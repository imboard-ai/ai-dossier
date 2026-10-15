import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type EngineDeps,
  Journal,
  runLoop,
  type SchedConfig,
  SchedStore,
  type TickResult,
} from '../index';

/**
 * #1233: `runLoop` with an off-thread tick (`runTick`) — the loop's own event
 * loop stays free, so it must keep the engine lease's heartbeat going while the
 * tick is pending (a 25–55 min batch gate), and stop once the tick is older than
 * any gate could legitimately be.
 */
describe('runLoop with an off-thread tick (#1233)', () => {
  let dir: string;
  let store: SchedStore;
  let journal: Journal;
  let touch: ReturnType<typeof vi.fn>;
  let deps: EngineDeps;
  const config: SchedConfig = { max_slots: 1, reconcile_interval_ms: 1 };
  const result = {} as TickResult;
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-run-loop-'));
    store = new SchedStore(dir, path.join(dir, 'user-config.json'));
    journal = new Journal(dir);
    touch = vi.fn();
    store.touchEngineLease = touch;
    deps = { store, journal, now: () => new Date() } as unknown as EngineDeps;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('heartbeats the lease while the tick is pending, and stops when it resolves', async () => {
    let stop = false;
    let duringTick = 0;
    await runLoop(
      deps,
      config,
      () => stop,
      () => {
        stop = true;
      },
      {
        heartbeatMs: 10,
        shouldHeartbeat: () => true,
        runTick: async () => {
          await delay(120);
          duringTick = touch.mock.calls.length;
          return result;
        },
      }
    );
    // One heartbeat before the tick, then several WHILE it was pending.
    expect(duringTick).toBeGreaterThan(3);
    const settled = touch.mock.calls.length;
    await delay(50);
    expect(touch.mock.calls.length).toBe(settled); // the in-tick timer was cleared
  });

  it('stops heartbeating a tick older than maxTickHeartbeatMs (a wedged tick goes stale)', async () => {
    let stop = false;
    await runLoop(
      deps,
      config,
      () => stop,
      () => {
        stop = true;
      },
      {
        heartbeatMs: 5,
        maxTickHeartbeatMs: 20,
        shouldHeartbeat: () => true,
        runTick: async () => {
          await delay(150);
          return result;
        },
      }
    );
    // ~1 pre-tick + a few in-tick beats inside the 20 ms cap — not the ~30 an uncapped tick gets.
    expect(touch.mock.calls.length).toBeLessThan(10);
  });

  it('no in-tick heartbeat when the tick is NOT waiting on a live gate (a stuck tick goes stale)', async () => {
    let stop = false;
    await runLoop(
      deps,
      config,
      () => stop,
      () => {
        stop = true;
      },
      {
        heartbeatMs: 5,
        runTick: async () => {
          await delay(80);
          return result;
        },
      }
    );
    // Default predicate: no in-flight gate recorded in the state dir → only the pre-tick beat.
    expect(touch.mock.calls.length).toBe(1);
  });

  it('a rejected tick (worker died) is journaled as tick-failed and the loop goes on', async () => {
    let ticks = 0;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await runLoop(deps, config, () => ticks >= 2, undefined, {
        runTick: async () => {
          ticks += 1;
          const err = new Error('sched tick worker exited (code 1) before finishing the tick');
          err.name = 'LockTimeoutError';
          throw err;
        },
      });
    } finally {
      stderr.mockRestore();
    }
    const failures = journal.read().filter((e) => e.event === 'tick-failed');
    expect(failures).toHaveLength(2);
    expect(failures[0].detail).toBe(
      'LockTimeoutError: sched tick worker exited (code 1) before finishing the tick'
    );
  });
});
