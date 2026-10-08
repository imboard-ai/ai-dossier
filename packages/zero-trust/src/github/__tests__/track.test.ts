/** #1068: upstream PR tracking and revisions. GitHub is a mocked, GET-only HTTP fake; the
 * revision round trip pushes to a local bare repository through the #1066 CAS rig. No
 * network, no real credentials. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { IntentDriver, IntentError, type IntentInput } from '../../intents';
import type { Journal } from '../../journal';
import { freshnessRig } from '../../policy/__tests__/freshness-rig';
import { createRun, ReasonCode, type RunRecord, transitionRun } from '../../state';
import { forkTarget } from '../fork-ref';
import { HandoffError, handoffMarker, type PrBinding } from '../handoff';
import type { HandoffRecord } from '../handoff-driver';
import type { GitHubRead } from '../reconcile';
import {
  observeCi,
  observePr,
  PrTracker,
  type RevisionAdmission,
  relocatePr,
  replayTrack,
  type TrackDeps,
  TrackError,
  type TrackOutcome,
  trackFromHandoff,
  upstreamOutcome,
} from '../track';
import { FORK_ID, OWNER } from './github-fake';
import { BRANCH, C1, C2, FORK, journal, Rig, SHA1, SHA2, temp } from './push-rig';

const UP = Object.freeze({ owner: 'up', repo: 'proj' });
const BINDING: PrBinding = Object.freeze({
  upstream: UP,
  base: 'main',
  headOwner: OWNER,
  branch: BRANCH,
});
const PR_URL = 'https://github.com/up/proj/pull/5';
const OTHER = 'e'.repeat(40);
const prIntent: IntentInput = {
  contributionId: 'contribution-1',
  target: 'up/proj#8',
  operationKind: 'pr_create',
  candidateSha: SHA1,
};
const MARKER = handoffMarker(prIntent);
/** The #1067 hand-off record of the observed PR: the tracker's starting point. */
const OBSERVED = {
  key: 'k',
  intentId: 'i',
  input: prIntent,
  binding: BINDING,
  link: 'https://github.com/up/proj/compare',
  linkKind: 'prefilled',
  bodyFile: '/controller/bodies/i.md',
  bodyDigest: 'd',
  status: 'observed',
  issuedAt: '2026-10-06T09:00:00.000Z',
  artifactRef: PR_URL,
  number: 5,
  headSha: SHA1,
  prState: 'open',
} as unknown as HandoffRecord;
const { pr: TRACKED } = trackFromHandoff(OBSERVED, FORK);

let clock = Date.parse('2026-10-06T10:00:00.000Z');
const now = () => {
  clock += 1000;
  return new Date(clock).toISOString();
};
const created = createRun(
  { runId: 'run-1', upstreamIssue: 'https://github.com/up/proj/issues/8', contributor: OWNER },
  now()
);
const step = (run: RunRecord, ...reasons: ReasonCode[]) =>
  reasons.reduce((r, reason) => transitionRun(r, reason, now()), run);
const shipping = step(
  created,
  ReasonCode.GatePassed,
  ReasonCode.PlanApproved,
  ReasonCode.CandidateReady,
  ReasonCode.VerificationPassed
);
const submitted = step(shipping, ReasonCode.PublicationObserved);

interface Pull {
  number: number;
  state: 'open' | 'closed';
  merged?: boolean;
  title?: string;
  body?: string | null;
  author?: string;
  /** Unset: GitHub reports the fork branch's current SHA. */
  headSha?: string;
  headRepoId?: number | null;
  deleted?: boolean;
}

/** Mocked GitHub: GET only, answering from mutable state. Records every request. */
class Upstream {
  readonly calls: string[] = [];
  pulls: Pull[] = [{ number: 5, state: 'open', title: 'Fix range()', body: `Body\n${MARKER}` }];
  checkRuns: Record<string, unknown>[] = [];
  workflowRuns: Record<string, unknown>[] = [];
  status: { state: string; total_count: number } = { state: 'pending', total_count: 0 };
  reviews: unknown[] = [];
  reviewComments: unknown[] = [];
  comments: unknown[] = [];
  /** Path fragments answered with a 500. */
  readonly failing = new Set<string>();
  branch: string | null = SHA1;
  forkId = FORK_ID;
  /** Fork reads go to the bare repository when a rig is attached. */
  constructor(private readonly fork?: Rig) {}

