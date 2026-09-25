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
import { formatCount } from './cost-format';

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
  reasoning_tokens: number | null;
  steps: number | null;
  cache_creation_tokens: number | null;
  cache_read_tokens: number | null;
  total_cost_usd: number | null;
  /** Explicitly unavailable subscription-plan pricing, distinct from old sparse rows. */
  cost: 'priced' | 'unpriced' | 'partial' | 'missing';
  duration_ms: number | null;
  /**
   * Every distinct non-null `model`/`tier` reported across this issue's
   * dispatches, comma-joined (a redispatch/escalation can change either
   * between attempts — #564 AC1). Null when no dispatch reported one (a
   * reconstructed `--batch` entry never has a `tier`; an ancient
   * pre-`model`-field entry never has a `model`).
   */
  model: string | null;
  provider: string | null;
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
  'reasoning_tokens',
  'steps',
  'cache_creation_tokens',
  'cache_read_tokens',
  'total_cost_usd',
  'duration_ms',
] as const satisfies readonly (keyof Omit<IssueCost, 'issue' | 'runs' | 'cost'> &
  keyof RunLogEntry)[];

/**
 * Every distinct non-null value `field` reports across `entries`, sorted and
 * comma-joined (values are themselves sometimes already comma-joined — a
 * `model` entry from a multi-model dispatch, e.g. an escalation ladder run —
 * so split each on `,` before deduping, rather than treating "a,b" and "b,a"
 * from two different dispatches as distinct). Null when nothing reported it.
 */
