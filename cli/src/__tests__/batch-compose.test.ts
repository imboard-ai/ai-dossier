import { describe, expect, it } from 'vitest';
import {
  type AssessedIssue,
  assessIssue,
  type ComposeIssueInput,
  type ComposeOptions,
  composeBatch,
  inferPackages,
  matchDataMutation,
  notAUnitReason,
  workspaceOf,
} from '../batch-compose';

function input(overrides: Partial<ComposeIssueInput> = {}): ComposeIssueInput {
  return {
    issue: 1,
    source: 'pick',
    title: 'fix: a small bug',
    body: 'Touches `packages/sched/src/status.ts`.',
    labels: [],
    state: 'OPEN',
    assignees: [],
    latestPhase: null,
    schedStatus: null,
    openDependencies: [],
    ...overrides,
  };
}

const OPTS: ComposeOptions = {
  rules: 'v2',
  baseBranch: 'main',
  minMembers: 3,
  maxMembers: 6,
  maxFullReview: 2,
  picksMode: true,
};

function assessed(
  issue: number,
  over: Partial<AssessedIssue> & { review?: 'light' | 'full' } = {}
): AssessedIssue {
  return {
    issue,
    source: 'pick',
    title: `issue ${issue}`,
    admissible: true,
    review: 'light',
    packages: [],
    prescreen: [],
    excluded: [],
    ...over,
  };
}

describe('assessIssue — readiness', () => {
  it('a clean open issue is admissible at review=light', () => {
    const a = assessIssue(input());
    expect(a.admissible).toBe(true);
    expect(a.review).toBe('light');
    expect(a.excluded).toEqual([]);
    expect(a.packages).toEqual(['packages/sched']);
  });

  it.each([
    ['closed', { state: 'CLOSED' }],
    ['assigned', { assignees: ['someone'] }],
    ['in-progress', { labels: ['in-progress'] }],
    ['hard-block-label', { labels: ['decision-pending'] }],
    ['batch-anchor', { labels: ['batch-epic'] }],
    ['in-flight', { latestPhase: 'implement' }],
    ['sched-active', { schedStatus: 'queued' }],
    ['open-dependency', { openDependencies: [99] }],
    ['not-a-unit', { labels: ['tracker'] }],
    ['data-mutation', { body: 'Write a one-off script to repair rows.' }],
  ] as const)('%s excludes', (code, over) => {
    const a = assessIssue(input(over as Partial<ComposeIssueInput>));
    expect(a.admissible).toBe(false);
    expect(a.excluded.map((e) => e.code)).toContain(code);
  });

  it('records every exclusion reason, not just the first', () => {
    const a = assessIssue(input({ state: 'CLOSED', assignees: ['x'], labels: ['in-progress'] }));
    expect(a.excluded.map((e) => e.code)).toEqual(['closed', 'assigned', 'in-progress']);
  });

  it('a classify-only runstate trail is NOT in flight (the classifier record is pre-dispatch)', () => {
    expect(assessIssue(input({ latestPhase: 'classify' })).admissible).toBe(true);
  });

  it('an unreadable issue is excluded as unreadable and never claimed light', () => {
    const a = assessIssue(input({ error: 'gh is not authenticated' }));
    expect(a.admissible).toBe(false);
    expect(a.review).toBe('full');
    expect(a.excluded).toEqual([{ code: 'unreadable', message: 'gh is not authenticated' }]);
  });

  it('a plan:v1 artifact over the file-count floor is an admissible review=full member (#818)', () => {
    const files = Array.from({ length: 9 }, (_, i) => `cli/src/f${i}.ts`);
    const a = assessIssue(input({ predictedFiles: files }));
    expect(a.admissible).toBe(true);
    expect(a.excluded).toEqual([]);
    expect(a.review).toBe('full');
    expect(a.prescreen).toEqual([expect.objectContaining({ check: 'file-count' })]);
    expect(a.packages).toEqual(['cli']);
  });
});

