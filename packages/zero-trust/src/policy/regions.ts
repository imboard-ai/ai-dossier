import MarkdownIt from 'markdown-it';
import type { PolicyFile } from './discover';

export interface PolicyRegion {
  readonly ambiguous: boolean;
  readonly lines: readonly { readonly text: string; readonly line: number }[];
}

// Parsing only: no rendering, plugins, linkification, callbacks or resource reads.
const markdown = new MarkdownIt('commonmark');

/** Apply the policy subset to CommonMark's block/source maps. This avoids
 * mistaking HTML contents/thematic breaks for fences, ATX or setext headings.
 * Unsupported setext/HTML taints the entire selected README contribution region. */
export function policyRegions(file: PolicyFile): readonly PolicyRegion[] {
  const readme = file.path === 'README.md';
  const regions: { ambiguous: boolean; lines: { text: string; line: number }[] }[] = [];
  let region: (typeof regions)[number] | undefined;
  let depth = 0;
  let seen = new Set<number>();
  const lines = file.content.split(/\r\n|\n|\r/u);
  if (!readme) {
    region = { ambiguous: false, lines: [] };
    regions.push(region);
  }
  for (const token of markdown.parse(file.content, {})) {
    if (!token.map || token.type === 'fence') continue;
    const [start, end] = token.map;
    if (readme && token.type === 'heading_open') {
      // Only source ATX headings in the requested 0–3-space subset establish
      // scope. A setext heading is ambiguity evidence, never a scope boundary.
      const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/u.exec(lines[start]);
      if (atx) {
        const level = atx[1].length;
        if (region && level <= depth) region = undefined;
        if (!region && /contribut/iu.test(atx[2] ?? '')) {
          depth = level;
          region = { ambiguous: false, lines: [] };
          regions.push(region);
          seen = new Set();
        }
      } else if (region && (token.markup === '=' || token.markup === '-')) {
        region.ambiguous = true;
      }
    }
    if (readme && region && token.type === 'html_block') region.ambiguous = true;
    // Leaf evidence only. Container maps (lists/quotes) span fenced blocks and
    // must never reintroduce their excluded contents through an enclosing map.
    if (!region || !['inline', 'html_block', 'code_block', 'heading_open'].includes(token.type))
      continue;
    for (let index = start; index < end; index++) {
      if (seen.has(index)) continue;
      region.lines.push({ text: lines[index], line: index + 1 });
      seen.add(index);
    }
  }
  return regions;
}
