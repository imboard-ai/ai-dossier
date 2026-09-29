/**
 * Engine termination logging (#945, #940 ask 3): the engine must never die
 * silently. Every exit the process can observe writes one final `engine-exit`
 * journal line with the reason (and stack for a crash):
 *
 *   signal:<SIG>          SIGTERM / SIGINT — graceful stop is requested (the loop
 *                         finishes its tick, agents keep running). A `stopping`
 *                         marker is written first, a second signal exits at once,
 *                         and a hard deadline (`stopTimeoutMs`) bounds a wedged
 *                         stop (`stop-timeout`)
 *   signal-ignored:SIGHUP SIGHUP never stops the engine (nohup / a closing terminal
 *                         must not kill an unattended engine); journaled, ignored
 *   stop-timeout          a stop was requested but the process was still alive at
 *                         the deadline; forced exit, lease released (NOT a crash)
 *   uncaught-exception    journaled with stack, exit 70, lease deliberately NOT
 *   unhandled-rejection   released so the next start / watcher sees a crash (also
 *                         journaled when it follows a signal — every cause is kept)
 *   normal                the loop returned after a stop request
 *   process-exit          a bare `process.exit()` nobody else logged
 *
 * #920: the engine's log ended in "nothing to do" (an idle tick's line) with no
 * error. Only SIGINT had a handler, so a SIGTERM/SIGHUP (another session's
 * restart, a closing terminal) killed it with no log line and no lease release.
 * SIGKILL/OOM remain unobservable by design — the stale heartbeat lease is what
 * catches those (`engine-restarted-after-crash`, `stale-engine-lease-alert`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Journal } from './journal';

const STOPPING_MARKER_FILE = 'engine-stopping.json';

/** Written on the FIRST stop signal: a later SIGKILL/timeout is a stop gone wrong, not a crash. */
export interface StoppingMarker {
  pid: number;
  signal: string;
  at: string;
}

export function writeStoppingMarker(dir: string, marker: StoppingMarker): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, STOPPING_MARKER_FILE), `${JSON.stringify(marker)}\n`, {
      mode: 0o600,
    });
  } catch {
    // Advisory: a missing marker only downgrades "stop gone wrong" to "crash".
  }
}

export function readStoppingMarker(dir: string): StoppingMarker | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, STOPPING_MARKER_FILE), 'utf8'));
    if (raw === null || typeof raw !== 'object') return null;
    const m = raw as Partial<StoppingMarker>;
    return typeof m.pid === 'number' && typeof m.signal === 'string' && typeof m.at === 'string'
      ? { pid: m.pid, signal: m.signal, at: m.at }
      : null;
  } catch {
    return null;
  }
}

export function clearStoppingMarker(dir: string): void {
  fs.rmSync(path.join(dir, STOPPING_MARKER_FILE), { force: true });
}

/** Deadline for a requested stop to finish before the engine forces its own exit. */
export const DEFAULT_STOP_TIMEOUT_MS = 120_000;

/** The slice of `process` the installer needs — injectable so tests never signal the test runner. */
export interface ExitProcess {
  pid: number;
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
  exit(code?: number): never;
}

export interface EngineExitLogger {
  /** Journal a graceful, loop-returned exit (`normal`). Idempotent with the rest. */
  logNormalExit(detail?: string): void;
  /** False after a crash: the lease must stay behind as the crash marker. */
  shouldReleaseLease(): boolean;
  /** The recorded reason, or null before any exit path fired. */
  reason(): string | null;
  dispose(): void;
}

const CRASH_EXIT_CODE = 70;
const STOP_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
const SIGNAL_NUMBERS: Record<(typeof STOP_SIGNALS)[number], number> = {
  SIGINT: 2,
  SIGTERM: 15,
};

