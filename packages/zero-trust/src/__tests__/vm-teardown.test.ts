import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Journal } from '../journal';
import {
  createRun,
  IllegalTransitionError,
  permittedTransitions,
  ReasonCode,
  type RunRecord,
  TERMINAL_STATES,
  transitionRun,
} from '../state';
import { VmCleanupError } from '../vm/adapter';
import {
  assertPublicationPermitted,
  MAX_CLEANUP_ATTEMPTS,
  PublicationDeniedError,
  teardownVm,
} from '../vm/teardown';

const T0 = Date.parse('2026-10-06T00:00:00.000Z');
const HANDLE = { vmId: 'vm-1', runId: 'run-1' };

function at(minutes: number): string {
  return new Date(T0 + minutes * 60_000).toISOString();
}

/** gating → planning → implementing → verifying → shipping, with real transitions. */
function runIn(
  target: 'gating' | 'planning' | 'implementing' | 'verifying' | 'shipping'
): RunRecord {
  const steps: [ReasonCode, string][] = [
    [ReasonCode.GatePassed, 'planning'],
    [ReasonCode.PlanApproved, 'implementing'],
    [ReasonCode.CandidateReady, 'verifying'],
    [ReasonCode.VerificationPassed, 'shipping'],
  ];
  let run = createRun({ runId: 'run-1', upstreamIssue: 'o/r#1', contributor: 'alice' }, at(0));
  let minute = 1;
  for (const [code, state] of steps) {
    if (run.state === target) break;
    run = transitionRun(run, code, at(minute++));
    expect(run.state).toBe(state);
  }
  expect(run.state).toBe(target);
  return run;
}

