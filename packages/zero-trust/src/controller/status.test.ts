import { describe, expect, it } from 'vitest';
import type { BudgetState } from '../budget-types';
import type { HandoffRecord } from '../github/handoff-driver';
import { SecretRedactionError } from '../redaction';
import { createRun, ReasonCode, transitionRun } from '../state';
import { InvalidStatusError, renderHuman, renderJson } from '../status';
import { assembleStatus } from './status';

const id = 'ztc-0123456789abcdef';
const initial = () =>
  createRun(
    {
      runId: `${id}-run-1`,
      upstreamIssue: 'https://github.com/owner/repo/issues/1',
      contributor: 'contributor',
    },
    at(0)
  );
function at(seconds: number): string {
  return new Date(Date.UTC(2026, 9, 5, 0, 0, seconds)).toISOString();
}
function budget(): BudgetState {
  return {
    schemaVersion: 1,
    contributionId: id,
    sessions: [
      {
        id: `${id}-run-1-s1`,
        ceiling: { currency: 'USD', minor: 100 },
        cleanupAllowance: 10,
        tokenLimit: 1000,
        timeLimitMs: 100000,
      },
    ],
    reservations: [
      {
        id: 'reservation',
        sessionId: `${id}-run-1-s1`,
        purpose: 'work',
        status: 'reserved',
        estimate: { money: { currency: 'USD', minor: 20 }, tokens: 1, timeMs: 1, rates: [] },
      },
    ],
  };
}
const parts = () => ({
  run: initial(),
  now: at(60),
  budget: budget(),
  sessionId: `${id}-run-1-s1`,
});
describe('assembleStatus', () => {
  it('shows manual grant revocation without erasing terminal tracker or blocked cleanup actions', () => {
    const path = 'Settings → Applications → Authorized GitHub Apps';
    for (const state of ['cancelled', 'merged', 'declined', 'blocked_cleanup'] as const) {
      let run = initial();
      if (state === 'merged' || state === 'declined') {
        for (const reason of [
          ReasonCode.GatePassed,
          ReasonCode.PlanApproved,
          ReasonCode.CandidateReady,
          ReasonCode.VerificationPassed,
          ReasonCode.ContributorHandoff,
          ReasonCode.PublicationObserved,
          state === 'merged' ? ReasonCode.ObservedUpstreamMerge : ReasonCode.UpstreamDeclined,
        ])
          run = transitionRun(run, reason, at(1));
      } else
        run = transitionRun(
          run,
          state === 'cancelled' ? ReasonCode.UserCancelled : ReasonCode.CleanupFailed,
          at(1)
        );
      const action = 'Keep the existing cleanup or prepared PR close instruction.';
      const status = assembleStatus({
        ...parts(),
        run,
        tracker: { state, nextPermittedAction: action },
        authorizationRequired: { nextPermittedAction: 'authorize' },
      });
      expect(status.nextPermittedAction).toContain(action);
      expect(status.nextPermittedAction).toContain(path);
      expect(status.nextPermittedAction).toContain('if it is still listed');
      expect(status.nextPermittedAction).toContain('does not confirm removal');
      expect(renderHuman(status)).toContain(path);
      expect(JSON.parse(renderJson(status)).nextPermittedAction).toBe(status.nextPermittedAction);
    }
    expect(assembleStatus(parts()).nextPermittedAction).not.toContain(path);
    const paused = transitionRun(initial(), ReasonCode.UserPaused, at(1));
    expect(assembleStatus({ ...parts(), run: paused }).nextPermittedAction).not.toContain(path);
  });
  it('reports durable reauthorization while retaining cleanup and terminal precedence', () => {
    const authorizationRequired = { nextPermittedAction: 'authorize' };
    const paused = transitionRun(initial(), ReasonCode.UserPaused, at(1));
    expect(
      assembleStatus({ ...parts(), run: paused, authorizationRequired }).nextPermittedAction
    ).toBe('authorize');
    for (const reason of [
      ReasonCode.CleanupFailed,
      ReasonCode.UserCancelled,
      ReasonCode.PolicyBlocked,
    ]) {
      const run = transitionRun(paused, reason, at(2));
      expect(assembleStatus({ ...parts(), run, authorizationRequired }).nextPermittedAction).toBe(
        assembleStatus({ ...parts(), run }).nextPermittedAction
      );
    }
    for (const authorizationRequired of [
      true,
      [],
      {},
      { nextPermittedAction: 'resume' },
      { nextPermittedAction: 'authorize', extra: true },
    ])
      expect(() => assembleStatus({ ...parts(), authorizationRequired })).toThrow(
        InvalidStatusError
      );
  });
  it('preserves the typed status error on active-time overflow', () => {
    const run = createRun(
      {
        runId: `${id}-run-1`,
        upstreamIssue: parts().run.upstreamIssue,
        contributor: 'contributor',
      },
      new Date(-8_000_000_000_000_000).toISOString()
    );
    expect(() =>
      assembleStatus({ ...parts(), run, now: new Date(8_000_000_000_000_000).toISOString() })
    ).toThrow(InvalidStatusError);
  });
  it('produces every status fact from history and conservative budget totals', () => {
    let run = initial();
    const events: [ReasonCode, number][] = [
      [ReasonCode.PermissionRequired, 10],
      [ReasonCode.MaintainerInvited, 20],
      [ReasonCode.GatePassed, 30],
      [ReasonCode.UserPaused, 40],
      [ReasonCode.ResumePlanning, 50],
      [ReasonCode.PlanApproved, 60],
      [ReasonCode.CandidateReady, 70],
      [ReasonCode.VerificationPassed, 80],
      [ReasonCode.ContributorHandoff, 90],
      [ReasonCode.PublicationObserved, 100],
      [ReasonCode.ReviewAwaited, 110],
      [ReasonCode.RevisionRequested, 120],
      [ReasonCode.UserCancelled, 130],
    ];
    for (const [reason, second] of events) run = transitionRun(run, reason, at(second));
    const b = budget();
    b.reservations.push({
      ...b.reservations[0],
      id: 'settled',
      status: 'settled',
      observed: { money: { currency: 'USD', minor: 25 }, tokens: 2, timeMs: 2, source: 'fake' },
    } as BudgetState['reservations'][number]);
    const status = assembleStatus({
      ...parts(),
      run,
      now: at(200),
      phase: 'execution',
      candidateSha: 'a'.repeat(40),
      budget: b,
    });
    expect(status).toEqual({
      runId: run.runId,
      phase: 'execution',
      state: 'cancelled',
      upstreamIssue: run.upstreamIssue,
      contributor: run.contributor,
      candidateSha: 'a'.repeat(40),
      activeTimeMs: 80000,
      estimatedSpend: { amount: 45, currency: 'USD' },
      budgetRemaining: { amount: 55, currency: 'USD' },
      reasonCode: ReasonCode.UserCancelled,
      nextPermittedAction:
        'No further execution; the run was cancelled. Run-token cleanup does not confirm removal of the GitHub App authorization. To revoke it fully, open GitHub Settings → Applications → Authorized GitHub Apps and revoke this run’s App if it is still listed. Confirm the App no longer appears there.',
    });
    expect(JSON.parse(renderJson(status))).toEqual(status);
    for (const key of Object.keys(status)) expect(renderHuman(status)).toContain(`${key}:`);
  });
  it('counts the current active interval and omits absent candidate', () => {
    const status = assembleStatus(parts());
    expect(status.activeTimeMs).toBe(60000);
    expect(status).not.toHaveProperty('candidateSha');
    expect(assembleStatus({ ...parts(), now: new Date(at(60)) })).toEqual(status);
  });
  it('prioritizes pending handoff, tracker, prerequisite and state defaults', () => {
    const run = transitionRun(initial(), ReasonCode.ContributorHandoff, at(1));
    const record = {
      status: 'link_issued',
      input: { operationKind: 'engagement_comment' },
      binding: { upstream: { owner: 'owner', repo: 'repo' }, issue: 1 },
      linkKind: 'body_file',
      link: 'https://github.com/owner/repo/issues/1',
      bodyFile: 'body.txt',
    } as HandoffRecord;
    const p = {
      ...parts(),
      run,
      handoff: { run, contributionId: id, handoffs: new Map([['key', record]]) },
      tracker: { state: run.state, nextPermittedAction: 'tracker-action' },
    };
    expect(assembleStatus(p).nextPermittedAction).toContain('review the prepared request');
    expect(renderHuman(assembleStatus(p))).toContain(record.link);
    expect(renderJson(assembleStatus(p))).toContain(record.link);
    expect(assembleStatus({ ...p, handoff: undefined }).nextPermittedAction).toBe('tracker-action');
    const waiting = transitionRun(initial(), ReasonCode.ForkMissing, at(1));
    const prerequisite = {
      upstream: { owner: 'owner', repo: 'repo', repositoryId: 123, defaultBranch: 'main' },
      appSlug: 'test-app',
    };
    expect(
      assembleStatus({ ...parts(), run: waiting, prerequisite }).nextPermittedAction
    ).toContain('fork');
    expect(assembleStatus({ ...parts(), run: waiting }).nextPermittedAction).toContain(
      'contributor hand-off'
    );
  });

  it('refuses a stale handoff even when the current run returns to the same state', () => {
    const old = transitionRun(initial(), ReasonCode.ContributorHandoff, at(1));
    let current = transitionRun(old, ReasonCode.EngagementObserved, at(2));
    current = transitionRun(current, ReasonCode.MaintainerInvited, at(3));
    current = transitionRun(current, ReasonCode.ForkMissing, at(4));
    const handoff = { run: old, contributionId: id, handoffs: new Map<string, HandoffRecord>() };
    expect(() => assembleStatus({ ...parts(), run: current, handoff })).toThrow();
    expect(() =>
      assembleStatus({ ...parts(), run: current, handoff: { ...handoff, run: current } })
    ).not.toThrow();
    expect(() =>
      assembleStatus({
        ...parts(),
        run: current,
        handoff: { ...handoff, run: current, contributionId: 'other' },
      })
    ).toThrow();
  });
  it('rejects planted free-text tokens specifically, with benign renderer controls', () => {
    expect(() => assembleStatus({ ...parts(), phase: 'plain-phase' })).not.toThrow();
    expect(() => assembleStatus({ ...parts(), phase: 'ghp_secret' })).toThrow(SecretRedactionError);
    expect(() =>
      assembleStatus({
        ...parts(),
        tracker: { state: 'gating', nextPermittedAction: 'ghp_secret' },
      })
    ).toThrow(SecretRedactionError);
  });
  it('fails closed on bad clocks, budget identity, mismatched state and planted secrets', () => {
    expect(() => assembleStatus({ ...parts(), now: 'invalid' })).toThrow();
    expect(() => assembleStatus({ ...parts(), now: at(-1) })).toThrow();
    expect(() => assembleStatus({ ...parts(), sessionId: 'missing' })).toThrow();
    expect(() =>
      assembleStatus({ ...parts(), budget: { ...budget(), contributionId: 'other' } })
    ).toThrow();
    expect(() =>
      assembleStatus({ ...parts(), tracker: { state: 'merged', nextPermittedAction: 'wait' } })
    ).toThrow();
    expect(() =>
      assembleStatus({
        ...parts(),
        tracker: { state: 'gating', nextPermittedAction: 'ghp_secret' },
      })
    ).toThrow();
    expect(() => assembleStatus({ ...parts(), candidateSha: 'ghp_secret' })).toThrow();
    expect(() =>
      assembleStatus({
        ...parts(),
        handoff: { run: { ...initial(), runId: 'other' }, contributionId: id, handoffs: new Map() },
      })
    ).toThrow();
  });
  it('reports overspend without negative remaining money', () => {
    const b = budget();
    b.reservations[0].estimate.money.minor = 120;
    expect(assembleStatus({ ...parts(), budget: b }).budgetRemaining.amount).toBe(0);
  });
});
