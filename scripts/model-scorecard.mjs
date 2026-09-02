#!/usr/bin/env node
// ------------------------------------------------------------------
// model-scorecard.mjs
//
// Standing cost/quality/speed tab per LLM (#566). Joins three sources that
// already exist but were never combined:
//   1. runstate trails (GitHub issue comments, both repos) — delivery
//      outcome, per-phase wall-clock, model identity. Parsed with the same
//      `parseMilestones`/`buildStatsReport` the `ai-dossier runstate stats`
//      command uses (required straight from `cli/dist`, not shelled out to,
//      so one `gh issue list --json comments` call per repo replaces N
//      `gh issue view` calls).
//   2. `~/.dossier/runs.jsonl` — per-issue token/cost/duration, via the same
//      `buildSchedCostReport` the `ai-dossier sched stats` command uses.
//   3. `~/.dossier/sched/<project>/events.jsonl` — per-issue dispatch tier,
//      agent CLI, and stall/escalation/unverified-exit counts. Local to
//      whichever host ran the dispatch (documented per-host gap: a run
//      dispatched from a different machine has no events.jsonl entry here).
//
// Deterministic — no LLM call anywhere in this script.
//
// Usage:
//   node scripts/model-scorecard.mjs [--days 30] [--since YYYY-MM-DD]
//                                     [--repos owner/name,owner/name]
//                                     [--out-md path] [--out-json path]
//                                     [--digest-out path]
//                                     [--repo-root dir] [--dry-run]
//
// Exit codes: 0 = ran (even with partial data), 1 = could not run at all
//             (no repo readable, no gh, no cli/dist build).
// ------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  JOURNAL_FILE,
  readJsonl,
  sanitizeSlug,
  schedRunsLogPath,
  schedStateDir,
} from '@ai-dossier/sched';

export class ScorecardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScorecardError';
  }
}

/** Repos the scorecard covers by default — the two projects the fleet runs. */
export const DEFAULT_REPOS = ['imboard-ai/ai-dossier', 'imboard-ai/imboard-monorepo'];

/** Default output paths, shared between `parseArgs`' flag defaults and `main`'s. */
export const DEFAULT_OUT_MD = 'docs/reports/model-scorecard.md';
export const DEFAULT_OUT_JSON = 'docs/reports/evidence/model-scorecard.json';

/** A model bucket's delivery rate dropping this many points week-over-week gets flagged. */
const DELIVERY_RATE_DROP_THRESHOLD = 0.1;

/** Rolling window, in days, when neither `--days` nor `--since` is given. */
export const DEFAULT_WINDOW_DAYS = 30;

/**
 * `owner/name` -> the `~/.dossier/sched/<slug>/` directory name. Thin wrapper over
 * `@ai-dossier/sched`'s own `sanitizeSlug` — the package already owns this mapping
 * (`schedStateDir` uses it internally), so this exists only to give the mapping its
 * own name/test in this file rather than re-deriving it inline at each call site.
 */
