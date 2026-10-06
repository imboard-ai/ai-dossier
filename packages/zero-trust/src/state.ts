/** Pure controller-owned lifecycle. Events are observations, not authorization proofs. */
import { assertNoSecrets } from './redaction';

export enum ReasonCode {
  RunCreated = 'run_created',
  PermissionRequired = 'permission_required',
  GatePassed = 'gate_passed',
  MaintainerInvited = 'maintainer_invited',
  PlanApproved = 'plan_approved',
  CandidateReady = 'candidate_ready',
  VerificationPassed = 'verification_passed',
  RepairRequired = 'repair_required',
  UserPaused = 'user_paused',
  ResumeGating = 'resume_gating',
  ResumePlanning = 'resume_planning',
  ResumeImplementing = 'resume_implementing',
  ResumeVerifying = 'resume_verifying',
  ResumeShipping = 'resume_shipping',
  ResumeRevising = 'resume_revising',
  PublicationObserved = 'publication_observed',
  ContributorHandoff = 'contributor_handoff',
  ForkMissing = 'fork_missing',
  InstallationMissing = 'installation_missing',
  InstallationTooBroad = 'installation_too_broad',
  EngagementObserved = 'engagement_observed',
  ReviewAwaited = 'review_awaited',
  RevisionRequested = 'revision_requested',
  UpstreamAccepted = 'upstream_accepted',
  ObservedUpstreamMerge = 'observed_upstream_merge',
  UpstreamDeclined = 'upstream_declined',
  PolicyBlocked = 'policy_blocked',
  UnsupportedEnvironment = 'unsupported_environment',
  ExecutionFailed = 'execution_failed',
  UserCancelled = 'user_cancelled',
  CleanupFailed = 'cleanup_failed',
  CleanupCompleted = 'cleanup_completed',
}

type Edges = Readonly<Partial<Record<ReasonCode, RunState>>>;
/** An observed hand-off must match the phase that issued it. */
const HANDOFF_ORIGIN: Readonly<Partial<Record<ReasonCode, string>>> = Object.freeze({
  [ReasonCode.EngagementObserved]: 'gating',
  [ReasonCode.PublicationObserved]: 'shipping',
});
/** Manual contributor prerequisites (#1065): a durable wait, re-checked only on explicit resume. */
const PREREQUISITE_REASONS: readonly ReasonCode[] = Object.freeze([
  ReasonCode.ForkMissing,
  ReasonCode.InstallationMissing,
]);
const prerequisites = {
  [ReasonCode.ForkMissing]: 'awaiting_contributor',
  [ReasonCode.InstallationMissing]: 'awaiting_contributor',
} as const;
const failures = {
  [ReasonCode.PolicyBlocked]: 'blocked',
  [ReasonCode.InstallationTooBroad]: 'blocked',
  [ReasonCode.UnsupportedEnvironment]: 'unsupported',
  [ReasonCode.ExecutionFailed]: 'failed',
  [ReasonCode.UserCancelled]: 'cancelled',
  [ReasonCode.CleanupFailed]: 'blocked_cleanup',
} as const;
const outcomes = {
  [ReasonCode.ObservedUpstreamMerge]: 'merged',
  [ReasonCode.UpstreamAccepted]: 'accepted',
  [ReasonCode.UpstreamDeclined]: 'declined',
} as const;

