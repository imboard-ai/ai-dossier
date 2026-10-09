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
  awaiting_contributor: [R.ContributorHandoff],
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
// fork_missing and installation_missing wait; installation_too_broad blocks (#1065).
const prerequisiteWaits = ['awaiting_contributor', 'awaiting_contributor', 'blocked'];
const expected: Record<RunState, string[]> = {
  gating: [
    ...failTargets,
    'awaiting_maintainer',
    'planning',
    'paused_user',
    'awaiting_contributor',
    ...prerequisiteWaits,
  ],
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
  shipping: [
    ...failTargets,
    'verifying',
    'submitted',
    'paused_user',
    'awaiting_contributor',
    ...prerequisiteWaits,
  ],
  awaiting_contributor: [
    ...failTargets,
    'awaiting_maintainer',
    'submitted',
    ...prerequisiteWaits,
    'gating',
    'shipping',
  ],
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
  it('base_advanced returns only shipping to verification and replays that history', () => {
    for (const state of RUN_STATES) {
      if (state === 'shipping') {
        const next = move(at(state), R.BaseAdvanced);
        expect(next.state).toBe('verifying');
        expect(deserializeRun(serializeRun(next))).toEqual(next);
      } else expect(() => move(at(state), R.BaseAdvanced)).toThrow(IllegalTransitionError);
    }
  });
  it('has exactly the required 19 states and immutable table', () => {
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
        // The publication hand-off is issued from shipping, not from gating.
        if (state === 'awaiting_contributor' && reason === R.PublicationObserved)
          run = move(at('shipping'), R.ContributorHandoff);
        // Prerequisite re-checks and resumes leave a fork/installation wait, not a link wait.
        if (
          state === 'awaiting_contributor' &&
          (to === 'awaiting_contributor' || to === 'gating' || reason === R.InstallationTooBroad)
        )
          run = move(at('gating'), R.ForkMissing);
        if (state === 'awaiting_contributor' && to === 'shipping')
          run = move(at('shipping'), R.InstallationMissing);
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

  it('an observed hand-off must match the phase that issued its link', () => {
    const engagement = move(at('gating'), R.ContributorHandoff);
    expect(move(engagement, R.EngagementObserved).state).toBe('awaiting_maintainer');
    expect(() => move(engagement, R.PublicationObserved)).toThrow(IllegalTransitionError);
    const publication = move(at('shipping'), R.ContributorHandoff);
    expect(move(publication, R.PublicationObserved).state).toBe('submitted');
    expect(() => move(publication, R.EngagementObserved)).toThrow(IllegalTransitionError);
    expect(move(publication, R.PolicyBlocked).state).toBe('blocked');
    // A tampered history cannot launder the origin on replay.
    const forged = {
      ...JSON.parse(serializeRun(engagement)),
      state: 'submitted',
      reasonCode: R.PublicationObserved,
    };
    forged.history.push({
      from: 'awaiting_contributor',
      to: 'submitted',
      reasonCode: R.PublicationObserved,
      timestamp: time,
    });
    expect(() => restoreRun(forged)).toThrow(IllegalTransitionError);
  });

  it('keeps a prerequisite wait and a link hand-off apart (#1065)', () => {
    const waiting = move(at('shipping'), R.ForkMissing);
    expect(waiting.state).toBe('awaiting_contributor');
    expect(waiting.reasonCode).toBe(R.ForkMissing);
    // The re-check finds the next prerequisite missing: same wait, new reason.
    const install = move(waiting, R.InstallationMissing);
    expect(install.state).toBe('awaiting_contributor');
    expect(install.reasonCode).toBe(R.InstallationMissing);
    // A resume returns only to the phase that entered the wait, across self-loops.
    expect(move(install, R.ResumeShipping).state).toBe('shipping');
    expect(() => move(install, R.ResumeGating)).toThrow(IllegalTransitionError);
    // Nothing was submitted: an observation cannot leave a prerequisite wait.
    expect(() => move(install, R.PublicationObserved)).toThrow(IllegalTransitionError);
    expect(() => move(install, R.EngagementObserved)).toThrow(IllegalTransitionError);
    expect(move(install, R.InstallationTooBroad).state).toBe('blocked');
    // Only the fork/installation check blocks as too broad: not a link wait, not other phases.
    expect(() => move(at('accepted'), R.InstallationTooBroad)).toThrow(IllegalTransitionError);
    expect(() => move(at('planning'), R.InstallationTooBroad)).toThrow(IllegalTransitionError);
    // A pending link cannot be skipped by a resume or relabelled as a prerequisite wait.
    const link = move(at('shipping'), R.ContributorHandoff);
    expect(() => move(link, R.ResumeShipping)).toThrow(IllegalTransitionError);
    expect(() => move(link, R.ForkMissing)).toThrow(IllegalTransitionError);
    expect(() => move(link, R.InstallationTooBroad)).toThrow(IllegalTransitionError);
    // After the resume, a later link hand-off is judged by its own entry.
    const resumed = move(install, R.ResumeShipping);
    const later = move(resumed, R.ContributorHandoff);
    expect(move(later, R.PublicationObserved).state).toBe('submitted');
    expect(() => move(later, R.ResumeShipping)).toThrow(IllegalTransitionError);
    expect(deserializeRun(serializeRun(install))).toEqual(install);
    // Replay enforces the same guard: a forged resume to another phase is rejected.
    const forged = {
      ...JSON.parse(serializeRun(install)),
      state: 'gating',
      reasonCode: R.ResumeGating,
    };
    forged.history.push({
      from: 'awaiting_contributor',
      to: 'gating',
      reasonCode: R.ResumeGating,
      timestamp: time,
    });
    expect(() => restoreRun(forged)).toThrow(IllegalTransitionError);
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
