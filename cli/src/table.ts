/**
 * Column-aligned plain-text tables.
 *
 * Several commands print tabular output and each used to compute its own column widths
 * and hand-pad — the same eight lines, re-derived. This is the one implementation they
 * share; a new table is a call, not another copy.
 */

/** Column alignment. Numeric columns read right-aligned; everything else left. */
export type ColumnAlign = 'left' | 'right';

export interface TableOptions {
  /** Per-column alignment, indexed like `headers`. Missing entries default to `left`. */
  align?: ColumnAlign[];
  /** Draw a `---` rule under the header row. */
  separator?: boolean;
}

/**
 * Longest cell in column `index`, counting the header.
 *
 * Folded rather than spread into `Math.max(...)`: the row count is caller data — for
 * `runstate stats` it is driven by how many milestone comments an issue has, which anyone
 * who can comment controls — and a spread of ~124k arguments overflows the stack.
 */
function columnWidth(header: string, rows: string[][], index: number): number {
  return rows.reduce((width, row) => Math.max(width, (row[index] ?? '').length), header.length);
}

/**
 * Render a table with each column padded to its widest cell.
 *
 * Cells are taken as already-printable text: a row shorter than `headers` is padded out,
 * and a row LONGER than `headers` has its extra cells appended unpadded, since there is no
 * column to size them against. Callers rendering untrusted text should sanitise it first —
 * a control character makes `.length` disagree with what the terminal draws, which silently
 * destroys the alignment this function exists to provide.
 */
export function renderTable(
  headers: string[],
  rows: string[][],
  options: TableOptions = {}
): string {
  const { align = [], separator = false } = options;
  const widths = headers.map((header, i) => columnWidth(header, rows, i));

  const pad = (cell: string, i: number): string => {
    if (i >= widths.length) return cell;
    return align[i] === 'right' ? cell.padStart(widths[i]) : cell.padEnd(widths[i]);
  };
  const line = (cells: string[]): string =>
    cells
      .map((cell, i) => pad(cell, i))
      .join('  ')
      .trimEnd();

  const out = [line(headers)];
  if (separator) out.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) out.push(line(row));
  return out.join('\n');
}
