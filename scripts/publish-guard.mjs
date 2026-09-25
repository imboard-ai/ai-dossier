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
//   on npm, release-relevant diff to HEAD     -> collision
//
// A collision is also what an unbumped source change merged under the
// `no-release-needed` label produces: that source is on main and not on npm.
// It stays red until the package is bumped — loud on purpose.
//
// Operating principle, shared with check-version-bumps.mjs: never FAIL OPEN.
// Anything that leaves the answer unknown (an npm error that is not a 404, a
// published version with no gitHead, a gitHead that cannot be fetched) exits 2
// rather than skipping — a skip is exactly the silent outcome this prevents.
//
// Usage:
//   node scripts/publish-guard.mjs --dir <package-dir> [--head <ref>]
//                                  [--repo-root <dir>] [--defer-collision <ledger>]
//   node scripts/publish-guard.mjs --report-collisions <ledger>
//
// When $GITHUB_OUTPUT is set, writes `skip=true|false` and
// `collision=true|false` there. Exit codes: 0 = publish or skip,
// 1 = collision, 2 = the guard could not run.
//
// `--defer-collision <ledger>` is for the workflow only: a collision exits 0
// and is recorded in the ledger file, so the other packages still publish.
// Every later package checked against the same ledger is HELD (skip) when one
// of its `@ai-dossier/*` dependencies collided or was held — it would
// otherwise ship against the older published dependency. The job's final
// step runs `--report-collisions <ledger>`, which exits 1 naming every
// collided package. The ledger is the single list of packages, so a new
// package step cannot be forgotten in a hand-maintained `if:`.
// ------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  CheckUnavailableError,
  changedWorkspaceDeps,
  git,
  gitError,
  isReleaseRelevant,
  SHORT_SHA_LENGTH,
  workspaceDepsAtRef,
} from './check-version-bumps.mjs';

/** How many differing paths to name in a collision message before truncating. */
const MAX_LISTED_FILES = 10;

/** npm's `gitHead` is always a full commit sha. */
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/** Attempts for an `npm view` that fails with something other than E404. */
const NPM_LOOKUP_ATTEMPTS = 3;
const NPM_LOOKUP_BACKOFF_MS = [5_000, 15_000];

const short = (sha) => (typeof sha === 'string' ? sha.slice(0, SHORT_SHA_LENGTH) : String(sha));

/**
 * Collapse text that came from outside this repo (the npm registry, stderr) to
 * one line with no `::`, so it can never be read by the Actions runner as a
 * workflow command when printed in the privileged publish job.
 */
export function oneLine(text, max = 200) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/::/g, ': :')
    .trim()
    .slice(0, max);
}

/**
 * Pure decision core.
 *
 * `published` is null when the exact version is not on npm, otherwise
 * `{ gitHead }`. `diff` is the release-relevant difference between that
 * gitHead and HEAD (`{ files, pins }`); it is required whenever the version
 * was published from a different commit — deciding without it would have to
 * guess, and guessing "skip" is the failure this guard exists to prevent.
 */
export function decide({ published, headSha, diff }) {
  if (published === null) return { action: 'publish', reason: 'version-not-on-npm' };

  if (published.gitHead === headSha) return { action: 'skip', reason: 'same-commit' };

  if (!Array.isArray(diff?.files) || !Array.isArray(diff?.pins)) {
    throw new CheckUnavailableError(
      `decide() needs the release diff between ${short(published.gitHead)} and ` +
        `${short(headSha)} and was called without one.`
    );
  }
  if (diff.files.length === 0 && diff.pins.length === 0) {
    return { action: 'skip', reason: 'no-release-relevant-change' };
  }
  return { action: 'collision', reason: 'content-differs', files: diff.files, pins: diff.pins };
}

/** Human-facing line(s) for a decision. Pure, so tests can assert on it. */
export function formatDecision({ name, version, published, headSha, decision }) {
  switch (decision.action) {
    case 'publish':
      return `${name}@${version} is not on npm — publishing.`;
    case 'skip':
      return decision.reason === 'same-commit'
        ? `${name}@${version} already published from this commit (${short(headSha)}) — skipping (re-run).`
        : `${name}@${version} already published from ${short(published.gitHead)}; ` +
            `no release-relevant change since — skipping.`;
    case 'collision': {
      const lines = [
        `${name}@${version} is already on npm, published from ${short(published.gitHead)}, ` +
          `but this commit (${short(headSha)}) ships different release-relevant source, so ` +
          'that source is merged and NOT released.',
        'Usual causes: another PR bumped this package to the same number and published first ' +
          '(#826), or an unbumped source change merged under the `no-release-needed` label.',
      ];
      if (decision.files.length > 0) {
        const listed = decision.files.slice(0, MAX_LISTED_FILES).join(', ');
        const more = decision.files.length > MAX_LISTED_FILES ? ', ...' : '';
        lines.push(`  Differs: ${listed}${more}`);
      }
      if (decision.pins.length > 0) lines.push(`  Repinned: ${decision.pins.join(', ')}`);
      lines.push(
        `  Fix: open a PR bumping ${name} past ${version} (npm version patch --no-git-tag-version ` +
          'in its directory); its merge publishes the unreleased change. Every publish run ' +
          'fails this way until then.'
      );
      return lines.join('\n');
    }
    default:
      throw new Error(`unknown decision action '${decision.action}'`);
  }
}

