#!/usr/bin/env node
// ------------------------------------------------------------------
// publish-guard.mjs
//
// Publish-time guard: decide whether `publish-packages.yml` should publish a
// package, skip it, or FAIL because its version number was already taken by
// different source.
//
// Why this exists (#826): the workflow used to skip any package whose version
// was already on npm. That skip is right for a re-run of the same commit and
// for a merge that did not touch the package — but it is silently wrong when
// two PRs cut from the same base both bump a package to the same number. Each
// PR's `check-version-bumps.mjs` run is individually correct against its own
// merge base; the first to merge publishes the number, and the second's
// publish run finds it taken and skips. That PR's code merged and never
// reached npm (#820 vs #821: both set cli 0.62.0, #817's change shipped only
// after a no-source follow-up bumped to 0.62.1).
//
// The publish run is the only point that sees the final state, so this guard
// lives here. npm records the commit every version was published from
// (`gitHead`), so "is this version's content the same as HEAD's?" is a git
// diff over the package's release-relevant paths — the same definition the
// PR-time guard uses — between that commit and HEAD:
//
//   version not on npm                        -> publish
//   on npm, gitHead == HEAD                   -> skip (re-run of this commit)
//   on npm, no release-relevant diff to HEAD  -> skip (unrelated merge)
//   on npm, release-relevant diff to HEAD     -> collision (fail the job)
//
// Operating principle, shared with check-version-bumps.mjs: never FAIL OPEN.
// Anything that leaves the answer unknown (an npm error that is not a 404, a
// published version with no gitHead, a gitHead that cannot be fetched) exits 2
// rather than skipping — a skip is exactly the silent outcome this prevents.
//
// Usage:
//   node scripts/publish-guard.mjs --dir <package-dir> [--head <ref>] [--repo-root <dir>]
//
// When $GITHUB_OUTPUT is set, writes `skip=true|false` and
// `collision=true|false` there. Exit codes: 0 = decided (publish, skip, or
// collision — the workflow fails the job on collision after the other
// packages are handled), 2 = the guard could not run.
// ------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CheckUnavailableError,
  changedWorkspaceDeps,
  isReleaseRelevant,
  workspaceDepsAtRef,
} from './check-version-bumps.mjs';

/** How many differing paths to name in a collision message before truncating. */
const MAX_LISTED_FILES = 10;

/**
 * Pure decision core.
 *
 * `published` is null when the exact version is not on npm, otherwise
 * `{ gitHead }`. `diff` is the release-relevant difference between that
 * gitHead and HEAD (`{ files, pins }`); it is only consulted when the version
 * is published from a different commit.
 */
export function decide({ published, headSha, diff }) {
  if (published === null) return { action: 'publish', reason: 'version-not-on-npm' };

  if (published.gitHead === headSha) return { action: 'skip', reason: 'same-commit' };

  const files = diff?.files ?? [];
  const pins = diff?.pins ?? [];
  if (files.length === 0 && pins.length === 0) {
    return { action: 'skip', reason: 'no-release-relevant-change' };
  }
  return { action: 'collision', reason: 'content-differs', files, pins };
}

/** Human-facing line(s) for a decision. Pure, so tests can assert on it. */
export function formatDecision({ name, version, published, headSha, decision }) {
  const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 12) : String(sha));
  switch (decision.action) {
    case 'publish':
      return `${name}@${version} is not on npm — publishing.`;
    case 'skip':
      return decision.reason === 'same-commit'
        ? `${name}@${version} already published from this commit (${short(headSha)}) — skipping (re-run).`
        : `${name}@${version} already published from ${short(published.gitHead)}; ` +
            `no release-relevant change since — skipping.`;
    default: {
      const lines = [
        `${name}@${version} is already on npm, published from ${short(published.gitHead)}, ` +
          `but this commit (${short(headSha)}) ships different release-relevant source.`,
        'Skipping would merge this change without ever releasing it — most likely another PR ' +
          'bumped this package to the same number and published first (#826).',
      ];
      if (decision.files.length > 0) {
        const listed = decision.files.slice(0, MAX_LISTED_FILES).join(', ');
        const more = decision.files.length > MAX_LISTED_FILES ? ', ...' : '';
        lines.push(`  Differs: ${listed}${more}`);
      }
      if (decision.pins.length > 0) lines.push(`  Repinned: ${decision.pins.join(', ')}`);
      lines.push(
        `  Fix: open a PR bumping ${name} past ${version} (npm version patch --no-git-tag-version ` +
          'in its directory); its merge publishes the unreleased change.'
      );
      return lines.join('\n');
    }
  }
}

