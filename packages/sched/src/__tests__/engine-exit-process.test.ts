import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Journal, SchedStore } from '../index';

/**
 * #945 / #920 with a REAL process: the engine's log used to end in an idle
 * tick's "nothing to do" because SIGTERM/SIGHUP had no handler. These tests
 * signal a child that wires the built package the way `sched start` does.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/engine-exit-fixture.mjs', import.meta.url));
const DIST_INDEX = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

async function startChild(mode?: 'crash') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-exit-proc-'));
  dirs.push(dir);
  const child = spawn(process.execPath, [FIXTURE, dir, ...(mode ? [mode] : [])], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.on('data', (c: Buffer) => {
    out += c.toString();
  });
  child.stderr?.on('data', (c: Buffer) => {
    out += c.toString();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal }))
  );
  await vi
    .waitUntil(() => /tick 2/.test(out), { timeout: 10_000, interval: 10 })
    .catch(() => {
      throw new Error(`child never reached tick 2: ${out}`);
    });
  const store = new SchedStore(dir, path.join(dir, 'user-config.json'));
  return { dir, child, exited, store, journal: new Journal(dir) };
}

describe.skipIf(!fs.existsSync(DIST_INDEX))('engine exit paths (real process, #945)', () => {
  it('heartbeat: a live engine keeps advancing lease updated_at', async () => {
    const { child, exited, store } = await startChild();
    const first = store.engineLeaseStatus()?.updated_at;
    await vi.waitUntil(() => store.engineLeaseStatus()?.updated_at !== first, { timeout: 5_000 });
    expect(store.engineLeaseStatus()?.alive).toBe(true);
    child.kill('SIGTERM');
    await exited;
  }, 20_000);

  it.each([
    'SIGTERM',
    'SIGHUP',
  ] as const)('%s: journals engine-exit, stops gracefully (exit 0) and releases the lease', async (sig) => {
    const { child, exited, store, journal } = await startChild();
    child.kill(sig);
    const result = await exited;
    expect(result).toEqual({ code: 0, signal: null });
    const exits = journal.read().filter((e) => e.event === 'engine-exit');
    expect(exits.map((e) => e.reason)).toEqual([`signal:${sig}`]);
    expect(store.engineLeaseStatus()).toBeNull();
  }, 20_000);

  it('uncaught exception: journals the stack, exits 70, keeps the lease as the crash marker', async () => {
    const { exited, store, journal } = await startChild('crash');
    const result = await exited;
    expect(result.code).toBe(70);
    const exits = journal.read().filter((e) => e.event === 'engine-exit');
    expect(exits).toHaveLength(1);
    expect(exits[0].reason).toBe('uncaught-exception');
    expect(exits[0].detail).toContain('fixture crash');
    expect(store.engineLeaseStatus()?.alive).toBe(false);
    const next = store.acquireEngineLease();
    expect(next.acquired && next.reclaimed?.updated_at).toBeTruthy();
  }, 20_000);

  it('SIGKILL: no engine-exit line is possible, but the stale lease proves the crash on next start', async () => {
    const { child, exited, store, journal } = await startChild();
    child.kill('SIGKILL');
    await exited;
    expect(journal.read().filter((e) => e.event === 'engine-exit')).toHaveLength(0);
    expect(store.engineLeaseStatus()?.alive).toBe(false);
    const next = store.acquireEngineLease();
    expect(next.acquired).toBe(true);
    expect(next.acquired && next.reclaimed).toBeTruthy();
  }, 20_000);
});
