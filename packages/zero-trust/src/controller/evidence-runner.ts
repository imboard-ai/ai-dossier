/** Production evidence runner (#1095; PRD §5.5, §5.6 steps 1, 2, 4 and 7; scenarios 6
 * and 7). A fresh VM is provisioned from an exact source manifest through the package
 * proxy, provisioning ends, the planned checks run with no network, and the verdict comes
 * only from what the supervisor observed: exit status and the report it read back. Every
 * function drives a `VmAdapter`; nothing is installed or run on the host. */
import path from 'node:path';
import {
  createManifest,
  type SourceEntry,
  type SourceManifest,
  sha256,
  validateManifest,
} from '../canonical/export';
import { privateDir, publishPrivate } from '../durable-fs';
import {
  applyProvisioning,
  type CommandOutcome,
  classifyOutcome,
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
import { parseJunitReport } from '../ecosystem/report';
import type { Journal } from '../journal';
import type { CommandEvidence, CommandStatus } from '../receipt/schema';
import { assertNoSecrets, assertSecretFree } from '../redaction';
import type { RunRecord } from '../state';
import {
  BrokerError,
  type ContainerProfile,
  type ProxyTarget,
  type VmAdapter,
  VmCleanupError,
  type VmHandle,
  type VmLimits,
} from '../vm/adapter';
import { assertProfileBaked } from '../vm/profile';
import { teardownVm } from '../vm/teardown';
import type { OutputCollector } from './output-collector';

/** Cap on the log excerpt kept in evidence, in characters (the tail of the log). */
export const MAX_LOG_EXCERPT_CHARS = 4096;
/** Replaces an excerpt that matched a credential pattern. */
export const REDACTED_EXCERPT = '[redacted]';
/** Separates stdout from stderr in the log a digest is taken over. */
const LOG_SEPARATOR = '\n--- stderr ---\n';
const NETWORK_OF: Readonly<Record<CommandPhase, PlannedCommand['network']>> = Object.freeze({
  provisioning: 'package_proxy',
  verification: 'none',
});

export type EvidencePlanErrorCode =
  | 'network_mismatch'
  | 'manager_mismatch'
  | 'no_test_command'
  | 'no_regression_targets'
  | 'no_test_files'
  | 'test_file_missing';

/** The plan or its inputs were refused before any VM was created or command ran. */
export class EvidencePlanError extends Error {
  constructor(readonly code: EvidencePlanErrorCode) {
    super(`Evidence plan refused (${code})`);
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
  readonly observeRun?: (run: RunRecord) => void;
  /** Dedicated VM event journal for teardown attempts. */
  readonly journal?: Journal;
  readonly retryDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** A command's log as evidence keeps it: the digest of the whole log and a bounded tail. */
export interface LogArtifact {
  /** SHA-256 (hex) of stdout, a fixed separator and stderr. */
  readonly digest: string;
  readonly bytes: number;
  /** The last `MAX_LOG_EXCERPT_CHARS` characters, or `[redacted]`. */
  readonly excerpt: string;
  readonly excerptTruncated: boolean;
  /** The log matched a credential pattern; only the digest is kept. */
  readonly redacted: boolean;
  /** The broker capped the command's output before the controller saw it. */
  readonly outputTruncated: boolean;
}

export interface CommandRecord {
  readonly id: string;
  readonly phase: CommandPhase;
  readonly network: PlannedCommand['network'];
  readonly argv: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
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
  /** Private directory for sanitized log artifacts (`<digest>.log.json`, write-once),
   * e.g. `RunStore.storeDirectory('artifacts')`. */
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

/** A provisioned VM in the verification phase: no network path exists any more. */
export interface ProvisionedWorkspace {
  readonly vm: VmHandle;
  readonly profile: ContainerProfile;
  readonly provisioning: readonly CommandRecord[];
  /** The host-side check after the phase switch: `package_proxy` was refused. */
  readonly phaseSwitch: { readonly attempt: string; readonly rejected: true };
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
  if (command.phase !== phase || command.network !== NETWORK_OF[phase])
    throw new EvidencePlanError('network_mismatch');
}

/** Sanitized log artifact: the digest covers every byte; the excerpt is a bounded tail
 * and becomes `[redacted]` when the log or the excerpt matches a credential pattern. */
export function logArtifact(stdout: string, stderr: string, outputTruncated: boolean): LogArtifact {
  const log = Buffer.from(`${stdout}${LOG_SEPARATOR}${stderr}`, 'utf8');
  const text = log.toString('utf8');
  const excerptTruncated = text.length > MAX_LOG_EXCERPT_CHARS;
  let excerpt = excerptTruncated ? text.slice(-MAX_LOG_EXCERPT_CHARS) : text;
  let redacted = false;
  try {
    assertNoSecrets(text);
    assertNoSecrets(excerpt);
  } catch {
    excerpt = REDACTED_EXCERPT;
    redacted = true;
  }
  return Object.freeze({
    digest: sha256(log),
    bytes: log.length,
    excerpt,
    excerptTruncated,
    redacted,
    outputTruncated,
  });
}

function persistLog(directory: string, artifact: LogArtifact): void {
  privateDir(directory);
  publishPrivate(
    path.join(directory, `${artifact.digest}.log.json`),
    Buffer.from(`${JSON.stringify(artifact)}\n`, 'utf8')
  );
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
  if (command.captureReport) collector.append(result.report);
  const summary = command.captureReport ? parseJunitReport(result.report) : null;
  const outcome: CommandOutcome = result.timedOut
    ? { kind: 'timeout' }
    : result.exitCode === null
      ? { kind: 'signal', signal: 'unknown' }
      : {
          kind: 'exited',
          exitCode: result.exitCode,
          report: summary ? { suites: summary.suites } : null,
        };
  // A setup step has no report: its exit status is the result, and a timeout or a
  // signal is still never a pass.
  const status: CommandStatus = command.captureReport
    ? classifyOutcome(outcome)
    : outcome.kind !== 'exited'
      ? 'inconclusive'
      : outcome.exitCode === 0
        ? 'passed'
        : 'failed';
  const log = logArtifact(result.stdout, result.stderr, result.truncated);
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
    status,
    durationMs: result.durationMs,
    captureReport: command.captureReport,
    log,
    evidence: { ...commandEvidence(command, outcome, log.digest), status },
  };
  assertSecretFree(record);
  if (options.artifactsDir) persistLog(options.artifactsDir, log);
  return record;
}

/** Runs one verification command in a provisioned workspace with no network and
 * classifies it from the exit status and the report the supervisor read back. A
 * timeout, a signal, a missing report or zero or unknown suites is `inconclusive`. */
export async function runPlanned(
  adapter: VmAdapter,
  workspace: Pick<ProvisionedWorkspace, 'vm' | 'profile'>,
  command: PlannedCommand,
  collector: OutputCollector,
  options: RunPlannedOptions = {}
): Promise<CommandRecord> {
  assertCommandPhase(command, 'verification');
  return execute(adapter, workspace.vm, workspace.profile, command, collector, options);
}

/** Destroys the workspace VM with the bounded teardown. Three failed deletions put the
 * run in `blocked_cleanup` (`observeRun` sees it) and throw `VmCleanupError`. */
export async function releaseWorkspace(
  adapter: Pick<VmAdapter, 'destroy'>,
  workspace: { readonly vm: Pick<VmHandle, 'vmId' | 'runId'> },
  lifecycle: RunLifecycle
): Promise<void> {
  const outcome = await teardownVm(adapter, workspace.vm, lifecycle.run, {
    journal: lifecycle.journal,
    observeRun: lifecycle.observeRun,
    now: lifecycle.now,
    retryDelayMs: lifecycle.retryDelayMs,
    sleep: lifecycle.sleep,
  });
  if (outcome.kind === 'blocked_cleanup')
    throw new VmCleanupError(outcome.leftoverPids, outcome.leftoverPaths, workspace.vm.vmId);
}

/** The phase switch must hold before anything runs: the broker refuses the proxy network. */
async function assertProxyClosed(
  adapter: VmAdapter,
  vm: VmHandle,
  profile: ContainerProfile
): Promise<void> {
  try {
    await adapter.exec(vm, { profile, argv: ['true'], network: 'package_proxy' });
  } catch (error) {
    if (error instanceof BrokerError && error.code === 'network_not_allowed') return;
    throw error;
  }
  throw new ProvisioningNotClosedError(vm.vmId);
}

/** Provisions a fresh VM from `manifest`: uploads exactly its files, runs the plan's
 * provisioning commands on the package proxy, ends provisioning and checks the proxy
 * network is gone. A provisioning command that does not pass makes the run
 * `unsupported_environment` (`ProvisioningFailedError`). On any failure the VM is
 * destroyed before the error is rethrown. */
export async function provisionWorkspace(options: ProvisionOptions): Promise<ProvisionedWorkspace> {
  const { adapter, profileRecord, collector, lifecycle } = options;
  assertPlanNetworks(options.plan);
  if (options.plan.manager !== profileRecord.manager)
    throw new EvidencePlanError('manager_mismatch');
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
  const records: CommandRecord[] = [];
  let failed: CommandRecord | undefined;
  try {
    for (const entry of manifest.entries)
      if (entry.mode !== '040000')
        await adapter.putFile(
          vm,
          entry.path,
          Buffer.from(entry.bytes, 'base64'),
          entry.mode === '100755'
        );
    for (const command of options.plan.provisioning) {
      const record = await execute(adapter, vm, profile, command, collector, options);
      records.push(record);
      if (record.status !== 'passed') {
        failed = record;
        break;
      }
    }
    if (!failed) {
      await adapter.endProvisioning(vm);
      await assertProxyClosed(adapter, vm, profile);
      return Object.freeze({
        vm,
        profile,
        provisioning: Object.freeze(records),
        phaseSwitch: Object.freeze({
          attempt: 'package-proxy-after-provisioning',
          rejected: true as const,
        }),
      });
    }
  } catch (error) {
    await releaseWorkspace(adapter, { vm }, lifecycle);
    throw error;
  }
  // Teardown first: `unsupported` is terminal, so a blocked cleanup must win.
  await releaseWorkspace(adapter, { vm }, lifecycle);
  const run = applyProvisioning(lifecycle.run, failed.status, lifecycle.now().toISOString());
  lifecycle.observeRun?.(run);
  throw new ProvisioningFailedError(run, Object.freeze(records), failed.id);
}

/** One workspace's verdict: a setup step (no report) that did not pass makes it
 * `inconclusive`; otherwise the report-classified commands roll up with `overallStatus`. */
export function workspaceStatus(records: readonly CommandRecord[]): CommandStatus {
  if (records.some((r) => !r.captureReport && r.status !== 'passed')) return 'inconclusive';
  return overallStatus(records.filter((r) => r.captureReport).map((r) => r.status));
}

async function workspaceEvidence(
  options: WorkspaceOptions,
  manifest: SourceManifest,
  plan: CommandPlan
): Promise<WorkspaceEvidence> {
  const workspace = await provisionWorkspace({ ...options, manifest, plan });
  try {
    const records: CommandRecord[] = [];
    for (const command of plan.verification)
      records.push(
        await runPlanned(options.adapter, workspace, command, options.collector, options)
      );
    return Object.freeze({
      provisioning: workspace.provisioning,
      records: Object.freeze(records),
      status: workspaceStatus(records),
      phaseSwitch: workspace.phaseSwitch,
    });
  } finally {
    await releaseWorkspace(options.adapter, workspace, options.lifecycle);
  }
}

function assertHasTestCommand(plan: CommandPlan): void {
  if (!plan.verification.some((c) => c.captureReport))
    throw new EvidencePlanError('no_test_command');
}

/** Baseline (PRD §5.6 step 1): the plan's verification commands on the base, in a fresh VM. */
export async function baselineEvidence(
  options: WorkspaceOptions & { readonly manifest: SourceManifest; readonly plan: CommandPlan }
): Promise<WorkspaceEvidence> {
  assertPlanNetworks(options.plan);
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
  for (const file of testFiles) {
    const entry = candidate.get(file);
    if (!entry || entry.mode === '040000') throw new EvidencePlanError('test_file_missing');
    const parts = file.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      const directory = parts.slice(0, depth).join('/');
      if (!entries.has(directory)) entries.set(directory, candidate.get(directory) as SourceEntry);
    }
    entries.set(file, entry);
  }
  return createManifest([...entries.values()]);
}

/** Regression proof (PRD §5.6 steps 2 and 4, scenario 6): the regression targets run on
 * the base plus only the test files (must be `failed`) and on the candidate (must be
 * `passed`), each in its own fresh VM. `not_reproduced` is a hand-off before patching. */
export async function regressionEvidence(
  options: WorkspaceOptions & {
    readonly baseManifest: SourceManifest;
    readonly testFiles: readonly string[];
    readonly candidateManifest: SourceManifest;
    readonly regressionTargets: readonly string[];
    readonly endpoints: ProxyEndpoints;
    readonly planOptions?: Omit<PlanOptions, 'testTargets'>;
  }
): Promise<RegressionRunEvidence> {
  if (options.regressionTargets.length === 0) throw new EvidencePlanError('no_regression_targets');
  const plan = buildCommandPlan(options.profileRecord.manager, options.endpoints, {
    ...options.planOptions,
    testTargets: options.regressionTargets,
  });
  assertPlanNetworks(plan);
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
