/**
 * Main-thread side of the off-thread tick (#1233): owns the tick worker
 * (`sched-tick-worker.ts`) and turns one tick into a promise, so `runLoop`'s
 * event loop stays free — lease heartbeat, SIGTERM/SIGINT handling and the
 * `engine-exit` journal line all keep working during a long batch gate.
 *
 * A worker that dies mid-tick (an uncaught error, a `process.exit` inside the
 * tick, which in a worker ends only the worker) rejects that tick — `runLoop`
 * journals it as `tick-failed` — and the next tick starts a fresh worker.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { SchedConfig, TickResult } from '@ai-dossier/sched';
import type { TickRequest, TickResponse, TickWorkerData } from './sched-tick-worker';

/** `DOSSIER_SCHED_INLINE_TICK=1` keeps the pre-#1233 inline (main-thread) tick. */
export const INLINE_TICK_ENV = 'DOSSIER_SCHED_INLINE_TICK';

export interface TickRunner {
  runTick(config: SchedConfig): Promise<TickResult>;
  close(): Promise<void>;
}

/**
 * The compiled worker entry next to this module, or null when it cannot run
 * here (running from TypeScript sources under a test runner, a stripped build).
 */
export function tickWorkerFile(dir: string = __dirname): string | null {
  const file = path.join(dir, 'sched-tick-worker.js');
  return fs.existsSync(file) ? file : null;
}

function revive(error: { name: string; message: string; stack?: string }): Error {
  const err = new Error(error.message);
  err.name = error.name;
  if (error.stack) err.stack = error.stack;
  return err;
}

export function createWorkerTickRunner(
  workerFile: string,
  data: TickWorkerData,
  makeWorker: (file: string, data: TickWorkerData) => Worker = (file, d) =>
    new Worker(file, { workerData: d })
): TickRunner {
  let worker: Worker | null = null;
  let nextId = 1;

  const ensure = (): Worker => {
    if (worker === null) worker = makeWorker(workerFile, data);
    return worker;
  };

  return {
    runTick(config) {
      const w = ensure();
      const id = nextId++;
      return new Promise<TickResult>((resolve, reject) => {
        const cleanup = () => {
          w.off('message', onMessage);
          w.off('error', onError);
          w.off('exit', onExit);
        };
        const drop = () => {
          if (worker === w) worker = null;
        };
        const onMessage = (msg: TickResponse) => {
          if (msg.id !== id) return;
          cleanup();
          if (msg.ok) resolve(msg.result);
          else reject(revive(msg.error));
        };
        const onError = (err: Error) => {
          cleanup();
          drop();
          void w.terminate();
          reject(err);
        };
        const onExit = (code: number) => {
          cleanup();
          drop();
          reject(new Error(`sched tick worker exited (code ${code}) before finishing the tick`));
        };
        w.on('message', onMessage);
        w.on('error', onError);
        w.on('exit', onExit);
        const request: TickRequest = { id, config };
        w.postMessage(request);
      });
    },
    async close() {
      const w = worker;
      worker = null;
      if (w !== null) await w.terminate();
    },
  };
}
