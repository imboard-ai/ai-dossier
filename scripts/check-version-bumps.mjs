#!/usr/bin/env node
// ------------------------------------------------------------------
// check-version-bumps.mjs
//
// PR guard: fail when a pull request changes a publishable package's
// release-relevant source but leaves its `package.json` version equal to
// the version on the base branch.
//
// Why this exists: `publish-packages.yml` skips publishing a package whose
// current version already exists on npm. That skip is correct, but it made
// "merged" quietly stop meaning "released" — #442 (worktree-pool 0.5.2) and
// #446 (cli 0.10.0) both merged unbumped and never reached npm. This guard
// moves the signal to PR time, where it is still cheap to act on.
//
// This script deliberately lives in `scripts/` rather than inside any
// package's `src/`, so editing the guard never trips the guard.
//
// Operating principle: the guard must never FAIL OPEN. Every condition that
// would leave it checking nothing (unreachable base ref, no discoverable
// workspaces, an unparseable package.json, a failed `git show`) exits 2 with a
// named cause and a fix, instead of printing "passed" over an empty check.
//
// Usage:
//   node scripts/check-version-bumps.mjs [--base <ref>] [--head <ref>]
//                                        [--labels <csv>] [--repo-root <dir>]
//
// Exit codes: 0 = pass (or skipped by label), 1 = violations found,
//             2 = the check could not run (e.g. unreachable base ref).
// ------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Label that lets an author opt a PR out of the guard (AC4). */
export const ESCAPE_LABEL = 'no-release-needed';

/** Directories inside a package whose contents ship to npm consumers. */
const RELEASE_DIRS = ['src', 'bin'];

/** How many changed paths to list per violating package before truncating. */
const MAX_LISTED_FILES = 5;

/** Characters that make the merge-base sha readable in a log without being ambiguous. */
const SHORT_SHA_LENGTH = 12;

/** Paths that live under a release dir but never change published behaviour. */
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIR_RE = /(^|\/)(__tests__|__mocks__|__fixtures__|fixtures)\//;

/**
 * Raised when the guard cannot determine an answer. Callers map this to exit 2
 * ("could not run") — never to exit 0 — so a broken environment is loud rather
 * than silently green.
 */
export class CheckUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CheckUnavailableError';
  }
}

/**
 * True when a changed repo-relative path is release-relevant for `packageDir`.
 *
 * Test files are excluded on purpose and the exclusion is load-bearing: every
 * package in this repo keeps its vitest specs *inside* `src/` as `*.test.ts`,
 * so without this a docs/test-only PR would fail the guard (AC2).
 */
export function isReleaseRelevant(changedPath, packageDir) {
  const prefix = `${packageDir}/`;
  if (!changedPath.startsWith(prefix)) return false;

  const rest = changedPath.slice(prefix.length);
  const topDir = rest.split('/')[0];
  if (!RELEASE_DIRS.includes(topDir)) return false;

  if (TEST_FILE_RE.test(rest)) return false;
  if (TEST_DIR_RE.test(rest)) return false;

  return true;
}

/**
 * Expand the root package.json `workspaces` globs into concrete directories.
 * Only the trailing-`*` form used by this repo (`packages/*`) and plain paths
 * are supported — enough for npm workspaces, and no dependency required.
 */
function expandWorkspaceGlobs(repoRoot, patterns) {
  const dirs = [];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new CheckUnavailableError(
        `the root package.json \`workspaces\` array contains a non-string entry ` +
          `(${JSON.stringify(pattern)}), so the package list cannot be trusted.`
      );
    }

    const parentPart = pattern.endsWith('/*') ? pattern.slice(0, -2) : pattern;
    if (/[*?[\]!]/.test(parentPart)) {
      // Silently expanding to nothing is the dangerous outcome: every package
      // would go unguarded while the check still printed green.
      throw new CheckUnavailableError(
        `the root package.json workspaces entry '${pattern}' uses a glob shape this ` +
          'guard cannot expand, so it would contribute zero packages and quietly ' +
          'leave them unchecked.\n' +
          "  Supported: a plain path ('cli') or a trailing single star ('packages/*').\n" +
          '  Fix: use a supported shape, or teach expandWorkspaceGlobs() in ' +
          'scripts/check-version-bumps.mjs how to expand this one.'
      );
    }

    if (!pattern.endsWith('/*')) {
      dirs.push(pattern);
      continue;
    }
    const parentAbs = join(repoRoot, parentPart);
    if (!existsSync(parentAbs)) continue;
    for (const entry of readdirSync(parentAbs).sort()) {
      let isDir = false;
      try {
        isDir = statSync(join(parentAbs, entry)).isDirectory();
      } catch {
        // Broken symlink or a race with a concurrent checkout: it cannot hold a
        // package.json we could read, so skipping it cannot hide a violation.
        isDir = false;
      }
      if (isDir) dirs.push(posix.join(parentPart, entry));
    }
  }
  return dirs;
}

