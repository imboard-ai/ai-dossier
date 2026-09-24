#!/usr/bin/env node
// ------------------------------------------------------------------
// prescreen-backlog-measure.mjs
//
// Before/after measurement for #772 (parent RCA #770): run `classify
// prescreen`'s pure core over a repo's OPEN backlog and compare the pre-#772
// contract (prescreen v1 — any text-floor keyword anywhere in title + body +
// labels ⇒ `verdict: full`, i.e. excluded from batching) with the current one
// (prescreen v2 — section/provenance-aware scan; a text-floor hit ⇒
// `verdict: candidate` + `review: full`).
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

/** Normalise one `gh issue list --json` row into the prescreen input shape. */
export function toInput(issue) {
  return {
    number: issue.number,
    title: typeof issue.title === 'string' ? issue.title : '',
    body: typeof issue.body === 'string' ? issue.body : '',
    labels: Array.isArray(issue.labels)
      ? issue.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean)
      : [],
  };
}

/**
 * The pre-#772 (prescreen v1) label + text verdict, reconstructed from the
 * same exported primitives v1 used: a hard-block label, or any text-floor
 * keyword over the quote-stripped title + WHOLE body + labels, ⇒ `full`.
 */
export function legacyVerdict(input, api) {
  const hardBlock = api.pickHardBlockLabel(input.labels) !== null;
  const text = api.stripQuotedSpans(`${input.title}\n${input.body}\n${input.labels.join(' ')}`);
  let keyword = null;
  for (const pattern of api.TEXT_FLOOR_PATTERNS) {
    keyword = pattern.match(text);
    if (keyword !== null) break;
  }
  return { verdict: hardBlock || keyword !== null ? 'full' : 'candidate', keyword };
}

/** First text-floor keyword named in a v2 reason list, or null. */
function v2Keyword(reasons) {
  const hit = reasons.find((r) => r.check === 'text-floor');
  return hit ? (/keyword: '([^']+)'/.exec(hit.message)?.[1] ?? null) : null;
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
      afterKeyword: v2Keyword(after.reasons),
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

function parseArgs(argv) {
  const opts = { limit: 500, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') opts.repo = argv[++i];
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--snapshot') opts.snapshot = argv[++i];
    else if (a === '--json') opts.json = true;
    else throw new Error(`unknown argument: ${a}`);
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
  if (typeof prescreen.floorScanText !== 'function') {
    throw new Error(
      'cli/dist/prescreen.js predates #772 (no floorScanText) — rebuild with make build-all.'
    );
  }
  return { ...prescreen, pickHardBlockLabel };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`prescreen-backlog-measure: ${err.message}`);
    process.exit(1);
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let api;
  let issues;
  try {
    api = loadApi(repoRoot);
    const raw = opts.snapshot
      ? readFileSync(opts.snapshot, 'utf8')
      : execFileSync(
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
          { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
        );
    issues = JSON.parse(raw);
  } catch (err) {
    console.error(`prescreen-backlog-measure: ${err.message}`);
    process.exit(1);
  }

  const { rows, summary } = measureBacklog(issues, api);
  if (opts.json) {
    console.log(JSON.stringify({ summary, rows }, null, 2));
    return;
  }
  console.log(`issues measured:                 ${summary.total}`);
  console.log(`before (v1) verdict=full:        ${summary.beforeFull}`);
  console.log(`after  (v2) verdict=full:        ${summary.afterFull}`);
  console.log(`after  (v2) review=full:         ${summary.afterReviewFull}`);
  console.log(`  of which candidate+review=full: ${summary.afterCandidateReviewFull}`);
  console.log(`v1 text hits v2 no longer sees:  ${summary.droppedTextHits}`);
  console.log('');
  console.log('number  before     after      review  v1-keyword       v2-keyword');
  for (const r of rows.filter((x) => x.before === 'full' || x.review === 'full')) {
    console.log(
      `${String(r.number).padEnd(7)} ${r.before.padEnd(10)} ${r.after.padEnd(10)} ${r.review.padEnd(7)} ${String(r.beforeKeyword ?? '-').padEnd(16)} ${r.afterKeyword ?? '-'}`
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
