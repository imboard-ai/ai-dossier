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
 * identical, so checksum and signature both still verify, as long as no field is
 * added. Provenance therefore lives only in `.dossier-source` beside the skill (#1136;
 * installs before that also wrote `x_source` into the frontmatter, which readers still
 * honour), and `description` is filled from `objective` only when the signature does
 * not cover the frontmatter. Legacy body-only (v1) signatures and the checksum cover
 * the body alone, which is copied verbatim.
 *
 * A spec-shaped dossier (Agent Skills layout, #1088) is already what a runtime
 * reads, and its v3 signature covers every frontmatter field, so it is copied as
 * is — only a `---dossier`/`---json`/`---yaml` fence is rewritten to `---`, which the parser
 * treats identically. Any other dossier that is already YAML-fronted is returned
 * unchanged.
 */

import { canonicalizeFrontmatter, parseDossierContent, signatureCoverage } from '@ai-dossier/core';
import YAML from 'yaml';

/** Keys an agent runtime reads first; the rest follow in their existing order. */
const AGENT_KEYS = ['name', 'description'];

/**
 * Whether a signature covers the frontmatter, so adding a field would break it: false
 * for an unsigned or body-only (v1) dossier, true for v2 or a coverage this CLI cannot
 * read.
 */
function signatureCoversFrontmatter(fm: Record<string, unknown>): boolean {
  try {
    return signatureCoverage(fm.signature as { covers?: unknown } | undefined) !== 'body';
  } catch {
    return true;
  }
}

/**
 * Convert a dossier to `---` YAML frontmatter suitable for agent skill discovery.
 * Returns the input unchanged when it is already YAML-fronted or cannot be parsed.
 */
export function toSkillFrontmatter(rawContent: string): string {
  let parsed: ReturnType<typeof parseDossierContent>;
  try {
    parsed = parseDossierContent(rawContent);
  } catch {
    return rawContent;
  }

  if (parsed.shape === 'spec') {
    return rawContent.replace(/^---(dossier|json|yaml)[^\n]*/, '---');
  }
  if (!rawContent.startsWith('---dossier')) {
    return rawContent; // already YAML-fronted — leave alone
  }

  // Copy before mutating. parseDossierContent can hand back a shared object for
  // identical input, so writing to it leaks fields into later calls.
  const fm = { ...(parsed.frontmatter as Record<string, unknown>) };

  // `description` is what the runtime matches on. Fall back to `objective` so
  // dossiers that never declared one are still discoverable — unless a v2 signature
  // covers the frontmatter, where the added field would fail verification. Those
  // install without a description until they move to the spec layout (#1126).
  if (
    fm.description == null &&
    typeof fm.objective === 'string' &&
    !signatureCoversFrontmatter(fm)
  ) {
    fm.description = fm.objective;
  }

  const ordered: Record<string, unknown> = {};
  for (const key of AGENT_KEYS) {
    if (key in fm) ordered[key] = fm[key];
  }
  for (const key of Object.keys(fm)) {
    if (!(key in ordered)) ordered[key] = fm[key];
  }

  // The reader parses YAML 1.1, where a plain `2026-09-29` is a date, not the string
  // the signature covered. Keep the first rendering that reads back as the same
  // object; if none does, install the dossier unconverted rather than unverifiable.
  const expected = frontmatterIdentity(ordered);
  for (const options of RENDERINGS) {
    const out = `---\n${YAML.stringify(ordered, options)}---\n${parsed.body}`;
    if (readsBackAs(out, expected)) return out;
  }
  return rawContent;
}

/** Plain scalars where they read back unchanged, else every string double-quoted. */
const RENDERINGS: (YAML.DocumentOptions & YAML.ToStringOptions)[] = [
  { lineWidth: 0, version: '1.1' },
  { lineWidth: 0, version: '1.1', defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' },
];

/** The frontmatter as a signature sees it, plus the signature block itself. */
function frontmatterIdentity(fm: Record<string, unknown>): string {
  return `${canonicalizeFrontmatter(fm)}\n${JSON.stringify(fm.signature)}`;
}

function readsBackAs(rendered: string, expected: string): boolean {
  try {
    const fm = parseDossierContent(rendered).frontmatter as Record<string, unknown>;
    return frontmatterIdentity(fm) === expected;
  } catch {
    return false;
  }
}