/**
 * Read and validate the root package.json's `workspaces` array.
 *
 * Every failure here throws instead of returning an empty list: an empty list
 * would make the whole guard report "passed" while inspecting nothing.
 */
function readWorkspacePatterns(repoRoot) {
  const rootPkgPath = join(repoRoot, 'package.json');

  let rootRaw;
  try {
    rootRaw = readFileSync(rootPkgPath, 'utf8');
  } catch (err) {
    throw new CheckUnavailableError(
      `cannot read the root package.json at ${rootPkgPath} (${err.message}).\n` +
        '  Fix: run the guard from the repository root, or pass --repo-root <dir>.'
    );
  }

  let rootPkg;
  try {
    rootPkg = JSON.parse(rootRaw);
  } catch (err) {
    throw new CheckUnavailableError(
      `the root package.json at ${rootPkgPath} is not valid JSON (${err.message}).\n` +
        '  Fix: repair package.json — until it parses, no package can be checked.'
    );
  }

  if (!Array.isArray(rootPkg.workspaces) || rootPkg.workspaces.length === 0) {
    throw new CheckUnavailableError(
      `the root package.json at ${rootPkgPath} has no usable \`workspaces\` array, ` +
        'so no publishable package could be discovered.\n' +
        '  The guard refuses to pass here: with an empty package list it would report ' +
        'success while checking nothing.\n' +
        "  Fix: restore the `workspaces` array. npm's object form " +
        '(`"workspaces": { "packages": [...] }`) is NOT supported by this guard — ' +
        'teach expandWorkspaceGlobs() about it in scripts/check-version-bumps.mjs first.'
    );
  }

  return rootPkg.workspaces;
}

/**
 * Discover publishable packages from the root package.json `workspaces` field.
 *
 * A workspace is publishable when its package.json has a name and a version and
 * is not `"private": true`. Reading the workspace list keeps this in step with
 * the repo automatically — a fifth package is guarded the day it is added,
 * rather than silently unprotected until someone remembers to edit a hardcoded
 * list (`publish-packages.yml` already carries four copies of that list).
 *
 * Throws `CheckUnavailableError` rather than returning an empty/partial list: an empty list
 * would make every subsequent step report "passed" while inspecting nothing, and
 * a package.json we cannot parse is a package we cannot clear.
 */
export function discoverPackages(repoRoot) {
  const patterns = readWorkspacePatterns(repoRoot);
  const workspaceDirs = expandWorkspaceGlobs(repoRoot, patterns);
  const packages = [];
  const skipped = [];

  for (const dir of workspaceDirs) {
    const pkgJsonPath = join(repoRoot, dir, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;

    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    } catch (err) {
      throw new CheckUnavailableError(
        `${dir}/package.json could not be read as JSON (${err.message}).\n` +
          '  The guard cannot tell whether that package is publishable, and skipping it ' +
          'would silently exempt it from the check.\n' +
          `  Fix: repair ${dir}/package.json.`
      );
    }

    if (pkg.private === true) {
      skipped.push(`${dir} (private)`);
      continue;
    }
    if (!pkg.name || !pkg.version) {
      skipped.push(`${dir} (no name/version)`);
      continue;
    }

    packages.push({ dir, name: pkg.name, version: pkg.version });
  }

  if (packages.length === 0) {
    throw new CheckUnavailableError(
      'no publishable package was discovered, so the guard would have checked nothing.\n' +
        `  workspaces: ${patterns.join(', ')}\n` +
        `  resolved dirs: ${workspaceDirs.join(', ') || '(none)'}\n` +
        `  skipped: ${skipped.join(', ') || '(none)'}\n` +
        '  Fix: check the `workspaces` globs in the root package.json — every workspace ' +
        'was private, unnamed, unversioned, or missing a package.json.'
    );
  }

  return packages;
}

/**
 * Pure decision core: given the changed paths, the packages at HEAD, and a
 * lookup of each package's version on the base ref, decide what to report.
 *
 * `baseVersions[dir] === null` means the package.json does not exist on the
 * base ref — the package is new in this PR, so its first publish *is* the
 * release and no bump is required.
 *
 * When the escape label is present the analysis still runs, so the report can
 * name exactly which packages the label waived instead of printing an opaque
 * "skipped".
 */