/** Single source of truth; frozen at runtime, including each row. */
export const TRANSITIONS = Object.freeze({
  gating: Object.freeze({
    ...failures,
    [ReasonCode.PermissionRequired]: 'awaiting_maintainer',
    [ReasonCode.GatePassed]: 'planning',
    [ReasonCode.UserPaused]: 'paused_user',
    [ReasonCode.ContributorHandoff]: 'awaiting_contributor',
    ...prerequisites,
  } as const),
  awaiting_maintainer: Object.freeze({
    ...failures,
    [ReasonCode.MaintainerInvited]: 'gating',
    [ReasonCode.UpstreamDeclined]: 'declined',
  } as const),
  planning: Object.freeze({
    ...failures,
    [ReasonCode.PlanApproved]: 'implementing',
    [ReasonCode.UserPaused]: 'paused_user',
  } as const),
  implementing: Object.freeze({
    ...failures,
    [ReasonCode.CandidateReady]: 'verifying',
    [ReasonCode.UserPaused]: 'paused_user',
  } as const),
  verifying: Object.freeze({
    ...failures,
    [ReasonCode.VerificationPassed]: 'shipping',
    [ReasonCode.RepairRequired]: 'implementing',
    [ReasonCode.UserPaused]: 'paused_user',
  } as const),
  paused_user: Object.freeze({
    ...failures,
    [ReasonCode.ResumeGating]: 'gating',
    [ReasonCode.ResumePlanning]: 'planning',
    [ReasonCode.ResumeImplementing]: 'implementing',
    [ReasonCode.ResumeVerifying]: 'verifying',
    [ReasonCode.ResumeShipping]: 'shipping',
    [ReasonCode.ResumeRevising]: 'revising',
  } as const),
  shipping: Object.freeze({
    ...failures,
    [ReasonCode.PublicationObserved]: 'submitted',
    [ReasonCode.UserPaused]: 'paused_user',
    [ReasonCode.ContributorHandoff]: 'awaiting_contributor',
    ...prerequisites,
  } as const),
  // Durable hand-off (PRD §5.8): the contributor submits, or creates the fork / installs the
  // App by hand; no compute until an explicit resume reconciles or re-checks.
  awaiting_contributor: Object.freeze({
    ...failures,
    [ReasonCode.EngagementObserved]: 'awaiting_maintainer',
    [ReasonCode.PublicationObserved]: 'submitted',
    // A re-check may find the other prerequisite missing; the wait continues.
    ...prerequisites,
    [ReasonCode.ResumeGating]: 'gating',
    [ReasonCode.ResumeShipping]: 'shipping',
  } as const),
  submitted: Object.freeze({
    ...failures,
    ...outcomes,
    [ReasonCode.ReviewAwaited]: 'awaiting_review',
    [ReasonCode.RevisionRequested]: 'revising',
  } as const),
  awaiting_review: Object.freeze({
    ...failures,
    ...outcomes,
    [ReasonCode.RevisionRequested]: 'revising',
  } as const),
  revising: Object.freeze({
    ...failures,
    [ReasonCode.CandidateReady]: 'verifying',
    [ReasonCode.UserPaused]: 'paused_user',
  } as const),
  accepted: Object.freeze({
    ...failures,
    [ReasonCode.ObservedUpstreamMerge]: 'merged',
    [ReasonCode.UpstreamDeclined]: 'declined',
    [ReasonCode.RevisionRequested]: 'revising',
  } as const),
  merged: Object.freeze({}),
  declined: Object.freeze({}),
  blocked: Object.freeze({}),
  unsupported: Object.freeze({}),
  failed: Object.freeze({}),
  cancelled: Object.freeze({}),
  // No escape through paused_user or gating. Cleanup completion closes this run.
  blocked_cleanup: Object.freeze({ [ReasonCode.CleanupCompleted]: 'blocked' } as const),
});

export type RunState = keyof typeof TRANSITIONS;
export const RUN_STATES: readonly RunState[] = Object.freeze(
  Object.keys(TRANSITIONS) as RunState[]
);
export const TERMINAL_STATES: readonly RunState[] = Object.freeze(
  RUN_STATES.filter((state) => Object.keys(TRANSITIONS[state]).length === 0)
);

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: RunState,
    readonly reasonCode: ReasonCode
  ) {
    super('Illegal zero-trust lifecycle transition');
    this.name = 'IllegalTransitionError';
  }
}

export class InvalidRunError extends Error {
  constructor() {
    super('Invalid zero-trust run record');
    this.name = 'InvalidRunError';
  }
}

export interface TransitionRecord {
  readonly from: RunState;
  readonly to: RunState;
  readonly reasonCode: ReasonCode;
  readonly timestamp: string;
}

export interface RunRecord {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly upstreamIssue: string;
  readonly contributor: string;
  readonly state: RunState;
  readonly reasonCode: ReasonCode;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly history: readonly TransitionRecord[];
}

export function isRunState(value: unknown): value is RunState {
  return typeof value === 'string' && Object.hasOwn(TRANSITIONS, value);
}

export function isReasonCode(value: unknown): value is ReasonCode {
  return Object.values(ReasonCode).includes(value as ReasonCode);
}

export function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function freezeRun(run: RunRecord): RunRecord {
  return Object.freeze({
    ...run,
    history: Object.freeze(run.history.map((entry) => Object.freeze({ ...entry }))),
  });
}

