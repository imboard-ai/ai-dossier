import { describe, expect, it } from 'vitest';
import {
  createExecGroundTruth,
  type ExecFn,
  type GroundTruthMilestone,
  groundTruthExec,
  isMemberComplete,
  isParkedMilestone,
  isVerifiedComplete,
  parseIssueLabelsJson,
  parseMilestoneJson,
  parsePrViewJson,
  parseSetupInfo,
} from '../index';

describe('parseMilestoneJson', () => {
  it('parses the runstate last --json shape', () => {
    const stdout = JSON.stringify({
      phase: 'implement',
      status: 'done',
      run: 'r-464-abcd',
      at: '2026-08-29T12:00:00Z',
      head: 'abc1234',
      branch: 'feature/464-x',
    });
    expect(parseMilestoneJson(stdout)).toEqual({
      phase: 'implement',
      status: 'done',
      run: 'r-464-abcd',
      at: '2026-08-29T12:00:00Z',
      keys: {
        phase: 'implement',
        status: 'done',
        run: 'r-464-abcd',
        at: '2026-08-29T12:00:00Z',
        head: 'abc1234',
        branch: 'feature/464-x',
      },
    } satisfies GroundTruthMilestone);
  });

  it('treats "null" (no milestones), empty, and garbage as null', () => {
    expect(parseMilestoneJson('null')).toBeNull();
    expect(parseMilestoneJson('')).toBeNull();
    expect(parseMilestoneJson(null)).toBeNull();
    expect(parseMilestoneJson('not json')).toBeNull();
    expect(parseMilestoneJson('[1,2]')).toBeNull();
    // shape without the required typed fields is not a milestone
    expect(parseMilestoneJson('{"phase":"gate"}')).toBeNull();
  });
});

describe('isVerifiedComplete (AC2 completion rule)', () => {
  const done = (
    phase: string,
    status: string,
    at = '2026-08-29T12:00:00Z'
  ): GroundTruthMilestone => ({
    phase,
    status,
    run: 'r',
    at,
    keys: {},
  });

  it('only the final report-done milestone verifies completion', () => {
    expect(isVerifiedComplete(done('report', 'done'), false)).toBe(true);
    expect(isVerifiedComplete(done('report', 'blocked'), false)).toBe(false);
    expect(isVerifiedComplete(done('ship', 'done'), false)).toBe(false);
    expect(isVerifiedComplete(done('implement', 'done'), false)).toBe(false);
    expect(isVerifiedComplete(null, false)).toBe(false);
  });

  it('a closed issue is ground truth regardless of the milestone', () => {
    expect(isVerifiedComplete(null, true)).toBe(true);
    expect(isVerifiedComplete(done('gate', 'done'), true)).toBe(true);
  });

  describe('#575 dispatch fence (dispatchedAt)', () => {
    it('a report/done milestone that predates dispatchedAt does NOT verify completion', () => {
      // Milestone posted 3 hours before this dispatch spawned — the issue's
      // PREVIOUS run's report, not this one's.
      expect(
        isVerifiedComplete(
          done('report', 'done', '2026-09-02T05:00:00Z'),
          false,
          '2026-09-02T08:00:00Z'
        )
      ).toBe(false);
    });

    it('a report/done milestone posted at or after dispatchedAt verifies completion', () => {
      expect(
        isVerifiedComplete(
          done('report', 'done', '2026-09-02T08:00:00Z'),
          false,
          '2026-09-02T08:00:00Z'
        )
      ).toBe(true);
      expect(
        isVerifiedComplete(
          done('report', 'done', '2026-09-02T09:00:00Z'),
          false,
          '2026-09-02T08:00:00Z'
        )
      ).toBe(true);
    });

    it('tolerates small clock skew (60s) between milestone.at and dispatchedAt', () => {
      expect(
        isVerifiedComplete(
          done('report', 'done', '2026-09-02T07:59:31Z'),
          false,
          '2026-09-02T08:00:00Z'
        )
      ).toBe(true);
      expect(
        isVerifiedComplete(
          done('report', 'done', '2026-09-02T07:58:00Z'),
          false,
          '2026-09-02T08:00:00Z'
        )
      ).toBe(false);
    });

    it('dispatchedAt=null (legacy pre-#524 slot) degrades to the old permissive check', () => {
      expect(isVerifiedComplete(done('report', 'done'), false, null)).toBe(true);
      expect(isVerifiedComplete(done('report', 'done'), false)).toBe(true);
    });

    it('an unparseable milestone.at is not gated by the fence', () => {
      expect(
        isVerifiedComplete(done('report', 'done', 'not-a-date'), false, '2026-09-02T08:00:00Z')
      ).toBe(true);
    });

    it('a closed issue still completes regardless of milestone age (AC3)', () => {
      expect(isVerifiedComplete(done('report', 'done'), true, '2026-09-02T08:00:00Z')).toBe(true);
      expect(isVerifiedComplete(null, true, '2026-09-02T08:00:00Z')).toBe(true);
    });
  });
});