export function analyze({ changedFiles, packages, baseVersions, labels = [] }) {
  const violations = [];
  const checked = [];

  for (const pkg of packages) {
    const touched = changedFiles.filter((f) => isReleaseRelevant(f, pkg.dir));
    if (touched.length === 0) continue;

    const baseVersion = baseVersions[pkg.dir];
    checked.push({ ...pkg, baseVersion, touched });

    // New package on this branch — nothing to bump against.
    if (baseVersion === null || baseVersion === undefined) continue;

    if (baseVersion === pkg.version) {
      violations.push({
        dir: pkg.dir,
        name: pkg.name,
        version: pkg.version,
        touched,
      });
    }
  }

  if (labels.includes(ESCAPE_LABEL)) {
    return { skipped: true, violations: [], checked: [], waived: violations };
  }

  return { skipped: false, violations, checked, waived: [] };
}

/**
 * One line naming what was actually compared. Printed on pass, fail and skip so
 * the CI log always answers "which base ref, which commit, how many files?"
 * without a re-run.
 */
function formatContext(context) {
  if (!context) return null;
  const { base, head, mergeBase, changedFileCount, packageCount } = context;
  const shortBase =
    typeof mergeBase === 'string' ? mergeBase.slice(0, SHORT_SHA_LENGTH) : mergeBase;
  return (
    `Version-bump check: comparing ${head} against base '${base}' ` +
    `(merge base ${shortBase}) — ${changedFileCount} changed file(s), ` +
    `${packageCount} publishable package(s) discovered.`
  );
}

