import type { RunLogEntry } from '@ai-dossier/core';
import { describe, expect, it } from 'vitest';
import {
  buildBatchAmortizationSummary,
  buildSchedCostReport,
  formatAmortizationLine,
  issueOfUnit,
  summarizeBatchJournal,
  tokensByModel,
} from '../sched-run-stats';

function entry(overrides: Partial<RunLogEntry>): RunLogEntry {
  return {
    timestamp: '2026-09-01T12:00:00Z',
    dossier: 'sched:cycle',
    resolved_version: 'n/a',
    source: 'local',
    verification: 'skipped',
    llm: 'claude',
    user: 'sched',
    cwd: '',
    nested: false,
    ...overrides,
  };
}

describe('issueOfUnit', () => {
  it('extracts the issue number from an issue:<n> unit', () => {
    expect(issueOfUnit('issue:524')).toBe(524);
  });

  it('returns null for a batch unit, null, or undefined', () => {
    expect(issueOfUnit('batch:b1')).toBeNull();
    expect(issueOfUnit(null)).toBeNull();
    expect(issueOfUnit(undefined)).toBeNull();
    expect(issueOfUnit('')).toBeNull();
  });
});

describe('buildSchedCostReport', () => {
  it('groups entries by issue and sums numeric fields, sorted ascending by issue', () => {
    const entries = [
      entry({ unit: 'issue:524', input_tokens: 100, output_tokens: 20, total_cost_usd: 0.01 }),
      entry({ unit: 'issue:524', input_tokens: 50, output_tokens: 10, total_cost_usd: 0.005 }),
      entry({ unit: 'issue:9', input_tokens: 5, output_tokens: 1 }),
    ];

    const report = buildSchedCostReport(entries);

    expect(report.issues).toMatchObject([
      {
        issue: 9,
        runs: 1,
        input_tokens: 5,
        output_tokens: 1,
        cache_creation_tokens: null,
        cache_read_tokens: null,
        total_cost_usd: null,
        duration_ms: null,
        model: null,
        tier: null,
        usage: 'ok',
      },
      {
        issue: 524,
        runs: 2,
        input_tokens: 150,
        output_tokens: 30,
        cache_creation_tokens: null,
        cache_read_tokens: null,
        total_cost_usd: 0.015,
        duration_ms: null,
        model: null,
        tier: null,
        usage: 'ok',
      },
    ]);
    expect(report.totals).toMatchObject({ runs: 3, input_tokens: 155, output_tokens: 31 });
  });

  it('excludes entries with no unit (ordinary ai-dossier run entries) and batch units', () => {
    const entries = [
      entry({ input_tokens: 999 }), // no unit at all
      entry({ unit: 'batch:b1', input_tokens: 999 }),
      entry({ unit: 'issue:524', input_tokens: 10 }),
    ];

    const report = buildSchedCostReport(entries);

    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({ issue: 524, input_tokens: 10 });
  });

  it('never fabricates a 0 — a field is null unless at least one entry reported it', () => {
    const report = buildSchedCostReport([entry({ unit: 'issue:1' })]);
    expect(report.issues[0]).toMatchObject({
      runs: 1,
      input_tokens: null,
      output_tokens: null,
      total_cost_usd: null,
      duration_ms: null,
    });
  });

  it('keeps OpenCode reasoning and steps separate, exposing subscription pricing as unpriced', () => {
    const report = buildSchedCostReport([
      entry({
        unit: 'issue:715',
        provider: 'opencode',
        model: 'glm-5.3',
        input_tokens: 168_908,
        output_tokens: 8_685,
        reasoning_tokens: 4_000,
        cache_read_tokens: 3_343_360,
        cache_creation_tokens: 0,
        steps: 31,
        total_cost_usd: null,
        cost_available: false,
      }),
    ]);

    expect(report.issues[0]).toMatchObject({
      provider: 'opencode',
      input_tokens: 168_908,
      output_tokens: 8_685,
      reasoning_tokens: 4_000,
      cache_read_tokens: 3_343_360,
      steps: 31,
      cost: 'unpriced',
      usage: 'ok',
    });
  });

  it('preserves priced spend and cache-only usage alongside unpriced OpenCode runs', () => {
    const report = buildSchedCostReport([
      entry({
        unit: 'issue:715',
        input_tokens: 100,
        total_cost_usd: 0.5,
        cost_available: true,
      }),
      entry({
        unit: 'issue:715',
        cache_read_tokens: 20,
        cost_available: false,
      }),
    ]);

    expect(report.issues[0]).toMatchObject({
      cache_read_tokens: 20,
      total_cost_usd: 0.5,
      cost: 'partial',
      usage: 'ok',
    });
  });

  describe('model/tier fields (#564 AC1)', () => {
    it('surfaces a single model/tier reported by one dispatch', () => {
      const report = buildSchedCostReport([
        entry({ unit: 'issue:1', model: 'claude-sonnet-5', tier: 'mid' }),
      ]);
      expect(report.issues[0]).toMatchObject({ model: 'claude-sonnet-5', tier: 'mid' });
    });

    it('dedupes and sorts distinct models/tiers across an escalated redispatch', () => {
      const report = buildSchedCostReport([
        entry({ unit: 'issue:1', model: 'claude-sonnet-5', tier: 'mid' }),
        entry({ unit: 'issue:1', model: 'claude-opus-5', tier: 'strong' }),
        entry({ unit: 'issue:1', model: 'claude-sonnet-5', tier: 'mid' }), // duplicate
      ]);
      expect(report.issues[0]).toMatchObject({
        model: 'claude-opus-5,claude-sonnet-5',
        tier: 'mid,strong',
      });
    });

    it('is null when no dispatch reported a model/tier', () => {
      const report = buildSchedCostReport([entry({ unit: 'issue:1' })]);
      expect(report.issues[0]).toMatchObject({ model: null, tier: null });
    });
  });

  describe('usage field (#564 AC2)', () => {
    it('flags a row usage=missing when a dispatch happened but reported no tokens', () => {
      const report = buildSchedCostReport([entry({ unit: 'issue:1' })]);
      expect(report.issues[0].usage).toBe('missing');
    });

    it('flags a row usage=ok when at least one dispatch reported tokens', () => {
      const report = buildSchedCostReport([entry({ unit: 'issue:1', input_tokens: 10 })]);
      expect(report.issues[0].usage).toBe('ok');
    });

    it('a zero-run synthesized row (issue asked about, no entries) is usage=ok, not missing', () => {
      const report = buildSchedCostReport([], [1]);
      expect(report.issues[0]).toMatchObject({ runs: 0, usage: 'ok' });
    });
  });

  it('restricts to the given issues, including a zero-run row for one with no entries', () => {
    const entries = [entry({ unit: 'issue:524', input_tokens: 10 })];

    const report = buildSchedCostReport(entries, [524, 9]);

    expect(report.issues.map((r) => r.issue)).toEqual([524, 9]);
    expect(report.issues[1]).toMatchObject({ issue: 9, runs: 0, input_tokens: null });
    // Totals only cover the selected issues.
    expect(report.totals.runs).toBe(1);
  });

  it('returns an empty report for no entries', () => {
    const report = buildSchedCostReport([]);
    expect(report.issues).toEqual([]);
    expect(report.totals).toMatchObject({ runs: 0 });
  });
});

