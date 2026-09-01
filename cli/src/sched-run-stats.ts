/**
 * Per-issue token/cost aggregation over `runs.jsonl` (#524).
 *
 * `packages/sched` now writes one `runs.jsonl` entry per dispatch (`unit`
 * set to `issue:<n>`) — this module is the read side: it groups those
 * entries by issue and sums tokens/cost/duration, the number both the pilot
 * and parity gate reports needed and had to approximate from agents'
 * self-reported numbers instead. Pure and dependency-free — no filesystem,
 * no `gh` — so the arithmetic is unit-testable against fixture entries; the
 * command layer (`cli/src/commands/sched.ts`) only reads `runs.jsonl` and
 * renders what this returns.
 */

import type { RunLogEntry } from '@ai-dossier/core';

/** `issue:<n>` → `<n>`; null for anything else (a batch unit, or no unit at all). */
export function issueOfUnit(unit: string | null | undefined): number | null {
  if (!unit) return null;
  const match = /^issue:(\d+)$/.exec(unit);
  return match ? Number.parseInt(match[1], 10) : null;
}

/** Sum a nullable numeric field across entries, tracking whether any entry actually reported it. */
function sumField(
  entries: RunLogEntry[],
  field: keyof RunLogEntry
): { total: number; samples: number } {
  let total = 0;
  let samples = 0;
  for (const entry of entries) {
    const value = entry[field];
    if (typeof value === 'number' && Number.isFinite(value)) {
      total += value;
      samples += 1;
    }
  }
  return { total, samples };
}

/** One issue's aggregated dispatch cost. */
export interface IssueCost {
  issue: number;
  /** Number of runs.jsonl entries (dispatches) attributed to this issue. */
  runs: number;
  /** Null when NO entry for this issue reported the field — never a fabricated 0. */
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_read_tokens: number | null;
  total_cost_usd: number | null;
  duration_ms: number | null;
}

/** The whole cohort: per-issue rows plus a totals row. */
export interface SchedCostReport {
  issues: IssueCost[];
  totals: Omit<IssueCost, 'issue'>;
}

function aggregate(
  issue: number | 'totals',
  entries: RunLogEntry[]
): IssueCost | Omit<IssueCost, 'issue'> {
  const fields = (
    [
      'input_tokens',
      'output_tokens',
      'cache_creation_tokens',
      'cache_read_tokens',
      'total_cost_usd',
      'duration_ms',
    ] as const
  ).map((field) => [field, sumField(entries, field)] as const);
  const values = Object.fromEntries(
    fields.map(([field, { total, samples }]) => [field, samples > 0 ? total : null])
  ) as Record<(typeof fields)[number][0], number | null>;

  const row = { runs: entries.length, ...values };
  return issue === 'totals' ? row : { issue, ...row };
}

/**
 * Build the per-issue cost report from already-read `runs.jsonl` entries.
 *
 * Only entries with an `issue:<n>` `unit` are considered — ordinary
 * `ai-dossier run` entries (no `unit`) and batch entries (`batch:<id>`, not
 * yet dispatched by the engine — see `packages/sched`'s header comment) are
 * excluded. `issues`, when given, restricts the report to that set (and
 * includes a zero-run row for any issue with no matching entries, so an
 * operator can tell "no cost recorded" from "not asked about").
 */
export function buildSchedCostReport(
  entries: RunLogEntry[],
  issues?: readonly number[]
): SchedCostReport {
  const byIssue = new Map<number, RunLogEntry[]>();
  for (const entry of entries) {
    const issue = issueOfUnit(entry.unit);
    if (issue === null) continue;
    const list = byIssue.get(issue);
    if (list) list.push(entry);
    else byIssue.set(issue, [entry]);
  }

  const selected = issues ?? [...byIssue.keys()].sort((a, b) => a - b);
  const rows = selected.map((issue) => aggregate(issue, byIssue.get(issue) ?? []) as IssueCost);
  const totals = aggregate(
    'totals',
    selected.flatMap((issue) => byIssue.get(issue) ?? [])
  );

  return { issues: rows, totals };
}