  pr(number = 5): Pull {
    return this.pulls.find((p) => p.number === number) as Pull;
  }
  private branchSha(): string | null {
    return this.fork ? this.fork.fork.sha() : this.branch;
  }
  private json(p: Pull) {
    return {
      number: p.number,
      html_url: `https://github.com/up/proj/pull/${p.number}`,
      state: p.state,
      merged: p.merged ?? false,
      merged_at: p.merged ? '2026-10-06T12:00:00Z' : null,
      title: p.title ?? 'Fix range()',
      body: p.body === undefined ? `Body\n${MARKER}` : p.body,
      user: { login: p.author ?? OWNER },
      head: {
        label: `${OWNER}:${BRANCH}`,
        ref: BRANCH,
        sha: p.headSha ?? this.branchSha() ?? SHA1,
        repo: p.headRepoId === null ? null : { id: p.headRepoId ?? FORK_ID },
      },
      base: { ref: 'main' },
    };
  }
  readonly read: GitHubRead = async (p) => {
    this.calls.push(p);
    for (const fragment of this.failing)
      if (p.includes(fragment)) return { status: 500, body: { message: 'synthetic' } };
    const query = p.indexOf('?');
    const route = query < 0 ? p : p.slice(0, query);
    const page = Number(/[?&]page=(\d+)/u.exec(p)?.[1] ?? '1');
    const paged = (items: unknown[]) => ({
      status: 200,
      body: items.slice((page - 1) * 100, page * 100),
    });
    const keyed = (key: string, sha: string, items: Record<string, unknown>[]) => ({
      status: 200,
      body: {
        total_count: items.length,
        [key]: items.slice((page - 1) * 100, page * 100).map((i) => ({ head_sha: sha, ...i })),
      },
    });
    if (route.startsWith(`/repos/${OWNER}/fixture`)) {
      if (this.fork) return this.fork.fork.read(p);
      if (route === `/repos/${OWNER}/fixture`) return { status: 200, body: { id: this.forkId } };
      const sha = this.branch;
      return sha
        ? { status: 200, body: { ref: `refs/heads/${BRANCH}`, object: { type: 'commit', sha } } }
        : { status: 404, body: { message: 'Not Found' } };
    }
    if (route === '/repos/up/proj/pulls')
      return paged(this.pulls.filter((x) => !x.deleted).map((x) => this.json(x)));
    let m = /^\/repos\/up\/proj\/pulls\/(\d+)$/u.exec(route);
    if (m) {
      const pull = this.pulls.find((x) => x.number === Number(m?.[1]) && !x.deleted);
      return pull ? { status: 200, body: this.json(pull) } : { status: 404, body: null };
    }
    if (/\/pulls\/\d+\/reviews$/u.test(route)) return paged(this.reviews);
    if (/\/pulls\/\d+\/comments$/u.test(route)) return paged(this.reviewComments);
    if (/\/issues\/\d+\/comments$/u.test(route)) return paged(this.comments);
    m = /^\/repos\/up\/proj\/commits\/([a-f0-9]{40})\/(check-runs|status)$/u.exec(route);
    if (m?.[2] === 'check-runs') return keyed('check_runs', m[1] as string, this.checkRuns);
    if (m?.[2] === 'status') return { status: 200, body: this.status };
    const headSha = /[?&]head_sha=([a-f0-9]{40})/u.exec(p)?.[1] as string;
    if (route === '/repos/up/proj/actions/runs')
      return keyed('workflow_runs', headSha, this.workflowRuns);
    return { status: 404, body: null };
  };
}

function maintainer(login = 'maintainer', association = 'MEMBER') {
  return { user: { login, type: 'User' }, author_association: association };
}
function review(id: number, updated = '2026-10-06T11:00:00Z', who = maintainer()) {
  return {
    id,
    ...who,
    body: 'Please also cover the empty range.',
    state: 'CHANGES_REQUESTED',
    submitted_at: updated,
    commit_id: SHA1,
    html_url: `${PR_URL}#pullrequestreview-${id}`,
  };
}
function remark(id: number, updated = '2026-10-06T11:00:00Z', who = maintainer()) {
  return {
    id,
    ...who,
    body: 'Rename this variable.',
    updated_at: updated,
    commit_id: SHA1,
    html_url: `${PR_URL}#discussion_r${id}`,
  };
}

const admitAll = (): RevisionAdmission & { calls: string[] } => {
  const calls: string[] = [];
  const probe = (name: string) => async () => {
    calls.push(name);
    return true;
  };
  return {
    calls,
    policyFresh: probe('policy'),
    contributorVerified: probe('contributor'),
    forkBindingVerified: probe('fork'),
  };
};

/** `push-rig`'s hooks close these journals and remove the directories after each test. */
const trackJournal = (dir = temp('zt-track-')): Journal => journal(dir);
function tracker(
  up: Upstream,
  options: { admission?: RevisionAdmission; run?: RunRecord; j?: Journal; bodies?: string } = {}
) {
  const deps: TrackDeps = {
    read: up.read,
    admission: options.admission ?? admitAll(),
    bodyDirectory: options.bodies ?? temp('zt-track-bodies-'),
    now,
  };
  const j = options.j ?? trackJournal();
  const t = new PrTracker(j, deps, {
    run: options.run ?? submitted,
    contributionId: 'contribution-1',
    ...trackFromHandoff(OBSERVED, FORK),
  });
  return { t, j, deps };
}
const kind = (o: TrackOutcome) => o.kind;