// ---------------------------------------------------------------- IO ---------

/**
 * Parse `npm view <name>@<version> version gitHead --json` output.
 *
 * Returns null for E404 (version — or the whole package — not on npm), else
 * `{ gitHead }`. Throws for everything else: an npm error we do not
 * recognise, unparseable output, or a published version with no gitHead —
 * each would otherwise have to be guessed as "publish" or "skip".
 */
export function parseNpmView({ status, stdout, stderr }, spec) {
  const stderrLine = oneLine(stderr.trim().split('\n')[0]);
  let parsed;
  try {
    parsed = stdout.trim() ? JSON.parse(stdout) : undefined;
  } catch (err) {
    throw new CheckUnavailableError(
      `npm view ${spec} printed output that is not JSON (${oneLine(err.message)}).\n` +
        `  stderr: ${stderrLine}`
    );
  }

  if (parsed?.error) {
    if (parsed.error.code === 'E404') return null;
    throw new CheckUnavailableError(
      `npm view ${spec} failed (${oneLine(parsed.error.code)}: ${oneLine(parsed.error.summary)}).\n` +
        '  Fix: re-run the workflow once the registry is reachable; the guard will not guess.'
    );
  }
  if (status !== 0 || parsed === undefined) {
    throw new CheckUnavailableError(
      `npm view ${spec} exited ${status} without a recognisable answer.\n  stderr: ${stderrLine}`
    );
  }

  // npm <= 11 prints one object for an exact version; npm 12 wraps it in a
  // one-element array. More than one entry means the spec matched several
  // versions — not the exact version this guard asked about.
  if (Array.isArray(parsed) && parsed.length !== 1) {
    throw new CheckUnavailableError(
      `npm view ${spec} returned ${parsed.length} entries; expected exactly one version.`
    );
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  const gitHead = entry !== null && typeof entry === 'object' ? entry.gitHead : undefined;
  if (typeof gitHead !== 'string' || !FULL_SHA_RE.test(gitHead)) {
    throw new CheckUnavailableError(
      `${spec} is on npm but has no usable gitHead (${oneLine(JSON.stringify(gitHead))}), so the ` +
        'guard cannot tell whether it was built from this source.\n' +
        '  Fix: bump the version so this commit publishes under a fresh number.'
    );
  }
  return { gitHead };
}

function npmViewOnce(spec) {
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

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Real npm lookup. `--prefer-online` sidesteps a stale local packument cache.
 * An answer that is not E404 and not a clean hit is retried with backoff (a
 * registry blip would otherwise halt every later package), then rethrown —
 * the retries narrow the window, they never turn "unknown" into "publish".
 */
export function npmLookup(
  name,
  version,
  { view = npmViewOnce, sleep = sleepSync, log = console.error } = {}
) {
  const spec = `${name}@${version}`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return view(spec);
    } catch (err) {
      if (!(err instanceof CheckUnavailableError) || attempt >= NPM_LOOKUP_ATTEMPTS) throw err;
      const wait = NPM_LOOKUP_BACKOFF_MS[attempt - 1] ?? NPM_LOOKUP_BACKOFF_MS.at(-1);
      log(`npm lookup for ${spec} failed (attempt ${attempt}): ${oneLine(err.message)}; retrying`);
      sleep(wait);
    }
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
        `(${oneLine(gitError(err))}).\n` +
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
export function releaseDiff(repoRoot, fromSha, toSha, dir) {
  let names;
  try {
    names = git(['diff', '--name-only', fromSha, toSha, '--', dir], repoRoot);
  } catch (err) {
    throw new CheckUnavailableError(`cannot diff ${fromSha}..${toSha} (${gitError(err)}).`);
  }
  const files = names
    .split('\n')
    .map((s) => s.trim())
    .filter((f) => f && isReleaseRelevant(f, dir));

  const fromPins = workspaceDepsAtRef(repoRoot, fromSha, dir);
  const toPins = workspaceDepsAtRef(repoRoot, toSha, dir);
  if (fromPins === null) {
    throw new CheckUnavailableError(
      `${dir}/package.json does not exist at the published commit ${fromSha}, so the ` +
        'published content cannot be compared with this one.\n' +
        '  Fix: bump the version so this commit publishes under a fresh number.'
    );
  }
  return { files, pins: changedWorkspaceDeps(fromPins, toPins ?? {}) };
}

/**
 * The package's name and version at `sha` — read from the commit, not the
 * working tree, so `--head` decides both what is looked up on npm and what is
 * diffed.
 */
function readPackageAt(repoRoot, sha, dir) {
  let pkg;
  try {
    pkg = JSON.parse(git(['show', `${sha}:${dir}/package.json`], repoRoot));
  } catch (err) {
    throw new CheckUnavailableError(
      `cannot read ${dir}/package.json at ${short(sha)} (${oneLine(gitError(err))}).`
    );
  }
  if (!pkg.name || !pkg.version) {
    throw new CheckUnavailableError(`${dir}/package.json at ${short(sha)} has no name/version.`);
  }
  return pkg;
}

/**
 * The collision ledger shared by one publish job: one `collision <name>` or
 * `held <name>` line per package. Absent file = nothing recorded yet.
 */
export function readLedger(path) {
  const entries = { collision: [], held: [] };
  if (!existsSync(path)) return entries;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const [kind, name] = line.trim().split(/\s+/);
    if (name && kind in entries) entries[kind].push(name);
  }
  return entries;
}

/** Final step of the publish job: exit 1 naming every collided package, else 0. */
export function reportCollisions(ledger, { log, error }) {
  const { collision, held } = readLedger(ledger);
  if (collision.length === 0) {
    log('No version collisions.');
    return 0;
  }
  const heldNote = held.length > 0 ? ` Held with them (dependents): ${held.join(', ')}.` : '';
  error(
    `::error title=Version collision::Not released: ${collision.join(', ')} — each version is ` +
      `already on npm from different source (see the 'Check if ... needs publishing' logs).` +
      `${heldNote} Bump them in a follow-up PR; every publish run fails this way until then.`
  );
  return 1;
}

function parseArgs(argv) {
  const opts = {
    dir: null,
    head: 'HEAD',
    repoRoot: process.cwd(),
    ledger: null,
    reportLedger: null,
  };
  const takesValue = {
    '--dir': 'dir',
    '--head': 'head',
    '--repo-root': 'repoRoot',
    '--defer-collision': 'ledger',
    '--report-collisions': 'reportLedger',
  };
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
  if (!opts.dir && !opts.reportLedger) {
    throw new CheckUnavailableError(
      '--dir is required.\n  Usage: node scripts/publish-guard.mjs --dir <package-dir>'
    );
  }
  return opts;
}

/** Everything decide() needs, read from git and npm. */
function resolve({ repoRoot, dir, head }, lookup) {
  let headSha;
  try {
    headSha = git(['rev-parse', `${head}^{commit}`], repoRoot);
  } catch (err) {
    throw new CheckUnavailableError(`cannot resolve --head '${head}' (${gitError(err)}).`);
  }
  const pkg = readPackageAt(repoRoot, headSha, dir);

  const published = lookup(pkg.name, pkg.version);
  let diff;
  if (published !== null && published.gitHead !== headSha) {
    ensureCommit(repoRoot, published.gitHead);
    diff = releaseDiff(repoRoot, published.gitHead, headSha, dir);
  }
  return { pkg, published, headSha, diff };
}

/** Dependencies of `pkg` (at --head) that already collided or were held this job. */
function heldBy(pkg, ledger) {
  if (!ledger) return [];
  const { collision, held } = readLedger(ledger);
  const blocked = new Set([...collision, ...held]);
  return Object.keys(pkg.dependencies ?? {}).filter((name) => blocked.has(name));
}

/** Decide for one package. Throws CheckUnavailableError when it cannot. */
function evaluate(opts, lookup) {
  const { pkg, published, headSha, diff } = resolve(opts, lookup);
  const decision = decide({ published, headSha, diff });
  const message = formatDecision({
    name: pkg.name,
    version: pkg.version,
    published,
    headSha,
    decision,
  });
  return { pkg, decision, message };
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
  let dir = '(unknown)';
  try {
    const opts = parseArgs(argv);
    if (opts.reportLedger) return reportCollisions(opts.reportLedger, { log, error });
    dir = opts.dir;
    const { pkg, decision, message } = evaluate(opts, lookup);
    const writeOutputs = (skip, collision) => {
      if (outputFile) appendFileSync(outputFile, `skip=${skip}\ncollision=${collision}\n`);
    };

    if (decision.action !== 'collision') {
      const blockers = decision.action === 'publish' ? heldBy(pkg, opts.ledger) : [];
      if (blockers.length > 0) {
        appendFileSync(opts.ledger, `held ${pkg.name}\n`);
        writeOutputs(true, false);
        error(
          `::warning title=${pkg.name}@${pkg.version} held::not publishing — its dependency ` +
            `${blockers.join(', ')} collided; it would ship against the older published version.`
        );
        return 0;
      }
      writeOutputs(decision.action !== 'publish', false);
      log(message);
      return 0;
    }

    writeOutputs(true, true);
    // `::error::` makes it an annotation on the run summary, not just a log line.
    error(`::error title=${pkg.name}@${pkg.version} version collision::${message.split('\n')[0]}`);
    error(message);
    if (!opts.ledger) return 1;
    appendFileSync(opts.ledger, `collision ${pkg.name}\n`);
    return 0;
  } catch (err) {
    const known = err instanceof CheckUnavailableError;
    const detail = known
      ? err.message
      : `unexpected error (this is a bug in scripts/publish-guard.mjs).\n${err?.stack ?? String(err)}`;
    error(`::error title=publish-guard (${oneLine(dir)}) could not run::${oneLine(detail)}`);
    error(`Publish guard for ${dir} could not run: ${detail}`);
    return 2;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exit(run(process.argv.slice(2)));
}