function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  try {
    return typeof err === 'string' ? err : JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function installEngineExitLogging(opts: {
  journal: Journal;
  /** Ask the loop to stop after the current tick (graceful). */
  requestStop: () => void;
  /** Called once on the first stop signal, before `requestStop` (writes the `stopping` marker). */
  markStopping?: (signal: string) => void;
  /** Hard deadline for a requested stop (default {@link DEFAULT_STOP_TIMEOUT_MS}); 0 disables. */
  stopTimeoutMs?: number;
  proc?: ExitProcess;
  now?: () => Date;
  /** Timer factory — injectable so tests never wait out a real deadline. */
  setTimer?: (fn: () => void, ms: number) => { unref(): unknown };
}): EngineExitLogger {
  const proc: ExitProcess = opts.proc ?? (process as unknown as ExitProcess);
  const now = opts.now ?? (() => new Date());
  let recorded: string | null = null;
  let crashed = false;
  let signalled = false;

  const append = (reason: string, detail?: string): void => {
    try {
      opts.journal.append(
        { event: 'engine-exit', pid: proc.pid, reason, ...(detail ? { detail } : {}) },
        now()
      );
    } catch {
      // The exit path must still exit: an unwritable journal cannot block it.
    }
  };
  const record = (reason: string, detail?: string): void => {
    if (recorded !== null) return;
    recorded = reason;
    append(reason, detail);
  };
  /** A crash is always journaled (with its stack), even after an earlier signal line. */
  const recordCrash = (reason: string, detail: string): void => {
    crashed = true;
    if (recorded === null) recorded = reason;
    append(reason, detail);
  };

  const setTimer =
    opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as { unref(): unknown });
  const stopTimeoutMs = opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

  const onSignal = (signal: (typeof STOP_SIGNALS)[number]) => () => {
    if (signalled) {
      record('signal-repeat', `second ${signal}: exiting immediately`);
      proc.exit(128 + SIGNAL_NUMBERS[signal]);
      return;
    }
    signalled = true;
    try {
      opts.markStopping?.(signal);
    } catch {
      // advisory
    }
    record(`signal:${signal}`, 'graceful stop requested; spawned agents keep running');
    if (stopTimeoutMs > 0) {
      setTimer(() => {
        append(
          'stop-timeout',
          `stop requested by ${signal} ${stopTimeoutMs} ms ago but the engine is still running (wedged tick?); forcing exit`
        );
        proc.exit(128 + SIGNAL_NUMBERS[signal]);
      }, stopTimeoutMs).unref();
    }
    opts.requestStop();
  };
  const handlers = STOP_SIGNALS.map((sig) => [sig, onSignal(sig)] as const);

  // A SIGHUP handler must exist: Node's default (terminate) would kill a nohup'd
  // engine, and installing any handler overrides an inherited SIG_IGN anyway.
  const onHup = () => {
    append('signal-ignored:SIGHUP', 'SIGHUP received; ignored — the engine keeps running');
  };

  const onUncaught = (err: unknown) => {
    recordCrash('uncaught-exception', describeError(err));
    process.stderr.write(`⚠ sched engine crashed: ${describeError(err)}\n`);
    proc.exit(CRASH_EXIT_CODE);
  };
  const onRejection = (err: unknown) => {
    recordCrash('unhandled-rejection', describeError(err));
    process.stderr.write(`⚠ sched engine crashed (unhandled rejection): ${describeError(err)}\n`);
    proc.exit(CRASH_EXIT_CODE);
  };
  const onExit = (code: number) => {
    record('process-exit', `exit code ${code}`);
  };

  for (const [sig, h] of handlers) proc.on(sig, h);
  proc.on('SIGHUP', onHup);
  proc.on('uncaughtException', onUncaught);
  proc.on('unhandledRejection', onRejection);
  proc.on('exit', onExit);

  return {
    logNormalExit: (detail) => record('normal', detail),
    shouldReleaseLease: () => !crashed,
    reason: () => recorded,
    dispose: () => {
      for (const [sig, h] of handlers) proc.removeListener(sig, h);
      proc.removeListener('SIGHUP', onHup);
      proc.removeListener('uncaughtException', onUncaught);
      proc.removeListener('unhandledRejection', onRejection);
      proc.removeListener('exit', onExit);
    },
  };
}