describe('PR observation and state mapping (AC1)', () => {
  it.each([
    ['open', {}, 'awaiting_review'],
    ['merged', { state: 'closed', merged: true }, 'merged'],
    [
      'merged after the fork was deleted',
      { state: 'closed', merged: true, headRepoId: null },
      'merged',
    ],
    ['closed and not merged', { state: 'closed' }, 'declined'],
    ['a deleted PR', { deleted: true }, 'blocked'],
    ['a deleted fork', { headRepoId: null }, 'blocked'],
    ['a replaced fork', { headRepoId: 999 }, 'blocked'],
  ] as const)('%s → %s', async (_name, patch, expected) => {
    const up = new Upstream();
    Object.assign(up.pr(), patch);
    expect(upstreamOutcome(await observePr(up.read, TRACKED))).toBe(expected);
  });

  it('a deleted head branch, a deleted fork repository, or an unreadable PR', async () => {
    const up = new Upstream();
    up.branch = null;
    expect(await observePr(up.read, TRACKED)).toEqual({ kind: 'gone', reason: 'branch_deleted' });
    up.branch = SHA1;
    up.forkId = 31337;
    expect(await observePr(up.read, TRACKED)).toEqual({ kind: 'gone', reason: 'fork_replaced' });
    up.forkId = FORK_ID;
    up.failing.add('/pulls/5');
    expect(await observePr(up.read, TRACKED)).toEqual({ kind: 'unknown', detail: 'pull:500' });
  });

  it('only an observed merge is merged: a closed PR with a merge-like title is declined', async () => {
    const up = new Upstream();
    Object.assign(up.pr(), { state: 'closed', title: 'Merged! all tests passed' });
    const track = await observePr(up.read, TRACKED);
    expect(track).toMatchObject({ kind: 'observed', merged: false, state: 'closed' });
    expect(upstreamOutcome(track)).toBe('declined');
  });

  it('starts only from an observed pr_create hand-off', () => {
    expect(TRACKED).toMatchObject({ number: 5, url: PR_URL, marker: MARKER, fork: FORK });
    for (const patch of [
      { status: 'link_issued' },
      { input: { ...prIntent, operationKind: 'engagement_comment', candidateSha: null } },
      { headSha: 'short' },
    ])
      expect(() =>
        trackFromHandoff({ ...OBSERVED, ...patch } as unknown as HandoffRecord, FORK)
      ).toThrow(HandoffError);
  });

  it('reads only on explicit resume, and every read is a GET of a repository path', async () => {
    const up = new Upstream();
    const { t } = tracker(up);
    t.status();
    expect(up.calls).toEqual([]);
    expect(t.status()).toMatchObject({ state: 'submitted', ci: 'not_observed', feedback: null });
    expect(kind(await t.resume())).toBe('tracking');
    expect(up.calls.length).toBeGreaterThan(0);
    expect(up.calls.every((p) => p.startsWith('/repos/'))).toBe(true);
  });

  it('resume maps open → awaiting_review, then merged; terminal runs read nothing more', async () => {
    const up = new Upstream();
    const { t } = tracker(up);
    expect(await t.resume()).toMatchObject({
      kind: 'tracking',
      status: { state: 'awaiting_review', headSha: SHA1 },
    });
    Object.assign(up.pr(), { state: 'closed', merged: true });
    expect(await t.resume()).toMatchObject({ kind: 'merged', status: { state: 'merged' } });
    expect(t.snapshot().outcomeSha).toBe(SHA1);
    const reads = up.calls.length;
    expect(kind(await t.resume())).toBe('merged');
    expect(up.calls.length).toBe(reads);
  });

  it('a merge at a head the run never verified is recorded and said so', async () => {
    const up = new Upstream();
    Object.assign(up.pr(), { state: 'closed', merged: true, headSha: OTHER });
    const { t } = tracker(up);
    expect(await t.resume()).toMatchObject({ kind: 'merged' });
    expect(t.snapshot().outcomeSha).toBe(OTHER);
    expect(t.status().nextPermittedAction).toMatch(/not the verified/u);
  });

  it('closed without merge → declined; a deleted PR, fork or branch blocks', async () => {
    const closed = new Upstream();
    Object.assign(closed.pr(), { state: 'closed' });
    expect(await tracker(closed).t.resume()).toMatchObject({
      kind: 'declined',
      status: { state: 'declined' },
    });
    for (const [patch, reason] of [
      [{ deleted: true }, 'pr_deleted'],
      [{ headRepoId: null }, 'fork_deleted'],
    ] as const) {
      const up = new Upstream();
      Object.assign(up.pr(), patch);
      expect(await tracker(up).t.resume()).toMatchObject({
        kind: 'blocked',
        reason,
        status: { state: 'blocked' },
      });
    }
    const branchless = new Upstream();
    branchless.branch = null;
    expect(await tracker(branchless).t.resume()).toMatchObject({ reason: 'branch_deleted' });
  });

  it('a head SHA moved out of band blocks (scenario 13), and its CI is not reported', async () => {
    const up = new Upstream();
    up.pr().headSha = OTHER;
    up.checkRuns = [{ status: 'completed', conclusion: 'success' }];
    const { t } = tracker(up);
    expect(await t.resume()).toMatchObject({
      kind: 'blocked',
      reason: 'unexpected_head_sha',
      status: { ci: 'not_observed' },
    });
    const moved = new Upstream();
    moved.branch = OTHER;
    expect(await tracker(moved).t.resume()).toMatchObject({ reason: 'unexpected_head_sha' });
  });

  it('an unreadable GitHub records nothing and claims nothing', async () => {
    const up = new Upstream();
    up.failing.add('/pulls/5');
    const { t, j } = tracker(up);
    const before = j.read().length;
    expect(await t.resume()).toMatchObject({
      kind: 'unknown',
      detail: 'pull:500',
      status: { state: 'submitted' },
    });
    expect(j.read().length).toBe(before);
  });
});

