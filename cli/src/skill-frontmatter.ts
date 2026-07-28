/**
 * Render a dossier for installation as an agent skill.
 *
 * The problem: dossiers are stored with `---dossier` (JSON) frontmatter so the block
 * can carry a checksum and signature. But agent runtimes parse standard `---` YAML.
 * opencode skips such files outright; Claude Code fares slightly better but does not
 * extract `name`/`description`, so an installed dossier surfaces with the literal
 * string "---dossier" as its description and cannot be matched from a natural-language
 * request. Every authored trigger phrase is inert.
 *
 * The fix: re-serialize the same frontmatter as YAML, with `name` and `description`
 * first so the runtime reads them.
 *
 * Why this does not break verification: a v2 signature covers
 * `canonicalizeFrontmatter(parsedFrontmatter) + body` — the parsed object, not the
 * bytes of the frontmatter block. Re-serializing JSON to YAML leaves the parsed object
 * (and therefore the signed payload) identical, so checksum and signature both still
 * verify. Legacy body-only signatures are likewise unaffected, since the body is copied
 * verbatim.
 *
 * A dossier that is already YAML-fronted is returned unchanged.
 */

import { parseDossierContent } from '@ai-dossier/core';
import YAML from 'yaml';

/** Keys an agent runtime reads first; the rest follow in their existing order. */
const AGENT_KEYS = ['name', 'description'];

/**
 * Convert a dossier to `---` YAML frontmatter suitable for agent skill discovery.
 * Returns the input unchanged when it is already YAML-fronted or cannot be parsed.
 */
export function toSkillFrontmatter(rawContent: string): string {
  if (!rawContent.startsWith('---dossier')) {
    return rawContent; // already YAML-fronted (or not a dossier) — leave alone
  }

  let parsed: ReturnType<typeof parseDossierContent>;
  try {
    parsed = parseDossierContent(rawContent);
  } catch {
    return rawContent;
  }

  const fm = parsed.frontmatter as Record<string, unknown>;

  // `description` is what the runtime matches on. Fall back to `objective` so
  // dossiers that never declared one are still discoverable.
  if (fm.description == null && typeof fm.objective === 'string') {
    fm.description = fm.objective;
  }

  const ordered: Record<string, unknown> = {};
  for (const key of AGENT_KEYS) {
    if (key in fm) ordered[key] = fm[key];
  }
  for (const key of Object.keys(fm)) {
    if (!(key in ordered)) ordered[key] = fm[key];
  }

  const yaml = YAML.stringify(ordered, { lineWidth: 0 });
  return `---\n${yaml}---\n${parsed.body}`;
}
