import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { issueOfUnit, Journal, unitEvent } from '../index';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-journal-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Journal (#464 AC6 — all events journaled)', () => {
  it('appends events with a stamped ts and reads them back oldest-first', () => {
    const dir = tmpDir();
    const journal = new Journal(dir);
    const now = new Date('2026-08-29T12:00:00Z');
    journal.append(unitEvent('spawned', 'issue:464', { pid: 123, tier: 'mid' }), now);
    journal.append(unitEvent('verify-complete', 'issue:460'), new Date('2026-08-29T12:01:00Z'));

    const events = journal.read();
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      ts: '2026-08-29T12:00:00.000Z',
      event: 'spawned',
      unit: 'issue:464',
      issue: 464,
      pid: 123,
      tier: 'mid',
    });
    expect(events[1].ts).toBe('2026-08-29T12:01:00.000Z');
  });

  it('unitEvent extracts the issue number from issue units and leaves batch units intact', () => {
    expect(unitEvent('spawned', 'issue:464')).toEqual({
      event: 'spawned',
      unit: 'issue:464',
      issue: 464,
    });
    expect(unitEvent('assigned', 'batch:b1')).toEqual({ event: 'assigned', unit: 'batch:b1' });
  });

  it('skips malformed lines on read', () => {
    const dir = tmpDir();
    const journal = new Journal(dir);
    journal.append(unitEvent('spawned', 'issue:1'), new Date());
    fs.appendFileSync(journal.filePath, '{not json}\n');
    journal.append(unitEvent('spawned', 'issue:2'), new Date());
    expect(journal.read().map((e) => e.unit)).toEqual(['issue:1', 'issue:2']);
  });

  it('never throws when the directory is unwritable', () => {
    // A regular FILE at the parent path makes the journal's mkdir fail fast
    // (ENOTDIR) — an unwritable journal location without hanging on odd mounts.
    const blocker = path.join(tmpDir(), 'not-a-dir');
    fs.writeFileSync(blocker, 'file');
    const journal = new Journal(path.join(blocker, 'events.jsonl'));
    const warned: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      warned.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(() => journal.append(unitEvent('spawned', 'issue:1'))).not.toThrow();
    } finally {
      process.stderr.write = original;
    }
    expect(warned.some((w) => w.includes('journal'))).toBe(true);
  });

  it('read on a missing file returns an empty list', () => {
    expect(new Journal(tmpDir()).read()).toEqual([]);
  });
});

describe('issueOfUnit — untrusted input (#524 review)', () => {
  it('returns null for a non-string unit instead of throwing', () => {
    // Reachable from `buildSchedCostReport`, which reads JSON.parse'd
    // runs.jsonl lines cast to RunLogEntry without validation: one
    // hand-edited `"unit": 5` must skip the row, not kill `sched stats`.
    expect(issueOfUnit(5 as unknown as string)).toBeNull();
    expect(issueOfUnit({} as unknown as string)).toBeNull();
    expect(issueOfUnit(null)).toBeNull();
    expect(issueOfUnit(undefined)).toBeNull();
  });
});