describe('#805: a plan:v1 risk-floor path is a review=full member, not an exclusion (prescreen:v3+)', () => {
  // imboard#4343's shape: batch-prep admitted it on the `billing` keyword and posted a plan:v1
  // artifact predicting a billing job; a later compose re-run must still admit it.
  const riskPath = ['packages/backend/src/billing/billing-sync.job.ts'];

  it('assessIssue admits it with review=full and records the path-floor reason', () => {
    const a = assessIssue(input({ predictedFiles: riskPath }));
    expect(a.admissible).toBe(true);
    expect(a.excluded).toEqual([]);
    expect(a.review).toBe('full');
    expect(a.prescreen).toEqual([expect.objectContaining({ check: 'path-floor' })]);
  });

  it('batch compose admits it as a review=full member', () => {
    const risky = assessIssue(input({ issue: 4343, predictedFiles: riskPath }));
    const r = composeBatch([risky, assessed(2), assessed(3)], OPTS);
    expect(r.members).toContainEqual(expect.objectContaining({ issue: 4343, review: 'full' }));
  });

  it('--rules legacy still excludes a plan:v1 risk-floor path (pre-#770 admission)', () => {
    const a = assessIssue(input({ predictedFiles: riskPath }), 'legacy');
    expect(a.admissible).toBe(false);
    expect(a.excluded.map((e) => e.code)).toEqual(['prescreen-full']);
  });

  it('>8 predicted files with a risk-floor path among them is still one review=full member (#818)', () => {
    const files = [...riskPath, ...Array.from({ length: 8 }, (_, i) => `cli/src/f${i}.ts`)];
    const a = assessIssue(input({ predictedFiles: files }));
    expect(a.admissible).toBe(true);
    expect(a.review).toBe('full');
    expect(a.prescreen.map((r) => r.check)).toEqual(['path-floor', 'file-count']);
  });
});

describe('#818: E.2 rules 4 (deploy pipeline) and 5 (>8 files) are review=full members (prescreen:v4)', () => {
  const nine = Array.from({ length: 9 }, (_, i) => `packages/backend/src/f${i}.ts`);
  const deploy = {
    title: 'fix(ci): deploy job skips the smoke gate after a build-once promote',
    body: 'The deploy workflow in `packages/backend/fly.toml` promotes the image unchecked.',
  };

  it('a deploy-pipeline issue (imboard#4136 shape) is admitted at review=full', () => {
    const a = assessIssue(input(deploy));
    expect(a).toMatchObject({ admissible: true, review: 'full', excluded: [] });
  });

  it('a 9-file plan (imboard#4239 shape) is admitted at review=full', () => {
    const a = assessIssue(input({ predictedFiles: nine }));
    expect(a).toMatchObject({ admissible: true, review: 'full', excluded: [] });
  });

  it('--rules legacy still excludes both (pre-#770 admission)', () => {
    const files = assessIssue(input({ predictedFiles: nine }), 'legacy');
    expect(files.admissible).toBe(false);
    expect(files.excluded.map((e) => e.code)).toEqual(['prescreen-full']);
    expect(files.excluded[0]?.message).toContain('rule5-file-count');
    expect(files.excluded[0]?.message).toContain('Legacy rules');
    const pipeline = assessIssue(input(deploy), 'legacy');
    expect(pipeline.admissible).toBe(false);
    expect(pipeline.excluded.map((e) => e.code)).toEqual(['legacy-full']);
  });

  it('compose over 4 rule-4/5 picks + 1 light pick forms one batch with ≤ 2 review=full (the rest held)', () => {
    // The #770 validation-run-#2 set: #4239 (9 files), #4355 (10 files), #4136/#3549 (deploy), #4216 light.
    const ten = Array.from({ length: 10 }, (_, i) => `packages/backend/src/g${i}.ts`);
    const picks = [
      assessIssue(input({ issue: 4239, predictedFiles: nine })),
      assessIssue(input({ issue: 4355, predictedFiles: ten })),
      assessIssue(input({ issue: 4136, ...deploy })),
      assessIssue(input({ issue: 3549, title: 'fix: rollback pipeline skips migrations check' })),
      assessIssue(input({ issue: 4216 })),
    ];
    expect(picks.every((a) => a.admissible)).toBe(true);
    const r = composeBatch(picks, OPTS);
    expect(r.members.filter((m) => m.review === 'full')).toHaveLength(2);
    expect(r.members.map((m) => m.issue)).toContain(4216);
    expect(r.held).toHaveLength(2);
    expect(r.held.every((h) => h.reason === 'review-full-cap')).toBe(true);
  });
});

describe('assessIssue — review level (#770 Option A, prescreen:v4)', () => {
  it('a risk keyword in scope makes the issue an admissible review=full member, not an exclusion', () => {
    const a = assessIssue(input({ title: 'fix: billing sweep window arithmetic' }));
    expect(a.admissible).toBe(true);
    expect(a.review).toBe('full');
    expect(a.prescreen).toEqual([expect.objectContaining({ check: 'text-floor' })]);
  });

  it('a risk keyword only in provenance stays review=light (#772 section-aware floor)', () => {
    const a = assessIssue(
      input({ body: 'Found by the #4103 security review. Tidy the cascade helper.' })
    );
    expect(a.review).toBe('light');
    expect(a.admissible).toBe(true);
  });

  it('legacy rules exclude on ANY keyword, provenance included (pre-#770 behaviour)', () => {
    const a = assessIssue(
      input({ body: 'Found by the #4103 security review. Tidy the cascade helper.' }),
      'legacy'
    );
    expect(a.admissible).toBe(false);
    expect(a.excluded.map((e) => e.code)).toEqual(['legacy-full']);
  });
});

