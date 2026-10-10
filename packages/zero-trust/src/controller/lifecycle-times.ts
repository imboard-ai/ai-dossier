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
/** Shared status/metrics policy: each elapsed interval belongs to its preceding state. */
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

/** Read-only projection of durable publication waits for selected-session status. */
export function publicationWaitTime(
  events: readonly unknown[],
  sessionId: string,
  now: number
): number {
  let open: { sessionId: string; at: number } | undefined;
  let total = 0;
  for (const event of events) {
    if (!isRecord(event) || event.type !== 'publication_wait') continue;
    const at = typeof event.at === 'string' ? Date.parse(event.at) : NaN;
    if (
      event.v !== 1 ||
      Object.keys(event).length !== 6 ||
      !Number.isFinite(at) ||
      at > now ||
      typeof event.sessionId !== 'string'
    )
      throw new Error('invalid_journal');
    if (event.operation === 'begin') {
      if (open) throw new Error('invalid_journal');
      open = { sessionId: event.sessionId, at };
    } else if (event.operation === 'end') {
      if (!open || open.sessionId !== event.sessionId || at < open.at)
        throw new Error('invalid_journal');
      if (open.sessionId === sessionId) total += at - open.at;
      open = undefined;
    } else throw new Error('invalid_journal');
  }
  if (open?.sessionId === sessionId) total += now - open.at;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('invalid_journal');
  return total;
}
