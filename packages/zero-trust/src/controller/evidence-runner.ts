/** Production evidence runner (#1095; PRD §5.5, §5.6 steps 1, 2, 4 and 7; scenarios 6
 * and 7). A fresh VM is provisioned from an exact source manifest through the package
 * proxy, provisioning ends, the planned checks run with no network, and the verdict comes
 * only from what the supervisor observed: exit status and the report it read back. Every
 * function drives a `VmAdapter`; nothing is installed or run on the host. */
import path from 'node:path';
import {
  createManifest,
  parentPaths,
  type SourceEntry,
  type SourceManifest,
  sha256,
  validateManifest,
} from '../canonical/export';
import { privateDir, publishPrivate } from '../durable-fs';
import {
  applyProvisioning,
  type CommandOutcome,
  classifyRegression,
  commandEvidence,
  overallStatus,
  type RegressionProof,
} from '../ecosystem/classify';
import {
  buildCommandPlan,
  type CommandPhase,
  type CommandPlan,
  type PlannedCommand,
  type PlanOptions,
  type ProxyEndpoints,
} from '../ecosystem/commands';
import type { ProfileRecord } from '../ecosystem/profiles';
import { type JunitSummary, parseJunitReport } from '../ecosystem/report';
import type { Journal } from '../journal';
import type { CommandEvidence, CommandStatus } from '../receipt/schema';
import { assertSecretFree, REDACTED, redactedExcerpt } from '../redaction';
import type { RunRecord } from '../state';
import {
  appendVmEvent,
  BrokerError,
  type ContainerProfile,
  type ExecResult,
  type ProxyTarget,
  type VmAdapter,
  VmCleanupError,
  type VmHandle,
  type VmLimits,
} from '../vm/adapter';
import { assertProfileBaked } from '../vm/profile';
import { teardownVm } from '../vm/teardown';
import {
  acquireWorkspaceLease,
  invalidateProvisionedVm,
  isProvisionedVm,
  registerProvisionedVm,
} from '../vm/workspace-lifecycle';
import type { OutputCollector } from './output-collector';

/** Cap on the log excerpt kept in evidence, in UTF-16 code units (the tail of the log). */
export const MAX_LOG_EXCERPT_CHARS = 4096;
/** Replaces an excerpt that matched a credential pattern. */
export const REDACTED_EXCERPT = REDACTED;
/** Separates stdout from stderr in the log a digest is taken over. */
const LOG_SEPARATOR = '\n--- stderr ---\n';
/** The one network each command phase may use. */
const PHASE_NETWORK: Readonly<Record<CommandPhase, PlannedCommand['network']>> = Object.freeze({
  provisioning: 'package_proxy',
  verification: 'none',
});
/** The broker code the phase switch must produce for a `package_proxy` request. */
const PROXY_REFUSED = 'network_not_allowed';
const MANIFEST_DIRECTORY: SourceEntry['mode'] = '040000';
const MANIFEST_EXECUTABLE: SourceEntry['mode'] = '100755';

export type EvidencePlanErrorCode =
  | 'network_mismatch'
  | 'manager_mismatch'
  | 'no_test_command'
  | 'no_regression_targets'
  | 'no_test_files'
  | 'test_file_missing'
  | 'workspace_unproven';

/** The plan or its inputs were refused before any VM was created or command ran.
 * `detail` holds controller data only (a command id and phase, a test-file index),
 * never repository-supplied text. */
export class EvidencePlanError extends Error {
  constructor(
    readonly code: EvidencePlanErrorCode,
    readonly detail?: string
  ) {
    super(`Evidence plan refused (${code})${detail ? `: ${detail}` : ''}`);
    this.name = 'EvidencePlanError';
  }
}

/** A provisioning command did not pass. The VM is already destroyed and `run` is the
 * `unsupported_environment` run (PRD §5.5), never a repair or a broader network. */
export class ProvisioningFailedError extends Error {
  constructor(
    readonly run: RunRecord,
    readonly records: readonly CommandRecord[],
    readonly failedAt: string
  ) {
    super(`Provisioning failed at ${failedAt}: unsupported_environment`);
    this.name = 'ProvisioningFailedError';
  }
}

/** After `endProvisioning` the broker still accepted a `package_proxy` command: the phase
 * switch cannot be shown to hold, so nothing runs in the VM. */
