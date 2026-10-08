import { type RunRecord, type RunState, restoreRun } from '../state';

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
export function lifecycleTimes(input: RunRecord, now: number) {
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
    if (ACTIVE.includes(state)) activeMs += elapsed;
    else if (Object.hasOwn(WAIT, state)) waitMs[WAIT[state as keyof typeof WAIT]] += elapsed;
    state = entry.to;
    start = stop;
  }
  if (![activeMs, ...Object.values(waitMs)].every(Number.isSafeInteger))
    throw new Error('Invalid lifecycle time');
  return { activeMs, waitMs };
}
