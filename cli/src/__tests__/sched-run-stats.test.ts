import type { RunLogEntry } from '@ai-dossier/core';
import { describe, expect, it } from 'vitest';
import { buildSchedCostReport, issueOfUnit } from '../sched-run-stats';

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

    expect(report.issues).toEqual([
      {
        issue: 9,
        runs: 1,
        input_tokens: 5,
        output_tokens: 1,
        cache_creation_tokens: null,
        cache_read_tokens: null,
        total_cost_usd: null,
        duration_ms: null,
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
