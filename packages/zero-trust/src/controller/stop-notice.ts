/** Why a run stopped, retained for `zt-run status`. The producer that stops the run writes
 * the notice; status shows it only for exactly that stop (same state, same history length),
 * so a later, unrelated stop never displays it. All text is fixed: no untrusted bytes. */

import type { WriteBlockReason } from '../intents';
import { INTEGRITY_CODES, type IntegrityCode } from '../review/integrity';
import type { RunRecord } from '../state';
import type { DriftHandoffReason } from './drift';
import type { ProxyCaReason } from './proxy-preflight';
import { VerificationRecordError } from './verification-record';

export interface StopNotice {
  readonly state: RunRecord['state'];
  /** The run history length once the stop is recorded. */
  readonly historyLength: number;
  readonly reason: string;
  readonly nextPermittedAction: string;
  /** Exact diagnostic artifact owned by this completed policy hand-off. */
  readonly gateAssessmentDigest?: string;
}
export const STOP_NOTICE_KEY = 'stop_notice';

export function provisioningNotice(
  reason: ProxyCaReason | 'provisioning_failed'
): Omit<StopNotice, 'historyLength'> {
  const action =
    reason === 'provisioning_failed'
      ? 'Inspect the provisioning diagnostic and package mirror, correct the unavailable input, then resume explicitly.'
      : reason === 'proxy_ca_not_yet_valid'
        ? 'Check the controller clock and proxy CA validity, then resume explicitly.'
        : 'Restart the proxy (zt-proxy down, then zt-proxy up), check caCertificateFile in the run endpoints file, then resume explicitly.';
  return {
    state: 'paused_user',
    reason,
    nextPermittedAction: `${reason}: ${action} No broader network or automatic repair is permitted.`,
  };
}

const REVISION_REFRESH_ACTIONS = Object.freeze({
  unavailable:
    'Revision feedback was not admitted, and GitHub could not be read while checking for newer maintainer feedback; nothing was recorded. Run resume --revise again later, or cancel the run.',
  reopen_pending:
    'Revision feedback was not admitted, and the pull request is closed. Reopen it on GitHub, then run resume --revise: the run confirms the reopen by reading it back before it looks for newer maintainer feedback.',
  refreshed_unjudged:
    'Newer maintainer feedback was selected for this revision but not yet judged. Run resume --revise to judge it; the refused feedback is never judged again.',
} as const);

/** Why an explicit --revise of a refused revision handed off again without new work (#1223). */
export function revisionRefreshNotice(
  reason: keyof typeof REVISION_REFRESH_ACTIONS
): Omit<StopNotice, 'historyLength'> {
  return {
    state: 'paused_user',
    reason: `revision_${reason}`,
    nextPermittedAction: REVISION_REFRESH_ACTIONS[reason],
  };
}

/** Structural view of the step artifact journal (`StepArtifacts`). */
interface NoticeStore {
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
}

/** `transitionPending`: the controller records the stop after the producer returns (one more
 * history entry). False when the run stays in its current state, e.g. a hand-off wait. */
export function recordStopNotice(
  store: NoticeStore,
  run: Pick<RunRecord, 'history'>,
  notice: Omit<StopNotice, 'historyLength'>,
  transitionPending: boolean
): void {
  store.put(STOP_NOTICE_KEY, {
    ...notice,
    historyLength: run.history.length + (transitionPending ? 1 : 0),
  } satisfies StopNotice);
}

/** Producers retire their notice when they run again: a crash between a notice and its
 * stop then cannot leave the notice behind for a later stop at the same length. */
export function clearStopNotice(store: NoticeStore): void {
  if (store.get(STOP_NOTICE_KEY) != null) store.put(STOP_NOTICE_KEY, null);
}

export type ControllerRefusalReason =
  | 'active_time_exhausted'
  | 'budget_exhausted'
  | 'hold_unsettled';