describe('upstream CI as observed (AC7, scenario 12)', () => {
  const ci = async (patch: Partial<Upstream>) => {
    const up = new Upstream();
    Object.assign(up, patch);
    return observeCi(up.read, BINDING, SHA1);
  };
  const done = (conclusion: string) => ({ status: 'completed', conclusion });

  it('reports none, pending, awaiting approval, failed and passed from what GitHub shows', async () => {
    expect(await ci({})).toBe('none');
    expect(await ci({ status: { state: 'pending', total_count: 0 } })).toBe('none');
    expect(await ci({ checkRuns: [{ status: 'in_progress', conclusion: null }] })).toBe('pending');
    expect(await ci({ status: { state: 'pending', total_count: 2 } })).toBe('pending');
    expect(await ci({ workflowRuns: [done('action_required')] })).toBe('awaiting_approval');
    expect(await ci({ workflowRuns: [{ status: 'waiting', conclusion: null }] })).toBe(
      'awaiting_approval'
    );
    expect(await ci({ checkRuns: [done('success'), done('failure')] })).toBe('failed');
    expect(await ci({ status: { state: 'error', total_count: 1 } })).toBe('failed');
    expect(
      await ci({
        checkRuns: [done('success'), done('skipped')],
        workflowRuns: [done('success')],
        status: { state: 'success', total_count: 1 },
      })
    ).toBe('passed');
  });

  it('never infers green: skipped-only, another commit, unreadable or unknown is not passed', async () => {
    expect(await ci({ checkRuns: [done('skipped'), done('neutral')] })).toBe('none');
    expect(await ci({ checkRuns: [{ ...done('success'), head_sha: OTHER }] })).toBe('unknown');
    const up = new Upstream();
    up.checkRuns = [done('success')];
    up.failing.add('/actions/runs');
    expect(await observeCi(up.read, BINDING, SHA1)).toBe('unknown');
    expect(await ci({ checkRuns: [done('mystery')] })).toBe('unknown');
    // A listing claiming more items than it returns is truncated, not complete.
    const truncated = new Upstream();
    const read: GitHubRead = async (p) =>
      p.includes('/check-runs')
        ? {
            status: 200,
            body: {
              total_count: 5000,
              check_runs: Array(100).fill({ ...done('success'), head_sha: SHA1 }),
            },
          }
        : truncated.read(p);
    expect(await observeCi(read, BINDING, SHA1)).toBe('unknown');
  });

  it('status says what the contributor does next and never calls pending or unread checks green', async () => {
    for (const [patch, state, text] of [
      [{}, 'none', /No upstream check has run/u],
      [{ checkRuns: [{ status: 'queued', conclusion: null }] }, 'pending', /still running/u],
      [
        { workflowRuns: [{ status: 'action_required', conclusion: null }] },
        'awaiting_approval',
        /waiting for a maintainer to approve/u,
      ],
      [{ status: { state: 'failure', total_count: 1 } }, 'failed', /checks failed/u],
    ] as const) {
      const up = new Upstream();
      Object.assign(up, patch);
      const { t } = tracker(up);
      const { status } = await t.resume();
      expect(status).toMatchObject({ state: 'awaiting_review', ci: state, ciSha: SHA1 });
      expect(status.nextPermittedAction).toMatch(text);
      expect(status.nextPermittedAction).not.toMatch(/checks passed/u);
    }
  });
});

describe('re-detecting a replacement PR (AC6, scenario 11)', () => {
  const closedWith = (...others: Partial<Pull>[]) => {
    const up = new Upstream();
    up.pr().state = 'closed';
    for (const [index, other] of others.entries())
      up.pulls.push({ number: 6 + index, state: 'open', ...other });
    return up;
  };

  it('lists head+base+state=all and follows exactly one other marked PR', async () => {
    const up = closedWith({});
    expect(await relocatePr(up.read, TRACKED, OWNER)).toEqual({
      kind: 'found',
      number: 6,
      url: 'https://github.com/up/proj/pull/6',
    });
    const listing = up.calls.find((p) => p.startsWith('/repos/up/proj/pulls?')) as string;
    expect(listing).toContain('state=all');
    expect(listing).toContain(`head=${encodeURIComponent(`${OWNER}:${BRANCH}`)}`);
    expect(listing).toContain('base=main');
    const { t } = tracker(up);
    expect(await t.resume()).toMatchObject({
      kind: 'tracking',
      status: { state: 'awaiting_review', pr: 'https://github.com/up/proj/pull/6' },
    });
    expect(t.snapshot().pr.number).toBe(6);
  });

  it('more than one marked match hands off and records nothing', async () => {
    const up = closedWith({}, {});
    expect(await relocatePr(up.read, TRACKED, OWNER)).toEqual({
      kind: 'ambiguous',
      reason: 'multiple_matches',
    });
    const { t, j } = tracker(up);
    const before = j.read().length;
    expect(await t.resume()).toMatchObject({ kind: 'handoff', reason: 'multiple_matches' });
    expect(j.read().length).toBe(before);
    expect(t.snapshot().run.state).toBe('submitted');
  });

  it('ignores unmarked PRs, hands off on a foreign author, and declines when none exists', async () => {
    expect(await relocatePr(closedWith({ body: 'unrelated' }).read, TRACKED, OWNER)).toEqual({
      kind: 'none',
    });
    expect(await relocatePr(closedWith({ author: 'mallory' }).read, TRACKED, OWNER)).toEqual({
      kind: 'ambiguous',
      reason: 'foreign_author',
    });
    expect(kind(await tracker(closedWith({ body: 'unrelated' })).t.resume())).toBe('declined');
  });

  it('a replacement whose head is not the verified SHA blocks', async () => {
    const up = closedWith({ headSha: OTHER });
    expect(await tracker(up).t.resume()).toMatchObject({
      kind: 'blocked',
      reason: 'unexpected_head_sha',
    });
  });
});

