#!/usr/bin/env node
// ------------------------------------------------------------------
// refresh-examples-snapshot.mjs
//
// Weekly CI job support: `examples/git/*.ds.md` and `examples/meta/*.ds.md`
// are hand-copied snapshots of published dossier families and drift within
// days (#441 — full-cycle-issue alone moved 3.6.1 -> 3.12.3 in the 3 days
// since the last manual refresh, PR #431; #749 added the `examples/meta/`
// mirror; #751 generalized this script to cover it instead of leaving it to
// drift silently, same failure mode as #441 one directory over). This
// script re-pulls the latest published version of every dossier already
// snapshotted in each configured family's directory, copies it over the
// local copy, and reports what changed so the calling workflow can decide
// whether to open a PR (AC1) with an old->new version table (AC2) — or, on
// a no-op week, do nothing at all (AC4).
//
// This script deliberately does NOT touch git or `gh` itself — orchestration
// (branch, commit, push, PR create/update) lives in the workflow YAML, same
// separation `check-version-bumps.mjs` draws around its own git calls. That
// keeps the parts worth unit-testing (frontmatter parsing, the PR body
// table) free of any network/process mocking.
//
// Operating principle, matching check-version-bumps.mjs: never fail open. A
// dossier that fails to pull, or a cached file that fails to parse, throws
// and aborts the whole run (exit 1) rather than being silently skipped —
// silently skipping one dossier would report a clean "no changes" while
// actually missing a real update.
//
// Usage:
//   node scripts/refresh-examples-snapshot.mjs [--family <name>]
//                                               [--check]
//                                               [--cli <path-to-cli.js>]
//                                               [--repo-root <dir>]
//                                               [--pr-body-out <path>]
//
// --family <name> restricts the run to one configured family (its short
// name — the last segment of its registry prefix, e.g. `git` or `meta`).
// Omit it to run every family in FAMILIES.
//
// --check runs the full pull + byte-compare for every dossier without
// writing any changed content to disk, and exits 1 if anything is out of
// date (0 if every mirror already matches the registry) — the dry-run
// verification mode AC1 requires.
//
// Exit codes: 0 = ran successfully and (outside --check) applied all
//             changes, or (--check) found nothing out of date;
//             1 = a dossier could not be pulled/parsed/copied, an unknown
//             --family was given, or (--check only) a mirror is stale.
// ------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDossierContent } from '@ai-dossier/core';

/** The registry owner/category every `examples/git/*.ds.md` file maps onto. */
export const DOSSIER_PREFIX = 'imboard-ai/git';

/**
 * Every family this script keeps as a byte-exact mirror of published
 * registry dossiers. Add an entry here to bring a new directory under
 * refresh coverage — everything else (pull, byte-compare, write-on-change,
 * PR body) is generic over this list (#751).
 */
export const FAMILIES = [
  { prefix: DOSSIER_PREFIX, dir: 'examples/git' },
  { prefix: 'imboard-ai/meta', dir: 'examples/meta' },
];

/**
 * PR title for the refresh job. Family-agnostic — the job now covers every
 * directory in `FAMILIES`, not just `examples/git/`, so this can't name one
 * directory verbatim the way it did before #751 (that requirement traced to
 * the now-closed #441, not to any live external consumer of this string).
 */
export const PR_TITLE = 'chore(examples): refresh dossier snapshots';

export class RefreshError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RefreshError';
  }
}

/**
 * `full-cycle-issue.ds.md` + prefix `imboard-ai/git` -> `imboard-ai/git/full-cycle-issue`.
 *
 * Every file in a family's directory is, by construction (see PR #431,
 * #441, #749, #751), a 1:1 snapshot of a published `<prefix>/<name>`
 * dossier — the filename (minus `.ds.md`) IS the registry name's last
 * segment. `prefix` is the calling family's registry prefix (see
 * `FAMILIES`) rather than a module-level constant, so this function has no
 * built-in assumption about which family it's being used for.
 */
export function dossierNameFromFile(filename, prefix) {
  if (!filename.endsWith('.ds.md')) {
    throw new RefreshError(`'${filename}' is not a .ds.md file — cannot derive a dossier name.`);
  }
  const slug = filename.slice(0, -'.ds.md'.length);
  if (!slug) {
    throw new RefreshError(`'${filename}' has no name before .ds.md.`);
  }
  return `${prefix}/${slug}`;
}

/** The `--family` short name for a family — the last segment of its registry prefix. */
export function familyShortName(prefix) {
  return prefix.split('/').pop();
}