/** Explicit new-run creation; never mutates/reopens a terminal run. */
export function createRun(
  input: Pick<RunRecord, 'runId' | 'upstreamIssue' | 'contributor'>,
  timestamp: string,
  previousRun?: RunRecord
): RunRecord {
  if (
    !isNonemptyString(input.runId) ||
    !isNonemptyString(input.upstreamIssue) ||
    !isNonemptyString(input.contributor) ||
    !isTimestamp(timestamp) ||
    (previousRun && input.runId === previousRun.runId)
  )
    throw new InvalidRunError();
  for (const field of [input.runId, input.upstreamIssue, input.contributor]) assertNoSecrets(field);
  return freezeRun({
    schemaVersion: 1,
    runId: input.runId,
    upstreamIssue: input.upstreamIssue,
    contributor: input.contributor,
    state: 'gating',
    reasonCode: ReasonCode.RunCreated,
    createdAt: timestamp,
    updatedAt: timestamp,
    history: [],
  });
}

export function permittedTransitions(state: RunState): Edges {
  if (!isRunState(state)) throw new InvalidRunError();
  return TRANSITIONS[state];
}

/** Validate the persisted record before admitting an event. No ambient clock. */
export function transitionRun(
  run: RunRecord,
  reasonCode: ReasonCode,
  timestamp: string
): RunRecord {
  const valid = restoreRun(run);
  return applyTransition(valid, reasonCode, timestamp);
}

/** The transition that entered the current `awaiting_contributor` wait (self-loops skipped). */
function waitEntry(run: RunRecord): TransitionRecord {
  for (let index = run.history.length - 1; index >= 0; index--) {
    const entry = run.history[index] as TransitionRecord;
    if (entry.from !== 'awaiting_contributor') return entry;
  }
  throw new InvalidRunError();
}

/** The phase a fork/installation wait returns to on resume; null outside such a wait. */
export function prerequisiteWaitOrigin(run: RunRecord): RunState | null {
  if (run.state !== 'awaiting_contributor') return null;
  const entry = waitEntry(run);
  return PREREQUISITE_REASONS.includes(entry.reasonCode) ? entry.from : null;
}

function applyTransition(run: RunRecord, reasonCode: ReasonCode, timestamp: string): RunRecord {
  const to = isReasonCode(reasonCode) ? (TRANSITIONS[run.state] as Edges)[reasonCode] : undefined;
  if (!to) throw new IllegalTransitionError(run.state, reasonCode);
  // A checkpoint cannot skip forward or silently switch the paused phase.
  if (
    run.state === 'paused_user' &&
    !Object.hasOwn(failures, reasonCode) &&
    to !== run.history.at(-1)?.from
  )
    throw new IllegalTransitionError(run.state, reasonCode);
  if (run.state === 'awaiting_contributor' && !Object.hasOwn(failures, reasonCode)) {
    // A link hand-off is left only by observing its submission from the phase that issued
    // it; a prerequisite wait only by a re-check, and a resume returns to its own phase.
    const entry = waitEntry(run);
    const legal = PREREQUISITE_REASONS.includes(entry.reasonCode)
      ? HANDOFF_ORIGIN[reasonCode] === undefined && (to === run.state || to === entry.from)
      : HANDOFF_ORIGIN[reasonCode] === entry.from;
    if (!legal) throw new IllegalTransitionError(run.state, reasonCode);
  }
  if (!isTimestamp(timestamp) || Date.parse(timestamp) < Date.parse(run.updatedAt))
    throw new InvalidRunError();
  return freezeRun({
    ...run,
    state: to,
    reasonCode,
    updatedAt: timestamp,
    history: [...run.history, { from: run.state, to, reasonCode, timestamp }],
  });
}

/** Replay JSON against the same table; caller owns atomic durable storage. */
export function restoreRun(value: unknown): RunRecord {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.history) ||
    !isRunState(value.state) ||
    !isReasonCode(value.reasonCode) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !isNonemptyString(value.runId) ||
    !isNonemptyString(value.upstreamIssue) ||
    !isNonemptyString(value.contributor)
  )
    throw new InvalidRunError();
  let run = createRun(
    { runId: value.runId, upstreamIssue: value.upstreamIssue, contributor: value.contributor },
    value.createdAt
  );
  for (const entry of value.history) {
    if (
      !isRecord(entry) ||
      entry.from !== run.state ||
      !isReasonCode(entry.reasonCode) ||
      !isTimestamp(entry.timestamp)
    )
      throw new InvalidRunError();
    run = applyTransition(run, entry.reasonCode, entry.timestamp);
    if (entry.to !== run.state) throw new InvalidRunError();
  }
  if (
    value.state !== run.state ||
    value.reasonCode !== run.reasonCode ||
    value.updatedAt !== run.updatedAt
  )
    throw new InvalidRunError();
  return run;
}

export function serializeRun(run: RunRecord): string {
  return JSON.stringify(restoreRun(run));
}

export function deserializeRun(json: string): RunRecord {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new InvalidRunError();
  }
  return restoreRun(value);
}