describe('withdrawal (AC4)', () => {
  it('issues the PR link and a prepared comment; declined only after the close is observed', async () => {
    const up = new Upstream();
    const { t, j } = tracker(up);
    await t.resume();
    const issued = await t.requestWithdrawal({
      reason: 'maintainer_request',
      explanation: 'The maintainers asked to withdraw this in favour of their own fix.',
    });
    if (issued.kind !== 'action') throw new Error('expected an action');
    expect(issued.action).toMatchObject({ kind: 'withdraw', link: PR_URL, author: OWNER });
    const body = fs.readFileSync(issued.action.bodyFile as string, 'utf8');
    expect(body).toContain('in favour of their own fix');
    expect(body).toMatch(
      /<!-- ai-dossier:ztfc contribution=contribution-1 intent=[a-f0-9]{32} op=pr_close -->/u
    );
    // Not closed yet: still awaiting review, no claim.
    expect(await t.resume()).toMatchObject({
      kind: 'tracking',
      status: { state: 'awaiting_review', action: { kind: 'withdraw' } },
    });
    up.pr().state = 'closed';
    expect(await t.resume()).toMatchObject({ kind: 'declined', status: { state: 'declined' } });
    expect(t.status().action).toBeUndefined();
    expect(replayTrack(j.read())).toEqual(t.snapshot());
  });

  it('after declined: nothing is read, journaled, pushed, deleted or scheduled', async () => {
    const r = await new Rig().start(shipping);
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    await r.driver.execute({
      contributionId: 'contribution-1',
      target: forkTarget(FORK, BRANCH),
      operationKind: 'push_branch',
      candidateSha: SHA1,
    });
    const up = new Upstream(r);
    const timers = [vi.spyOn(globalThis, 'setTimeout'), vi.spyOn(globalThis, 'setInterval')];
    const { t, j } = tracker(up);
    await t.resume();
    const issued = await t.requestWithdrawal({ reason: 'user_instruction', explanation: 'Stop.' });
    up.pr().state = 'closed';
    expect(kind(await t.resume())).toBe('declined');
    // Every request the tracker ever made is a repository GET: its only port is `read`.
    expect(up.calls.every((p) => p.startsWith('/repos/'))).toBe(true);
    const reads = up.calls.length;
    const events = j.read().length;
    expect(kind(await t.resume())).toBe('declined');
    expect(kind(await t.beginRevision())).toBe('declined');
    expect(
      kind(await t.requestWithdrawal({ reason: 'user_instruction', explanation: 'Again.' }))
    ).toBe('declined');
    expect(up.calls.length).toBe(reads);
    expect(j.read().length).toBe(events);
    // Nothing upstream or on the fork was touched: the PR still exists and the branch is put.
    expect(up.pr()).toMatchObject({ state: 'closed' });
    expect(up.pr().deleted).toBeUndefined();
    expect(r.fork.sha()).toBe(SHA1);
    expect(issued.kind === 'action' && fs.existsSync(issued.action.bodyFile as string)).toBe(true);
    // No follow-up is ever scheduled.
    for (const timer of timers) expect(timer).not.toHaveBeenCalled();
  });

  it('a pending withdrawal does not chase a replacement PR, and a merge overtakes it', async () => {
    const up = new Upstream();
    up.pulls.push({ number: 6, state: 'open' });
    const { t } = tracker(up);
    await t.requestWithdrawal({ reason: 'user_instruction', explanation: 'No longer needed.' });
    Object.assign(up.pr(), { state: 'closed', merged: true });
    expect(kind(await t.resume())).toBe('merged');
    expect(up.calls.some((p) => p.startsWith('/repos/up/proj/pulls?'))).toBe(false);
  });

  it('can be cancelled before the close, and is refused while revising', async () => {
    const up = new Upstream();
    up.reviews = [review(1)];
    const { t } = tracker(up);
    await t.requestWithdrawal({ reason: 'user_instruction', explanation: 'Stop.' });
    await expect(t.beginRevision()).rejects.toThrow(/action_pending/u);
    expect(await t.cancelAction()).toMatchObject({ kind: 'tracking' });
    await expect(t.cancelAction()).rejects.toThrow(/no_action/u);
    expect(kind(await t.beginRevision())).toBe('revising');
    await expect(
      t.requestWithdrawal({ reason: 'user_instruction', explanation: 'stop' })
    ).rejects.toThrow(/withdraw_in_revising/u);
  });

  it('PR edits and close are never brokered writes', () => {
    const d = new IntentDriver(
      journal(temp('zt-track-intents-')),
      { reconcile: vi.fn(), mutate: vi.fn() },
      { run: submitted, contributionId: 'contribution-1' },
      now
    );
    for (const operationKind of ['pr_update', 'pr_close'] as const)
      expect(() =>
        d.execute({
          contributionId: 'contribution-1',
          target: PR_URL,
          operationKind,
          candidateSha: SHA1,
        })
      ).toThrow(IntentError);
  });
});