const CONTROLLER_REFUSAL_ACTIONS: Readonly<Record<ControllerRefusalReason, string>> = Object.freeze(
  {
    active_time_exhausted:
      'No further phase work was admitted: active_time_exhausted. The active-time limit cannot be extended for this run. Cancel it or start a new run with an appropriate limit.',
    budget_exhausted:
      'No further phase work was admitted: budget_exhausted. Inspect the retained budget limits and start a new run with an appropriate budget. To cancel this run, request cancel then explicitly resume to apply it.',
    hold_unsettled:
      'No further phase work was admitted: hold_unsettled. Inspect the retained budget reservations and reconcile their actual outcome before explicitly resuming, or cancel the run. Extending the budget does not settle an unknown hold.',
  }
);

export function controllerRefusalNotice(
  reason: ControllerRefusalReason,
  state: RunRecord['state']
): Omit<StopNotice, 'historyLength'> {
  return {
    state,
    reason,
    nextPermittedAction:
      state === 'blocked_cleanup'
        ? `No further phase work was admitted: ${reason}. Cleanup remains incomplete. Inspect the retained cleanup evidence and explicitly resume to retry cleanup; cancellation is unavailable until cleanup is reconciled.`
        : CONTROLLER_REFUSAL_ACTIONS[reason],
  };
}

/** Admission must not retire a notice owned by a different phase producer. */
export function clearControllerRefusalNotice(store: NoticeStore): void {
  const notice = store.get<StopNotice | null>(STOP_NOTICE_KEY);
  if (notice && Object.hasOwn(CONTROLLER_REFUSAL_ACTIONS, notice.reason)) clearStopNotice(store);
}

/** Release cleanup may add a final transition after the controller's stop. Rebind
 * only an existing admission refusal; never create one or replace a producer's notice. */
export function rebindControllerRefusalNotice(store: NoticeStore, run: RunRecord): void {
  const notice = store.get<StopNotice | null>(STOP_NOTICE_KEY);
  if (notice && Object.hasOwn(CONTROLLER_REFUSAL_ACTIONS, notice.reason))
    recordStopNotice(
      store,
      run,
      controllerRefusalNotice(notice.reason as ControllerRefusalReason, run.state),
      false
    );
}

/** The action status shows for `run`, or undefined when no notice explains this stop. */
export function stopNoticeAction(
  notice: unknown,
  run: Pick<RunRecord, 'state' | 'history'>
): string | undefined {
  if (!notice || typeof notice !== 'object') return undefined;
  const { state, historyLength, nextPermittedAction } = notice as Partial<StopNotice>;
  return state === run.state &&
    historyLength === run.history.length &&
    typeof nextPermittedAction === 'string'
    ? nextPermittedAction
    : undefined;
}

const DRIFT_HANDOFF_ACTIONS: Readonly<Record<DriftHandoffReason, string>> = Object.freeze({
  rebase_conflict:
    'Upstream changed a file this patch also changes, so the candidate was not rebased (no text merging). Nothing was pushed. Start a new run on the current upstream.',
  base_unknown:
    'The current upstream base could not be read, so nothing was pushed. Resume explicitly to check it again.',
  base_unstable:
    "Upstream kept advancing past this session's rebase limit. Nothing was pushed. Start a new run on the current upstream.",
  rebase_unavailable:
    'The candidate could not be rebased onto the current upstream base. Nothing was pushed. Start a new run on the current upstream.',
});

export function driftHandoffNotice(reason: DriftHandoffReason): Omit<StopNotice, 'historyLength'> {
  return { state: 'paused_user', reason, nextPermittedAction: DRIFT_HANDOFF_ACTIONS[reason] };
}

/** Why the gate handed off. Closed set: the policy decision's own codes plus the checks
 * the gate step makes before and after it. */
export const GATE_HANDOFF_REASONS = Object.freeze([
  'issue_unknown',
  'policy_unknown',
  'multiple_templates',
  'ai_unclear',
  'ownership_unclear',
  'ban_citation_missing',
  'unknown_input',
  'real_name_required',
  'issue_unreadable',
] as const);
export type GateHandoffReason = (typeof GATE_HANDOFF_REASONS)[number];

/** Dedupes `values` into the closed `allowed` set; anything else becomes `fallback`, so no
 * untrusted text reaches status. */
function closedReason(
  values: readonly string[],
  allowed: readonly string[],
  fallback: string
): string {
  const closed = [...new Set(values.map((v) => (allowed.includes(v) ? v : fallback)))];
  return closed.length ? closed.join(',') : fallback;
}

