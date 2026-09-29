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

async function startChild(mode?: 'crash' | 'slow') {
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
  return { dir, child, exited, store, journal: new Journal(dir), output: () => out };
}

describe('engine exit paths (real process, #945)', () => {
  // Fail loudly rather than silently skip: a green run that exercised nothing is worse than red.
  it('the built package exists (run `make build-all` first)', () => {
    expect(fs.existsSync(DIST_INDEX), `missing ${DIST_INDEX} — run \`make build-all\``).toBe(true);
  });

  it('heartbeat: a live engine keeps advancing lease updated_at', async () => {
    const { child, exited, store } = await startChild();
    const first = store.engineLeaseStatus()?.updated_at;
    await vi.waitUntil(() => store.engineLeaseStatus()?.updated_at !== first, { timeout: 5_000 });
    expect(store.engineLeaseStatus()?.alive).toBe(true);
    child.kill('SIGTERM');
    await exited;
  }, 20_000);

  it('SIGTERM: journals engine-exit, stops gracefully (exit 0), releases the lease, marker written', async () => {
    const { dir, child, exited, store, journal } = await startChild();
    child.kill('SIGTERM');
    const result = await exited;
    expect(result).toEqual({ code: 0, signal: null });
    const exits = journal.read().filter((e) => e.event === 'engine-exit');
    expect(exits.map((e) => e.reason)).toEqual(['signal:SIGTERM']);
    expect(store.engineLeaseStatus()).toBeNull();
    expect(fs.readFileSync(path.join(dir, 'stopping-marker'), 'utf8')).toBe('SIGTERM');
  }, 20_000);

  it('SIGHUP does not stop the engine: it keeps ticking and journals the ignored signal', async () => {
    const { child, exited, store, journal, output } = await startChild();
    child.kill('SIGHUP');
    await vi.waitUntil(() => journal.read().some((e) => e.reason === 'signal-ignored:SIGHUP'), {
      timeout: 5_000,
    });
    const ticksBefore = (output().match(/tick \d+/g) ?? []).length;
    await vi.waitUntil(() => (output().match(/tick \d+/g) ?? []).length > ticksBefore, {
      timeout: 5_000,
    });
    expect(store.engineLeaseStatus()?.alive).toBe(true);
    child.kill('SIGTERM');
    expect(await exited).toEqual({ code: 0, signal: null });
  }, 20_000);

  it('a signal that lands mid-tick is handled after the tick, gracefully', async () => {
    const { child, exited, journal, output } = await startChild('slow');
    child.kill('SIGTERM');
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(
      journal
        .read()
        .filter((e) => e.event === 'engine-exit')
        .map((e) => e.reason)
    ).toEqual(['signal:SIGTERM']);
    expect(output()).toContain('stopped');
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