describe('isMemberComplete (#523 AC1) with the #575 dispatch fence', () => {
  const memberDone = (at: string): GroundTruthMilestone => ({
    phase: 'review',
    status: 'done',
    run: 'r',
    at,
    keys: { mode: 'slot' },
  });

  it('only phase=review status=done mode=slot verifies member completion', () => {
    expect(isMemberComplete(memberDone('2026-08-29T12:00:00Z'))).toBe(true);
    expect(
      isMemberComplete({
        phase: 'review',
        status: 'done',
        run: 'r',
        at: '2026-08-29T12:00:00Z',
        keys: {},
      })
    ).toBe(false);
    expect(isMemberComplete(null)).toBe(false);
  });

  it('a review/done member milestone that predates dispatchedAt does NOT verify completion', () => {
    // A member re-added to a fresh batch run after a PREVIOUS batch already
    // shipped it — its stale `review done mode=slot` must not instantly
    // complete the fresh member dispatch.
    expect(isMemberComplete(memberDone('2026-09-02T05:00:00Z'), '2026-09-02T08:00:00Z')).toBe(
      false
    );
  });

  it('a review/done member milestone posted at or after dispatchedAt verifies completion', () => {
    expect(isMemberComplete(memberDone('2026-09-02T08:00:00Z'), '2026-09-02T08:00:00Z')).toBe(true);
  });

  it('dispatchedAt=null degrades to the old permissive check', () => {
    expect(isMemberComplete(memberDone('2026-08-29T12:00:00Z'), null)).toBe(true);
    expect(isMemberComplete(memberDone('2026-08-29T12:00:00Z'))).toBe(true);
  });
});

describe('createExecGroundTruth', () => {
  it('reads milestones, issue state, and branch heads through the exec fn', () => {
    const calls: Array<[string, string[]]> = [];
    const exec: ExecFn = (file, args) => {
      calls.push([file, args]);
      if (file === 'ai-dossier' && args.includes('464')) {
        return JSON.stringify({
          phase: 'report',
          status: 'done',
          run: 'r-464-x',
          at: '2026-08-29T12:00:00Z',
        });
      }
      if (file === 'ai-dossier') return 'null';
      if (file === 'gh') return 'CLOSED';
      if (file === 'git')
        return '9a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b\trefs/heads/feature/464-x';
      return null;
    };
    const gt = createExecGroundTruth(exec, { repoDir: '/repo' });

    expect(gt.latestMilestone(464)?.phase).toBe('report');
    expect(gt.latestMilestone(465)).toBeNull();
    expect(gt.issueClosed(464)).toBe(true);
    expect(gt.branchHead('feature/464-x')).toBe('9a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b');

    // The runstate call asks for JSON; git runs in the repo dir.
    expect(calls.some(([f, a]) => f === 'ai-dossier' && a.includes('--json'))).toBe(true);
    expect(calls.some(([f]) => f === 'git')).toBe(true);
  });

  it('distinguishes unreachable from known-absent when the subprocess fails (decision 2, option A)', () => {
    const failing: ExecFn = () => null;
    const gt = createExecGroundTruth(failing);
    expect(gt.latestMilestone(1)).toBeUndefined(); // FAILED poll — unreachable, not absent
    expect(gt.issueClosed(1)).toBe(false); // never confirms completion
    expect(gt.branchHead('x')).toBeNull();

    // A poll that RUNS and answers "no milestone" is known-absent, not unreachable.
    const ok: ExecFn = (_file, args) => (args.includes('runstate') ? 'null' : null);
    expect(createExecGroundTruth(ok).latestMilestone(1)).toBeNull();
  });

  it('a non-40-hex ls-remote line is not a head sha', () => {
    const exec: ExecFn = (_file, args) =>
      args[0] === 'ls-remote' ? 'short-ref\trefs/heads/x' : null;
    expect(createExecGroundTruth(exec).branchHead('x')).toBeNull();
  });

  it('rejects crafted branch names that could become git options (CWE-88)', () => {
    const calls: Array<[string, string[]]> = [];
    const exec: ExecFn = (file, args) => {
      calls.push([file, args]);
      return null;
    };
    const gt = createExecGroundTruth(exec);
    expect(gt.branchHead('--upload-pack=evil')).toBeNull();
    expect(gt.branchHead('-oProxyCommand=evil')).toBeNull();
    expect(gt.branchHead('ok-branch')).toBeNull(); // exec returns null → null head
    // No git call may have been made for the rejected refs…
    expect(calls.filter(([f]) => f === 'git')).toHaveLength(1);
    // …and the legit ref is queried after the `--` end-of-options separator.
    expect(calls.find(([f]) => f === 'git')?.[1]).toEqual([
      'ls-remote',
      'origin',
      '--',
      'ok-branch',
    ]);
  });

  it('groundTruthExec is the default exec (injectable boundary exists)', () => {
    expect(typeof groundTruthExec).toBe('function');
  });
});