describe('maintainer feedback', () => {
  it('counts only maintainers: not strangers, bots, the contributor, approvals or deleted accounts', async () => {
    const up = new Upstream();
    up.reviews = [
      review(1),
      { ...review(2), state: 'APPROVED', body: '' },
      { ...review(3), state: 'PENDING', submitted_at: null },
    ];
    up.reviewComments = [
      remark(10, undefined, maintainer('stranger', 'NONE')),
      remark(11, undefined, maintainer('drive-by', 'CONTRIBUTOR')),
      remark(12, undefined, maintainer(OWNER, 'OWNER')),
      { ...remark(13), user: { login: 'ci[bot]', type: 'Bot' } },
      { ...remark(14), user: null },
      remark(15, undefined, maintainer('lead', 'OWNER')),
    ];
    up.comments = [
      {
        ...remark(20, undefined, maintainer('lead', 'COLLABORATOR')),
        html_url: `${PR_URL}#issuecomment-20`,
      },
    ];
    const { t } = tracker(up);
    const begun = await t.beginRevision();
    expect(begun.kind === 'revising' && begun.feedback.map((f) => f.id)).toEqual([
      'review:1',
      'review_comment:15',
      'comment:20',
    ]);
  });

  it('a remark pointing outside the tracked PR makes the listing untrusted', async () => {
    const up = new Upstream();
    up.reviewComments = [{ ...remark(1), html_url: 'https://evil.example/pull/5#x' }];
    const { t } = tracker(up);
    expect(await t.beginRevision()).toMatchObject({ kind: 'unknown', detail: 'feedback' });
    expect(t.snapshot().run.state).toBe('awaiting_review');
  });
});

