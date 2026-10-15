import { spawn, spawnSync } from 'node:child_process';
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
  readInFlight,
  removeInFlight,
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
  const record = (over: Partial<InFlightCapRun> = {}): InFlightCapRun => ({
    version: 1,
    capability: 'gate.batch',
    cwd: '/wt/batch-b1',
    pid: deadPid(),
    pid_start: null,
    started_at: '2026-10-15T05:53:44.000Z',
    timeout_ms: 3_600_000,
    launcher_pid: 3416683,
    run_dir: path.join(stateDir, 'run-a'),
    head: 'a'.repeat(40),
    ...over,
  });

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-in-flight-'));
    dir = inFlightDir(stateDir);
  });
  afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  it('round-trips one record per worktree + capability, private on disk', () => {
    const r = record();
    const file = writeInFlight(dir, r);
    expect(readInFlight(dir, '/wt/batch-b1', 'gate.batch')).toEqual(r);
    expect(readInFlight(dir, '/wt/batch-b1', 'test.focused')).toBeNull();
    expect(readInFlight(dir, '/wt/other', 'gate.batch')).toBeNull();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('a malformed record reads as absent and is skipped by the listing', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'gate.batch-junk.json'), '{"version":1,"pid":"x"}');
    expect(listInFlight(dir)).toEqual([]);
  });

  it('removeInFlight drops the record and its run directory', () => {
    const r = record();
    fs.mkdirSync(r.run_dir, { recursive: true });
    writeInFlight(dir, r);
    removeInFlight(dir, r);
    expect(readInFlight(dir, r.cwd, r.capability)).toBeNull();
    expect(fs.existsSync(r.run_dir)).toBe(false);
  });

  it('liveness: a dead pid is dead; a live detached group is alive until it exits', async () => {
    expect(inFlightAlive({ pid: deadPid(), pid_start: null })).toBe(false);
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    const pid = child.pid as number;
    try {
      expect(inFlightAlive({ pid, pid_start: null })).toBe(true);
    } finally {
      process.kill(-pid, 'SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    expect(inFlightAlive({ pid, pid_start: null })).toBe(false);
  });

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
    const finished = record({ cwd: '/wt/b2', run_dir: path.join(stateDir, 'run-b') });
    fs.mkdirSync(finished.run_dir, { recursive: true });
    fs.writeFileSync(path.join(finished.run_dir, IN_FLIGHT_RUN_FILES.status), '0\n');
    writeInFlight(dir, finished);
    writeInFlight(dir, record({ pid: process.pid }));
    const listed = listInFlight(dir);
    expect(listed).toHaveLength(2);
    const byCwd = new Map(listed.map((l) => [l.record.cwd, l]));
    expect(byCwd.get('/wt/b2')).toMatchObject({ alive: false, finished: true });
    expect(byCwd.get('/wt/batch-b1')).toMatchObject({ alive: true, finished: false });
    expect(describeInFlight(byCwd.get('/wt/batch-b1') as (typeof listed)[number])).toBe(
      `gate.batch pid ${process.pid} (STILL RUNNING) started 2026-10-15T05:53:44.000Z in /wt/batch-b1`
    );
    expect(describeInFlight(byCwd.get('/wt/b2') as (typeof listed)[number])).toContain(
      'finished, not consumed'
    );
  });
});
