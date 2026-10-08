/** Independent verifier (#1102; PRD §5.6 steps 6 to 8, §5.7, §5.9; scenarios 6, 7, 10
 * and 17). It rebuilds the exact candidate commit from the controller's sanitized
 * blobs, verifies it in a NEW VM with no network, takes the verdict only from what the
 * supervisor observed, routes it through the repair cap and persists a controller-owned
 * `VerificationRecord`. It signs nothing: shipping turns the record into a receipt just
 * in time. Fail closed throughout: an unreadable, inconsistent, partial or interrupted
 * answer never reaches `shipping`, and a candidate is never silently verified twice. */
import path from 'node:path';
import {
  CanonicalError,
  type CanonicalReason,
  type SourceManifest,
  sha256,
  validateManifest,
} from '../canonical/export';
import {
  type CandidateAuthority,
  type CandidateRecord,
  reconstructCandidate,
} from '../canonical/reconstruct';
import { readPrivate } from '../durable-fs';
import {
  applyVerification,
  classifyRegression,
  overallStatus,
  type RegressionProof,
} from '../ecosystem/classify';
import {
  buildCommandPlan,
  type CommandPlan,
  type PlanOptions,
  type ProxyEndpoints,
} from '../ecosystem/commands';
import { type ProfileRecord, profileReceiptBinding } from '../ecosystem/profiles';
import type { CommandEvidence, CommandStatus } from '../receipt/schema';
import { ReasonCode, type RunRecord, transitionRun } from '../state';
import { appendVmEvent, type ProxyTarget, type VmAdapter, type VmLimits } from '../vm/adapter';
import {
  type BoundarySession,
  finishBoundary,
  prepareBoundary,
  probeBoundary,
  runBoundaryVerdict,
} from '../vm/boundary-probe';
import { type BoundaryInput, isCleanHeldVerdict } from '../vm/evidence';
import {
  assertHasTestCommand,
  type CommandRecord,
  type ProvisionedWorkspace,
  type RunLifecycle,
  regressionPlan,
  runWorkspace,
  type WorkspaceRun,
  workspaceStatus,
} from './evidence-runner';
import { OutputCollector } from './output-collector';
import {
  beginVerification,
  loadVerification,
  publishVerification,
  REGRESSION_COMMAND_SUFFIX,
  receiptGrade,
  type VerificationRecord,
  VerificationRecordError,
  type VerificationVerdict,
  verificationState,
} from './verification-record';

export interface VerifierDeps {
  readonly adapter: VmAdapter;
  readonly runId: string;
  readonly limits: VmLimits;
  /** The trusted profile recorded for this run (`recordProfileSelection`). */
  readonly profileRecord: ProfileRecord;
  readonly proxyTarget: ProxyTarget;
  readonly endpoints: ProxyEndpoints;
  readonly planOptions?: Omit<PlanOptions, 'testTargets'>;
  /** The run store's private artifacts directory (`RunStore.storeDirectory('artifacts')`):
   * logs, the boundary input and `verification/<candidateSha>.json` are written here. */
  readonly artifactsDir: string;
  /** The run must be in `verifying`; every state change reaches `observeRun`, and
   * verification events go to `journal`. */
  readonly lifecycle: RunLifecycle;
  /** Deadline for boundary quiescence and drain (`finishBoundary`). */
  readonly boundaryTimeoutMs?: number;
}

export interface VerifyInput {
  /** The SHA the controller authorized; the rebuilt commit must equal it. */
  readonly candidateSha: string;
  /** The controller's sanitized source manifest for the candidate. */
  readonly manifest: SourceManifest;
  readonly record: CandidateRecord;
  /** Controller-owned binding; never taken from the worker. */
  readonly authority: CandidateAuthority;
  readonly basePack: Buffer;
  /** Controller-chosen regression test paths (the regression evidence's targets). */
  readonly regressionTargets: readonly string[];
  /** The regression targets' status on base plus only the test files (#1095
   * `regressionEvidence().base.status`). Only `failed` proves the bug was reproduced. */
  readonly regressionBase: CommandStatus;
}

export type BoundaryUnavailableReason =
  | 'finalize_failed'
  | 'artifact_unreadable'
  | 'cleanup_failed';
export type InterruptedReason = 'attempt_without_record' | 'record_unusable';

