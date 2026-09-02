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

export class ScorecardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScorecardError';
  }
}

/** Repos the scorecard covers by default — the two projects the fleet runs. */
export const DEFAULT_REPOS = ['imboard-ai/ai-dossier', 'imboard-ai/imboard-monorepo'];

/** `owner/name` -> the `~/.dossier/sched/<slug>/` directory name the CLI already uses. */
export function projectSlug(repo) {
  return repo.replace('/', '-');
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` `days` before `now`, for `--search "updated:>=<date>"` and the events window. */
export function windowStartDate(days, now = new Date()) {
  return new Date(now.getTime() - days * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Phases whose `done` means the issue was delivered.
 *
 * Mirrors `DELIVERED_PHASES` in `cli/src/runstate-stats.ts` (not exported — see the
 * module comment). Keep in sync if that list changes: `ship`/`report` are full-cycle's
 * terminal phases, `batch-ship`/`batch-report` are the batch anchor's.
 */
const DELIVERED_PHASES = ['ship', 'report', 'batch-ship', 'batch-report'];

function isDelivered(run) {
  return run.last_status === 'done' && DELIVERED_PHASES.includes(run.last_phase);
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
export function pickCanonicalRun(runs) {
  if (runs.length === 0) return null;
  const delivered = runs.find(isDelivered);
  if (delivered) return delivered;
  return [...runs].sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''))[0];
}

/** Dispatch tier / agent CLI / stall+escalation+unverified-exit counts, keyed by issue. */
export function buildDispatchInfo(events, sinceIso, untilIso) {
  const info = new Map();
  const get = (issue) => {
    let entry = info.get(issue);
    if (!entry) {
      entry = { tier: null, agentCli: null, stalls: 0, escalations: 0, unverifiedExits: 0 };
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
  const review = [...milestones].reverse().find((m) => m.phase === 'review');
  if (!review) return { fixed: null, escalated: null };
  const fixed = Number(review.keys.fixed);
  const escalated = Number(review.keys.escalated);
  return {
    fixed: Number.isFinite(fixed) ? fixed : null,
    escalated: Number.isFinite(escalated) ? escalated : null,
  };
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
    const run = pickCanonicalRun(runs);
    if (!run) continue;
    const cost = costByIssue.get(issue);
    const dispatch = dispatchInfo.get(issue) ?? {
      tier: null,
      agentCli: null,
      stalls: 0,
      escalations: 0,
      unverifiedExits: 0,
    };
    const { fixed, escalated } = reviewFieldsOf(milestonesByIssue.get(issue) ?? []);

    rows.push({
      repo,
      issue,
      model: run.model === null ? null : canonicalModelFn(run.model),
      rawModel: run.model,
      tier: dispatch.tier ?? cost?.tier ?? null,
      agentCli: dispatch.agentCli,
      delivered: isDelivered(run),
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
    });
  }
  return rows;
}

const UNKNOWN_MODEL_LABEL = '<unknown>';
const UNKNOWN_TIER_LABEL = '<unknown>';

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}

/** One bucket's rollup: cost/quality/speed over its rows, plus the confidence count. */
function bucketFrom(rows) {
  const n = rows.length;
  const delivered = rows.filter((r) => r.delivered);
  const blocked = rows.filter((r) => r.blocked);
  const deliveredCosts = delivered.map((r) => r.costUsd).filter((v) => v != null);
  const deliveredApiMinutes = delivered.map((r) => r.apiMinutes).filter((v) => v != null);
  const deliveredInputTokens = delivered.map((r) => r.inputTokens).filter((v) => v != null);
  const deliveredOutputTokens = delivered.map((r) => r.outputTokens).filter((v) => v != null);
  const fixedSamples = rows.map((r) => r.reviewFixed).filter((v) => v != null);
  const escalatedSamples = rows.map((r) => r.reviewEscalated).filter((v) => v != null);

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
      deliveredInputTokens.length > 0 || deliveredOutputTokens.length > 0
        ? sum(deliveredInputTokens) / Math.max(deliveredInputTokens.length, 1) +
          sum(deliveredOutputTokens) / Math.max(deliveredOutputTokens.length, 1)
        : null,
    stalls: sum(rows.map((r) => r.stalls)),
    escalations: sum(rows.map((r) => r.escalations)),
    unverifiedExits: sum(rows.map((r) => r.unverifiedExits)),
    reviewFixed: fixedSamples.length > 0 ? sum(fixedSamples) : null,
    reviewEscalated: escalatedSamples.length > 0 ? sum(escalatedSamples) : null,
  };
}

/**
 * Group joined rows into per (model × repo × tier) buckets, per-model totals (all
 * repos/tiers folded), and a grand total — the "Per model × repo × tier (and totals)" AC.
 */
export function aggregateScorecard(rows, { windowStart, windowEnd, generatedAt }) {
  const byKey = new Map();
  const byModel = new Map();

  for (const row of rows) {
    const model = row.model ?? UNKNOWN_MODEL_LABEL;
    const tier = row.tier ?? UNKNOWN_TIER_LABEL;
    const key = `${model} ${row.repo} ${tier}`;
    const list = byKey.get(key) ?? [];
    list.push(row);
    byKey.set(key, list);

    const modelList = byModel.get(model) ?? [];
    modelList.push(row);
    byModel.set(model, modelList);
  }

  const buckets = [...byKey.entries()]
    .map(([key, list]) => {
      const [model, repo, tier] = key.split(' ');
      return { model, repo, tier, ...bucketFrom(list) };
    })
    .sort(
      (a, b) =>
        a.model.localeCompare(b.model) ||
        a.repo.localeCompare(b.repo) ||
        a.tier.localeCompare(b.tier)
    );

  const totals = [...byModel.entries()]
    .map(([model, list]) => ({ model, ...bucketFrom(list) }))
    .sort((a, b) => a.model.localeCompare(b.model));

  const grandTotal = { model: 'TOTAL', ...bucketFrom(rows) };

  return { generatedAt, windowStart, windowEnd, buckets, totals, grandTotal };
}

function fmtUsd(value) {
  return value == null ? 'N/A' : `$${value.toFixed(3)}`;
}
/** Cost is the one figure whose sample count routinely differs from the bucket's `n` —
 * cost telemetry is missing for plenty of historical dispatches (#564) — so it carries
 * its own count rather than borrowing the bucket's, which would overstate confidence. */
function fmtUsdWithSamples(value, samples) {
  return value == null ? 'N/A' : `$${value.toFixed(3)} (n=${samples})`;
}
function fmtPct(value) {
  return value == null ? 'N/A' : `${(value * 100).toFixed(0)}%`;
}
function fmtMin(value) {
  return value == null ? 'N/A' : value.toFixed(1);
}
function fmtTokens(value) {
  return value == null ? 'N/A' : Math.round(value).toLocaleString('en-US');
}

export function renderMarkdown(scorecard) {
  const lines = [
    '# Model Scorecard',
    '',
    `Generated: ${scorecard.generatedAt} | Window: ${scorecard.windowStart} → ${scorecard.windowEnd}`,
    '',
    'Cost, quality, and speed per LLM, joined from runstate trails (GitHub), `runs.jsonl`',
    '(token/cost telemetry), and `events.jsonl` (dispatch tier, stall/escalation counts).',
    'Regenerate with `npm run scorecard`. See #566.',
    '',
    '**`n` is a confidence column, not a metric** — a row with `n=1` is one data point, not',
    'a trend. Read `cost/delivered` and `delivery rate` alongside `n`, never alone.',
    '',
    '## Per model × repo × tier',
    '',
    '| Model | Repo | Tier | n | Delivered | Delivery rate | Cost/delivered | Median API-min | Stalls | Escalations | Unverified exits |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const b of scorecard.buckets) {
    lines.push(
      `| \`${b.model}\` | ${b.repo} | ${b.tier} | ${b.n} | ${b.delivered} | ${fmtPct(b.deliveryRate)} | ${fmtUsdWithSamples(b.costPerDeliveredUsd, b.costSamples)} | ${fmtMin(b.medianApiMinutes)} | ${b.stalls} | ${b.escalations} | ${b.unverifiedExits} |`
    );
  }

  lines.push(
    '',
    '## Totals per model (all repos/tiers)',
    '',
    '| Model | n | Delivered | Delivery rate | Cost/delivered | Billable tokens/delivered | Median API-min | Stalls | Escalations | Unverified exits |',
    '|---|---|---|---|---|---|---|---|---|---|'
  );
  for (const t of scorecard.totals) {
    lines.push(
      `| \`${t.model}\` | ${t.n} | ${t.delivered} | ${fmtPct(t.deliveryRate)} | ${fmtUsdWithSamples(t.costPerDeliveredUsd, t.costSamples)} | ${fmtTokens(t.billableTokensPerDeliveredIssue)} | ${fmtMin(t.medianApiMinutes)} | ${t.stalls} | ${t.escalations} | ${t.unverifiedExits} |`
    );
  }
  const g = scorecard.grandTotal;
  lines.push(
    `| **TOTAL** | ${g.n} | ${g.delivered} | ${fmtPct(g.deliveryRate)} | ${fmtUsdWithSamples(g.costPerDeliveredUsd, g.costSamples)} | ${fmtTokens(g.billableTokensPerDeliveredIssue)} | ${fmtMin(g.medianApiMinutes)} | ${g.stalls} | ${g.escalations} | ${g.unverifiedExits} |`
  );

  lines.push(
    '',
    '## Reconciliation',
    '',
    'First snapshot (#566) spot-checked against `docs/reports/batch-pilot-2-execution.md`',
    '§13.1: issue #540 ($4.173) and #542 ($5.937) — both recovered from the same',
    '`~/.dossier/runs.jsonl` this script reads, via the now-fixed `ai-dossier sched stats`',
    '(#564/#573) — matched to the cent.',
    '',
    '## Limitations',
    '',
    '- **Cost per phase is not separable.** A dispatch is usually one continuous agent',
    '  session covering several phases, so `runs.jsonl` records cost per issue, not per',
    '  phase. Wall-clock per phase exists (via `ai-dossier runstate stats`) but is not',
    '  joined here to keep this table to one row per bucket; run that command directly',
    '  for a phase breakdown.',
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
    for (const w of scorecard.warnings) lines.push(`- ${w}`);
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
  const ranked = scorecard.totals.filter((t) => t.n > 0);
  const byCost = [...ranked]
    .filter((t) => t.costPerDeliveredUsd != null)
    .sort((a, b) => a.costPerDeliveredUsd - b.costPerDeliveredUsd)[0];
  const byQuality = [...ranked]
    .filter((t) => t.deliveryRate != null)
    .sort((a, b) => b.deliveryRate - a.deliveryRate)[0];
  const bySpeed = [...ranked]
    .filter((t) => t.medianApiMinutes != null)
    .sort((a, b) => a.medianApiMinutes - b.medianApiMinutes)[0];

  let drop = null;
  if (previous) {
    const prevByModel = new Map(previous.totals.map((t) => [t.model, t]));
    for (const t of ranked) {
      const prev = prevByModel.get(t.model);
      if (!prev || prev.deliveryRate == null || t.deliveryRate == null) continue;
      const delta = t.deliveryRate - prev.deliveryRate;
      if (delta < -0.1 && (!drop || delta < drop.delta)) {
        drop = { model: t.model, delta, from: prev.deliveryRate, to: t.deliveryRate };
      }
    }
  }

  const lines = [
    `📊 Model scorecard (${scorecard.windowStart} → ${scorecard.windowEnd})`,
    byCost
      ? `💰 Cheapest/delivered: ${byCost.model} (${fmtUsd(byCost.costPerDeliveredUsd)}, n=${byCost.n})`
      : '💰 Cheapest/delivered: no data',
    byQuality
      ? `🎯 Best delivery rate: ${byQuality.model} (${fmtPct(byQuality.deliveryRate)}, n=${byQuality.n})`
      : '🎯 Best delivery rate: no data',
    bySpeed
      ? `⚡ Fastest: ${bySpeed.model} (${fmtMin(bySpeed.medianApiMinutes)} API-min, n=${bySpeed.n})`
      : '⚡ Fastest: no data',
    drop
      ? `📉 Delivery rate drop: ${drop.model} ${fmtPct(drop.from)} → ${fmtPct(drop.to)}`
      : '📉 Delivery rate drop >10pt: none',
    '🔗 docs/reports/model-scorecard.md',
  ];
  return lines.join('\n');
}

