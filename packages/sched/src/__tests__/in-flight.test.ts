import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  describeInFlight,
  IN_FLIGHT_RUN_FILES,
  type InFlightCapRun,
  inFlightAlive,
  inFlightDir,
  listInFlight,
  procStartTime,
  readInFlight,
  releaseOwnStateLock,
  removeInFlight,
  waitingOnLiveGate,
  writeInFlight,
} from '../index';

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

describe('in-flight capability runs (#1233)', () => {
  let stateDir: string;
  let dir: string;
  const children: ChildProcess[] = [];
  /** A live, detached `sleep` — a stand-in gate leading its own process group. */
  const liveGroup = (): number => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    children.push(child);
    return child.pid as number;
  };
  const record = (over: Partial<InFlightCapRun> = {}): InFlightCapRun => ({
    version: 1,
    capability: 'gate.batch',
    cwd: '/wt/batch-b1',
    pid: deadPid(),
    pid_start: null,
    started_at: '2026-10-15T05:53:44.000Z',
    timeout_ms: 3_600_000,
    launcher_pid: 3416683,
    run_dir: path.join(dir, 'run-a'),
    head: 'a'.repeat(40),
    ...over,
  });

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-in-flight-'));
    dir = inFlightDir(stateDir);
  });
  afterEach(() => {
    for (const c of children.splice(0)) {
      try {
        process.kill(-(c.pid as number), 'SIGKILL');
      } catch {
        // gone
      }
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('round-trips one record per worktree + capability, private on disk', () => {
    const r = record();
    const file = writeInFlight(dir, r);
    expect(readInFlight(dir, '/wt/batch-b1', 'gate.batch')).toEqual(r);
    expect(readInFlight(dir, '/wt/batch-b1', 'test.focused')).toBeNull();
    expect(readInFlight(dir, '/wt/other', 'gate.batch')).toBeNull();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('tightens a pre-existing, looser in-flight dir to 0700', () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    writeInFlight(dir, record());
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('a record that could steer a delete or a signal elsewhere reads as absent', () => {
    const bad = [
      record({ run_dir: os.homedir() }), // not a child of the registry
      record({ run_dir: path.join(dir, 'not-a-run') }), // not a run-* dir
      record({ run_dir: path.join(dir, '..', 'run-x') }), // escapes the registry
      record({ pid: process.pid }), // never the engine itself
      record({ started_at: 'yesterday' }), // unparseable start → would kill at once
    ];
    for (const r of bad) {
      writeInFlight(dir, r);
      expect(readInFlight(dir, r.cwd, r.capability)).toBeNull();
    }
    expect(listInFlight(dir)).toEqual([]);
  });

  it('removeInFlight drops the record and its run directory, never a symlink target', () => {
    const r = record();
    fs.mkdirSync(r.run_dir, { recursive: true });
    writeInFlight(dir, r);
    removeInFlight(dir, r);
    expect(readInFlight(dir, r.cwd, r.capability)).toBeNull();
    expect(fs.existsSync(r.run_dir)).toBe(false);

    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-in-flight-target-'));
    try {
      fs.symlinkSync(target, path.join(dir, 'run-link'));
      removeInFlight(dir, record({ run_dir: path.join(dir, 'run-link') }));
      expect(fs.existsSync(target)).toBe(true);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('liveness: a dead pid is dead; a live detached group is alive until it exits', async () => {
    expect(inFlightAlive({ pid: deadPid(), pid_start: null })).toBe(false);
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    const pid = child.pid as number;
    try {
      expect(inFlightAlive({ pid, pid_start: procStartTime(pid) })).toBe(true);
    } finally {
      process.kill(-pid, 'SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    expect(inFlightAlive({ pid, pid_start: null })).toBe(false);
  });

  it.skipIf(process.platform !== 'linux')(
    'a RECYCLED leader pid (start time differs) is not our gate — never probed as a group',
    () => {
      const pid = liveGroup(); // an unrelated group leader now owns the pid
      const start = procStartTime(pid) as number;
      expect(inFlightAlive({ pid, pid_start: start })).toBe(true);
      expect(inFlightAlive({ pid, pid_start: start + 1 })).toBe(false);
    }
  );

  it('the group outlives its leader: a surviving member keeps the run alive', async () => {
    // The wrapper (leader) exits at once; its backgrounded `sleep` stays in the group.
    const child = spawn('/bin/sh', ['-c', 'sleep 30 & exit 0'], {
      detached: true,
      stdio: 'ignore',
    });
    const pid = child.pid as number;
    await new Promise((resolve) => child.once('exit', resolve));
    try {
      expect(inFlightAlive({ pid, pid_start: null })).toBe(true);
    } finally {
      process.kill(-pid, 'SIGKILL');
    }
  });

  it('lists runs with liveness and finished state, and describes them for alerts', () => {
    const finished = record({ cwd: '/wt/b2', run_dir: path.join(dir, 'run-b') });
    fs.mkdirSync(finished.run_dir, { recursive: true });
    fs.writeFileSync(path.join(finished.run_dir, IN_FLIGHT_RUN_FILES.status), '0\n');
    writeInFlight(dir, finished);
    const live = liveGroup();
    writeInFlight(dir, record({ pid: live }));
    const listed = listInFlight(dir);
    expect(listed).toHaveLength(2);
    const byCwd = new Map(listed.map((l) => [l.record.cwd, l]));
    expect(byCwd.get('/wt/b2')).toMatchObject({ alive: false, finished: true });
    expect(byCwd.get('/wt/batch-b1')).toMatchObject({ alive: true, finished: false });
    const line = describeInFlight(byCwd.get('/wt/batch-b1') as (typeof listed)[number]);
    expect(line).toContain(
      `gate.batch pid ${live} (STILL RUNNING) started 2026-10-15T05:53:44.000Z in /wt/batch-b1`
    );
    expect(line).toContain(`kill -TERM -- -${live}`);
    expect(line).toContain(path.join(dir, 'run-a'));
    expect(describeInFlight(byCwd.get('/wt/b2') as (typeof listed)[number])).toContain(
      'finished, not consumed'
    );
  });

  it('waitingOnLiveGate: only a live gate this pid launched or waits on, within its deadline', () => {
    const now = new Date('2026-10-15T06:00:00.000Z');
    expect(waitingOnLiveGate(dir, 4242, now)).toBe(false);
    writeInFlight(dir, record({ pid: liveGroup(), launcher_pid: 4242 }));
    expect(waitingOnLiveGate(dir, 4242, now)).toBe(true);
    expect(waitingOnLiveGate(dir, 4243, now)).toBe(false);
    // past started_at + timeout_ms → no longer a legitimate wait
    expect(waitingOnLiveGate(dir, 4242, new Date('2026-10-15T07:00:00.000Z'))).toBe(false);
    writeInFlight(dir, record({ cwd: '/wt/b3', pid: liveGroup(), waiter_pid: 5151 }));
    expect(waitingOnLiveGate(dir, 5151, now)).toBe(true);
  });

  it('releaseOwnStateLock frees only a lock that names this pid', () => {
    const lock = path.join(stateDir, '.sched-lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid + 1));
    expect(releaseOwnStateLock(stateDir)).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
    expect(releaseOwnStateLock(stateDir)).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
    expect(releaseOwnStateLock(stateDir)).toBe(false);
  });
});
