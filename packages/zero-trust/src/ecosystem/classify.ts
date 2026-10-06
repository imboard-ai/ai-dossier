/** Classifies supervised command outcomes and enforces the repair cap (PRD §5.6.7,
 * scenario 7). Absence of evidence is never a pass. */
import type { CommandEvidence, CommandStatus } from '../receipt/schema';
import { ReasonCode, type RunRecord, transitionRun } from '../state';
import type { PlannedCommand } from './commands';

/** What the controller's process supervisor observed — never a repository-authored file. */
export type CommandOutcome =
  | { readonly kind: 'timeout' }
  | { readonly kind: 'signal'; readonly signal: string }
  | {
      readonly kind: 'exited';
      readonly exitCode: number;
      /** Parsed test report; `null` when missing or unreadable. */
      readonly report: { readonly suites: number } | null;
    };

/** `failed` needs a readable report: a non-zero exit with no report could equally be
 * a crash of the runner, so it stays inconclusive. */
export function classifyOutcome(outcome: CommandOutcome): CommandStatus {
  if (outcome.kind !== 'exited') return 'inconclusive';
  if (outcome.report === null || !Number.isSafeInteger(outcome.report.suites))
    return 'inconclusive';
  if (outcome.exitCode !== 0) return 'failed';
  return outcome.report.suites > 0 ? 'passed' : 'inconclusive';
}

/** Maps an outcome to the receipt's command evidence (status, exit code, suites). */
export function commandEvidence(
  command: PlannedCommand,
  outcome: CommandOutcome,
  sanitizedLogDigest: string
): CommandEvidence {
  const exited = outcome.kind === 'exited';
  return {
    id: command.id,
    command: command.argv.join(' '),
    required: command.required,
    status: classifyOutcome(outcome),
    exitStatus:
      exited &&
      Number.isInteger(outcome.exitCode) &&
      outcome.exitCode >= 0 &&
      outcome.exitCode <= 255
        ? outcome.exitCode
        : 'unknown',
    suites: exited && outcome.report !== null ? outcome.report.suites : 'unknown',
    sanitizedLogDigest,
  };
}

/** Rolls several command statuses up: any inconclusive wins over failed, and only an
 * all-passed set passes. */
export function overallStatus(statuses: readonly CommandStatus[]): CommandStatus {
  if (statuses.length === 0 || statuses.some((s) => s === 'inconclusive' || s === 'skipped'))
    return 'inconclusive';
  return statuses.every((s) => s === 'passed') ? 'passed' : 'failed';
}

export type RegressionProof =
  | 'reproduced_and_fixed'
  | 'not_reproduced'
  | 'still_failing'
  | 'inconclusive';

/** Scenario 6: the regression must FAIL on the base and PASS on the candidate. A
 * base that passes means the bug was not reproduced — hand off before patching. */
export function classifyRegression(base: CommandStatus, candidate: CommandStatus): RegressionProof {
  if (base === 'inconclusive' || base === 'skipped') return 'inconclusive';
  if (base === 'passed') return 'not_reproduced';
  if (candidate === 'passed') return 'reproduced_and_fixed';
  return candidate === 'failed' ? 'still_failing' : 'inconclusive';
}

export const MAX_REPAIR_ATTEMPTS = 2;

export class RepairCapExceededError extends Error {
  constructor(readonly repairsUsed: number) {
    super('Zero-trust repair cap reached');
    this.name = 'RepairCapExceededError';
  }
}

/** Repairs used in the current execution session, derived from immutable history so
 * the cap survives restarts. A session starts at plan approval or a new revision. */
export function repairsUsed(run: RunRecord): number {
  let count = 0;
  for (const entry of run.history) {
    if (
      entry.reasonCode === ReasonCode.PlanApproved ||
      entry.reasonCode === ReasonCode.RevisionRequested
    )
      count = 0;
    else if (entry.reasonCode === ReasonCode.RepairRequired) count++;
  }
  return count;
}

/** Throws when another repair would exceed the cap (the third repair is refused). */
export function assertRepairAllowed(run: RunRecord): void {
  const used = repairsUsed(run);
  if (used >= MAX_REPAIR_ATTEMPTS) throw new RepairCapExceededError(used);
}

/** Applies a verification verdict to a `verifying` run: pass → shipping; otherwise a
 * repair while the cap allows, then `failed`. Inconclusive is never a pass. */
export function applyVerification(
  run: RunRecord,
  verdict: CommandStatus,
  timestamp: string
): RunRecord {
  if (verdict === 'passed') return transitionRun(run, ReasonCode.VerificationPassed, timestamp);
  if (repairsUsed(run) < MAX_REPAIR_ATTEMPTS)
    return transitionRun(run, ReasonCode.RepairRequired, timestamp);
  return transitionRun(run, ReasonCode.ExecutionFailed, timestamp);
}