// ------------------------------------------------------------------
// I/O — everything below this line touches gh, the filesystem, or cli/dist.
// Kept thin and injectable so `main()` is the only place tests need to fake.
// ------------------------------------------------------------------

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
        '500',
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
  } catch (err) {
    throw new ScorecardError(`gh issue list failed for ${repo}: ${err.stderr || err.message}`);
  }
  return JSON.parse(out);
}

function loadJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((v) => v !== null);
}

function loadCliDist(repoRoot, name) {
  const require = createRequire(import.meta.url);
  const path = resolve(repoRoot, 'cli', 'dist', name);
  if (!existsSync(path)) {
    throw new ScorecardError(
      `cli/dist/${name} not found — run 'make build-all' before the scorecard (needs the built CLI for milestone parsing).`
    );
  }
  return require(path);
}

function parseArgs(argv) {
  const opts = {
    days: 30,
    since: null,
    repos: DEFAULT_REPOS,
    outMd: 'docs/reports/model-scorecard.md',
    outJson: 'docs/reports/evidence/model-scorecard.json',
    repoRoot: process.cwd(),
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--days':
        opts.days = Number(next());
        break;
      case '--since':
        opts.since = next();
        break;
      case '--repos':
        opts.repos = next()
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean);
        break;
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
  days = 30,
  since = null,
  repos = DEFAULT_REPOS,
  outMd = 'docs/reports/model-scorecard.md',
  outJson = 'docs/reports/evidence/model-scorecard.json',
  repoRoot = process.cwd(),
  dryRun = false,
  execFile = execFileSync,
  home = homedir(),
  now = new Date(),
  log = console.log,
} = {}) {
  const start = since ?? windowStartDate(days, now);
  const end = now.toISOString().slice(0, 10);

  const { parseMilestones } = loadCliDist(repoRoot, 'runstate.js');
  const { canonicalModel, buildStatsReport } = loadCliDist(repoRoot, 'runstate-stats.js');
  const { buildSchedCostReport } = loadCliDist(repoRoot, 'sched-run-stats.js');

  const allRows = [];
  const warnings = [];

  for (const repo of repos) {
    log(`scorecard: reading ${repo} since ${start}…`);
    const issuesWithComments = ghIssueListWithComments(repo, start, execFile);
    const issueNumbers = issuesWithComments.map((i) => i.number);

    const trails = issuesWithComments.map((i) => ({
      issue: i.number,
      milestones: parseMilestones((i.comments ?? []).map((c) => c.body)),
    }));
    const statsReport = buildStatsReport({ trails, repo });
    warnings.push(...statsReport.warnings.map((w) => `${repo}: ${w}`));

    const runsJsonlPath = join(home, '.dossier', 'runs.jsonl');
    const entries = loadJsonl(runsJsonlPath);
    const schedCost = buildSchedCostReport(entries, issueNumbers);

    const eventsPath = join(home, '.dossier', 'sched', projectSlug(repo), 'events.jsonl');
    const events = loadJsonl(eventsPath);
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
    });
    allRows.push(...rows);
  }

  const scorecard = aggregateScorecard(allRows, {
    windowStart: start,
    windowEnd: end,
    generatedAt: now.toISOString(),
  });
  scorecard.warnings = warnings;

  const outJsonAbs = resolve(repoRoot, outJson);
  let previous = null;
  if (existsSync(outJsonAbs)) {
    try {
      previous = JSON.parse(readFileSync(outJsonAbs, 'utf8'));
    } catch {
      previous = null;
    }
  }

  const markdown = renderMarkdown(scorecard);
  const json = renderJson(scorecard);
  const digest = renderDigest(scorecard, previous);

  if (!dryRun) {
    mkdirSync(dirname(resolve(repoRoot, outMd)), { recursive: true });
    mkdirSync(dirname(outJsonAbs), { recursive: true });
    writeFileSync(resolve(repoRoot, outMd), markdown);
    writeFileSync(outJsonAbs, json);
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