// ---------------------------------------------------------------- IO ---------

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function errText(err) {
  const stderr = (err?.stderr ?? '').toString().trim();
  return (stderr || err?.message || String(err)).split('\n').join(' | ');
}

/**
 * Parse `npm view <name>@<version> version gitHead --json` output.
 *
 * Returns null for E404 (version — or the whole package — not on npm), else
 * `{ gitHead }`. Throws for everything else: an npm error we do not
 * recognise, unparseable output, or a published version with no gitHead —
 * each would otherwise have to be guessed as "publish" or "skip".
 */
export function parseNpmView({ status, stdout, stderr }, spec) {
  let parsed;
  try {
    parsed = stdout.trim() ? JSON.parse(stdout) : undefined;
  } catch (err) {
    throw new CheckUnavailableError(
      `npm view ${spec} printed output that is not JSON (${err.message}).\n` +
        `  stderr: ${stderr.trim().split('\n')[0] ?? ''}`
    );
  }

  if (parsed?.error) {
    if (parsed.error.code === 'E404') return null;
    throw new CheckUnavailableError(
      `npm view ${spec} failed (${parsed.error.code}: ${parsed.error.summary}).\n` +
        '  Fix: re-run the workflow once the registry is reachable; the guard will not guess.'
    );
  }
  if (status !== 0 || parsed === undefined) {
    throw new CheckUnavailableError(
      `npm view ${spec} exited ${status} without a recognisable answer.\n` +
        `  stderr: ${stderr.trim().split('\n')[0] ?? ''}`
    );
  }

  const gitHead = typeof parsed === 'object' ? parsed.gitHead : undefined;
  if (typeof gitHead !== 'string' || !/^[0-9a-f]{40}$/.test(gitHead)) {
    throw new CheckUnavailableError(
      `${spec} is on npm but has no usable gitHead (${JSON.stringify(gitHead)}), so the guard ` +
        'cannot tell whether it was built from this source.\n' +
        '  Fix: bump the version so this commit publishes under a fresh number.'
    );
  }
  return { gitHead };
}

