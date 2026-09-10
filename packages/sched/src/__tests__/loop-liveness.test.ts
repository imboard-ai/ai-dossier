import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type EngineDeps, Journal, runLoop, SchedStore } from '../index';

/**
 * #679 regression: the long-running engine must survive its own inter-tick
 * sleep. `sleep()` unref'd both the sleep timer and the stop-check interval,
 * and spawned agents are detached+unref'd by design — so after the first
 * tick's async work settled, nothing kept the event loop alive and
 * `sched start` exited cleanly after one tick, silently behaving like
 * `--once`. These tests pin the fix: ref'd sleep handles keep the process
 * alive across tick intervals; SIGINT still stops the loop promptly.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/loop-liveness-fixture.mjs', import.meta.url));
// The child-process fixture imports the BUILT package — a child process
// cannot import TypeScript. CI runs `make build-all` before tests, so dist
// always exists there; on a cold local tree without a build, skip loudly.
const DIST_INDEX = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeLoopDeps(): EngineDeps {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-loop-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-loop-home-'));
  dirs.push(dir, homeDir);
  return {
    store: new SchedStore(dir),
    journal: new Journal(dir),
    groundTruth: {
      latestMilestone: () => null,
      issueClosed: () => false,
      branchHead: () => null,
      prState: () => undefined,
      openPrForBranch: () => null,
      setupInfo: () => null,
      issueLabels: () => [],
    },
    spawnDeps: {
      spawn: () => {
        throw new Error('loop-liveness test queue is empty — spawn must never be reached');
      },
      kill: () => false,
      isAlive: () => false,
      processStart: () => null,
    },
    now: () => new Date(),
    repoDir: dir,
    teardownExec: () => null,
    homeDir,
  };
}

describe('runLoop liveness (#679)', () => {
  it('keeps ticking on its configured interval until shouldStop flips — one onTick per tick', async () => {
    const deps = makeLoopDeps();
    let tickCount = 0;
    // shouldStop flips once three ticks have run; the loop must reach it via
    // its own interval (not exit early, not hang).
    await runLoop(
      deps,
      { reconcile_interval_ms: 30 },
      () => tickCount >= 3,
      () => {
        tickCount += 1;
      }
    );
    expect(tickCount).toBe(3);
  });

  describe.skipIf(!fs.existsSync(DIST_INDEX))('child process (built dist)', () => {
    it('is still alive after two tick intervals, then exits cleanly on SIGINT', async () => {
      const INTERVAL_MS = 150;
      const child = spawn(process.execPath, [FIXTURE, String(INTERVAL_MS)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString();
      });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        child.on('exit', (code, signal) => resolve({ code, signal }));
      });

      await vi.waitUntil(() => out.includes('ready'), { timeout: 5_000 });

      // The #679 bug: the process was already gone by now — it exited on its
      // own right after the first tick. Alive-with-no-exit-event past two
      // full intervals is the regression assertion.
      await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS * 2 + INTERVAL_MS / 2));
      expect(child.exitCode, `still running: stdout=${out} stderr=${stderr}`).toBeNull();
      expect(child.signalCode).toBeNull();
      const ticksSeen = (out.match(/^tick /gm) ?? []).length;
      expect(ticksSeen).toBeGreaterThanOrEqual(2);

      child.kill('SIGINT');
      const result = await Promise.race([
        exited,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10_000)),
      ]);
      expect(result, 'SIGINT must stop the engine promptly').not.toBe('timeout');
      if (result !== 'timeout') {
        expect(result.code).toBe(0);
        expect(result.signal).toBeNull();
      }
      expect(out).toMatch(/^stopped after \d+ ticks$/m);
    }, 20_000);
  });
});
