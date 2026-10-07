/**
 * Spec-shape writer: render a dossier in the Agent Skills layout (#1088, #1123).
 *
 * `spec-shape.ts` maps between the flat logical frontmatter and the spec-shaped
 * object; this module turns that object into file bytes that a strict YAML
 * reader (the Agent Skills validator, a skills runtime) reads back as exactly the
 * same object:
 *
 * - every scalar is quoted, so `"true"`, `"1.0"` or `"2024-01-01"` stay strings
 *   instead of being read as a boolean, number or date and rejected;
 * - empty collections are never emitted (`toSpecFrontmatter` already omits an
 *   empty `metadata`);
 * - the result is parsed back and compared before it is returned, so a value the
 *   YAML layer cannot carry fails here rather than in a signature check later.
 *
 * It also fills the two fields the spec requires at the top level when a legacy
 * dossier never declared them: `name` (from the registry path or file name) and
 * `description` (from `objective`).
 */

import YAML, { Scalar, visit } from 'yaml';
import { parseDossierContent } from './parser';
import { DOSSIER_METADATA_PREFIX, SpecShapeError, toSpecFrontmatter } from './spec-shape';
import type { DossierFrontmatter, ParsedDossier } from './types';
import { stableStringify } from './utils/canonical-json';

/** Longest Agent Skills `name`. */
const MAX_SKILL_NAME_LENGTH = 64;

/**
 * An Agent Skills `name` derived from a registry path, file path or title: the
 * last path segment without its `.ds.md`/`.md` extension, lowercased, with every
 * run of other characters collapsed to one hyphen. Returns undefined when nothing
 * usable is left.
 */
export function deriveSkillName(source: string): string | undefined {
  const base = source.split(/[\\/]/).pop() ?? '';
  const slug = base
    .replace(/@[^@]*$/, '')
    .replace(/(\.ds)?\.md$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SKILL_NAME_LENGTH)
    .replace(/^-+|-+$/g, '');
  return slug || undefined;
}

/**
 * Logical frontmatter with the Agent Skills identity filled in where absent:
 * `name` from `nameSource` (a registry path or file path), else from the title;
 * `description` from `objective`. Present values are kept as they are, even when
 * invalid — the linter reports those; a writer does not rename a dossier.
 */
export function withSkillIdentity(
  logical: Record<string, unknown>,
  nameSource?: string
): Record<string, unknown> {
  const out = { ...logical };
  if (out.name === undefined) {
    const name =
      (nameSource && deriveSkillName(nameSource)) ||
      (typeof out.title === 'string' ? deriveSkillName(out.title) : undefined);
    if (name) {
      out.name = name;
    }
  }
  if (out.description === undefined && typeof out.objective === 'string') {
    out.description = out.objective;
  }
  return out;
}

/**
 * The `metadata` entries of an on-disk spec-shaped frontmatter that belong to
 * other tools (anything outside `dossier.*`). The logical view drops them, so a
 * rewrite has to carry them over explicitly — they are covered by a v3 signature.
 */
export function foreignMetadata(rawFrontmatter: Record<string, unknown>): Record<string, string> {
  const metadata = rawFrontmatter.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!key.startsWith(DOSSIER_METADATA_PREFIX) && typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Spec-shaped frontmatter for a logical object, keeping the foreign `metadata`
 * entries of the file it is rewriting (pass the parsed original, if any).
 */
export function buildSpecFrontmatter(
  logical: Record<string, unknown>,
  original?: Pick<ParsedDossier, 'rawFrontmatter' | 'shape'>
): Record<string, unknown> {
  const spec = toSpecFrontmatter(logical);
  const foreign = original?.shape === 'spec' ? foreignMetadata(original.rawFrontmatter) : {};
  if (Object.keys(foreign).length > 0) {
    spec.metadata = { ...((spec.metadata as Record<string, string>) ?? {}), ...foreign };
  }
  return spec;
}

/**
 * Render spec-shaped frontmatter and a body as dossier file content
 * (`---` YAML front matter). Throws `SpecShapeError` when the result would not
 * parse back to the same frontmatter and body.
 */
export function serializeSpecDossier(spec: Record<string, unknown>, body: string): string {
  const doc = new YAML.Document(spec);
  visit(doc, {
    Scalar(key, node) {
      if (key === 'key') {
        // The stringifier still quotes a key that cannot be written plain.
        node.type = Scalar.PLAIN;
      } else if (typeof node.value === 'string') {
        // Single quotes keep JSON-encoded values readable; a line break folds
        // in single quotes, so those get double quotes and an explicit `\n`.
        node.type = node.value.includes('\n') ? Scalar.QUOTE_DOUBLE : Scalar.QUOTE_SINGLE;
      }
    },
  });
  const content = `---\n${doc.toString({ lineWidth: 0 })}---\n${body}`;

  let reparsed: ParsedDossier;
  try {
    reparsed = parseDossierContent(content);
  } catch (err) {
    throw new SpecShapeError('Spec-shaped frontmatter does not parse back', { cause: err });
  }
  if (
    reparsed.shape !== 'spec' ||
    reparsed.body !== body ||
    stableStringify(reparsed.rawFrontmatter) !== stableStringify(spec)
  ) {
    throw new SpecShapeError('Spec-shaped frontmatter does not round-trip through YAML');
  }
  return content;
}

/** Spec-shaped file content for logical frontmatter and a body; see `serializeSpecDossier`. */
export function renderSpecDossier(
  logical: DossierFrontmatter | Record<string, unknown>,
  body: string,
  original?: Pick<ParsedDossier, 'rawFrontmatter' | 'shape'>
): string {
  return serializeSpecDossier(
    buildSpecFrontmatter(logical as Record<string, unknown>, original),
    body
  );
}
