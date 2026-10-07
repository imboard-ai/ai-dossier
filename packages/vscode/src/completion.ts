/**
 * Frontmatter completion + hover, driven by dossier-schema.json.
 *
 * Why a small provider instead of VS Code's JSON language service: the JSON features only attach
 * to whole-document `json` files. Feeding them a block embedded in Markdown means running a
 * virtual-document + request-forwarding shim (and YAML frontmatter would need a second one),
 * which is far more moving parts than the ~100 lines here. This also handles both frontmatter
 * shapes (JSON `---dossier` and YAML) with one code path.
 *
 * Spec-shaped files (Agent Skills layout, #1088) keep Dossier fields under `metadata` as
 * `dossier.<field>` keys whose values are strings, so there completion offers those keys and
 * hover describes them; the top level only offers the Agent Skills fields.
 */
import { SPEC_TOP_LEVEL_FIELDS } from '@ai-dossier/core';
import {
  type FrontmatterBlock,
  isInsideFrontmatter,
  isMetadataChildLine,
  isSpecShapedBlock,
  isTopLevelLine,
  locateFrontmatter,
  SPEC_KEY_PREFIX,
  specKeyOnLine,
  specKeys,
  topLevelKeyOnLine,
} from './frontmatter';
import { FIELDS, type FieldInfo, getField } from './schema-info';

export interface CompletionEntry {
  label: string;
  kind: 'property' | 'value';
  insertText: string;
  detail: string;
  documentation: string;
  /** Column where the text being replaced starts (the range ends at the cursor). */
  replaceStartCol: number;
}

export interface HoverEntry {
  markdown: string;
  startCol: number;
  endCol: number;
}

/** Keys already written at top level, so completion does not offer them twice. */
function presentKeys(block: FrontmatterBlock): Set<string> {
  const keys = new Set<string>();
  const end = block.closeLine === -1 ? block.lines.length : block.closeLine;
  for (let i = block.openLine + 1; i < end; i++) {
    const k = topLevelKeyOnLine(block, i);
    if (k) keys.add(k);
  }
  return keys;
}

