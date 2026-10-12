import { isRecord, type RunRecord, type RunState, restoreRun } from '../state';

const ACTIVE: readonly RunState[] = [
  'gating',
  'planning',
  'implementing',
  'verifying',
  'shipping',
  'revising',
];
const WAIT = {
  awaiting_maintainer: 'maintainer',
  awaiting_contributor: 'contributor',
  submitted: 'review',
  awaiting_review: 'review',
  accepted: 'review',
  paused_user: 'paused',
} as const;
/** Shared status/metrics policy: each elapsed interval belongs to its preceding state.
 * `activeSince` clips active intervals to the selected budget session's start; waits are
 * not clipped. */
export function lifecycleTimes(
  input: RunRecord,
  now: number,
  activeSince = Number.NEGATIVE_INFINITY
) {
  const run = restoreRun(input);
  if (!Number.isFinite(now) || now < Date.parse(run.updatedAt))
    throw new Error('Invalid lifecycle time');
  let state: RunState = 'gating';
  let start = Date.parse(run.createdAt);
  let activeMs = 0;
  const waitMs = { maintainer: 0, contributor: 0, review: 0, paused: 0 };
  for (const entry of [...run.history, { to: run.state, timestamp: new Date(now).toISOString() }]) {
    const stop = Date.parse(entry.timestamp);
    const elapsed = stop - start;
    if (ACTIVE.includes(state)) activeMs += Math.max(0, stop - Math.max(start, activeSince));
    else if (Object.hasOwn(WAIT, state)) waitMs[WAIT[state as keyof typeof WAIT]] += elapsed;
    state = entry.to;
    start = stop;
  }
  if (![activeMs, ...Object.values(waitMs)].every(Number.isSafeInteger))
    throw new Error('Invalid lifecycle time');
  return { activeMs, waitMs };
}

/** An unmatched `begin` row: the publication wait still in progress. */
export interface OpenPublicationWait {
  readonly sessionId: string;
  readonly at: number;
}
/** Validates one durable `publication_wait` row (shape, time, begin/end pairing) against
 * the wait still open before it. The controller's journal replay and the status projection
 * share this so neither accepts a row the other rejects. Throws `invalid_journal`.
 * A gate hand-off opens the same wait while the run is parked for the operator (#1184). */
export function nextPublicationWait(
  open: OpenPublicationWait | undefined,
  event: Record<string, unknown>,
  now = Number.POSITIVE_INFINITY
): { open?: OpenPublicationWait; closed?: { sessionId: string; ms: number } } {
  const at = typeof event.at === 'string' ? Date.parse(event.at) : NaN;
  if (
    event.type !== 'publication_wait' ||
    event.v !== 1 ||
    Object.keys(event).length !== 6 ||
    !Number.isFinite(at) ||
    at > now ||
    typeof event.sessionId !== 'string'
  )
    throw new Error('invalid_journal');
  if (event.operation === 'begin') {
    if (open) throw new Error('invalid_journal');
    return { open: { sessionId: event.sessionId, at } };
  }
  if (event.operation !== 'end' || !open || open.sessionId !== event.sessionId || at < open.at)
    throw new Error('invalid_journal');
  return { closed: { sessionId: open.sessionId, ms: at - open.at } };
}

/** When a still-open wait stops accruing: a run stopped outside `gating`/`shipping`
 * (kill-all, incident stop) never journals the closing row, and its active time froze at
 * the stop, so the open wait must freeze there too. */
export function openWaitUntil(run: RunRecord, now: number): number {
  return run.state === 'gating' || run.state === 'shipping' ? now : Date.parse(run.updatedAt);
}

/** Read-only projection of durable publication waits for selected-session status. */
export function publicationWaitTime(
  events: readonly unknown[],
  sessionId: string,
  now: number,
  runId?: string,
  openUntil = now
): number {
  let open: OpenPublicationWait | undefined;
  let total = 0;
  for (const event of events) {
    if (!isRecord(event) || event.type !== 'publication_wait') continue;
    if (runId !== undefined && event.runId !== runId) throw new Error('invalid_journal');
    const next = nextPublicationWait(open, event, now);
    if (next.closed?.sessionId === sessionId) total += next.closed.ms;
    open = next.open;
  }
  if (open?.sessionId === sessionId) total += Math.max(0, Math.min(now, openUntil) - open.at);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('invalid_journal');
  return total;
}
