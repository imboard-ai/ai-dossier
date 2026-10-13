import { describe, expect, it } from 'vitest';
import {
  alteredEvidenceNotice,
  clearStopNotice,
  driftHandoffNotice,
  freshnessNotice,
  gateHandoffNotice,
  isAlteredEvidence,
  recordStopNotice,
  reviewHandoffNotice,
  STOP_NOTICE_KEY,
  stopNoticeAction,
  writeBlockedNotice,
} from './stop-notice';
import { VerificationRecordError } from './verification-record';

function store() {
  const values = new Map<string, unknown>();
  const puts: [string, unknown][] = [];
  return {
    values,
    puts,
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: (key: string, value: unknown) => {
      puts.push([key, value]);
      values.set(key, value);
    },
  };
}

const run = (state: string, length: number) =>
  ({ state, history: Array.from({ length }, () => ({})) }) as never;

describe('stop notices', () => {
  it('binds the history length the stop will have', () => {
    const s = store();
    recordStopNotice(s, run('shipping', 4), driftHandoffNotice('rebase_conflict'), true);
    expect(s.values.get(STOP_NOTICE_KEY)).toMatchObject({
      state: 'paused_user',
      historyLength: 5,
      reason: 'rebase_conflict',
    });
    recordStopNotice(
      s,
      run('awaiting_contributor', 4),
      { state: 'awaiting_contributor', reason: 'ambiguous:x', nextPermittedAction: 'Wait.' },
      false
    );
    expect(s.values.get(STOP_NOTICE_KEY)).toMatchObject({ historyLength: 4 });
  });

  it('clears only a present notice', () => {
    const s = store();
    clearStopNotice(s);
    expect(s.puts).toEqual([]);
    recordStopNotice(s, run('shipping', 1), freshnessNotice(['issue_closed']), true);
    clearStopNotice(s);
    expect(s.values.get(STOP_NOTICE_KEY)).toBeNull();
    clearStopNotice(s);
    expect(s.puts).toHaveLength(2);
  });

  it('shows a notice only for exactly the stop it explains', () => {
    const notice = { ...freshnessNotice(['policy_changed']), historyLength: 3 };
    expect(stopNoticeAction(notice, run('blocked', 3))).toContain('policy_changed');
    expect(stopNoticeAction(notice, run('blocked', 4))).toBeUndefined();
    expect(stopNoticeAction(notice, run('paused_user', 3))).toBeUndefined();
    expect(stopNoticeAction(null, run('blocked', 3))).toBeUndefined();
    expect(stopNoticeAction({ ...notice, nextPermittedAction: 7 }, run('blocked', 3))).toBe(
      undefined
    );
  });

  it('claims nothing was overwritten only for refusals proven before any write', () => {
    expect(writeBlockedNotice('remote_diverged').nextPermittedAction).toContain(
      'nothing on it was overwritten'
    );
    expect(writeBlockedNotice('authorization_refused').nextPermittedAction).toContain(
      'nothing was pushed'
    );
    for (const reason of ['unknown', 'unexpected_remote_sha', 'reconciliation_error'] as const)
      expect(writeBlockedNotice(reason).nextPermittedAction).toContain(
        'the fork branch state could not be confirmed'
      );
  });

  it('says a receipt may have been used only when one was issued', () => {
    expect(alteredEvidenceNotice(false).nextPermittedAction).toContain('no receipt was issued');
    expect(alteredEvidenceNotice(true).nextPermittedAction).toContain(
      'the fork branch may hold the candidate'
    );
  });

  it('treats only corrupted or mismatched evidence as altered', () => {
    expect(isAlteredEvidence(new VerificationRecordError('invalid_record'))).toBe(true);
    expect(isAlteredEvidence(new VerificationRecordError('evidence_mismatch'))).toBe(true);
    expect(isAlteredEvidence(new VerificationRecordError('unavailable'))).toBe(false);
    expect(isAlteredEvidence(new Error('invalid_record'))).toBe(false);
  });
  it('records an integrity review hand-off as paused_user with closed codes only (#1205)', () => {
    const notice = reviewHandoffNotice(['test_removed', 'existing_tests_failed', 'test_removed']);
    expect(notice).toMatchObject({
      state: 'paused_user',
      reason: 'test_removed,existing_tests_failed',
    });
    expect(notice.nextPermittedAction).toContain('Nothing was pushed');
    expect(reviewHandoffNotice(['<script>ghp_x']).reason).toBe('invalid_input');
    expect(reviewHandoffNotice([]).reason).toBe('invalid_input');
  });
  it('records a gate hand-off in gating with closed reasons only', () => {
    const notice = gateHandoffNotice(['ai_unclear', 'ownership_unclear', 'ai_unclear']);
    expect(notice).toMatchObject({ state: 'gating', reason: 'ai_unclear,ownership_unclear' });
    expect(notice.nextPermittedAction).toContain('(ai_unclear,ownership_unclear)');
    expect(gateHandoffNotice(['<script>ghp_x']).reason).toBe('unknown_input');
    expect(gateHandoffNotice([]).reason).toBe('unknown_input');
    const store = new Map<string, unknown>();
    const artifacts = {
      get: <T>(key: string) => store.get(key) as T | undefined,
      put: (key: string, value: unknown) => void store.set(key, value),
    };
    recordStopNotice(artifacts, { history: [] }, notice, false);
    expect(stopNoticeAction(store.get(STOP_NOTICE_KEY), { state: 'gating', history: [] })).toBe(
      notice.nextPermittedAction
    );
  });
});