/** Render the human-facing report. Kept pure so tests can assert on it (AC3). */
export function formatReport({ skipped, violations, checked, waived = [], context }) {
  const lines = [];
  const header = formatContext(context);
  if (header) lines.push(header, '');

  if (skipped) {
    lines.push(`Version-bump check SKIPPED — the \`${ESCAPE_LABEL}\` label is applied to this PR.`);
    if (waived.length > 0) {
      lines.push('The label waived a real finding — these packages ship unreleased:');
      for (const v of waived) {
        lines.push(
          `  ${v.name} [${v.dir}] — ${v.touched.length} file(s) changed, version ${v.version} unchanged.`
        );
      }
      lines.push(`Remove the \`${ESCAPE_LABEL}\` label and bump if that was not intended.`);
    } else {
      lines.push('No publishable package needs a version bump for this change.');
    }
    return lines.join('\n');
  }

  if (checked.length === 0) {
    lines.push('Version-bump check passed — no publishable package source changed.');
    return lines.join('\n');
  }

  for (const pkg of checked) {
    const bumped = !violations.some((v) => v.dir === pkg.dir);
    const state = bumped
      ? `OK (${pkg.baseVersion ?? 'new package'} -> ${pkg.version})`
      : `NOT BUMPED (still ${pkg.version})`;
    lines.push(`  ${pkg.name} [${pkg.dir}] — ${pkg.touched.length} file(s) changed — ${state}`);
  }

  if (violations.length === 0) {
    lines.push('', 'Version-bump check passed.');
    return lines.join('\n');
  }

  lines.push('', 'Version-bump check FAILED.');
  lines.push('');
  for (const v of violations) {
    lines.push(
      `${v.name}: source changed but the version is unchanged (${v.version} on both this ` +
        'branch and the base branch).'
    );
    lines.push(
      `  Changed: ${v.touched.slice(0, MAX_LISTED_FILES).join(', ')}` +
        `${v.touched.length > MAX_LISTED_FILES ? ', ...' : ''}`
    );
    lines.push(`  Fix: bump ${v.name} version`);
    lines.push(`       cd ${v.dir} && npm version patch --no-git-tag-version`);
    lines.push('');
  }
  lines.push(
    'A package whose version is already on npm is silently skipped by the publish ' +
      'workflow, so this change would merge without ever being released.'
  );
  lines.push(
    `If the change genuinely needs no release, apply the \`${ESCAPE_LABEL}\` label to this PR.`
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------- CLI --------

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Best available one-line description of why a git invocation failed. */
function gitError(err) {
  const stderr = (err?.stderr ?? '').toString().trim();
  return (stderr || err?.message || String(err)).split('\n').join(' | ');
}

function parseArgs(argv) {
  const opts = { base: 'origin/main', head: 'HEAD', labels: [], repoRoot: process.cwd() };
  const takesValue = { '--base': 'base', '--head': 'head', '--repo-root': 'repoRoot' };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--labels') {
      opts.labels = (next ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      i += 1;
      continue;
    }

    const key = takesValue[arg];
    if (key) {
      if (!next || next.startsWith('--')) {
        throw new CheckUnavailableError(
          `${arg} requires a value (got ${next === undefined ? 'nothing' : `'${next}'`}).\n` +
            '  Usage: node scripts/check-version-bumps.mjs [--base <ref>] [--head <ref>] ' +
            '[--labels <csv>] [--repo-root <dir>]'
        );
      }
      opts[key] = next;
      i += 1;
      continue;
    }

    throw new CheckUnavailableError(
      `unrecognised argument '${arg}'.\n` +
        '  Usage: node scripts/check-version-bumps.mjs [--base <ref>] [--head <ref>] ' +
        '[--labels <csv>] [--repo-root <dir>]'
    );
  }

  // An empty --base is the CI shape of this failure: `--base "origin/$BASE_REF"`
  // with BASE_REF unset yields 'origin/', which git resolves to nothing useful.
  if (!opts.base || opts.base === 'origin/') {
    throw new CheckUnavailableError(
      `--base resolved to '${opts.base}', which is not a usable git ref.\n` +
        '  Fix: in CI this comes from github.event.pull_request.base.ref — the job must run ' +
        'on a `pull_request` event for that to be set.'
    );
  }

  return opts;
}

/**
 * Read a package's version at a git ref.
 *
 * Returns null ONLY when the package.json genuinely does not exist at that ref
 * (a package new on this branch). Any other failure — a bad ref, a shallow
 * clone, unparseable JSON — throws, because returning null there would exempt
 * the package from the check and quietly turn a violation into a pass.
 */
export function versionAtRef(repoRoot, ref, packageDir) {
  const path = `${packageDir}/package.json`;

  let listed;
  try {
    listed = git(['ls-tree', '-r', '--name-only', ref, '--', path], repoRoot);
  } catch (err) {
    throw new CheckUnavailableError(
      `cannot list '${path}' at ref '${ref}' (${gitError(err)}).\n` +
        '  Fix: make sure the base ref is fetched (in CI: actions/checkout with fetch-depth: 0).'
    );
  }
  if (!listed) return null; // Not present on the base ref — new package.

  let raw;
  try {
    raw = git(['show', `${ref}:${path}`], repoRoot);
  } catch (err) {
    throw new CheckUnavailableError(`cannot read '${path}' at ref '${ref}' (${gitError(err)}).`);
  }

  try {
    return JSON.parse(raw).version ?? null;
  } catch (err) {
    throw new CheckUnavailableError(
      `'${path}' at ref '${ref}' is not valid JSON (${err.message}).\n` +
        `  Fix: the base branch has a broken ${path}; repair it there.`
    );
  }
}

export function run(argv, { log = console.log, error = console.error } = {}) {
  try {
    const opts = parseArgs(argv);
    const { repoRoot } = opts;

    // Fail loudly when the base ref is unreachable. A guard that fails open is
    // worse than no guard: it reports green while checking nothing.
    let mergeBase;
    try {
      mergeBase = git(['merge-base', opts.base, opts.head], repoRoot);
    } catch (err) {
      throw new CheckUnavailableError(
        `cannot compute a merge base between '${opts.base}' and '${opts.head}'.\n` +
          `  git said: ${gitError(err)}\n` +
          '  Fix: fetch the base branch first (in CI use actions/checkout with fetch-depth: 0; ' +
          'a shallow clone has no common history to merge-base against).'
      );
    }

    let changedFiles;
    try {
      changedFiles = git(['diff', '--name-only', mergeBase, opts.head], repoRoot)
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    } catch (err) {
      throw new CheckUnavailableError(
        `cannot diff '${mergeBase}'..'${opts.head}' (${gitError(err)}).\n` +
          '  Fix: make sure both refs exist in this checkout (fetch-depth: 0).'
      );
    }

    const packages = discoverPackages(repoRoot);
    const baseVersions = {};
    for (const pkg of packages) {
      baseVersions[pkg.dir] = versionAtRef(repoRoot, mergeBase, pkg.dir);
    }

    const result = analyze({ changedFiles, packages, baseVersions, labels: opts.labels });
    const report = formatReport({
      ...result,
      context: {
        base: opts.base,
        head: opts.head,
        mergeBase,
        changedFileCount: changedFiles.length,
        packageCount: packages.length,
      },
    });

    if (result.violations.length > 0) {
      error(report);
      return 1;
    }
    log(report);
    return 0;
  } catch (err) {
    if (err instanceof CheckUnavailableError) {
      error(`Version-bump check could not run: ${err.message}`);
      return 2;
    }
    error(
      'Version-bump check could not run: unexpected error (this is a bug in ' +
        `scripts/check-version-bumps.mjs).\n${err?.stack ?? String(err)}`
    );
    return 2;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exit(run(process.argv.slice(2)));
}
