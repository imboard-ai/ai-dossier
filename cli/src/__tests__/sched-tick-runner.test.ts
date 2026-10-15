import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SchedConfig } from '@ai-dossier/sched';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ServiceStatus, unsupervisedWarning } from '../sched-service';
import { createWorkerTickRunner, tickWorkerFile } from '../sched-tick-runner';

/**
 * #1233: the main-thread side of the off-thread tick, against a REAL worker
 * thread running a tiny stand-in script that speaks the same protocol as
 * `sched-tick-worker.ts` (the real entry needs the compiled CLI; the e2e run
 * covers it). The stand-in's behaviour is chosen per tick by `config.mode`.
 */
describe('worker tick runner (#1233)', () => {
  let dir: string;
  let file: string;
  const config = (mode: string) => ({ max_slots: 1, mode }) as unknown as SchedConfig;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-tick-runner-'));
    file = path.join(dir, 'stand-in-worker.js');
    fs.writeFileSync(
      file,
      [
        "const { parentPort, threadId } = require('node:worker_threads');",
        'parentPort.on("message", ({ id, config }) => {',
        '  if (config.mode === "exit") process.exit(3);',
        '  if (config.mode === "throw") {',
        '    parentPort.postMessage({ id, ok: false, error: { name: "LockTimeoutError", message: "state locked" } });',
        '    return;',
        '  }',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: source text of the stand-in worker script
        '  parentPort.postMessage({ id, ok: true, result: { spawned: [`thread-${threadId}`] } });',
        '});',
        '',
      ].join('\n')
    );
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('runs ticks on one long-lived worker and resolves with their results', async () => {
    const runner = createWorkerTickRunner(file, { stateDir: dir, repoDir: dir });
    try {
      const a = await runner.runTick(config('ok'));
      const b = await runner.runTick(config('ok'));
      expect(a.spawned).toEqual(b.spawned); // same worker thread both times
      expect(a.spawned[0]).toMatch(/^thread-\d+$/);
    } finally {
      await runner.close();
    }
  });

  it('a tick error comes back as an Error with its name (runLoop journals it)', async () => {
    const runner = createWorkerTickRunner(file, { stateDir: dir, repoDir: dir });
    try {
      await expect(runner.runTick(config('throw'))).rejects.toMatchObject({
        name: 'LockTimeoutError',
        message: 'state locked',
      });
    } finally {
      await runner.close();
    }
  });

  it('a worker that dies mid-tick rejects that tick, and the next tick gets a fresh worker', async () => {
    const runner = createWorkerTickRunner(file, { stateDir: dir, repoDir: dir });
    try {
      const before = await runner.runTick(config('ok'));
      await expect(runner.runTick(config('exit'))).rejects.toThrow(
        /tick worker exited \(code 3\) before finishing the tick/
      );
      const after = await runner.runTick(config('ok'));
      expect(after.spawned).not.toEqual(before.spawned);
    } finally {
      await runner.close();
    }
  });

  it('tickWorkerFile finds only a compiled entry', () => {
    expect(tickWorkerFile(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'sched-tick-worker.js'), '');
    expect(tickWorkerFile(dir)).toBe(path.join(dir, 'sched-tick-worker.js'));
  });
});

describe('unsupervised sched start warning (#1233)', () => {
  const status = (over: Partial<ServiceStatus> = {}): ServiceStatus => ({
    project: 'p',
    systemd: { installed: false, enabled: null, active: null, unitPath: '/u' },
    cron: { installed: false },
    supervised: false,
    ...over,
  });

  it('warns when nothing supervises the engine, naming the reaper risk and the fix', () => {
    const msg = unsupervisedWarning('imboard-ai-imboard-monorepo', () => status(), {});
    expect(msg).toContain('NOT supervised');
    expect(msg).toContain('host process reaper');
    expect(msg).toContain('ai-dossier sched service install');
    expect(msg).toContain('--unsupervised');
  });

  it('is silent when supervised, under systemd, or when the probe fails', () => {
    expect(unsupervisedWarning('p', () => status({ supervised: true }), {})).toBeNull();
    expect(unsupervisedWarning('p', () => status(), { INVOCATION_ID: 'abc' })).toBeNull();
    expect(
      unsupervisedWarning(
        'p',
        () => {
          throw new Error('crontab missing');
        },
        {}
      )
    ).toBeNull();
  });
});
