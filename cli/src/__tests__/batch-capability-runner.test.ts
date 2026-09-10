import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBatchCapabilityRunner } from '../commands/sched';

vi.mock('node:child_process');

const spawnResult = (opts: {
  status?: number | null;
  stdout?: string;
  error?: Error & { code?: string };
}): SpawnSyncReturns<string> =>
  ({
    status: opts.status ?? null,
    stdout: opts.stdout ?? '',
    stderr: '',
    signal: null,
    error: opts.error,
    pid: 1,
    output: [],
  }) as SpawnSyncReturns<string>;

describe('createBatchCapabilityRunner (#681)', () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  it('an ETIMEDOUT spawn is distinguishable: automation-broken with the timeout reason shape, not evidence-free', () => {
    // The pre-#681 shape collapsed this into `{outcome: 'automation-broken'}`
    // with no reason — byte-for-byte the #679 evidence-free record.
    const timedOut = new Error('spawnSync ETIMEDOUT') as Error & { code?: string };
    timedOut.code = 'ETIMEDOUT';
    vi.mocked(spawnSync).mockReturnValue(
      spawnResult({ error: timedOut, stdout: 'mid-suite output, selection line etc.' })
    );

    const result = createBatchCapabilityRunner({ timeoutMs: 50 })('/wt', 'test.focused');

    expect(result).toMatchObject({
      outcome: 'automation-broken',
      reason: 'command timed out after 50ms',
      outputTail: 'mid-suite output, selection line etc.',
    });
  });

  it('a NON-timeout spawn error stays the evidence-free automation-broken (a genuine machinery failure, still blocks)', () => {
    const enoent = new Error('spawnSync ai-dossier ENOENT') as Error & { code?: string };
    enoent.code = 'ENOENT';
    vi.mocked(spawnSync).mockReturnValue(spawnResult({ error: enoent }));

    const result = createBatchCapabilityRunner()('/wt', 'test.focused');

    expect(result).toEqual({ outcome: 'automation-broken' });
  });

  it('carries the envelope duration_ms through to the gate result', () => {
    vi.mocked(spawnSync).mockReturnValue(
      spawnResult({
        status: 0,
        stdout:
          '{"capability":"test.focused","outcome":"automation-broken","reason":"command timed out after 900000ms","duration_ms":901102}',
      })
    );

    const result = createBatchCapabilityRunner()('/wt', 'test.focused');

    expect(result).toMatchObject({
      outcome: 'automation-broken',
      reason: 'command timed out after 900000ms',
      durationMs: 901102,
    });
  });

  it('a non-numeric duration_ms reads as null, not a crash', () => {
    vi.mocked(spawnSync).mockReturnValue(
      spawnResult({
        status: 0,
        stdout: '{"capability":"typecheck.run","outcome":"ok","duration_ms":"900000"}',
      })
    );

    const result = createBatchCapabilityRunner()('/wt', 'typecheck.run');

    expect(result).toMatchObject({ outcome: 'ok', durationMs: null });
  });
});
