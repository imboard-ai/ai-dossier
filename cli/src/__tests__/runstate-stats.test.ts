import { describe, expect, it } from 'vitest';
import { parseMilestones, RUNSTATE_MARKER } from '../runstate';
import {
  buildStatsReport,
  formatDuration,
  formatDurationCell,
  type IssueTrail,
  isUsableTimestamp,
  MAX_ISSUE_SELECTION,
  MERGE_WAIT_PHASE,
  median,
  parseIssueSelection,
  renderTable,
  STATS_PHASE_ORDER,
  UNKNOWN_MODEL,
  UNKNOWN_RUN,
} from '../runstate-stats';

/**
 * Build one milestone comment body the way `runstate post` writes it. Extra `key=value`
 * lines go in `keys`, so a fixture can carry `model=` or `pr=` without a second builder.
 */
function milestone(
  phase: string,
  status: string,
  run: string,
  at: string,
  keys: Record<string, string> = {}
): string {
  return [
    RUNSTATE_MARKER,
    `phase=${phase} status=${status} run=${run} at=${at}`,
    ...Object.entries(keys).map(([k, v]) => `${k}=${v}`),
    'next=done',
    '',
  ].join('\n');
}

/** Turn comment bodies into the trail shape `buildStatsReport` consumes. */
function trail(issue: number, bodies: string[]): IssueTrail {
  return { issue, milestones: parseMilestones(bodies) };
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

describe('parseIssueSelection', () => {
  it('expands an explicit list', () => {
    expect(parseIssueSelection('1,2,3')).toEqual([1, 2, 3]);
  });

  it('expands an inclusive range', () => {
    expect(parseIssueSelection('1..9')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('expands a mixed list and range', () => {
    expect(parseIssueSelection('1,2,5..8')).toEqual([1, 2, 5, 6, 7, 8]);
  });

  it('de-duplicates and sorts ascending', () => {
    expect(parseIssueSelection('9,1,5..7,6,1')).toEqual([1, 5, 6, 7, 9]);
  });

  it('tolerates surrounding whitespace around terms', () => {
    expect(parseIssueSelection(' 3 , 1 .. 2 ')).toEqual([1, 2, 3]);
  });

  it('accepts a single issue', () => {
    expect(parseIssueSelection('451')).toEqual([451]);
  });

  it('rejects an empty selection', () => {
    expect(() => parseIssueSelection('  ')).toThrow(/Empty issue selection/);
  });

  it('rejects a stray comma by name', () => {
    expect(() => parseIssueSelection('1,,2')).toThrow(/stray comma/);
  });

  it('rejects a non-numeric term and names it', () => {
    expect(() => parseIssueSelection('1,abc,3')).toThrow(/Invalid issue 'abc'/);
  });

  it('rejects issue 0', () => {
    expect(() => parseIssueSelection('0')).toThrow(/Invalid issue '0'/);
  });

  it('rejects a malformed range', () => {
    expect(() => parseIssueSelection('1..2..3')).toThrow(/Malformed range/);
  });

  it('rejects a descending range and suggests the fix', () => {
    expect(() => parseIssueSelection('9..1')).toThrow(/Descending range '9\.\.1'.*9\.\.1/s);
  });

  it('rejects a range past the selection cap without materialising it', () => {
    expect(() => parseIssueSelection(`1..${MAX_ISSUE_SELECTION + 1}`)).toThrow(
      new RegExp(`past the ${MAX_ISSUE_SELECTION} cap`)
    );
  });

  it('rejects a list that accumulates past the cap', () => {
    const half = Math.ceil(MAX_ISSUE_SELECTION / 2);
    const selection = `1..${half},1000..${1000 + half}`;
    expect(() => parseIssueSelection(selection)).toThrow(
      new RegExp(`past ${MAX_ISSUE_SELECTION} issues`)
    );
  });

  it('accepts a range exactly at the cap', () => {
    expect(parseIssueSelection(`1..${MAX_ISSUE_SELECTION}`)).toHaveLength(MAX_ISSUE_SELECTION);
  });
});

describe('isUsableTimestamp', () => {
  it('accepts the format runstate post stamps', () => {
    expect(isUsableTimestamp('2026-08-24T10:00:00Z')).toBe(true);
  });

  it('accepts fractional seconds and explicit offsets', () => {
    expect(isUsableTimestamp('2026-08-24T10:00:00.123Z')).toBe(true);
    expect(isUsableTimestamp('2026-08-24T10:00:00+02:00')).toBe(true);
  });

  it('rejects an unexpanded shell substitution', () => {
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
});

describe('formatDuration', () => {
  it('renders sub-minute durations in seconds', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(59)).toBe('59s');
  });

  it('renders minutes and seconds', () => {
    expect(formatDuration(60)).toBe('1m 0s');
    expect(formatDuration(303)).toBe('5m 3s');
    expect(formatDuration(3599)).toBe('59m 59s');
  });

  it('renders hours and minutes', () => {
    expect(formatDuration(3600)).toBe('1h 0m');
    expect(formatDuration(7500)).toBe('2h 5m');
  });

  it('renders days and hours', () => {
    expect(formatDuration(86400)).toBe('1d 0h');
    expect(formatDuration(97200)).toBe('1d 3h');
  });

  it('renders a negative duration with a leading sign', () => {
    expect(formatDuration(-90)).toBe('-1m 30s');
  });

  it('pairs the human form with raw seconds, and renders null as a dash', () => {
    expect(formatDurationCell(303)).toBe('5m 3s (303s)');
    expect(formatDurationCell(null)).toBe('-');
  });
});

describe('renderTable', () => {
  it('pads every column to its widest cell', () => {
    const out = renderTable(
      ['phase', 'n'],
      [
        ['gate', '1'],
        ['implement', '12'],
      ]
    );
    const [header, first, second] = out.split('\n');
    expect(header).toBe('phase      n');
    expect(first).toBe('gate       1');
    expect(second).toBe('implement  12');
  });

  it('right-aligns the columns asked for', () => {
    const out = renderTable(['a', 'b'], [['x', '1']], ['left', 'right']);
    expect(out.split('\n')[1]).toBe('x  1');
  });

  it('tolerates a short row rather than printing undefined', () => {
    const out = renderTable(['a', 'b'], [['x']]);
    expect(out.split('\n')[1]).toBe('x');
  });

  it('renders headers alone when there are no rows', () => {
    expect(renderTable(['a', 'b'], [])).toBe('a  b');
  });
});

describe('buildStatsReport — AC1: one clean trail', () => {
  const report = buildStatsReport([trail(440, CLEAN_TRAIL)]);
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

  it('reads model= off the gate milestone', () => {
    expect(run.model).toBe('claude-opus-5');
  });

  it('warns about nothing on a clean trail', () => {
    expect(report.warnings).toEqual([]);
    expect(report.issues_without_trail).toEqual([]);
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

  const report = buildStatsReport([trail(451, MULTI_RUN)]);

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

  it('keeps a blocked status on its row', () => {
    expect(report.runs[0].phases[2]).toMatchObject({ phase: 'implement', status: 'blocked' });
  });

  it('buckets whole-run totals by model', () => {
    expect(report.aggregates.models).toEqual([
      {
        model: 'claude-opus-5',
        runs: 1,
        samples: 1,
        median_total_seconds: 1800,
        min_total_seconds: 1800,
        max_total_seconds: 1800,
      },
      {
        model: 'claude-sonnet-5',
        runs: 1,
        samples: 1,
        median_total_seconds: 1200,
        min_total_seconds: 1200,
        max_total_seconds: 1200,
      },
    ]);
  });

  it('re-groups runs whose milestones interleave in comment order', () => {
    const interleaved = buildStatsReport([
      trail(451, [
        milestone('gate', 'done', 'r-451-aaaa', '2026-08-24T09:00:00Z'),
        milestone('gate', 'done', 'r-451-bbbb', '2026-08-24T09:01:00Z'),
        milestone('setup', 'done', 'r-451-aaaa', '2026-08-24T09:10:00Z'),
        milestone('setup', 'done', 'r-451-bbbb', '2026-08-24T09:02:00Z'),
      ]),
    ]);

    // Without grouping, r-451-aaaa's setup would be paired with r-451-bbbb's gate.
    expect(interleaved.runs[0].phases[1]).toMatchObject({ phase: 'setup', seconds: 600 });
    expect(interleaved.runs[1].phases[1]).toMatchObject({ phase: 'setup', seconds: 60 });
  });

  it('keeps each run in the order its milestones were appended', () => {
    const report = buildStatsReport([
      trail(451, [
        milestone('gate', 'done', 'r-451-cccc', '2026-08-24T09:00:00Z'),
        milestone('setup', 'done', 'r-451-cccc', '2026-08-24T09:05:00Z'),
        milestone('plan', 'done', 'r-451-cccc', '2026-08-24T09:06:00Z'),
      ]),
    ]);
    expect(report.runs[0].phases.map((p) => p.phase)).toEqual(['gate', 'setup', 'plan']);
  });
});

describe('buildStatsReport — AC2: aggregation across issues', () => {
  /** A three-milestone run whose `setup` span is `setupSeconds`, so each issue
   * contributes a different sample to the same phase. */
  function runOf(run: string, model: string, setupSeconds: number): string[] {
    const start = Date.parse('2026-08-24T10:00:00Z');
    const at = (offset: number): string =>
      `${new Date(start + offset * 1000).toISOString().slice(0, 19)}Z`;
    return [
      milestone('gate', 'done', run, at(0), { model }),
      milestone('setup', 'done', run, at(setupSeconds)),
      milestone('plan', 'done', run, at(setupSeconds + 100)),
    ];
  }

  const report = buildStatsReport([
    trail(1, runOf('r-1-aaaa', 'claude-opus-5', 100)),
    trail(2, runOf('r-2-bbbb', 'claude-opus-5', 200)),
    trail(3, runOf('r-3-cccc', 'claude-sonnet-5', 300)),
  ]);

  it('lists every requested issue', () => {
    expect(report.issues).toEqual([1, 2, 3]);
  });

  it('reports per-phase median, min, and max across runs', () => {
    const setup = report.aggregates.phases.find((p) => p.phase === 'setup');
    expect(setup).toEqual({
      phase: 'setup',
      samples: 3,
      median_seconds: 200,
      min_seconds: 100,
      max_seconds: 300,
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
    const noModel = buildStatsReport([
      trail(4, [
        milestone('gate', 'done', 'r-4-dddd', '2026-08-24T10:00:00Z'),
        milestone('setup', 'done', 'r-4-dddd', '2026-08-24T10:01:00Z'),
      ]),
    ]);
    expect(noModel.runs[0].model).toBeNull();
    expect(noModel.aggregates.models[0]).toMatchObject({ model: UNKNOWN_MODEL, runs: 1 });
  });

  it('falls back to a later milestone when the gate carries no model=', () => {
    const lateModel = buildStatsReport([
      trail(5, [
        milestone('gate', 'done', 'r-5-eeee', '2026-08-24T10:00:00Z'),
        milestone('setup', 'done', 'r-5-eeee', '2026-08-24T10:01:00Z', {
          model: 'claude-haiku-4-5',
        }),
      ]),
    ]);
    expect(lateModel.runs[0].model).toBe('claude-haiku-4-5');
  });
});

describe('buildStatsReport — AC3: imperfect trails', () => {
  it('says so and measures nothing when an issue has no runstate comments', () => {
    const report = buildStatsReport([trail(999, ['just a normal comment', ''])]);
    expect(report.runs).toEqual([]);
    expect(report.issues_without_trail).toEqual([999]);
    expect(report.warnings).toEqual([]);
  });

  it('measures a trail with phases missing entirely', () => {
    const report = buildStatsReport([
      trail(7, [
        milestone('gate', 'done', 'r-7-aaaa', '2026-08-24T10:00:00Z'),
        milestone('implement', 'done', 'r-7-aaaa', '2026-08-24T10:30:00Z'),
        milestone('report', 'done', 'r-7-aaaa', '2026-08-24T10:35:00Z'),
      ]),
    ]);
    expect(report.runs[0].phases.map((p) => p.phase)).toEqual(['gate', 'implement', 'report']);
    expect(report.runs[0].phases[1].seconds).toBe(1800);
  });

  it('keeps partial and blocked statuses on their rows', () => {
    const report = buildStatsReport([
      trail(8, [
        milestone('review', 'partial', 'r-8-aaaa', '2026-08-24T10:00:00Z'),
        milestone('review', 'done', 'r-8-aaaa', '2026-08-24T10:10:00Z'),
        milestone('ship', 'blocked', 'r-8-aaaa', '2026-08-24T10:20:00Z', { reason: 'ci-red' }),
      ]),
    ]);
    expect(report.runs[0].phases.map((p) => `${p.phase}/${p.status}`)).toEqual([
      'review/partial',
      'review/done',
      'ship/blocked',
    ]);
  });

  it('does not relabel a ship milestone that follows a blocked ship', () => {
    const report = buildStatsReport([
      trail(9, [
        milestone('ship', 'blocked', 'r-9-aaaa', '2026-08-24T10:00:00Z', { reason: 'ci-red' }),
        milestone('ship', 'done', 'r-9-aaaa', '2026-08-24T10:10:00Z'),
      ]),
    ]);
    expect(report.runs[0].phases.map((p) => p.phase)).toEqual(['ship', 'ship']);
  });

  it('reports a zero-second gap as 0s rather than as missing', () => {
    // Shaped after imboard-monorepo#3685, where an orchestrator posted four milestones
    // in the same second — real 0s spans, not absent measurements.
    const report = buildStatsReport([
      trail(3685, [
        milestone('plan', 'done', 'r-3685-5423', '2026-08-23T19:04:58Z'),
        milestone('implement', 'done', 'r-3685-5423', '2026-08-23T19:04:58Z'),
        milestone('review', 'done', 'r-3685-5423', '2026-08-23T19:04:58Z'),
        milestone('ship', 'awaiting-merge', 'r-3685-5423', '2026-08-23T19:04:58Z'),
      ]),
    ]);
    expect(report.runs[0].phases.map((p) => p.seconds)).toEqual([null, 0, 0, 0]);
    expect(report.warnings).toEqual([]);
  });

  it('groups milestones with no run= id and warns that their spans may be unrelated', () => {
    const report = buildStatsReport([
      trail(10, [
        [RUNSTATE_MARKER, 'phase=gate status=done at=2026-08-24T10:00:00Z', 'next=setup', ''].join(
          '\n'
        ),
      ]),
    ]);
    expect(report.runs[0].run).toBe(UNKNOWN_RUN);
    expect(report.warnings.some((w) => w.includes(UNKNOWN_RUN))).toBe(true);
  });

  it('reports a backwards span as negative and warns about clock skew', () => {
    // Two machines whose clocks disagree: setup was appended after gate but stamped
    // earlier. Reordering it would hide the skew behind a plausible sequence.
    const report = buildStatsReport([
      trail(11, [
        milestone('gate', 'done', 'r-11-aaaa', '2026-08-24T10:05:00Z'),
        milestone('setup', 'done', 'r-11-aaaa', '2026-08-24T10:00:00Z'),
      ]),
    ]);
    expect(report.runs[0].phases.map((p) => p.phase)).toEqual(['gate', 'setup']);
    expect(report.runs[0].phases[1].seconds).toBe(-300);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('ended before it started');
  });

  it('renders a negative span readably in the duration cell', () => {
    expect(formatDurationCell(-300)).toBe('-5m 0s (-300s)');
  });

  it('does not double-count a warning raised by two milestones alike', () => {
    const report = buildStatsReport([
      trail(12, [
        milestone('gate', 'done', 'r-12-aaaa', '$(date -u +%Y-%m-%dT%H:%M:%SZ)'),
        milestone('gate', 'done', 'r-12-aaaa', '$(date -u +%Y-%m-%dT%H:%M:%SZ)'),
      ]),
    ]);
    expect(report.warnings).toHaveLength(1);
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
    const report = buildStatsReport([trail(3684, BROKEN_TRAIL)]);

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

    it('leaves a run with no usable timestamp at all with no rows and no total', () => {
      const allBroken = buildStatsReport([
        trail(13, [milestone('gate', 'done', 'r-13-aaaa', '$(date -u)')]),
      ]);
      expect(allBroken.runs[0].phases).toEqual([]);
      expect(allBroken.runs[0].total_seconds).toBeNull();
      expect(allBroken.runs[0].started_at).toBeNull();
    });
  });

  it('measures the issues it can while reporting the ones it cannot', () => {
    const report = buildStatsReport([
      trail(440, CLEAN_TRAIL),
      trail(441, ['not a runstate comment']),
    ]);
    expect(report.runs).toHaveLength(1);
    expect(report.issues_without_trail).toEqual([441]);
    expect(report.issues).toEqual([440, 441]);
  });

  it('returns an empty report for an empty selection', () => {
    const report = buildStatsReport([]);
    expect(report).toEqual({
      issues: [],
      runs: [],
      aggregates: { phases: [], models: [] },
      issues_without_trail: [],
      warnings: [],
    });
  });
});
