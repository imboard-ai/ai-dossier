import { describe, expect, it } from 'vitest';
import {
  batchPhaseBlockedReason,
  createExecGroundTruth,
  type ExecFn,
  type GroundTruthMilestone,
  groundTruthExec,
  isBatchPhaseDone,
  isMemberBlocked,
  isMemberComplete,
  isParkedMilestone,
  isVerifiedComplete,
  memberBlockedReason,
  parseIssueCloseTruthJson,
  parseIssueLabelsJson,
  parseMergedPrListJson,
  parseMilestoneJson,
  parseMilestoneListJson,
  parseOpenPrListJson,
  parsePrViewJson,
  parseSetupInfo,
  REVIEW_PARTIAL_REASON,
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

  describe('#677: member-cycle vocabulary — a present batch= key also marks the trail', () => {
    // member-cycle carries `batch=<id>` on every milestone (its blocked
    // postings name `batch=` without `mode=slot`); gate-issue's slot-trail
    // rule already reads the disjunction ("carries `mode=slot` or
    // `batch=<id>`"). The scheduler's predicates must accept both spellings.
    const memberDoneBatch = (at: string): GroundTruthMilestone => ({
      phase: 'review',
      status: 'done',
      run: 'r',
      at,
      keys: { batch: 'b-20260909-01' },
    });

    it('a review/done milestone carrying only batch= verifies completion', () => {
      expect(isMemberComplete(memberDoneBatch('2026-08-29T12:00:00Z'))).toBe(true);
      expect(
        isMemberComplete(memberDoneBatch('2026-09-02T08:00:00Z'), '2026-09-02T08:00:00Z')
      ).toBe(true);
    });

    it('the #575 dispatch fence applies to the batch= spelling too', () => {
      expect(
        isMemberComplete(memberDoneBatch('2026-09-02T05:00:00Z'), '2026-09-02T08:00:00Z')
      ).toBe(false);
    });

    it('a full-cycle milestone (neither mode=slot nor batch=) still does NOT complete a member', () => {
      expect(
        isMemberComplete({
          phase: 'review',
          status: 'done',
          run: 'r',
          at: '2026-08-29T12:00:00Z',
          keys: {},
        })
      ).toBe(false);
    });
  });
});

describe('#804: a member review partial is a terminal hand-back', () => {
  const partial = (keys: Record<string, string>): GroundTruthMilestone => ({
    phase: 'review',
    status: 'partial',
    run: 'r',
    at: '2026-09-24T12:00:00Z',
    keys,
  });

  it('a batch-trail review partial reads as blocked, naming the pending agents', () => {
    const m = partial({ batch: 'b1', agents_pending: 'security' });
    expect(isMemberBlocked(m)).toBe(true);
    expect(isMemberComplete(m)).toBe(false);
    expect(memberBlockedReason(m)).toBe(`${REVIEW_PARTIAL_REASON}:security`);
    expect(memberBlockedReason(partial({ mode: 'slot' }))).toBe(REVIEW_PARTIAL_REASON);
  });

  it('a non-member review partial, or a partial at another phase, is not a hand-back', () => {
    expect(isMemberBlocked(partial({ agents_pending: 'security' }))).toBe(false);
    expect(isMemberBlocked({ ...partial({ batch: 'b1' }), phase: 'implement' })).toBe(false);
  });

  it("a blocked milestone's own reason= wins", () => {
    expect(
      memberBlockedReason({
        phase: 'review',
        status: 'blocked',
        run: 'r',
        at: '2026-09-24T12:00:00Z',
        keys: { batch: 'b1', reason: 'review-not-run' },
      })
    ).toBe('review-not-run');
  });
});

