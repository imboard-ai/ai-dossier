import { describe, expect, it } from 'vitest';
import { SecretRedactionError } from './redaction';
import {
  createRun,
  deserializeRun,
  IllegalTransitionError,
  InvalidRunError,
  permittedTransitions,
  ReasonCode as R,
  RUN_STATES,
  type RunRecord,
  type RunState,
  restoreRun,
  serializeRun,
  TERMINAL_STATES,
  TRANSITIONS,
  transitionRun,
} from './state';

const time = '2026-10-05T00:00:00.000Z';
const identity = {
  runId: 'run-1',
  upstreamIssue: 'https://github.com/owner/repo/issues/1',
  contributor: 'alice',
};
const initial = () => createRun(identity, time);
const move = (run: RunRecord, reason: R) => transitionRun(run, reason, time);
const routes: Record<RunState, R[]> = {
  gating: [],
  awaiting_maintainer: [R.PermissionRequired],
  planning: [R.GatePassed],
  implementing: [R.GatePassed, R.PlanApproved],
  verifying: [R.GatePassed, R.PlanApproved, R.CandidateReady],
  paused_user: [R.UserPaused],
  shipping: [R.GatePassed, R.PlanApproved, R.CandidateReady, R.VerificationPassed],
  submitted: [
    R.GatePassed,
    R.PlanApproved,
    R.CandidateReady,
    R.VerificationPassed,
    R.PublicationObserved,
  ],
  awaiting_review: [
    R.GatePassed,
    R.PlanApproved,
    R.CandidateReady,
    R.VerificationPassed,
    R.PublicationObserved,
    R.ReviewAwaited,
  ],
  revising: [
    R.GatePassed,
    R.PlanApproved,
    R.CandidateReady,
    R.VerificationPassed,
    R.PublicationObserved,
    R.RevisionRequested,
  ],
  accepted: [
    R.GatePassed,
    R.PlanApproved,
    R.CandidateReady,
    R.VerificationPassed,
    R.PublicationObserved,
    R.UpstreamAccepted,
  ],
  merged: [
    R.GatePassed,
    R.PlanApproved,
    R.CandidateReady,
    R.VerificationPassed,
    R.PublicationObserved,
    R.ObservedUpstreamMerge,
  ],
  declined: [R.PermissionRequired, R.UpstreamDeclined],
  blocked: [R.PolicyBlocked],
  unsupported: [R.UnsupportedEnvironment],
  failed: [R.ExecutionFailed],
  cancelled: [R.UserCancelled],
  blocked_cleanup: [R.CleanupFailed],
};
const at = (state: RunState) => routes[state].reduce(move, initial());

// Independent product-level adjacency expectation, not copied from exported table.
const failTargets = ['blocked', 'unsupported', 'failed', 'cancelled', 'blocked_cleanup'];
const expected: Record<RunState, string[]> = {
  gating: [...failTargets, 'awaiting_maintainer', 'planning', 'paused_user'],
  awaiting_maintainer: [...failTargets, 'gating', 'declined'],
  planning: [...failTargets, 'implementing', 'paused_user'],
  implementing: [...failTargets, 'verifying', 'paused_user'],
  verifying: [...failTargets, 'shipping', 'implementing', 'paused_user'],
  paused_user: [
    ...failTargets,
    'gating',
    'planning',
    'implementing',
    'verifying',
    'shipping',
    'revising',
  ],
  shipping: [...failTargets, 'submitted', 'paused_user'],
  submitted: [...failTargets, 'merged', 'accepted', 'declined', 'awaiting_review', 'revising'],
  awaiting_review: [...failTargets, 'merged', 'accepted', 'declined', 'revising'],
  revising: [...failTargets, 'verifying', 'paused_user'],
  accepted: [...failTargets, 'merged', 'declined', 'revising'],
  merged: [],
  declined: [],
  blocked: [],
  unsupported: [],
  failed: [],
  cancelled: [],
  blocked_cleanup: ['blocked'],
};

