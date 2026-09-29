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

import { execFileSync, spawn } from 'node:child_process';
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

// --- `--changed`: the per-member gate scopes itself to what the diff touched (#919) ---
//
// The batch member gate calls `test.focused` with only (worktree, capability id):
// the capability contract carries no changed-paths, and the runner's cwd is the
// member worktree. So the script derives them itself from git, and maps paths to
// suites. Anything it cannot place falls back to the FULL run — a wrongly wide
// gate is only slow, a wrongly narrow one lets a red member through.

/** Suite id for the repo-script tests (`npm run test:scripts`). */
export const SCRIPTS_SUITE = 'scripts';

/** Root paths whose only tests are the repo-script tests. */
const SCRIPTS_ONLY = [
  /^scripts\//,
  /^vitest\.scripts\.config\.mjs$/,
  /^docs\//,
  /^\.github\//,
  /^[^/]+\.md$/,
];

/**
 * Map each workspace dir to the workspace dirs that (transitively) depend on it:
 * a change in `packages/core` must also run the suites that consume its build.
 * Reads each workspace's package.json; `dirs` are the test workspaces.
 */
export function workspaceDependents(root, dirs) {
  const pkgs = new Map();
  for (const dir of dirs) {
    const p = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf-8'));
    pkgs.set(dir, {
      name: p.name,
      deps: Object.keys({ ...p.dependencies, ...p.devDependencies, ...p.peerDependencies }),
    });
  }
  const byName = new Map([...pkgs].map(([dir, p]) => [p.name, dir]));
  const direct = new Map(dirs.map((d) => [d, new Set()]));
  for (const [dir, p] of pkgs) {
    for (const dep of p.deps) {
      const target = byName.get(dep);
      if (target !== undefined) direct.get(target).add(dir);
    }
  }
  const closure = new Map();
  for (const dir of dirs) {
    const seen = new Set();
    const queue = [dir];
    while (queue.length > 0) {
      for (const next of direct.get(queue.pop()) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    closure.set(dir, seen);
  }
  return closure;
}

/**
 * Suites to run for a set of repo-relative changed paths. Pure.
 *
 * @param {string[]} paths
 * @param {{ workspaces: string[], dependents: Map<string, Set<string>> }} ctx
 * @returns {{ only: string[]|null, reason: string }} `only: null` means run everything
 */
export function suitesForChangedPaths(paths, { workspaces, dependents }) {
  const only = new Set([SCRIPTS_SUITE]); // cheap, and covers root-level glue
  for (const raw of paths) {
    const path = raw.replace(/^\.\//, '');
    const ws = workspaces
      .filter((dir) => path === dir || path.startsWith(`${dir}/`))
      .sort((a, b) => b.length - a.length)[0];
    if (ws !== undefined) {
      only.add(ws);
      for (const dep of dependents.get(ws) ?? []) only.add(dep);
    } else if (!SCRIPTS_ONLY.some((re) => re.test(path))) {
      return { only: null, reason: `${path} maps to no workspace` };
    }
  }
  return { only: [...only].sort(), reason: 'mapped' };
}

const git = (root, args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * Repo-relative paths this checkout changed: committed since the merge-base with
 * the base ref, plus uncommitted and untracked. Base is `$TEST_REPORT_BASE`, else
 * `origin/main`, else `main`. Returns null when git cannot answer (caller runs full).
 */
export function changedPaths(root, env = process.env) {
  const candidates = [env.TEST_REPORT_BASE, 'origin/main', 'main'].filter(Boolean);
  for (const ref of candidates) {
    try {
      const base = git(root, ['merge-base', ref, 'HEAD']).trim();
      const diff = git(root, ['diff', '--name-only', '--no-renames', base]);
      const untracked = git(root, ['ls-files', '--others', '--exclude-standard']);
      return [...new Set(`${diff}\n${untracked}`.split('\n').filter(Boolean))];
    } catch {
      // try the next candidate
    }
  }
  return null;
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
    let only = onlyArg ? onlyArg.slice('--only='.length).split(',') : null;
    if (only === null && process.argv.includes('--changed')) {
      const workspaces = discoverTestWorkspaces(root);
      const paths = changedPaths(root);
      const plan =
        paths === null
          ? { only: null, reason: 'could not diff against a base ref' }
          : suitesForChangedPaths(paths, {
              workspaces,
              dependents: workspaceDependents(root, workspaces),
            });
      process.stderr.write(
        `test-report: --changed -> ${plan.only === null ? `FULL run (${plan.reason})` : plan.only.join(', ')}\n`
      );
      only = plan.only;
    }
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
