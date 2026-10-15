/**
 * In-flight capability runs (#1233): the engine's record of a gate it has
 * launched and not yet consumed.
 *
 * The batch gate (`cap run gate.batch`, 25–55 min) and the per-member gate
 * (`cap run test.focused`) outlive the engine that launched them whenever the
 * engine is killed mid-gate (a host reaper's SIGKILL, OOM, a stop-timeout).
 * Before this record existed a restarted engine had no way to know a gate was
 * still running in the worktree, so it launched a duplicate, which collided on
 * the gate's isolated resources (2026-09-29: a false `suite-unreadable` block).
 *
 * One JSON file per (worktree, capability) under `<stateDir>/in-flight/`,
 * written BEFORE the launcher starts waiting and removed once the verdict is
 * consumed. The launcher (`spawnCapRun` in the CLI) owns the protocol; this
 * module owns the file format, liveness and listing, so `sched status`, the
 * stale-lease alert and the launcher all read the same truth.
 *
 * Every gate is launched in its own process group (`detached`), with `pid` the
 * group leader, so liveness is "does any process of that group still exist".
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { procStartTime } from './dispatch';

export const IN_FLIGHT_DIR = 'in-flight';

/** Files inside a run's private directory (`run_dir`). */
export const IN_FLIGHT_RUN_FILES = {
  /** Written by the launch wrapper with `cap run`'s exit code once it exits. */
  status: 'status',
  stdout: 'stdout',
  stderr: 'stderr',
  envelope: 'envelope.json',
} as const;

export interface InFlightCapRun {
  version: 1;
  capability: string;
  /** Absolute worktree the gate runs in. */
  cwd: string;
  /** Process-group leader (the launch wrapper); also the process group id. */
  pid: number;
  /** `/proc` start time of `pid` — a recycled pid is not our gate. Null off Linux. */
  pid_start: number | null;
  started_at: string;
  timeout_ms: number;
  /** The engine (or CLI) process that launched it. */
  launcher_pid: number;
  /** Private directory holding the run's status/stdout/stderr/envelope files. */
  run_dir: string;
  /** `git rev-parse HEAD` of `cwd` at launch — a finished verdict is only adopted for the same HEAD. */
  head: string | null;
}

export interface InFlightListing {
  record: InFlightCapRun;
  /** Some process of the gate's process group is still running. */
  alive: boolean;
  /** The wrapper recorded `cap run`'s exit status (the verdict is on disk). */
  finished: boolean;
  /** The record file this listing came from. */
  file: string;
}

export function inFlightDir(stateDir: string): string {
  return path.join(stateDir, IN_FLIGHT_DIR);
}

function recordFile(dir: string, cwd: string, capability: string): string {
  const key = createHash('sha256')
    .update(`${path.resolve(cwd)}\0${capability}`)
    .digest('hex')
    .slice(0, 16);
  return path.join(dir, `${capability.replace(/[^a-z0-9.-]/gi, '_')}-${key}.json`);
}

function parseRecord(raw: unknown): InFlightCapRun | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Partial<InFlightCapRun>;
  if (
    r.version !== 1 ||
    typeof r.capability !== 'string' ||
    typeof r.cwd !== 'string' ||
    typeof r.pid !== 'number' ||
    !Number.isInteger(r.pid) ||
    r.pid <= 1 ||
    typeof r.started_at !== 'string' ||
    typeof r.timeout_ms !== 'number' ||
    typeof r.run_dir !== 'string'
  ) {
    return null;
  }
  return {
    version: 1,
    capability: r.capability,
    cwd: r.cwd,
    pid: r.pid,
    pid_start: typeof r.pid_start === 'number' ? r.pid_start : null,
    started_at: r.started_at,
    timeout_ms: r.timeout_ms,
    launcher_pid: typeof r.launcher_pid === 'number' ? r.launcher_pid : 0,
    run_dir: r.run_dir,
    head: typeof r.head === 'string' ? r.head : null,
  };
}

function readRecordFile(file: string): InFlightCapRun | null {
  try {
    return parseRecord(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/** Atomic write (tmp + rename), 0600, directory 0700. */
export function writeInFlight(dir: string, record: InFlightCapRun): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = recordFile(dir, record.cwd, record.capability);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return file;
}

export function readInFlight(dir: string, cwd: string, capability: string): InFlightCapRun | null {
  return readRecordFile(recordFile(dir, cwd, capability));
}

/** Remove the record (and, unless `keepRunDir`, its run directory). Best effort. */
export function removeInFlight(
  dir: string,
  record: Pick<InFlightCapRun, 'cwd' | 'capability' | 'run_dir'>,
  opts: { keepRunDir?: boolean } = {}
): void {
  try {
    fs.rmSync(recordFile(dir, record.cwd, record.capability), { force: true });
  } catch {
    // best effort
  }
  if (!opts.keepRunDir) {
    try {
      fs.rmSync(record.run_dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

/** `/proc/<pid>/stat` state is `Z` — exited but not yet reaped by its parent. */
function isZombie(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
  } catch {
    return false;
  }
}

function signalReaches(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether the gate is still running: the leader is alive (and is the process we
 * launched, by start time) or — the leader gone — some other member of its
 * process group still is (a `cap run` whose wrapper was killed keeps running).
 */
export function inFlightAlive(record: Pick<InFlightCapRun, 'pid' | 'pid_start'>): boolean {
  if (signalReaches(record.pid) && !isZombie(record.pid)) {
    const start = procStartTime(record.pid);
    if (record.pid_start === null || start === null || start === record.pid_start) return true;
    // The pid was recycled by an unrelated process: our leader is gone. A
    // recycled pid is not a group leader of our group, so the group probe
    // below still answers for the gate's other members.
  }
  if (process.platform === 'win32') return false;
  return signalReaches(-record.pid) && !(isZombie(record.pid) && onlyLeaderInGroup(record.pid));
}

/** Linux: the leader is the only process left in its group (best effort; false when unknown). */
function onlyLeaderInGroup(pgid: number): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === pgid) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf-8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      // field 5 (pgrp) → index 2 in the post-comm array (field 3 = index 0)
      if (Number(fields[2]) === pgid && fields[0] !== 'Z') return false;
    } catch {
      // raced with an exit — ignore
    }
  }
  return true;
}

export function inFlightFinished(record: Pick<InFlightCapRun, 'run_dir'>): boolean {
  return fs.existsSync(path.join(record.run_dir, IN_FLIGHT_RUN_FILES.status));
}

/** Every recorded in-flight run, with liveness. Unreadable files are skipped. */
export function listInFlight(dir: string): InFlightListing[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: InFlightListing[] = [];
  for (const name of names.sort()) {
    const file = path.join(dir, name);
    const record = readRecordFile(file);
    if (record === null) continue;
    out.push({
      record,
      alive: inFlightAlive(record),
      finished: inFlightFinished(record),
      file,
    });
  }
  return out;
}

/** One human line per in-flight run — `sched status`, the stale-lease alert. */
export function describeInFlight(entry: InFlightListing): string {
  const { record } = entry;
  const state = entry.alive ? 'STILL RUNNING' : entry.finished ? 'finished, not consumed' : 'dead';
  return `${record.capability} pid ${record.pid} (${state}) started ${record.started_at} in ${record.cwd}`;
}