describe('matchDataMutation / notAUnitReason', () => {
  it('matches action phrases, including hyphenated label spellings', () => {
    expect(matchDataMutation('ship a data backfill for old boards')).toBe('data backfill');
    expect(matchDataMutation('labels: data-migration')).toBe('data migration');
  });

  it('does not match batch vocabulary or places an issue merely mentions', () => {
    expect(matchDataMutation('list ranked backfill candidates from the backlog')).toBeNull();
    expect(matchDataMutation('the IAM user can read production data')).toBeNull();
  });

  it('flags trackers, decisions, research and parked items', () => {
    expect(notAUnitReason('[PARKED] feat: x', '', [])).not.toBeNull();
    expect(notAUnitReason('research: KG audit', '', [])).not.toBeNull();
    expect(notAUnitReason('epic(meetings): voting', '', [])).not.toBeNull();
    expect(notAUnitReason('fix: y', '## Decision needed\n| A | B |', [])).not.toBeNull();
    expect(notAUnitReason('fix: y', 'body', ['question'])).not.toBeNull();
    expect(notAUnitReason('fix(research-tool): y', 'plain body', [])).toBeNull();
  });
});

describe('package inference', () => {
  it('maps paths to their workspace package, including a nested repo root', () => {
    expect(workspaceOf('main/packages/backend/src/jobs/x.ts')).toBe('packages/backend');
    expect(workspaceOf('cli/src/cli.ts')).toBe('cli');
    expect(workspaceOf('package.json')).toBeNull();
  });

  it('reads backticked paths from the body but ignores prose slashes and URLs', () => {
    const body = [
      'Edit `packages/sched/src/status.ts` and cli/src/commands/batch.ts.',
      'Status goes active/disabled/pending and/or ci/cd.',
      'See https://github.com/org/repo/blob/main/registry/api.ts',
    ].join('\n');
    expect(inferPackages(body)).toEqual(['cli', 'packages/sched']);
  });

  it('prefers plan:v1 predicted files over the body', () => {
    expect(inferPackages('touches `cli/src/x.ts`', ['packages/core/src/y.ts'])).toEqual([
      'packages/core',
    ]);
  });

  it('ignores paths in reference sections', () => {
    expect(inferPackages('## Related\n- `registry/api/x.ts`\n## Fix\n`cli/src/a.ts`')).toEqual([
      'cli',
    ]);
  });
});

describe('composeBatch', () => {
  it('admits every pick within the caps and reports ok at min_members', () => {
    const r = composeBatch([assessed(1), assessed(2), assessed(3)], OPTS);
    expect(r.status).toBe('ok');
    expect(r.members.map((m) => m.issue)).toEqual([1, 2, 3]);
    expect(r.held).toEqual([]);
  });

  it('caps review=full members at max_full_review (#771 ≤ 2) and holds the overflow', () => {
    const r = composeBatch(
      [
        assessed(1, { review: 'full' }),
        assessed(2, { review: 'full' }),
        assessed(3, { review: 'full' }),
        assessed(4),
      ],
      OPTS
    );
    expect(r.members.filter((m) => m.review === 'full')).toHaveLength(2);
    expect(r.members.map((m) => m.issue).sort()).toEqual([1, 2, 4]);
    expect(r.held).toEqual([expect.objectContaining({ issue: 3, reason: 'review-full-cap' })]);
  });

  it('never exceeds max_members', () => {
    const picks = Array.from({ length: 8 }, (_, i) => assessed(i + 1));
    const r = composeBatch(picks, OPTS);
    expect(r.members).toHaveLength(6);
    expect(r.held.map((h) => h.reason)).toEqual(['max-members', 'max-members']);
  });

  it('backfills short picks from the backlog, preferring a shared package, then light', () => {
    const r = composeBatch(
      [
        assessed(10, { packages: ['packages/sched'] }),
        assessed(11, { packages: ['packages/sched'] }),
        assessed(20, { source: 'backlog', packages: ['registry'] }),
        assessed(21, { source: 'backlog', packages: ['packages/sched'], review: 'full' }),
        assessed(22, { source: 'backlog', packages: ['packages/sched'] }),
      ],
      OPTS
    );
    expect(r.status).toBe('ok');
    expect(r.members.map((m) => [m.issue, m.source])).toEqual([
      [10, 'pick'],
      [11, 'pick'],
      [22, 'backfill'],
    ]);
    expect(r.backfill.map((b) => [b.rank, b.issue, b.selected])).toEqual([
      [1, 22, true],
      [2, 21, false],
      [3, 20, false],
    ]);
    expect(r.shared_packages).toEqual(['packages/sched']);
  });

  it('does not backfill a review=full candidate past the cap', () => {
    const r = composeBatch(
      [
        assessed(1, { review: 'full' }),
        assessed(2, { review: 'full' }),
        assessed(20, { source: 'backlog', review: 'full' }),
      ],
      OPTS
    );
    expect(r.members.map((m) => m.issue)).toEqual([1, 2]);
    expect(r.status).toBe('under-min');
  });

  it('one survivor is no-batch with a full-cycle recommendation (#770 P4)', () => {
    const r = composeBatch([assessed(7), assessed(8, { admissible: false })], OPTS);
    expect(r.status).toBe('no-batch');
    expect(r.recommendation).toContain('#7');
  });

  it('backlog-only mode fills to max_members, seeded from the largest package cluster', () => {
    const backlog = [
      assessed(1, { source: 'backlog', packages: ['cli'] }),
      assessed(2, { source: 'backlog', packages: ['registry'] }),
      assessed(3, { source: 'backlog', packages: ['registry'] }),
    ];
    const r = composeBatch(backlog, { ...OPTS, picksMode: false, maxMembers: 2, minMembers: 2 });
    expect(r.members.map((m) => [m.issue, m.source])).toEqual([
      [2, 'backlog'],
      [3, 'backlog'],
    ]);
    expect(r.held).toEqual([expect.objectContaining({ issue: 1, reason: 'max-members' })]);
    expect(r.backfill).toEqual([]);
  });

  it('is deterministic — same input, same output', () => {
    const set = [
      assessed(5, { packages: ['cli'] }),
      assessed(3, { source: 'backlog', packages: ['cli'] }),
      assessed(4, { source: 'backlog', packages: ['cli'] }),
    ];
    expect(composeBatch(set, OPTS)).toEqual(composeBatch([...set].reverse(), OPTS));
  });
});

