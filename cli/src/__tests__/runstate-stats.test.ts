import { describe, expect, it } from 'vitest';
import { buildMilestone, nowStamp, parseMilestones, RUNSTATE_MARKER } from '../runstate';
import {
  BATCH_MERGE_WAIT_PHASE,
  buildStatsReport,
  canonicalModel,
  type IssueTrail,
  isUsableTimestamp,
  MERGE_WAIT_PHASE,
  median,
  renderValue,
  STATS_PHASE_ORDER,
  skewNote,
  UNKNOWN_MODEL,
  UNKNOWN_RUN,
} from '../runstate-stats';

/**
 * One milestone comment body, built by the same function `runstate post` uses — so a
 * fixture cannot drift from the wire format it is supposed to represent.
 */
function milestone(
  phase: string,
  status: string,
  run: string,
  at: string,
  keys: Record<string, string> = {}
): string {
  return buildMilestone({ phase, status, run, at, keys: Object.entries(keys), next: 'done' });
}

/** Turn comment bodies into the trail shape `buildStatsReport` consumes. */
function trail(issue: number, bodies: string[]): IssueTrail {
  return { issue, milestones: parseMilestones(bodies) };
}

/** Build a report from one issue's bodies — the shape most cases here need. */
function reportFor(issue: number, bodies: string[]) {
  return buildStatsReport({ trails: [trail(issue, bodies)] });
}

/**
 * A complete, well-formed run: all seven phases plus ship's second milestone.
 *
 * Shaped after the real trail on `imboard-ai/ai-dossier#440` — same phase sequence, same
 * two-ship-milestone ending — with round timestamps so the expected durations are
 * checkable by eye rather than by re-deriving the arithmetic under test.
 */
const CLEAN_TRAIL = [
  milestone('gate', 'done', 'r-440-ab56', '2026-08-24T10:00:00Z', {
    base_branch: 'main',
    model: 'claude-opus-5',
  }),
  milestone('setup', 'done', 'r-440-ab56', '2026-08-24T10:02:00Z', { branch: 'feature/440-x' }),
  milestone('plan', 'done', 'r-440-ab56', '2026-08-24T10:07:00Z', { open_questions: '0' }),
  milestone('implement', 'done', 'r-440-ab56', '2026-08-24T10:37:00Z', { files: '7' }),
  milestone('review', 'done', 'r-440-ab56', '2026-08-24T11:07:00Z', { fixed: '36' }),
  milestone('ship', 'awaiting-merge', 'r-440-ab56', '2026-08-24T11:09:00Z', { pr: '445' }),
  milestone('ship', 'done', 'r-440-ab56', '2026-08-24T11:24:00Z', { merge_commit: 'c4a6231' }),
  milestone('report', 'done', 'r-440-ab56', '2026-08-24T11:25:00Z', { pr: '445' }),
];

describe('isUsableTimestamp', () => {
  it('accepts the format runstate post stamps', () => {
    expect(isUsableTimestamp('2026-08-24T10:00:00Z')).toBe(true);
  });

  it('accepts fractional seconds and explicit offsets', () => {
    expect(isUsableTimestamp('2026-08-24T10:00:00.123Z')).toBe(true);
    expect(isUsableTimestamp('2026-08-24T10:00:00+02:00')).toBe(true);
  });

  it('rejects an unexpanded shell substitution in either form', () => {
    expect(isUsableTimestamp('$(date -u +%Y-%m-%dT%H:%M:%SZ)')).toBe(false);
    expect(isUsableTimestamp('`date -u`')).toBe(false);
  });

  it('rejects an empty value, a date without a time, and prose', () => {
    expect(isUsableTimestamp('')).toBe(false);
    expect(isUsableTimestamp('2026-08-24')).toBe(false);
    expect(isUsableTimestamp('just now')).toBe(false);
  });

  it('rejects a well-shaped but impossible date', () => {
    expect(isUsableTimestamp('2026-13-45T99:00:00Z')).toBe(false);
  });
});

describe('median', () => {
  it('takes the middle value of an odd-length list', () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it('averages the two middle values of an even-length list', () => {
    expect(median([1, 2, 4, 5])).toBe(3);
  });

  it('rounds a fractional average to whole seconds', () => {
    expect(median([1, 2])).toBe(2);
  });

  it('handles a single sample', () => {
    expect(median([42])).toBe(42);
  });

  it('does not mutate its input', () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });

  it('refuses an empty list rather than returning NaN', () => {
    // NaN would render as a plausible-looking `NaN (NaNs)` cell instead of announcing itself.
    expect(() => median([])).toThrow(/at least one sample/);
  });
});