describe('lifecycle contract', () => {
  it('has exactly the required 18 states and immutable table', () => {
    expect(RUN_STATES).toEqual(Object.keys(expected));
    expect(TERMINAL_STATES).toEqual([
      'merged',
      'declined',
      'blocked',
      'unsupported',
      'failed',
      'cancelled',
    ]);
    expect(Object.isFrozen(TRANSITIONS)).toBe(true);
    for (const state of RUN_STATES) {
      expect(Object.values(permittedTransitions(state)).sort()).toEqual(
        [...expected[state]].sort()
      );
      expect(Object.isFrozen(TRANSITIONS[state])).toBe(true);
    }
  });

  for (const state of RUN_STATES) {
    for (const reason of Object.values(R)) {
      it(`${state} + ${reason}: table enforced, reason/time persisted`, () => {
        const to = permittedTransitions(state)[reason];
        let run = at(state);
        if (state === 'paused_user' && to && !failTargets.includes(to))
          run = move(at(to), R.UserPaused);
        const original = serializeRun(run);
        if (to) {
          const next = transitionRun(run, reason, '2026-10-05T00:01:00.000Z');
          expect(next.state).toBe(to);
          expect(next.reasonCode).toBe(reason);
          expect(next.history.at(-1)).toEqual({
            from: state,
            to,
            reasonCode: reason,
            timestamp: '2026-10-05T00:01:00.000Z',
          });
          expect(deserializeRun(serializeRun(next))).toEqual(next);
        } else expect(() => move(run, reason)).toThrow(IllegalTransitionError);
        expect(serializeRun(run)).toBe(original);
      });
    }
  }

  it('completes initial submission and verified revision on the same run', () => {
    let run = at('awaiting_review');
    for (const reason of [
      R.RevisionRequested,
      R.CandidateReady,
      R.RepairRequired,
      R.CandidateReady,
      R.VerificationPassed,
      R.PublicationObserved,
      R.UpstreamAccepted,
      R.ObservedUpstreamMerge,
    ])
      run = move(run, reason);
    expect(run.state).toBe('merged');
    expect(run.runId).toBe(identity.runId);
    expect(
      run.history
        .filter((entry) => entry.to === 'merged')
        .every((entry) => entry.reasonCode === R.ObservedUpstreamMerge)
    ).toBe(true);
  });

  it('does not confuse acceptance/publication with observed merge', () => {
    expect(at('submitted').state).toBe('submitted');
    expect(at('accepted').state).toBe('accepted');
    for (const state of RUN_STATES) {
      for (const [reason, to] of Object.entries(permittedTransitions(state))) {
        if (to === 'merged') expect(reason).toBe(R.ObservedUpstreamMerge);
      }
    }
    expect(() => move(initial(), R.ObservedUpstreamMerge)).toThrow(IllegalTransitionError);
  });

  it('requires distinct explicit creation to replace a terminal run', () => {
    for (const state of TERMINAL_STATES) {
      const previous = at(state);
      expect(() => createRun(identity, time, previous)).toThrow(InvalidRunError);
      const next = createRun({ ...identity, runId: 'new-run' }, time, previous);
      expect(next.state).toBe('gating');
      expect(previous.state).toBe(state);
      expect(next.history).toEqual([]);
    }
  });

  it('cleanup cannot escape indirectly to execution or publication', () => {
    const seen = new Set<RunState>();
    const visit = (state: RunState) => {
      if (seen.has(state)) return;
      seen.add(state);
      for (const to of Object.values(permittedTransitions(state))) if (to) visit(to);
    };
    visit('blocked_cleanup');
    expect([...seen]).toEqual(['blocked_cleanup', 'blocked']);
    const blocked = move(at('blocked_cleanup'), R.CleanupCompleted);
    expect(() => move(deserializeRun(serializeRun(blocked)), R.GatePassed)).toThrow(
      IllegalTransitionError
    );
  });

  it('pause only resumes the interrupted phase, not unverified shipping', () => {
    const paused = move(at('implementing'), R.UserPaused);
    expect(move(paused, R.ResumeImplementing).state).toBe('implementing');
    expect(() => move(paused, R.ResumeShipping)).toThrow(IllegalTransitionError);
    expect(() => move(paused, R.ResumeGating)).toThrow(IllegalTransitionError);
  });

  it('freezes the run and all history entries', () => {
    const run = at('verifying');
    expect(Object.isFrozen(run)).toBe(true);
    expect(Object.isFrozen(run.history)).toBe(true);
    expect(run.history.every(Object.isFrozen)).toBe(true);
  });
});