function aggregateCategorical(
  entries: RunLogEntry[],
  field: 'model' | 'provider' | 'tier'
): string | null {
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
  const totals = {} as Omit<
    IssueCost,
    'issue' | 'runs' | 'usage' | 'cost' | 'model' | 'provider' | 'tier'
  >;
  for (const field of SUM_FIELDS) {
    const { total, samples } = sumField(entries, field);
    totals[field] = samples > 0 ? total : null;
  }
  const model = aggregateCategorical(entries, 'model');
  const provider = aggregateCategorical(entries, 'provider');
  const tier = aggregateCategorical(entries, 'tier');
  const hasUnpricedCost = entries.some((entry) => entry.cost_available === false);
  const cost: IssueCost['cost'] = hasUnpricedCost
    ? totals.total_cost_usd === null
      ? 'unpriced'
      : 'partial'
    : totals.total_cost_usd === null
      ? 'missing'
      : 'priced';
  const usage: IssueCost['usage'] =
    runs > 0 &&
    totals.input_tokens === null &&
    totals.output_tokens === null &&
    totals.reasoning_tokens === null &&
    totals.cache_creation_tokens === null &&
    totals.cache_read_tokens === null
      ? 'missing'
      : 'ok';
  return { runs, ...totals, cost, model, provider, tier, usage };
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

// ---------------------------------------------------------------------------
// Batch amortization (#775, parent #770 P6): what batching is FOR is paying
// the CI gate once for N issues, so the one number that matters per batch is
// issues shipped per gate run. Everything below is pure — `sched stats
// --batch` and `scripts/model-scorecard.mjs` feed it already-read data.
// ---------------------------------------------------------------------------

/** The minimal journal-event shape these helpers read (an `events.jsonl` line). */
export interface BatchJournalEvent {
  ts?: string;
  event?: string;
  unit?: string;
  issue?: number;
  detail?: string;
  /** #844: `member-advance-recovered` carries the parked member's exit kind. */
  kind?: string;
}

/** What a batch's own `events.jsonl` lines say about its members. */
export interface BatchJournalSummary {
  /** Every member issue any event on `batch:<id>` named, ascending. */
  members: number[];
  /** Members whose work fast-forwarded onto the integration branch (`member-landed`). */
  landed: number[];
  /** Members the batch lost (`unit-failed` / `member-evicted` on the batch unit), de-duplicated. */
  evicted: number[];
  /** #810: members that handed themselves back (`member-handed-back`) — out, but not evicted. */
  handedBack: number[];
  /** `suite-failed` lines: aggregate-suite (local gate) runs that did not come back green. */
  suiteFailures: number;
  /** The last `batch-blocked` detail, or null when the batch never blocked (or was resumed since, #822). */
  blocked: string | null;
  /** #822: members re-prompted once for running the wrong procedure (`member-reprompted`). */
  reprompted: number[];
  dissolved: boolean;
}

/** Events whose `issue` names a member of the batch the event's `unit` is. */
const BATCH_MEMBER_EVENTS = new Set([
  'spawned',
  'redispatched',
  'member-landed',
  'member-advanced',
  'member-evicted',
  'member-handed-back',
  'member-reprompted',
  // #844: the SIGTERM→SIGKILL stop of a member's agent, and the crash-recovery advance.
  'member-stop-requested',
  'kill-escalated',
  'member-advance-recovered',
  'unit-failed',
  'run-log-recorded',
  'gate-skipped',
]);

/** Summarize the `batch:<batchId>` lines of an `events.jsonl` (#775). */
export function summarizeBatchJournal(
  events: readonly BatchJournalEvent[],
  batchId: string
): BatchJournalSummary {
  const unit = `batch:${batchId}`;
  const members = new Set<number>();
  const landed = new Set<number>();
  const evicted = new Set<number>();
  const handedBack = new Set<number>();
  const reprompted = new Set<number>();
  let suiteFailures = 0;
  let blocked: string | null = null;
  let dissolved = false;
  for (const event of events) {
    if (event?.unit !== unit || typeof event.event !== 'string') continue;
    const issue = typeof event.issue === 'number' ? event.issue : null;
    if (issue !== null && BATCH_MEMBER_EVENTS.has(event.event)) members.add(issue);
    if (issue !== null && event.event === 'member-landed') landed.add(issue);
    if (issue !== null && (event.event === 'unit-failed' || event.event === 'member-evicted')) {
      evicted.add(issue);
    }
    if (issue !== null && event.event === 'member-handed-back') handedBack.add(issue);
    // #844: an engine that exited right after an eviction's write may never have
    // journaled its `unit-failed`/`member-handed-back` — the recovery line names it.
    if (issue !== null && event.event === 'member-advance-recovered') {
      (event.kind === 'handed-back' ? handedBack : evicted).add(issue);
    }
    if (event.event === 'suite-failed') suiteFailures += 1;
    if (issue !== null && event.event === 'member-reprompted') reprompted.add(issue);
    if (event.event === 'batch-blocked') blocked = event.detail ?? 'blocked';
    // #822: `sched resume --batch` took it out of that block.
    if (event.event === 'batch-resumed') blocked = null;
    if (event.event === 'batch-dissolved') dissolved = true;
  }
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
  return {
    members: sorted(members),
    landed: sorted(landed),
    evicted: sorted(evicted),
    handedBack: sorted(handedBack),
    reprompted: sorted(reprompted),
    suiteFailures,
    blocked,
    dissolved,
  };
}

/** One model's share of a batch's dispatches. */
export interface ModelTokens {
  /** The entry's `model` as recorded (comma-joined when one dispatch escalated), or null. */
  model: string | null;
  runs: number;
  /** Uncached input + cache-creation + cache-read + output — the scorecard's billable total. */
  billable_tokens: number | null;
  total_cost_usd: number | null;
}

/** Billable tokens of one entry, or null when it reported none of the four terms. */
function billableTokensOf(entry: RunLogEntry): number | null {
  const terms = [
    entry.input_tokens,
    entry.cache_creation_tokens,
    entry.cache_read_tokens,
    entry.output_tokens,
  ].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return terms.length > 0 ? terms.reduce((a, b) => a + b, 0) : null;
}

/** Group dispatch entries by model — "tokens by model" per batch (#775). Sorted by tokens, descending. */
export function tokensByModel(entries: readonly RunLogEntry[]): ModelTokens[] {
  const byModel = new Map<string, RunLogEntry[]>();
  for (const entry of entries) {
    const key = typeof entry.model === 'string' && entry.model !== '' ? entry.model : '';
    const list = byModel.get(key);
    if (list) list.push(entry);
    else byModel.set(key, [entry]);
  }
  const rows = [...byModel.entries()].map(([model, list]) => {
    const tokens = list.map(billableTokensOf).filter((v): v is number => v !== null);
    const costs = list
      .map((e) => e.total_cost_usd)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return {
      model: model === '' ? null : model,
      runs: list.length,
      billable_tokens: tokens.length > 0 ? tokens.reduce((a, b) => a + b, 0) : null,
      total_cost_usd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
    };
  });
  return rows.sort((a, b) => (b.billable_tokens ?? -1) - (a.billable_tokens ?? -1));
}

/** Batch states in which the batch's PR has merged — its landed members shipped. */
const SHIPPED_BATCH_STATUSES = new Set(['merged', 'deployed']);

/** The subset of a persisted `BatchEntry` the amortization summary reads. */
export interface BatchStateSlice {
  status: string;
  members: readonly number[];
  pr: number | null;
  /** `kind` (#810): `handed-back` records are the member's own hand-back, not an eviction. */
  evictions: readonly { issue: number; kind?: string }[];
}

/** `sched stats --batch <id>`'s amortization summary (#775). */
export interface BatchAmortizationSummary {
  batch: string;
  status: string | null;
  pr: number | null;
  members_enqueued: number;
  members_landed: number;
  evictions: number;
  /** #810: members that handed themselves back (out of the batch, not evicted). */
  handed_back: number;
  /** Members that shipped with the batch PR; null while the batch has not merged. */
  members_shipped: number | null;
  /** CI gate runs paid for the batch PR (one per PR); 0 while unshipped. */
  gate_runs: number;
  /** `members_shipped / gate_runs` — the number batching exists to raise. Null while unshipped. */
  issues_per_gate_run: number | null;
  suite_failures: number;
  billable_tokens: number | null;
  total_cost_usd: number | null;
  /** Billable tokens per shipped member (or per landed member while unshipped). */
  tokens_per_member: number | null;
  by_model: ModelTokens[];
}

/**
 * Combine the persisted batch (when `state.json` still holds it), its journal
 * lines and its reconstructed dispatch entries into one amortization summary.
 * Every source is optional: an old batch pruned from state still summarizes
 * from its journal and logs, and vice versa.
 */
export function buildBatchAmortizationSummary({
  batchId,
  batch,
  journal,
  entries,
}: {
  batchId: string;
  batch: BatchStateSlice | null;
  journal: BatchJournalSummary;
  entries: readonly RunLogEntry[];
}): BatchAmortizationSummary {
  const stateRecords = batch?.evictions ?? [];
  const handedBack = new Set<number>([
    ...(journal.handedBack ?? []),
    ...stateRecords.filter((e) => e.kind === 'handed-back').map((e) => e.issue),
  ]);
  const evicted = new Set<number>(
    [
      ...journal.evicted,
      ...stateRecords.filter((e) => e.kind !== 'handed-back').map((e) => e.issue),
    ]
      // A member the journal saw hand back is not also an eviction (pre-#810
      // journals recorded hand-backs as `unit-failed`).
      .filter((issue) => !handedBack.has(issue))
  );
  // Out of the batch before landing, whichever way it left.
  const out = new Set<number>([...evicted, ...handedBack]);
  const enqueued = new Set<number>([...journal.members, ...(batch?.members ?? []), ...out]);
  for (const entry of entries) {
    const issue = issueOfUnit(entry.unit);
    if (issue !== null) enqueued.add(issue);
  }
  const landed = journal.landed.filter((issue) => !out.has(issue));
  // Shipped = what landed on the integration branch, when the journal saw landings; only
  // a journal-less batch (rotated/other host) falls back to enqueued minus evicted.
  const shipped =
    batch !== null && SHIPPED_BATCH_STATUSES.has(batch.status)
      ? landed.length > 0
        ? landed.length
        : [...enqueued].filter((issue) => !out.has(issue)).length
      : null;
  // One CI gate per merged PR. `state.json` does not record CI re-runs, so this is a lower
  // bound; the scorecard adds the anchor's `ci_fix_attempts` where one was posted.
  const gateRuns = shipped !== null ? 1 : 0;
  const byModel = tokensByModel(entries);
  const tokenTerms = byModel.map((m) => m.billable_tokens).filter((v): v is number => v !== null);
  const costTerms = byModel.map((m) => m.total_cost_usd).filter((v): v is number => v !== null);
  const billable = tokenTerms.length > 0 ? tokenTerms.reduce((a, b) => a + b, 0) : null;
  const perMemberDenominator = shipped ?? landed.length;
  return {
    batch: batchId,
    status: batch?.status ?? null,
    pr: batch?.pr ?? null,
    members_enqueued: enqueued.size,
    members_landed: landed.length,
    evictions: evicted.size,
    handed_back: handedBack.size,
    members_shipped: shipped,
    gate_runs: gateRuns,
    issues_per_gate_run: shipped !== null && gateRuns > 0 ? shipped / gateRuns : null,
    suite_failures: journal.suiteFailures,
    billable_tokens: billable,
    total_cost_usd: costTerms.length > 0 ? costTerms.reduce((a, b) => a + b, 0) : null,
    tokens_per_member:
      billable !== null && perMemberDenominator > 0 ? billable / perMemberDenominator : null,
    by_model: byModel,
  };
}

/** One human line: members in/out, issues per gate run, tokens per member, tokens by model. */
export function formatAmortizationLine(a: BatchAmortizationSummary): string {
  const outcome =
    a.members_shipped !== null
      ? `${a.members_shipped} shipped in ${a.gate_runs} gate run(s) → ${a.issues_per_gate_run?.toFixed(1)} issues/gate run`
      : `not shipped per state.json (status=${a.status ?? 'unknown'}) → issues/gate run n/a`;
  const perMember =
    a.tokens_per_member !== null
      ? ` (${formatCount(Math.round(a.tokens_per_member))}/${a.members_shipped !== null ? 'shipped' : 'landed'} member)`
      : '';
  const models =
    a.by_model.length > 0
      ? a.by_model
          .map((m) => `${m.model ?? '<unknown>'} ${formatCount(m.billable_tokens)} ×${m.runs}`)
          .join(', ')
      : 'none recorded';
  return [
    `Summary: ${a.members_enqueued} enqueued, ${a.members_landed} landed, ${a.evictions} evicted` +
      `${a.handed_back > 0 ? `, ${a.handed_back} handed back` : ''}; ${outcome};`,
    `${formatCount(a.billable_tokens)} billable tokens${perMember}; by model: ${models}`,
  ].join(' ');
}
