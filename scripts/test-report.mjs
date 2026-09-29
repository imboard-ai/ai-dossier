#!/usr/bin/env node
// ------------------------------------------------------------------
// test-report.mjs — the machine-readable full-suite gate (#893).
//
// `make test` runs every workspace's vitest plus the repo-script tests, but
// prints only human text. The batch suite runner (`cli/src/batch-suite-runner.ts`,
// #562) attributes a red aggregate suite to batch members by parsing ONE vitest
// JSON document (`{ testResults: [{ name, assertionResults: [...] }] }`) out of
// the capability's stdout — with no such document, EVERY red run is
// `suite-unreadable` and the batch strands (docs/agent-traps.md).
//
// This script is the `test.full` / `gate.batch` command. It runs each workspace
// suite and the script tests SEQUENTIALLY (one vitest at a time: the registry
// tests time out under concurrent load, #893), each with vitest's JSON reporter
// writing to a temp file, and merges the results into a single report:
//
//   stdout  — ONE JSON document, `{ success, numFailedTests, testResults }`.
//             Only failed tests and failed/crashed suites carry assertion
//             records (a full report of passing tests is megabytes). File
//             paths are repo-relative, because attribution compares them
//             with the members' repo-relative changed paths.
//   stderr  — each workspace's normal human-readable vitest output.
//   exit    — 0 only if every suite exited 0.
//
// A workspace that dies WITHOUT writing a report (build error, crash, a
// non-vitest `test` script) is recorded as one failed record on
// `<workspace>/package.json` carrying the output tail, so the run is still
// readable and names the culprit — attributable by bisect if no member owns
// that path — rather than collapsing into `suite-unreadable`.
// ------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Output tail kept on a crashed-suite record — enough for the real cause. */
export const TAIL_CHARS = 1500;

const toRepoRelative = (root, p) => {
  const rel = p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) ? relative(root, p) : p;
  return rel.split(sep).join('/');
};

const firstLine = (s) =>
  String(s ?? '')
    .split('\n')
    .find((l) => l.trim() !== '')
    ?.trim()
    .slice(0, 300) ?? '';

const failedRecord = (file, fullName, message) => ({
  name: file,
  status: 'failed',
  assertionResults: [{ status: 'failed', fullName, title: fullName, failureMessages: [message] }],
});

/**
 * Fold one suite run into merged `testResults` records. Pure.
 *
 * @param {{ label: string, dir: string, exitCode: number|null, report: object|null, tail: string }} run
 * @param {string} root repo root, for path relativization
 */
export function recordsForRun(run, root) {
  const { label, dir, exitCode, report, tail } = run;
  const results = Array.isArray(report?.testResults) ? report.testResults : null;
  if (results === null) {
    if (exitCode === 0) return []; // a green non-vitest suite with nothing to report
    const file = dir === '.' ? 'package.json' : `${dir}/package.json`;
    return [
      failedRecord(
        file,
        `${label}: suite exited ${exitCode ?? 'abnormally'} without a test report`,
        String(tail ?? '').slice(-TAIL_CHARS)
      ),
    ];
  }
  const out = [];
  for (const suite of results) {
    if (suite === null || typeof suite !== 'object') continue;
    const file = toRepoRelative(root, typeof suite.name === 'string' ? suite.name : dir);
    const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
    const failed = assertions
      .filter((a) => a?.status === 'failed')
      .map((a) => ({
        status: 'failed',
        fullName: a.fullName ?? a.title ?? '',
        title: a.title ?? '',
        failureMessages: a.failureMessages ?? [],
      }));
    if (failed.length > 0) {
      out.push({ name: file, status: 'failed', assertionResults: failed });
    } else if (suite.status === 'failed') {
      // The FILE failed to run (import error, syntax error, a hook that threw):
      // vitest records no assertion, and a suite with zero named failures is
      // unattributable — name the file itself.
      out.push(
        failedRecord(
          file,
          `${file} failed to run: ${firstLine(suite.message)}`,
          String(suite.message ?? '')
        )
      );
    } else {
      out.push({ name: file, status: 'passed', assertionResults: [] });
    }
  }
  // A non-zero exit whose report names nothing red (a coverage threshold, an
  // unhandled error vitest reports after the run) must not read as green.
  if (exitCode !== 0 && !out.some((r) => r.status === 'failed')) {
    const file = dir === '.' ? 'package.json' : `${dir}/package.json`;
    out.push(
      failedRecord(
        file,
        `${label}: suite exited ${exitCode ?? 'abnormally'} with no failing test in its report`,
        String(tail ?? '').slice(-TAIL_CHARS)
      )
    );
  }
  return out;
}