/**
 * Filter `FAMILIES` (or an equivalent list) down to the one matching
 * `--family <name>`, or return the full list when no name was given.
 * Extracted from the CLI entrypoint so the filtering logic (and its
 * unknown-name error) is unit-testable without shelling out.
 */
export function selectFamilies(all, familyName) {
  if (!familyName) {
    return all;
  }
  const matched = all.filter((f) => familyShortName(f.prefix) === familyName);
  if (matched.length === 0) {
    const known = all.map((f) => familyShortName(f.prefix)).join(', ');
    throw new RefreshError(`unknown family '${familyName}' — expected one of: ${known}`);
  }
  return matched;
}

/**
 * Parse the `---dossier\n{...}\n---` frontmatter block a .ds.md file opens
 * with and return its `version` field.
 *
 * Delegates to `@ai-dossier/core`'s `parseDossierContent` — the same parser
 * the CLI itself uses — rather than hand-rolling a regex + JSON.parse, so
 * this script never drifts from what the project considers a valid dossier
 * (e.g. the standard `---` YAML frontmatter form `parseDossierContent` also
 * accepts, which a bespoke `---dossier`-only regex could not).
 *
 * Throws rather than returning null on anything malformed — a dossier we
 * cannot version-check is a dossier the "did it change" comparison cannot
 * be trusted for, and silently treating it as unchanged would be exactly
 * the fail-open behaviour this script exists to avoid.
 */
export function extractVersion(dossierMarkdown, sourceLabel = '<content>') {
  let parsed;
  try {
    parsed = parseDossierContent(dossierMarkdown);
  } catch (err) {
    throw new RefreshError(`${sourceLabel}: ${err.message}`);
  }
  const version = parsed.frontmatter?.version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new RefreshError(`${sourceLabel}: frontmatter has no usable 'version' field.`);
  }
  return version;
}

/**
 * A dossier version is used as a filesystem path segment below (as part of
 * `${version}.ds.md`) — restrict it to characters that can never introduce a
 * path separator (`/`, `\`) so a malformed or malicious registry response
 * cannot influence where this script writes on disk.
 */
const SAFE_VERSION_RE = /^[0-9][A-Za-z0-9._+-]*$/;

/**
 * Parse the version number the CLI's `pull` command reports it fetched, out
 * of its own stdout (`✅ imboard-ai/git/foo@1.2.3 (updated) [public]`).
 *
 * Reading the version back out of stdout — rather than re-deriving the cache
 * path some other way — keeps this script honest about what the CLI
 * actually did. `pullOne()` always calls `pull --force` against a fresh,
 * empty scratch cache (see below), so the printed status this script will
 * ever see is `(downloaded)` on the first call or `(updated)` thereafter,
 * never `(already cached)` — that status only appears when `--force` is
 * absent. The regex doesn't hardcode a status word, so it keeps working if
 * the CLI's status text changes.
 *
 * The captured version is validated against `SAFE_VERSION_RE` before being
 * returned — see the comment on that constant.
 */
