import { budgetTotals } from '../budget';
import type { BudgetState } from '../budget-types';
import { prerequisiteAction } from '../github/fork';
import { type HandoffState, handoffStatus } from '../github/handoff-driver';
import { assertSecretFree } from '../redaction';
import { type RunRecord, type RunState, restoreRun, sameRunRecord } from '../state';
import { InvalidStatusError, renderJson, type StatusRecord } from '../status';
import type { AuthorApproval } from './config';
import { contributionIdOf } from './ids';
import { lifecycleTimes } from './lifecycle-times';
export const DEFAULT_STATE_ACTIONS: Readonly<Record<RunState, string>> = Object.freeze({
  gating: 'Inspect eligibility and contribution policies.',
  awaiting_maintainer: 'Resume explicitly to check the maintainer invitation.',
  planning: 'Prepare the implementation plan.',
  implementing: 'Implement the approved plan in isolation.',
  verifying: 'Independently verify the immutable candidate.',
  shipping:
    'Publish only the independently verified candidate through the bound shipping operations.',
  paused_user: 'Resume explicitly on a fresh VM; approve an open checkpoint first.',
  awaiting_contributor: 'Complete the contributor hand-off, then resume explicitly.',
  submitted: 'Resume explicitly to observe upstream review and CI.',
  awaiting_review: 'Resume explicitly to observe maintainer feedback.',
  revising: 'Address the approved maintainer feedback in isolation.',
  accepted: 'Resume explicitly to observe an upstream merge.',
  merged: 'No further execution; the upstream merge was observed.',
  declined: 'No further execution; the contribution was declined.',
  blocked: 'Inspect the recorded block before starting a new run.',
  unsupported: 'Choose a supported environment for a new run.',
  failed: 'Inspect the preserved failure evidence before starting a new run.',
  cancelled: 'No further execution; the run was cancelled.',
  blocked_cleanup: 'Reconcile remaining resources and credentials before closing cleanup.',
});
export interface StatusParts {
  readonly publicationWaitMs?: number;
  readonly run: RunRecord;
  readonly now: Date | string;
  readonly phase?: string;
  readonly candidateSha?: string;
  readonly budget: BudgetState;
  readonly sessionId: string;
  readonly authorApproval?: AuthorApproval;
  readonly handoff?: HandoffState;
  /** Structural type: credential modules are never imported, even for types. */
  readonly tracker?: { readonly state: RunState; readonly nextPermittedAction: string };
  readonly prerequisite?: {
    readonly upstream: {
      readonly repositoryId: number;
      readonly owner: string;
      readonly repo: string;
      readonly defaultBranch: string;
    };
    readonly appSlug: string;
    readonly forkName?: string;
  };
}
/** Pure assembly, no reads/polling or external writes. Monetary amounts are minor units. */
export function assembleStatus(parts: StatusParts): StatusRecord {
  parts = structuredClone(parts);
  assertSecretFree(parts);
  const run = restoreRun(parts.run);
  const now = Date.parse(parts.now instanceof Date ? parts.now.toISOString() : parts.now);
  if (!Number.isFinite(now) || now < Date.parse(run.updatedAt)) throw new InvalidStatusError();
  let activeTimeMs: number;
  try {
    const sessionIndex = parts.budget.sessions.findIndex((s) => s.id === parts.sessionId);
    const revisions = run.history.filter((e) => e.reasonCode === 'revision_requested');
    const since =
      sessionIndex > 0
        ? Date.parse(revisions[sessionIndex - 1]?.timestamp ?? '')
        : Date.parse(run.createdAt);
    if (!Number.isFinite(since)) throw new InvalidStatusError();
    activeTimeMs = lifecycleTimes(run, now, since).activeMs;
    const waiting = parts.publicationWaitMs ?? 0;
    if (!Number.isSafeInteger(waiting) || waiting < 0 || waiting > activeTimeMs)
      throw new InvalidStatusError();
    activeTimeMs -= waiting;
  } catch {
    throw new InvalidStatusError();
  }
  const session = parts.budget.sessions.find((s) => s.id === parts.sessionId);
  if (!session || parts.budget.contributionId !== contributionIdOf(run.runId))
    throw new InvalidStatusError();
  const totals = budgetTotals(parts.budget, parts.sessionId);
  const spend = totals.spent + totals.reserved;
  if (!Number.isSafeInteger(spend)) throw new InvalidStatusError();
  if (
    parts.handoff &&
    (!sameRunRecord(restoreRun(parts.handoff.run), run) ||
      parts.handoff.contributionId !== contributionIdOf(run.runId))
  )
    throw new InvalidStatusError();
  if (parts.tracker && parts.tracker.state !== run.state) throw new InvalidStatusError();
  const handoff = parts.handoff ? handoffStatus(parts.handoff) : null;
  const prerequisite = parts.prerequisite
    ? prerequisiteAction(
        run,
        parts.prerequisite.upstream,
        parts.prerequisite.appSlug,
        parts.prerequisite.forkName
      )
    : null;
  const status: StatusRecord = {
    runId: run.runId,
    phase: parts.phase ?? run.state,
    state: run.state,
    upstreamIssue: run.upstreamIssue,
    contributor: run.contributor,
    ...(parts.authorApproval === undefined ? {} : { authorApproval: parts.authorApproval }),
    ...(parts.candidateSha === undefined ? {} : { candidateSha: parts.candidateSha }),
    activeTimeMs,
    estimatedSpend: { amount: spend, currency: session.ceiling.currency },
    budgetRemaining: {
      amount: Math.max(0, session.ceiling.minor - spend),
      currency: session.ceiling.currency,
    },
    reasonCode: run.history.at(-1)?.reasonCode ?? run.reasonCode,
    nextPermittedAction:
      (handoff ? `${handoff.nextPermittedAction} Link: ${handoff.link}` : undefined) ??
      parts.tracker?.nextPermittedAction ??
      prerequisite?.nextPermittedAction ??
      DEFAULT_STATE_ACTIONS[run.state],
  };
  // Validate every emitted fact through the same whitelist used by both renderers.
  renderJson(status);
  return status;
}
