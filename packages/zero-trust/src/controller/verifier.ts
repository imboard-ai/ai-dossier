/** Independent verifier (#1102; PRD §5.6 steps 6 to 8, §5.7, §5.9; scenarios 6, 7, 10
 * and 17). It rebuilds the exact candidate commit from the controller's sanitized
 * blobs, verifies it in a NEW VM with no network, takes the verdict only from what the
 * supervisor observed, routes it through the repair cap and persists a controller-owned
 * `VerificationRecord`. It signs nothing: shipping turns the record into a receipt just
 * in time. Fail closed throughout: an unreadable, inconsistent or partial answer never
 * reaches `shipping`. */
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
import { type CommandEvidence, type CommandStatus, evidenceVerified } from '../receipt/schema';
import { ReasonCode, type RunRecord, transitionRun } from '../state';
import type { ProxyTarget, VmAdapter, VmLimits } from '../vm/adapter';
import {
  type BoundarySession,
  finishBoundary,
  prepareBoundary,
  probeBoundary,
  runBoundaryVerdict,
} from '../vm/boundary-probe';
import { type BoundaryInput, isCleanHeldVerdict } from '../vm/evidence';
import {
  type CommandRecord,
  EvidencePlanError,
  type ProvisionedWorkspace,
  provisionWorkspace,
  type RunLifecycle,
  releaseWorkspace,
  runPlanned,
  workspaceStatus,
} from './evidence-runner';
import { OutputCollector } from './output-collector';
import {
  publishVerification,
  type VerificationRecord,
  type VerificationVerdict,
  verificationExists,
} from './verification-record';

/** Suffix that keeps the regression-target command's id distinct from the suite's. */
export const REGRESSION_COMMAND_SUFFIX = '-regression';

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
  /** The run must be in `verifying`; every state change reaches `observeRun`. */
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

export type VerificationOutcome =
  /** Reconstruction failed or rebuilt another SHA. No VM was created; the run is `blocked`. */
  | {
      readonly kind: 'identity_mismatch';
      readonly reason: CanonicalReason;
      readonly run: RunRecord;
    }
  /** Boundary evidence could not be produced (e.g. a secret in guest output, collector
   * truncation, unpublishable artifact). Nothing authoritative exists; the run is `blocked`. */
  | { readonly kind: 'boundary_unavailable'; readonly run: RunRecord }
  /** The record is persisted. `boundaryHeld: false` blocks the run whatever the verdict;
   * otherwise the verdict went through `applyVerification`. */
  | {
      readonly kind: 'verified';
      readonly verdict: VerificationVerdict;
      readonly record: VerificationRecord;
      readonly run: RunRecord;
    };

export type VerifierInputErrorCode =
  | 'run_not_verifying'
  | 'run_mismatch'
  | 'regression_not_reproduced'
  | 'already_verified';

/** Refused before reconstruction or any VM; `detail`-free, nothing echoed. */
export class VerifierInputError extends Error {
  constructor(readonly code: VerifierInputErrorCode) {
    super(`Verification refused (${code})`);
    this.name = 'VerifierInputError';
  }
}

/** The suite's verification commands, then the regression targets' test command(s)
 * with distinct ids. Setup commands run once; every command has no network. */
export function verificationPlan(
  profileRecord: ProfileRecord,
  endpoints: ProxyEndpoints,
  regressionTargets: readonly string[],
  planOptions: Omit<PlanOptions, 'testTargets'> = {}
): CommandPlan {
  if (regressionTargets.length === 0) throw new EvidencePlanError('no_regression_targets');
  const suite = buildCommandPlan(profileRecord.manager, endpoints, planOptions);
  const regression = buildCommandPlan(profileRecord.manager, endpoints, {
    ...planOptions,
    testTargets: regressionTargets,
  });
  const targeted = regression.verification
    .filter((c) => c.captureReport)
    .map((c) => Object.freeze({ ...c, id: `${c.id}${REGRESSION_COMMAND_SUFFIX}` }));
  if (targeted.length === 0 || !suite.verification.some((c) => c.captureReport))
    throw new EvidencePlanError('no_test_command');
  return Object.freeze({
    manager: suite.manager,
    provisioning: suite.provisioning,
    verification: Object.freeze([...suite.verification, ...targeted]),
  });
}

/** `passed` only when every command passed, the regression is `reproduced_and_fixed`
 * and the evidence is receipt-grade; a failing command stays `failed`; anything else is
 * `inconclusive`. */
export function verificationVerdict(
  records: readonly CommandRecord[],
  regression: RegressionProof,
  commands: readonly CommandEvidence[]
): VerificationVerdict {
  const status = workspaceStatus(records);
  if (status === 'failed') return 'failed';
  if (status !== 'passed') return 'inconclusive';
  return regression === 'reproduced_and_fixed' && evidenceVerified([...commands])
    ? 'passed'
    : 'inconclusive';
}

