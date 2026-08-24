import { describe, expect, it } from 'vitest';
import { renderTable } from '../table';

describe('renderTable', () => {
  it('pads every column to its widest cell', () => {
    const out = renderTable(
      ['phase', 'n'],
      [
        ['gate', '1'],
        ['implement', '12'],
      ]
    );
    const [header, first, second] = out.split('\n');
    expect(header).toBe('phase      n');
    expect(first).toBe('gate       1');
    expect(second).toBe('implement  12');
  });

  it('right-aligns the columns asked for', () => {
    const out = renderTable(['a', 'bbb'], [['x', '1']], { align: ['left', 'right'] });
    expect(out.split('\n')[1]).toBe('x    1');
  });

  it('tolerates a short row rather than printing undefined', () => {
    const out = renderTable(['a', 'b'], [['x']]);
    expect(out.split('\n')[1]).toBe('x');
  });

  it('appends a row that is longer than the headers rather than padding to undefined', () => {
    const out = renderTable(['a'], [['x', 'extra']]);
    expect(out.split('\n')[1]).toBe('x  extra');
  });

  it('renders headers alone when there are no rows', () => {
    expect(renderTable(['a', 'b'], [])).toBe('a  b');
  });

  it('draws a rule under the header when asked', () => {
    const out = renderTable(['ab', 'c'], [['x', 'y']], { separator: true });
    expect(out.split('\n')).toEqual(['ab  c', '--  -', 'x   y']);
  });

  it('sizes a column from its header when that is the widest cell', () => {
    const out = renderTable(['duration', 'n'], [['5s', '1']]);
    expect(out.split('\n')[1]).toBe('5s        1');
  });

  /**
   * Row counts come from caller data — for `runstate stats` that means "however many
   * milestone comments anyone chose to post". `Math.max(...rows)` overflows the stack
   * around 124k arguments, so the widths are folded instead.
   */
  it('handles more rows than a spread call could take', () => {
    const rows = Array.from({ length: 200_000 }, () => ['x']);
    expect(() => renderTable(['h'], rows)).not.toThrow();
  });
});