// --- #468: PR state, setup info, park detection ---

describe('parsePrViewJson (#468 AC1)', () => {
  it('parses the gh pr view --json shape', () => {
    const stdout = JSON.stringify({
      state: 'MERGED',
      mergedAt: '2026-08-29T12:30:00Z',
      mergeable: 'MERGEABLE',
      labels: [{ name: 'auto-merge' }, { name: 'feature' }],
    });
    expect(parsePrViewJson(stdout)).toEqual({
      state: 'MERGED',
      mergedAt: '2026-08-29T12:30:00Z',
      mergeable: 'MERGEABLE',
      blocked: false,
    });
  });

  it('detects the auto-merge-blocked label', () => {
    const stdout = JSON.stringify({
      state: 'OPEN',
      mergedAt: null,
      mergeable: 'CONFLICTING',
      labels: [{ name: 'auto-merge-blocked' }],
    });
    expect(parsePrViewJson(stdout)).toEqual({
      state: 'OPEN',
      mergedAt: null,
      mergeable: 'CONFLICTING',
      blocked: true,
    });
  });

  it('missing mergeability and labels degrade safely', () => {
    const stdout = JSON.stringify({ state: 'OPEN', mergedAt: null });
    expect(parsePrViewJson(stdout)).toEqual({
      state: 'OPEN',
      mergedAt: null,
      mergeable: null,
      blocked: false,
    });
  });

  it('null / garbage / unknown states are not a truth', () => {
    expect(parsePrViewJson(null)).toBeNull();
    expect(parsePrViewJson('')).toBeNull();
    expect(parsePrViewJson('not json')).toBeNull();
    expect(parsePrViewJson('{"state":"DRAFT"}')).toBeNull();
  });
});

describe('isParkedMilestone (#468 park detection)', () => {
  const milestone = (phase: string, status: string, keys: Record<string, string> = {}) => ({
    phase,
    status,
    run: 'r',
    at: '2026-08-29T12:00:00Z',
    keys,
  });

  it('only ship/awaiting-merge milestones carrying pr= are parks', () => {
    expect(isParkedMilestone(milestone('ship', 'awaiting-merge', { pr: '55' }))).toBe(true);
    expect(isParkedMilestone(milestone('ship', 'awaiting-merge', {}))).toBe(false);
    expect(isParkedMilestone(milestone('ship', 'awaiting-merge', { pr: 'not-a-number' }))).toBe(
      false
    );
    expect(isParkedMilestone(milestone('ship', 'done', { pr: '55' }))).toBe(false);
    expect(isParkedMilestone(milestone('report', 'done'))).toBe(false);
    expect(isParkedMilestone(null)).toBe(false);
  });
});