export type VerificationOutcome =
  /** Reconstruction failed or rebuilt another SHA. No VM was created; the run is `blocked`. */
  | {
      readonly kind: 'identity_mismatch';
      readonly reason: CanonicalReason;
      readonly run: RunRecord;
    }
  /** Boundary evidence could not be produced or read back (a secret in guest output,
   * collector truncation, an unpublishable or unreadable artifact, canaries that could not
   * be removed). Nothing authoritative exists: no record, the run is `blocked`. */
  | {
      readonly kind: 'boundary_unavailable';
      readonly reason: BoundaryUnavailableReason;
      readonly run: RunRecord;
    }
  /** An earlier verification of this candidate started and left no usable record (a crash
   * or a failure mid-way). It is never re-run: the run is `blocked`. */
  | { readonly kind: 'interrupted'; readonly reason: InterruptedReason; readonly run: RunRecord }
  /** The record is persisted. `boundaryHeld: false` blocks the run whatever the verdict;
   * otherwise the verdict went through `applyVerification`. `replayed` when the record
   * already existed for this run (a crash before the run state was saved) and no VM ran. */
  | {
      readonly kind: 'verified';
      readonly verdict: VerificationVerdict;
      readonly record: VerificationRecord;
      readonly run: RunRecord;
      readonly replayed: boolean;
    };

export type VerifierInputErrorCode =
  | 'run_not_verifying'
  | 'run_mismatch'
  | 'invalid_candidate'
  | 'regression_not_reproduced'
  | 'already_verified';

/** Refused before reconstruction or any VM; nothing echoed. */
export class VerifierInputError extends Error {
  constructor(readonly code: VerifierInputErrorCode) {
    super(`Verification refused (${code})`);
    this.name = 'VerifierInputError';
  }
}

/** The suite's verification commands, then the regression targets' test command(s)
 * with ids suffixed `REGRESSION_COMMAND_SUFFIX`. Setup commands run once; every command
 * has no network. */
export function verificationPlan(
  profileRecord: ProfileRecord,
  endpoints: ProxyEndpoints,
  regressionTargets: readonly string[],
  planOptions: Omit<PlanOptions, 'testTargets'> = {}
): CommandPlan {
  const regression = regressionPlan(profileRecord, endpoints, regressionTargets, planOptions);
  const suite = buildCommandPlan(profileRecord.manager, endpoints, planOptions);
  assertHasTestCommand(suite);
  const targeted = regression.verification
    .filter((c) => c.captureReport)
    .map((c) => Object.freeze({ ...c, id: `${c.id}${REGRESSION_COMMAND_SUFFIX}` }));
  return Object.freeze({
    manager: suite.manager,
    provisioning: suite.provisioning,
    verification: Object.freeze([...suite.verification, ...targeted]),
  });
}

/** `passed` only when every command passed and `receiptGrade` holds; a failing command
 * stays `failed`; anything else is `inconclusive`. */
export function verificationVerdict(
  records: readonly CommandRecord[],
  regression: RegressionProof,
  commands: readonly CommandEvidence[]
): VerificationVerdict {
  const status = workspaceStatus(records);
  if (status === 'failed') return 'failed';
  if (status !== 'passed') return 'inconclusive';
  return receiptGrade(regression, commands) ? 'passed' : 'inconclusive';
}

function journal(deps: VerifierDeps, candidateSha: string, event: Record<string, unknown>): void {
  appendVmEvent(deps.lifecycle.journal, deps.lifecycle.now(), {
    runId: deps.runId,
    candidateSha,
    ...event,
  });
}

function block(lifecycle: RunLifecycle, timestamp = lifecycle.now().toISOString()): RunRecord {
  const run = transitionRun(lifecycle.run, ReasonCode.PolicyBlocked, timestamp);
  lifecycle.observeRun(run);
  return run;
}

/** A boundary that did not hold blocks the run; otherwise the repair cap applies. */
function settle(lifecycle: RunLifecycle, record: VerificationRecord, timestamp: string): RunRecord {
  if (!record.boundaryHeld) return block(lifecycle, timestamp);
  const run = applyVerification(lifecycle.run, record.verdict, timestamp);
  lifecycle.observeRun(run);
  return run;
}

