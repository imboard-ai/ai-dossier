/** Local replay only. No driver, GitHub read or model adapter is constructed. */
import path from 'node:path';
import { BudgetLedger, budgetTotals } from '../budget';
import { readPrivate } from '../durable-fs';
import { replayHandoffs } from '../github/handoff-driver';
import { replayTrack } from '../github/track';
import { isRecoveryEvent } from '../recovery';
import { assertSecretFree } from '../redaction';
import { isRunContinuation, type RunRecord } from '../state';
import type { RunStore } from './run-store';

/** Do not open Journal here: its constructor creates files and repairs torn tails. */
function events(directory: string): unknown[] {
  const text = readPrivate(path.join(directory, 'events.jsonl')).toString('utf8');
  if (!text || !text.endsWith('\n')) throw new Error('Unknown outcome evidence');
  const rows: unknown[] = text
    .slice(0, -1)
    .split('\n')
    .map((line) => JSON.parse(line));
  assertSecretFree(rows);
  // A repaired/truncated journal is not complete statistical evidence either.
  if (rows.some(isRecoveryEvent)) throw new Error('Unknown outcome evidence');
  return rows;
}
export function readOutcomeHandoffs(store: RunStore, run: RunRecord) {
  const state = replayHandoffs(events(store.storeDirectory('handoff')));
  if (state.contributionId !== store.contributionId || !isRunContinuation(state.run, run))
    throw new Error('Unknown outcome evidence');
  return state;
}
export function readOutcomeTrack(store: RunStore, run: RunRecord) {
  const state = replayTrack(events(store.storeDirectory('track')), store.storeDirectory('bodies'));
  if (state.contributionId !== store.contributionId || !isRunContinuation(state.run, run))
    throw new Error('Unknown outcome evidence');
  return state;
}
export function readOutcomeBudget(store: RunStore) {
  const state = new BudgetLedger(
    path.join(store.storeDirectory('budget'), 'ledger.json'),
    store.contributionId
  ).snapshot();
  for (const session of state.sessions) budgetTotals(state, session.id);
  return state;
}
