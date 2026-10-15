/**
 * Tracked `cap run` launcher for the sched engine (#1233).
 *
 * `spawnSync` gave the engine no pid until the gate had finished, kept the
 * gate in the engine's process group, and left nothing behind when the engine
 * died mid-gate — so a restarted engine launched a duplicate gate that
 * collided with the orphaned one. This launcher:
 *
 *   - starts `ai-dossier cap run <id>` through a tiny `/bin/sh` wrapper in its
 *     OWN process group (`detached`), output and exit status going to files in
 *     a private run directory (no pipe a descendant can hold open, no maxBuffer);
 *   - records the run in the in-flight registry (`@ai-dossier/sched`
 *     `writeInFlight`) BEFORE it starts waiting — pid, start time, worktree,
 *     HEAD — so `sched status`, the stale-lease alert and the next engine see it;
 *   - waits synchronously (the batch state machine is synchronous) by polling,
 *     and on its timeout kills the whole process group;
 *   - on entry, ADOPTS a recorded run for the same worktree + capability: a
 *     live one is waited for (never duplicated), a finished one is consumed
 *     when it ran against the same HEAD; anything else is discarded.
 *
 * It returns the same `SpawnSyncReturns`-shaped result the legacy path does, so
 * verdict resolution (`resolveVerdict` in cap-envelope.ts) is shared.
 */

import { type SpawnSyncReturns, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IN_FLIGHT_RUN_FILES,
  type InFlightCapRun,
  inFlightAlive,
  inFlightFinished,
  procStartTime,
  readInFlight,
  removeInFlight,
  writeInFlight,
} from '@ai-dossier/sched';
import { CAP_ENVELOPE_FILE_ENV } from './capability';

/** Poll cadence while waiting for a gate. */
export const TRACKED_POLL_MS = 500;
/** Grace between SIGTERM and SIGKILL to the gate's process group on timeout. */
export const TRACKED_KILL_GRACE_MS = 5_000;
/** A finished-but-unconsumed run older than this is not adopted. */
export const ADOPT_FINISHED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** `sh` exit code for "command not found". */
const SH_NOT_FOUND = 127;

/** Runs `cap run <id>` and records its exit status atomically; `$1`=capability, `$2`=status file. */
const WRAPPER_SCRIPT = 'ai-dossier cap run "$1"; s=$?; echo "$s" > "$2.tmp" && mv "$2.tmp" "$2"';