/** A gate hand-off leaves the run in `gating`; the notice is its only record. Unknown
 * decision codes collapse to `unknown_input`, so no untrusted text reaches status. */
export function gateHandoffNotice(reasons: readonly string[]): Omit<StopNotice, 'historyLength'> {
  const reason = closedReason(reasons, GATE_HANDOFF_REASONS, 'unknown_input');
  return {
    state: 'gating',
    reason,
    nextPermittedAction: `Handed off at the gate (${reason}). No implementation VM or code work started and nothing was published. Policy decision calls may already have run and been charged; inspect policyGate evidence if present, and estimatedSpend in status. Check the upstream issue and contribution policy, then resume explicitly or contribute manually.`,
  };
}

/** Why review handed off: the integrity review's codes (#1205), or the regression proof
 * that runs before it. */
export type ReviewHandoffReason =
  | IntegrityCode
  | 'no_regression_test'
  | 'regression_not_reproduced';
const REVIEW_HANDOFF_REASONS: readonly ReviewHandoffReason[] = Object.freeze([
  ...INTEGRITY_CODES,
  'no_regression_test',
  'regression_not_reproduced',
]);

/** Review refused the candidate. The run pauses with the candidate retained. */
export function reviewHandoffNotice(
  reasons: readonly ReviewHandoffReason[]
): Omit<StopNotice, 'historyLength'> {
  const reason = closedReason(reasons, REVIEW_HANDOFF_REASONS, 'invalid_input');
  return {
    state: 'paused_user',
    reason,
    nextPermittedAction: `Review refused the candidate (${reason}). Nothing was pushed; the candidate is retained in artifacts/candidate.diff. Fix it with \`edit --run <id> --patch <file>\` and resume, start a new run, or contribute manually. A plain resume repeats the same review.`,
  };
}

/** Permission freshness (PRD §5.9): revocation, closure or a policy change blocks. */
export function freshnessNotice(reasons: readonly string[]): Omit<StopNotice, 'historyLength'> {
  return {
    state: 'blocked',
    reason: reasons.join(','),
    nextPermittedAction: `Blocked by the publication freshness check (${reasons.join(', ')}). No further write or link follows; the candidate, its verification and the freshness evidence are retained. Start a new run if the contribution should continue.`,
  };
}

/** Scenario 10: evidence that no longer matches what the verdict recorded (a torn or
 * corrupted record, or an altered or unreadable boundary/log artifact). An unavailable
 * record (a transient read failure) is not altered evidence. */
export function isAlteredEvidence(error: unknown): boolean {
  return (
    error instanceof VerificationRecordError &&
    (error.code === 'invalid_record' || error.code === 'evidence_mismatch')
  );
}

export function alteredEvidenceNotice(receiptIssued: boolean): Omit<StopNotice, 'historyLength'> {
  return {
    state: 'blocked',
    reason: 'verification_altered',
    nextPermittedAction: receiptIssued
      ? 'The verification evidence changed after the verdict. A receipt was already issued, so the fork branch may hold the candidate; no further write or link follows. Inspect the fork branch. Fresh verification requires a new run.'
      : 'The verification evidence changed after the verdict, so no receipt was issued and nothing was pushed. Fresh verification requires a new run.',
  };
}

const WRITE_BLOCK_STATES: Partial<Record<WriteBlockReason, string>> = Object.freeze({
  remote_diverged:
    'the fork branch holds a commit no verified push left there, and nothing on it was overwritten',
  fork_unverified: 'the fork no longer resolves to the bound repository, and nothing was pushed',
  authorization_refused:
    'the push authorization was refused before any credential was used, and nothing was pushed',
});

/** The intent journal blocked the push. Only the refusals proven before any write say so;
 * every other reason leaves the fork branch state unconfirmed. */
export function writeBlockedNotice(reason: WriteBlockReason): Omit<StopNotice, 'historyLength'> {
  const state = WRITE_BLOCK_STATES[reason] ?? 'the fork branch state could not be confirmed';
  return {
    state: 'blocked',
    reason,
    nextPermittedAction: `Blocked before publication (${reason}): ${state}. No link was issued. Inspect the fork branch before starting a new run.`,
  };
}
