import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildStatusWarnings,
  checkStaleLeaseAlert,
  createEmptyState,
  enqueueEntries,
  HUNG_INTERVALS_ENV,
  Journal,
  reportCrashRestart,
  resolveHungAfterMs,
  SchedStore,
} from '../index';

const NOW = new Date('2026-09-29T12:00:00Z');

/** A pid that is guaranteed dead: a child that already exited. */
function deadPid(): number {
  for (let i = 0; i < 20; i++) {
    const { pid } = spawnSync(process.execPath, ['-e', '0']);
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('could not obtain a dead pid');
}

describe('engine lease heartbeat, reclaim and alerts (#945)', () => {
  let dir: string;
  let store: SchedStore;
  let journal: Journal;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-alert-'));
    store = new SchedStore(dir, path.join(dir, 'user-config.json'));
    journal = new Journal(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const writeDeadLease = (id = 'dead-1', updated_at?: string) => {
    const leaseDir = path.join(dir, '.sched-engine-lease');
    fs.mkdirSync(leaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(leaseDir, 'holder.json'),
      JSON.stringify({ pid: deadPid(), pid_start: null, id, ...(updated_at ? { updated_at } : {}) })
    );
  };
  const withWork = () =>
    store.withLock(() => ({
      state: enqueueEntries(createEmptyState(), [{ issue: 7, deps: [] }], NOW),
      result: undefined,
    }));

  it('touchEngineLease advances updated_at on the held lease only', () => {
    const acq = store.acquireEngineLease();
    expect(acq.acquired).toBe(true);
    store.touchEngineLease(new Date('2030-01-01T00:00:00Z'));
    expect(store.engineLeaseStatus()?.updated_at).toBe('2030-01-01T00:00:00.000Z');
    expect(store.engineLeaseStatus()?.alive).toBe(true);
    // another store instance holds no lease: a touch is a no-op
    const other = new SchedStore(dir, path.join(dir, 'user-config.json'));
    other.touchEngineLease(new Date('2031-01-01T00:00:00Z'));
    expect(store.engineLeaseStatus()?.updated_at).toBe('2030-01-01T00:00:00.000Z');
    if (acq.acquired) store.releaseEngineLease(acq.lease);
    expect(store.engineLeaseStatus()).toBeNull();
  });

  it('acquiring over a dead holder reports the reclaimed lease; a clean start does not', () => {
    const clean = store.acquireEngineLease();
    expect(clean.acquired && clean.reclaimed).toBeFalsy();
    if (clean.acquired) store.releaseEngineLease(clean.lease);

    writeDeadLease('dead-1', '2026-09-29T10:59:00.000Z');
    const acq = store.acquireEngineLease();
    expect(acq.acquired).toBe(true);
    if (acq.acquired) {
      expect(acq.reclaimed?.updated_at).toBe('2026-09-29T10:59:00.000Z');
      store.releaseEngineLease(acq.lease);
    }
  });

  it('reportCrashRestart journals engine-restarted-after-crash and notifies', () => {
    const notify = vi.fn();
    reportCrashRestart(journal, { pid: 99, pid_start: null, updated_at: 'T' }, notify, NOW);
    expect(journal.read()[0]).toMatchObject({ event: 'engine-restarted-after-crash', pid: 99 });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'engine-restarted-after-crash' })
    );
  });

  it('a stale lease with unfinished work alerts ONCE per episode, and re-arms for the next', () => {
    withWork();
    const notify = vi.fn();
    writeDeadLease('ep-1');
    expect(checkStaleLeaseAlert(store, journal, notify, NOW)).toBe('alerted');
    expect(checkStaleLeaseAlert(store, journal, notify, NOW)).toBe('already-alerted');
    expect(checkStaleLeaseAlert(store, journal, notify, NOW)).toBe('already-alerted');
    expect(notify).toHaveBeenCalledOnce();
    expect(journal.read().filter((e) => e.event === 'stale-engine-lease-alert')).toHaveLength(1);

    // engine comes back, then dies again: a NEW episode alerts again
    const acq = store.acquireEngineLease();
    expect(checkStaleLeaseAlert(store, journal, notify, NOW)).toBe('alive');
    if (acq.acquired) store.releaseEngineLease(acq.lease);
    fs.rmSync(path.join(dir, '.sched-engine-lease'), { recursive: true, force: true });
    writeDeadLease('ep-2');
    expect(checkStaleLeaseAlert(store, journal, notify, NOW)).toBe('alerted');
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('a LIVE pid with a stale heartbeat is hung: alerts once per episode, clears when fresh', () => {
    withWork();
    const notify = vi.fn();
    const acq = store.acquireEngineLease();
    expect(acq.acquired).toBe(true);
    store.touchEngineLease(new Date('2026-09-29T11:00:00Z')); // 60 min before NOW
    const opts = { hungAfterMs: 10 * 60_000 };
    expect(checkStaleLeaseAlert(store, journal, notify, NOW, opts)).toBe('alerted');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'engine-hung' }));
    expect(checkStaleLeaseAlert(store, journal, notify, NOW, opts)).toBe('already-alerted');
    expect(notify).toHaveBeenCalledOnce();
    expect(journal.read().find((e) => e.event === 'stale-engine-lease-alert')?.reason).toBe(
      'engine-hung'
    );
    // heartbeat resumes: alive, markers cleared, a later hang alerts again
    store.touchEngineLease(NOW);
    expect(checkStaleLeaseAlert(store, journal, notify, NOW, opts)).toBe('alive');
    const later = new Date(NOW.getTime() + 60 * 60_000);
    expect(checkStaleLeaseAlert(store, journal, notify, later, opts)).toBe('alerted');
    expect(notify).toHaveBeenCalledTimes(2);
    if (acq.acquired) store.releaseEngineLease(acq.lease);
  });

  it('a hung status warning needs a live pid, a heartbeat, and unfinished work', () => {
    const state = enqueueEntries(createEmptyState(), [{ issue: 7, deps: [] }], NOW);
    const lease = (o: Partial<{ alive: boolean; updated_at: string | null }>) => ({
      pid: 1,
      pid_start: null,
      alive: true,
      updated_at: '2026-09-29T11:00:00Z' as string | null,
      ...o,
    });
    const kinds = (l: ReturnType<typeof lease>, st = state) =>
      buildStatusWarnings(st, l, NOW, 10 * 60_000).map((w) => w.kind);
    expect(kinds(lease({}))).toContain('engine-hung');
    expect(kinds(lease({ updated_at: '2026-09-29T11:55:00Z' }))).not.toContain('engine-hung');
    expect(kinds(lease({ updated_at: null }))).not.toContain('engine-hung');
    expect(kinds(lease({ alive: false }))).not.toContain('engine-hung');
    expect(kinds(lease({}), createEmptyState())).not.toContain('engine-hung');
    expect(resolveHungAfterMs(60_000, {})).toBe(10 * 60_000);
    expect(resolveHungAfterMs(1_000, {})).toBe(5 * 60_000);
    expect(resolveHungAfterMs(60_000, { [HUNG_INTERVALS_ENV]: '3' })).toBe(5 * 60_000);
  });

  it('crash restart after a begun stop is reported as a wedged stop, not a crash', () => {
    const notify = vi.fn();
    reportCrashRestart(journal, { pid: 99, pid_start: null, updated_at: null }, notify, NOW, {
      signal: 'SIGTERM',
      at: 'T0',
    });
    expect(journal.read()[0]).toMatchObject({ reason: 'stop-interrupted' });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'engine-restarted-after-stop-timeout' })
    );
  });

  it('two racing watchers cannot both alert (O_EXCL episode marker)', () => {
    withWork();
    writeDeadLease('race');
    const a = vi.fn();
    const b = vi.fn();
    checkStaleLeaseAlert(store, journal, a, NOW);
    // simulate the loser: same episode, marker already exists
    checkStaleLeaseAlert(store, journal, b, NOW);
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });

  it('an unwritable store never throws out of the watcher (alerts anyway)', () => {
    withWork();
    writeDeadLease('ro');
    const notify = vi.fn();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const brokenJournal = {
      append: () => {
        throw new Error('EACCES');
      },
    } as unknown as Journal;
    fs.chmodSync(dir, 0o500);
    try {
      expect(() => checkStaleLeaseAlert(store, brokenJournal, notify, NOW)).not.toThrow();
      expect(notify).toHaveBeenCalledOnce();
    } finally {
      fs.chmodSync(dir, 0o700);
      vi.restoreAllMocks();
    }
  });

  it('heartbeat CAS: a lease reclaimed by another engine is never overwritten', () => {
    const acq = store.acquireEngineLease();
    expect(acq.acquired).toBe(true);
    const leaseDir = path.join(dir, '.sched-engine-lease');
    const holder = path.join(leaseDir, 'holder.json');
    fs.writeFileSync(holder, JSON.stringify({ pid: 1, pid_start: null, id: 'someone-else' }));
    store.touchEngineLease(NOW);
    expect(JSON.parse(fs.readFileSync(holder, 'utf8')).id).toBe('someone-else');
    expect(fs.readdirSync(leaseDir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('does not alert with no lease, a live lease, or nothing unfinished', () => {
    const notify = vi.fn();
    expect(checkStaleLeaseAlert(store, journal, notify, NOW)).toBe('no-lease');
    writeDeadLease();
    expect(checkStaleLeaseAlert(store, journal, notify, NOW)).toBe('no-work');
    expect(notify).not.toHaveBeenCalled();
  });

  it('a throwing notifier still records the episode (no alert storm)', () => {
    withWork();
    writeDeadLease('ep-x');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const bad = vi.fn(() => {
      throw new Error('gh down');
    });
    expect(checkStaleLeaseAlert(store, journal, bad, NOW)).toBe('alerted');
    expect(checkStaleLeaseAlert(store, journal, bad, NOW)).toBe('already-alerted');
    expect(bad).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });
});