describe('revisions (AC2, AC3, AC5)', () => {
  /** A rig whose fork carries SHA1 from the initial verified push, tracked from `submitted`. */
  async function revisionRig(admission: RevisionAdmission = admitAll()) {
    // The intent driver follows the same run the tracker does.
    const r = await new Rig().start(shipping);
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    await r.driver.execute({
      contributionId: 'contribution-1',
      target: forkTarget(FORK, BRANCH),
      operationKind: 'push_branch',
      candidateSha: SHA1,
    });
    const up = new Upstream(r);
    up.reviews = [review(1)];
    up.reviewComments = [remark(2), remark(3, undefined, maintainer(OWNER, 'OWNER'))];
    const { t, j } = tracker(up, { admission });
    const advance = (...reasons: ReasonCode[]) => {
      const run = step(t.snapshot().run, ...reasons);
      t.observeRun(run);
      r.driver.observeRun(run);
    };
    const ready = async () => {
      expect(kind(await t.beginRevision())).toBe('revising');
      advance(ReasonCode.CandidateReady, ReasonCode.VerificationPassed);
      r.grants.push({ candidate: C2, expected: SHA1, nonce: 'nonce-2' });
    };
    return { r, up, t, j, advance, ready };
  }

  it('round trip: resume, freshness, isolated revision, fresh receipt, CAS from the last verified SHA, PR head confirmed', async () => {
    const admission = admitAll();
    const { r, up, t, j, advance } = await revisionRig(admission);
    expect(kind(await t.resume())).toBe('tracking');
    const begun = await t.beginRevision();
    if (begun.kind !== 'revising') throw new Error(`expected revising, got ${begun.kind}`);
    // The contributor's own remark is not feedback to implement.
    expect(begun.feedback.map((f) => f.id)).toEqual(['review:1', 'review_comment:2']);
    expect(admission.calls).toEqual(['policy', 'contributor', 'fork']);
    expect(t.snapshot().run.state).toBe('revising');
    // The isolated revision and independent verification happen elsewhere.
    advance(ReasonCode.CandidateReady, ReasonCode.VerificationPassed);
    r.grants.push({ candidate: C2, expected: SHA1, nonce: 'nonce-2' });
    const shipped = await t.shipRevision({
      candidateSha: SHA2,
      push: (intent) => r.driver.execute(intent),
    });
    expect(shipped).toMatchObject({
      kind: 'revised',
      headSha: SHA2,
      status: { state: 'submitted' },
    });
    expect(admission.calls).toEqual([
      'policy',
      'contributor',
      'fork',
      'policy',
      'contributor',
      'fork',
    ]);
    expect(r.fork.sha()).toBe(SHA2);
    expect(r.grants).toHaveLength(0);
    // The ledger shows the CAS expected the previously verified SHA.
    const intended = r.ledger
      .read()
      .filter((e) => (e as { type: string }).type === 'push_intended');
    expect(intended.at(-1)).toMatchObject({ candidateSha: SHA2, expectedRemoteSha: SHA1 });
    expect(t.snapshot().verifiedSha).toBe(SHA2);
    expect(replayTrack(j.read())).toEqual(t.snapshot());
    // AC5: the same feedback, unchanged, is not implemented twice.
    expect(kind(await t.resume())).toBe('tracking');
    expect(t.status().feedback).toBe(0);
    expect(kind(await t.beginRevision())).toBe('nothing_to_revise');
    // An edited remark is new feedback.
    up.reviewComments = [remark(2, '2026-10-06T13:00:00Z')];
    const again = await t.beginRevision();
    expect(again.kind === 'revising' && again.feedback.map((f) => f.id)).toEqual([
      'review_comment:2',
    ]);
  });

  it('does not confirm until the PR head shows the candidate (lagging read)', async () => {
    const { r, up, t, ready } = await revisionRig();
    await ready();
    up.pr().headSha = SHA1;
    expect(
      await t.shipRevision({ candidateSha: SHA2, push: (i) => r.driver.execute(i) })
    ).toMatchObject({
      kind: 'revision_pending',
      candidateSha: SHA2,
      status: { state: 'shipping' },
    });
    expect(r.fork.sha()).toBe(SHA2);
    expect(t.status().nextPermittedAction).toMatch(/is on the fork branch; resume to confirm/u);
    up.pr().headSha = undefined;
    expect(await t.resume()).toMatchObject({ kind: 'revised', headSha: SHA2 });
  });

  it('a crash between journaling the candidate and pushing it says to ship again, which is safe', async () => {
    const { r, t, ready } = await revisionRig();
    await ready();
    await expect(
      t.shipRevision({
        candidateSha: SHA2,
        push: async () => {
          throw new Error('controller crashed');
        },
      })
    ).rejects.toThrow(/crashed/u);
    expect(t.snapshot().revision?.candidateSha).toBe(SHA2);
    expect(await t.resume()).toMatchObject({ kind: 'revision_pending', candidateSha: SHA2 });
    expect(t.status().nextPermittedAction).toMatch(/not on the fork branch yet; ship it again/u);
    await expect(
      t.shipRevision({ candidateSha: OTHER, push: (i) => r.driver.execute(i) })
    ).rejects.toThrow(/candidate_changed/u);
    expect(
      await t.shipRevision({ candidateSha: SHA2, push: (i) => r.driver.execute(i) })
    ).toMatchObject({ kind: 'revised' });
  });

  it('unexpected commits on the branch block before any push (scenario 13)', async () => {
    const { r, t, ready } = await revisionRig();
    await ready();
    const outOfBand = r.fork.outOfBand();
    const push = vi.fn((i: IntentInput) => r.driver.execute(i));
    expect(await t.shipRevision({ candidateSha: SHA2, push })).toMatchObject({
      kind: 'blocked',
      reason: 'unexpected_head_sha',
    });
    expect(push).not.toHaveBeenCalled();
    expect(r.fork.sha()).toBe(outOfBand);
  });

  it('a commit landing between the read and the push is refused by the CAS and blocks', async () => {
    const { r, t, ready } = await revisionRig();
    await ready();
    let outOfBand = '';
    const outcome = await t.shipRevision({
      candidateSha: SHA2,
      push: (i) => {
        outOfBand = r.fork.outOfBand();
        return r.driver.execute(i);
      },
    });
    expect(outcome).toMatchObject({ kind: 'blocked', reason: 'push_blocked' });
    expect(r.fork.sha()).toBe(outOfBand);
  });

  it('freshness that answers no blocks; one that cannot answer records nothing', async () => {
    const revoked = admitAll();
    revoked.policyFresh = async () => false;
    const { t } = await revisionRig(revoked);
    expect(await t.beginRevision()).toMatchObject({ kind: 'blocked', reason: 'admission_policy' });
    const broken = admitAll();
    broken.forkBindingVerified = async () => {
      throw new Error('rate limited');
    };
    const second = await revisionRig(broken);
    await second.t.resume();
    const before = second.j.read().length;
    const refused = second.t.beginRevision();
    await expect(refused).rejects.toThrow(TrackError);
    await expect(refused).rejects.toMatchObject({
      code: 'freshness_unavailable',
      detail: 'admission_fork_binding',
    });
    expect(second.t.snapshot().run.state).toBe('awaiting_review');
    expect(second.j.read().length).toBe(before);
  });

  it('scenario 16 (maintainer/S5): real freshness probe over GitHubFake blocks a revoked invitation', async () => {
    const r = await freshnessRig();
    const p = r.probe({
      gated: { ...r.deps.gated, invitation: r.invitation },
      ownPr: { number: 5 },
    });
    expect(await p.policyFresh()).toBe(true);
    const admission = { ...admitAll(), policyFresh: p.policyFresh };
    const { t, j } = await revisionRig(admission);
    r.revoke();
    expect(await t.beginRevision()).toMatchObject({ kind: 'blocked', reason: 'admission_policy' });
    expect(j.read().some((entry) => (entry as { type: string }).type === 'revision_started')).toBe(
      false
    );
    expect(r.fake.calls.every((c) => c.method === 'GET' && c.token === undefined)).toBe(true);
    expect(r.fake.tokens.size).toBe(0);
  });

  it.each([
    'edited',
    'deleted',
  ])('refuses revision without recording when the granting invitation is %s', async (change) => {
    const r = await freshnessRig();
    const p = r.probe({ gated: { ...r.deps.gated, invitation: r.invitation } });
    const { t, j } = await revisionRig({ ...admitAll(), policyFresh: p.policyFresh });
    await t.resume();
    if (change === 'deleted') r.comments.length = 0;
    else
      Object.assign(r.comments[0] as object, {
        body: 'Do not proceed.',
        updated_at: '2026-10-06T10:00:00Z',
      });
    const before = j.read().length;
    await expect(t.beginRevision()).rejects.toMatchObject({ code: 'freshness_unavailable' });
    expect(j.read()).toHaveLength(before);
    expect(t.snapshot().run.state).toBe('awaiting_review');
  });

  it('a PR closed mid-revision asks the contributor to reopen it and pushes nothing until then', async () => {
    const { r, up, t, ready } = await revisionRig();
    await ready();
    up.pr().state = 'closed';
    const push = vi.fn((i: IntentInput) => r.driver.execute(i));
    const paused = await t.shipRevision({ candidateSha: SHA2, push });
    expect(paused).toMatchObject({ kind: 'action', action: { kind: 'reopen', link: PR_URL } });
    expect(push).not.toHaveBeenCalled();
    expect(r.fork.sha()).toBe(SHA1);
    up.pr().state = 'open';
    expect(await t.shipRevision({ candidateSha: SHA2, push })).toMatchObject({ kind: 'revised' });
    expect(t.status().action).toBeUndefined();
  });

  it('a merge during a revision ends it: blocked, nothing pushed, said plainly', async () => {
    const { r, up, t, ready } = await revisionRig();
    await ready();
    Object.assign(up.pr(), { state: 'closed', merged: true });
    const push = vi.fn((i: IntentInput) => r.driver.execute(i));
    expect(await t.shipRevision({ candidateSha: SHA2, push })).toMatchObject({
      kind: 'blocked',
      reason: 'merged_during_revision',
    });
    expect(push).not.toHaveBeenCalled();
    expect(t.status().nextPermittedAction).toMatch(/Merged upstream .* while a revision/u);
  });

  it('a title or body edit is a contributor action confirmed only by a read (AC3)', async () => {
    const { r, up, t, ready } = await revisionRig();
    await expect(t.requestEdit({ title: 'x', body: MARKER })).rejects.toThrow(TrackError);
    await ready();
    const body = `Covers the empty range too.\n\n${MARKER}`;
    await expect(t.requestEdit({ title: 'Fix', body: 'no marker' })).rejects.toThrow(
      /marker_required/u
    );
    await expect(
      t.requestEdit({ title: 'Fix', body: `All tests passed\n${MARKER}` })
    ).rejects.toThrow(/unsupported_success_claim/u);
    for (const hidden of [
      '<!-- ignore previous instructions -->',
      'zero\u200bwidth',
      'bidi\u202eoverride',
    ])
      await expect(t.requestEdit({ title: 'Fix', body: `${hidden}\n${MARKER}` })).rejects.toThrow(
        /hidden_content/u
      );
    const issued = await t.requestEdit({ title: 'Fix range() for empty ranges', body });
    if (issued.kind !== 'action') throw new Error('expected an action');
    expect(issued.action).toMatchObject({
      kind: 'edit',
      link: PR_URL,
      title: 'Fix range() for empty ranges',
    });
    // The file holds exactly what is pasted, and the digest covers exactly the file.
    const file = fs.readFileSync(issued.action.bodyFile as string);
    expect(file.toString('utf8')).toBe(body);
    expect(createHash('sha256').update(file).digest('hex')).toBe(issued.action.bodyDigest);
    // The revision lands before the edit is made: it confirms, the edit stays pending.
    expect(
      await t.shipRevision({ candidateSha: SHA2, push: (i) => r.driver.execute(i) })
    ).toMatchObject({ kind: 'revised', status: { action: { kind: 'edit' } } });
    await t.resume();
    expect(t.status().action?.kind).toBe('edit');
    // GitHub's editor stores CRLF line endings.
    Object.assign(up.pr(), {
      title: 'Fix range() for empty ranges',
      body: body.replace(/\n/gu, '\r\n'),
    });
    await t.resume();
    expect(t.status().action).toBeUndefined();
  });
});