let dir: string;
let journal: Journal;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-teardown-'));
  journal = new Journal(path.join(dir, 'journal'));
});
afterEach(() => {
  journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

const now = () => new Date(at(30));

describe('teardownVm — bounded cleanup (AC3 / scenario 20)', () => {
  it('three failed deletions block the run and deny publication', async () => {
    const run = runIn('shipping');
    assertPublicationPermitted(run);
    const destroy = vi.fn(async () => {
      throw new VmCleanupError([4242], ['/var/lib/zt/run-1/overlay.qcow2']);
    });
    const sleeps: number[] = [];
    const outcome = await teardownVm({ destroy }, HANDLE, run, {
      journal,
      now,
      retryDelayMs: 5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(destroy).toHaveBeenCalledTimes(MAX_CLEANUP_ATTEMPTS);
    expect(destroy).toHaveBeenCalledWith(HANDLE);
    expect(sleeps).toEqual([5, 5]);
    expect(outcome.kind).toBe('blocked_cleanup');
    expect(outcome.attempts).toBe(3);
    expect(outcome.run.state).toBe('blocked_cleanup');
    expect(outcome.run.reasonCode).toBe(ReasonCode.CleanupFailed);
    if (outcome.kind !== 'blocked_cleanup') throw new Error('unreachable');
    expect(outcome.leftoverPids).toEqual([4242]);
    expect(outcome.leftoverPaths).toEqual(['/var/lib/zt/run-1/overlay.qcow2']);

    const events = journal.read() as { type: string; attempt?: number; state?: string }[];
    expect(events.filter((e) => e.type === 'vm_cleanup_attempt_failed')).toHaveLength(3);
    expect(
      events.filter((e) => e.type === 'vm_cleanup_attempt_failed').map((e) => e.attempt)
    ).toEqual([1, 2, 3]);
    const blocked = events.filter((e) => e.type === 'vm_cleanup_blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      v: 1,
      runId: 'run-1',
      vmId: 'vm-1',
      state: 'blocked_cleanup',
      leftoverPids: [4242],
      leftoverPaths: ['/var/lib/zt/run-1/overlay.qcow2'],
    });
    expect(events.at(-1)?.type).toBe('vm_cleanup_blocked');

    expect(() => assertPublicationPermitted(outcome.run)).toThrow(PublicationDeniedError);
    try {
      assertPublicationPermitted(outcome.run);
    } catch (error) {
      expect((error as PublicationDeniedError).state).toBe('blocked_cleanup');
      expect((error as Error).message).toContain('blocked_cleanup');
      expect((error as Error).name).toBe('PublicationDeniedError');
    }
  });

  it.each([
    'gating',
    'implementing',
    'verifying',
  ] as const)('blocks a run from %s as well', async (state) => {
    const outcome = await teardownVm(
      {
        destroy: async () => {
          throw new VmCleanupError([], ['/tmp/x']);
        },
      },
      HANDLE,
      runIn(state),
      { now, retryDelayMs: 0, sleep: async () => {} }
    );
    expect(outcome.run.state).toBe('blocked_cleanup');
  });

  it('success on the second attempt reports destroyed with attempts 2', async () => {
    const run = runIn('shipping');
    let calls = 0;
    const outcome = await teardownVm(
      {
        destroy: async () => {
          calls++;
          if (calls === 1) throw new VmCleanupError([1], []);
        },
      },
      HANDLE,
      run,
      { journal, now, sleep: async () => {} }
    );
    expect(outcome).toEqual({ kind: 'destroyed', attempts: 2, run });
    expect(outcome.run.state).toBe('shipping');
    const events = journal.read() as { type: string }[];
    expect(events.map((e) => e.type)).toEqual(['vm_cleanup_attempt_failed']);
  });

  it('first-attempt success needs no journal and no sleep', async () => {
    const run = runIn('verifying');
    const sleep = vi.fn(async () => {});
    const outcome = await teardownVm({ destroy: async () => {} }, HANDLE, run, { now, sleep });
    expect(outcome).toEqual({ kind: 'destroyed', attempts: 1, run });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('normalizes a non-VmCleanupError to unknown:<vmId>', async () => {
    const outcome = await teardownVm(
      {
        destroy: async () => {
          throw new Error('EBUSY');
        },
      },
      HANDLE,
      runIn('shipping'),
      { journal, now, retryDelayMs: 0, sleep: async () => {} }
    );
    if (outcome.kind !== 'blocked_cleanup') throw new Error('expected blocked');
    expect(outcome.leftoverPids).toEqual([]);
    expect(outcome.leftoverPaths).toEqual(['unknown:vm-1']);
    const events = journal.read() as { leftoverPaths: string[] }[];
    expect(events.every((e) => e.leftoverPaths[0] === 'unknown:vm-1')).toBe(true);
  });

  it('uses the default timer-based sleep when none is injected', async () => {
    let calls = 0;
    const outcome = await teardownVm(
      {
        destroy: async () => {
          calls++;
          throw new VmCleanupError([], []);
        },
      },
      HANDLE,
      runIn('shipping'),
      { now, retryDelayMs: 0 }
    );
    expect(calls).toBe(3);
    expect(outcome.kind).toBe('blocked_cleanup');
  });

  it('default retry delay is 1000ms', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const promise = teardownVm(
      {
        destroy: async () => {
          calls++;
          throw new VmCleanupError([], []);
        },
      },
      HANDLE,
      runIn('shipping'),
      { now }
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(3);
    expect((await promise).kind).toBe('blocked_cleanup');
  });

  it('refuses to block a run whose state has no cleanup_failed edge', async () => {
    const terminal = transitionRun(runIn('gating'), ReasonCode.PolicyBlocked, at(5));
    await expect(
      teardownVm(
        {
          destroy: async () => {
            throw new VmCleanupError([], []);
          },
        },
        HANDLE,
        terminal,
        { now, retryDelayMs: 0, sleep: async () => {} }
      )
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });
});

describe('assertPublicationPermitted', () => {
  it('passes only for shipping', () => {
    expect(() => assertPublicationPermitted(runIn('shipping'))).not.toThrow();
    for (const state of ['gating', 'planning', 'implementing', 'verifying'] as const)
      expect(() => assertPublicationPermitted(runIn(state))).toThrow(PublicationDeniedError);
    const paused = transitionRun(runIn('shipping'), ReasonCode.UserPaused, at(10));
    expect(() => assertPublicationPermitted(paused)).toThrow(PublicationDeniedError);
  });
});

describe('blocked_cleanup has no path back to shipping', () => {
  async function blockedRun(): Promise<RunRecord> {
    const outcome = await teardownVm(
      {
        destroy: async () => {
          throw new VmCleanupError([], []);
        },
      },
      HANDLE,
      runIn('shipping'),
      { now, retryDelayMs: 0, sleep: async () => {} }
    );
    return outcome.run;
  }

  it('every reason code except cleanup_completed is illegal', async () => {
    const blocked = await blockedRun();
    expect(Object.values(permittedTransitions('blocked_cleanup'))).not.toContain('shipping');
    for (const code of Object.values(ReasonCode)) {
      if (code === ReasonCode.CleanupCompleted) continue;
      expect(() => transitionRun(blocked, code, at(40))).toThrow(IllegalTransitionError);
    }
  });

  it('cleanup completion closes the run in a terminal state with no shipping edge', async () => {
    const closed = transitionRun(await blockedRun(), ReasonCode.CleanupCompleted, at(40));
    expect(closed.state).toBe('blocked');
    expect(TERMINAL_STATES).toContain('blocked');
    for (const code of Object.values(ReasonCode))
      expect(() => transitionRun(closed, code, at(50))).toThrow(IllegalTransitionError);
    expect(() => assertPublicationPermitted(closed)).toThrow(PublicationDeniedError);
  });
});