describe('fail-closed persistence', () => {
  it('roundtrips without executing unknown properties', () => {
    const record = {
      ...at('accepted'),
      extra: 'not persisted',
      toJSON: () => {
        throw new Error('must not run');
      },
    };
    expect(deserializeRun(serializeRun(record))).toEqual(at('accepted'));
  });

  it.each([
    null,
    [],
    {},
    { ...initial(), schemaVersion: 2 },
    { ...initial(), state: 'toString' },
    { ...initial(), reasonCode: 'bad' },
    { ...initial(), history: {} },
    { ...initial(), createdAt: 'bad' },
    { ...initial(), updatedAt: 'bad' },
    { ...initial(), runId: '' },
    { ...initial(), contributor: '' },
    { ...initial(), upstreamIssue: '' },
  ])('rejects malformed record %#', (value) => {
    expect(() => restoreRun(value)).toThrow(InvalidRunError);
  });

  it.each(['not json', 'null', '[]'])('rejects invalid JSON: %s', (json) => {
    expect(() => deserializeRun(json)).toThrow(InvalidRunError);
  });

  it('rejects tampered state, reason, timestamp, history and merge labels', () => {
    const run = at('planning');
    for (const value of [
      { ...run, state: 'merged' },
      { ...run, reasonCode: R.ExecutionFailed },
      { ...run, updatedAt: '2026-10-06T00:00:00.000Z' },
      { ...run, history: [null] },
      { ...run, history: [{ ...run.history[0], from: 'shipping' }] },
      { ...run, history: [{ ...run.history[0], to: 'merged' }] },
      { ...run, history: [{ ...run.history[0], reasonCode: 'invented' }] },
      { ...run, history: [{ ...run.history[0], timestamp: 'bad' }] },
    ])
      expect(() => restoreRun(value)).toThrow(InvalidRunError);
    expect(() =>
      restoreRun({ ...run, history: [{ ...run.history[0], reasonCode: R.ObservedUpstreamMerge }] })
    ).toThrow(IllegalTransitionError);
  });

  it('requires known events, canonical time and monotonic timestamps', () => {
    expect(() => move(initial(), 'not-a-reason' as R)).toThrow(IllegalTransitionError);
    expect(() => permittedTransitions('missing' as RunState)).toThrow(InvalidRunError);
    for (const timestamp of [
      'bad',
      '2026-10-05',
      '2026-10-05T00:00:00Z',
      '2026-10-04T00:00:00.000Z',
    ]) {
      expect(() => transitionRun(initial(), R.GatePassed, timestamp)).toThrow(InvalidRunError);
    }
    expect(() => createRun(identity, 'bad')).toThrow(InvalidRunError);
    expect(() => createRun({ ...identity, runId: ' ' }, time)).toThrow(InvalidRunError);
  });

  it('compares extended ISO years by instant, not lexicographic spelling', () => {
    const future = transitionRun(initial(), R.GatePassed, '+010000-01-01T00:00:00.000Z');
    expect(future.state).toBe('planning');
    expect(() => transitionRun(future, R.PlanApproved, time)).toThrow(InvalidRunError);
    expect(deserializeRun(serializeRun(future))).toEqual(future);
  });

  it('rejects credential-bearing identities rather than persisting raw secrets', () => {
    expect(() => createRun({ ...identity, contributor: 'Bearer secret' }, time)).toThrow(
      SecretRedactionError
    );
  });
});