describe('parseSetupInfo (#468 teardown inputs)', () => {
  // gh issue view --json comments always wraps the array — {"comments": [...]}
  // — never a bare array (#496). This fixture mirrors that real shape.
  const comments = (bodies: string[]) =>
    JSON.stringify({ comments: bodies.map((body) => ({ body })) });

  it('recovers worktree/pool_claimed from the setup milestone comment', () => {
    const json = comments([
      '<!-- runstate:v1 -->\nphase=gate status=done run=r-1 at=2026-08-29T10:00:00Z\nnext=setup',
      '<!-- runstate:v1 -->\nphase=setup status=done run=r-1 at=2026-08-29T10:05:00Z\nbranch=feature/101-x\nworktree=/repo/worktrees/feature-101-x\npool_claimed=false\nnext=plan',
      '<!-- runstate:v1 -->\nphase=ship status=awaiting-merge run=r-1 at=2026-08-29T11:00:00Z\npr=55\nnext=done',
    ]);
    expect(parseSetupInfo(json)).toEqual({
      worktree: '/repo/worktrees/feature-101-x',
      poolClaimed: false,
      branch: 'feature/101-x',
    });
  });

  it('pool_claimed=true is recognized; newest setup comment wins', () => {
    const json = comments([
      '<!-- runstate:v1 -->\nphase=setup status=done run=r-1 at=2026-08-29T10:05:00Z\nworktree=/old-wt\npool_claimed=false',
      '<!-- runstate:v1 -->\nphase=setup status=done run=r-2 at=2026-08-29T14:05:00Z\nworktree=/pool/wt-9\npool_claimed=true',
    ]);
    expect(parseSetupInfo(json)).toEqual({
      worktree: '/pool/wt-9',
      poolClaimed: true,
      branch: null,
    });
  });

  it('no setup milestone, no worktree key, or garbage → null', () => {
    expect(parseSetupInfo(null)).toBeNull();
    expect(parseSetupInfo('[]')).toBeNull();
    expect(parseSetupInfo('{"comments":[]}')).toBeNull();
    expect(parseSetupInfo('not json')).toBeNull();
    expect(
      parseSetupInfo(
        comments(['<!-- runstate:v1 -->\nphase=gate status=done run=r-1 at=x\nworktree=/wt'])
      )
    ).toBeNull();
    expect(
      parseSetupInfo(
        comments(['<!-- runstate:v1 -->\nphase=setup status=done run=r-1 at=x\npool_claimed=false'])
      )
    ).toBeNull();
    // a blocked setup milestone is not a usable teardown source
    expect(
      parseSetupInfo(
        comments([
          '<!-- runstate:v1 -->\nphase=setup status=blocked run=r-1 at=x\nworktree=/wt\npool_claimed=false',
        ])
      )
    ).toBeNull();
  });

  it('recovers teardown inputs from gh\'s real {"comments": [...]} wrapper shape (#496 regression)', () => {
    const wrapped = JSON.stringify({
      comments: [
        {
          body: '<!-- runstate:v1 -->\nphase=setup status=done run=r-3810 at=2026-08-29T23:00:00Z\nbranch=feature/3810-x\nworktree=/repo/worktrees/feature-3810-x\npool_claimed=true\nnext=plan',
        },
      ],
    });
    expect(parseSetupInfo(wrapped)).toEqual({
      worktree: '/repo/worktrees/feature-3810-x',
      poolClaimed: true,
      branch: 'feature/3810-x',
    });
  });
});

describe('createExecGroundTruth prState/setupInfo (#468)', () => {
  it('reads PR state and setup info through the exec fn', () => {
    const calls: Array<[string, string[]]> = [];
    const exec: ExecFn = (file, args) => {
      calls.push([file, args]);
      if (file === 'gh' && args[0] === 'pr') {
        return JSON.stringify({
          state: 'MERGED',
          mergedAt: '2026-08-29T12:30:00Z',
          mergeable: 'MERGEABLE',
          labels: [],
        });
      }
      if (file === 'gh' && args[0] === 'issue' && args.includes('comments')) {
        return JSON.stringify({
          comments: [
            {
              body: '<!-- runstate:v1 -->\nphase=setup status=done run=r-1 at=x\nworktree=/wt-9\npool_claimed=true',
            },
          ],
        });
      }
      return null;
    };
    const gt = createExecGroundTruth(exec, { repoDir: '/repo' });

    expect(gt.prState(55)).toEqual({
      state: 'MERGED',
      mergedAt: '2026-08-29T12:30:00Z',
      mergeable: 'MERGEABLE',
      blocked: false,
    });
    expect(gt.setupInfo(101)).toEqual({
      worktree: '/wt-9',
      poolClaimed: true,
      branch: null,
    });
    // the PR poll asks gh for exactly the watcher's fields
    expect(
      calls.some(
        ([f, a]) => f === 'gh' && a[0] === 'pr' && a.some((arg) => arg.includes('mergedAt'))
      )
    ).toBe(true);
  });

  it('a failed poll is unreachable for both PR state and setup info', () => {
    const failing: ExecFn = () => null;
    const gt = createExecGroundTruth(failing);
    expect(gt.prState(55)).toBeUndefined();
    expect(gt.setupInfo(101)).toBeUndefined();
    // a verifiably-empty comment list is known-absent, not unreachable
    const empty: ExecFn = (_file, args) => (args.includes('comments') ? '{"comments":[]}' : null);
    expect(createExecGroundTruth(empty).setupInfo(101)).toBeNull();
  });
});

