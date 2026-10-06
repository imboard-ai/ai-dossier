/** #1068: upstream PR tracking and revisions. GitHub is a mocked, GET-only HTTP fake; the
 * revision round trip pushes to a local bare repository through the #1066 CAS rig. No
 * network, no real credentials. */
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntentDriver, IntentError, type IntentInput } from '../../intents';
import { Journal } from '../../journal';
import { createRun, ReasonCode, type RunRecord, transitionRun } from '../../state';
import { forkTarget } from '../fork-ref';
import { handoffMarker, type PrBinding } from '../handoff';
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
  type TrackedPr,
  type TrackOutcome,
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
const TRACKED: TrackedPr = Object.freeze({
  binding: BINDING,
  fork: FORK,
  number: 5,
  url: PR_URL,
  marker: MARKER,
});

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
  checkRuns: unknown[] = [];
  workflowRuns: unknown[] = [];
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
    const keyed = (key: string, items: unknown[]) => ({
      status: 200,
      body: { total_count: items.length, [key]: items.slice((page - 1) * 100, page * 100) },
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
    if (m?.[2] === 'check-runs') return keyed('check_runs', this.checkRuns);
    if (m?.[2] === 'status') return { status: 200, body: this.status };
    if (route === '/repos/up/proj/actions/runs') return keyed('workflow_runs', this.workflowRuns);
    return { status: 404, body: null };
  };
}