export function parsePulledVersion(pullStdout, dossierName) {
  const escaped = dossierName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}@([0-9][^\\s]*)\\s+\\(`);
  const match = pullStdout.match(re);
  if (!match) {
    throw new RefreshError(
      `could not find a pulled version for '${dossierName}' in pull output:\n${pullStdout}`
    );
  }
  const version = match[1];
  if (!SAFE_VERSION_RE.test(version)) {
    throw new RefreshError(
      `'${dossierName}' reported version '${version}', which contains characters unsafe to ` +
        `use in a file path (expected to match ${SAFE_VERSION_RE}). Refusing to proceed.`
    );
  }
  return version;
}

/**
 * Render the AC2 old->new version table for the PR body.
 *
 * Called unconditionally by `main()` for every run, including no-op weeks
 * where `changes` is empty — AC4 ("no-op weeks create no PR") is enforced
 * by the calling workflow YAML gating the PR step on `changed == 'true'`,
 * not by this function skipping its empty-list branch, which is live,
 * regularly-exercised code (see the "handles an empty change list" test).
 *
 * `families` names which mirror directories this run actually covered —
 * defaults to every configured family, but a `--family git` run passes just
 * that one so the summary never claims to have refreshed a directory it
 * didn't touch.
 */
export function buildPrBody(changes, families = FAMILIES) {
  const dirLabel = families.map(({ dir }) => `\`${dir}/\``).join(', ');
  const lines = [
    '## Summary',
    '',
    `Automated weekly refresh of the example dossier mirror(s) under ${dirLabel} from`,
    'their published registry versions — see #441, #751.',
    '',
  ];

  if (changes.length === 0) {
    lines.push('No dossier versions changed.');
    return `${lines.join('\n')}\n`;
  }

  lines.push('## Versions', '', '| Dossier | Old | New |', '|---|---|---|');
  for (const { name, oldVersion, newVersion } of changes) {
    lines.push(`| \`${name}\` | ${oldVersion ?? '_(new file)_'} | ${newVersion} |`);
  }
  lines.push(
    '',
    '`scripts/test-examples.sh` was run against this refreshed set in the same workflow',
    'run before this PR was opened/updated.',
    '',
    'This branch is rewritten from scratch each week (a single clean commit against',
    'current main, not accumulated history) — any manual commit pushed here between',
    'runs is discarded by the next scheduled run.',
    '',
    '🤖 Generated by the `refresh-examples-snapshot` job in `.github/workflows/test-examples.yml`.'
  );
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const opts = {
    family: null,
    cli: 'cli/dist/cli.js',
    repoRoot: process.cwd(),
    prBodyOut: null,
    check: false,
  };
  const takesValue = {
    '--family': 'family',
    '--cli': 'cli',
    '--repo-root': 'repoRoot',
    '--pr-body-out': 'prBodyOut',
  };
  const booleanFlags = {
    '--check': 'check',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const boolKey = booleanFlags[arg];
    if (boolKey) {
      opts[boolKey] = true;
      continue;
    }
    const key = takesValue[arg];
    if (!key) {
      throw new RefreshError(`unrecognised argument '${arg}'.`);
    }
    const next = argv[i + 1];
    if (!next) {
      throw new RefreshError(`${arg} requires a value.`);
    }
    opts[key] = next;
    i += 1;
  }
  if (!opts.prBodyOut) {
    const dir = process.env.RUNNER_TEMP || tmpdir();
    opts.prBodyOut = join(dir, 'refresh-pr-body.md');
  }
  return opts;
}

function setGithubOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  writeFileSync(file, `${key}=${value}\n`, { flag: 'a' });
}

/**
 * Load the CLI's own `safeDossierPath()` straight out of its build output,
 * by file path rather than the `@ai-dossier/cli` package specifier (that
 * package declares no public `exports` for internal modules like
 * `helpers.js`, and `cachedContentPath()` in `cli/src/cache-resolver.ts`
 * can't be reused as-is either — its `CACHE_DIR` constant is fixed to the
 * real `os.homedir()` at import time in *this* process, not the child
 * subprocess's scratch `HOME`). `createRequire` loads the CJS build
 * synchronously, keeping `pullOne` sync like the rest of this script.
 */
function loadSafeDossierPath(cliPath, repoRoot) {
  const require = createRequire(import.meta.url);
  const helpersPath = join(dirname(resolve(repoRoot, cliPath)), 'helpers.js');
  return require(helpersPath).safeDossierPath;
}

/**
 * Pull one dossier to a scratch cache dir (never the real `~/.dossier/cache`,
 * so this script never depends on — or pollutes — a machine's existing
 * login/cache state) and return its freshly downloaded content + version.
 *
 * The cache file path mirrors the `<cache>/<name>/<version>.ds.md` layout
 * centralized in `cli/src/cache-resolver.ts`'s `cachedContentPath()` — the
 * `<name>` portion is resolved with the CLI's own `safeDossierPath()` (which
 * rejects a dossier name that would escape the cache dir); `<version>` comes
 * from `parsePulledVersion()`, which independently validates it against
 * `SAFE_VERSION_RE` before it ever reaches a path. If the cache layout in
 * `cache-resolver.ts` changes, update this to match.
 */
function pullOne({ name, cliPath, repoRoot, scratchHome }) {
  let stdout;
  try {
    stdout = execFileSync('node', [cliPath, 'pull', name, '--force'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, HOME: scratchHome },
    });
  } catch (err) {
    const out = (err.stdout ?? '') + (err.stderr ?? '');
    throw new RefreshError(`pull failed for '${name}':\n${out || err.message}`);
  }

  const version = parsePulledVersion(stdout, name);
  const safeDossierPath = loadSafeDossierPath(cliPath, repoRoot);
  const dossierCacheDir = safeDossierPath(join(scratchHome, '.dossier', 'cache'), name);
  const cachePath = join(dossierCacheDir, `${version}.ds.md`);
  if (!existsSync(cachePath)) {
    throw new RefreshError(
      `pull reported '${name}@${version}' but the expected cache file is missing: ${cachePath}`
    );
  }
  return { version, content: readFileSync(cachePath, 'utf8') };
}

