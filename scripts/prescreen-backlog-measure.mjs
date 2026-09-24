#!/usr/bin/env node
// ------------------------------------------------------------------
// prescreen-backlog-measure.mjs
//
// Before/after measurement for #772 (parent RCA #770): run `classify
// prescreen`'s pure core over a repo's OPEN backlog and compare the pre-#772
// contract (prescreen v1 — any text-floor keyword anywhere in title + body +
// labels ⇒ `verdict: full`, i.e. excluded from batching) with the current one
// (prescreen v2+ — section/provenance-aware scan; a text-floor hit ⇒
// `verdict: candidate` + `review: full`). v3 (#805) changed only the plan:v1
// path-floor, which this label+text-only measurement never exercises, so the
// "after" columns read the same under v2 and v3.
//
// Read-only and deterministic: one `gh issue list` call, no model call, no
// writes. Issue text is never printed — only numbers, verdicts, and the
// matched keyword — so the output is safe to paste into a public PR even when
// the measured repo is private.
//
// Scope of the comparison: label + text checks only. Rule-9 open dependencies
// and the plan:v1 path-floor / file-count checks need one `gh` call per issue
// and are identical before and after #772, so they are left out of both sides.
//
// Usage:
//   node scripts/prescreen-backlog-measure.mjs --repo owner/name [--limit 500]
//                                              [--snapshot issues.json] [--json]
//
//   --snapshot  read `gh issue list --json number,title,body,labels` output
//               from a file instead of calling gh (re-run a frozen sample).
//
// Needs the built CLI (`make build-all`) — it requires cli/dist/prescreen.js.
// Exit codes: 0 = measured, 1 = could not run (bad args, no gh, no build).
// ------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Default `gh issue list --limit` — above any backlog measured so far; truncation is warned about. */
const DEFAULT_LIMIT = 500;
/** `gh issue list --json body` for a few hundred issues runs to tens of MB. */
const GH_MAX_BUFFER = 256 * 1024 * 1024;
/** The contract this script measures against; an older dist lacks `review`. */
const EXPECTED_SCHEMA = 'prescreen:v3';

/**
 * Normalise one `gh issue list --json` row into the prescreen input shape. Labels follow
 * `cli/src/gh.ts`'s `ghLabelNames`: only `{ name: string }` entries count.
 */
export function toInput(issue) {
  return {
    number: issue.number,
    title: typeof issue.title === 'string' ? issue.title : '',
    body: typeof issue.body === 'string' ? issue.body : '',
    labels: Array.isArray(issue.labels)
      ? issue.labels.map((l) => l?.name).filter((n) => typeof n === 'string')
      : [],
  };
}

/** First text-floor keyword (pattern order) matching `text`, or null — the same loop both contracts run. */
export function firstKeyword(text, patterns) {
  for (const pattern of patterns) {
    const keyword = pattern.match(text);
    if (keyword !== null) return keyword;
  }
  return null;
}

/**
 * The pre-#772 (prescreen v1) label + text verdict, reconstructed from the
 * same exported primitives v1 used: a hard-block label, or any text-floor
 * keyword over the quote-stripped title + WHOLE body + labels, ⇒ `full`.
 */
export function legacyVerdict(input, api) {
  const hardBlock = api.pickHardBlockLabel(input.labels) !== null;
  const text = api.stripQuotedSpans(`${input.title}\n${input.body}\n${input.labels.join(' ')}`);
  const keyword = firstKeyword(text, api.TEXT_FLOOR_PATTERNS);
  return { verdict: hardBlock || keyword !== null ? 'full' : 'candidate', keyword };
}

/**
 * Pure core: per-issue rows plus the aggregate counts the PR reports.
 * `api` is the subset of cli/dist exports used (injected so tests need no build).
 */
export function measureBacklog(issues, api) {
  const rows = issues.map((raw) => {
    const input = toInput(raw);
    const before = legacyVerdict(input, api);
    const after = api.prescreenIssue({
      title: input.title,
      body: input.body,
      labels: input.labels,
    });
    return {
      number: input.number,
      before: before.verdict,
      beforeKeyword: before.keyword,
      after: after.verdict,
      review: after.review,
      afterKeyword: firstKeyword(
        api.floorScanText(input.title, input.body, input.labels),
        api.TEXT_FLOOR_PATTERNS
      ),
    };
  });
  const count = (pred) => rows.filter(pred).length;
  return {
    rows,
    summary: {
      total: rows.length,
      beforeFull: count((r) => r.before === 'full'),
      afterFull: count((r) => r.after === 'full'),
      afterReviewFull: count((r) => r.review === 'full'),
      afterCandidateReviewFull: count((r) => r.after === 'candidate' && r.review === 'full'),
      /** v1 text hit that v2's section/provenance filtering no longer sees at all. */
      droppedTextHits: count((r) => r.beforeKeyword !== null && r.afterKeyword === null),
    },
  };
}

