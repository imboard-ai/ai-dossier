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
import { issueOfUnit } from '@ai-dossier/sched';

/**
 * `issue:<n>` → `<n>`; null for anything else (a batch unit, or no unit at
 * all). Re-exported from `@ai-dossier/sched` — that package is both the
 * writer of the `unit` correlation key and the pre-existing owner of this
 * exact parse (`packages/sched/src/journal.ts`); a second, independently
 * maintained regex here was the same class of drift #524 exists to close.
 */
export { issueOfUnit };

/** Sum a nullable numeric field across entries, tracking whether any entry actually reported it. */
function sumField(
  entries: RunLogEntry[],
  field: keyof RunLogEntry
): { total: number; samples: number } {
  let total = 0;
  let samples = 0;
  for (const entry of entries) {
    const value = entry[field];
    // A non-finite RUNNING TOTAL would render as `-` and blank the whole
    // column — including the TOTAL row — hiding every legitimate run beside
    // it. Skip the addition rather than poisoning the cohort (#524 review).
    if (typeof value === 'number' && Number.isFinite(value) && Number.isFinite(total + value)) {
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
  /**
   * Every distinct non-null `model`/`tier` reported across this issue's
   * dispatches, comma-joined (a redispatch/escalation can change either
   * between attempts — #564 AC1). Null when no dispatch reported one (a
   * reconstructed `--batch` entry never has a `tier`; an ancient
   * pre-`model`-field entry never has a `model`).
   */
  model: string | null;
  tier: string | null;
  /**
   * `'missing'` when at least one dispatch happened (`runs > 0`) but NONE of
   * them reported token usage — a dispatch log existed but yielded nothing
   * parseable (#564 AC2). Distinguishes "we saw the dispatch, its cost is
   * unknown" from `runs === 0` ("nothing dispatched"), which the caller
   * already renders as a zero-run row rather than a cost row at all.
   */
  usage: 'ok' | 'missing';
}

/** The whole cohort: per-issue rows plus a totals row. */
export interface SchedCostReport {
  issues: IssueCost[];
  totals: Omit<IssueCost, 'issue'>;
}

/** The summable `IssueCost` fields, in table-column order. */
const SUM_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_tokens',
  'cache_read_tokens',
  'total_cost_usd',
  'duration_ms',
] as const satisfies readonly (keyof Omit<IssueCost, 'issue' | 'runs'> & keyof RunLogEntry)[];

/**
 * Every distinct non-null value `field` reports across `entries`, sorted and
 * comma-joined (values are themselves sometimes already comma-joined — a
 * `model` entry from a multi-model dispatch, e.g. an escalation ladder run —
 * so split each on `,` before deduping, rather than treating "a,b" and "b,a"
 * from two different dispatches as distinct). Null when nothing reported it.
 */
function aggregateCategorical(entries: RunLogEntry[], field: 'model' | 'tier'): string | null {
  const seen = new Set<string>();
  for (const entry of entries) {
    const value = entry[field];
    if (typeof value !== 'string' || value === '') continue;
    for (const part of value.split(',')) {
      const trimmed = part.trim();
      if (trimmed) seen.add(trimmed);
    }
  }
  return seen.size > 0 ? [...seen].sort().join(',') : null;
}

/**
 * Sum every `SUM_FIELDS` entry across `entries` — the issue-less half of one
 * row. Exported (#564 review) so a caller with an already-filtered entry set
 * that ISN'T issue-shaped (e.g. `sched stats --batch`'s tail/report entries,
 * `unit: batch:<id>`) can aggregate it directly — `buildSchedCostReport`
 * below intentionally filters to `issue:<n>` units only, so round-tripping
 * batch-overhead entries through it silently produces an all-null/zero row.
 */
export function aggregateRunLogEntries(entries: RunLogEntry[]): Omit<IssueCost, 'issue'> {
  const runs = entries.length;
  const totals = {} as Omit<IssueCost, 'issue' | 'runs' | 'usage' | 'model' | 'tier'>;
  for (const field of SUM_FIELDS) {
    const { total, samples } = sumField(entries, field);
    totals[field] = samples > 0 ? total : null;
  }
  const model = aggregateCategorical(entries, 'model');
  const tier = aggregateCategorical(entries, 'tier');
  const usage: IssueCost['usage'] =
    runs > 0 && totals.input_tokens === null && totals.output_tokens === null ? 'missing' : 'ok';
  return { runs, ...totals, model, tier, usage };
}

/**
 * Build the per-issue cost report from already-read `runs.jsonl` entries.
 *
 * Only entries with an `issue:<n>` `unit` are considered — ordinary
 * `ai-dossier run` entries (no `unit`) and `batch:<id>` entries (a batch's
 * tail/report/fix agents, which never write to `runs.jsonl` — see
 * `sched stats --batch` / `packages/sched/src/batch-stats.ts`, #564) are
 * excluded. Since #564, batch MEMBER dispatches use this same `issue:<n>`
 * scheme, so they are already included here, not excluded.
 *
 * `issues`, when given, restricts the report to that set (and
 * includes a zero-run row for any issue with no matching entries, so an
 * operator can tell "no cost recorded" from "not asked about"); duplicates in
 * it are collapsed, so an issue cannot be counted twice into `totals`.
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

  const selected = issues ? [...new Set(issues)] : [...byIssue.keys()].sort((a, b) => a - b);
  const rows = selected.map((issue) => ({
    issue,
    ...aggregateRunLogEntries(byIssue.get(issue) ?? []),
  }));
  const totals = aggregateRunLogEntries(selected.flatMap((issue) => byIssue.get(issue) ?? []));

  return { issues: rows, totals };
}