/** Merge per-suite runs into the single document the batch suite runner parses. Pure. */
export function mergeRuns(runs, root) {
  const testResults = runs.flatMap((run) => recordsForRun(run, root));
  const numFailedTests = testResults.reduce(
    (n, r) => n + r.assertionResults.filter((a) => a.status === 'failed').length,
    0
  );
  return {
    success: runs.every((r) => r.exitCode === 0),
    numFailedTests,
    testResults,
  };
}

/** Workspace dirs (from the root `workspaces` globs) that declare a `test` script. */
export function discoverTestWorkspaces(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
  const dirs = [];
  for (const pattern of pkg.workspaces ?? []) {
    if (pattern.endsWith('/*')) {
      const base = pattern.slice(0, -2);
      if (!existsSync(join(root, base))) continue;
      for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(`${base}/${entry.name}`);
      }
    } else {
      dirs.push(pattern);
    }
  }
  return dirs
    .filter((dir) => existsSync(join(root, dir, 'package.json')))
    .filter((dir) => {
      const p = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf-8'));
      return typeof p.scripts?.test === 'string';
    })
    .sort();
}

/** Run one `npm run` script with vitest's JSON reporter on top of the default one. */
function runSuite({ label, dir, args }, root, tmp, index) {
  const outputFile = join(tmp, `report-${index}.json`);
  return new Promise((resolve) => {
    const child = spawn(
      'npm',
      [...args, '--', '--reporter=default', '--reporter=json', `--outputFile.json=${outputFile}`],
      { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let tail = '';
    const keep = (chunk) => {
      process.stderr.write(chunk); // human output goes to stderr; stdout is the report
      tail = (tail + chunk.toString()).slice(-TAIL_CHARS * 2);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (err) =>
      resolve({ label, dir, exitCode: null, report: null, tail: err.message })
    );
    child.on('close', (code) => {
      let report = null;
      try {
        report = JSON.parse(readFileSync(outputFile, 'utf-8'));
      } catch {
        // no/partial report — recordsForRun degrades this to a named failure
      }
      resolve({ label, dir, exitCode: code, report, tail });
    });
  });
}

async function main() {
  // vitest reports realpaths; a symlinked checkout would otherwise relativize to `../…`.
  const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
  const tmp = mkdtempSync(join(tmpdir(), 'test-report-'));
  try {
    const onlyArg = process.argv.find((a) => a.startsWith('--only='));
    const only = onlyArg ? onlyArg.slice('--only='.length).split(',') : null;
    const suites = [
      ...discoverTestWorkspaces(root).map((dir) => ({
        label: dir,
        dir,
        args: ['run', 'test', '-w', dir],
      })),
      { label: 'scripts', dir: 'scripts', args: ['run', 'test:scripts'] },
    ].filter((suite) => only === null || only.includes(suite.dir));
    const runs = [];
    for (const [i, suite] of suites.entries()) {
      process.stderr.write(`\n=== test-report: ${suite.label} ===\n`);
      runs.push(await runSuite(suite, root, tmp, i));
    }
    const merged = mergeRuns(runs, root);
    // The report is the FIRST `{` on stdout and nothing else is written there.
    process.stdout.write(`${JSON.stringify(merged)}\n`);
    process.exitCode = merged.success ? 0 : 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`test-report: ${err.stack ?? err}\n`);
    process.exit(2);
  });
}
