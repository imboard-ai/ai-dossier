#!/usr/bin/env node
// ------------------------------------------------------------------
// publish-reconcile.mjs
//
// Safety net for #798: `publish-packages.yml` is triggered by the `push`
// event, and GitHub intermittently drops that event entirely (no run of ANY
// push-triggered workflow exists for the merge SHA), so a merged version bump
// is silently never published — worst when it is the last merge of a burst.
//
// This does not try to prevent the drop. It asks the same question the publish
// run asks — via scripts/publish-guard.mjs, against the checked-out main — for
// every package `publish-packages.yml` publishes, and if any would be
// published, dispatches `publish-packages.yml`. That workflow re-runs the guard
// itself and publishes in dependency order, so this script never publishes.
//
//   nothing to publish            -> no-op
//   a publish run is queued/live  -> no-op (it will publish; do not double up)
//   otherwise                     -> dispatch publish-packages.yml on main
//
// A collision or undecidable package cannot be fixed by a re-publish, so it
// does not trigger a dispatch; it does fail this job (exit 1) so it is loud.
//
// The package list is read from publish-packages.yml's `publish-guard.mjs
// --dir <dir>` steps, so a new package cannot be forgotten here.
//
// Usage (repo root, full-history checkout of main, GH_TOKEN set):
//   node scripts/publish-reconcile.mjs [--dry-run]
// ------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { run as runGuard } from './publish-guard.mjs';

export const PUBLISH_WORKFLOW = 'publish-packages.yml';

/** Package dirs the publish workflow guards, in its (dependency) order. */
export function packageDirs(workflowText) {
  return [...workflowText.matchAll(/publish-guard\.mjs --dir (\S+)/g)].map((m) => m[1]);
}

/**
 * Which of `dirs` the guard would publish. Returns
 * `{ pending: string[], problems: number }`; `problems` is the exit code of
 * the guard's --report-collisions over everything it recorded (0 or 1).
 */
export async function findPending(dirs, { guard = runGuard, log = console.log } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'publish-reconcile-'));
  const ledger = join(tmp, 'ledger');
  const pending = [];
  try {
    for (const dir of dirs) {
      const outFile = join(tmp, 'out');
      rmSync(outFile, { force: true });
      await guard(['--dir', dir, '--defer-collision', ledger], { outputFile: outFile, log });
      let out = '';
      try {
        out = readFileSync(outFile, 'utf8');
      } catch {
        // no output written: undecided, never treated as "publish"
      }
      if (/^skip=false$/m.test(out)) pending.push(dir);
    }
    const problems = await guard(['--report-collisions', ledger], { log });
    return { pending, problems: problems === 0 ? 0 : 1 };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Number of queued or in-progress runs of the publish workflow. */
export function inflightRuns(exec = execFileSync) {
  let n = 0;
  for (const status of ['queued', 'in_progress']) {
    const out = exec(
      'gh',
      [
        'run',
        'list',
        '-w',
        PUBLISH_WORKFLOW,
        '--status',
        status,
        '--json',
        'databaseId',
        '-q',
        'length',
      ],
      { encoding: 'utf8' }
    );
    n += Number(String(out).trim()) || 0;
  }
  return n;
}

export async function reconcile({
  workflowText = readFileSync(
    new URL(`../.github/workflows/${PUBLISH_WORKFLOW}`, import.meta.url),
    'utf8'
  ),
  dryRun = false,
  guard,
  inflight = inflightRuns,
  dispatch = () =>
    execFileSync('gh', ['workflow', 'run', PUBLISH_WORKFLOW, '--ref', 'main'], {
      stdio: 'inherit',
    }),
  log = console.log,
} = {}) {
  const dirs = packageDirs(workflowText);
  if (dirs.length === 0) throw new Error(`no publish-guard steps found in ${PUBLISH_WORKFLOW}`);

  const { pending, problems } = await findPending(dirs, { guard, log });
  if (pending.length === 0) {
    log('publish-reconcile: nothing to publish.');
  } else if (inflight() > 0) {
    log(
      `publish-reconcile: ${pending.join(', ')} unpublished, but a publish run is already queued or running; leaving it to that run.`
    );
  } else if (dryRun) {
    log(
      `publish-reconcile: [dry-run] would dispatch ${PUBLISH_WORKFLOW} for ${pending.join(', ')}.`
    );
  } else {
    log(
      `publish-reconcile: ${pending.join(', ')} on main but not on npm; dispatching ${PUBLISH_WORKFLOW}.`
    );
    dispatch();
  }
  return { pending, exitCode: problems };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  reconcile({ dryRun: process.argv.includes('--dry-run') })
    .then((r) => {
      process.exitCode = r.exitCode;
    })
    .catch((err) => {
      console.error(`::error title=publish-reconcile failed::${err?.message ?? err}`);
      process.exitCode = 2;
    });
}