/**
 * Refresh one family: pull every dossier already snapshotted in `dir`,
 * byte-compare it against the local copy, and (unless `check`) write back
 * any dossier whose registry content moved. Logs its own per-family summary
 * line as its last step, so a crash partway through a LATER family still
 * leaves this family's line in the log — the summary isn't deferred to a
 * second pass over every family's result at the end of `main()`.
 *
 * Extracted out of `main()` (#751 review) so the family loop there stays a
 * flat aggregate instead of nesting `for family -> for file -> if changed`
 * inline.
 */
function refreshFamily({ prefix, dir, repoRoot, cliPath, scratchHome, pull, log, check }) {
  const absExamplesDir = join(repoRoot, dir);
  if (!existsSync(absExamplesDir)) {
    throw new RefreshError(`examples dir not found: ${absExamplesDir}`);
  }

  const files = readdirSync(absExamplesDir)
    .filter((f) => f.endsWith('.ds.md'))
    .sort();
  if (files.length === 0) {
    throw new RefreshError(`no .ds.md files found in ${absExamplesDir} — nothing to refresh.`);
  }

  const changes = [];
  for (const file of files) {
    const name = dossierNameFromFile(file, prefix);
    const localPath = join(absExamplesDir, file);
    const oldContent = readFileSync(localPath, 'utf8');
    const oldVersion = extractVersion(oldContent, localPath);

    const { version: newVersion, content: newContent } = pull({
      name,
      cliPath,
      repoRoot,
      scratchHome,
    });

    if (newContent !== oldContent) {
      if (!check) {
        writeFileSync(localPath, newContent);
      }
      changes.push({ name, oldVersion, newVersion });
      log(`${check ? 'stale' : 'changed'}: ${name}  ${oldVersion} -> ${newVersion}`);
    } else {
      log(`unchanged: ${name}  ${oldVersion}`);
    }
  }

  const summary = { prefix, dir, fileCount: files.length, changedCount: changes.length };
  log(
    `${dir}: ${summary.fileCount} dossier(s), ${summary.changedCount} ${check ? 'stale' : 'changed'}`
  );
  return { changes, summary };
}

export function main({
  families = FAMILIES,
  cliPath,
  repoRoot,
  prBodyOut,
  pull = pullOne,
  log = console.log,
  check = false,
} = {}) {
  if (families.length === 0) {
    throw new RefreshError('no families configured — nothing to refresh.');
  }

  const scratchHome = mkdtempSync(join(tmpdir(), 'refresh-examples-'));
  const changes = [];
  const familySummaries = [];

  for (const family of families) {
    const { changes: familyChanges, summary } = refreshFamily({
      ...family,
      repoRoot,
      cliPath,
      scratchHome,
      pull,
      log,
      check,
    });
    changes.push(...familyChanges);
    familySummaries.push(summary);
  }

  const changed = changes.length > 0;
  const body = buildPrBody(changes, families);
  writeFileSync(prBodyOut, body);

  log('');
  log(changed ? `${changes.length} dossier(s) changed.` : 'No changes — no-op week.');
  if (!check) {
    log(`PR body written to ${prBodyOut}`);

    // Only a real (non-dry-run) refresh is authoritative for the CI job's
    // outputs — a --check invocation is a local verification pass and must
    // never masquerade as the source of GITHUB_OUTPUT for a downstream step.
    setGithubOutput('changed', changed ? 'true' : 'false');
    setGithubOutput('pr_title', PR_TITLE);
    setGithubOutput('pr_body_path', prBodyOut);
    // FAMILIES is the single source of truth for which directories this job
    // covers (#751 review) — the workflow's `git add` stages exactly this
    // list instead of a hardcoded, easily-stale directory pair.
    setGithubOutput('dirs', families.map((f) => f.dir).join(' '));
  }

  return { changed, changes, prBodyPath: prBodyOut, families: familySummaries };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const families = selectFamilies(FAMILIES, opts.family);
    const result = main({
      families,
      cliPath: opts.cli,
      repoRoot: opts.repoRoot,
      prBodyOut: opts.prBodyOut,
      check: opts.check,
    });
    if (opts.check && result.changed) {
      console.error(
        `refresh-examples-snapshot --check: ${result.changes.length} dossier(s) out of date with the registry.`
      );
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof RefreshError) {
      console.error(`refresh-examples-snapshot failed: ${err.message}`);
    } else {
      console.error(`refresh-examples-snapshot failed (unexpected error):\n${err?.stack ?? err}`);
    }
    process.exit(1);
  }
}
