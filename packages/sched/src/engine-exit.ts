/**
 * Engine termination logging (#945, #940 ask 3): the engine must never die
 * silently. Every exit the process can observe writes one final `engine-exit`
 * journal line with the reason (and stack for a crash):
 *
 *   signal:<SIG>          SIGTERM / SIGHUP / SIGINT — graceful stop is requested
 *                         (the loop finishes its tick, agents keep running); a
 *                         second signal exits immediately
 *   uncaught-exception    journaled with stack, exit 70, lease deliberately NOT
 *   unhandled-rejection   released so the next start / watcher sees a crash
 *   normal                the loop returned after a stop request
 *   process-exit          a bare `process.exit()` nobody else logged
 *
 * #920: the engine's log ended in "nothing to do" (an idle tick's line) with no
 * error. Only SIGINT had a handler, so a SIGTERM/SIGHUP (another session's
 * restart, a closing terminal) killed it with no log line and no lease release.
 * SIGKILL/OOM remain unobservable by design — the stale heartbeat lease is what
 * catches those (`engine-restarted-after-crash`, `stale-engine-lease-alert`).
 */

import type { Journal } from './journal';

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
const SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT'] as const;
const SIGNAL_NUMBERS: Record<(typeof SIGNALS)[number], number> = {
  SIGHUP: 1,
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
  proc?: ExitProcess;
  now?: () => Date;
}): EngineExitLogger {
  const proc: ExitProcess = opts.proc ?? (process as unknown as ExitProcess);
  const now = opts.now ?? (() => new Date());
  let recorded: string | null = null;
  let crashed = false;
  let signalled = false;

  const record = (reason: string, detail?: string): void => {
    if (recorded !== null) return;
    recorded = reason;
    opts.journal.append(
      { event: 'engine-exit', pid: proc.pid, reason, ...(detail ? { detail } : {}) },
      now()
    );
  };

  const onSignal = (signal: (typeof SIGNALS)[number]) => () => {
    if (signalled) proc.exit(128 + SIGNAL_NUMBERS[signal]);
    signalled = true;
    record(`signal:${signal}`, 'graceful stop requested; spawned agents keep running');
    opts.requestStop();
  };
  const handlers = SIGNALS.map((sig) => [sig, onSignal(sig)] as const);

  const onUncaught = (err: unknown) => {
    crashed = true;
    record('uncaught-exception', describeError(err));
    process.stderr.write(`⚠ sched engine crashed: ${describeError(err)}\n`);
    proc.exit(CRASH_EXIT_CODE);
  };
  const onRejection = (err: unknown) => {
    crashed = true;
    record('unhandled-rejection', describeError(err));
    process.stderr.write(`⚠ sched engine crashed (unhandled rejection): ${describeError(err)}\n`);
    proc.exit(CRASH_EXIT_CODE);
  };
  const onExit = (code: number) => {
    record('process-exit', `exit code ${code}`);
  };

  for (const [sig, h] of handlers) proc.on(sig, h);
  proc.on('uncaughtException', onUncaught);
  proc.on('unhandledRejection', onRejection);
  proc.on('exit', onExit);

  return {
    logNormalExit: (detail) => record('normal', detail),
    shouldReleaseLease: () => !crashed,
    reason: () => recorded,
    dispose: () => {
      for (const [sig, h] of handlers) proc.removeListener(sig, h);
      proc.removeListener('uncaughtException', onUncaught);
      proc.removeListener('unhandledRejection', onRejection);
      proc.removeListener('exit', onExit);
    },
  };
}
