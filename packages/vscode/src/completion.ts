/**
 * Frontmatter completion + hover, driven by dossier-schema.json.
 *
 * Why a small provider instead of VS Code's JSON language service: the JSON features only attach
 * to whole-document `json` files. Feeding them a block embedded in Markdown means running a
 * virtual-document + request-forwarding shim (and YAML frontmatter would need a second one),
 * which is far more moving parts than the ~100 lines here. This also handles both frontmatter
 * shapes (JSON `---dossier` and YAML) with one code path.
 */
import {
  type FrontmatterBlock,
  isInsideFrontmatter,
  locateFrontmatter,
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
    const k = topLevelKeyOnLine(block, block.lines[i]);
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

  // Value position: `"status": "Dr` / `"status": ` (JSON) or `status: Dr` (YAML).
  const valueMatch = json
    ? prefix.match(/^ {0,2}"([^"]+)"\s*:\s*("?)([^"]*)$/)
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
  const keyMatch = json ? prefix.match(/^ {0,2}"([^"]*)$/) : prefix.match(/^([A-Za-z_][\w-]*)?$/);
  if (keyMatch) {
    const partial = keyMatch[1] ?? '';
    const have = presentKeys(block);
    return FIELDS.filter((f) => !have.has(f.name)).map((f) => ({
      label: f.name,
      kind: 'property' as const,
      // JSON: the auto-closed quote is already there; YAML: add the colon.
      insertText: json ? f.name : `${f.name}: `,
      detail: `${f.type}${f.required ? ' (required)' : ''}`,
      documentation: describe(f),
      replaceStartCol: col - partial.length,
    }));
  }
  return [];
}

export function hoverAt(content: string, line: number, col: number): HoverEntry | null {
  const block = locateFrontmatter(content);
  if (!block || !isInsideFrontmatter(block, line)) return null;
  const text = block.lines[line] ?? '';
  const key = topLevelKeyOnLine(block, text);
  if (!key) return null;
  const field = getField(key);
  if (!field) return null;
  const startCol = text.indexOf(key);
  const endCol = startCol + key.length;
  if (col < startCol || col > endCol) return null;
  return { markdown: describe(field), startCol, endCol };
}