function block(lifecycle: RunLifecycle): RunRecord {
  const run = transitionRun(lifecycle.run, ReasonCode.PolicyBlocked, lifecycle.now().toISOString());
  lifecycle.observeRun(run);
  return run;
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

interface VmEvidence {
  readonly workspace: ProvisionedWorkspace;
  readonly records: readonly CommandRecord[];
  /** `null` when finalization threw: there is no authoritative boundary evidence. */
  readonly boundary: BoundaryInput | null;
}

/** One fresh VM: provision from the reconstructed manifest, run the plan offline, probe
 * and finish the boundary, then the bounded teardown. A probe failure is not thrown: the
 * finished session records it as failed evidence. */
async function runInFreshVm(
  deps: VerifierDeps,
  session: BoundarySession,
  manifest: SourceManifest,
  plan: CommandPlan
): Promise<VmEvidence> {
  const collector = new OutputCollector();
  const workspace = await provisionWorkspace({
    adapter: deps.adapter,
    runId: deps.runId,
    limits: deps.limits,
    profileRecord: deps.profileRecord,
    proxyTarget: deps.proxyTarget,
    collector,
    lifecycle: deps.lifecycle,
    artifactsDir: deps.artifactsDir,
    manifest,
    plan,
  });
  const records: CommandRecord[] = [];
  let boundary: BoundaryInput | null = null;
  try {
    for (const command of plan.verification)
      records.push(
        await runPlanned(deps.adapter, workspace, command, collector, {
          artifactsDir: deps.artifactsDir,
        })
      );
    try {
      await probeBoundary(session, deps.adapter, workspace.vm, workspace.profile);
    } catch {
      // The session is now closed and its input is failed evidence (finishBoundary).
    }
    try {
      boundary = await finishBoundary(session, collector, deps.runId, {
        timeoutMs: deps.boundaryTimeoutMs,
      });
    } catch {
      boundary = null;
    }
  } catch (error) {
    await releaseWorkspace(deps.adapter, workspace, deps.lifecycle, error);
    throw error;
  }
  await releaseWorkspace(deps.adapter, workspace, deps.lifecycle);
  return { workspace, records, boundary };
}

/** Verifies `input.candidateSha` independently (see the module comment). Throws
 * `VerifierInputError` or `EvidencePlanError` before any work on a bad request;
 * `ProvisioningFailedError` (run `unsupported`), `VmCleanupError` (run `blocked_cleanup`)
 * and adapter errors propagate after teardown with the run never in `shipping`. */
export async function verifyCandidate(
  deps: VerifierDeps,
  input: VerifyInput
): Promise<VerificationOutcome> {
  const { lifecycle } = deps;
  if (lifecycle.run.state !== 'verifying') throw new VerifierInputError('run_not_verifying');
  if (lifecycle.run.runId !== deps.runId) throw new VerifierInputError('run_mismatch');
  if (input.regressionBase !== 'failed') throw new VerifierInputError('regression_not_reproduced');
  const plan = verificationPlan(
    deps.profileRecord,
    deps.endpoints,
    input.regressionTargets,
    deps.planOptions
  );
  if (verificationExists(deps.artifactsDir, input.candidateSha))
    throw new VerifierInputError('already_verified');

  const rebuilt = reconstruct(input);
  if (!rebuilt.ok)
    return { kind: 'identity_mismatch', reason: rebuilt.reason, run: block(lifecycle) };

  const session = await prepareBoundary(deps.artifactsDir);
  let evidence: VmEvidence;
  try {
    evidence = await runInFreshVm(deps, session, rebuilt.manifest, plan);
  } finally {
    session.cleanup();
  }
  let boundary: BoundaryInput;
  let boundaryDigest: string;
  try {
    if (!evidence.boundary) throw new Error('no boundary evidence');
    boundary = evidence.boundary;
    boundaryDigest = sha256(readPrivate(session.artifactPath));
  } catch {
    return { kind: 'boundary_unavailable', run: block(lifecycle) };
  }

  const boundaryHeld = isCleanHeldVerdict(runBoundaryVerdict([boundary], deps.runId));
  const tests = evidence.records.filter((r) => r.captureReport);
  const regressionStatus = overallStatus(
    tests.filter((r) => r.id.endsWith(REGRESSION_COMMAND_SUFFIX)).map((r) => r.status)
  );
  const regression = classifyRegression(input.regressionBase, regressionStatus);
  const commands = tests.map((r) => r.evidence);
  const verdict = verificationVerdict(evidence.records, regression, commands);
  const record = publishVerification(deps.artifactsDir, {
    runId: deps.runId,
    candidateSha: input.candidateSha,
    baseSha: input.record.baseSha,
    parentSha: input.record.baseSha,
    ...profileReceiptBinding(deps.profileRecord, evidence.workspace.vm.accelerator),
    networkPolicy: { provisioning: 'package_proxy', verification: 'none' },
    commands,
    regression,
    verdict,
    boundaryHeld,
    boundaryInputRef: { artifact: path.basename(session.artifactPath), digest: boundaryDigest },
    logsDigests: [
      ...new Set(
        [...evidence.workspace.provisioning, ...evidence.records].map((r) => r.log.digest)
      ),
    ],
    verifiedAt: lifecycle.now().toISOString(),
  });
  const run = boundaryHeld
    ? applyVerification(lifecycle.run, verdict, lifecycle.now().toISOString())
    : transitionRun(lifecycle.run, ReasonCode.PolicyBlocked, lifecycle.now().toISOString());
  lifecycle.observeRun(run);
  return { kind: 'verified', verdict, record, run };
}
