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
 * Nesting depth (`{`/`[` opened minus closed, outside strings) at the START of `line`, counting
 * from the line after the opener. A top-level key of a JSON block sits at depth 1, inside the
 * outer `{`. Depth, not indentation, so 2-space, 4-space and tab-indented files all work.
 */
export function jsonDepthAtLineStart(block: FrontmatterBlock, line: number): number {
  let depth = 0;
  for (let i = block.openLine + 1; i < line; i++) {
    let inString = false;
    const text = block.lines[i] ?? '';
    for (let c = 0; c < text.length; c++) {
      const ch = text[c];
      if (inString) {
        if (ch === '\\') c++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
    }
  }
  return depth;
}

/** True when `line` starts at the top level of the frontmatter mapping. */
export function isTopLevelLine(block: FrontmatterBlock, line: number): boolean {
  return block.style === 'json'
    ? jsonDepthAtLineStart(block, line) === 1
    : !/^\s/.test(block.lines[line] ?? '');
}

/**
 * Finds the key token for a dotted field path like `signature.algorithm` or `authors.0.name`.
 * The first segment must be a top-level key (so a nested `version` cannot capture `version`);
 * later segments are searched between their parent and the next top-level key.
 * Falls back to the deepest segment that was found, then to null.
 */
export function findFieldRange(block: FrontmatterBlock, fieldPath: string): Range | null {
  const end = block.closeLine === -1 ? block.lines.length : block.closeLine;
  const segments = fieldPath.split('.').filter((s) => s !== '' && !/^\d+$/.test(s));
  let found: Range | null = null;
  let from = block.openLine + 1;
  let limit = end;
  for (let idx = 0; idx < segments.length; idx++) {
    const re = keyPattern(segments[idx]);
    let hit = -1;
    for (let i = from; i < limit; i++) {
      if (re.test(block.lines[i]) && (idx > 0 || isTopLevelLine(block, i))) {
        hit = i;
        break;
      }
    }
    if (hit === -1) break;
    const startCol = (block.lines[hit].match(re) as RegExpMatchArray)[1].length;
    const keyLen = (block.lines[hit].match(re) as RegExpMatchArray)[2].length;
    found = { line: hit, startCol, endLine: hit, endCol: startCol + keyLen };
    if (idx === 0) limit = nextTopLevelLine(block, hit + 1, end);
    from = hit + 1;
  }
  return found;
}

function nextTopLevelLine(block: FrontmatterBlock, from: number, end: number): number {
  for (let i = from; i < end; i++) {
    if (topLevelKeyOnLine(block, i)) return i;
  }
  return end;
}

/** Whole-line range, used when a diagnostic has no better anchor. */
export function lineRange(lines: string[], line: number): Range {
  const l = Math.min(Math.max(line, 0), Math.max(lines.length - 1, 0));
  return { line: l, startCol: 0, endLine: l, endCol: (lines[l] ?? '').length };
}

/** The frontmatter key on `line` when it is a top-level key, else null. */
export function topLevelKeyOnLine(block: FrontmatterBlock, line: number): string | null {
  const text = block.lines[line] ?? '';
  const m =
    block.style === 'json' ? text.match(/^\s*"([^"]+)"\s*:/) : text.match(/^([A-Za-z_][\w-]*)\s*:/);
  return m && isTopLevelLine(block, line) ? m[1] : null;
}
