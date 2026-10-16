import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { createSpawnDeps, procStatFields } from '../dispatch';

describe('#1244 agent lifecycle', () => {
  it.skipIf(process.platform !== 'linux')(
    'reports a real zombie dead, then lets libuv reap the owned child',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-zombie-'));
      const deps = createSpawnDeps();
      const pid = deps.spawn(
        [process.execPath, '-e', 'process.exit(0)'],
        '',
        path.join(dir, 'log')
      );
      try {
        const deadline = Date.now() + 5_000;
        // Deliberately hold this thread's event loop so the exited child stays
        // waitable. A signal-0 check still succeeds for this real Z process.
        while (procStatFields(pid)?.[0] !== 'Z' && Date.now() < deadline) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        expect(procStatFields(pid)?.[0]).toBe('Z');
        expect(() => process.kill(pid, 0)).not.toThrow();
        expect(deps.isAlive(pid)).toBe(false);
        expect(deps.hasUnreapedChildren?.()).toBe(true);
        for (let n = 0; n < 100 && procStatFields(pid) !== null; n++) await delay(10);
        expect(procStatFields(pid)).toBeNull();
        expect(deps.hasUnreapedChildren?.()).toBe(false);
      } finally {
        deps.kill(pid);
        await delay(20);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  it('retains live-process, PID identity, and no-proc fallback behavior', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-live-'));
    const deps = createSpawnDeps();
    const pid = deps.spawn(
      [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      '',
      path.join(dir, 'log')
    );
    try {
      expect(deps.isAlive(pid)).toBe(true);
      const start = deps.processStart(pid);
      if (start !== null) expect(deps.isAlive(pid, start + 1)).toBe(false);
      const read = fs.readFileSync;
      const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
        if (String(args[0]).startsWith('/proc/')) throw new Error('no proc');
        return read(...args);
      });
      try {
        expect(deps.isAlive(pid, start ?? undefined)).toBe(true);
      } finally {
        spy.mockRestore();
      }
    } finally {
      deps.kill(pid, undefined, 'SIGKILL');
      await delay(20);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
