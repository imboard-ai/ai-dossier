/**
 * Worker-thread entry for the `sched start` loop (#1233).
 *
 * A tick is synchronous end to end — the batch gate it may run is a 25–55 min
 * wait. Run on the engine's main thread, that wait froze the event loop: no
 * lease heartbeat, no SIGTERM/SIGINT handler, so a host reaper's SIGTERM →
 * SIGKILL landed as an unobservable SIGKILL. The loop now posts each tick here;
 * the main thread stays free to heartbeat, handle signals and journal its exit.
 *
 * Protocol: the parent posts `{ id, config }`; this worker runs `tick` against
 * engine deps built exactly as the inline path builds them (`buildEngineDeps`)
 * and posts back `{ id, ok: true, result }` or `{ id, ok: false, error }`.
 */

import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { Journal, type SchedConfig, SchedStore, type TickResult, tick } from '@ai-dossier/sched';
import { buildEngineDeps } from './commands/sched';

export interface TickWorkerData {
  stateDir: string;
  repoDir: string;
  anchorRepo?: string;
}

/** Bounded retry for a full non-blocking stdout/stderr. */
const WRITE_RETRY_BUDGET_MS = 1_000;

/** An Error flattened for `postMessage` (structured clone keeps no prototype). */
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

export function serializeError(err: unknown): SerializedError {
  const e = err instanceof Error ? err : new Error(String(err));
  return { name: e.name, message: e.message, ...(e.stack ? { stack: e.stack } : {}) };
}

export interface TickRequest {
  id: number;
  config: SchedConfig;
}

export type TickResponse =
  | { id: number; ok: true; result: TickResult; unreapedChildren?: boolean }
  | { id: number; ok: false; error: SerializedError };

/**
 * A worker's stdout/stderr are forwarded to the parent over a message port, which
 * only drains when this thread's event loop turns — never during a synchronous
 * gate wait. Write straight to the process's fds instead so engine diagnostics
 * (and the "adopting in-flight gate" notice) appear when they happen.
 */
function writeThrough(fd: number): typeof process.stdout.write {
  return ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    let offset = 0;
    const giveUpAt = Date.now() + WRITE_RETRY_BUDGET_MS;
    while (offset < data.length) {
      try {
        offset += fs.writeSync(fd, data, offset);
      } catch (err) {
        // A non-blocking pipe/journald socket can be momentarily full: retry
        // briefly. Anything else (EBADF, EPIPE) drops the line — a closed fd
        // must never fail a tick.
        if ((err as NodeJS.ErrnoException).code !== 'EAGAIN' || Date.now() > giveUpAt) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    const cb = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
    cb?.();
    return true;
  }) as typeof process.stdout.write;
}

if (parentPort !== null) {
  process.stdout.write = writeThrough(1);
  process.stderr.write = writeThrough(2);
  const port = parentPort;
  const data = workerData as TickWorkerData;
  const store = new SchedStore(data.stateDir);
  let tickConfig: SchedConfig | undefined;
  const deps = buildEngineDeps({
    store,
    journal: new Journal(store.dir),
    anchorRepo: data.anchorRepo,
    repoDir: data.repoDir,
    getTickConfig: () => {
      if (tickConfig === undefined) throw new Error('tick worker: no tick config yet');
      return tickConfig;
    },
  });
  port.on('message', (msg: TickRequest) => {
    tickConfig = msg.config;
    let response: TickResponse;
    try {
      const result = tick(deps, msg.config);
      response = {
        id: msg.id,
        ok: true,
        result,
        unreapedChildren: deps.spawnDeps.hasUnreapedChildren?.() ?? false,
      };
    } catch (err) {
      response = { id: msg.id, ok: false, error: serializeError(err) };
    }
    port.postMessage(response);
  });
}