function review(id: number, author = 'maintainer', updated = '2026-10-06T11:00:00Z') {
  return {
    id,
    user: { login: author, type: 'User' },
    body: 'Please also cover the empty range.',
    state: 'CHANGES_REQUESTED',
    submitted_at: updated,
    commit_id: SHA1,
    html_url: `${PR_URL}#pullrequestreview-${id}`,
  };
}
function remark(id: number, author = 'maintainer', updated = '2026-10-06T11:00:00Z') {
  return {
    id,
    user: { login: author, type: 'User' },
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

const journals: Journal[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const j of journals.splice(0)) j.close();
});
function trackJournal(dir = temp('zt-track-')): Journal {
  const j = new Journal(dir);
  journals.push(j);
  return j;
}
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
    pr: TRACKED,
    headSha: SHA1,
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
    expect(upstreamOutcome(await observePr(up.read, TRACKED))).toBe('unknown');
  });

  it('only an observed merge is merged: a closed PR with a merge-like title is declined', async () => {
    const up = new Upstream();
    Object.assign(up.pr(), { state: 'closed', title: 'Merged! all tests passed' });
    const track = await observePr(up.read, TRACKED);
    expect(track).toMatchObject({ kind: 'observed', merged: false, state: 'closed' });
    expect(upstreamOutcome(track)).toBe('declined');
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
    const reads = up.calls.length;
    expect(kind(await t.resume())).toBe('merged');
    expect(up.calls.length).toBe(reads);
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

  it('a head SHA moved out of band blocks (scenario 13)', async () => {
    const up = new Upstream();
    up.pr().headSha = OTHER;
    expect(await tracker(up).t.resume()).toMatchObject({
      kind: 'blocked',
      reason: 'unexpected_head_sha',
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
    expect(await t.resume()).toMatchObject({ kind: 'unknown', status: { state: 'submitted' } });
    expect(j.read().length).toBe(before);
  });
});

describe('upstream CI as observed (AC7, scenario 12)', () => {
  const ci = async (patch: Partial<Upstream>) => {
    const up = new Upstream();
    Object.assign(up, patch);
    return observeCi(up.read, BINDING, SHA1);
  };
  it('reports none, pending, awaiting approval, failed and passed from what GitHub shows', async () => {
    expect(await ci({})).toBe('none');
    expect(await ci({ status: { state: 'pending', total_count: 0 } })).toBe('none');
    expect(await ci({ checkRuns: [{ status: 'in_progress', conclusion: null }] })).toBe('pending');
    expect(await ci({ status: { state: 'pending', total_count: 2 } })).toBe('pending');
    expect(
      await ci({ workflowRuns: [{ status: 'completed', conclusion: 'action_required' }] })
    ).toBe('awaiting_approval');
    expect(await ci({ workflowRuns: [{ status: 'waiting', conclusion: null }] })).toBe(
      'awaiting_approval'
    );
    expect(
      await ci({
        checkRuns: [
          { status: 'completed', conclusion: 'success' },
          { status: 'completed', conclusion: 'failure' },
        ],
      })
    ).toBe('failed');
    expect(await ci({ status: { state: 'error', total_count: 1 } })).toBe('failed');
    expect(
      await ci({
        checkRuns: [
          { status: 'completed', conclusion: 'success' },
          { status: 'completed', conclusion: 'skipped' },
        ],
        workflowRuns: [{ status: 'completed', conclusion: 'success' }],
        status: { state: 'success', total_count: 1 },
      })
    ).toBe('passed');
  });

  it('never infers green: an unreadable source or an unknown conclusion is unknown', async () => {
    const up = new Upstream();
    up.checkRuns = [{ status: 'completed', conclusion: 'success' }];
    up.failing.add('/actions/runs');
    expect(await observeCi(up.read, BINDING, SHA1)).toBe('unknown');
    expect(await ci({ checkRuns: [{ status: 'completed', conclusion: 'mystery' }] })).toBe(
      'unknown'
    );
    // A listing claiming more items than it returns is truncated, not complete.
    const truncated = new Upstream();
    const read: GitHubRead = async (p) =>
      p.includes('/check-runs')
        ? {
            status: 200,
            body: {
              total_count: 5000,
              check_runs: Array(100).fill({ status: 'completed', conclusion: 'success' }),
            },
          }
        : truncated.read(p);
    expect(await observeCi(read, BINDING, SHA1)).toBe('unknown');
  });

  it('status says what the contributor does next and never calls pending or unread checks green', async () => {
    for (const [patch, ci, text] of [
      [{}, 'none', /No upstream checks are reported/u],
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
      expect(status).toMatchObject({ state: 'awaiting_review', ci, ciSha: SHA1 });
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
    expect(issued.action.instructions).toMatch(/Nothing is deleted/u);
    expect(issued.action.instructions).toMatch(/sends no follow-up/u);
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

  it('a pending withdrawal does not chase a replacement PR, and a merge overtakes it', async () => {
    const up = new Upstream();
    up.pulls.push({ number: 6, state: 'open' });
    const { t } = tracker(up);
    await t.requestWithdrawal({ reason: 'user_instruction', explanation: 'No longer needed.' });
    Object.assign(up.pr(), { state: 'closed', merged: true });
    expect(kind(await t.resume())).toBe('merged');
    expect(up.calls.some((p) => p.startsWith('/repos/up/proj/pulls?'))).toBe(false);
  });

  it('is refused while revising and never brokered', async () => {
    const up = new Upstream();
    up.reviews = [review(1)];
    const { t } = tracker(up);
    await t.beginRevision();
    await expect(
      t.requestWithdrawal({ reason: 'user_instruction', explanation: 'stop' })
    ).rejects.toThrow(TrackError);
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
    up.reviewComments = [remark(2), remark(3, OWNER)];
    const { t, j } = tracker(up, { admission });
    const advance = (...reasons: ReasonCode[]) => {
      const run = step(t.snapshot().run, ...reasons);
      t.observeRun(run);
      r.driver.observeRun(run);
    };
    return { r, up, t, j, advance };
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
    expect(
      r.ledger
        .read()
        .filter((e) => (e as { type: string }).type === 'push_intended')
        .at(-1)
    ).toMatchObject({ candidateSha: SHA2, expectedRemoteSha: SHA1 });
    expect(t.snapshot().verifiedSha).toBe(SHA2);
    expect(replayTrack(j.read())).toEqual(t.snapshot());
    // AC5: the same feedback, unchanged, is not implemented twice.
    expect(kind(await t.resume())).toBe('tracking');
    expect(t.status().feedback).toBe(0);
    expect(kind(await t.beginRevision())).toBe('nothing_to_revise');
    // An edited remark is new feedback.
    up.reviewComments = [remark(2, 'maintainer', '2026-10-06T13:00:00Z')];
    const again = await t.beginRevision();
    expect(again.kind === 'revising' && again.feedback.map((f) => f.id)).toEqual([
      'review_comment:2',
    ]);
  });

  it('does not confirm until the PR head shows the candidate (lagging read)', async () => {
    const { r, up, t, advance } = await revisionRig();
    await t.beginRevision();
    advance(ReasonCode.CandidateReady, ReasonCode.VerificationPassed);
    r.grants.push({ candidate: C2, expected: SHA1, nonce: 'nonce-2' });
    up.pr().headSha = SHA1;
    expect(
      await t.shipRevision({ candidateSha: SHA2, push: (i) => r.driver.execute(i) })
    ).toMatchObject({
      kind: 'revision_pending',
      candidateSha: SHA2,
      status: { state: 'shipping' },
    });
    expect(r.fork.sha()).toBe(SHA2);
    up.pr().headSha = undefined;
    expect(await t.resume()).toMatchObject({ kind: 'revised', headSha: SHA2 });
  });

  it('unexpected commits on the branch block before any push (scenario 13)', async () => {
    const { r, t, advance } = await revisionRig();
    await t.beginRevision();
    advance(ReasonCode.CandidateReady, ReasonCode.VerificationPassed);
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
    const { r, t, advance } = await revisionRig();
    await t.beginRevision();
    advance(ReasonCode.CandidateReady, ReasonCode.VerificationPassed);
    r.grants.push({ candidate: C2, expected: SHA1, nonce: 'nonce-2' });
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
    const before = second.j.read().length;
    await expect(second.t.beginRevision()).rejects.toThrow(TrackError);
    // The resume inside it may record review_awaited; no revision starts.
    expect(second.t.snapshot().run.state).toBe('awaiting_review');
    expect(second.j.read().length).toBeLessThanOrEqual(before + 1);
  });

  it('a PR closed mid-revision asks the contributor to reopen it and pushes nothing until then', async () => {
    const { r, up, t, advance } = await revisionRig();
    await t.beginRevision();
    advance(ReasonCode.CandidateReady, ReasonCode.VerificationPassed);
    up.pr().state = 'closed';
    const push = vi.fn((i: IntentInput) => r.driver.execute(i));
    const paused = await t.shipRevision({ candidateSha: SHA2, push });
    expect(paused).toMatchObject({ kind: 'action', action: { kind: 'reopen', link: PR_URL } });
    expect(push).not.toHaveBeenCalled();
    expect(r.fork.sha()).toBe(SHA1);
    up.pr().state = 'open';
    r.grants.push({ candidate: C2, expected: SHA1, nonce: 'nonce-2' });
    expect(await t.shipRevision({ candidateSha: SHA2, push })).toMatchObject({ kind: 'revised' });
    expect(t.status().action).toBeUndefined();
  });

  it('a title or body edit is a contributor action confirmed only by a read (AC3)', async () => {
    const { up, t } = await revisionRig();
    await expect(t.requestEdit({ title: 'x', body: MARKER })).rejects.toThrow(TrackError);
    await t.beginRevision();
    const body = `Covers the empty range too.\n\n${MARKER}`;
    await expect(t.requestEdit({ title: 'Fix', body: 'no marker' })).rejects.toThrow(
      /marker_required/u
    );
    await expect(
      t.requestEdit({ title: 'Fix', body: `All tests passed\n${MARKER}` })
    ).rejects.toThrow(/unsupported_success_claim/u);
    const issued = await t.requestEdit({ title: 'Fix range() for empty ranges', body });
    if (issued.kind !== 'action') throw new Error('expected an action');
    expect(issued.action).toMatchObject({
      kind: 'edit',
      link: PR_URL,
      title: 'Fix range() for empty ranges',
    });
    expect(fs.readFileSync(issued.action.bodyFile as string, 'utf8')).toContain(body);
    // Not edited yet: the run does not claim it.
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
    const second = tracker(up, { j: trackJournal(dir), bodies, run: first.t.snapshot().run });
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
    // A tracked PR outside the run's upstream does not replay.
    const [head] = events as [Record<string, unknown>];
    expect(() =>
      replayTrack([
        {
          ...head,
          pr: {
            ...TRACKED,
            binding: { ...BINDING, upstream: { owner: 'evil', repo: 'proj' } },
            url: 'https://github.com/evil/proj/pull/5',
          },
        },
      ])
    ).toThrow(TrackError);
  });
});