export interface TrackedCapRun {
  spawned: SpawnSyncReturns<string>;
  /** The run directory's envelope file (read by the caller's verdict resolution). */
  envelopeFile: string;
  /** Adoption / launch notes for the caller's diagnostics. */
  notes: string[];
  /** Remove the in-flight record and run directory — call once the envelope has been read. */
  release: () => void;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function gitHead(cwd: string): string | null {
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8', timeout: 10_000 });
    const sha = typeof r.stdout === 'string' ? r.stdout.trim() : '';
    return r.status === 0 && /^[0-9a-f]{7,64}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Last `maxBytes` of a file ('' when absent). */
function readTail(file: string, maxBytes: number): string {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return '';
  }
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // group already gone
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function errno(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Wait for a recorded run to finish (its wrapper wrote a status) or die, killing
 * its whole process group at `deadlineMs`. Returns whether it timed out.
 */
function waitForRun(record: InFlightCapRun, deadlineMs: number): { timedOut: boolean } {
  const statusFile = path.join(record.run_dir, IN_FLIGHT_RUN_FILES.status);
  for (;;) {
    if (fs.existsSync(statusFile)) return { timedOut: false };
    if (!inFlightAlive(record)) return { timedOut: false };
    if (Date.now() >= deadlineMs) break;
    sleepSync(Math.min(TRACKED_POLL_MS, Math.max(1, deadlineMs - Date.now())));
  }
  signalGroup(record.pid, 'SIGTERM');
  const graceEnd = Date.now() + TRACKED_KILL_GRACE_MS;
  while (Date.now() < graceEnd && inFlightAlive(record) && !fs.existsSync(statusFile)) {
    sleepSync(100);
  }
  if (inFlightAlive(record)) signalGroup(record.pid, 'SIGKILL');
  return { timedOut: true };
}

/** Build the `spawnSync`-shaped result from a run directory. */
function collect(
  record: InFlightCapRun,
  timedOut: boolean,
  maxBuffer: number,
  timeoutMs: number
): SpawnSyncReturns<string> {
  const dir = record.run_dir;
  const stdout = readTail(path.join(dir, IN_FLIGHT_RUN_FILES.stdout), maxBuffer);
  const stderr = readTail(path.join(dir, IN_FLIGHT_RUN_FILES.stderr), maxBuffer);
  let code: number | null = null;
  try {
    const parsed = Number.parseInt(
      fs.readFileSync(path.join(dir, IN_FLIGHT_RUN_FILES.status), 'utf-8').trim(),
      10
    );
    code = Number.isInteger(parsed) ? parsed : null;
  } catch {
    code = null;
  }
  let status: number | null = code;
  let signal: NodeJS.Signals | null = null;
  let error: Error | undefined;
  if (code !== null && code > 128 && code < 128 + 65) {
    // `$?` of a signal-killed `cap run` — report it the way spawnSync would.
    const name = Object.entries(os.constants.signals).find(([, n]) => n === code - 128)?.[0];
    status = null;
    signal = (name as NodeJS.Signals | undefined) ?? null;
  }
  if (timedOut && code === null) {
    error = errno(`cap run ${record.capability} ETIMEDOUT after ${timeoutMs}ms`, 'ETIMEDOUT');
    signal = 'SIGTERM';
  } else if (
    code === SH_NOT_FOUND &&
    !fs.existsSync(path.join(dir, IN_FLIGHT_RUN_FILES.envelope))
  ) {
    // `sh` could not find `ai-dossier` on PATH — spawnSync's ENOENT.
    error = errno('spawnSync ai-dossier ENOENT', 'ENOENT');
    status = null;
  }
  return {
    pid: record.pid,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status,
    signal,
    ...(error !== undefined ? { error } : {}),
  };
}

/**
 * Run (or adopt) `ai-dossier cap run <capabilityId>` in `cwd`, tracked under
 * `inFlightDir`. Synchronous; returns once the gate has a verdict, died, or
 * timed out (process group killed).
 */
export function runTrackedCapRun(
  capabilityId: string,
  cwd: string,
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv; inFlightDir: string; maxBuffer: number }
): TrackedCapRun {
  const notes: string[] = [];
  const worktree = path.resolve(cwd);
  const head = gitHead(worktree);
  const dir = opts.inFlightDir;

  const existing = readInFlight(dir, worktree, capabilityId);
  if (existing !== null) {
    const finished = inFlightFinished(existing);
    const alive = !finished && inFlightAlive(existing);
    if (alive) {
      // Never launch a duplicate next to a live gate (#1233) — wait for it.
      notes.push(
        `adopted in-flight ${capabilityId} pid ${existing.pid} started ${existing.started_at} by pid ${existing.launcher_pid}`
      );
      process.stderr.write(
        `▶ sched: adopting in-flight ${capabilityId} (pid ${existing.pid}, started ${existing.started_at}) in ${worktree} instead of launching a duplicate\n`
      );
      const deadline = Date.parse(existing.started_at) + existing.timeout_ms;
      const { timedOut } = waitForRun(existing, Number.isFinite(deadline) ? deadline : 0);
      if (head !== null && existing.head === head) {
        const spawned = collect(existing, timedOut, opts.maxBuffer, existing.timeout_ms);
        const envelopeFile = path.join(existing.run_dir, IN_FLIGHT_RUN_FILES.envelope);
        return {
          spawned,
          envelopeFile,
          notes,
          // A launcher still alive (a live engine, while an operator's `sched
          // resume --batch` waited alongside it) consumes and cleans up its own run.
          release: () => {
            if (!processAlive(existing.launcher_pid)) removeInFlight(dir, existing);
          },
        };
      }
      notes.push(
        `adopted run was against HEAD ${existing.head ?? 'unknown'}, now ${head ?? 'unknown'} — re-running`
      );
      removeInFlight(dir, existing);
    } else if (
      finished &&
      head !== null &&
      existing.head === head &&
      Date.now() - Date.parse(existing.started_at) < ADOPT_FINISHED_MAX_AGE_MS
    ) {
      notes.push(
        `adopted finished ${capabilityId} pid ${existing.pid} (started ${existing.started_at}) for the same HEAD`
      );
      const spawned = collect(existing, false, opts.maxBuffer, existing.timeout_ms);
      const envelopeFile = path.join(existing.run_dir, IN_FLIGHT_RUN_FILES.envelope);
      return { spawned, envelopeFile, notes, release: () => removeInFlight(dir, existing) };
    } else {
      notes.push(
        `discarded ${finished ? 'stale finished' : 'dead'} in-flight record (pid ${existing.pid}, started ${existing.started_at})`
      );
      removeInFlight(dir, existing);
    }
  }

  const launched = launchTrackedCapRun(capabilityId, worktree, {
    timeoutMs: opts.timeoutMs,
    env: opts.env,
    inFlightDir: dir,
    head,
  });
  if ('error' in launched) {
    return {
      spawned: {
        pid: 0,
        output: [null, '', ''],
        stdout: '',
        stderr: '',
        status: null,
        signal: null,
        error: launched.error,
      },
      envelopeFile: '',
      notes,
      release: () => {},
    };
  }
  const { record } = launched;
  if (launched.note !== undefined) notes.push(launched.note);
  const { timedOut } = waitForRun(record, Date.now() + opts.timeoutMs);
  const spawned = collect(record, timedOut, opts.maxBuffer, opts.timeoutMs);
  return {
    spawned,
    envelopeFile: path.join(record.run_dir, IN_FLIGHT_RUN_FILES.envelope),
    notes,
    release: () => removeInFlight(dir, record),
  };
}

/**
 * Start `cap run <capabilityId>` detached (its own process group) through the
 * status-recording wrapper and record it in the in-flight registry. Returns
 * at once — the caller waits. Exported so a test can stand in for an engine
 * that launched a gate and then died.
 */
export function launchTrackedCapRun(
  capabilityId: string,
  worktree: string,
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv; inFlightDir: string; head: string | null }
): { record: InFlightCapRun; note?: string } | { error: Error } {
  const dir = opts.inFlightDir;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const runDir = fs.mkdtempSync(path.join(dir, 'run-'));
  const files = {
    status: path.join(runDir, IN_FLIGHT_RUN_FILES.status),
    stdout: path.join(runDir, IN_FLIGHT_RUN_FILES.stdout),
    stderr: path.join(runDir, IN_FLIGHT_RUN_FILES.stderr),
    envelope: path.join(runDir, IN_FLIGHT_RUN_FILES.envelope),
  };
  const outFd = fs.openSync(files.stdout, 'w', 0o600);
  const errFd = fs.openSync(files.stderr, 'w', 0o600);
  let pid: number | undefined;
  try {
    const child = spawn('/bin/sh', ['-c', WRAPPER_SCRIPT, 'sh', capabilityId, files.status], {
      cwd: worktree,
      env: { ...(opts.env ?? process.env), [CAP_ENVELOPE_FILE_ENV]: files.envelope },
      stdio: ['ignore', outFd, errFd],
      // #1233 (5): its own process group — isolated from signals aimed at the
      // engine's group, and killable as a whole on timeout.
      detached: true,
    });
    // An async spawn failure is reported as an 'error' event; unhandled, it
    // would crash the engine (or its tick worker).
    child.on('error', () => {});
    child.unref();
    pid = child.pid;
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  if (pid === undefined) {
    fs.rmSync(runDir, { recursive: true, force: true });
    return { error: errno('spawn /bin/sh failed', 'ENOENT') };
  }
  const record: InFlightCapRun = {
    version: 1,
    capability: capabilityId,
    cwd: worktree,
    pid,
    pid_start: procStartTime(pid),
    started_at: new Date().toISOString(),
    timeout_ms: opts.timeoutMs,
    launcher_pid: process.pid,
    run_dir: runDir,
    head: opts.head,
  };
  try {
    writeInFlight(dir, record);
  } catch (err) {
    return { record, note: `in-flight record not written: ${(err as Error).message}` };
  }
  return { record };
}
