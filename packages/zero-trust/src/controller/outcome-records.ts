/** Local replay only. No driver, GitHub read or model adapter is constructed. */
import path from 'node:path';
import { BudgetLedger, budgetTotals } from '../budget';
import { readPrivate } from '../durable-fs';
import { replayHandoffs } from '../github/handoff-driver';
import { replayTrack } from '../github/track';
import { parseJournalEvents } from '../journal';
import { isRecoveryEvent } from '../recovery';
import { assertSecretFree } from '../redaction';
import { isRunContinuation, ReasonCode, type RunRecord } from '../state';
import type { RunStore } from './run-store';

export class OutcomeEvidenceError extends Error {
  constructor(readonly code: 'identity_mismatch' | 'incomplete' | 'recovered') {
    super('Unknown local outcome evidence');
  }
}

/** Do not open Journal here: its constructor creates files and repairs torn tails. */
function events(directory: string): unknown[] {
  const rows = parseJournalEvents(readPrivate(path.join(directory, 'events.jsonl')));
  if (!rows.length) throw new Error('Unknown outcome evidence');
  assertSecretFree(rows);
  // A repaired/truncated journal is not complete statistical evidence either.
  if (rows.some(isRecoveryEvent)) throw new OutcomeEvidenceError('recovered');
  return rows;
}
export function readOutcomeHandoffs(store: RunStore, run: RunRecord) {
  const state = store.withStoreDirectory('handoff', (dir) => replayHandoffs(events(dir)));
  if (state.contributionId !== store.contributionId || !isRunContinuation(state.run, run))
    throw new OutcomeEvidenceError('identity_mismatch');
  return state;
}
export function readOutcomeTrack(store: RunStore, run: RunRecord) {
  const state = store.withStoreDirectory('track', (dir) =>
    replayTrack(events(dir), store.storeDirectory('bodies'))
  );
  if (state.contributionId !== store.contributionId || !isRunContinuation(state.run, run))
    throw new OutcomeEvidenceError('identity_mismatch');
  // A valid prefix may lag external execution, but never omit the tracker's own
  // observations already persisted by the controller (complete-line tail loss).
  const owned = [
    ReasonCode.ReviewAwaited,
    ReasonCode.RevisionRequested,
    ReasonCode.UpstreamAccepted,
    ReasonCode.ObservedUpstreamMerge,
    ReasonCode.UpstreamDeclined,
    ReasonCode.PublicationObserved,
  ];
  if (run.history.slice(state.run.history.length).some((e) => owned.includes(e.reasonCode)))
    throw new OutcomeEvidenceError('incomplete');
  return state;
}
export function readOutcomeBudget(store: RunStore) {
  const state = store.withStoreDirectory('budget', (dir) =>
    new BudgetLedger(path.join(dir, 'ledger.json'), store.contributionId).snapshot()
  );
  for (const session of state.sessions) budgetTotals(state, session.id);
  return state;
}
