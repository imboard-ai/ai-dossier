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
 *     a private run directory (no pipe a descendant can hold open);
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
 * verdict resolution (`resolveVerdict` in cap-envelope.ts) is shared. Two
 * deliberate differences from `spawnSync`: output larger than `maxBuffer` is
 * truncated to its TAIL (noted in the diagnostics) instead of failing ENOBUFS,
 * and a timeout kills the gate's whole process group, not just `cap run`.
 */

import { type SpawnSyncReturns, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureInFlightDir,
  IN_FLIGHT_RUN_DIR_PREFIX,
  IN_FLIGHT_RUN_FILES,
  type InFlightCapRun,
  inFlightAlive,
  inFlightFinished,
  pidExists,
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
/** Poll cadence inside that grace. */
const KILL_GRACE_POLL_MS = 100;
/** A finished-but-unconsumed run older than this is not adopted. */
export const ADOPT_FINISHED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Budget for the `git rev-parse HEAD` identity probe. */
const GIT_HEAD_TIMEOUT_MS = 10_000;

/** `sh` exit code for "command not found". */
const SH_NOT_FOUND = 127;
/** `sh` reports a signal-killed child as 128 + the signal number. */
const SH_SIGNAL_EXIT_BASE = 128;

/**
 * Waits for the launcher's go-file (`$3`), then runs `cap run <id>` and records
 * its exit status atomically. `$1` = the capability id, `$2` = the run
 * directory's `IN_FLIGHT_RUN_FILES.status` path, `$3` = its go-file. The
 * launcher creates the go-file only AFTER the in-flight record is on disk, so
 * a gate never runs unrecorded; a launcher that dies in between leaves a
 * wrapper that gives up after ~10 s without running anything (exit 125, no
 * status — the record then reads as dead and is discarded). All three are
 * positional arguments — never interpolated into the script.
 */
const WRAPPER_SCRIPT =
  'i=0; while [ ! -e "$3" ]; do i=$((i+1)); [ "$i" -gt 200 ] && exit 125; sleep 0.05; done; ' +
  'ai-dossier cap run "$1"; s=$?; echo "$s" > "$2.tmp" && mv "$2.tmp" "$2"';

/** Go-file inside a run directory (see {@link WRAPPER_SCRIPT}). */
const GO_FILE = 'go';

export interface TrackedCapRun {
  spawned: SpawnSyncReturns<string>;
  /** The run directory's envelope file (read by the caller's verdict resolution). */
  envelopeFile: string;
  /** Adoption / launch notes for the caller's diagnostics. */
  notes: string[];
  /** Remove the in-flight record and run directory — call once the envelope has been read. */
  release: () => void;
}

interface TrackedOpts {
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  inFlightDir: string;
  maxBuffer: number;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function gitHead(cwd: string): string | null {
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      timeout: GIT_HEAD_TIMEOUT_MS,
    });
    const sha = typeof r.stdout === 'string' ? r.stdout.trim() : '';
    return r.status === 0 && /^[0-9a-f]{7,64}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Last `maxBytes` of a file ('' when absent), and whether it was cut. */
function readTail(file: string, maxBytes: number): { text: string; truncated: boolean } {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { text: '', truncated: false };
  }
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, size - length);
    return { text: buf.subarray(0, read).toString('utf-8'), truncated: size > maxBytes };
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

/** Another live process (not this one) — the launcher of a run we adopted, say. */
function otherProcessAlive(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1 && pid !== process.pid && pidExists(pid);
}

