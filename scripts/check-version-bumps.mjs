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

/** Label that lets an author opt a PR out of the guard (AC4). */
export const ESCAPE_LABEL = 'no-release-needed';

/** Directories inside a package whose contents ship to npm consumers. */
const RELEASE_DIRS = ['src', 'bin'];

/** Paths that live under a release dir but never change published behaviour. */
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIR_RE = /(^|\/)(__tests__|__mocks__|__fixtures__|fixtures)\//;

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
    if (!pattern.endsWith('/*')) {
      dirs.push(pattern);
      continue;
    }
    const parent = pattern.slice(0, -2);
    const parentAbs = join(repoRoot, parent);
    if (!existsSync(parentAbs)) continue;
    for (const entry of readdirSync(parentAbs).sort()) {
      if (statSync(join(parentAbs, entry)).isDirectory()) {
        dirs.push(posix.join(parent, entry));
      }
    }
  }
  return dirs;
}

/**
 * Discover publishable packages from the root package.json `workspaces` field.
 *
 * A workspace is publishable when its package.json has a name and a version and
 * is not `"private": true`. Reading the workspace list keeps this in step with
 * the repo automatically — a fifth package is guarded the day it is added,
 * rather than silently unprotected until someone remembers to edit a hardcoded
 * list (`publish-packages.yml` already carries four copies of that list).
 */
export function discoverPackages(repoRoot) {
  const rootPkgPath = join(repoRoot, 'package.json');
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
  const patterns = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : [];

  const packages = [];
  for (const dir of expandWorkspaceGlobs(repoRoot, patterns)) {
    const pkgJsonPath = join(repoRoot, dir, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;

    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    } catch {
      continue;
    }
    if (pkg.private === true) continue;
    if (!pkg.name || !pkg.version) continue;

    packages.push({ dir, name: pkg.name, version: pkg.version });
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
 */
export function analyze({ changedFiles, packages, baseVersions, labels = [] }) {
  if (labels.includes(ESCAPE_LABEL)) {
    return { skipped: true, violations: [], checked: [] };
  }

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

  return { skipped: false, violations, checked };
}

/** Render the human-facing report. Kept pure so tests can assert on it (AC3). */
export function formatReport({ skipped, violations, checked }) {
  const lines = [];

  if (skipped) {
    lines.push(
      `Version-bump check SKIPPED — the \`${ESCAPE_LABEL}\` label is applied to this PR.`,
      'No publishable package needs a version bump for this change.'
    );
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
      `  Changed: ${v.touched.slice(0, 5).join(', ')}${v.touched.length > 5 ? ', ...' : ''}`
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
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function parseArgs(argv) {
  const opts = { base: 'origin/main', head: 'HEAD', labels: [], repoRoot: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--base') {
      opts.base = next;
      i += 1;
    } else if (arg === '--head') {
      opts.head = next;
      i += 1;
    } else if (arg === '--repo-root') {
      opts.repoRoot = next;
      i += 1;
    } else if (arg === '--labels') {
      opts.labels = (next ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      i += 1;
    }
  }
  return opts;
}

/** Read a package's version at a git ref; null when the file is absent there. */
export function versionAtRef(repoRoot, ref, packageDir) {
  try {
    const raw = git(['show', `${ref}:${packageDir}/package.json`], repoRoot);
    return JSON.parse(raw).version ?? null;
  } catch {
    return null;
  }
}

export function run(argv, { log = console.log, error = console.error } = {}) {
  const opts = parseArgs(argv);
  const { repoRoot } = opts;

  // Fail loudly when the base ref is unreachable. A guard that fails open is
  // worse than no guard: it reports green while checking nothing.
  let mergeBase;
  try {
    mergeBase = git(['merge-base', opts.base, opts.head], repoRoot);
  } catch {
    error(
      `Version-bump check could not run: cannot compute a merge base between ` +
        `'${opts.base}' and '${opts.head}'.\n` +
        `  Fix: fetch the base branch first (in CI use actions/checkout with fetch-depth: 0).`
    );
    return 2;
  }

  const changedFiles = git(['diff', '--name-only', mergeBase, opts.head], repoRoot)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const packages = discoverPackages(repoRoot);
  const baseVersions = {};
  for (const pkg of packages) {
    baseVersions[pkg.dir] = versionAtRef(repoRoot, mergeBase, pkg.dir);
  }

  const result = analyze({ changedFiles, packages, baseVersions, labels: opts.labels });
  const report = formatReport(result);

  if (result.violations.length > 0) {
    error(report);
    return 1;
  }
  log(report);
  return 0;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  process.exit(run(process.argv.slice(2)));
}