describe('renderValue', () => {
  it('leaves ordinary text alone', () => {
    expect(renderValue('claude-opus-5')).toBe('claude-opus-5');
  });

  it('replaces ANSI escapes so a forged milestone cannot repaint the table', () => {
    expect(renderValue('[31mgate')).toBe('�[31mgate');
  });

  it('replaces a carriage return so a forged milestone cannot overwrite a row', () => {
    expect(renderValue('claude\rSPOOFED')).toBe('claude�SPOOFED');
  });

  it('replaces DEL and other control characters', () => {
    expect(renderValue('a\x7fb\x00c')).toBe('a�b�c');
  });

  it('truncates a value too long to belong in a cell', () => {
    const out = renderValue('x'.repeat(500));
    expect(out).toHaveLength(121);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('skewNote', () => {
  it('is silent when every sample ran forwards', () => {
    expect(skewNote(0)).toBeNull();
  });

  it('names how many samples were backwards', () => {
    expect(skewNote(2)).toBe('2 skewed');
  });
});

describe('buildStatsReport — AC1: one clean trail', () => {
  const report = reportFor(440, CLEAN_TRAIL);
  const run = report.runs[0];

  it('produces one run', () => {
    expect(report.runs).toHaveLength(1);
    expect(run.run).toBe('r-440-ab56');
    expect(run.issue).toBe(440);
  });

  it('emits one row per milestone', () => {
    expect(run.phases).toHaveLength(CLEAN_TRAIL.length);
  });

  it('leaves the first phase without a measurable start', () => {
    expect(run.phases[0]).toMatchObject({
      phase: 'gate',
      status: 'done',
      started_at: null,
      ended_at: '2026-08-24T10:00:00Z',
      seconds: null,
    });
  });

  it("starts each phase at the previous milestone's at=", () => {
    expect(run.phases[1]).toMatchObject({
      phase: 'setup',
      started_at: '2026-08-24T10:00:00Z',
      ended_at: '2026-08-24T10:02:00Z',
      seconds: 120,
    });
    expect(run.phases[2]).toMatchObject({ phase: 'plan', seconds: 300 });
    expect(run.phases[3]).toMatchObject({ phase: 'implement', seconds: 1800 });
    expect(run.phases[4]).toMatchObject({ phase: 'review', seconds: 1800 });
  });

  it("reports ship's awaiting-merge → done gap as merge-wait", () => {
    expect(run.phases[5]).toMatchObject({
      phase: 'ship',
      status: 'awaiting-merge',
      seconds: 120,
    });
    expect(run.phases[6]).toMatchObject({
      phase: MERGE_WAIT_PHASE,
      status: 'done',
      started_at: '2026-08-24T11:09:00Z',
      ended_at: '2026-08-24T11:24:00Z',
      seconds: 900,
    });
    expect(run.phases[7]).toMatchObject({ phase: 'report', seconds: 60 });
  });

  it('totals the run from its first to its last milestone', () => {
    expect(run.started_at).toBe('2026-08-24T10:00:00Z');
    expect(run.ended_at).toBe('2026-08-24T11:25:00Z');
    expect(run.total_seconds).toBe(5100);
  });

  it('records how far the run got', () => {
    expect(run.last_phase).toBe('report');
    expect(run.last_status).toBe('done');
  });

  it('reads model= off the gate milestone', () => {
    expect(run.model).toBe('claude-opus-5');
  });

  it('warns about nothing on a clean trail', () => {
    expect(report.warnings).toEqual([]);
    expect(report.issues_without_trail).toEqual([]);
    expect(report.issues_failed).toEqual([]);
  });

  it('orders aggregate phase rows by the pipeline, with merge-wait before report', () => {
    expect(report.aggregates.phases.map((p) => p.phase)).toEqual([
      'setup',
      'plan',
      'implement',
      'review',
      'ship',
      MERGE_WAIT_PHASE,
      'report',
    ]);
  });

  it('places merge-wait between ship and report in the canonical order', () => {
    expect(STATS_PHASE_ORDER.indexOf(MERGE_WAIT_PHASE)).toBe(STATS_PHASE_ORDER.indexOf('ship') + 1);
    expect(STATS_PHASE_ORDER.indexOf('report')).toBe(
      STATS_PHASE_ORDER.indexOf(MERGE_WAIT_PHASE) + 1
    );
  });

  it('reports no clock skew', () => {
    expect(report.aggregates.phases.every((p) => p.negative_samples === 0)).toBe(true);
  });
});

describe('buildStatsReport — AC1: multi-run trails', () => {
  /** A first run that blocks at implement, then a second run that completes the issue. */
  const MULTI_RUN = [
    milestone('gate', 'done', 'r-451-aaaa', '2026-08-24T09:00:00Z', { model: 'claude-sonnet-5' }),
    milestone('setup', 'done', 'r-451-aaaa', '2026-08-24T09:05:00Z'),
    milestone('implement', 'blocked', 'r-451-aaaa', '2026-08-24T09:20:00Z', { reason: 'flaky-ci' }),
    milestone('gate', 'done', 'r-451-bbbb', '2026-08-24T12:00:00Z', { model: 'claude-opus-5' }),
    milestone('setup', 'done', 'r-451-bbbb', '2026-08-24T12:02:00Z'),
    milestone('report', 'done', 'r-451-bbbb', '2026-08-24T12:30:00Z'),
  ];

  const report = reportFor(451, MULTI_RUN);

  it('groups milestones per run id', () => {
    expect(report.runs.map((r) => r.run)).toEqual(['r-451-aaaa', 'r-451-bbbb']);
    expect(report.runs[0].phases).toHaveLength(3);
    expect(report.runs[1].phases).toHaveLength(3);
  });

  it("never spans one run's gap into another run's first phase", () => {
    // 12:00 minus 09:20 is 2h40m of nothing; the second run's gate must not report it.
    expect(report.runs[1].phases[0]).toMatchObject({ phase: 'gate', seconds: null });
  });

  it('totals each run independently', () => {
    expect(report.runs[0].total_seconds).toBe(1200);
    expect(report.runs[1].total_seconds).toBe(1800);
  });

  it('keeps a blocked status on its row and in the run summary', () => {
    expect(report.runs[0].phases[2]).toMatchObject({ phase: 'implement', status: 'blocked' });
    expect(report.runs[0].last_phase).toBe('implement');
    expect(report.runs[0].last_status).toBe('blocked');
  });

  it('buckets whole-run totals and outcomes by model', () => {
    expect(report.aggregates.models).toEqual([
      {
        model: 'claude-opus-5',
        aliases: ['claude-opus-5'],
        runs: 1,
        samples: 1,
        median_total_seconds: 1800,
        min_total_seconds: 1800,
        max_total_seconds: 1800,
        negative_samples: 0,
        completed: 1,
        blocked: 0,
        unfinished: 0,
        completion_rate: 1,
      },
      {
        model: 'claude-sonnet-5',
        aliases: ['claude-sonnet-5'],
        runs: 1,
        samples: 1,
        median_total_seconds: 1200,
        min_total_seconds: 1200,
        max_total_seconds: 1200,
        negative_samples: 0,
        completed: 0,
        blocked: 1,
        unfinished: 0,
        completion_rate: 0,
      },
    ]);
  });

  it('re-groups runs whose milestones interleave in comment order', () => {
    const interleaved = reportFor(451, [
      milestone('gate', 'done', 'r-451-aaaa', '2026-08-24T09:00:00Z'),
      milestone('gate', 'done', 'r-451-bbbb', '2026-08-24T09:01:00Z'),
      milestone('setup', 'done', 'r-451-aaaa', '2026-08-24T09:10:00Z'),
      milestone('setup', 'done', 'r-451-bbbb', '2026-08-24T09:02:00Z'),
    ]);

    // Without grouping, r-451-aaaa's setup would be paired with r-451-bbbb's gate.
    expect(interleaved.runs[0].phases[1]).toMatchObject({ phase: 'setup', seconds: 600 });
    expect(interleaved.runs[1].phases[1]).toMatchObject({ phase: 'setup', seconds: 60 });
  });

  it('keeps each run in the order its milestones were appended', () => {
    const report = reportFor(451, [
      milestone('gate', 'done', 'r-451-cccc', '2026-08-24T09:00:00Z'),
      milestone('setup', 'done', 'r-451-cccc', '2026-08-24T09:05:00Z'),
      milestone('plan', 'done', 'r-451-cccc', '2026-08-24T09:06:00Z'),
    ]);
    expect(report.runs[0].phases.map((p) => p.phase)).toEqual(['gate', 'setup', 'plan']);
  });
});

describe('buildStatsReport — AC2: aggregation across issues', () => {
  /**
   * A three-milestone run whose `setup` span is `setupSeconds`, so each issue contributes a
   * different sample to the same phase.
   */
  function runOf(run: string, model: string, setupSeconds: number): string[] {
    const start = Date.parse('2026-08-24T10:00:00Z');
    const at = (offset: number): string => nowStamp(new Date(start + offset * 1000));
    return [
      milestone('gate', 'done', run, at(0), { model }),
      milestone('setup', 'done', run, at(setupSeconds)),
      milestone('plan', 'done', run, at(setupSeconds + 100)),
    ];
  }

  const report = buildStatsReport({
    trails: [
      trail(1, runOf('r-1-aaaa', 'claude-opus-5', 100)),
      trail(2, runOf('r-2-bbbb', 'claude-opus-5', 200)),
      trail(3, runOf('r-3-cccc', 'claude-sonnet-5', 300)),
    ],
  });

  it('lists every requested issue', () => {
    expect(report.issues).toEqual([1, 2, 3]);
  });

  it('reports per-phase median, min, and max across runs', () => {
    expect(report.aggregates.phases.find((p) => p.phase === 'setup')).toEqual({
      phase: 'setup',
      samples: 3,
      median_seconds: 200,
      min_seconds: 100,
      max_seconds: 300,
      negative_samples: 0,
    });
  });

  it('counts only measurable samples per phase', () => {
    // gate is every run's first milestone, so it never has a measurable duration.
    expect(report.aggregates.phases.some((p) => p.phase === 'gate')).toBe(false);
  });

  it('breaks whole-run totals down by model', () => {
    const opus = report.aggregates.models.find((m) => m.model === 'claude-opus-5');
    expect(opus).toMatchObject({ runs: 2, samples: 2, min_total_seconds: 200 });
    expect(opus?.max_total_seconds).toBe(300);
    // Even sample count → the two middle values averaged.
    expect(opus?.median_total_seconds).toBe(250);
  });

  it('buckets runs with no model= under unknown', () => {
    const noModel = reportFor(4, [
      milestone('gate', 'done', 'r-4-dddd', '2026-08-24T10:00:00Z'),
      milestone('setup', 'done', 'r-4-dddd', '2026-08-24T10:01:00Z'),
    ]);
    expect(noModel.runs[0].model).toBeNull();
    expect(noModel.aggregates.models[0]).toMatchObject({ model: UNKNOWN_MODEL, runs: 1 });
  });

  it('falls back to a later milestone when the gate carries no model=', () => {
    const lateModel = reportFor(5, [
      milestone('gate', 'done', 'r-5-eeee', '2026-08-24T10:00:00Z'),
      milestone('setup', 'done', 'r-5-eeee', '2026-08-24T10:01:00Z', {
        model: 'claude-haiku-4-5',
      }),
    ]);
    expect(lateModel.runs[0].model).toBe('claude-haiku-4-5');
  });

  it('prefers the gate milestone over a later one when both carry model=', () => {
    const bothModels = reportFor(6, [
      milestone('gate', 'done', 'r-6-ffff', '2026-08-24T10:00:00Z', { model: 'claude-opus-5' }),
      milestone('setup', 'done', 'r-6-ffff', '2026-08-24T10:01:00Z', { model: 'other-model' }),
    ]);
    expect(bothModels.runs[0].model).toBe('claude-opus-5');
  });

  it('reports a model bucket with no measurable total as having no samples', () => {
    const inFlight = buildStatsReport({
      trails: [
        trail(7, [milestone('gate', 'done', 'r-7-aaaa', '2026-08-24T10:00:00Z', { model: 'm' })]),
      ],
    });
    expect(inFlight.aggregates.models[0]).toMatchObject({
      model: 'm',
      runs: 1,
      samples: 0,
      median_total_seconds: null,
      min_total_seconds: null,
      max_total_seconds: null,
    });
  });
});

describe('buildStatsReport — AC3: imperfect trails', () => {
  it('says so and measures nothing when an issue has no runstate comments', () => {
    const report = reportFor(999, ['just a normal comment', '']);
    expect(report.runs).toEqual([]);
    expect(report.issues_without_trail).toEqual([999]);
    expect(report.warnings).toEqual([]);
  });

  it('measures a trail with phases missing entirely', () => {
    const report = reportFor(7, [
      milestone('gate', 'done', 'r-7-aaaa', '2026-08-24T10:00:00Z'),
      milestone('implement', 'done', 'r-7-aaaa', '2026-08-24T10:30:00Z'),
      milestone('report', 'done', 'r-7-aaaa', '2026-08-24T10:35:00Z'),
    ]);
    expect(report.runs[0].phases.map((p) => p.phase)).toEqual(['gate', 'implement', 'report']);
    expect(report.runs[0].phases[1].seconds).toBe(1800);
  });

  it('keeps partial and blocked statuses on their rows', () => {
    const report = reportFor(8, [
      milestone('review', 'partial', 'r-8-aaaa', '2026-08-24T10:00:00Z'),
      milestone('review', 'done', 'r-8-aaaa', '2026-08-24T10:10:00Z'),
      milestone('ship', 'blocked', 'r-8-aaaa', '2026-08-24T10:20:00Z', { reason: 'ci-red' }),
    ]);
    expect(report.runs[0].phases.map((p) => `${p.phase}/${p.status}`)).toEqual([
      'review/partial',
      'review/done',
      'ship/blocked',
    ]);
  });

  it('does not relabel a ship milestone that follows a blocked ship', () => {
    const report = reportFor(9, [
      milestone('ship', 'blocked', 'r-9-aaaa', '2026-08-24T10:00:00Z', { reason: 'ci-red' }),
      milestone('ship', 'done', 'r-9-aaaa', '2026-08-24T10:10:00Z'),
    ]);
    expect(report.runs[0].phases.map((p) => p.phase)).toEqual(['ship', 'ship']);
  });

  it('reports a zero-second gap as 0s rather than as missing', () => {
    // Shaped after imboard-monorepo#3685, where an orchestrator posted four milestones
    // in the same second — real 0s spans, not absent measurements.
    const report = reportFor(3685, [
      milestone('plan', 'done', 'r-3685-5423', '2026-08-23T19:04:58Z'),
      milestone('implement', 'done', 'r-3685-5423', '2026-08-23T19:04:58Z'),
      milestone('review', 'done', 'r-3685-5423', '2026-08-23T19:04:58Z'),
      milestone('ship', 'awaiting-merge', 'r-3685-5423', '2026-08-23T19:04:58Z'),
    ]);
    expect(report.runs[0].phases.map((p) => p.seconds)).toEqual([null, 0, 0, 0]);
    expect(report.warnings).toEqual([]);
  });

  it('groups milestones with no run= id and warns that their spans may be unrelated', () => {
    const report = reportFor(10, [
      [RUNSTATE_MARKER, 'phase=gate status=done at=2026-08-24T10:00:00Z', 'next=setup', ''].join(
        '\n'
      ),
    ]);
    expect(report.runs[0].run).toBe(UNKNOWN_RUN);
    expect(report.warnings.some((w) => w.includes(UNKNOWN_RUN))).toBe(true);
  });

  it('reports a backwards span as negative and warns about clock skew', () => {
    // Two machines whose clocks disagree: setup was appended after gate but stamped
    // earlier. Reordering it would hide the skew behind a plausible sequence.
    const report = reportFor(11, [
      milestone('gate', 'done', 'r-11-aaaa', '2026-08-24T10:05:00Z'),
      milestone('setup', 'done', 'r-11-aaaa', '2026-08-24T10:00:00Z'),
    ]);
    expect(report.runs[0].phases.map((p) => p.phase)).toEqual(['gate', 'setup']);
    expect(report.runs[0].phases[1].seconds).toBe(-300);
    expect(report.warnings.some((w) => w.includes('ended before it started'))).toBe(true);
  });

  it('marks the aggregate row a skewed sample landed in', () => {
    const report = reportFor(11, [
      milestone('gate', 'done', 'r-11-aaaa', '2026-08-24T10:05:00Z'),
      milestone('setup', 'done', 'r-11-aaaa', '2026-08-24T10:00:00Z'),
    ]);
    const setup = report.aggregates.phases.find((p) => p.phase === 'setup');
    expect(setup).toMatchObject({ samples: 1, negative_samples: 1 });
    // A consumer reading only the JSON aggregates still learns the median is not meaningful.
    expect(report.warnings.some((w) => w.includes('not meaningful'))).toBe(true);
  });

  it('counts a warning raised twice instead of dropping the second', () => {
    const report = reportFor(12, [
      milestone('gate', 'done', 'r-12-aaaa', '2026-08-24T10:00:00Z'),
      milestone('setup', 'done', 'r-12-aaaa', '`date -u`'),
      milestone('plan', 'done', 'r-12-aaaa', '`date -u`'),
    ]);
    const skipped = report.warnings.filter((w) => w.includes('unusable at='));
    expect(skipped).toHaveLength(2);
  });

  it('collapses two identical warnings into one line carrying the count', () => {
    const report = reportFor(12, [
      milestone('gate', 'done', 'r-12-aaaa', '`date -u`'),
      milestone('gate', 'done', 'r-12-aaaa', '`date -u`'),
    ]);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('(×2)');
  });

  it('reports a run with one usable milestone as unmeasured, not as zero seconds', () => {
    // Every in-flight run looks like this after its gate. Calling it 0s would drag every
    // median it feeds toward zero with a duration nobody measured.
    const report = reportFor(13, [
      milestone('gate', 'done', 'r-13-aaaa', '2026-08-24T10:00:00Z', { model: 'm' }),
    ]);
    expect(report.runs[0].total_seconds).toBeNull();
    expect(report.aggregates.models[0]).toMatchObject({ runs: 1, samples: 0 });
  });

  it('names the repository in warnings when the caller supplied one', () => {
    const report = buildStatsReport({
      trails: [trail(14, [milestone('gate', 'done', 'r-14-aaaa', '`date -u`')])],
      repo: 'imboard-ai/ai-dossier',
    });
    expect(report.repo).toBe('imboard-ai/ai-dossier');
    expect(report.warnings[0]).toContain('imboard-ai/ai-dossier#14');
  });

  it('sanitises a forged milestone before it reaches a warning', () => {
    const report = reportFor(15, [
      milestone('gate', 'done', 'r-15-aaaa', '$(x)', { model: 'm' }).replace(
        'phase=gate',
        'phase=[2Kgate'
      ),
    ]);
    expect(report.warnings[0]).not.toContain('');
  });

  it('carries per-issue read failures separately from issues with no trail', () => {
    const report = buildStatsReport({
      trails: [trail(440, CLEAN_TRAIL), trail(441, ['not a runstate comment'])],
      failed: [{ issue: 442, error: 'Could not read issue #442: not found' }],
    });
    expect(report.runs).toHaveLength(1);
    expect(report.issues_without_trail).toEqual([441]);
    expect(report.issues_failed).toEqual([{ issue: 442, error: expect.stringContaining('#442') }]);
  });

  describe('a real-world-shaped broken trail (imboard-monorepo#3684)', () => {
    /**
     * The gate milestone's `at=` was pasted before the shell expanded it. Reproduced
     * verbatim: this exact trail is live on the issue, and it is the shape AC3 names.
     */
    const BROKEN_TRAIL = [
      milestone('gate', 'done', 'r-3684-a0cf', '$(date -u +%Y-%m-%dT%H:%M:%SZ)', {
        base_branch: 'main',
      }),
      milestone('setup', 'done', 'r-3684-a0cf', '2026-08-23T10:48:25Z'),
      milestone('plan', 'done', 'r-3684-a0cf', '2026-08-23T10:56:09Z'),
      milestone('implement', 'done', 'r-3684-a0cf', '2026-08-23T11:20:30Z'),
    ];
    const report = reportFor(3684, BROKEN_TRAIL);

    it('skips the unusable milestone rather than emitting a NaN row', () => {
      expect(report.runs[0].phases.map((p) => p.phase)).toEqual(['setup', 'plan', 'implement']);
    });

    it('warns, naming the phase and what it cost', () => {
      expect(report.warnings).toHaveLength(1);
      expect(report.warnings[0]).toContain('#3684');
      expect(report.warnings[0]).toContain('gate');
      expect(report.warnings[0]).toContain('unusable at=');
    });

    it('breaks the chain instead of spanning the hole', () => {
      // Pairing setup with the milestone BEFORE the skipped gate would report a duration
      // silently covering two phases — indistinguishable from a real measurement.
      expect(report.runs[0].phases[0]).toMatchObject({ phase: 'setup', seconds: null });
      expect(report.runs[0].phases[1]).toMatchObject({ phase: 'plan', seconds: 464 });
    });

    it('still totals the usable part of the run', () => {
      expect(report.runs[0].started_at).toBe('2026-08-23T10:48:25Z');
      expect(report.runs[0].total_seconds).toBe(1925);
    });

    it('still reports how far the run got, from the skipped milestone included', () => {
      expect(report.runs[0].last_phase).toBe('implement');
    });

    it('leaves a run with no usable timestamp at all with no rows and no total', () => {
      const allBroken = reportFor(16, [milestone('gate', 'done', 'r-16-aaaa', '$(date -u)')]);
      expect(allBroken.runs[0].phases).toEqual([]);
      expect(allBroken.runs[0].total_seconds).toBeNull();
      expect(allBroken.runs[0].started_at).toBeNull();
    });
  });

  it('measures the issues it can while reporting the ones it cannot', () => {
    const report = buildStatsReport({
      trails: [trail(440, CLEAN_TRAIL), trail(441, ['not a runstate comment'])],
    });
    expect(report.runs).toHaveLength(1);
    expect(report.issues_without_trail).toEqual([441]);
    expect(report.issues).toEqual([440, 441]);
  });

  it('returns an empty report for an empty selection', () => {
    expect(buildStatsReport({ trails: [] })).toEqual({
      repo: null,
      issues: [],
      runs: [],
      aggregates: { phases: [], models: [] },
      issues_without_trail: [],
      issues_failed: [],
      warnings: [],
    });
  });

  /**
   * Sample counts come from however many comments an issue has, which anyone who can
   * comment controls. `Math.min(...values)` overflows the stack around 124k arguments.
   */
  it('aggregates more samples than a spread call could take', () => {
    const bodies = [milestone('gate', 'done', 'r-17-aaaa', '2026-08-24T10:00:00Z')];
    const start = Date.parse('2026-08-24T10:00:00Z');
    for (let i = 1; i <= 150_000; i += 1) {
      bodies.push(milestone('setup', 'done', 'r-17-aaaa', nowStamp(new Date(start + i * 1000))));
    }
    expect(() => buildStatsReport({ trails: [trail(17, bodies)] })).not.toThrow();
  });
});

/**
 * The #461 vocabulary: classify prefixes a member issue's trail, and the batch line is
 * a trail of its own on a batch anchor issue. Stats must place both in the canonical
 * order and give batch-ship the same awaiting-merge → merge-wait relabel ship has.
 */
describe('buildStatsReport — classify and batch phases (#461)', () => {
  const CLASSIFIED_TRAIL = [
    milestone('classify', 'done', 'r-440-ab56', '2026-08-24T09:00:00Z', {
      mode: 'slot',
      risk: 'low',
      est_files: '3',
      est_diff: '120',
      areas: 'cli,docs',
      test_scope: 'focused',
      deps: 'none',
      confidence: '0.85',
    }),
    ...CLEAN_TRAIL,
  ];

  const BATCH_ANCHOR_TRAIL = [
    milestone('batch-setup', 'done', 'r-480-cd12', '2026-08-24T10:00:00Z', {
      batch: 'b-2026-08-29-01',
      members: '4',
    }),
    milestone('batch-validate', 'done', 'r-480-cd12', '2026-08-24T10:30:00Z'),
    milestone('batch-review', 'done', 'r-480-cd12', '2026-08-24T11:00:00Z'),
    milestone('batch-ship', 'awaiting-merge', 'r-480-cd12', '2026-08-24T11:10:00Z', {
      pr: '481',
    }),
    milestone('batch-ship', 'done', 'r-480-cd12', '2026-08-24T11:40:00Z', {
      merge_commit: 'c4a6231',
    }),
    milestone('batch-report', 'done', 'r-480-cd12', '2026-08-24T11:45:00Z'),
  ];

  it('places classify before gate in the canonical order', () => {
    expect(STATS_PHASE_ORDER.indexOf('classify')).toBe(0);
    expect(STATS_PHASE_ORDER.indexOf('gate')).toBe(STATS_PHASE_ORDER.indexOf('classify') + 1);
  });

  it('places the batch line after the full-cycle phases, with its own merge-wait', () => {
    const batchIdx = STATS_PHASE_ORDER.indexOf('batch-setup');
    expect(STATS_PHASE_ORDER.slice(batchIdx)).toEqual([
      'batch-setup',
      'batch-validate',
      'batch-review',
      'batch-ship',
      BATCH_MERGE_WAIT_PHASE,
      'batch-report',
    ]);
    expect(batchIdx).toBeGreaterThan(STATS_PHASE_ORDER.indexOf('report'));
  });

  it('measures a classify milestone that prefixes a full-cycle trail', () => {
    const run = reportFor(440, CLASSIFIED_TRAIL).runs[0];
    expect(run.phases[0]).toMatchObject({ phase: 'classify', seconds: null });
    expect(run.phases[1]).toMatchObject({
      phase: 'gate',
      started_at: '2026-08-24T09:00:00Z',
      seconds: 3600,
    });
  });

  it('reports a batch anchor trail, with batch-ship’s wait under its own label', () => {
    const run = reportFor(480, BATCH_ANCHOR_TRAIL).runs[0];
    expect(run.phases.map((p) => p.phase)).toEqual([
      'batch-setup',
      'batch-validate',
      'batch-review',
      'batch-ship',
      BATCH_MERGE_WAIT_PHASE,
      'batch-report',
    ]);
    expect(run.phases[4]).toMatchObject({ phase: BATCH_MERGE_WAIT_PHASE, seconds: 1800 });
    expect(run.last_phase).toBe('batch-report');
  });

  it('does not pool batch-merge-wait with full-cycle merge-wait in aggregates', () => {
    const report = buildStatsReport({
      trails: [trail(440, CLEAN_TRAIL), trail(480, BATCH_ANCHOR_TRAIL)],
    });
    const phases = report.aggregates.phases.map((p) => p.phase);
    expect(phases).toContain(MERGE_WAIT_PHASE);
    expect(phases).toContain(BATCH_MERGE_WAIT_PHASE);
    const wait = report.aggregates.phases.find((p) => p.phase === MERGE_WAIT_PHASE);
    expect(wait?.samples).toBe(1);
    const batchWait = report.aggregates.phases.find((p) => p.phase === BATCH_MERGE_WAIT_PHASE);
    expect(batchWait?.samples).toBe(1);
  });

  it('does not relabel a ship → batch-ship transition (same-phase rule)', () => {
    const malformed = [
      milestone('ship', 'awaiting-merge', 'r-1-aaaa', '2026-08-24T10:00:00Z'),
      milestone('batch-ship', 'done', 'r-1-aaaa', '2026-08-24T10:10:00Z'),
    ];
    const run = reportFor(1, malformed).runs[0];
    expect(run.phases.map((p) => p.phase)).toEqual(['ship', 'batch-ship']);
  });
});

describe('canonicalModel — routing prefixes folded into one bucket', () => {
  it('folds the real-world spellings of one model onto one key', () => {
    // Every pair observed on real trails: ai-dossier #460–#538 and imboard-monorepo #471.
    expect(canonicalModel('llmgateway/glm-5.3')).toBe(canonicalModel('glm-5.3'));
    expect(canonicalModel('~z-ai/glm-latest')).toBe(canonicalModel('z-ai/glm-latest'));
    expect(canonicalModel('openrouter-kimi-latest')).toBe(canonicalModel('moonshotai/kimi-latest'));
  });

  it('strips the gateway alias marker and lowercases', () => {
    expect(canonicalModel('~z-ai/GLM-Latest')).toBe('glm-latest');
  });

  it('peels a chain of routing prefixes', () => {
    expect(canonicalModel('llmgateway/openrouter-kimi-latest')).toBe('kimi-latest');
  });

  it('never strips an unrecognised leading segment', () => {
    // The one error this table cannot survive is merging two different models.
    expect(canonicalModel('claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(canonicalModel('acme/glm-5.3')).toBe('acme/glm-5.3');
  });

  it('keeps a value that is nothing but a routing prefix as its own bucket', () => {
    expect(canonicalModel('openrouter')).toBe('openrouter');
    expect(canonicalModel('openrouter/')).toBe('openrouter/');
  });

  it('keeps distinct model versions distinct', () => {
    expect(canonicalModel('llmgateway/glm-5.3')).not.toBe(canonicalModel('z-ai/glm-latest'));
  });
});

describe('buildStatsReport — model buckets answer "which tiers are safe"', () => {
  /** One model recorded under two routing spellings, with opposite outcomes. */
  const SPLIT_SPELLINGS = [
    trail(1, [
      milestone('gate', 'done', 'r-1-aaaa', '2026-08-24T09:00:00Z', { model: 'glm-5.3' }),
      milestone('report', 'done', 'r-1-aaaa', '2026-08-24T09:30:00Z'),
    ]),
    trail(2, [
      milestone('gate', 'done', 'r-2-bbbb', '2026-08-24T09:00:00Z', {
        model: 'llmgateway/glm-5.3',
      }),
      milestone('implement', 'blocked', 'r-2-bbbb', '2026-08-24T09:10:00Z', { reason: 'quota' }),
    ]),
    trail(3, [
      milestone('gate', 'done', 'r-3-cccc', '2026-08-24T09:00:00Z', { model: 'glm-5.3' }),
      milestone('ship', 'awaiting-merge', 'r-3-cccc', '2026-08-24T09:20:00Z', { pr: '9' }),
    ]),
  ];

  const report = buildStatsReport({ trails: SPLIT_SPELLINGS });

  it('reports one bucket, not one per spelling', () => {
    expect(report.aggregates.models).toHaveLength(1);
    expect(report.aggregates.models[0].model).toBe('glm-5.3');
    expect(report.aggregates.models[0].runs).toBe(3);
  });

  it('discloses which raw spellings folded in, so the merge is never silent', () => {
    expect(report.aggregates.models[0].aliases).toEqual(['glm-5.3', 'llmgateway/glm-5.3']);
  });

  it('counts terminal outcomes so a bucket says whether the work finished', () => {
    expect(report.aggregates.models[0]).toMatchObject({
      completed: 1,
      blocked: 1,
      unfinished: 1,
      completion_rate: 1 / 3,
    });
  });

  it('leaves the per-run rows on their raw recorded model', () => {
    // The fold is an aggregation choice; the evidence trail keeps what was written.
    expect(report.runs.map((r) => r.model)).toEqual(['glm-5.3', 'llmgateway/glm-5.3', 'glm-5.3']);
  });

  it('counts ship done as delivered — the merge and teardown are confirmed by then', () => {
    // The report tail is routinely a separately dispatched run; scoring the delivering run
    // as unfinished would put every scheduler-dispatched arm's completion rate far too low.
    const shipped = reportFor(7, [
      milestone('gate', 'done', 'r-7-9999', '2026-08-24T09:00:00Z', { model: 'glm-5.3' }),
      milestone('ship', 'done', 'r-7-9999', '2026-08-24T09:40:00Z', { merge_commit: 'abc1234' }),
    ]);
    expect(shipped.aggregates.models[0]).toMatchObject({ completed: 1, completion_rate: 1 });
  });

  it('counts a batch-report done as completed', () => {
    const batch = reportFor(4, [
      milestone('gate', 'done', 'r-4-dddd', '2026-08-24T09:00:00Z', { model: 'glm-5.3' }),
      milestone('batch-report', 'done', 'r-4-dddd', '2026-08-24T09:30:00Z'),
    ]);
    expect(batch.aggregates.models[0]).toMatchObject({ completed: 1, completion_rate: 1 });
  });

  it('does not count a mid-pipeline done as completed', () => {
    const midway = reportFor(5, [
      milestone('gate', 'done', 'r-5-eeee', '2026-08-24T09:00:00Z', { model: 'glm-5.3' }),
      milestone('review', 'done', 'r-5-eeee', '2026-08-24T09:30:00Z'),
    ]);
    expect(midway.aggregates.models[0]).toMatchObject({
      completed: 0,
      blocked: 0,
      unfinished: 1,
      completion_rate: 0,
    });
  });

  it('buckets runs with no model= under unknown without canonicalising it', () => {
    const none = reportFor(6, [
      milestone('gate', 'done', 'r-6-ffff', '2026-08-24T09:00:00Z'),
      milestone('report', 'done', 'r-6-ffff', '2026-08-24T09:30:00Z'),
    ]);
    expect(none.aggregates.models[0]).toMatchObject({
      model: UNKNOWN_MODEL,
      aliases: [UNKNOWN_MODEL],
      runs: 1,
    });
  });
});
