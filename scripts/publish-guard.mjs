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
// The published version's gitHead is read from the registry's HTTP JSON API
// (`GET <registry>/<name>/<version>`), a stable public format — not from
// `npm view` output, whose shape changed under CI when npm@latest moved to
// npm 12 (a one-element array instead of an object) and turned the first
// publish run after #839 red (parser fix #842).
//
// Operating principle, shared with check-version-bumps.mjs: never FAIL OPEN.
// Anything that leaves the answer unknown (a registry answer other than 200 or
// 404, a published version with no gitHead, a gitHead that cannot be fetched)
// is "unavailable" — never a skip, which is exactly the silent outcome this
// prevents. Without --defer-collision it exits 2; with it, it is recorded in
// the ledger (as is an unexpected error in the guard itself).
//
// Usage:
//   node scripts/publish-guard.mjs --dir <package-dir> [--head <ref>]
//                                  [--repo-root <dir>] [--defer-collision <ledger>]
//   node scripts/publish-guard.mjs --report-collisions <ledger>
//
// When $GITHUB_OUTPUT is set, writes `skip=true|false` and
// `collision=true|false` there (an unavailable package writes skip=true,
// collision=false). Exit codes: 0 = publish or skip (and, under
// --defer-collision, a recorded collision/unavailable), 1 = collision
// (without --defer-collision) or --report-collisions found entries,
// 2 = the guard could not run (without --defer-collision, or the ledger
// itself could not be written).
//
// `--defer-collision <ledger>` is for the workflow only: a collision — or a
// package the guard could not decide ("unavailable") — exits 0 and is
// recorded in the ledger file, so one package's problem never stops the
// unrelated ones from publishing. Every later package checked against the
// same ledger is HELD (skip) when one of its `@ai-dossier/*` dependencies
// collided, was unavailable, or was held — it would otherwise ship against
// the older published dependency. The job's final step runs
// `--report-collisions <ledger>`, which exits 1 naming every collided and
// unavailable package. The ledger is the single list of packages, so a new
// package step cannot be forgotten in a hand-maintained `if:`.
// ------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** The registry `publish-packages.yml` publishes to. */
export const REGISTRY_URL = 'https://registry.npmjs.org';

/** Attempts for a lookup whose failure is transient (network, 5xx, 429). */
const LOOKUP_ATTEMPTS = 3;
const LOOKUP_BACKOFF_MS = [5_000, 15_000];
const backoffMs = (attempt) => LOOKUP_BACKOFF_MS[attempt - 1] ?? LOOKUP_BACKOFF_MS.at(-1);

/** Budget for fetching a published gitHead that is not in the clone. */
const GIT_FETCH_TIMEOUT_MS = 120_000;

/** npm package-name shape (optionally scoped), checked before it goes into a URL. */
const PACKAGE_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/**
 * A CheckUnavailableError worth retrying: the same request may well succeed
 * a few seconds later. Everything else (a missing gitHead, a manifest for the
 * wrong version) is permanent and is not retried.
 */
function transient(message) {
  const err = new CheckUnavailableError(message);
  err.retryable = true;
  return err;
}

/** Per-request budget for a registry lookup. */
const REGISTRY_TIMEOUT_MS = 20_000;

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

/** The gitHead of a registry version manifest, or a CheckUnavailableError. */
function requireGitHead(manifest, spec) {
  const gitHead = manifest !== null && typeof manifest === 'object' ? manifest.gitHead : undefined;
  if (typeof gitHead !== 'string' || !FULL_SHA_RE.test(gitHead)) {
    throw new CheckUnavailableError(
      `${spec} is on npm but has no usable gitHead (${oneLine(JSON.stringify(gitHead))}), so the ` +
        'guard cannot tell whether it was built from this source.\n' +
        '  Fix: bump the version so this commit publishes under a fresh number.'
    );
  }
  return { gitHead };
}

/** Refuse an answer that describes a different package or version than was asked. */
function requireIdentity(entry, name, version) {
  if (entry?.name !== name || entry?.version !== version) {
    throw new CheckUnavailableError(
      `the registry returned ${oneLine(`${entry?.name}@${entry?.version}`)} when asked ` +
        `for ${name}@${version}; refusing to compare against a different version.`
    );
  }
}

/**
 * Interpret the registry's answer to `GET <registry>/<name>/<version>`.
 *
 * 404 -> null (the version, or the whole package, is not on npm). 200 -> the
 * manifest, which must be for exactly this name and version and carry a full
 * gitHead. Anything else throws: an unexpected status or body would otherwise
 * have to be guessed as "publish" or "skip".
 */