export class ProvisioningNotClosedError extends Error {
  constructor(readonly vmId: string) {
    super(`The package proxy network was not refused after provisioning on ${vmId}`);
    this.name = 'ProvisioningNotClosedError';
  }
}

/** The run the evidence belongs to and where its state changes go. The runner changes
 * the run only on a failure (`unsupported_environment`, `blocked_cleanup`); every such
 * run reaches `observeRun` before the function throws. */
export interface RunLifecycle {
  readonly run: RunRecord;
  readonly now: () => Date;
  /** Persists a changed run where the admission fence reads it (e.g. `IntentDriver.observeRun`). */
  readonly observeRun: (run: RunRecord) => void;
  /** Dedicated VM event journal: teardown attempts and aborted workspaces. */
  readonly journal?: Journal;
  readonly retryDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** A command's log as evidence keeps it: the digest of the whole log and a bounded tail. */
export interface LogArtifact {
  /** SHA-256 (hex) of stdout, a fixed separator and stderr. */
  readonly digest: string;
  /** UTF-8 byte length of the digested log. */
  readonly bytes: number;
  /** The last `MAX_LOG_EXCERPT_CHARS` code units, or `[redacted]`. */
  readonly excerpt: string;
  /** The log was longer than the excerpt. */
  readonly excerptTruncated: boolean;
  /** The log or the excerpt matched a credential pattern: the excerpt is replaced;
   * the digest and the sizes are kept. */
  readonly redacted: boolean;
  /** The broker capped the command's output before the controller saw it. */
  readonly outputTruncated: boolean;
}

export interface CommandRecord {
  readonly id: string;
  readonly phase: CommandPhase;
  readonly network: PlannedCommand['network'];
  /** argv joined by spaces (display only). */
  readonly argv: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** From the supervisor-read junit report; null for a setup command or an unreadable report. */
  readonly suites: number | null;
  readonly tests: number | null;
  readonly failures: number | null;
  readonly status: CommandStatus;
  readonly durationMs: number;
  readonly captureReport: boolean;
  readonly log: LogArtifact;
  /** Receipt evidence; references the log by `log.digest`. */
  readonly evidence: CommandEvidence;
}

export interface RunPlannedOptions {
  /** Private directory for sanitized log artifacts, written once as
   * `<digest>.<complete|truncated>.log.json` (e.g. `RunStore.storeDirectory('artifacts')`). */
  readonly artifactsDir?: string;
}

export interface WorkspaceOptions extends RunPlannedOptions {
  readonly adapter: VmAdapter;
  readonly runId: string;
  readonly limits: VmLimits;
  readonly profileRecord: ProfileRecord;
  /** The run's one package mirror (see `ProxyTarget`). */
  readonly proxyTarget: ProxyTarget;
  readonly collector: OutputCollector;
  readonly lifecycle: RunLifecycle;
}

export interface ProvisionOptions extends WorkspaceOptions {
  readonly manifest: SourceManifest;
  readonly plan: CommandPlan;
}

export type BaselineOptions = ProvisionOptions;

export interface RegressionOptions extends WorkspaceOptions {
  readonly baseManifest: SourceManifest;
  /** Paths, taken from the candidate, that make up the regression test. */
  readonly testFiles: readonly string[];
  readonly candidateManifest: SourceManifest;
  readonly regressionTargets: readonly string[];
  readonly endpoints: ProxyEndpoints;
  readonly planOptions?: Omit<PlanOptions, 'testTargets'>;
}

/** A provisioned VM in the verification phase: no network path exists any more. Only
 * `provisionWorkspace` makes one, and `runPlanned` accepts nothing else. */
export interface ProvisionedWorkspace {
  readonly vm: VmHandle;
  readonly profile: ContainerProfile;
  readonly provisioning: readonly CommandRecord[];
  /** The host-side check after the phase switch: the broker code that refused
   * `package_proxy`. */
  readonly phaseSwitch: { readonly attempt: string; readonly refusedWith: string };
}

export interface WorkspaceEvidence {
  readonly provisioning: readonly CommandRecord[];
  readonly records: readonly CommandRecord[];
  readonly status: CommandStatus;
  readonly phaseSwitch: ProvisionedWorkspace['phaseSwitch'];
}

export interface RegressionRunEvidence {
  readonly proof: RegressionProof;
  /** Base plus only the test files: must be `failed`. */
  readonly base: WorkspaceEvidence;
  /** The candidate: must be `passed`. `null` when the base did not fail, since nothing
   * the candidate does can change that verdict. */
  readonly candidate: WorkspaceEvidence | null;
}

/** Workspaces that passed the phase-switch check and are not yet released. */
const PROVEN = new WeakSet<ProvisionedWorkspace>();

/** The model loop may use only a live handle from this adapter's completed provisioning. */
export function assertProvisionedVm(adapter: VmAdapter, vm: VmHandle): void {
  if (!isProvisionedVm(adapter, vm)) throw new EvidencePlanError('workspace_unproven');
}

/** Exclusive model-loop ownership; release/teardown invalidates proof immediately,
 * even while the owner awaits a provider or persistence callback. */
export function leaseProvisionedVm(adapter: VmAdapter, vm: VmHandle): () => void {
  try {
    return acquireWorkspaceLease(adapter, vm);
  } catch {
    throw new EvidencePlanError('workspace_unproven');
  }
}

/** A supervisory worker deadline must quiesce the guest, never merely abandon its promise.
 * Caller still owns bounded cleanup retries and lifecycle persistence on destroy failure. */
export async function abortProvisionedVm(adapter: VmAdapter, vm: VmHandle): Promise<void> {
  invalidateProvisionedVm(adapter, vm);
  await adapter.destroy(vm);
}

/** Refuses any command whose phase or network is not its phase's one network:
 * provisioning only on the package proxy, verification only with none. */
export function assertPlanNetworks(plan: CommandPlan): void {
  for (const [phase, commands] of [
    ['provisioning', plan.provisioning],
    ['verification', plan.verification],
  ] as const)
    for (const command of commands) assertCommandPhase(command, phase);
}

function assertCommandPhase(command: PlannedCommand, phase: CommandPhase): void {
  if (command.phase !== phase || command.network !== PHASE_NETWORK[phase])
    throw new EvidencePlanError('network_mismatch', `${command.id} in ${phase}`);
}

/** The last `MAX_LOG_EXCERPT_CHARS` code units, never starting inside a surrogate pair. */
function logTail(text: string): string {
  if (text.length <= MAX_LOG_EXCERPT_CHARS) return text;
  const tail = text.slice(-MAX_LOG_EXCERPT_CHARS);
  return /^[\uDC00-\uDFFF]/.test(tail) ? tail.slice(1) : tail;
}

/** Sanitized log artifact: the digest covers every byte; the excerpt is a bounded tail
 * and becomes `[redacted]` when the log or the excerpt matches a credential pattern. */
export function logArtifact(stdout: string, stderr: string, outputTruncated: boolean): LogArtifact {
  const text = `${stdout}${LOG_SEPARATOR}${stderr}`;
  const log = Buffer.from(text, 'utf8');
  const { excerpt, redacted } = redactedExcerpt(text, logTail);
  return Object.freeze({
    digest: sha256(log),
    bytes: log.length,
    excerpt,
    excerptTruncated: text.length > MAX_LOG_EXCERPT_CHARS,
    redacted,
    outputTruncated,
  });
}

/** Write-once: the name carries everything the content depends on beyond the log bytes. */
function persistLog(directory: string, artifact: LogArtifact): void {
  privateDir(directory);
  const name = `${artifact.digest}.${artifact.outputTruncated ? 'truncated' : 'complete'}.log.json`;
  publishPrivate(path.join(directory, name), Buffer.from(`${JSON.stringify(artifact)}\n`, 'utf8'));
}

function outcomeOf(result: ExecResult, summary: JunitSummary | null): CommandOutcome {
  if (result.timedOut) return { kind: 'timeout' };
  if (result.exitCode === null) return { kind: 'signal', signal: 'unknown' };
  return { kind: 'exited', exitCode: result.exitCode, report: summary };
}

async function execute(
  adapter: VmAdapter,
  vm: VmHandle,
  profile: ContainerProfile,
  command: PlannedCommand,
  collector: OutputCollector,
  options: RunPlannedOptions
): Promise<CommandRecord> {
  const result = await adapter.exec(vm, {
    profile,
    argv: command.argv,
    env: command.env,
    network: command.network,
    report: command.captureReport,
    timeoutMs: command.timeoutMs,
  });
  collector.append(result.stdout);
  collector.append(result.stderr);
  // A supervised timeout/signal is semantically inconclusive, but its returned
  // streams may still be complete. Capture loss is an independent broker fact.
  if (result.truncated) collector.markIncomplete();
  if (command.captureReport) collector.append(result.report);
  const summary = command.captureReport ? parseJunitReport(result.report) : null;
  const outcome = outcomeOf(result, summary);
  const log = logArtifact(result.stdout, result.stderr, result.truncated);
  const evidence = commandEvidence(command, outcome, log.digest);
  const record: CommandRecord = {
    id: command.id,
    phase: command.phase,
    network: command.network,
    argv: command.argv.join(' '),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    suites: summary?.suites ?? null,
    tests: summary?.tests ?? null,
    failures: summary?.failures ?? null,
    status: evidence.status,
    durationMs: result.durationMs,
    captureReport: command.captureReport,
    log,
    evidence,
  };
  assertSecretFree(record);
  if (options.artifactsDir) persistLog(options.artifactsDir, log);
  return record;
}

/** Runs one verification command in a workspace `provisionWorkspace` returned and has
 * not released, with no network, and classifies it from the exit status and the report
 * the supervisor read back (`classifyCommand`). A timeout, a signal, a missing report,
 * zero or unknown suites, or case counts that contradict the exit are `inconclusive`. */
export async function runPlanned(
  adapter: VmAdapter,
  workspace: ProvisionedWorkspace,
  command: PlannedCommand,
  collector: OutputCollector,
  options: RunPlannedOptions = {}
): Promise<CommandRecord> {
  if (!PROVEN.has(workspace)) throw new EvidencePlanError('workspace_unproven');
  assertCommandPhase(command, 'verification');
  const release = leaseProvisionedVm(adapter, workspace.vm);
  try {
    const record = await execute(
      adapter,
      workspace.vm,
      workspace.profile,
      command,
      collector,
      options
    );
    assertProvisionedVm(adapter, workspace.vm);
    return record;
  } finally {
    release();
  }
}

/** One bounded teardown; a blocked one throws `VmCleanupError` with `cause` set to the
 * failure that led here, if any. */
async function destroyVm(
  adapter: Pick<VmAdapter, 'destroy'>,
  vm: Pick<VmHandle, 'vmId' | 'runId'>,
  lifecycle: RunLifecycle,
  cause?: unknown
): Promise<void> {
  const outcome = await teardownVm(adapter, vm, lifecycle.run, {
    journal: lifecycle.journal,
    observeRun: lifecycle.observeRun,
    now: lifecycle.now,
    retryDelayMs: lifecycle.retryDelayMs,
    sleep: lifecycle.sleep,
  });
  if (outcome.kind === 'blocked_cleanup') {
    const error = new VmCleanupError(outcome.leftoverPids, outcome.leftoverPaths, vm.vmId);
    if (cause !== undefined) error.cause = cause;
    throw error;
  }
}

/** Destroys the workspace VM with the bounded teardown; the workspace can no longer run
 * commands. Three failed deletions put the run in `blocked_cleanup` (`observeRun` sees
 * it) and throw `VmCleanupError` (with `cause` when one is given). */
export async function releaseWorkspace(
  adapter: Pick<VmAdapter, 'destroy'>,
  workspace: ProvisionedWorkspace,
  lifecycle: RunLifecycle,
  cause?: unknown
): Promise<void> {
  PROVEN.delete(workspace);
  invalidateProvisionedVm(adapter, workspace.vm);
  await destroyVm(adapter, workspace.vm, lifecycle, cause);
}

interface Progress {
  stage: 'upload' | 'provisioning' | 'phase_switch' | 'verification';
  commandId?: string;
}

/** Records where a workspace failed: the stage, the command and the error class only
 * (messages can carry guest text). */
function journalAbort(
  lifecycle: RunLifecycle,
  vm: VmHandle,
  progress: Progress,
  error: unknown
): void {
  appendVmEvent(lifecycle.journal, lifecycle.now(), {
    type: 'evidence_workspace_aborted',
    runId: vm.runId,
    vmId: vm.vmId,
    stage: progress.stage,
    ...(progress.commandId ? { commandId: progress.commandId } : {}),
    cause: error instanceof Error ? error.name : typeof error,
  });
}

/** The phase switch must hold before anything runs: the broker refuses the proxy network. */
async function assertProxyClosed(
  adapter: VmAdapter,
  vm: VmHandle,
  profile: ContainerProfile
): Promise<string> {
  try {
    await adapter.exec(vm, { profile, argv: ['true'], network: 'package_proxy' });
  } catch (error) {
    if (error instanceof BrokerError && error.code === PROXY_REFUSED) return error.code;
    throw error;
  }
  throw new ProvisioningNotClosedError(vm.vmId);
}

async function uploadManifest(
  adapter: VmAdapter,
  vm: VmHandle,
  manifest: SourceManifest
): Promise<void> {
  for (const entry of manifest.entries)
    if (entry.mode !== MANIFEST_DIRECTORY)
      await adapter.putFile(
        vm,
        entry.path,
        Buffer.from(entry.bytes, 'base64'),
        entry.mode === MANIFEST_EXECUTABLE
      );
}

/** Runs provisioning commands in order until one does not pass. */
async function runProvisioning(
  options: ProvisionOptions,
  vm: VmHandle,
  profile: ContainerProfile,
  progress: Progress
): Promise<{ records: CommandRecord[]; failed?: CommandRecord }> {
  const records: CommandRecord[] = [];
  for (const command of options.plan.provisioning) {
    progress.commandId = command.id;
    const record = await execute(options.adapter, vm, profile, command, options.collector, options);
    records.push(record);
    if (record.status !== 'passed') return { records, failed: record };
  }
  return { records };
}

/** Provisions a fresh VM from `manifest`: uploads exactly its files, runs the plan's
 * provisioning commands on the package proxy, ends provisioning and checks the proxy
 * network is gone. A provisioning command that does not pass makes the run
 * `unsupported_environment` (`ProvisioningFailedError`). On any failure the VM is
 * destroyed before the error is rethrown. */
export async function provisionWorkspace(options: ProvisionOptions): Promise<ProvisionedWorkspace> {
  const { adapter, profileRecord, lifecycle } = options;
  assertPlanNetworks(options.plan);
  if (options.plan.manager !== profileRecord.manager)
    throw new EvidencePlanError(
      'manager_mismatch',
      `${options.plan.manager} plan, ${profileRecord.manager} profile`
    );
  const manifest = validateManifest(options.manifest);
  const profile: ContainerProfile = profileRecord.profile.ecosystem;
  assertProfileBaked(profile, profileRecord.profile.id);
  const vm = await adapter.create({
    runId: options.runId,
    limits: options.limits,
    scope: 'container',
    phase: 'provisioning',
    proxyTarget: options.proxyTarget,
  });
  const progress: Progress = { stage: 'upload' };
  let provisioned: { records: CommandRecord[]; failed?: CommandRecord };
  try {
    await uploadManifest(adapter, vm, manifest);
    progress.stage = 'provisioning';
    provisioned = await runProvisioning(options, vm, profile, progress);
    if (!provisioned.failed) {
      progress.stage = 'phase_switch';
      progress.commandId = undefined;
      await adapter.endProvisioning(vm);
      const refusedWith = await assertProxyClosed(adapter, vm, profile);
      const workspace: ProvisionedWorkspace = Object.freeze({
        vm,
        profile,
        provisioning: Object.freeze(provisioned.records),
        phaseSwitch: Object.freeze({ attempt: 'package-proxy-after-provisioning', refusedWith }),
      });
      PROVEN.add(workspace);
      registerProvisionedVm(adapter, vm);
      return workspace;
    }
  } catch (error) {
    journalAbort(lifecycle, vm, progress, error);
    await destroyVm(adapter, vm, lifecycle, error);
    throw error;
  }
  const { records, failed } = provisioned;
  // Teardown first: `unsupported` is terminal, so a blocked cleanup must win.
  await destroyVm(adapter, vm, lifecycle, { failedAt: failed.id, records });
  const run = applyProvisioning(lifecycle.run, failed.status, lifecycle.now().toISOString());
  lifecycle.observeRun(run);
  throw new ProvisioningFailedError(run, Object.freeze(records), failed.id);
}

/** One workspace's verdict: a setup step (no report) that did not pass makes it
 * `inconclusive`; otherwise the report-classified commands roll up with `overallStatus`
 * (no test command at all is `inconclusive`). */
export function workspaceStatus(records: readonly CommandRecord[]): CommandStatus {
  if (records.some((r) => !r.captureReport && r.status !== 'passed')) return 'inconclusive';
  return overallStatus(records.filter((r) => r.captureReport).map((r) => r.status));
}

async function workspaceEvidence(
  options: WorkspaceOptions,
  manifest: SourceManifest,
  plan: CommandPlan
): Promise<WorkspaceEvidence> {
  const { adapter, lifecycle } = options;
  const workspace = await provisionWorkspace({ ...options, manifest, plan });
  const records: CommandRecord[] = [];
  const progress: Progress = { stage: 'verification' };
  try {
    for (const command of plan.verification) {
      progress.commandId = command.id;
      records.push(await runPlanned(adapter, workspace, command, options.collector, options));
    }
  } catch (error) {
    journalAbort(lifecycle, workspace.vm, progress, error);
    await releaseWorkspace(adapter, workspace, lifecycle, error);
    throw error;
  }
  await releaseWorkspace(adapter, workspace, lifecycle);
  return Object.freeze({
    provisioning: workspace.provisioning,
    records: Object.freeze(records),
    status: workspaceStatus(records),
    phaseSwitch: workspace.phaseSwitch,
  });
}

function assertHasTestCommand(plan: CommandPlan): void {
  if (!plan.verification.some((c) => c.captureReport))
    throw new EvidencePlanError('no_test_command');
}

/** Baseline (PRD §5.6 step 1): the plan's verification commands on the base, in a fresh VM. */
export async function baselineEvidence(options: BaselineOptions): Promise<WorkspaceEvidence> {
  assertHasTestCommand(options.plan);
  return workspaceEvidence(options, options.manifest, options.plan);
}

/** The base with only `testFiles` taken from the candidate (plus any parent directories
 * the base lacks): the regression test applied to unpatched code. */
export function reproductionManifest(
  baseManifest: SourceManifest,
  candidateManifest: SourceManifest,
  testFiles: readonly string[]
): SourceManifest {
  if (testFiles.length === 0) throw new EvidencePlanError('no_test_files');
  const base = validateManifest(baseManifest);
  const candidate = new Map(validateManifest(candidateManifest).entries.map((e) => [e.path, e]));
  const entries = new Map<string, SourceEntry>(base.entries.map((e) => [e.path, e]));
  testFiles.forEach((file, index) => {
    const entry = candidate.get(file);
    if (!entry || entry.mode === MANIFEST_DIRECTORY)
      throw new EvidencePlanError('test_file_missing', `test file #${index}`);
    // A valid candidate manifest holds every parent directory of its files.
    for (const directory of parentPaths(file))
      if (!entries.has(directory)) entries.set(directory, candidate.get(directory) as SourceEntry);
    entries.set(file, entry);
  });
  return createManifest([...entries.values()]);
}

/** Regression proof (PRD §5.6 steps 2 and 4, scenario 6): the regression targets run on
 * the base plus only the test files (must be `failed`) and on the candidate (must be
 * `passed`), each in its own fresh VM. `not_reproduced` is a hand-off before patching. */
export async function regressionEvidence(
  options: RegressionOptions
): Promise<RegressionRunEvidence> {
  if (options.regressionTargets.length === 0) throw new EvidencePlanError('no_regression_targets');
  const plan = buildCommandPlan(options.profileRecord.manager, options.endpoints, {
    ...options.planOptions,
    testTargets: options.regressionTargets,
  });
  assertHasTestCommand(plan);
  const reproduction = reproductionManifest(
    options.baseManifest,
    options.candidateManifest,
    options.testFiles
  );
  const base = await workspaceEvidence(options, reproduction, plan);
  if (base.status !== 'failed')
    return Object.freeze({
      proof: classifyRegression(base.status, 'skipped'),
      base,
      candidate: null,
    });
  const candidate = await workspaceEvidence(options, options.candidateManifest, plan);
  return Object.freeze({
    proof: classifyRegression(base.status, candidate.status),
    base,
    candidate,
  });
}
