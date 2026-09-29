import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completionsAt, hoverAt } from '../completion';
import { KeyedDebouncer } from '../debounce';
import { computeDiagnostics } from '../diagnostics';
import { findFieldRange, isTopLevelLine, locateFrontmatter } from '../frontmatter';

const FOUR_SPACE = [
  '---dossier',
  '{',
  '    "title": "Four space",',
  '    "risk_level": "low",',
  '    "checksum": {',
  '        "algorithm": "sha256",',
  '        "hash": "x"',
  '    },',
  '    "',
  '}',
  '---',
  'body',
].join('\n');

describe('YAML parse error line (review bug 1)', () => {
  it('reports the offending line, not the one after it', () => {
    const doc = '---\ntitle: ok\nname: fine\n  bad: x\n---\nbody';
    const d = computeDiagnostics(doc);
    expect(d[0].code).toBe('parse');
    expect(d[0].range.line).toBe(3);
  });

  it('never points at the opener or the closing delimiter', () => {
    const d = computeDiagnostics('---\n  bad: x\n\tworse: [\n---\nbody');
    expect(d[0].range.line).toBeGreaterThanOrEqual(1);
    expect(d[0].range.line).toBeLessThan(4);
  });
});

describe('indentation-agnostic JSON keys (review bug 3)', () => {
  const block = locateFrontmatter(FOUR_SPACE);
  if (!block) throw new Error('no block');

  it('treats 4-space top-level keys as top level and nested ones as nested', () => {
    expect(isTopLevelLine(block, 3)).toBe(true);
    expect(isTopLevelLine(block, 5)).toBe(false);
  });

  it('completes keys, minus present ones, in a 4-space file', () => {
    const labels = completionsAt(FOUR_SPACE, 8, 5).map((c) => c.label);
    expect(labels).toContain('status');
    expect(labels).not.toContain('title');
    expect(labels).not.toContain('checksum');
  });

  it('completes enum values in a 4-space file', () => {
    const doc = FOUR_SPACE.replace('"risk_level": "low",', '"risk_level": ');
    const line = doc.split('\n').findIndex((l) => l.includes('risk_level'));
    const items = completionsAt(doc, line, doc.split('\n')[line].length);
    expect(items.map((i) => i.label)).toContain('critical');
  });

  it('offers nothing for nested keys', () => {
    expect(completionsAt(FOUR_SPACE, 5, 12)).toEqual([]);
  });

  it('hovers a 4-space top-level key but not a nested one', () => {
    expect(hoverAt(FOUR_SPACE, 3, 7)?.markdown).toContain('risk_level');
    expect(hoverAt(FOUR_SPACE, 5, 12)).toBeNull();
  });
});

describe('findFieldRange anchors on top-level keys (review minor)', () => {
  const doc = [
    '---dossier',
    '{',
    '  "relationships": {',
    '    "version": "nested"',
    '  },',
    '  "version": "top"',
    '}',
    '---',
  ].join('\n');

  it('skips a nested key of the same name', () => {
    const block = locateFrontmatter(doc);
    if (!block) throw new Error('no block');
    expect(findFieldRange(block, 'version')?.line).toBe(5);
  });

  it('finds a nested key only inside its own parent', () => {
    const block = locateFrontmatter(doc);
    if (!block) throw new Error('no block');
    expect(findFieldRange(block, 'relationships.version')?.line).toBe(3);
    // `version` is not a child of `version`: falls back to the parent.
    expect(findFieldRange(block, 'version.nope')?.line).toBe(5);
  });
});

describe('YAML key completion nit', () => {
  it('does not offer keys at the start of a line that already has one', () => {
    expect(completionsAt('---\ntitle: x\n---\n', 1, 0)).toEqual([]);
  });
});

describe('KeyedDebouncer (review bug 4)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces rapid schedules per key', () => {
    const fn = vi.fn();
    const d = new KeyedDebouncer();
    d.schedule('a', 300, fn);
    d.schedule('a', 300, fn);
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(d.pending).toBe(0);
  });

  it('does not fire after cancel (close within the debounce window)', () => {
    const fn = vi.fn();
    const d = new KeyedDebouncer();
    d.schedule('a', 300, fn);
    d.cancel('a');
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
    expect(d.pending).toBe(0);
  });

  it('does not fire after dispose (deactivate)', () => {
    const fn = vi.fn();
    const d = new KeyedDebouncer();
    d.schedule('a', 300, fn);
    d.schedule('b', 300, fn);
    d.dispose();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
    expect(d.pending).toBe(0);
  });
});
