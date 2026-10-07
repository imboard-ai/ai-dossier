import MarkdownIt from 'markdown-it';
import { type PolicyFile, PolicyInputError } from './discover';

export interface PolicyRegion {
  readonly ambiguous: boolean;
  readonly lines: readonly { readonly text: string; readonly line: number }[];
}

// Parsing only: no rendering, plugins, linkification, callbacks or resource reads.
const MAX_NESTING = 20;
// The runtime supports maxNesting although the published Options type omits it.
const parserOptions = { html: true, maxNesting: MAX_NESTING };
const markdown = new MarkdownIt('commonmark', parserOptions);

function assertHtmlSeparator(text: string): void {
  const opener = text.split(/\r\n|\n|\r/u, 1)[0];
  // Refuse parser/CommonMark disagreements before trusting scope. The parser
  // accepts lowercase declarations and JS whitespace throughout type-7 start
  // syntax. This bounded profile admits only horizontal ASCII whitespace on
  // HTML opener lines, including attribute values and trailing text.
  if (/^ {0,3}<![a-z]/u.test(opener) || (/^ {0,3}</u.test(opener) && /[^\S \t]/u.test(opener)))
    throw new PolicyInputError();
}

/** Apply the policy subset to CommonMark's block/source maps. This avoids
 * mistaking HTML contents/thematic breaks for fences, ATX or setext headings.
 * Unsupported setext/HTML taints the entire selected README contribution region. */
export function policyRegions(file: PolicyFile): readonly PolicyRegion[] {
  const readme = file.path === 'README.md';
  const regions: { ambiguous: boolean; lines: { text: string; line: number }[] }[] = [];
  let region: (typeof regions)[number] | undefined;
  let depth = 0;
  const lines = file.content.split(/\r\n|\n|\r/u);
  const tokens = markdown.parse(file.content, {});
  // The parser can stop emitting leaf evidence at its nesting cap. Refuse the
  // cap's boundary conservatively, never mistake omitted evidence for silence.
  if (tokens.some((token) => token.level >= MAX_NESTING - 1)) throw new PolicyInputError();
  const excluded = new Set<number>();
  const ambiguous = new Set<number>();
  const headings = new Map<number, RegExpExecArray>();
  for (const token of tokens) {
    // Validate the container-stripped opener too: raw lines can retain list/quote
    // prefixes that hide an unsupported separator from the source-line guard.
    if (token.type === 'html_block') assertHtmlSeparator(token.content);
    if (!token.map) continue;
    const [start, end] = token.map;
    if (token.type === 'fence') {
      for (let index = start; index < end; index++) excluded.add(index);
    } else if (readme && token.type === 'html_block') {
      for (let index = start; index < end; index++) ambiguous.add(index);
    } else if (readme && token.type === 'heading_open') {
      const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/u.exec(lines[start]);
      if (atx) headings.set(start, atx);
      else if (token.markup === '=' || token.markup === '-') ambiguous.add(start);
    }
  }
  if (!readme) {
    region = { ambiguous: false, lines: [] };
    regions.push(region);
  }
  for (let index = 0; index < lines.length; index++) {
    if (excluded.has(index)) continue;
    // markdown-it's HTML opener uses broader JS whitespace than CommonMark.
    // Unsupported non-horizontal whitespace is a closed refusal, not silence.
    assertHtmlSeparator(lines[index]);
    const atx = headings.get(index);
    if (atx) {
      const level = atx[1].length;
      if (region && level <= depth) region = undefined;
      if (!region && /contribut/iu.test(atx[2] ?? '')) {
        depth = level;
        region = { ambiguous: false, lines: [] };
        regions.push(region);
      }
    }
    if (region) {
      if (ambiguous.has(index)) region.ambiguous = true;
      // All non-fenced source text is evidence, including reference definitions
      // omitted from token maps. Parsed maps establish structure, never silence.
      region.lines.push({ text: lines[index], line: index + 1 });
    }
  }
  return regions;
}