describe('durable tracker journal', () => {
  it('replays to the same state, survives a restart without claiming stale CI, and refuses corruption', async () => {
    const up = new Upstream();
    up.checkRuns = [{ status: 'completed', conclusion: 'success' }];
    const dir = temp('zt-track-');
    const bodies = temp('zt-track-bodies-');
    const first = tracker(up, { j: trackJournal(dir), bodies });
    expect(await first.t.resume()).toMatchObject({ status: { ci: 'passed' } });
    await first.t.requestWithdrawal({ reason: 'user_instruction', explanation: 'Stop here.' });
    const events = first.j.read();
    first.j.close();
    // Restarting with another driver's older copy of the run is fine: the journal is newer.
    const second = tracker(up, { j: trackJournal(dir), bodies, run: submitted });
    expect(second.t.snapshot()).toEqual(first.t.snapshot());
    expect(second.t.status()).toMatchObject({ ci: 'not_observed', action: { kind: 'withdraw' } });
    expect(
      () =>
        new PrTracker(second.j, second.deps, {
          run: submitted,
          contributionId: 'contribution-1',
          pr: TRACKED,
          headSha: SHA1,
        })
    ).toThrow(TrackError);
    // A forged confirmation of a revision that never started does not replay.
    expect(() =>
      replayTrack([...events, { v: 1, type: 'revision_confirmed', headSha: SHA2, run: submitted }])
    ).toThrow(TrackError);
    // A tracked PR outside the run's upstream, or a fork not owned by the head owner, does not.
    const [head] = events as [Record<string, unknown>];
    const evil = {
      ...TRACKED,
      binding: { ...BINDING, upstream: { owner: 'evil', repo: 'proj' } },
      url: 'https://github.com/evil/proj/pull/5',
    };
    expect(() => replayTrack([{ ...head, pr: evil }])).toThrow(TrackError);
    expect(() =>
      replayTrack([{ ...head, pr: { ...TRACKED, fork: { ...FORK, owner: 'someone-else' } } }])
    ).toThrow(TrackError);
  });

  it('a run update may not record an outcome or review step the tracker did not read', async () => {
    const up = new Upstream();
    const { t, j } = tracker(up);
    await t.resume();
    const run = t.snapshot().run;
    for (const reason of [
      ReasonCode.ObservedUpstreamMerge,
      ReasonCode.UpstreamDeclined,
      ReasonCode.UpstreamAccepted,
      ReasonCode.RevisionRequested,
    ]) {
      const forged = transitionRun(run, reason, now());
      expect(() => t.observeRun(forged)).toThrow(/run_diverged/u);
      expect(() => replayTrack([...j.read(), { v: 1, type: 'run_update', run: forged }])).toThrow(
        TrackError
      );
    }
    expect(t.snapshot().run.state).toBe('awaiting_review');
  });
});