describe('isMemberBlocked (#523 AC1/AC2) with the #605 dispatch fence', () => {
  const memberBlocked = (at: string, reason = 'no-plan-artifact'): GroundTruthMilestone => ({
    phase: 'plan',
    status: 'blocked',
    run: 'r',
    at,
    keys: { mode: 'slot', reason },
  });

  it('only status=blocked mode=slot signals a blocked member', () => {
    expect(isMemberBlocked(memberBlocked('2026-08-29T12:00:00Z'))).toBe(true);
    expect(
      isMemberBlocked({
        phase: 'plan',
        status: 'blocked',
        run: 'r',
        at: '2026-08-29T12:00:00Z',
        keys: {},
      })
    ).toBe(false);
    expect(isMemberBlocked(null)).toBe(false);
  });

  it('#677: a blocked milestone carrying only batch= (member-cycle) signals a blocked member', () => {
    // member-cycle's Step 0/Step 6 hand-back postings name `--kv batch=<batch>`
    // without `mode=slot` — the scheduler must read the hand-back, or the
    // member dies unfenced as `agent-exited-unverified` instead.
    expect(
      isMemberBlocked({
        phase: 'plan',
        status: 'blocked',
        run: 'r',
        at: '2026-08-29T12:00:00Z',
        keys: { batch: 'b-20260909-01', reason: 'env-cold' },
      })
    ).toBe(true);
    expect(
      isMemberBlocked(
        {
          phase: 'plan',
          status: 'blocked',
          run: 'r',
          at: '2026-09-06T07:00:00Z',
          keys: { batch: 'b-20260909-01', reason: 'env-cold' },
        },
        '2026-09-06T08:02:00Z'
      )
    ).toBe(false);
  });

  it('#605: a blocked milestone that predates dispatchedAt does NOT block the member', () => {
    // The regression this fix exists for: RFC-0001 F.8 requeues every member
    // of a dissolved batch, so a member re-added to a fresh batch carries the
    // hand-back that caused the dissolve. Read unfenced, it evicted the fresh
    // agent mid-run and the journal reported the OLD run's reason=.
    expect(isMemberBlocked(memberBlocked('2026-09-06T07:56:11Z'), '2026-09-06T08:02:00Z')).toBe(
      false
    );
  });

  it('a blocked milestone posted at or after dispatchedAt still blocks the member', () => {
    expect(isMemberBlocked(memberBlocked('2026-09-06T08:02:00Z'), '2026-09-06T08:02:00Z')).toBe(
      true
    );
  });

  it('dispatchedAt=null degrades to the old permissive check', () => {
    expect(isMemberBlocked(memberBlocked('2026-08-29T12:00:00Z'), null)).toBe(true);
    expect(isMemberBlocked(memberBlocked('2026-08-29T12:00:00Z'))).toBe(true);
  });

  it('is fenced with the same signature shape as isMemberComplete (the #575 asymmetry)', () => {
    // #575 fenced one terminal predicate and not the other; keep them paired.
    const at = '2026-09-06T05:00:00Z';
    const dispatchedAt = '2026-09-06T08:00:00Z';
    expect(
      isMemberComplete(
        { phase: 'review', status: 'done', run: 'r', at, keys: { mode: 'slot' } },
        dispatchedAt
      )
    ).toBe(false);
    expect(isMemberBlocked(memberBlocked(at), dispatchedAt)).toBe(false);
  });
});

describe('isBatchPhaseDone (#605 audit) with the dispatch fence', () => {
  const anchorDone = (at: string): GroundTruthMilestone => ({
    phase: 'batch-review',
    status: 'done',
    run: 'r',
    at,
    keys: {},
  });

  it('matches the named phase only', () => {
    expect(isBatchPhaseDone(anchorDone('2026-09-06T08:00:00Z'), 'batch-review')).toBe(true);
    expect(isBatchPhaseDone(anchorDone('2026-09-06T08:00:00Z'), 'batch-report')).toBe(false);
    expect(isBatchPhaseDone(null, 'batch-review')).toBe(false);
  });

  it('a done milestone predating dispatchedAt does not advance the batch', () => {
    // An anchor is per-batch by convention only; a re-enqueue against an
    // existing anchor would otherwise skip the new batch's own review.
    expect(
      isBatchPhaseDone(anchorDone('2026-09-06T05:00:00Z'), 'batch-review', '2026-09-06T08:00:00Z')
    ).toBe(false);
    expect(
      isBatchPhaseDone(anchorDone('2026-09-06T08:00:00Z'), 'batch-review', '2026-09-06T08:00:00Z')
    ).toBe(true);
  });
});