/** Preconditions, checked before reconstruction, storage or any VM. Returns the plan. */
function assertVerifiable(deps: VerifierDeps, input: VerifyInput): CommandPlan {
  if (deps.lifecycle.run.state !== 'verifying') throw new VerifierInputError('run_not_verifying');
  if (deps.lifecycle.run.runId !== deps.runId) throw new VerifierInputError('run_mismatch');
  if (typeof input.candidateSha !== 'string' || !/^[a-f0-9]{40}$/u.test(input.candidateSha))
    throw new VerifierInputError('invalid_candidate');
  if (input.regressionBase !== 'failed') throw new VerifierInputError('regression_not_reproduced');
  return verificationPlan(
    deps.profileRecord,
    deps.endpoints,
    input.regressionTargets,
    deps.planOptions
  );
}

/** Rebuilds the candidate from one validated copy of the manifest; that same frozen copy
 * is what gets uploaded. */
function reconstruct(
  input: VerifyInput
): { ok: true; manifest: SourceManifest } | { ok: false; reason: CanonicalReason } {
  try {
    const manifest = validateManifest(input.manifest);
    const rebuilt = reconstructCandidate(manifest, input.record, input.authority, input.basePack);
    if (rebuilt.record.candidateSha !== input.candidateSha)
      return { ok: false, reason: 'commit_mismatch' };
    return { ok: true, manifest };
  } catch (error) {
    if (error instanceof CanonicalError) return { ok: false, reason: error.reason };
    throw error;
  }
}

/** The record already exists for this run: a crash came after it was written and before
 * the run state was saved. Replay its transition; never run another VM. */
function replay(deps: VerifierDeps, candidateSha: string): VerificationOutcome {
  const { lifecycle } = deps;
  let record: VerificationRecord;
  try {
    record = loadVerification(deps.artifactsDir, candidateSha, { runId: deps.runId });
  } catch (error) {
    if (!(error instanceof VerificationRecordError)) throw error;
    journal(deps, candidateSha, { type: 'verification_interrupted', reason: 'record_unusable' });
    return { kind: 'interrupted', reason: 'record_unusable', run: block(lifecycle) };
  }
  const run = settle(lifecycle, record, lifecycle.now().toISOString());
  return { kind: 'verified', verdict: record.verdict, record, run, replayed: true };
}

/** Probes and finishes the boundary on the still-live verification VM. A probe that
 * throws is not rethrown: its closed session finishes as failed evidence. */
function finishProbe(deps: VerifierDeps, session: BoundarySession, collector: OutputCollector) {
  return async (workspace: ProvisionedWorkspace): Promise<boolean> => {
    try {
      await probeBoundary(session, deps.adapter, workspace.vm, workspace.profile);
    } catch {
      // Recorded: `finishBoundary` turns a failed or closed session into failed evidence.
    }
    try {
      await finishBoundary(session, collector, deps.runId, { timeoutMs: deps.boundaryTimeoutMs });
      return true;
    } catch {
      return false;
    }
  };
}

/** The persisted boundary input, read once: its digest and its verdict come from the same
 * bytes. */
function readBoundary(session: BoundarySession): { input: BoundaryInput; digest: string } | null {
  try {
    const bytes = readPrivate(session.artifactPath);
    const input = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    ) as BoundaryInput;
    return { input, digest: sha256(bytes) };
  } catch {
    return null;
  }
}