describe('batch amortization (#775)', () => {
  const events = [
    { event: 'spawned', unit: 'batch:b1', issue: 11 },
    { event: 'member-landed', unit: 'batch:b1', issue: 11 },
    { event: 'run-log-recorded', unit: 'batch:b1', issue: 12 },
    { event: 'unit-failed', unit: 'batch:b1', issue: 12, reason: 'env-cold' },
    { event: 'unit-failed', unit: 'batch:b1', issue: 12, reason: 'env-cold' },
    { event: 'member-landed', unit: 'batch:b1', issue: 13 },
    { event: 'suite-failed', unit: 'batch:b1', detail: 'unreadable' },
    { event: 'batch-blocked', unit: 'batch:b1', detail: 'suite-unreadable' },
    // Another batch and an issue-unit line must not leak in.
    { event: 'member-landed', unit: 'batch:b2', issue: 99 },
    { event: 'spawned', unit: 'issue:12', issue: 12 },
  ];

  it('summarizes one batch journal, de-duplicating evictions', () => {
    expect(summarizeBatchJournal(events, 'b1')).toEqual({
      members: [11, 12, 13],
      landed: [11, 13],
      evicted: [12],
      suiteFailures: 1,
      blocked: 'suite-unreadable',
      dissolved: false,
    });
  });

  it('groups billable tokens by model, keeping a null model visible', () => {
    const rows = tokensByModel([
      entry({
        unit: 'issue:11',
        model: 'openai/gpt-5.6-luna',
        input_tokens: 100,
        output_tokens: 10,
        cache_read_tokens: 1000,
      }),
      entry({ unit: 'issue:13', model: 'openai/gpt-5.6-luna', input_tokens: 50, output_tokens: 5 }),
      entry({
        unit: 'batch:b1',
        model: 'claude-sonnet-5',
        input_tokens: 1,
        output_tokens: 1,
        total_cost_usd: 0.5,
      }),
      entry({ unit: 'issue:12' }),
    ]);
    expect(rows).toEqual([
      { model: 'openai/gpt-5.6-luna', runs: 2, billable_tokens: 1165, total_cost_usd: null },
      { model: 'claude-sonnet-5', runs: 1, billable_tokens: 2, total_cost_usd: 0.5 },
      { model: null, runs: 1, billable_tokens: null, total_cost_usd: null },
    ]);
  });

  it('reports issues per gate run only once the batch merged', () => {
    const journal = summarizeBatchJournal(events, 'b1');
    const entries = [
      entry({ unit: 'issue:11', model: 'm', input_tokens: 600, output_tokens: 0 }),
      entry({ unit: 'issue:13', model: 'm', input_tokens: 400, output_tokens: 0 }),
    ];
    const blocked = buildBatchAmortizationSummary({
      batchId: 'b1',
      batch: { status: 'blocked', members: [11, 12, 13], pr: null, evictions: [] },
      journal,
      entries,
    });
    expect(blocked).toMatchObject({
      members_enqueued: 3,
      members_landed: 2,
      evictions: 1,
      members_shipped: null,
      gate_runs: 0,
      issues_per_gate_run: null,
      billable_tokens: 1000,
      tokens_per_member: 500,
    });
    expect(formatAmortizationLine(blocked)).toContain('not shipped (status=blocked)');

    const merged = buildBatchAmortizationSummary({
      batchId: 'b1',
      batch: { status: 'merged', members: [11, 12, 13], pr: 7, evictions: [{ issue: 12 }] },
      journal,
      entries,
    });
    expect(merged).toMatchObject({
      members_shipped: 2,
      gate_runs: 1,
      issues_per_gate_run: 2,
      pr: 7,
    });
    const line = formatAmortizationLine(merged);
    expect(line).toContain('2 shipped in 1 gate run(s) → 2.0 issues/gate run');
    expect(line).toContain('by model: m');
  });

  it('still summarizes a batch pruned from state.json', () => {
    const summary = buildBatchAmortizationSummary({
      batchId: 'b1',
      batch: null,
      journal: summarizeBatchJournal(events, 'b1'),
      entries: [],
    });
    expect(summary.status).toBeNull();
    expect(summary.members_enqueued).toBe(3);
    expect(formatAmortizationLine(summary)).toContain('none recorded');
  });
});