function describe(f: FieldInfo): string {
  const parts = [`**${f.name}** (${f.type}${f.required ? ', required' : ''})`, '', f.description];
  if (f.enum) parts.push('', `Allowed values: ${f.enum.map((v) => `\`${v}\``).join(', ')}`);
  return parts.join('\n');
}

export function completionsAt(content: string, line: number, col: number): CompletionEntry[] {
  const block = locateFrontmatter(content);
  if (!block || !isInsideFrontmatter(block, line)) return [];
  const text = block.lines[line] ?? '';
  const prefix = text.slice(0, col);
  const json = block.style === 'json';
  if (isMetadataChildLine(block, line)) return specCompletions(block, text, prefix, col);
  // Nested values (inside objects/arrays) are not described by top-level schema entries.
  if (!isTopLevelLine(block, line)) return [];

  // Value position: `"status": "Dr` / `"status": ` (JSON) or `status: Dr` (YAML).
  const valueMatch = json
    ? prefix.match(/^\s*"([^"]+)"\s*:\s*("?)([^"]*)$/)
    : prefix.match(/^([A-Za-z_][\w-]*)\s*:\s*(["']?)([^"']*)$/);
  if (valueMatch) {
    const field = getField(valueMatch[1]);
    const values = field?.enum ?? (field?.type === 'boolean' ? ['true', 'false'] : undefined);
    if (!field || !values) return [];
    const quoted = valueMatch[2] !== '';
    const partial = valueMatch[3];
    const startCol = col - partial.length;
    return values.map((v) => ({
      label: v,
      kind: 'value' as const,
      // Bare (unquoted) strings in JSON need quotes; booleans and YAML do not.
      insertText: json && !quoted && field.type === 'string' ? `"${v}"` : v,
      detail: field.name,
      documentation: field.description,
      replaceStartCol: startCol,
    }));
  }

  // Key position: `  "ti` (JSON, top level) or `ti` (YAML, column 0).
  const keyMatch = json ? prefix.match(/^\s*"([^"]*)$/) : prefix.match(/^([A-Za-z_][\w-]*)?$/);
  // YAML: don't offer keys at the start of a line that already has one.
  if (keyMatch && (json || !text.slice(col).includes(':'))) {
    const partial = keyMatch[1] ?? '';
    const have = presentKeys(block);
    // A Dossier field written at the top level of a spec-shaped file is rejected by the parser.
    const spec = isSpecShapedBlock(block);
    return FIELDS.filter((f) => !have.has(f.name) && (!spec || SPEC_TOP_LEVEL.has(f.name))).map(
      (f) => ({
        label: f.name,
        kind: 'property' as const,
        // JSON: the auto-closed quote is already there; YAML: add the colon.
        insertText: json ? f.name : `${f.name}: `,
        detail: `${f.type}${f.required ? ' (required)' : ''}`,
        documentation: describe(f),
        replaceStartCol: col - partial.length,
      })
    );
  }
  return [];
}

const SPEC_TOP_LEVEL = new Set<string>(SPEC_TOP_LEVEL_FIELDS);

/** Completion on a `metadata` child line: `dossier.<field>` keys, and values for them. */
function specCompletions(
  block: FrontmatterBlock,
  text: string,
  prefix: string,
  col: number
): CompletionEntry[] {
  const json = block.style === 'json';
  const valueMatch = json
    ? prefix.match(/^\s*"dossier\.([^"]+)"\s*:\s*("?)([^"]*)$/)
    : prefix.match(/^\s*(["']?)dossier\.([^"':\s]+)\1\s*:\s*(["']?)([^"']*)$/);
  if (valueMatch) {
    const [name, quote, partial] = json
      ? [valueMatch[1], valueMatch[2], valueMatch[3]]
      : [valueMatch[2], valueMatch[3], valueMatch[4]];
    const field = getField(name);
    const values = field?.enum ?? (field?.type === 'boolean' ? ['true', 'false'] : undefined);
    if (!field || !values) return [];
    // Metadata values are strings: a bare `true` would be a YAML/JSON boolean and is rejected,
    // so booleans are always quoted, and JSON strings need quotes whatever the field type.
    const needsQuotes = quote === '' && (json || field.type === 'boolean');
    const q = json ? '"' : "'";
    return values.map((v) => ({
      label: v,
      kind: 'value' as const,
      insertText: needsQuotes ? `${q}${v}${q}` : v,
      detail: `${SPEC_KEY_PREFIX}${field.name}`,
      documentation: field.description,
      replaceStartCol: col - partial.length,
    }));
  }

  const keyMatch = json ? prefix.match(/^\s*"([^"]*)$/) : prefix.match(/^\s*([\w.-]*)$/);
  if (!keyMatch || (!json && text.slice(col).includes(':'))) return [];
  const partial = keyMatch[1];
  const have = new Set(specKeys(block).map((k) => k.field));
  return FIELDS.filter((f) => !have.has(f.name) && !SPEC_TOP_LEVEL.has(f.name)).map((f) => ({
    label: `${SPEC_KEY_PREFIX}${f.name}`,
    kind: 'property' as const,
    insertText: json ? `${SPEC_KEY_PREFIX}${f.name}` : `${SPEC_KEY_PREFIX}${f.name}: `,
    detail: `${f.type}${f.required ? ' (required)' : ''}`,
    documentation: describe(f),
    replaceStartCol: col - partial.length,
  }));
}

export function hoverAt(content: string, line: number, col: number): HoverEntry | null {
  const block = locateFrontmatter(content);
  if (!block || !isInsideFrontmatter(block, line)) return null;
  const text = block.lines[line] ?? '';
  const key = topLevelKeyOnLine(block, line);
  if (!key) {
    const spec = specKeyOnLine(block, line);
    const field = spec && getField(spec.field);
    if (!spec || !field || col < spec.startCol || col > spec.endCol) return null;
    return { markdown: describe(field), startCol: spec.startCol, endCol: spec.endCol };
  }
  const field = getField(key);
  if (!field) return null;
  const startCol = text.indexOf(key);
  const endCol = startCol + key.length;
  if (col < startCol || col > endCol) return null;
  return { markdown: describe(field), startCol, endCol };
}