export function parseArgs(argv) {
  const opts = { limit: DEFAULT_LIMIT, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // Same guard as model-scorecard.mjs: `--snapshot --json` must not read "--json" as a path.
    const next = () => {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value.`);
      return value;
    };
    if (arg === '--repo') opts.repo = next();
    else if (arg === '--limit') opts.limit = Number(next());
    else if (arg === '--snapshot') opts.snapshot = next();
    else if (arg === '--json') opts.json = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.snapshot && !opts.repo)
    throw new Error('--repo owner/name (or --snapshot file) is required');
  if (!Number.isSafeInteger(opts.limit) || opts.limit < 1)
    throw new Error('--limit must be a positive integer');
  return opts;
}

function loadApi(repoRoot) {
  const require = createRequire(import.meta.url);
  const load = (name) => {
    const path = resolve(repoRoot, 'cli', 'dist', name);
    if (!existsSync(path)) {
      throw new Error(`cli/dist/${name} not found — run 'make build-all' first.`);
    }
    return require(path);
  };
  const prescreen = load('prescreen.js');
  const { pickHardBlockLabel } = load('hard-block-labels.js');
  if (prescreen.PRESCREEN_SCHEMA !== EXPECTED_SCHEMA) {
    throw new Error(
      `cli/dist/prescreen.js is not ${EXPECTED_SCHEMA} (found ${prescreen.PRESCREEN_SCHEMA ?? 'none'}) — rebuild with 'make build-all'.`
    );
  }
  return { ...prescreen, pickHardBlockLabel };
}

/** Read the issue list from a snapshot file or `gh`, with errors that name their source. */
function readIssues(opts) {
  const source = opts.snapshot ? `--snapshot ${opts.snapshot}` : 'gh issue list output';
  let raw;
  if (opts.snapshot) {
    raw = readFileSync(opts.snapshot, 'utf8');
  } else {
    try {
      raw = execFileSync(
        'gh',
        [
          'issue',
          'list',
          '--repo',
          opts.repo,
          '--state',
          'open',
          '--limit',
          String(opts.limit),
          '--json',
          'number,title,body,labels',
        ],
        { encoding: 'utf8', maxBuffer: GH_MAX_BUFFER }
      );
    } catch (err) {
      if (err?.code === 'ENOENT') {
        throw new Error(
          "gh CLI not found on PATH — install gh (and run 'gh auth login') or pass --snapshot <file>."
        );
      }
      throw err;
    }
  }
  let issues;
  try {
    issues = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${source}: not valid JSON (${err.message})`);
  }
  if (!Array.isArray(issues)) {
    throw new Error(
      `${source}: expected a JSON array from 'gh issue list --json number,title,body,labels'.`
    );
  }
  if (!opts.snapshot && issues.length === opts.limit) {
    console.error(
      `⚠ fetched exactly --limit ${opts.limit} issues; the backlog may be truncated — re-run with a higher --limit.`
    );
  }
  return issues;
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let rows;
  let summary;
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    const api = loadApi(repoRoot);
    ({ rows, summary } = measureBacklog(readIssues(opts), api));
  } catch (err) {
    console.error(`prescreen-backlog-measure: ${err.message}`);
    process.exit(1);
  }
  if (opts.json) {
    console.log(JSON.stringify({ summary, rows }, null, 2));
    return;
  }
  console.log(`issues measured:                 ${summary.total}`);
  console.log(`before (v1) verdict=full:        ${summary.beforeFull}`);
  console.log(`after       verdict=full:        ${summary.afterFull}`);
  console.log(`after       review=full:         ${summary.afterReviewFull}`);
  console.log(`  of which candidate+review=full: ${summary.afterCandidateReviewFull}`);
  console.log(`v1 text hits now unseen:         ${summary.droppedTextHits}`);
  console.log('');
  console.log('number  before     after      review  v1-keyword       now-keyword');
  for (const r of rows.filter((x) => x.before === 'full' || x.review === 'full')) {
    console.log(
      `${String(r.number).padEnd(7)} ${r.before.padEnd(10)} ${r.after.padEnd(10)} ${r.review.padEnd(7)} ${String(r.beforeKeyword ?? '-').padEnd(16)} ${r.afterKeyword ?? '-'}`
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
