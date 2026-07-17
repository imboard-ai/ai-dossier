/**
 * opencode wrapper generation for dossier skills.
 *
 * Background: opencode (https://opencode.ai) reads `~/.claude/skills/` but its
 * frontmatter parser only accepts standard YAML (`---`). Dossier skills use
 * `---dossier` (JSON) frontmatter for signature + checksum coverage, so opencode
 * silently skips them. We solve this by writing a slim YAML wrapper to
 * `~/.config/opencode/skills/<name>/SKILL.md` — same `name`, same body, opencode-native
 * frontmatter. The signed source in `~/.claude/skills/` is never touched.
 *
 * This module owns:
 *   - target resolution from the `--for` flag (claude / opencode / both)
 *   - detecting when a source is already YAML (already loadable, no wrapper needed)
 *   - wrapper generation (with `allowedTools` for delegating skills)
 *   - idempotent write / remove of wrappers
 *
 * See install-skill.ts and sync-skills.ts for the two callers.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDossierContent } from '@ai-dossier/core';

export type SyncTarget = 'claude' | 'opencode' | 'both';

export interface ResolvedTargets {
  writeClaude: boolean;
  writeOpencode: boolean;
}

/** ~/.claude/skills — the primary install location, read by both Claude Code and opencode. */
export const CLAUDE_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

/** ~/.config/opencode — opencode's config root. Its existence gates auto-wrapping. */
export const OPENCODE_CONFIG_DIR = path.join(os.homedir(), '.config', 'opencode');

/** ~/.config/opencode/skills — where we write generated YAML wrappers. */
export const OPENCODE_SKILLS_DIR = path.join(OPENCODE_CONFIG_DIR, 'skills');

/** True when opencode appears installed on this machine (auto-detect trigger). */
export function opencodeConfigExists(): boolean {
  return fs.existsSync(OPENCODE_CONFIG_DIR);
}

/**
 * Resolve --for flag to concrete write targets.
 *
 * - undefined  → claude + auto-detect opencode
 * - 'claude'   → claude only (even if opencode is present)
 * - 'opencode' → opencode only (rare; still installs to claude for the source)
 * - 'both'     → both, regardless of opencode-dir presence
 */
export function resolveTargets(forOpt: SyncTarget | undefined): ResolvedTargets {
  if (forOpt === 'claude') return { writeClaude: true, writeOpencode: false };
  if (forOpt === 'both') return { writeClaude: true, writeOpencode: true };
  if (forOpt === 'opencode') return { writeClaude: true, writeOpencode: true };
  return { writeClaude: true, writeOpencode: opencodeConfigExists() };
}

/** True if the raw content starts with `---dossier` (needs wrapping for opencode). */
export function isDossierFrontmatter(content: string): boolean {
  return content.startsWith('---dossier');
}

/**
 * Escape a YAML single-quoted string per YAML 1.2: single quotes double up,
 * everything else is literal. Descriptions can contain apostrophes and commas.
 */
function yamlSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Detect delegating skills — their body invokes `ai-dossier run <name>`.
 * We emit an `allowedTools` entry so opencode auto-approves that command.
 */
function isDelegatingSkill(body: string): boolean {
  return /\bai-dossier run\s+\S/.test(body);
}

/**
 * Build a YAML-wrapped SKILL.md string from a dossier-frontmatter source.
 *
 * Returns null if the source is already YAML (opencode reads it fine, no wrapper needed)
 * or if parsing fails (best-effort, no throw).
 *
 * `skillName` is the filesystem directory name — used as a fallback when the JSON
 * has no `name` field (edge case: scaffold-project).
 */
export function buildOpencodeWrapper(rawContent: string, skillName: string): string | null {
  if (!isDossierFrontmatter(rawContent)) {
    return null;
  }

  let parsed: ReturnType<typeof parseDossierContent>;
  try {
    parsed = parseDossierContent(rawContent);
  } catch {
    return null;
  }

  const fm = parsed.frontmatter as Record<string, unknown>;
  const name = (typeof fm.name === 'string' && fm.name) || skillName;
  const description =
    (typeof fm.description === 'string' && fm.description) ||
    (typeof fm.objective === 'string' && fm.objective) ||
    '';

  const lines: string[] = ['---', `name: ${name}`];
  if (description) {
    lines.push(`description: ${yamlSingleQuote(description)}`);
  }
  if (isDelegatingSkill(parsed.body)) {
    lines.push('allowedTools:');
    lines.push('  - Bash(ai-dossier run *)');
  }
  lines.push('---');

  // Ensure exactly one blank line between frontmatter and body, then the body verbatim.
  const body = parsed.body.replace(/^\s*\n/, '');
  return `${lines.join('\n')}\n\n${body}`;
}

/**
 * Write an opencode wrapper for a skill. Idempotent: no-op when content matches.
 *
 * Returns:
 *   'created'  — new file written
 *   'updated'  — existing file overwritten with new content
 *   'unchanged' — file already matched, no write
 *   'skipped'  — source is YAML-native, opencode reads it directly (no wrapper needed)
 */
export type WriteResult = 'created' | 'updated' | 'unchanged' | 'skipped';

export function writeOpencodeWrapper(skillName: string, rawContent: string): WriteResult {
  const wrapper = buildOpencodeWrapper(rawContent, skillName);
  if (wrapper === null) return 'skipped';

  const targetDir = path.join(OPENCODE_SKILLS_DIR, skillName);
  const targetFile = path.join(targetDir, 'SKILL.md');

  if (fs.existsSync(targetFile)) {
    const current = fs.readFileSync(targetFile, 'utf8');
    if (current === wrapper) return 'unchanged';
    fs.writeFileSync(targetFile, wrapper, 'utf8');
    return 'updated';
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetFile, wrapper, 'utf8');
  return 'created';
}

/**
 * Remove a skill's opencode wrapper if present. Best-effort: no error when missing.
 * Returns true if a wrapper was removed.
 */
export function removeOpencodeWrapper(skillName: string): boolean {
  const targetDir = path.join(OPENCODE_SKILLS_DIR, skillName);
  if (!fs.existsSync(targetDir)) return false;
  fs.rmSync(targetDir, { recursive: true, force: true });
  return true;
}

/**
 * List skill names currently present in the opencode skills dir.
 * Used by --list to show a dual-install badge and by sync-skills to prune.
 */
export function listOpencodeSkills(): string[] {
  if (!fs.existsSync(OPENCODE_SKILLS_DIR)) return [];
  return fs
    .readdirSync(OPENCODE_SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => fs.existsSync(path.join(OPENCODE_SKILLS_DIR, e.name, 'SKILL.md')))
    .map((e) => e.name);
}