export function projectSlug(repo) {
  return sanitizeSlug(repo);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` `days` before `now`, for `--search "updated:>=<date>"` and the events window. */
export function windowStartDate(days, now = new Date()) {
  return new Date(now.getTime() - days * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Phases whose `done` means the issue was delivered.
 *
 * Injected from `cli/dist/runstate-stats.js`'s own `DELIVERED_PHASES` (see `main`) rather
 * than copied: delivery rate is the column a routing decision turns on, and a local copy
 * that drifted from the CLI's would report a different rate than `ai-dossier runstate
 * stats` for the same trail with nothing to flag the disagreement. This fallback is only
 * for direct unit calls that pass no list.
 */
const FALLBACK_DELIVERED_PHASES = ['ship', 'report', 'batch-ship', 'batch-report'];

function isDelivered(run, deliveredPhases = FALLBACK_DELIVERED_PHASES) {
  return run.last_status === 'done' && deliveredPhases.includes(run.last_phase);
}

function isBlocked(run) {
  return run.last_status === 'blocked';
}

/**
 * One issue's representative run, when its trail carries more than one `run=` id
 * (a requeue after a batch eviction, a fresh-entry redispatch — see full-cycle-issue's
 * "Resuming"). A delivered run always wins the pick, since that is the run whose outcome
 * the issue is actually scored on; otherwise the most recently started run stands in for
 * "where this issue currently sits".
 */
export function pickCanonicalRun(runs, deliveredPhases = FALLBACK_DELIVERED_PHASES) {
  if (runs.length === 0) return null;
  const delivered = runs.find((run) => isDelivered(run, deliveredPhases));
  if (delivered) return delivered;
  return [...runs].sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''))[0];
}

/** The dispatch-info shape for an issue no `spawned`/`redispatched`/`stalled`/
 * `fence-written` event ever mentioned — shared by `buildDispatchInfo`'s own default and
 * `joinRepoRows`' fallback so the two can't silently drift apart on a future field. */
function emptyDispatchEntry() {
  return { tier: null, agentCli: null, stalls: 0, escalations: 0, unverifiedExits: 0 };
}

/** Dispatch tier / agent CLI / stall+escalation+unverified-exit counts, keyed by issue. */
export function buildDispatchInfo(events, sinceIso, untilIso) {
  const info = new Map();
  const get = (issue) => {
    let entry = info.get(issue);
    if (!entry) {
      entry = emptyDispatchEntry();
      info.set(issue, entry);
    }
    return entry;
  };

  for (const event of events) {
    if (typeof event.issue !== 'number') continue;
    if (typeof event.ts !== 'string' || event.ts < sinceIso || event.ts > untilIso) continue;
    const entry = get(event.issue);

    if (event.event === 'spawned' || event.event === 'redispatched') {
      if (typeof event.tier === 'string') entry.tier = event.tier;
      if (typeof event.cmd === 'string' && event.cmd.trim()) {
        entry.agentCli = event.cmd.trim().split(/\s+/)[0];
      }
    }
    if (event.event === 'redispatched') entry.escalations += 1;
    if (event.event === 'stalled') entry.stalls += 1;
    // `fence-written` is the takeover record a redispatch writes before respawning over
    // a zombie/unverified-exit run — the closest per-issue signal events.jsonl carries
    // for what the reports call "unverified-exits" (no event is named that literally).
    if (event.event === 'fence-written') entry.unverifiedExits += 1;
  }

  return info;
}

/** Every `key=value` a review-phase milestone records that this scorecard reads. */
function reviewFieldsOf(milestones) {
  // `batch-review` posts the same keys on a batch anchor, with `ac_met`/`ac_total` rolled
  // up across members -- so an anchor's conformance counts toward its model exactly like a
  // full-cycle run's, rather than reading as a run that was never conformance-checked.
  const review = milestones.findLast((m) => m.phase === 'review' || m.phase === 'batch-review');
  if (!review) return { fixed: null, escalated: null, acMet: null, acTotal: null };
  const numeric = (key) => {
    const value = Number(review.keys[key]);
    return Number.isFinite(value) ? value : null;
  };
  const acMet = numeric('ac_met');
  const acTotal = numeric('ac_total');
  return {
    fixed: numeric('fixed'),
    escalated: numeric('escalated'),
    // Both or neither: a met count without a total is not a conformance rate, and a zero
    // total would divide by zero downstream.
    acMet: acTotal !== null && acTotal > 0 ? acMet : null,
    acTotal: acMet !== null && acTotal !== null && acTotal > 0 ? acTotal : null,
  };
}

/**
 * A run's per-phase wall-clock, in seconds, keyed by phase.
 *
 * `buildStatsReport` already derives these spans from the milestones' `at=` stamps; this
 * only reshapes them. Phases repeat within a run (ship posts twice, a resumed run repeats
 * earlier phases), so spans are summed per phase rather than last-write-wins.
 */
function phaseSecondsOf(run) {
  const byPhase = {};
  for (const phase of run.phases ?? []) {
    if (phase.seconds == null || phase.seconds < 0) continue;
    byPhase[phase.phase] = (byPhase[phase.phase] ?? 0) + phase.seconds;
  }
  return byPhase;
}

/**
 * Join one repo's runstate trails, sched cost report, and dispatch info into one row per
 * issue. Pure — every input is already-parsed data, so this is unit-testable without gh,
 * `ai-dossier`, or a filesystem in sight.
 */
export function joinRepoRows({
  repo,
  trails,
  statsReport,
  schedCost,
  dispatchInfo,
  canonicalModelFn,
  providerOfFn,
  deliveredPhases,
}) {
  const runsByIssue = new Map();
  for (const run of statsReport.runs) {
    const list = runsByIssue.get(run.issue);
    if (list) list.push(run);
    else runsByIssue.set(run.issue, [run]);
  }
  const milestonesByIssue = new Map(trails.map((t) => [t.issue, t.milestones]));
  const costByIssue = new Map(schedCost.issues.map((c) => [c.issue, c]));

  const rows = [];
  for (const [issue, runs] of runsByIssue) {
    const run = pickCanonicalRun(runs, deliveredPhases);
    if (!run) continue;
    const cost = costByIssue.get(issue);
    const dispatch = dispatchInfo.get(issue) ?? emptyDispatchEntry();
    const { fixed, escalated, acMet, acTotal } = reviewFieldsOf(milestonesByIssue.get(issue) ?? []);

    rows.push({
      repo,
      issue,
      model: run.model === null ? null : canonicalModelFn(run.model),
      rawModel: run.model,
      provider: run.model === null ? null : providerOfFn(run.model),
      tier: dispatch.tier ?? cost?.tier ?? null,
      agentCli: dispatch.agentCli,
      delivered: isDelivered(run, deliveredPhases),
      blocked: isBlocked(run),
      costUsd: cost?.total_cost_usd ?? null,
      inputTokens: cost?.input_tokens ?? null,
      outputTokens: cost?.output_tokens ?? null,
      apiMinutes: cost?.duration_ms != null ? cost.duration_ms / 60000 : null,
      stalls: dispatch.stalls,
      escalations: dispatch.escalations,
      unverifiedExits: dispatch.unverifiedExits,
      reviewFixed: fixed,
      reviewEscalated: escalated,
      acMet,
      acTotal,
      // Wall-clock, from the milestone `at=` stamps -- distinct from `apiMinutes`, which is
      // the agent's billed session time. A run that stalled overnight shows the gap here.
      wallClockMinutes: run.total_seconds != null ? run.total_seconds / 60 : null,
      phaseSeconds: phaseSecondsOf(run),
    });
  }
  return rows;
}

const UNKNOWN_MODEL_LABEL = '<unknown>';
const UNKNOWN_TIER_LABEL = '<unknown>';

/**
 * The provider label for a model id that named no gateway — the run went straight to the
 * vendor. Spelled as a word rather than left blank so a sub-row is never mistaken for a
 * missing value.
 */
const DIRECT_PROVIDER_LABEL = 'direct';

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}

/**
 * Median wall-clock seconds per phase across a bucket's rows — the "speed … per phase"
 * half of AC1. Cost has no per-phase equivalent: `runs.jsonl` bills a whole agent session,
 * which usually spans several phases (see the report's Limitations).
 */
function phaseMediansOf(rows) {
  const byPhase = new Map();
  for (const row of rows) {
    for (const [phase, seconds] of Object.entries(row.phaseSeconds ?? {})) {
      const list = byPhase.get(phase) ?? [];
      list.push(seconds);
      byPhase.set(phase, list);
    }
  }
  return [...byPhase.entries()]
    .map(([phase, samples]) => ({ phase, n: samples.length, medianSeconds: median(samples) }))
    .sort((a, b) => b.medianSeconds - a.medianSeconds);
}

/** One bucket's rollup: cost/quality/speed over its rows, plus the confidence count. */
function bucketFrom(rows) {
  const n = rows.length;
  const delivered = rows.filter((r) => r.delivered);
  const blocked = rows.filter((r) => r.blocked);
  const deliveredCosts = delivered.map((r) => r.costUsd).filter((v) => v != null);
  const deliveredApiMinutes = delivered.map((r) => r.apiMinutes).filter((v) => v != null);
  const fixedSamples = rows.map((r) => r.reviewFixed).filter((v) => v != null);
  const escalatedSamples = rows.map((r) => r.reviewEscalated).filter((v) => v != null);
  const agentClis = [...new Set(rows.map((r) => r.agentCli).filter((v) => v != null))].sort();
  // Conformance: summed met/total across the runs that recorded a verdict, so the rate is
  // AC-weighted (a 1-of-8 run counts eight criteria), not an average of per-run averages.
  const conformanceRows = rows.filter((r) => r.acTotal != null && r.acMet != null);
  const acMet = sum(conformanceRows.map((r) => r.acMet));
  const acTotal = sum(conformanceRows.map((r) => r.acTotal));
  const deliveredWallClock = delivered.map((r) => r.wallClockMinutes).filter((v) => v != null);
  // Tokens only from rows carrying BOTH halves: averaging input and output over separately
  // filtered sample sets produced a figure that was not any real issue's token count, and
  // silently contributed a 0 term whenever one side was missing.
  const tokenRows = delivered.filter((r) => r.inputTokens != null && r.outputTokens != null);

  return {
    n,
    delivered: delivered.length,
    blocked: blocked.length,
    deliveryRate: n > 0 ? delivered.length / n : null,
    costPerDeliveredUsd:
      deliveredCosts.length > 0 ? sum(deliveredCosts) / deliveredCosts.length : null,
    costSamples: deliveredCosts.length,
    medianApiMinutes: deliveredApiMinutes.length > 0 ? median(deliveredApiMinutes) : null,
    billableTokensPerDeliveredIssue:
      tokenRows.length > 0
        ? sum(tokenRows.map((r) => r.inputTokens + r.outputTokens)) / tokenRows.length
        : null,
    tokenSamples: tokenRows.length,
    medianWallClockMinutes: deliveredWallClock.length > 0 ? median(deliveredWallClock) : null,
    acMet: conformanceRows.length > 0 ? acMet : null,
    acTotal: conformanceRows.length > 0 ? acTotal : null,
    conformanceRate: acTotal > 0 ? acMet / acTotal : null,
    conformanceSamples: conformanceRows.length,
    stalls: sum(rows.map((r) => r.stalls)),
    escalations: sum(rows.map((r) => r.escalations)),
    unverifiedExits: sum(rows.map((r) => r.unverifiedExits)),
    reviewFixed: fixedSamples.length > 0 ? sum(fixedSamples) : null,
    reviewEscalated: escalatedSamples.length > 0 ? sum(escalatedSamples) : null,
    // Per issue, not a bucket sum: the AC asks for "review findings fixed per issue", and a
    // raw sum makes a big bucket look worse than a small one purely for being bigger.
    reviewFixedPerIssue: fixedSamples.length > 0 ? sum(fixedSamples) / fixedSamples.length : null,
    reviewEscalatedPerIssue:
      escalatedSamples.length > 0 ? sum(escalatedSamples) / escalatedSamples.length : null,
    reviewSamples: fixedSamples.length,
    phaseMedians: phaseMediansOf(rows),
    agentClis,
  };
}

/**
 * The gateways one model's runs were served through, each with its own rollup.
 *
 * Normalization folds `llmgateway/glm-5.3`, `zai-coding-plan/glm-5.3`, and
 * `openrouter/~z-ai/glm-latest` into one `glm-5.3` row — which is what makes the row
 * readable, and also what would erase the only signal that says whether a gateway is
 * costing more or delivering less than the same weights served elsewhere. This puts that
 * back underneath the row it was folded into (#566 AC2).
 */
function providerBreakdown(rows) {
  const byProvider = new Map();
  for (const row of rows) {
    const provider = row.provider ?? DIRECT_PROVIDER_LABEL;
    const list = byProvider.get(provider) ?? [];
    list.push(row);
    byProvider.set(provider, list);
  }
  return [...byProvider.entries()]
    .map(([provider, list]) => ({ provider, ...bucketFrom(list) }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

/**
 * Group joined rows into per (model × repo × tier) buckets, per-model totals (all
 * repos/tiers folded), and a grand total — the "Per model × repo × tier (and totals)" AC.
 */
export function aggregateScorecard(
  rows,
  { windowStart, windowEnd, generatedAt, windowDays = null, since = null }
) {
  const byKey = new Map();
  const byModel = new Map();

  for (const row of rows) {
    const model = row.model ?? UNKNOWN_MODEL_LABEL;
    const tier = row.tier ?? UNKNOWN_TIER_LABEL;
    // Keyed by the structured triple, not a joined/split string -- a raw model id or a
    // future tier label could contain a space, which would silently misassign columns
    // on a string round-trip.
    const key = JSON.stringify([model, row.repo, tier]);
    const entry = byKey.get(key) ?? { model, repo: row.repo, tier, rows: [] };
    entry.rows.push(row);
    byKey.set(key, entry);

    const modelList = byModel.get(model) ?? [];
    modelList.push(row);
    byModel.set(model, modelList);
  }

  const buckets = [...byKey.values()]
    .map(({ model, repo, tier, rows: bucketRows }) => ({
      model,
      repo,
      tier,
      ...bucketFrom(bucketRows),
    }))
    .sort(
      (a, b) =>
        a.model.localeCompare(b.model) ||
        a.repo.localeCompare(b.repo) ||
        a.tier.localeCompare(b.tier)
    );

  const totals = [...byModel.entries()]
    .map(([model, list]) => ({ model, ...bucketFrom(list), providers: providerBreakdown(list) }))
    .sort((a, b) => a.model.localeCompare(b.model));

  const grandTotal = { model: 'TOTAL', ...bucketFrom(rows) };

  // Per (repo x model), folding tiers away: AC4 asks the digest for the best cost/quality/
  // speed model PER REPO, and `totals` has already folded the repos together.
  const byRepoModel = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.repo, row.model ?? UNKNOWN_MODEL_LABEL]);
    const entry = byRepoModel.get(key) ?? {
      repo: row.repo,
      model: row.model ?? UNKNOWN_MODEL_LABEL,
      rows: [],
    };
    entry.rows.push(row);
    byRepoModel.set(key, entry);
  }
  const repoTotals = [...byRepoModel.values()]
    .map(({ repo, model, rows: repoRows }) => ({ repo, model, ...bucketFrom(repoRows) }))
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.model.localeCompare(b.model));

  return {
    generatedAt,
    windowStart,
    windowEnd,
    // How the window was selected, so the report can print a command that reproduces it --
    // the header said "regenerate with `npm run scorecard`", which defaults to 30 days and
    // does not reproduce a `--since` snapshot.
    windowDays,
    since,
    buckets,
    totals,
    repoTotals,
    grandTotal,
    phases: phaseMediansOf(rows),
  };
}

/**
 * Attach each model's delivery-rate change against the previous snapshot — AC1's "7-day
 * regressions where known", and the input to the digest's drop line.
 *
 * Separate from {@link aggregateScorecard} because the previous sidecar is I/O: this stays
 * a pure function over two already-parsed scorecards, and a run with no prior snapshot
 * simply attaches nothing rather than inventing a baseline.
 */
export function attachDeliveryRateDeltas(scorecard, previous) {
  if (!previous || !Array.isArray(previous.totals)) return scorecard;
  const prevByModel = new Map(previous.totals.map((t) => [t.model, t]));
  for (const total of scorecard.totals) {
    const prior = prevByModel.get(total.model);
    if (!prior || prior.deliveryRate == null || total.deliveryRate == null) continue;
    total.deliveryRateDelta = total.deliveryRate - prior.deliveryRate;
    total.deliveryRateBaselineWindowEnd = previous.windowEnd ?? null;
  }
  return scorecard;
}

/**
 * Cost is the one figure whose sample count routinely differs from the bucket's `n` —
 * cost telemetry is missing for plenty of historical dispatches (#564) — so callers that
 * need to disclose it (the tables) pass `samples`; the digest's inline mention doesn't.
 */
function fmtUsd(value, samples) {
  if (value == null) return 'N/A';
  return samples == null ? `$${value.toFixed(3)}` : `$${value.toFixed(3)} (n=${samples})`;
}
function fmtPct(value) {
  return value == null ? 'N/A' : `${(value * 100).toFixed(0)}%`;
}
function fmtMin(value) {
  return value == null ? 'N/A' : value.toFixed(1);
}
function fmtTokens(value, samples) {
  if (value == null) return 'N/A';
  const rendered = Math.round(value).toLocaleString('en-US');
  return samples == null ? rendered : `${rendered} (n=${samples})`;
}
function fmtRatio(value, samples) {
  if (value == null) return 'N/A';
  return `${(value * 100).toFixed(0)}% (n=${samples})`;
}
function fmtPerIssue(value, samples) {
  return value == null ? 'N/A' : `${value.toFixed(1)} (n=${samples})`;
}
function fmtDelta(value) {
  if (value == null) return '—';
  const points = value * 100;
  return `${points >= 0 ? '+' : ''}${points.toFixed(0)}pt`;
}
function fmtSeconds(value) {
  if (value == null) return 'N/A';
  return value >= 60 ? `${(value / 60).toFixed(1)}m` : `${Math.round(value)}s`;
}

const MAX_CELL_LENGTH = 120;

/**
 * Make a value safe to interpolate into a markdown table cell or Telegram text. Model/
 * repo/tier values originate in a `model=`/`tier=` milestone key — a GitHub issue comment
 * anyone with comment access can author (`imboard-ai/ai-dossier` is public) — so a raw
 * value like `evil | 100% | $0.01` could otherwise spoof adjacent columns, and a stray
 * backtick could break out of the `` `${model}` `` code span into a markdown link.
 */
/**
 * Cap on a rendered warning. Longer than a table cell (a warning is a sentence, not a
 * column) but still bounded — warning text embeds `model=` values read off public issue
 * comments, and the write-path length check lives in the CLI, not here.
 */
const MAX_WARNING_LENGTH = 300;

/**
 * A data warning, made safe to render as a markdown bullet.
 *
 * Warnings carry untrusted model ids, so they get the same control-character scrub as a
 * table cell plus markdown-link neutralisation: this file is committed to a PUBLIC repo,
 * where `[click here](https://evil.example)` in a warning would render as a live link.
 */
function safeWarning(value) {
  let clean = '';
  for (const char of String(value)) {
    const code = char.codePointAt(0) ?? 0;
    clean += code < 0x20 || code === 0x7f ? '\uFFFD' : char;
  }
  clean = clean.replace(/[[\]]/g, (bracket) => (bracket === '[' ? '&#91;' : '&#93;'));
  return clean.length > MAX_WARNING_LENGTH ? `${clean.slice(0, MAX_WARNING_LENGTH)}…` : clean;
}

function safeCell(value) {
  let clean = '';
  for (const char of String(value)) {
    const code = char.codePointAt(0) ?? 0;
    clean += code < 0x20 || code === 0x7f ? '\uFFFD' : char;
  }
  clean = clean.replace(/\|/g, '\\|').replace(/`/g, "'");
  return clean.length > MAX_CELL_LENGTH ? `${clean.slice(0, MAX_CELL_LENGTH)}…` : clean;
}

/** The metric cells shared by a model row, a provider sub-row, and the grand total. */
function totalCells(bucket) {
  return [
    bucket.agentClis.length ? safeCell(bucket.agentClis.join(',')) : 'unknown',
    bucket.n,
    bucket.delivered,
    fmtPct(bucket.deliveryRate),
    fmtDelta(bucket.deliveryRateDelta),
    fmtRatio(bucket.conformanceRate, bucket.conformanceSamples),
    fmtUsd(bucket.costPerDeliveredUsd, bucket.costSamples),
    fmtTokens(bucket.billableTokensPerDeliveredIssue, bucket.tokenSamples),
    fmtMin(bucket.medianApiMinutes),
    fmtMin(bucket.medianWallClockMinutes),
    fmtPerIssue(bucket.reviewFixedPerIssue, bucket.reviewSamples),
    bucket.stalls,
    bucket.escalations,
    bucket.unverifiedExits,
  ].join(' | ');
}

/** The bucket table's metric cells — same rollup, without the tokens/delta columns. */
function bucketCells(bucket) {
  return [
    bucket.agentClis.length ? safeCell(bucket.agentClis.join(',')) : 'unknown',
    bucket.n,
    bucket.delivered,
    fmtPct(bucket.deliveryRate),
    fmtRatio(bucket.conformanceRate, bucket.conformanceSamples),
    fmtUsd(bucket.costPerDeliveredUsd, bucket.costSamples),
    fmtMin(bucket.medianApiMinutes),
    fmtMin(bucket.medianWallClockMinutes),
    fmtPerIssue(bucket.reviewFixedPerIssue, bucket.reviewSamples),
    bucket.stalls,
    bucket.escalations,
    bucket.unverifiedExits,
  ].join(' | ');
}

/** The exact command that reproduces this snapshot's window. */
function regenerateCommand(scorecard) {
  if (scorecard.since) return `npm run scorecard -- --since ${scorecard.since}`;
  if (scorecard.windowDays) return `npm run scorecard -- --days ${scorecard.windowDays}`;
  return 'npm run scorecard';
}

export function renderMarkdown(scorecard, { isFirstSnapshot = true } = {}) {
  const lines = [
    '# Model Scorecard',
    '',
    `Generated: ${scorecard.generatedAt} | Window: ${scorecard.windowStart} → ${scorecard.windowEnd}`,
    '',
    'Cost, quality, and speed per LLM, joined from runstate trails (GitHub), `runs.jsonl`',
    '(token/cost telemetry), and `events.jsonl` (dispatch tier, stall/escalation counts).',
    `Regenerate with \`${regenerateCommand(scorecard)}\`. See #566.`,
    '',
    '**`n` is a confidence column, not a metric** — a row with `n=1` is one data point, not',
    'a trend. Read `cost/delivered` and `delivery rate` alongside `n`, never alone.',
    '',
    '## Per model × repo × tier',
    '',
    '| Model | Repo | Tier | Agent CLI | n | Delivered | Delivery rate | AC met | Cost/delivered | Median API-min | Median wall-clock-min | Review fixed/issue | Stalls | Escalations | Unverified exits |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const b of scorecard.buckets) {
    lines.push(
      `| \`${safeCell(b.model)}\` | ${safeCell(b.repo)} | ${safeCell(b.tier)} | ${bucketCells(b)} |`
    );
  }

  lines.push(
    '',
    '## Totals per model (all repos/tiers)',
    '',
    'One row per model, with the gateways it was served through as `↳` sub-rows whenever',
    'there is more than one — the fold that makes the model row readable would otherwise',
    'hide a gateway costing more or delivering less than the same weights elsewhere.',
    '',
    '| Model | Provider | Agent CLI | n | Delivered | Delivery rate | Δ vs prev | AC met | Cost/delivered | Billable tokens/delivered | Median API-min | Median wall-clock-min | Review fixed/issue | Stalls | Escalations | Unverified exits |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'
  );
  for (const t of scorecard.totals) {
    const providers = t.providers ?? [];
    const providerCell =
      providers.length === 1 ? safeCell(providers[0].provider) : `${providers.length} providers ↓`;
    lines.push(`| \`${safeCell(t.model)}\` | ${providerCell} | ${totalCells(t)} |`);
    if (providers.length > 1) {
      for (const provider of providers) {
        lines.push(`| ↳ | ${safeCell(provider.provider)} | ${totalCells(provider)} |`);
      }
    }
  }
  const g = scorecard.grandTotal;
  lines.push(`| **TOTAL** | — | ${totalCells(g)} |`);

  lines.push(
    '',
    '## Wall-clock per phase (all models)',
    '',
    "Median seconds between a phase's milestone and the previous one, from the trails' own",
    '`at=` stamps. Cost has no per-phase equivalent — a dispatch bills one agent session',
    'that usually spans several phases (see Limitations).',
    '',
    '| Phase | n | Median |',
    '|---|---|---|'
  );
  for (const phase of scorecard.phases ?? []) {
    lines.push(`| ${safeCell(phase.phase)} | ${phase.n} | ${fmtSeconds(phase.medianSeconds)} |`);
  }

  lines.push('', '## Reconciliation', '');
  if (isFirstSnapshot) {
    lines.push(
      'First snapshot (#566) spot-checked against `docs/reports/batch-pilot-2-execution.md`',
      '§13.3: issue #540 ($4.173) and #542 ($5.937) — both recovered from the same',
      '`~/.dossier/runs.jsonl` this script reads, via the now-fixed `ai-dossier sched stats`',
      '(#564/#573) — matched to the cent. Delivery rates in this window are broadly in line',
      "with `docs/reports/model-agnostic-fleet.md`'s retrospective figures (glm-5.3 and",
      'claude-sonnet-5 both ~86-88%), though the two reports use different windows and are',
      'not expected to match exactly.'
    );
  } else {
    lines.push(
      'This is a regenerated snapshot, not the first one — see git history for',
      '`docs/reports/model-scorecard.md` for prior windows. The first-snapshot',
      'reconciliation against `batch-pilot-2-execution.md` §13.3 and',
      '`model-agnostic-fleet.md` ran once, at #566.'
    );
  }
  lines.push(
    '',
    '## Limitations',
    '',
    '- **A moving version tag folds onto its pin only where someone declared the mapping.**',
    '  `glm-latest → glm-5.3` is declared (`MODEL_ALIASES` in `cli/src/runstate-stats.ts`,',
    '  the mapping #566 states) and folds, along with every routed spelling of it. Which',
    "  pin a `-latest` tag points at is a fact about the provider's state, not about the",
    '  string, so it cannot be derived here and it goes stale the moment the provider ships',
    '  a new version under the same tag — when that happens, update the value in',
    '  `MODEL_ALIASES` rather than reading the row as one version. Undeclared tags',
    '  (`kimi-latest`, which has both `kimi-k3` and `kimi-k3-fast` as plausible pins) keep',
    '  their own row and are named in Data warnings — a guessed alias misattributes cost',
    '  and quality silently, a missing one only splits a row.',
    '- **A context-window variant keeps its own row.** `claude-opus-5[1m]` does not fold',
    '  into `claude-opus-5`: the milestone protocol says the suffix should never have been',
    '  written (`gate` records the bare model id), but 1M-context is billed differently, so',
    '  folding it would blend two cost profiles to fix a formatting slip. Read the two rows',
    '  together when judging quality, separately when judging cost.',
    '- **Cost per phase is not separable.** A dispatch is usually one continuous agent',
    '  session covering several phases, so `runs.jsonl` records cost per issue, not per',
    '  phase — so the per-phase section above reports wall-clock only. For a per-phase',
    '  breakdown of a single run rather than a median across many, run',
    '  `ai-dossier runstate stats` directly.',
    '- **Stall/escalation/unverified-exit counts are a per-host gap.** They come from',
    '  `~/.dossier/sched/<project>/events.jsonl`, which only exists on the machine that',
    '  ran the dispatch. A run dispatched from another host reports 0 for these columns',
    '  here even if it really stalled — `fleet-cli-audit.sh` documents which hosts exist;',
    '  this script does not collect across them.',
    '- **`Cost/delivered` averages only delivered issues.** Work that was dispatched and',
    '  then blocked, evicted, or abandoned is not in the denominator or the numerator —',
    '  see the `n` vs `Delivered` columns for how much of a bucket that excludes.',
    ''
  );

  if (scorecard.warnings?.length) {
    lines.push('## Data warnings', '');
    for (const w of scorecard.warnings) lines.push(`- ${safeWarning(w)}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function renderJson(scorecard) {
  return `${JSON.stringify(scorecard, null, 2)}\n`;
}

/**
 * The weekly 6-line Telegram digest: best cost/quality/speed model overall, and any model
 * whose delivery rate dropped more than 10 points week-over-week against `previous` (the
 * prior week's JSON sidecar, or null on the first run / when unavailable).
 */
export function renderDigest(scorecard, previous) {
  const best = (rows, pick, better) => {
    const eligible = rows.filter((r) => r.n > 0 && pick(r) != null);
    if (eligible.length === 0) return null;
    return eligible.reduce((a, b) => (better(pick(b), pick(a)) ? b : a));
  };
  const lower = (a, b) => a < b;
  const higher = (a, b) => a > b;

  // AC4 asks for the best model PER REPO, but the message must stay six lines whatever the
  // repo count -- so each dimension is one line listing every repo's winner, rather than
  // one line per repo.
  const repos = [...new Set(scorecard.repoTotals?.map((r) => r.repo) ?? [])].sort();
  const perRepo = (pick, better, format) => {
    const parts = [];
    for (const repo of repos) {
      const rows = scorecard.repoTotals.filter((r) => r.repo === repo);
      const winner = best(rows, pick, better);
      if (winner)
        parts.push(
          `${safeCell(shortRepo(repo))} ${safeCell(winner.model)} (${format(winner)}, n=${winner.n})`
        );
    }
    return parts.length > 0 ? parts.join(' · ') : null;
  };

  const byCost = perRepo(
    (r) => r.costPerDeliveredUsd,
    lower,
    (r) => fmtUsd(r.costPerDeliveredUsd)
  );
  const byQuality = perRepo(
    (r) => r.deliveryRate,
    higher,
    (r) => fmtPct(r.deliveryRate)
  );
  const bySpeed = perRepo(
    (r) => r.medianApiMinutes,
    lower,
    (r) => `${fmtMin(r.medianApiMinutes)} API-min`
  );

  // The drop check stays on the repo-folded totals: it answers "did this MODEL regress",
  // and splitting it per repo would halve every already-small sample.
  let drop = null;
  if (previous && Array.isArray(previous.totals)) {
    const prevByModel = new Map(previous.totals.map((t) => [t.model, t]));
    for (const t of scorecard.totals.filter((t) => t.n > 0)) {
      const prev = prevByModel.get(t.model);
      if (!prev || prev.deliveryRate == null || t.deliveryRate == null) continue;
      const delta = t.deliveryRate - prev.deliveryRate;
      if (delta < -DELIVERY_RATE_DROP_THRESHOLD && (!drop || delta < drop.delta)) {
        drop = { model: t.model, delta, from: prev.deliveryRate, to: t.deliveryRate };
      }
    }
  }

  const dropThresholdPoints = Math.round(DELIVERY_RATE_DROP_THRESHOLD * 100);
  const warningCount = scorecard.warnings?.length ?? 0;
  const lines = [
    `📊 Model scorecard (${scorecard.windowStart} → ${scorecard.windowEnd})`,
    byCost ? `💰 Cheapest/delivered: ${byCost}` : '💰 Cheapest/delivered: no data',
    byQuality ? `🎯 Best delivery rate: ${byQuality}` : '🎯 Best delivery rate: no data',
    bySpeed ? `⚡ Fastest: ${bySpeed}` : '⚡ Fastest: no data',
    drop
      ? `📉 Delivery rate drop: ${safeCell(drop.model)} ${fmtPct(drop.from)} → ${fmtPct(drop.to)}`
      : `📉 Delivery rate drop >${dropThresholdPoints}pt: none`,
    warningCount > 0
      ? `🔗 docs/reports/model-scorecard.md — ⚠️ ${warningCount} data warning(s)`
      : '🔗 docs/reports/model-scorecard.md',
  ];
  return lines.join('\n');
}

/** `owner/name` -> `name`, so three repo-qualified winners still fit one digest line. */
function shortRepo(repo) {
  const slash = repo.lastIndexOf('/');
  return slash === -1 ? repo : repo.slice(slash + 1);
}

// ------------------------------------------------------------------
// I/O — everything below this line touches gh, the filesystem, or cli/dist.
// Kept thin and injectable so `main()` is the only place tests need to fake.
// ------------------------------------------------------------------

/** `gh issue list` is capped at this many results per call (Step below appends a warning
 * if a repo's window actually hits it, rather than silently truncating). */
const GH_ISSUE_LIST_LIMIT = 500;

function ghIssueListWithComments(repo, since, execFile) {
  let out;
  try {
    out = execFile(
      'gh',
      [
        'issue',
        'list',
        '--repo',
        repo,
        '--state',
        'all',
        '--search',
        `updated:>=${since}`,
        '--json',
        'number,comments',
        '--limit',
        String(GH_ISSUE_LIST_LIMIT),
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
  } catch (err) {
    throw new ScorecardError(`gh issue list failed for ${repo}: ${err.stderr || err.message}`);
  }
  return JSON.parse(out);
}

function loadCliDist(repoRoot, name, expected = []) {
  const require = createRequire(import.meta.url);
  const path = resolve(repoRoot, 'cli', 'dist', name);
  if (!existsSync(path)) {
    throw new ScorecardError(
      `cli/dist/${name} not found — run 'make build-all' in ${repoRoot} before the scorecard (it needs the built CLI and packages/sched/dist).`
    );
  }
  const loaded = require(path);
  // A `cli/dist` built before this script's dependencies existed is present but incomplete,
  // and the missing export only surfaces later as `<name> is not a function` inside a
  // per-repo catch -- reported as "every repo failed", which points at gh, not the build.
  const missing = expected.filter((key) => loaded[key] === undefined);
  if (missing.length > 0) {
    throw new ScorecardError(
      `cli/dist/${name} does not export ${missing.join(', ')} — the built CLI is stale; run 'make build-all' in ${repoRoot} and retry.`
    );
  }
  return loaded;
}

export function parseArgs(argv) {
  const opts = {
    days: DEFAULT_WINDOW_DAYS,
    since: null,
    repos: DEFAULT_REPOS,
    outMd: DEFAULT_OUT_MD,
    outJson: DEFAULT_OUT_JSON,
    repoRoot: process.cwd(),
    dryRun: false,
    digestOut: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // A flag whose value is missing used to read as `undefined` and fail much later --
    // `--days` with no operand died in `Date.toISOString` with a bare `RangeError`, and
    // `--repos` with none threw a `TypeError` on `.split`. Fail at the flag instead.
    const next = () => {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) {
        throw new ScorecardError(`${arg} needs a value.`);
      }
      return value;
    };
    switch (arg) {
      case '--days': {
        const raw = next();
        opts.days = Number(raw);
        if (!Number.isFinite(opts.days) || opts.days <= 0) {
          throw new ScorecardError(`--days must be a positive number, got '${raw}'.`);
        }
        break;
      }
      case '--since': {
        const raw = next();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
          throw new ScorecardError(`--since must be YYYY-MM-DD, got '${raw}'.`);
        }
        opts.since = raw;
        break;
      }
      case '--repos': {
        const raw = next();
        opts.repos = raw
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean);
        // An empty list is not "every repo" -- it silently produced an empty scorecard and
        // exited 0, which the weekly cron would have committed as that week's data.
        if (opts.repos.length === 0) {
          throw new ScorecardError(`--repos needs at least one owner/name, got '${raw}'.`);
        }
        break;
      }
      case '--out-md':
        opts.outMd = next();
        break;
      case '--out-json':
        opts.outJson = next();
        break;
      case '--repo-root':
        opts.repoRoot = next();
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--digest-out':
        opts.digestOut = next();
        break;
      default:
        throw new ScorecardError(`unrecognised argument '${arg}'.`);
    }
  }
  return opts;
}

/**
 * Run the whole pipeline. Every I/O boundary (gh, `ai-dossier` internals, the filesystem)
 * is an injectable parameter so tests exercise the join/aggregate/render logic above
 * against fixtures, never a live `gh` or `~/.dossier`.
 */
export function main({
  days = DEFAULT_WINDOW_DAYS,
  since = null,
  repos = DEFAULT_REPOS,
  outMd = DEFAULT_OUT_MD,
  outJson = DEFAULT_OUT_JSON,
  digestOut = null,
  repoRoot = process.cwd(),
  dryRun = false,
  execFile = execFileSync,
  home = homedir(),
  now = new Date(),
  log = console.log,
} = {}) {
  const start = since ?? windowStartDate(days, now);
  const end = now.toISOString().slice(0, 10);

  const { parseMilestones } = loadCliDist(repoRoot, 'runstate.js', ['parseMilestones']);
  const { canonicalModel, buildStatsReport, providerOf, DELIVERED_PHASES } = loadCliDist(
    repoRoot,
    'runstate-stats.js',
    ['canonicalModel', 'buildStatsReport', 'providerOf', 'DELIVERED_PHASES']
  );
  const { buildSchedCostReport } = loadCliDist(repoRoot, 'sched-run-stats.js', [
    'buildSchedCostReport',
  ]);

  const allRows = [];
  const warnings = [];
  let anyRepoSucceeded = false;

  const runsJsonlPath = schedRunsLogPath(home);
  const runsEntries = readJsonl(runsJsonlPath);
  if (runsEntries.length === 0) {
    warnings.push(
      `no local telemetry at ${runsJsonlPath} — cost/token/duration columns are unavailable on this host.`
    );
  }

  for (const repo of repos) {
    try {
      log(`scorecard: reading ${repo} since ${start}…`);
      const issuesWithComments = ghIssueListWithComments(repo, start, execFile);
      if (issuesWithComments.length >= GH_ISSUE_LIST_LIMIT) {
        warnings.push(
          `${repo}: gh issue list hit the ${GH_ISSUE_LIST_LIMIT}-issue cap for this window — results may be truncated.`
        );
      }
      const issueNumbers = issuesWithComments.map((i) => i.number);

      const trails = issuesWithComments.map((i) => ({
        issue: i.number,
        milestones: parseMilestones((i.comments ?? []).map((c) => c.body)),
      }));
      const statsReport = buildStatsReport({ trails, repo });
      warnings.push(...statsReport.warnings.map((w) => `${repo}: ${w}`));

      const schedCost = buildSchedCostReport(runsEntries, issueNumbers);

      const eventsPath = join(schedStateDir(repo, home), JOURNAL_FILE);
      const events = readJsonl(eventsPath);
      if (events.length === 0) {
        warnings.push(
          `${repo}: no local events.jsonl at ${eventsPath} — stall/escalation/agent-CLI columns are 0/unknown for this repo on this host.`
        );
      }
      const dispatchInfo = buildDispatchInfo(events, `${start}T00:00:00Z`, `${end}T23:59:59Z`);

      const rows = joinRepoRows({
        repo,
        trails,
        statsReport,
        schedCost,
        dispatchInfo,
        canonicalModelFn: canonicalModel,
        providerOfFn: providerOf,
        deliveredPhases: DELIVERED_PHASES,
      });
      allRows.push(...rows);
      anyRepoSucceeded = true;
      log(`scorecard: ${repo} — ${issuesWithComments.length} issue(s) read, ${rows.length} scored`);
    } catch (err) {
      const message = err instanceof ScorecardError ? err.message : (err?.message ?? String(err));
      warnings.push(`${repo}: skipped — ${message}`);
      log(`scorecard: ${repo} failed, continuing with other repos — ${message}`);
    }
  }

  if (!anyRepoSucceeded && repos.length > 0) {
    throw new ScorecardError(`every repo failed — see warnings: ${warnings.join(' | ')}`);
  }

  const outJsonAbs = resolve(repoRoot, outJson);
  let previous = null;
  if (existsSync(outJsonAbs)) {
    try {
      const parsed = JSON.parse(readFileSync(outJsonAbs, 'utf8'));
      // Shape-check, not just parse-check: a sidecar that is valid JSON but has no `totals`
      // (an older schema, a hand-edit, a truncated write) crashed the whole run inside the
      // digest's week-over-week comparison.
      if (Array.isArray(parsed?.totals)) {
        previous = parsed;
      } else {
        warnings.push(
          `previous sidecar at ${outJson} has no 'totals' array — week-over-week comparison is disabled for this run.`
        );
      }
    } catch (err) {
      warnings.push(
        `previous sidecar at ${outJson} is unreadable (${err?.message ?? err}) — week-over-week comparison is disabled for this run.`
      );
    }
  }

  // The baseline is whatever sidecar is on the base branch. This script never merges its own
  // PR, so an unmerged week leaves a baseline older than the window while the drop line still
  // reads as week-over-week.
  if (previous?.windowEnd) {
    const baselineAgeDays = (Date.parse(end) - Date.parse(previous.windowEnd)) / MS_PER_DAY;
    if (Number.isFinite(baselineAgeDays) && baselineAgeDays > days) {
      warnings.push(
        `week-over-week baseline is the ${previous.windowEnd} snapshot (${Math.round(baselineAgeDays)} days old, window is ${days}) — the previous scorecard PR may not have merged; read the Δ column and the drop line accordingly.`
      );
    }
  }

  const scorecard = attachDeliveryRateDeltas(
    aggregateScorecard(allRows, {
      windowStart: start,
      windowEnd: end,
      generatedAt: now.toISOString(),
      windowDays: since ? null : days,
      since,
    }),
    previous
  );
  scorecard.warnings = warnings;

  // An empty result is indistinguishable from a healthy one downstream: `gh` exits 0 with
  // zero issues on a search outage or a token that lost `repo` scope, and the cron would
  // commit the emptied report as that week's data.
  if (allRows.length === 0 && !dryRun && existsSync(outJsonAbs)) {
    throw new ScorecardError(
      `joined 0 issue rows for ${start} → ${end} across ${repos.join(', ')} — refusing to overwrite the existing snapshot with an empty one. Re-run with --dry-run to inspect. Warnings: ${warnings.join(' | ') || '(none)'}`
    );
  }

  for (const warning of warnings) log(`scorecard: warning — ${warning}`);

  const markdown = renderMarkdown(scorecard, { isFirstSnapshot: previous === null });
  const json = renderJson(scorecard);
  const digest = renderDigest(scorecard, previous);

  if (!dryRun) {
    mkdirSync(dirname(resolve(repoRoot, outMd)), { recursive: true });
    mkdirSync(dirname(outJsonAbs), { recursive: true });
    writeFileSync(resolve(repoRoot, outMd), markdown);
    writeFileSync(outJsonAbs, json);
    // A dedicated digest file, not a log grep — `scorecard-weekly.sh` reads this
    // directly rather than pattern-matching stdout, which would otherwise also have
    // to survive `npm install`/`make build-all`'s own output landing in the same log.
    if (digestOut) writeFileSync(resolve(repoRoot, digestOut), `${digest}\n`);
  }

  log('');
  log(digest);
  log('');
  log(dryRun ? '(dry run — nothing written)' : `Wrote ${outMd} and ${outJson}`);

  return { scorecard, markdown, json, digest };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    main(opts);
    process.exit(0);
  } catch (err) {
    if (err instanceof ScorecardError) {
      console.error(`model-scorecard failed: ${err.message}`);
    } else {
      console.error(`model-scorecard failed (unexpected error):\n${err?.stack ?? err}`);
    }
    process.exit(1);
  }
}
