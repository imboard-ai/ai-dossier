import type { PolicyFile } from './discover';

export interface PolicyRegion {
  readonly ambiguous: boolean;
  readonly lines: readonly { readonly text: string; readonly line: number }[];
}

/** The supported CommonMark subset. Unsupported setext/HTML constructs taint
 * the entire enclosing README region, including already-collected evidence. */
export function policyRegions(file: PolicyFile): readonly PolicyRegion[] {
  const readme = file.path === 'README.md';
  const regions: { ambiguous: boolean; lines: { text: string; line: number }[] }[] = [];
  let region: (typeof regions)[number] | undefined;
  let depth = 0;
  let fence: { marker: string; length: number } | undefined;
  let htmlEnd: RegExp | null | undefined;
  let paragraph = false;
  const lines = file.content.split(/\r\n|\n|\r/u);
  if (!readme) {
    region = { ambiguous: false, lines: [] };
    regions.push(region);
  }
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index];
    // Active HTML content cannot open a Markdown fence or manufacture a heading.
    if (htmlEnd !== undefined) {
      paragraph = false;
      if (region) {
        region.ambiguous = true;
        region.lines.push({ text, line: index + 1 });
      }
      if (htmlEnd ? htmlEnd.test(text) : text.trim() === '') htmlEnd = undefined;
      continue;
    }
    if (fence) {
      paragraph = false;
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(text);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length)
        fence = undefined;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(text);
    if (open && (open[1][0] !== '`' || !open[2].includes('`'))) {
      paragraph = false;
      fence = { marker: open[1][0], length: open[1].length };
      continue;
    }
    // An HTML block cannot manufacture a heading that ends the active region.
    // Comments/raw tags have explicit ends; other HTML blocks end at a blank.
    const html = /^ {0,3}<(?:!--|\/?[A-Za-z]|!|\?)/u.test(text);
    if (readme && html) {
      paragraph = false;
      if (region) {
        region.ambiguous = true;
        region.lines.push({ text, line: index + 1 });
      }
      const raw = /^ {0,3}<(script|style|pre|textarea)(?:\s|>|$)/iu.exec(text);
      const start = text.trimStart();
      htmlEnd = start.startsWith('<!--')
        ? /-->/u
        : start.startsWith('<?')
          ? /\?>/u
          : start.startsWith('<![CDATA[')
            ? /\]\]>/u
            : /^<![A-Z]/u.test(start)
              ? />/u
              : raw
                ? new RegExp(`</${raw[1]}\\s*>`, 'iu')
                : null;
      if (htmlEnd?.test(text)) htmlEnd = undefined;
      continue;
    }
    if (readme) {
      const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/u.exec(text);
      if (heading) {
        paragraph = false;
        const level = heading[1].length;
        if (region && level <= depth) region = undefined;
        if (!region && /contribut/iu.test(heading[2] ?? '')) {
          depth = level;
          region = { ambiguous: false, lines: [] };
          regions.push(region);
        }
        // In-region headings can themselves state restrictions; boundary headings
        // outside the selected contribution region must never become evidence.
        region?.lines.push({ text, line: index + 1 });
        continue;
      }
      if (region && paragraph && /^ {0,3}(?:=+|-+)[ \t]*$/u.test(text)) region.ambiguous = true;
    }
    region?.lines.push({ text, line: index + 1 });
    // Setext requires a paragraph, not merely a preceding nonblank physical
    // line: ATX headings, list items and closed fences cannot become setext.
    paragraph =
      text.trim() !== '' &&
      !/^ {0,3}(?:=+|-+)[ \t]*$/u.test(text) &&
      !/^ {0,3}(?:[-+*][ \t]+|\d{1,9}[.)][ \t]+|>)/u.test(text) &&
      !/^(?: {4}|\t)/u.test(text);
  }
  return regions;
}
