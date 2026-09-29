/**
 * Locating a dossier's frontmatter block and the lines of its keys.
 *
 * Real dossiers use two shapes (see `parseDossierContent` in @ai-dossier/core):
 *   ---dossier          (or ---json)          ---
 *   { "title": ... }                          title: ...
 *   ---                                       ---
 * The block is JSON (or YAML) between the opener and the first `---` line. Everything here is
 * pure (no `vscode` import) so it can be unit-tested directly.
 */

export interface Range {
  line: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface FrontmatterBlock {
  /** 'json' when the opener is ---dossier / ---json, otherwise plain YAML. */
  style: 'json' | 'yaml';
  /** Line index of the opening delimiter (always 0). */
  openLine: number;
  /** Line index of the closing `---`, or -1 when the block is never closed. */
  closeLine: number;
  /** Lines of the file, split on \n with any trailing \r removed. */
  lines: string[];
}

export function splitLines(content: string): string[] {
  return content.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Returns null when the file does not start with a frontmatter opener. */
export function locateFrontmatter(content: string): FrontmatterBlock | null {
  if (!content.startsWith('---')) return null;
  const lines = splitLines(content);
  const opener = lines[0].trim();
  let style: 'json' | 'yaml';
  if (opener === '---dossier' || opener === '---json') style = 'json';
  else if (opener === '---') style = 'yaml';
  else if (opener.startsWith('---dossier') || opener.startsWith('---json')) style = 'json';
  else return null;

  let closeLine = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeLine = i;
      break;
    }
  }
  return { style, openLine: 0, closeLine, lines };
}

/** True when `line` is strictly inside the frontmatter body (after the opener, before the close). */
export function isInsideFrontmatter(block: FrontmatterBlock, line: number): boolean {
  if (line <= block.openLine) return false;
  return block.closeLine === -1 || line < block.closeLine;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches `"key":` (JSON) or `key:` (YAML) at any indentation. */
function keyPattern(key: string): RegExp {
  const k = escapeRegExp(key);
  return new RegExp(`^(\\s*)("${k}"|${k})\\s*:`);
}

/**
 * Finds the key token for a dotted field path like `signature.algorithm` or `authors.0.name`,
 * descending one segment at a time so a nested key is only matched after its parent.
 * Falls back to the deepest segment that was found, then to null.
 */
export function findFieldRange(block: FrontmatterBlock, fieldPath: string): Range | null {
  const end = block.closeLine === -1 ? block.lines.length : block.closeLine;
  const segments = fieldPath.split('.').filter((s) => s !== '' && !/^\d+$/.test(s));
  let from = block.openLine + 1;
  let found: Range | null = null;
  for (const seg of segments) {
    const re = keyPattern(seg);
    let hit = -1;
    for (let i = from; i < end; i++) {
      if (re.test(block.lines[i])) {
        hit = i;
        break;
      }
    }
    if (hit === -1) break;
    const m = block.lines[hit].match(re) as RegExpMatchArray;
    const startCol = m[1].length;
    found = { line: hit, startCol, endLine: hit, endCol: startCol + m[2].length };
    from = hit;
  }
  return found;
}

/** Whole-line range, used when a diagnostic has no better anchor. */
export function lineRange(lines: string[], line: number): Range {
  const l = Math.min(Math.max(line, 0), Math.max(lines.length - 1, 0));
  return { line: l, startCol: 0, endLine: l, endCol: (lines[l] ?? '').length };
}

/** The frontmatter key at the start of `lineText` when it is a top-level key, else null. */
export function topLevelKeyOnLine(block: FrontmatterBlock, lineText: string): string | null {
  const m =
    block.style === 'json'
      ? lineText.match(/^ {0,2}"([^"]+)"\s*:/)
      : lineText.match(/^([A-Za-z_][\w-]*)\s*:/);
  return m ? m[1] : null;
}