describe('batchPhaseBlockedReason (#832)', () => {
  const blocked = (
    phase: string,
    at: string,
    keys: Record<string, string> = {}
  ): GroundTruthMilestone => ({ phase, status: 'blocked', run: 'r', at, keys });

  it("returns the tail's own reason for a blocked milestone of a listed phase", () => {
    const m = blocked('batch-review', '2026-09-24T17:25:00Z', { reason: 'members-mismatch' });
    expect(batchPhaseBlockedReason(m, ['batch-review', 'batch-ship'])).toBe('members-mismatch');
    expect(batchPhaseBlockedReason(m, ['batch-report'])).toBeNull();
    expect(batchPhaseBlockedReason(null, ['batch-review'])).toBeNull();
    expect(
      batchPhaseBlockedReason({ ...m, status: 'done' }, ['batch-review', 'batch-ship'])
    ).toBeNull();
  });

  it('is fenced to this dispatch — an earlier blocked milestone does not block a new tail', () => {
    const m = blocked('batch-review', '2026-09-24T17:00:00Z', { reason: 'x' });
    expect(batchPhaseBlockedReason(m, ['batch-review'], '2026-09-24T18:00:00Z')).toBeNull();
    expect(batchPhaseBlockedReason(m, ['batch-review'], '2026-09-24T17:00:00Z')).toBe('x');
  });

  it('reduces the agent-written reason to a slug, and names a missing one', () => {
    const at = '2026-09-24T17:25:00Z';
    expect(
      batchPhaseBlockedReason(blocked('batch-ship', at, { reason: 'bad $(rm -rf) reason' }), [
        'batch-ship',
      ])
    ).toBe('bad-rm--rf-reason');
    expect(batchPhaseBlockedReason(blocked('batch-ship', at), ['batch-ship'])).toBe('unspecified');
    expect(
      batchPhaseBlockedReason(blocked('batch-ship', at, { reason: 'a'.repeat(200) }), [
        'batch-ship',
      ])?.length
    ).toBe(80);
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

  it('#596: openPrForBranch reads the first open PR for a branch, or null when there is none', () => {
    const calls: Array<[string, string[]]> = [];
    const exec: ExecFn = (file, args) => {
      calls.push([file, args]);
      if (file !== 'gh') return null;
      return args.includes('has-pr') ? JSON.stringify([{ number: 3999 }]) : '[]';
    };
    const gt = createExecGroundTruth(exec);
    expect(gt.openPrForBranch('no-pr-branch')).toBeNull();
    expect(gt.openPrForBranch('has-pr')).toBe(3999);
    expect(
      calls.some(([f, a]) => f === 'gh' && a[0] === 'pr' && a[1] === 'list' && a.includes('has-pr'))
    ).toBe(true);
  });

  it('#596: openPrForBranch is unreachable when the poll fails, and rejects crafted branch names (CWE-88)', () => {
    const failing: ExecFn = () => null;
    expect(createExecGroundTruth(failing).openPrForBranch('some-branch')).toBeUndefined();

    const calls: Array<[string, string[]]> = [];
    const exec: ExecFn = (file, args) => {
      calls.push([file, args]);
      return '[]';
    };
    const gt = createExecGroundTruth(exec);
    // `undefined`, not `null`: a rejected ref means we refused to ask, and
    // `null` is the positive claim ("verifiably no open PR") the engine is
    // entitled to fail a unit terminally on.
    expect(gt.openPrForBranch('--upload-pack=evil')).toBeUndefined();
    expect(calls).toHaveLength(0); // rejected before any subprocess ran
  });
});

describe('parseOpenPrListJson (#596)', () => {
  it('returns the first open PR number', () => {
    expect(parseOpenPrListJson(JSON.stringify([{ number: 3999 }, { number: 1 }]))).toBe(3999);
  });

  it('an empty result is a verified "no open PR"', () => {
    expect(parseOpenPrListJson('[]')).toBeNull();
  });

  it('an unusable payload is UNREACHABLE, not a verified "no open PR"', () => {
    // The distinction the engine acts on: `null` lets it fail a unit
    // terminally, so a gh version change or an auth banner on stdout must
    // not be able to manufacture that claim.
    expect(parseOpenPrListJson(null)).toBeUndefined();
    expect(parseOpenPrListJson('')).toBeUndefined();
    expect(parseOpenPrListJson('not json')).toBeUndefined();
    expect(parseOpenPrListJson('{"unexpected":"shape"}')).toBeUndefined();
  });

  it('entries present but none usable is a verified "no open PR"', () => {
    expect(parseOpenPrListJson('[{"number":"55"}]')).toBeNull(); // string, not number
    expect(parseOpenPrListJson('[{}]')).toBeNull();
    expect(parseOpenPrListJson('[null]')).toBeNull();
    expect(parseOpenPrListJson('[{"number":0}]')).toBeNull(); // not positive
  });

  it("accepts gh's single-key wrapper shape as well as a bare array (#496)", () => {
    expect(parseOpenPrListJson('{"pullRequests":[{"number":3999}]}')).toBe(3999);
  });

  it('skips a FORK PR that merely reuses the branch name — never park on work the fleet did not do', () => {
    // `gh pr list --head` filters on the head ref NAME only, so anyone with
    // fork access can put a same-named branch in this list. Adopting it would
    // park a unit on, and on merge certify, work the fleet never produced.
    const out = JSON.stringify([
      { number: 4242, headRefName: 'issue-596', isCrossRepository: true },
      { number: 3999, headRefName: 'issue-596', isCrossRepository: false },
    ]);
    expect(parseOpenPrListJson(out, 'issue-596')).toBe(3999);

    const forkOnly = JSON.stringify([
      { number: 4242, headRefName: 'issue-596', isCrossRepository: true },
    ]);
    expect(parseOpenPrListJson(forkOnly, 'issue-596')).toBeNull();
  });

  it('skips an entry whose headRefName does not match the branch asked about', () => {
    const out = JSON.stringify([
      { number: 4242, headRefName: 'some-other-branch', isCrossRepository: false },
    ]);
    expect(parseOpenPrListJson(out, 'issue-596')).toBeNull();
  });

  it('takes the first of several same-head PRs rather than refusing to choose', () => {
    // GitHub allows one open PR per head/BASE pair, not one per head — a
    // branch targeting two bases yields two. The caller needs A live PR to
    // hand the watcher; refusing would strand both.
    const out = JSON.stringify([
      { number: 3999, headRefName: 'issue-596', isCrossRepository: false },
      { number: 4000, headRefName: 'issue-596', isCrossRepository: false },
    ]);
    expect(parseOpenPrListJson(out, 'issue-596')).toBe(3999);
  });
});

// --- #789: automatic detection of a hand-opened batch PR the ledger never recorded ---

describe('parseMergedPrListJson (#789)', () => {
  const THRESHOLD = '2026-09-13T00:00:00Z';
  const AFTER = '2026-09-13T01:00:00Z';
  const BEFORE = '2026-09-12T23:00:00Z';

  it('finds the single qualifying MERGED PR — the imboard#4255 shape', () => {
    const out = JSON.stringify([
      {
        number: 4255,
        headRefName: 'batch/b-20260913-01-20260913',
        baseRefName: 'main',
        isCrossRepository: false,
        mergedAt: AFTER,
        createdAt: AFTER,
      },
    ]);
    expect(parseMergedPrListJson(out, 'batch/b-20260913-01-20260913', 'main', THRESHOLD)).toEqual({
      kind: 'found',
      pr: 4255,
      mergedAt: AFTER,
    });
  });

  it('zero candidates is a VERIFIED none, not unreachable', () => {
    expect(parseMergedPrListJson('[]', 'batch/x', 'main', THRESHOLD)).toEqual({ kind: 'none' });
  });

  it('an unusable payload is UNREACHABLE, never a verified answer', () => {
    expect(parseMergedPrListJson(null, 'batch/x', 'main', THRESHOLD)).toBeUndefined();
    expect(parseMergedPrListJson('', 'batch/x', 'main', THRESHOLD)).toBeUndefined();
    expect(parseMergedPrListJson('not json', 'batch/x', 'main', THRESHOLD)).toBeUndefined();
    expect(
      parseMergedPrListJson('{"unexpected":"shape"}', 'batch/x', 'main', THRESHOLD)
    ).toBeUndefined();
  });

  it('an unparseable threshold verifies nothing (fails closed, never "none")', () => {
    expect(parseMergedPrListJson('[]', 'batch/x', 'main', 'not-a-date')).toBeUndefined();
  });

  it("skips a FORK PR that merely reuses the branch name — never adopt work the fleet didn't do", () => {
    const out = JSON.stringify([
      {
        number: 9999,
        headRefName: 'batch/x',
        baseRefName: 'main',
        isCrossRepository: true,
        mergedAt: AFTER,
        createdAt: AFTER,
      },
    ]);
    expect(parseMergedPrListJson(out, 'batch/x', 'main', THRESHOLD)).toEqual({ kind: 'none' });
  });

  it('skips a PR based against the WRONG base branch', () => {
    const out = JSON.stringify([
      {
        number: 4255,
        headRefName: 'batch/x',
        baseRefName: 'staging',
        isCrossRepository: false,
        mergedAt: AFTER,
        createdAt: AFTER,
      },
    ]);
    expect(parseMergedPrListJson(out, 'batch/x', 'main', THRESHOLD)).toEqual({ kind: 'none' });
  });

  it('skips an UNMERGED PR (no mergedAt) even under --state merged', () => {
    const out = JSON.stringify([
      {
        number: 4255,
        headRefName: 'batch/x',
        baseRefName: 'main',
        isCrossRepository: false,
        mergedAt: null,
        createdAt: AFTER,
      },
    ]);
    expect(parseMergedPrListJson(out, 'batch/x', 'main', THRESHOLD)).toEqual({ kind: 'none' });
  });

  it('skips a PR created BEFORE the batch — a stale PR from an earlier batch reusing the branch name', () => {
    const out = JSON.stringify([
      {
        number: 1111,
        headRefName: 'batch/x',
        baseRefName: 'main',
        isCrossRepository: false,
        mergedAt: AFTER,
        createdAt: BEFORE,
      },
    ]);
    expect(parseMergedPrListJson(out, 'batch/x', 'main', THRESHOLD)).toEqual({ kind: 'none' });
  });

  it('a PR created exactly AT the threshold qualifies ("at or after")', () => {
    const out = JSON.stringify([
      {
        number: 4255,
        headRefName: 'batch/x',
        baseRefName: 'main',
        isCrossRepository: false,
        mergedAt: AFTER,
        createdAt: THRESHOLD,
      },
    ]);
    expect(parseMergedPrListJson(out, 'batch/x', 'main', THRESHOLD)).toEqual({
      kind: 'found',
      pr: 4255,
      mergedAt: AFTER,
    });
  });

  it('TWO qualifying candidates is ambiguous — refuses to guess', () => {
    const out = JSON.stringify([
      {
        number: 4255,
        headRefName: 'batch/x',
        baseRefName: 'main',
        isCrossRepository: false,
        mergedAt: AFTER,
        createdAt: AFTER,
      },
      {
        number: 4260,
        headRefName: 'batch/x',
        baseRefName: 'main',
        isCrossRepository: false,
        mergedAt: AFTER,
        createdAt: AFTER,
      },
    ]);
    expect(parseMergedPrListJson(out, 'batch/x', 'main', THRESHOLD)).toEqual({
      kind: 'ambiguous',
      matches: [4255, 4260],
    });
  });

  it("accepts gh's single-key wrapper shape as well as a bare array (#496)", () => {
    const wrapped = JSON.stringify({
      pullRequests: [
        {
          number: 4255,
          headRefName: 'batch/x',
          baseRefName: 'main',
          isCrossRepository: false,
          mergedAt: AFTER,
          createdAt: AFTER,
        },
      ],
    });
    expect(parseMergedPrListJson(wrapped, 'batch/x', 'main', THRESHOLD)).toEqual({
      kind: 'found',
      pr: 4255,
      mergedAt: AFTER,
    });
  });
});

describe('createExecGroundTruth.mergedPrForBranch (#789)', () => {
  it('no mergedPrForBranch without a verified repo — never the cwd repo', () => {
    expect(createExecGroundTruth(() => '[]').mergedPrForBranch).toBeUndefined();
    expect(
      createExecGroundTruth(() => '[]', { repo: '--repo=evil' }).mergedPrForBranch
    ).toBeUndefined();
  });

  it('pins the repo with -R and passes --head/--base/--state merged', () => {
    const calls: string[][] = [];
    const exec: ExecFn = (_file, args) => {
      calls.push(args);
      return '[]';
    };
    const gt = createExecGroundTruth(exec, { repo: 'imboard-ai/imboard' });
    expect(gt.mergedPrForBranch?.('batch/b-1-20260913', 'main', '2026-09-13T00:00:00Z')).toEqual({
      kind: 'none',
    });
    expect(calls[0]).toContain('-R');
    expect(calls[0]).toContain('imboard-ai/imboard');
    expect(calls[0]).toContain('--head');
    expect(calls[0]).toContain('batch/b-1-20260913');
    expect(calls[0]).toContain('--base');
    expect(calls[0]).toContain('main');
    expect(calls[0]).toContain('--state');
    expect(calls[0]).toContain('merged');
  });

  it('a failed gh call is unreachable', () => {
    const failing: ExecFn = () => null;
    const gt = createExecGroundTruth(failing, { repo: 'imboard-ai/imboard' });
    expect(gt.mergedPrForBranch?.('batch/x', 'main', '2026-09-13T00:00:00Z')).toBeUndefined();
  });

  it('rejects crafted branch/base names (CWE-88) before any subprocess runs', () => {
    const calls: string[][] = [];
    const exec: ExecFn = (_file, args) => {
      calls.push(args);
      return '[]';
    };
    const gt = createExecGroundTruth(exec, { repo: 'imboard-ai/imboard' });
    expect(
      gt.mergedPrForBranch?.('--upload-pack=evil', 'main', '2026-09-13T00:00:00Z')
    ).toBeUndefined();
    expect(
      gt.mergedPrForBranch?.('batch/x', '--upload-pack=evil', '2026-09-13T00:00:00Z')
    ).toBeUndefined();
    expect(calls).toHaveLength(0);
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

describe('parseMilestoneListJson (#622 — the milestones one dispatch posted)', () => {
  const row = (phase: string, status: string, at: string, mode = 'slot') => ({
    phase,
    status,
    run: 'r-596-a39e',
    at,
    mode,
  });

  it('parses the runstate list --json array, oldest first', () => {
    const out = parseMilestoneListJson(
      JSON.stringify([
        row('plan', 'done', '2026-09-06T12:42:30Z'),
        row('review', 'done', '2026-09-06T12:52:37Z'),
        row('implement', 'done', '2026-09-06T12:52:52Z'),
      ])
    );
    expect(out).toHaveLength(3);
    expect(out?.[1]?.phase).toBe('review');
    expect(out?.[1]?.keys.mode).toBe('slot');
  });

  it('skips a malformed element rather than losing the whole read', () => {
    // Losing a well-formed terminal milestone to a malformed neighbour is
    // exactly the failure this call exists to prevent.
    const out = parseMilestoneListJson(
      JSON.stringify([{ nonsense: true }, row('review', 'done', '2026-09-06T12:52:37Z')])
    );
    expect(out).toHaveLength(1);
    expect(out?.[0]?.phase).toBe('review');
  });

  it('is tri-state: null stdout is unreachable, empty is verifiably none', () => {
    expect(parseMilestoneListJson(null)).toBeUndefined();
    expect(parseMilestoneListJson('')).toEqual([]);
    expect(parseMilestoneListJson('[]')).toEqual([]);
    expect(parseMilestoneListJson('not json')).toBeUndefined();
    expect(parseMilestoneListJson('{"phase":"review"}')).toBeUndefined(); // object, not array
  });

  it("#622: the real trail — a catch-up milestone buries the dispatch's completion", () => {
    // #596's member, verbatim. `review/done` is complete and fresh; the
    // `implement/done` posted 15s later is what `latestMilestone` returns,
    // and reading only that evicted a member with pushed, conformant work.
    const window = parseMilestoneListJson(
      JSON.stringify([
        row('plan', 'done', '2026-09-06T12:42:30Z'),
        row('review', 'done', '2026-09-06T12:52:37Z'),
        row('implement', 'done', '2026-09-06T12:52:52Z'),
      ])
    );
    const spawnedAt = '2026-09-06T12:40:00Z';
    const newest = window?.[window.length - 1];
    expect(isMemberComplete(newest ?? null, spawnedAt)).toBe(false); // the bug

    const lastTerminal = [...(window ?? [])]
      .reverse()
      .find((m) => isMemberComplete(m, spawnedAt) || isMemberBlocked(m, spawnedAt));
    expect(lastTerminal?.phase).toBe('review'); // the fix
    expect(isMemberComplete(lastTerminal ?? null, spawnedAt)).toBe(true);
  });

  it("#622 keeps #605's fence: a PREVIOUS run's terminal milestone is out of the window", () => {
    const spawnedAt = '2026-09-06T12:40:00Z';
    const stale = row('review', 'done', '2026-09-06T08:15:56Z');
    expect(
      isMemberComplete(parseMilestoneListJson(JSON.stringify([stale]))?.[0] ?? null, spawnedAt)
    ).toBe(false);
  });
});

describe('parseIssueCloseTruthJson (#768)', () => {
  const wrap = (issue: unknown) => JSON.stringify({ data: { repository: { issue } } });

  it('reads a PR closer (imboard#4147 shape)', () => {
    expect(
      parseIssueCloseTruthJson(
        wrap({
          state: 'CLOSED',
          stateReason: 'COMPLETED',
          labels: { nodes: [{ name: 'cycle:slot' }] },
          timelineItems: {
            nodes: [
              {
                closer: {
                  __typename: 'PullRequest',
                  number: 4256,
                  merged: true,
                  baseRefName: 'main',
                  repository: { nameWithOwner: 'imboard-ai/imboard' },
                },
              },
            ],
          },
        })
      )
    ).toEqual({
      state: 'CLOSED',
      stateReason: 'COMPLETED',
      labels: ['cycle:slot'],
      closer: {
        kind: 'pr',
        number: 4256,
        merged: true,
        baseRefName: 'main',
        repo: 'imboard-ai/imboard',
      },
      closingPrs: [],
    });
  });

  it('reads closing references (imboard#4116: merged #4255, closed by hand)', () => {
    expect(
      parseIssueCloseTruthJson(
        wrap({
          state: 'CLOSED',
          stateReason: 'COMPLETED',
          closedByPullRequestsReferences: {
            nodes: [
              {
                number: 4255,
                merged: true,
                baseRefName: 'main',
                repository: { nameWithOwner: 'imboard-ai/imboard-monorepo' },
              },
            ],
          },
          timelineItems: { nodes: [{ closer: null }] },
        })
      )
    ).toMatchObject({
      closer: null,
      closingPrs: [
        { number: 4255, merged: true, baseRefName: 'main', repo: 'imboard-ai/imboard-monorepo' },
      ],
    });
  });

  it('reads a commit closer (imboard#4146 shape) and a null closer (imboard#4116 shape)', () => {
    const oid = '628c6fad676c46cad0c701c07dfd8fad40a9f39c';
    expect(
      parseIssueCloseTruthJson(
        wrap({
          state: 'CLOSED',
          stateReason: 'COMPLETED',
          labels: { nodes: [] },
          timelineItems: { nodes: [{ closer: { __typename: 'Commit', oid } }] },
        })
      )?.closer
    ).toEqual({ kind: 'commit', oid });
    expect(
      parseIssueCloseTruthJson(
        wrap({
          state: 'CLOSED',
          stateReason: 'COMPLETED',
          timelineItems: { nodes: [{ closer: null }] },
        })
      )?.closer
    ).toBeNull();
  });

  it('keeps NOT_PLANNED distinct from COMPLETED, and an open issue as OPEN', () => {
    expect(
      parseIssueCloseTruthJson(wrap({ state: 'CLOSED', stateReason: 'NOT_PLANNED' }))?.stateReason
    ).toBe('NOT_PLANNED');
    expect(parseIssueCloseTruthJson(wrap({ state: 'OPEN', stateReason: null }))?.state).toBe(
      'OPEN'
    );
  });

  it('an unusable payload is unreachable (undefined), never a verified state', () => {
    expect(parseIssueCloseTruthJson(null)).toBeUndefined();
    expect(parseIssueCloseTruthJson('')).toBeUndefined();
    expect(parseIssueCloseTruthJson('not json')).toBeUndefined();
    expect(
      parseIssueCloseTruthJson(JSON.stringify({ data: { repository: { issue: null } } }))
    ).toBeUndefined();
    expect(parseIssueCloseTruthJson(wrap({ state: 'MERGED' }))).toBeUndefined();
  });

  it('more labels than one page is unreachable — the hand-back label could be on the next page', () => {
    expect(
      parseIssueCloseTruthJson(
        wrap({
          state: 'CLOSED',
          stateReason: 'COMPLETED',
          labels: { pageInfo: { hasNextPage: true }, nodes: [{ name: 'a' }] },
        })
      )
    ).toBeUndefined();
  });

  it('createExecGroundTruth: no issueCloseTruth without a verified repo — never the cwd repo', () => {
    expect(createExecGroundTruth(() => '{}').issueCloseTruth).toBeUndefined();
    expect(
      createExecGroundTruth(() => '{}', { repo: '--repo=evil' }).issueCloseTruth
    ).toBeUndefined();
  });

  it('createExecGroundTruth.issueCloseTruth names the repo explicitly, and a failed gh call is unreachable', () => {
    const calls: string[][] = [];
    const exec: ExecFn = (_file, args) => {
      calls.push(args);
      return null;
    };
    const gt = createExecGroundTruth(exec, { repo: 'imboard-ai/imboard' });
    expect(gt.issueCloseTruth?.(4146)).toBeUndefined(); // the repo probe failed too
    expect(calls[0]).toContain('owner=imboard-ai');
    expect(calls[0]).toContain('name=imboard');
    expect(calls[0].join(' ')).not.toContain('{owner}');
  });
});

describe('issueCloseTruth: a missing issue is not an outage (#768)', () => {
  it('reads MISSING when the issue read fails but the repository answers', () => {
    const exec: ExecFn = (_file, args) =>
      args[0] === 'api' && args[1] === 'graphql' ? null : 'imboard-ai/imboard';
    const gt = createExecGroundTruth(exec, { repo: 'imboard-ai/imboard' });
    expect(gt.issueCloseTruth?.(99999)?.state).toBe('MISSING');
  });
});