function errno(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Wait for a recorded run to finish (its wrapper wrote a status) or die. At
 * `deadlineMs` the whole process group is killed — but only while
 * `inFlightAlive` still confirms it is OUR gate (identity-checked: a recycled
 * pid never gets a group signal). Returns whether it timed out.
 */
function waitForRun(record: InFlightCapRun, deadlineMs: number): { timedOut: boolean } {
  const statusFile = path.join(record.run_dir, IN_FLIGHT_RUN_FILES.status);
  for (;;) {
    if (fs.existsSync(statusFile)) return { timedOut: false };
    if (!inFlightAlive(record)) return { timedOut: false };
    if (Date.now() >= deadlineMs) break;
    sleepSync(Math.min(TRACKED_POLL_MS, Math.max(1, deadlineMs - Date.now())));
  }
  if (inFlightAlive(record)) signalGroup(record.pid, 'SIGTERM');
  const graceEnd = Date.now() + TRACKED_KILL_GRACE_MS;
  while (Date.now() < graceEnd && inFlightAlive(record) && !fs.existsSync(statusFile)) {
    sleepSync(KILL_GRACE_POLL_MS);
  }
  if (inFlightAlive(record)) signalGroup(record.pid, 'SIGKILL');
  return { timedOut: true };
}

/** Build the `spawnSync`-shaped result from a run directory. */
function collect(
  record: InFlightCapRun,
  timedOut: boolean,
  maxBuffer: number,
  notes: string[]
): SpawnSyncReturns<string> {
  const dir = record.run_dir;
  const out = readTail(path.join(dir, IN_FLIGHT_RUN_FILES.stdout), maxBuffer);
  const err = readTail(path.join(dir, IN_FLIGHT_RUN_FILES.stderr), maxBuffer);
  if (out.truncated || err.truncated) {
    notes.push(`output truncated to its last ${maxBuffer} bytes`);
  }
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
  if (code !== null && code > SH_SIGNAL_EXIT_BASE) {
    // `$?` of a signal-killed `cap run` — report it the way spawnSync would.
    const name = Object.entries(os.constants.signals).find(
      ([, n]) => n === code - SH_SIGNAL_EXIT_BASE
    )?.[0];
    if (name !== undefined) {
      status = null;
      signal = name as NodeJS.Signals;
    }
  }
  if (timedOut) {
    // Our own deadline fired: ETIMEDOUT exactly like spawnSync, whatever the
    // wrapper managed to record during the kill grace.
    error = errno(
      `cap run ${record.capability} ETIMEDOUT after ${record.timeout_ms}ms`,
      'ETIMEDOUT'
    );
    status = null;
    signal = signal ?? 'SIGTERM';
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
    output: [null, out.text, err.text],
    stdout: out.text,
    stderr: err.text,
    status,
    signal,
    ...(error !== undefined ? { error } : {}),
  };
}

function trackedResult(
  record: InFlightCapRun,
  timedOut: boolean,
  opts: TrackedOpts,
  notes: string[],
  release: () => void
): TrackedCapRun {
  const spawned = collect(record, timedOut, opts.maxBuffer, notes);
  return {
    spawned,
    envelopeFile: path.join(record.run_dir, IN_FLIGHT_RUN_FILES.envelope),
    notes,
    release,
  };
}

/**
 * Remove a record this process did NOT launch — unless its launcher is still
 * alive (a live engine while an operator's `sched resume --batch` waited
 * alongside it): that launcher consumes and cleans up its own run.
 */
function releaseAdopted(dir: string, record: InFlightCapRun): void {
  if (!otherProcessAlive(record.launcher_pid)) removeInFlight(dir, record);
}

/**
 * The adoption half of {@link runTrackedCapRun}: a result when a recorded run
 * for this worktree + capability supplied the verdict, else null (launch fresh).
 */
function adoptExisting(
  existing: InFlightCapRun,
  capabilityId: string,
  worktree: string,
  head: string | null,
  opts: TrackedOpts,
  notes: string[]
): TrackedCapRun | null {
  const dir = opts.inFlightDir;
  const finished = inFlightFinished(existing);
  const alive = !finished && inFlightAlive(existing);
  if (alive) {
    // Never launch a duplicate next to a live gate (#1233) — wait for it, and
    // say so in the record (the in-tick heartbeat keys on it).
    notes.push(
      `adopted in-flight ${capabilityId} pid ${existing.pid} started ${existing.started_at} by pid ${existing.launcher_pid}`
    );
    process.stderr.write(
      `▶ sched: adopting in-flight ${capabilityId} (pid ${existing.pid}, started ${existing.started_at}) in ${worktree} instead of launching a duplicate\n`
    );
    try {
      writeInFlight(dir, { ...existing, waiter_pid: process.pid });
    } catch {
      // advisory: only the in-tick heartbeat reads waiter_pid
    }
    const { timedOut } = waitForRun(
      existing,
      Date.parse(existing.started_at) + existing.timeout_ms
    );
    if (head !== null && existing.head === head) {
      return trackedResult(existing, timedOut, opts, notes, () => releaseAdopted(dir, existing));
    }
    notes.push(
      `adopted run was against HEAD ${existing.head ?? 'unknown'}, now ${head ?? 'unknown'} — re-running`
    );
    releaseAdopted(dir, existing);
    return null;
  }
  if (
    finished &&
    head !== null &&
    existing.head === head &&
    Date.now() - Date.parse(existing.started_at) < ADOPT_FINISHED_MAX_AGE_MS
  ) {
    notes.push(
      `adopted finished ${capabilityId} pid ${existing.pid} (started ${existing.started_at}) for the same HEAD`
    );
    return trackedResult(existing, false, opts, notes, () => releaseAdopted(dir, existing));
  }
  notes.push(
    `discarded ${finished ? 'stale finished' : 'dead'} in-flight record (pid ${existing.pid}, started ${existing.started_at})`
  );
  releaseAdopted(dir, existing);
  return null;
}

/**
 * Run (or adopt) `ai-dossier cap run <capabilityId>` in `cwd`, tracked under
 * `inFlightDir`. Synchronous; returns once the gate has a verdict, died, or
 * timed out (process group killed).
 */
export function runTrackedCapRun(
  capabilityId: string,
  cwd: string,
  opts: TrackedOpts
): TrackedCapRun {
  const notes: string[] = [];
  const worktree = path.resolve(cwd);
  const head = gitHead(worktree);
  const dir = opts.inFlightDir;

  const existing = readInFlight(dir, worktree, capabilityId);
  if (existing !== null) {
    const adopted = adoptExisting(existing, capabilityId, worktree, head, opts, notes);
    if (adopted !== null) return adopted;
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
  return trackedResult(record, timedOut, opts, notes, () => removeInFlight(dir, record));
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
  ensureInFlightDir(dir);
  const runDir = fs.mkdtempSync(path.join(dir, IN_FLIGHT_RUN_DIR_PREFIX));
  const files = {
    status: path.join(runDir, IN_FLIGHT_RUN_FILES.status),
    stdout: path.join(runDir, IN_FLIGHT_RUN_FILES.stdout),
    stderr: path.join(runDir, IN_FLIGHT_RUN_FILES.stderr),
    envelope: path.join(runDir, IN_FLIGHT_RUN_FILES.envelope),
  };
  const outFd = fs.openSync(files.stdout, 'w', 0o600);
  const errFd = fs.openSync(files.stderr, 'w', 0o600);
  let pid: number | undefined;
  let spawnError: Error | undefined;
  try {
    const child = spawn(
      '/bin/sh',
      ['-c', WRAPPER_SCRIPT, 'sh', capabilityId, files.status, path.join(runDir, GO_FILE)],
      {
        cwd: worktree,
        env: { ...(opts.env ?? process.env), [CAP_ENVELOPE_FILE_ENV]: files.envelope },
        stdio: ['ignore', outFd, errFd],
        // #1233 (5): its own process group — isolated from signals aimed at the
        // engine's group, and killable as a whole on timeout.
        detached: true,
      }
    );
    // An async spawn failure is reported as an 'error' event; unhandled, it
    // would crash the engine (or its tick worker).
    child.on('error', (err) => {
      spawnError = err;
    });
    child.unref();
    pid = child.pid;
  } catch (err) {
    spawnError = err as Error;
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  if (pid === undefined) {
    fs.rmSync(runDir, { recursive: true, force: true });
    return { error: spawnError ?? errno('spawn /bin/sh failed: no pid', 'ENOENT') };
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
  let note: string | undefined;
  try {
    writeInFlight(dir, record);
  } catch (err) {
    // The gate runs untracked: a restart mid-gate could duplicate it. Loud.
    note = `in-flight record not written (${(err as Error).message}) — this gate is untracked`;
    process.stderr.write(`⚠ sched: ${capabilityId} pid ${pid}: ${note}\n`);
  }
  // Record on disk (or loudly not) — let the wrapper start `cap run`.
  fs.writeFileSync(path.join(runDir, GO_FILE), '', { mode: 0o600 });
  return note !== undefined ? { record, note } : { record };
}
