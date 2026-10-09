import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createFixtures } from '../../fixtures/retention';
import {
  boundedRead,
  digest,
  directoryEntries,
  fileDigest,
  JOURNAL_BYTES,
  RECORD_BYTES,
  strictJsonLines,
} from './files';

const { rig, cleanup } = createFixtures();
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});
it('refuses oversized sparse evidence before allocation or any read', () => {
  const r = rig(),
    file = r.artifact();
  fs.truncateSync(file, RECORD_BYTES + 1);
  const read = vi.spyOn(fs, 'readSync'),
    allocation = vi.spyOn(Buffer, 'alloc');
  expect(() => boundedRead(file)).toThrow('size-limit');
  expect(read).not.toHaveBeenCalled();
  expect(allocation).not.toHaveBeenCalled();
});
it('detects growth during a bounded descriptor read', () => {
  const r = rig(),
    file = r.artifact();
  const read = fs.readSync;
  let changed = false;
  vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
    const count = read(...args);
    if (!changed) {
      changed = true;
      fs.appendFileSync(file, 'growth');
    }
    return count;
  });
  expect(() => boundedRead(file)).toThrow();
});
it('pins regular inodes and streams bulk hashes with a fixed-size allocation', () => {
  const r = rig(),
    file = r.artifact('bulk', 'x'.repeat(RECORD_BYTES * 2));
  const stat = fs.statSync(file);
  const alloc = vi.spyOn(Buffer, 'alloc');
  expect(fileDigest(file, stat, stat.size)).toBe(digest('x'.repeat(stat.size)));
  expect(alloc.mock.calls.every(([size]) => size <= 64 * 1024)).toBe(true);
  expect(() => fileDigest(file, stat, stat.size - 1)).toThrow('size-limit');
  fs.symlinkSync(file, path.join(r.temp, 'alias'));
  expect(() => boundedRead(path.join(r.temp, 'alias'))).toThrow();
  expect([...directoryEntries(path.dirname(file))]).toContain('bulk');
});
it.each([
  '{}',
  '{}\n\n',
  '{bad}\n',
  '{"a":"gh\\u0070_hidden","a":"safe"}\n',
])('strict JSONL refuses torn/empty/malformed/secret records', (text) => {
  expect(() => strictJsonLines(Buffer.from(text))).toThrow();
});
it('strict JSONL enforces UTF8, per-line, total and count bounds and scans raw duplicate values', () => {
  expect(strictJsonLines(Buffer.from('{}\n{"v":1}\n'))).toEqual([{}, { v: 1 }]);
  expect(() => strictJsonLines(Buffer.from([0xff, 10]))).toThrow();
  expect(() => strictJsonLines(Buffer.from(`${' '.repeat(RECORD_BYTES)}{}\n`))).toThrow(
    'size-limit'
  );
  expect(() => strictJsonLines(Buffer.alloc(JOURNAL_BYTES + 1))).toThrow('size-limit');
  expect(() => strictJsonLines(Buffer.from('{}\n'.repeat(10001)))).toThrow('size-limit');
});
