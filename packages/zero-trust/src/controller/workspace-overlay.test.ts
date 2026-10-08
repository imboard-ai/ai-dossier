import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createManifest, exportSource, type SourceEntry, sha256 } from '../canonical/export';
import { MAX_FILE_BYTES } from '../vm/broker';
import { WorkspaceOverlay } from './workspace-overlay';

const temps: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-test-'));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const entry = (name: string, bytes: Buffer, mode: SourceEntry['mode'] = '100644'): SourceEntry => ({
  path: name,
  mode,
  bytes: bytes.toString('base64'),
  sha256: sha256(bytes),
});

describe('WorkspaceOverlay controller-held source', () => {
  it('keeps binary base blobs, empty directories, executable bits and only exact admitted writes', () => {
    const entries = [
      entry('empty', Buffer.alloc(0), '040000'),
      entry('run', Buffer.from('old'), '100755'),
      entry('blob', Buffer.from([0, 255, 128])),
    ];
    const base = createManifest(entries);
    const overlay = new WorkspaceOverlay(base);
    entries.splice(0);
    overlay.write('run', 'new');
    overlay.write('src/a.ts', 'fix');
    overlay.write('tests/a.js', 'test');
    overlay.write('src/a.ts', 'final fix');
    const manifest = overlay.materialize(path.join(temp(), 'candidate'));
    expect(manifest.entries).toEqual(
      createManifest([
        ...base.entries.filter((e) => e.path !== 'run'),
        entry('run', Buffer.from('new'), '100755'),
        entry('src', Buffer.alloc(0), '040000'),
        entry('src/a.ts', Buffer.from('final fix')),
        entry('tests', Buffer.alloc(0), '040000'),
        entry('tests/a.js', Buffer.from('test')),
      ]).entries
    );
    expect(overlay.base).toEqual(base);
    expect(overlay.executable('run')).toBe(true);
    expect(overlay.executable('src/a.ts')).toBe(false);
    expect(overlay.testFiles()).toEqual(['tests/a.js']);
  });
  it('uses every scope-review test path rule and lists only writes in stable order', () => {
    const overlay = new WorkspaceOverlay(createManifest([]));
    const tests = [
      'test/a.js',
      'tests/b.ts',
      '__tests__/c.js',
      'x.test.',
      'a.spec.ts',
      'test_a.py',
      'b_test.py',
    ];
    for (const file of [...tests].reverse()) overlay.write(file, 'test');
    for (const file of ['test.ts', 'testing/a.ts', 'contest.py']) overlay.write(file, 'source');
    expect(overlay.testFiles()).toEqual(tests.sort());
    expect(Object.isFrozen(overlay.testFiles())).toBe(true);
  });
  it.each([
    '../outside',
    '/absolute',
    'a//b',
    'a\\b',
    '.git/config',
    'a\nname',
    'C:drive',
  ])('refuses unsafe write %j without changing candidate', (file) => {
    const overlay = new WorkspaceOverlay(createManifest([]));
    expect(() => overlay.write(file, 'x')).toThrow();
    expect(overlay.materialize(path.join(temp(), 'out')).entries).toEqual([]);
  });
  it('refuses credential and oversized contents', () => {
    const overlay = new WorkspaceOverlay(createManifest([]));
    expect(() => overlay.write('a', ['gh', 'p_', 'fixture'].join(''))).toThrow();
    expect(() => overlay.write('a', 'é'.repeat(MAX_FILE_BYTES / 2 + 1))).toThrow('limit_exceeded');
  });
  it('rejects file/directory and case collisions atomically', () => {
    const overlay = new WorkspaceOverlay(
      createManifest([entry('a', Buffer.alloc(0), '040000'), entry('b', Buffer.from('b'))])
    );
    for (const file of ['a', 'b/child', 'B']) expect(() => overlay.write(file, 'x')).toThrow();
    expect(overlay.materialize(path.join(temp(), 'out'))).toEqual(overlay.base);
  });
  it('refuses existing directories and symlinks without modifying their contents', () => {
    const dir = temp();
    const overlay = new WorkspaceOverlay(createManifest([]));
    fs.writeFileSync(path.join(dir, 'sentinel'), 'keep');
    expect(() => overlay.materialize(dir)).toThrow();
    const link = path.join(temp(), 'link');
    fs.symlinkSync(dir, link);
    expect(() => overlay.materialize(link)).toThrow();
    expect(fs.readFileSync(path.join(dir, 'sentinel'), 'utf8')).toBe('keep');
  });
  it('revalidates the baseline rather than trusting a forged digest', () => {
    expect(() => new WorkspaceOverlay({ ...createManifest([]), digest: 'forged' })).toThrow(
      'invalid_manifest'
    );
    const dir = temp();
    fs.writeFileSync(path.join(dir, 'a'), 'base');
    const overlay = new WorkspaceOverlay(exportSource(dir));
    fs.writeFileSync(path.join(dir, 'a'), 'later repository process');
    expect(overlay.materialize(path.join(temp(), 'out')).entries[0].bytes).toBe(
      Buffer.from('base').toString('base64')
    );
  });
});
