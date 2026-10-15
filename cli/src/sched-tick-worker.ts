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

export interface TickRequest {
  id: number;
  config: SchedConfig;
}

export type TickResponse =
  | { id: number; ok: true; result: TickResult }
  | { id: number; ok: false; error: { name: string; message: string; stack?: string } };

/**
 * A worker's stdout/stderr are forwarded to the parent over a message port, which
 * only drains when this thread's event loop turns — never during a synchronous
 * gate wait. Write straight to the process's fds instead so engine diagnostics
 * (and the "adopting in-flight gate" notice) appear when they happen.
 */
function writeThrough(fd: number): typeof process.stdout.write {
  return ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    try {
      if (typeof chunk === 'string') fs.writeSync(fd, chunk);
      else fs.writeSync(fd, chunk);
    } catch {
      // a closed fd must never fail a tick
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
      response = { id: msg.id, ok: true, result: tick(deps, msg.config) };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      response = {
        id: msg.id,
        ok: false,
        error: { name: e.name, message: e.message, ...(e.stack ? { stack: e.stack } : {}) },
      };
    }
    port.postMessage(response);
  });
}