export function parseRegistryResponse({ status, body }, name, version) {
  const spec = `${name}@${version}`;
  if (status === 404) return null;
  if (status !== 200) {
    const message =
      `the registry answered HTTP ${status} for ${spec} (${oneLine(body, 120)}).\n` +
      '  Fix: re-run the workflow once the registry is reachable; the guard will not guess.';
    if (status === 429 || status >= 500) throw transient(message);
    throw new CheckUnavailableError(message);
  }
  let manifest;
  try {
    manifest = JSON.parse(body);
  } catch (err) {
    throw new CheckUnavailableError(
      `the registry's manifest for ${spec} is not JSON (${oneLine(err.message)}).`
    );
  }
  requireIdentity(manifest, name, version);
  return requireGitHead(manifest, spec);
}

/** The exact-version manifest URL; scoped names keep `@` and encode `/`. */
export function registryUrl(name, version) {
  if (!PACKAGE_NAME_RE.test(name)) {
    throw new CheckUnavailableError(`'${oneLine(name)}' is not a valid npm package name.`);
  }
  return `${REGISTRY_URL}/${encodeURIComponent(name).replace(/^%40/, '@')}/${encodeURIComponent(version)}`;
}

/** One registry request. `fetchImpl` is injectable for tests. */
export async function registryViewOnce(name, version, { fetchImpl = fetch } = {}) {
  const url = registryUrl(name, version);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
      // A redirect to another origin must never supply the manifest we trust.
      redirect: 'error',
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
  } catch (err) {
    throw transient(`cannot reach ${url} (${oneLine(err?.message ?? err)}).`);
  }
  let body;
  try {
    body = await response.text();
  } catch (err) {
    throw transient(
      `reading the registry answer for ${name}@${version} failed (${oneLine(err?.message)}).`
    );
  }
  return parseRegistryResponse({ status: response.status, body }, name, version);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The published version's source commit, from the registry HTTP API. A
 * transient failure (network, 5xx, 429) is retried with backoff (a registry
 * blip would otherwise mark the package unavailable), then rethrown — the
 * retries narrow the window, they never turn "unknown" into "publish". A
 * permanent failure is rethrown at once.
 */
export async function registryLookup(
  name,
  version,
  { view = registryViewOnce, wait = sleep, log = console.error } = {}
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await view(name, version);
    } catch (err) {
      if (!err?.retryable || attempt >= LOOKUP_ATTEMPTS) throw err;
      log(
        `registry lookup for ${name}@${version} failed (attempt ${attempt}): ` +
          `${oneLine(err.message)}; retrying`
      );
      await wait(backoffMs(attempt));
    }
  }
}

// --- npm CLI lookup: inert fallback --------------------------------------
// Superseded by registryLookup (#826 follow-up to #842) and not called by
// run() by default. Kept as a documented fallback — e.g. for a private
// registry that needs npm's auth handling — rather than deleted. To use it,
// pass it as run()'s `lookup` option: `run(argv, { lookup: npmLookup })`.

/**
 * Parse `npm view <name>@<version> version gitHead --json` output.
 *
 * Returns null for E404 (version — or the whole package — not on npm), else
 * `{ gitHead }`. Throws for everything else: an npm error we do not
 * recognise, unparseable output, or a published version with no gitHead —
 * each would otherwise have to be guessed as "publish" or "skip".
 */
export function parseNpmView({ status, stdout, stderr }, name, version) {
  const spec = `${name}@${version}`;
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
  // `npm view` output carries `version` but not always `name`.
  requireIdentity({ name, ...entry }, name, version);
  return requireGitHead(entry, spec);
}

