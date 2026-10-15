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
 * consumed. The launch/adopt protocol lives in the CLI
 * (`cli/src/cap-run-tracked.ts`: `runTrackedCapRun` / `launchTrackedCapRun`);
 * this module owns the file format, validation, liveness and listing, so
 * `sched status`, the stale-lease alert, the engine's in-tick heartbeat and the
 * launcher all read the same truth.
 *
 * Every gate is launched in its own process group (`detached`), with `pid` the
 * group leader, so liveness is "does any process of that group still exist".
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { procStartTime, procStatFields } from './dispatch';
import { writeAtomic } from './persist';

export const IN_FLIGHT_DIR = 'in-flight';

/** Prefix of every run directory the launcher creates inside the in-flight dir. */
export const IN_FLIGHT_RUN_DIR_PREFIX = 'run-';

/** Files inside a run's private directory (`run_dir`). */
export const IN_FLIGHT_RUN_FILES = {
  /** Written by the launch wrapper with `cap run`'s exit code once it exits. */
  status: 'status',
  stdout: 'stdout',
  stderr: 'stderr',
  envelope: 'envelope.json',
} as const;

/** `/proc/<pid>/stat` post-comm field indexes (see `procStatFields`). */
const STAT_STATE_IDX = 0;
const STAT_PGRP_IDX = 2;

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
  /** A later process (a restarted engine, `sched resume --batch`) currently waiting on it, if any. */
  waiter_pid?: number;
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

/**
 * Parse and VALIDATE a record read from `dir`. A record steers a recursive
 * delete (`run_dir`) and a process-group signal (`pid`), so anything that does
 * not look exactly like what the launcher writes — a corrupted, hand-edited or
 * copied-from-elsewhere file — reads as absent.
 */
function parseRecord(raw: unknown, dir: string): InFlightCapRun | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Partial<InFlightCapRun>;
  if (
    r.version !== 1 ||
    typeof r.capability !== 'string' ||
    typeof r.cwd !== 'string' ||
    typeof r.pid !== 'number' ||
    !Number.isInteger(r.pid) ||
    r.pid <= 1 ||
    r.pid === process.pid ||
    typeof r.started_at !== 'string' ||
    !Number.isFinite(Date.parse(r.started_at)) ||
    typeof r.timeout_ms !== 'number' ||
    !(r.timeout_ms > 0) ||
    typeof r.run_dir !== 'string'
  ) {
    return null;
  }
  // The run directory must be one the launcher created: a `run-*` child of THIS dir.
  const runDir = path.resolve(r.run_dir);
  if (
    path.dirname(runDir) !== path.resolve(dir) ||
    !path.basename(runDir).startsWith(IN_FLIGHT_RUN_DIR_PREFIX)
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
    ...(typeof r.waiter_pid === 'number' ? { waiter_pid: r.waiter_pid } : {}),
    run_dir: runDir,
    head: typeof r.head === 'string' ? r.head : null,
  };
}

function readRecordFile(file: string, dir: string): InFlightCapRun | null {
  try {
    return parseRecord(JSON.parse(fs.readFileSync(file, 'utf8')), dir);
  } catch {
    return null;
  }
}

/** Create `dir` 0700 — and tighten it when it already existed with looser bits. */
export function ensureInFlightDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // best effort — the record files themselves are 0600
  }
}

/** Atomic, durable write (tmp + fsync + rename), 0600, directory 0700. */
export function writeInFlight(dir: string, record: InFlightCapRun): string {
  ensureInFlightDir(dir);
  const file = recordFile(dir, record.cwd, record.capability);
  writeAtomic(file, `${JSON.stringify(record)}\n`);
  return file;
}

export function readInFlight(dir: string, cwd: string, capability: string): InFlightCapRun | null {
  return readRecordFile(recordFile(dir, cwd, capability), dir);
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
  if (opts.keepRunDir) return;
  const runDir = path.resolve(record.run_dir);
  if (
    path.dirname(runDir) !== path.resolve(dir) ||
    !path.basename(runDir).startsWith(IN_FLIGHT_RUN_DIR_PREFIX)
  ) {
    return;
  }
  try {
    if (!fs.lstatSync(runDir).isDirectory()) return; // never follow a symlink
    fs.rmSync(runDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/** `kill(pid, 0)` — the process (or, for a negative pid, the group) exists; EPERM counts. */
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isZombie(pid: number): boolean {
  return procStatFields(pid)?.[STAT_STATE_IDX] === 'Z';
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
    const fields = procStatFields(Number(entry));
    if (
      fields !== null &&
      Number(fields[STAT_PGRP_IDX]) === pgid &&
      fields[STAT_STATE_IDX] !== 'Z'
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Whether the gate is still running — identity-checked, because the answer
 * gates a process-GROUP kill:
 *  - leader alive and its `/proc` start time matches (or is unknowable on both
 *    sides, off Linux) → alive;
 *  - leader pid alive but its start time DIFFERS → the pid was recycled. A pid
 *    is never reused while it is still a group id, so our gate's group is gone:
 *    NOT alive (the recycled pid may lead an unrelated group — never probe it);
 *  - leader gone → alive iff some other member of its process group still runs
 *    (a `cap run` whose wrapper was killed keeps running).
 */
export function inFlightAlive(record: Pick<InFlightCapRun, 'pid' | 'pid_start'>): boolean {
  if (record.pid <= 1 || record.pid === process.pid) return false;
  if (pidExists(record.pid) && !isZombie(record.pid)) {
    const start = procStartTime(record.pid);
    if (record.pid_start !== null && start !== null && start !== record.pid_start) return false;
    return true;
  }
  if (process.platform === 'win32') return false;
  return pidExists(-record.pid) && !(isZombie(record.pid) && onlyLeaderInGroup(record.pid));
}

export function inFlightFinished(record: Pick<InFlightCapRun, 'run_dir'>): boolean {
  return fs.existsSync(path.join(record.run_dir, IN_FLIGHT_RUN_FILES.status));
}

/** Every recorded in-flight run, with liveness. Unreadable or invalid files are skipped. */
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
    const record = readRecordFile(file, dir);
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

/**
 * #1233: is a gate that THIS process launched or is waiting on still within its
 * budget? The engine's in-tick heartbeat keeps the lease fresh only then — a
 * tick stuck anywhere else goes stale on the usual `engine-hung` schedule.
 */
export function waitingOnLiveGate(
  dir: string,
  pid: number = process.pid,
  now: Date = new Date()
): boolean {
  return listInFlight(dir).some(
    ({ record, alive, finished }) =>
      alive &&
      !finished &&
      (record.launcher_pid === pid || record.waiter_pid === pid) &&
      now.getTime() < Date.parse(record.started_at) + record.timeout_ms
  );
}

/** One human line per in-flight run — `sched status`, the stale-lease alert. */
export function describeInFlight(entry: InFlightListing): string {
  const { record } = entry;
  const state = entry.alive ? 'STILL RUNNING' : entry.finished ? 'finished, not consumed' : 'dead';
  const hint = entry.alive
    ? `; the next engine adopts it — or stop it with \`kill -TERM -- -${record.pid}\``
    : '';
  return `${record.capability} pid ${record.pid} (${state}) started ${record.started_at} in ${record.cwd}; logs ${record.run_dir}${hint}`;
}
