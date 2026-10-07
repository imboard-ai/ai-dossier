#!/usr/bin/env node
// ------------------------------------------------------------------
// validate-skills-spec.mjs
//
// Check that every shipped example dossier, rendered the way `install-skill`
// renders it (`toSkillFrontmatter`), passes the Agent Skills reference
// validator (`skills-ref validate`, https://agentskills.io/specification).
//
// Why (#1088): our frontmatter carries ~15 top-level keys the spec does not
// allow, so installed dossiers fail the validator the spec tells authors to
// run. Until the shipped examples are re-signed in the spec layout (#1126) this
// check reports the gap; the workflow runs it non-blocking and flips to
// required afterwards.
//
// `--as-written` validates each example the way the CLI writers now emit it
// (#1123: `ai-dossier sign`/`format` write the Agent Skills layout) instead of
// as shipped. That proves the writers' output, so the workflow requires it.
//
// Needs: a built CLI (`make build-all`) and `skills-ref` on PATH (or
// SKILLS_REF_BIN). Usage: node scripts/validate-skills-spec.mjs [--as-written] [dir ...]
// ------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Recursively list `*.ds.md` files under `dir`, sorted for stable output. */
export function findDossiers(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findDossiers(full));
    else if (entry.name.endsWith('.ds.md')) out.push(full);
  }
  return out.sort();
}

/** The `name:` of a YAML-fronted skill file, or null. */
export function skillName(rendered) {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(rendered);
  const m = fm && /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(fm[1]);
  return m ? m[1] : null;
}

/** Reduce validator output to its bullet lines (`  - …`), one per error. */
export function errorLines(output) {
  return output
    .split('\n')
    .filter((l) => l.startsWith('  - '))
    .map((l) => l.slice(4).trim());
}

/**
 * Split one validator error into countable keys. "Unexpected fields … a, b."
 * becomes one key per field, so a systemic gap reads as a per-field tally
 * instead of one unique line per dossier.
 */
export function errorKeys(error) {
  const m = /^Unexpected fields in frontmatter: (.+?)\. Only /.exec(error);
  if (!m) return [error.split('\n')[0]];
  return m[1].split(', ').map((f) => `Unexpected top-level key: ${f}`);
}

/** Tally failing files per error key, most common first. */
export function summarize(results) {
  const failed = results.filter((r) => r.errors.length > 0);
  const byError = new Map();
  for (const r of failed) {
    for (const key of new Set(r.errors.flatMap(errorKeys))) {
      byError.set(key, [...(byError.get(key) ?? []), r.file]);
    }
  }
  const sorted = [...byError].sort((a, b) => b[1].length - a[1].length);
  return { total: results.length, failed: failed.length, byError: new Map(sorted) };
}

/**
 * A dossier as `ai-dossier sign` would write it: the Agent Skills layout, `name`
 * derived from the file name when absent. Its old signature is set aside — it
 * covered the legacy bytes, and re-signing needs the publisher's key.
 */
export function asWritten(content, file, core) {
  const parsed = core.parseDossierContent(content);
  const { signature: _replaced, ...unsigned } = parsed.frontmatter;
  return core.renderSpecDossier(core.withSkillIdentity(unsigned, file), parsed.body, parsed);
}

function validate(bin, skillDir) {
  const p = spawnSync(bin, ['validate', skillDir], { encoding: 'utf8' });
  if (p.error) throw new Error(`cannot run ${bin}: ${p.error.message}`);
  const errors = errorLines(`${p.stdout}\n${p.stderr}`);
  // A failing exit with no error bullets is still a failure, never a pass.
  if (p.status !== 0 && errors.length === 0) errors.push(`${bin} exited ${p.status}`);
  return { ok: p.status === 0, errors };
}

export function main(argv = process.argv.slice(2)) {
  const bin = process.env.SKILLS_REF_BIN || 'skills-ref';
  const written = argv.includes('--as-written');
  const args = argv.filter((a) => a !== '--as-written');
  const dirs = args.length ? args : [join(REPO_ROOT, 'examples')];
  // The CLI is CJS; createRequire keeps named-export interop out of the picture.
  const require = createRequire(import.meta.url);
  const { toSkillFrontmatter } = require(join(REPO_ROOT, 'cli/dist/skill-frontmatter.js'));
  const core = written ? require(join(REPO_ROOT, 'packages/core/dist/index.js')) : null;

  const tmp = mkdtempSync(join(tmpdir(), 'skills-spec-'));
  const results = [];
  try {
    for (const file of dirs.flatMap(findDossiers)) {
      const source = readFileSync(file, 'utf8');
      const rendered = toSkillFrontmatter(written ? asWritten(source, file, core) : source);
      const name = skillName(rendered) ?? 'unnamed';
      const skillDir = join(tmp, name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), rendered);
      const { ok, errors } = validate(bin, skillDir);
      results.push({ file: relative(REPO_ROOT, file), errors: ok ? [] : errors });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const s = summarize(results);
  const mode = written ? ' (as the CLI writes them)' : '';
  console.log(`skills-ref validate${mode}: ${s.total - s.failed}/${s.total} dossiers pass\n`);
  for (const [error, files] of s.byError) {
    console.log(`${String(files.length).padStart(3)}x ${error}`);
  }
  if (s.failed)
    console.log(
      `\nFailing: ${results
        .filter((r) => r.errors.length)
        .map((r) => r.file)
        .join(', ')}`
    );
  return s.failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