describe('parseSetupInfo author trust (defense-in-depth)', () => {
  /** Build a `gh issue view --json comments` payload (the real wrapper shape). */
  const commentsPayload = (items: Array<{ body: string; authorAssociation?: string }>) =>
    JSON.stringify({ comments: items });

  it('ignores setup milestones from non-collaborators (destructive-input path)', () => {
    const setup = (assoc: string) => ({
      body: '<!-- runstate:v1 -->\nphase=setup status=done run=r-evil at=x\nworktree=/repo/worktrees/evil\npool_claimed=false',
      authorAssociation: assoc,
    });
    // a random commenter's "setup milestone" is not a teardown source
    expect(
      parseSetupInfo(commentsPayload([setup('NONE'), setup('FIRST_TIME_CONTRIBUTOR')]))
    ).toBeNull();
    // owner/member/collaborator milestones are trusted
    for (const assoc of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      expect(parseSetupInfo(commentsPayload([setup(assoc)]))?.worktree).toBe(
        '/repo/worktrees/evil'
      );
    }
    // a trusted setup beats a newer untrusted one
    expect(
      parseSetupInfo(
        commentsPayload([
          {
            body: '<!-- runstate:v1 -->\nphase=setup status=done run=r-1 at=x\nworktree=/repo/worktrees/real\npool_claimed=false',
            authorAssociation: 'OWNER',
          },
          setup('NONE'),
        ])
      )?.worktree
    ).toBe('/repo/worktrees/real');
  });

  it('comments without authorAssociation (older gh / file fakes) still parse', () => {
    expect(
      parseSetupInfo(
        commentsPayload([
          {
            body: '<!-- runstate:v1 -->\nphase=setup status=done run=r-1 at=x\nworktree=/repo/worktrees/wt\npool_claimed=true',
          },
        ])
      )
    ).toEqual({ worktree: '/repo/worktrees/wt', poolClaimed: true, branch: null });
  });
});

describe('issueLabels (#544)', () => {
  it('reads label names through the exec fn, asking gh for exactly the labels field', () => {
    const calls: Array<[string, string[]]> = [];
    const exec: ExecFn = (file, args) => {
      calls.push([file, args]);
      return JSON.stringify({ labels: [{ name: 'bug' }, { name: 'decision-pending' }] });
    };

    expect(createExecGroundTruth(exec, { repoDir: '/repo' }).issueLabels(544)).toEqual([
      'bug',
      'decision-pending',
    ]);
    expect(calls).toEqual([['gh', ['issue', 'view', '544', '--json', 'labels']]]);
  });

  it('reports UNREACHABLE (undefined) when the read fails — never an empty label set', () => {
    // The distinction is load-bearing: [] unblocks a `label:`-blocked unit.
    expect(createExecGroundTruth(() => null).issueLabels(544)).toBeUndefined();
  });

  it('reports UNREACHABLE when gh exits 0 with a non-JSON body', () => {
    expect(createExecGroundTruth(() => 'not json at all').issueLabels(544)).toBeUndefined();
  });
});

describe('parseIssueLabelsJson', () => {
  it('parses the gh --json labels shape', () => {
    expect(parseIssueLabelsJson(JSON.stringify({ labels: [{ name: 'epic' }] }))).toEqual(['epic']);
  });

  it('parses an issue with no labels as an empty array, not unreachable', () => {
    expect(parseIssueLabelsJson(JSON.stringify({ labels: [] }))).toEqual([]);
  });

  it('drops malformed label entries but keeps the ones that parsed', () => {
    const stdout = JSON.stringify({ labels: [{ name: 'bug' }, {}, null, { name: 42 }] });
    expect(parseIssueLabelsJson(stdout)).toEqual(['bug']);
  });

  it('returns undefined for empty, non-JSON, and labels-less payloads', () => {
    expect(parseIssueLabelsJson('')).toBeUndefined();
    expect(parseIssueLabelsJson(null)).toBeUndefined();
    expect(parseIssueLabelsJson('{')).toBeUndefined();
    expect(parseIssueLabelsJson(JSON.stringify({ state: 'OPEN' }))).toBeUndefined();
  });
});
