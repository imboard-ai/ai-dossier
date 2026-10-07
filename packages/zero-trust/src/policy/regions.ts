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
  let htmlEnd: string | undefined;
  const lines = file.content.split(/\r\n|\n|\r/u);
  if (!readme) {
    region = { ambiguous: false, lines: [] };
    regions.push(region);
  }
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index];
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(text);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length)
        fence = undefined;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(text);
    if (open && (open[1][0] !== '`' || !open[2].includes('`'))) {
      fence = { marker: open[1][0], length: open[1].length };
      continue;
    }
    // An HTML block cannot manufacture a heading that ends the active region.
    // Comments/raw tags have explicit ends; other HTML blocks end at a blank.
    const html = /^ {0,3}<(?:!--|\/?[A-Za-z]|!|\?)/u.test(text);
    if (readme && (html || htmlEnd !== undefined)) {
      if (region) {
        region.ambiguous = true;
        region.lines.push({ text, line: index + 1 });
      }
      if (htmlEnd === undefined) {
        const raw = /^ {0,3}<(script|style|pre|textarea)(?:\s|>)/iu.exec(text);
        htmlEnd = text.trimStart().startsWith('<!--')
          ? '-->'
          : raw
            ? `</${raw[1].toLowerCase()}>`
            : '';
      }
      if (htmlEnd ? text.toLowerCase().includes(htmlEnd) : text.trim() === '') htmlEnd = undefined;
      continue;
    }
    if (readme) {
      const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/u.exec(text);
      if (heading) {
        const level = heading[1].length;
        if (region && level <= depth) region = undefined;
        if (!region && /contribut/iu.test(heading[2] ?? '')) {
          depth = level;
          region = { ambiguous: false, lines: [] };
          regions.push(region);
        }
        // Headings establish regions; they are not policy assertions.
        continue;
      }
      if (
        region &&
        index > 0 &&
        lines[index - 1].trim() !== '' &&
        /^ {0,3}(?:=+|-+)[ \t]*$/u.test(text)
      )
        region.ambiguous = true;
    }
    region?.lines.push({ text, line: index + 1 });
  }
  return regions;
}