/** One fresh VM from the reconstructed manifest, then the record and the run's move. */
async function verifyInFreshVm(
  deps: VerifierDeps,
  input: VerifyInput,
  manifest: SourceManifest,
  plan: CommandPlan
): Promise<VerificationOutcome> {
  const { lifecycle } = deps;
  const unavailable = (reason: BoundaryUnavailableReason): VerificationOutcome => {
    journal(deps, input.candidateSha, { type: 'verification_boundary_unavailable', reason });
    return { kind: 'boundary_unavailable', reason, run: block(lifecycle) };
  };
  const collector = new OutputCollector();
  const session = await prepareBoundary(deps.artifactsDir);
  let vm: WorkspaceRun<boolean>;
  try {
    vm = await runWorkspace(
      { ...deps, collector },
      manifest,
      plan,
      finishProbe(deps, session, collector)
    );
  } catch (error) {
    try {
      session.cleanup();
    } catch {
      // The original failure is the one to report.
    }
    throw error;
  }
  try {
    session.cleanup();
  } catch {
    return unavailable('cleanup_failed');
  }
  if (!vm.beforeRelease) return unavailable('finalize_failed');
  const boundary = readBoundary(session);
  if (!boundary) return unavailable('artifact_unreadable');

  const tests = vm.records.filter((r) => r.captureReport);
  const regression = classifyRegression(
    input.regressionBase,
    overallStatus(
      tests.filter((r) => r.id.endsWith(REGRESSION_COMMAND_SUFFIX)).map((r) => r.status)
    )
  );
  const commands = tests.map((r) => r.evidence);
  const verdict = verificationVerdict(vm.records, regression, commands);
  const now = lifecycle.now().toISOString();
  const record = publishVerification(deps.artifactsDir, {
    runId: deps.runId,
    candidateSha: input.candidateSha,
    baseSha: input.record.baseSha,
    parentSha: input.record.baseSha,
    ...profileReceiptBinding(deps.profileRecord, vm.workspace.vm.accelerator),
    networkPolicy: { provisioning: 'package_proxy', verification: 'none' },
    commands,
    regression,
    verdict,
    boundaryHeld: isCleanHeldVerdict(runBoundaryVerdict([boundary.input], deps.runId)),
    boundaryInputRef: { artifact: path.basename(session.artifactPath), digest: boundary.digest },
    logsDigests: [
      ...new Set([...vm.workspace.provisioning, ...vm.records].map((r) => r.log.digest)),
    ],
    verifiedAt: now,
  });
  journal(deps, input.candidateSha, {
    type: 'verification_completed',
    verdict,
    boundaryHeld: record.boundaryHeld,
    recordDigest: record.recordDigest,
  });
  return {
    kind: 'verified',
    verdict,
    record,
    run: settle(lifecycle, record, now),
    replayed: false,
  };
}

/** Verifies `input.candidateSha` independently (see the module comment). Throws
 * `VerifierInputError` or `EvidencePlanError` before any work on a bad request. Once the
 * candidate is claimed, any failure that has not already moved the run (a
 * `ProvisioningFailedError` moved it to `unsupported`, a `VmCleanupError` to
 * `blocked_cleanup`) blocks it before the error propagates: a candidate is verified at
 * most once. */
export async function verifyCandidate(
  verifier: VerifierDeps,
  input: VerifyInput
): Promise<VerificationOutcome> {
  let observed = false;
  const lifecycle: RunLifecycle = {
    ...verifier.lifecycle,
    observeRun: (run) => {
      observed = true;
      verifier.lifecycle.observeRun(run);
    },
  };
  const deps: VerifierDeps = { ...verifier, lifecycle };
  const plan = assertVerifiable(deps, input);
  const state = verificationState(deps.artifactsDir, input.candidateSha);
  if (state === 'recorded') return replay(deps, input.candidateSha);
  if (state === 'attempted') {
    journal(deps, input.candidateSha, {
      type: 'verification_interrupted',
      reason: 'attempt_without_record',
    });
    return { kind: 'interrupted', reason: 'attempt_without_record', run: block(lifecycle) };
  }

  const rebuilt = reconstruct(input);
  if (!rebuilt.ok) {
    journal(deps, input.candidateSha, {
      type: 'verification_identity_mismatch',
      reason: rebuilt.reason,
    });
    return { kind: 'identity_mismatch', reason: rebuilt.reason, run: block(lifecycle) };
  }

  try {
    beginVerification(deps.artifactsDir, input.candidateSha);
  } catch (error) {
    if (error instanceof VerificationRecordError && error.code === 'record_exists')
      throw new VerifierInputError('already_verified');
    throw error;
  }
  try {
    return await verifyInFreshVm(deps, input, rebuilt.manifest, plan);
  } catch (error) {
    journal(deps, input.candidateSha, {
      type: 'verification_aborted',
      cause: error instanceof Error ? error.name : typeof error,
    });
    // `unsupported` (ProvisioningFailedError) and `blocked_cleanup` (VmCleanupError) were
    // already observed; the original failure wins over a failed block.
    if (!observed)
      try {
        block(lifecycle);
      } catch {}
    throw error;
  }
}