/**
 * #773 AC1 — the 2026-09-24 imboard pick set (#4114, #4178, #4327, #4333, #4343), paraphrased
 * to the shape that decided each verdict (the real bodies live in a private repo): #4114 names
 * "security" only in its provenance line, #4327/#4343 are genuinely billing-adjacent, #4178 and
 * #4333 carry no risk keyword. State as of selection time: all open, unassigned, unclaimed.
 */
const PICKS_2026_09_24: ComposeIssueInput[] = [
  input({
    issue: 4114,
    title: 'chore: guest-board and example-pool cleanup are partial cascades',
    body: 'Found by the #4103 security review. Not a live vulnerability.\n\nRoute `main/packages/backend/src/services/cleanup.service.ts` through the full purge.',
  }),
  input({
    issue: 4178,
    title: 'bug(meetings): committee meeting PATCH writes meetingStatus with no re-arm',
    body: 'Fix `main/packages/backend/src/routes/v1/meetings.ts`.',
  }),
  input({
    issue: 4327,
    title: 'Billing reminder/sweep query windows use local setDate() arithmetic',
    body: 'Fix `main/packages/backend/src/jobs/billing-trial-reminders.job.ts`.',
  }),
  input({
    issue: 4333,
    title: 'Meta Conversions API Purchase event returns 400',
    body: 'Log the response body in `main/packages/backend/src/services/meta-capi.ts`.',
  }),
  input({
    issue: 4343,
    title: 'Guardrail: steer duration date-arithmetic to addDaysUtc',
    body: 'The billing sweep-job windows in `main/packages/backend/src/jobs/billing-grace-period.job.ts` still use setDate().',
  }),
];

describe('#773 AC1 — the 2026-09-24 imboard picks', () => {
  it('legacy rules reproduce the keyword collapse: 3 of 5 excluded, no viable batch', () => {
    const r = composeBatch(
      PICKS_2026_09_24.map((i) => assessIssue(i, 'legacy')),
      { ...OPTS, rules: 'legacy' }
    );
    expect(r.members.map((m) => m.issue)).toEqual([4178, 4333]);
    expect(r.status).toBe('under-min');
    // #4333 was additionally dropped by the model classifier's uncertainty rule (#770 table),
    // which no deterministic rule reproduces — leaving the observed 1-member batch.
  });

  it('P1/P2 rules admit all five as one ≥ 3-member batch with ≤ 2 review=full members', () => {
    const r = composeBatch(
      PICKS_2026_09_24.map((i) => assessIssue(i, 'v2')),
      OPTS
    );
    expect(r.status).toBe('ok');
    expect(r.members.length).toBeGreaterThanOrEqual(3);
    expect(r.members.map((m) => m.issue).sort()).toEqual([4114, 4178, 4327, 4333, 4343]);
    expect(r.members.filter((m) => m.review === 'full').map((m) => m.issue)).toEqual([4327, 4343]);
    expect(r.shared_packages).toEqual(['packages/backend']);
  });
});