/** Real npm lookup. `--prefer-online` sidesteps a stale local packument cache. */
export function npmLookup(name, version) {
  const spec = `${name}@${version}`;
  try {
    const stdout = execFileSync(
      'npm',
      ['view', spec, 'version', 'gitHead', '--json', '--prefer-online'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return parseNpmView({ status: 0, stdout, stderr: '' }, spec);
  } catch (err) {
    if (err instanceof CheckUnavailableError) throw err;
    return parseNpmView(
      {
        status: err.status ?? 1,
        stdout: (err.stdout ?? '').toString(),
        stderr: (err.stderr ?? '').toString(),
      },
      spec
    );
  }
}

/** Make sure `sha` is a commit in this clone, fetching it once if needed. */
function ensureCommit(repoRoot, sha) {
  const present = () => {
    try {
      git(['cat-file', '-e', `${sha}^{commit}`], repoRoot);
      return true;
    } catch {
      return false;
    }
  };
  if (present()) return;
  try {
    git(['fetch', '--no-tags', 'origin', sha], repoRoot);
  } catch (err) {
    throw new CheckUnavailableError(
      `the published gitHead ${sha} is not in this clone and could not be fetched ` +
        `(${errText(err)}).\n` +
        '  Fix: check out with fetch-depth: 0; if the commit is truly gone, bump the version.'
    );
  }
  if (!present()) {
    throw new CheckUnavailableError(`fetched ${sha} but it is still not a commit in this clone.`);
  }
}

/**
 * Release-relevant difference for `dir` between two commits: changed
 * src/bin files (tests excluded) and changed workspace-sibling pins —
 * exactly what check-version-bumps.mjs treats as needing a release.
 */
export function releaseDiff(repoRoot, fromSha, toRef, dir) {
  let names;
  try {
    names = git(['diff', '--name-only', fromSha, toRef, '--', dir], repoRoot);
  } catch (err) {
    throw new CheckUnavailableError(`cannot diff ${fromSha}..${toRef} (${errText(err)}).`);
  }
  const files = names
    .split('\n')
    .map((s) => s.trim())
    .filter((f) => f && isReleaseRelevant(f, dir));

  const fromPins = workspaceDepsAtRef(repoRoot, fromSha, dir);
  const toPins = workspaceDepsAtRef(repoRoot, toRef, dir);
  if (fromPins === null) {
    throw new CheckUnavailableError(
      `${dir}/package.json does not exist at the published commit ${fromSha}, so the ` +
        'published content cannot be compared with this one.\n' +
        '  Fix: bump the version so this commit publishes under a fresh number.'
    );
  }
  return { files, pins: changedWorkspaceDeps(fromPins, toPins ?? {}) };
}

function parseArgs(argv) {
  const opts = { dir: null, head: 'HEAD', repoRoot: process.cwd() };
  const takesValue = { '--dir': 'dir', '--head': 'head', '--repo-root': 'repoRoot' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = takesValue[argv[i]];
    const next = argv[i + 1];
    if (!key) throw new CheckUnavailableError(`unrecognised argument '${argv[i]}'.`);
    if (!next || next.startsWith('--')) {
      throw new CheckUnavailableError(`${argv[i]} requires a value.`);
    }
    opts[key] = next;
    i += 1;
  }
  if (!opts.dir) {
    throw new CheckUnavailableError(
      '--dir is required.\n  Usage: node scripts/publish-guard.mjs --dir <package-dir>'
    );
  }
  return opts;
}

export function run(
  argv,
  {
    log = console.log,
    error = console.error,
    lookup = npmLookup,
    outputFile = process.env.GITHUB_OUTPUT,
  } = {}
) {
  const writeOutputs = (skip, collision) => {
    if (outputFile) appendFileSync(outputFile, `skip=${skip}\ncollision=${collision}\n`);
  };

  try {
    const opts = parseArgs(argv);
    const { repoRoot, dir } = opts;

    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8'));
    } catch (err) {
      throw new CheckUnavailableError(`cannot read ${dir}/package.json (${err.message}).`);
    }
    if (!pkg.name || !pkg.version) {
      throw new CheckUnavailableError(`${dir}/package.json has no name/version.`);
    }

    let headSha;
    try {
      headSha = git(['rev-parse', `${opts.head}^{commit}`], repoRoot);
    } catch (err) {
      throw new CheckUnavailableError(`cannot resolve --head '${opts.head}' (${errText(err)}).`);
    }

    const published = lookup(pkg.name, pkg.version);
    let diff;
    if (published !== null && published.gitHead !== headSha) {
      ensureCommit(repoRoot, published.gitHead);
      diff = releaseDiff(repoRoot, published.gitHead, headSha, dir);
    }

    const decision = decide({ published, headSha, diff });
    const message = formatDecision({
      name: pkg.name,
      version: pkg.version,
      published,
      headSha,
      decision,
    });

    if (decision.action === 'collision') {
      // `::error::` makes it an annotation on the run summary, not just a log line.
      error(
        `::error title=${pkg.name}@${pkg.version} version collision::${message.split('\n')[0]}`
      );
      error(message);
      writeOutputs(true, true);
    } else {
      log(message);
      writeOutputs(decision.action === 'skip', false);
    }
    return 0;
  } catch (err) {
    if (err instanceof CheckUnavailableError) {
      error(`Publish guard could not run: ${err.message}`);
      return 2;
    }
    error(
      'Publish guard could not run: unexpected error (this is a bug in ' +
        `scripts/publish-guard.mjs).\n${err?.stack ?? String(err)}`
    );
    return 2;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exit(run(process.argv.slice(2)));
}