/** One `npm view` call. `exec` is injectable for tests. */
export function npmViewOnce(name, version, { exec = execFileSync } = {}) {
  const spec = `${name}@${version}`;
  let res;
  try {
    const stdout = exec('npm', ['view', spec, 'version', 'gitHead', '--json', '--prefer-online'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    res = { status: 0, stdout, stderr: '' };
  } catch (err) {
    res = {
      status: err.status ?? 1,
      stdout: (err.stdout ?? '').toString(),
      stderr: (err.stderr ?? '').toString(),
    };
  }
  return parseNpmView(res, name, version);
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** npm CLI lookup (inert fallback, see above), with the same retry contract. */
export function npmLookup(
  name,
  version,
  { view = npmViewOnce, sleep = sleepSync, log = console.error } = {}
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return view(name, version);
    } catch (err) {
      if (!(err instanceof CheckUnavailableError) || attempt >= LOOKUP_ATTEMPTS) throw err;
      log(
        `npm lookup for ${name}@${version} failed (attempt ${attempt}): ` +
          `${oneLine(err.message)}; retrying`
      );
      sleep(backoffMs(attempt));
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
    git(['fetch', '--no-tags', 'origin', sha], repoRoot, { timeout: GIT_FETCH_TIMEOUT_MS });
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
    throw new CheckUnavailableError(
      `cannot diff ${fromSha}..${toSha} (${oneLine(gitError(err))}).`
    );
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

/** Ledger line kinds, and how each reads in a "held" warning. */
const LEDGER_KINDS = {
  collision: 'collided',
  unavailable: 'could not be checked',
  // A package that failed before its name was known — recorded by directory.
  'unavailable-unknown': 'could not be checked (name unknown)',
  held: 'was held',
};

/**
 * The ledger shared by one publish job: one `<kind> <name>` line per package,
 * kind being one of LEDGER_KINDS. Absent file = nothing recorded yet.
 */
export function readLedger(path) {
  const entries = Object.fromEntries(Object.keys(LEDGER_KINDS).map((k) => [k, []]));
  if (!existsSync(path)) return entries;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const [kind, name] = line.trim().split(/\s+/);
    if (name && kind in entries) entries[kind].push(name);
  }
  return entries;
}

/**
 * Final step of the publish job: exit 1 naming every collided or unavailable
 * package (and the dependents held with them), else 0.
 */
export function reportCollisions(ledger, { log, error }) {
  const { collision, held, ...rest } = readLedger(ledger);
  const unavailable = [...rest.unavailable, ...rest['unavailable-unknown']];
  if (collision.length === 0 && unavailable.length === 0) {
    log('No version collisions.');
    return 0;
  }
  if (collision.length > 0) {
    error(
      `::error title=Version collision::Not released: ${collision.join(', ')} — each version is ` +
        `already on npm from different source (see the 'Check if ... needs publishing' logs). ` +
        'Bump them in a follow-up PR; every publish run fails this way until then.'
    );
  }
  if (unavailable.length > 0) {
    error(
      `::error title=Publish guard could not decide::Not checked: ${unavailable.join(', ')} — ` +
        `the guard could not determine whether these are safe to publish. Follow the Fix: line ` +
        `in each package's 'Check if ... needs publishing' log (re-run for a registry outage; ` +
        'bump the version for a missing gitHead); nothing was skipped silently.'
    );
  }
  if (held.length > 0) {
    error(`::error title=Held dependents::Also not released (held): ${held.join(', ')}.`);
  }
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

/**
 * Everything decide() needs, read from git and npm. `seen.name` is set as
 * soon as the package is known, so a later failure can still be recorded
 * under the package's name (which is what its dependents list).
 */
async function resolve({ repoRoot, dir, head }, lookup, seen) {
  let headSha;
  try {
    headSha = git(['rev-parse', `${head}^{commit}`], repoRoot);
  } catch (err) {
    throw new CheckUnavailableError(`cannot resolve --head '${head}' (${oneLine(gitError(err))}).`);
  }
  const pkg = readPackageAt(repoRoot, headSha, dir);
  seen.name = pkg.name;

  const published = await lookup(pkg.name, pkg.version);
  let diff;
  if (published !== null && published.gitHead !== headSha) {
    ensureCommit(repoRoot, published.gitHead);
    diff = releaseDiff(repoRoot, published.gitHead, headSha, dir);
  }
  return { pkg, published, headSha, diff };
}

/**
 * Why `pkg` must be held: its `@ai-dossier/*` dependencies that collided,
 * could not be checked, or were held this job — as `{ name, kind }`. A
 * package recorded only by directory (name unknown) could be any of them, so
 * it blocks every dependency in the package's own scope.
 */
function heldBy(pkg, ledger) {
  if (!ledger) return [];
  const entries = readLedger(ledger);
  const kindOf = new Map();
  for (const kind of ['collision', 'unavailable', 'held']) {
    for (const name of entries[kind]) kindOf.set(name, kind);
  }
  // Scope of this package (`@ai-dossier/`): a sibling in the same scope is a
  // workspace package, which an unknown failed package could be.
  const scope = pkg.name.startsWith('@') ? `${pkg.name.split('/')[0]}/` : null;
  const unknown = entries['unavailable-unknown'].length > 0 && scope !== null;
  return Object.keys(pkg.dependencies ?? {})
    .filter((name) => kindOf.has(name) || (unknown && name.startsWith(scope)))
    .map((name) => ({ name, kind: kindOf.get(name) ?? 'unavailable-unknown' }));
}

/** Decide for one package. Throws CheckUnavailableError when it cannot. */
async function evaluate(opts, lookup, seen) {
  const { pkg, published, headSha, diff } = await resolve(opts, lookup, seen);
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

/** Print and record a decided package; returns the exit code. */
function emitDecision({ pkg, decision, message }, ledger, { log, error, writeOutputs }) {
  if (decision.action === 'collision') {
    writeOutputs(true, true);
    // `::error::` makes it an annotation on the run summary, not just a log line.
    error(`::error title=${pkg.name}@${pkg.version} version collision::${message.split('\n')[0]}`);
    error(message);
    if (!ledger) return 1;
    appendFileSync(ledger, `collision ${pkg.name}\n`);
    return 0;
  }
  const blockers = decision.action === 'publish' ? heldBy(pkg, ledger) : [];
  if (blockers.length > 0) {
    appendFileSync(ledger, `held ${pkg.name}\n`);
    writeOutputs(true, false);
    log(message);
    const why = blockers.map((b) => `${b.name} ${LEDGER_KINDS[b.kind]}`).join(', ');
    error(
      `::warning title=${pkg.name}@${pkg.version} held::not publishing — its dependency ${why} ` +
        'this run; it would ship against the older published version.'
    );
    return 0;
  }
  writeOutputs(decision.action !== 'publish', false);
  log(message);
  return 0;
}

/** The package name for a failed run: from HEAD if known, else the working tree. */
function nameForLedger(seen, repoRoot, dir) {
  if (seen.name) return { kind: 'unavailable', name: seen.name };
  try {
    const { name } = JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8'));
    if (typeof name === 'string' && PACKAGE_NAME_RE.test(name))
      return { kind: 'unavailable', name };
  } catch {
    // Fall through: recorded by directory, which holds every dependent.
  }
  return { kind: 'unavailable-unknown', name: dir };
}

/**
 * Deferred failure: record the package and let unrelated packages proceed;
 * its dependents are held and the final report step fails the job. Never a
 * skip that reads as success. Returns the exit code.
 */
function recordUnavailable({ seen, repoRoot, dir, ledger }, { error, writeOutputs }) {
  if (!ledger) return 2;
  try {
    const { kind, name } = nameForLedger(seen, repoRoot, dir);
    appendFileSync(ledger, `${kind} ${name}\n`);
    writeOutputs(true, false);
  } catch (recordErr) {
    error(`cannot record ${dir} as unavailable (${oneLine(recordErr?.message)}).`);
    return 2;
  }
  return 0;
}

export async function run(
  argv,
  {
    log = console.log,
    error = console.error,
    lookup = registryLookup,
    outputFile = process.env.GITHUB_OUTPUT,
  } = {}
) {
  const ctx = { dir: '(unknown)', repoRoot: process.cwd(), ledger: null, seen: { name: null } };
  const writeOutputs = (skip, collision) => {
    if (outputFile) appendFileSync(outputFile, `skip=${skip}\ncollision=${collision}\n`);
  };
  try {
    const opts = parseArgs(argv);
    if (opts.reportLedger) return reportCollisions(opts.reportLedger, { log, error });
    Object.assign(ctx, { dir: opts.dir, repoRoot: opts.repoRoot, ledger: opts.ledger });
    const evaluated = await evaluate(opts, lookup, ctx.seen);
    return emitDecision(evaluated, opts.ledger, { log, error, writeOutputs });
  } catch (err) {
    const detail =
      err instanceof CheckUnavailableError
        ? err.message
        : `unexpected error (this is a bug in scripts/publish-guard.mjs).\n${err?.stack ?? String(err)}`;
    error(`::error title=publish-guard (${oneLine(ctx.dir)}) could not run::${oneLine(detail)}`);
    error(`Publish guard for ${ctx.dir} could not run: ${detail}`);
    return recordUnavailable(ctx, { error, writeOutputs });
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await run(process.argv.slice(2)).catch((err) => {
    console.error(`Publish guard could not run: ${err?.stack ?? String(err)}`);
    return 2;
  });
}
