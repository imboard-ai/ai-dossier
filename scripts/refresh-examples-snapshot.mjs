#!/usr/bin/env node
// ------------------------------------------------------------------
// refresh-examples-snapshot.mjs
//
// Weekly CI job support: `examples/git/*.ds.md` is a hand-copied snapshot of
// the published `imboard-ai/git/*` dossier family and drifts within days
// (#441 — full-cycle-issue alone moved 3.6.1 -> 3.12.3 in the 3 days since
// the last manual refresh, PR #431). This script re-pulls the latest
// published version of every dossier already snapshotted in examples/git,
// copies it over the local copy, and reports what changed so the calling
// workflow can decide whether to open a PR (AC1) with an old->new version
// table (AC2) — or, on a no-op week, do nothing at all (AC4).
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
//   node scripts/refresh-examples-snapshot.mjs [--examples-dir <dir>]
//                                               [--cli <path-to-cli.js>]
//                                               [--repo-root <dir>]
//                                               [--pr-body-out <path>]
//
// Exit codes: 0 = ran successfully (whether or not anything changed),
//             1 = a dossier could not be pulled/parsed/copied.
// ------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The registry owner/category every `examples/git/*.ds.md` file maps onto. */
export const DOSSIER_PREFIX = 'imboard-ai/git';

/** PR title AC1 requires verbatim. */
export const PR_TITLE = 'chore(examples): refresh git/ snapshot';

export class RefreshError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RefreshError';
  }
}

/**
 * `full-cycle-issue.ds.md` -> `imboard-ai/git/full-cycle-issue`.
 *
 * Every file in examples/git/ is, by construction (see PR #431 and #441),
 * a 1:1 snapshot of a published `imboard-ai/git/<name>` dossier — the
 * filename (minus `.ds.md`) IS the registry name's last segment.
 */
export function dossierNameFromFile(filename) {
  if (!filename.endsWith('.ds.md')) {
    throw new RefreshError(`'${filename}' is not a .ds.md file — cannot derive a dossier name.`);
  }
  const slug = filename.slice(0, -'.ds.md'.length);
  if (!slug) {
    throw new RefreshError(`'${filename}' has no name before .ds.md.`);
  }
  return `${DOSSIER_PREFIX}/${slug}`;
}

/**
 * Parse the `---dossier\n{...}\n---` frontmatter block a .ds.md file opens
 * with and return its `version` field.
 *
 * Throws rather than returning null on anything malformed — a dossier we
 * cannot version-check is a dossier the "did it change" comparison cannot
 * be trusted for, and silently treating it as unchanged would be exactly
 * the fail-open behaviour this script exists to avoid.
 */
export function extractVersion(dossierMarkdown, sourceLabel = '<content>') {
  const match = dossierMarkdown.match(/^---dossier\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) {
    throw new RefreshError(`${sourceLabel}: no '---dossier ... ---' frontmatter block found.`);
  }
  let frontmatter;
  try {
    frontmatter = JSON.parse(match[1]);
  } catch (err) {
    throw new RefreshError(`${sourceLabel}: frontmatter is not valid JSON (${err.message}).`);
  }
  if (typeof frontmatter.version !== 'string' || frontmatter.version.length === 0) {
    throw new RefreshError(`${sourceLabel}: frontmatter has no usable 'version' field.`);
  }
  return frontmatter.version;
}

/**
 * Parse the version number the CLI's `pull` command reports it fetched, out
 * of its own stdout (`✅ imboard-ai/git/foo@1.2.3 (updated) [public]`).
 *
 * Reading the version back out of stdout — rather than re-deriving the cache
 * path some other way — keeps this script honest about what the CLI
 * actually did, including on the "(already cached)" path where `--force`
 * still re-verifies but the printed status differs.
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
  return match[1];
}

/** Render the AC2 old->new version table for the PR body. Empty `changes` never reaches here (AC4 short-circuits first) but is handled defensively. */
export function buildPrBody(changes) {
  const lines = [
    '## Summary',
    '',
    'Automated weekly refresh of `examples/git/*.ds.md` from the published',
    '`imboard-ai/git/*` dossiers — see #441.',
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
    '🤖 Generated by the `refresh-examples-snapshot` job in `.github/workflows/test-examples.yml`.'
  );
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const opts = {
    examplesDir: 'examples/git',
    cli: 'cli/dist/cli.js',
    repoRoot: process.cwd(),
    prBodyOut: null,
  };
  const takesValue = {
    '--examples-dir': 'examplesDir',
    '--cli': 'cli',
    '--repo-root': 'repoRoot',
    '--pr-body-out': 'prBodyOut',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
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
 * Pull one dossier to a scratch cache dir (never the real `~/.dossier/cache`,
 * so this script never depends on — or pollutes — a machine's existing
 * login/cache state) and return its freshly downloaded content + version.
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
  const [owner, category, ...rest] = name.split('/');
  const cachePath = join(
    scratchHome,
    '.dossier',
    'cache',
    owner,
    category,
    ...rest,
    `${version}.ds.md`
  );
  if (!existsSync(cachePath)) {
    throw new RefreshError(
      `pull reported '${name}@${version}' but the expected cache file is missing: ${cachePath}`
    );
  }
  return { version, content: readFileSync(cachePath, 'utf8') };
}

export function main({
  examplesDir,
  cliPath,
  repoRoot,
  prBodyOut,
  pull = pullOne,
  log = console.log,
} = {}) {
  const absExamplesDir = join(repoRoot, examplesDir);
  if (!existsSync(absExamplesDir)) {
    throw new RefreshError(`examples dir not found: ${absExamplesDir}`);
  }

  const files = readdirSync(absExamplesDir)
    .filter((f) => f.endsWith('.ds.md'))
    .sort();
  if (files.length === 0) {
    throw new RefreshError(`no .ds.md files found in ${absExamplesDir} — nothing to refresh.`);
  }

  const scratchHome = mkdtempSync(join(tmpdir(), 'refresh-examples-'));
  const changes = [];

  for (const file of files) {
    const name = dossierNameFromFile(file);
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
      writeFileSync(localPath, newContent);
      changes.push({ name, oldVersion, newVersion });
      log(`changed: ${name}  ${oldVersion} -> ${newVersion}`);
    } else {
      log(`unchanged: ${name}  ${oldVersion}`);
    }
  }

  const changed = changes.length > 0;
  const body = buildPrBody(changes);
  writeFileSync(prBodyOut, body);

  log('');
  log(changed ? `${changes.length} dossier(s) changed.` : 'No changes — no-op week.');
  log(`PR body written to ${prBodyOut}`);

  setGithubOutput('changed', changed ? 'true' : 'false');
  setGithubOutput('pr_title', PR_TITLE);
  setGithubOutput('pr_body_path', prBodyOut);

  return { changed, changes, prBodyPath: prBodyOut };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    main({
      examplesDir: opts.examplesDir,
      cliPath: opts.cli,
      repoRoot: opts.repoRoot,
      prBodyOut: opts.prBodyOut,
    });
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
