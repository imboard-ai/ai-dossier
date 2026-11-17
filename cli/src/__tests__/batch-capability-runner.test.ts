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

  it('a NON-timeout spawn error stays automation-broken (a genuine machinery failure, still blocks), naming the spawn error', () => {
    const enoent = new Error('spawnSync ai-dossier ENOENT') as Error & { code?: string };
    enoent.code = 'ENOENT';
    vi.mocked(spawnSync).mockReturnValue(spawnResult({ error: enoent }));

    const result = createBatchCapabilityRunner()('/wt', 'test.focused');

    expect(result).toMatchObject({
      outcome: 'automation-broken',
      reason: 'cap run test.focused spawn error ENOENT',
    });
  });

  it('#811: a forged ok envelope from a failing cap run is automation-broken with evidence, never ok', () => {
    vi.mocked(spawnSync).mockReturnValue(
      spawnResult({
        status: 1,
        stdout: '{"cap_envelope":1,"capability":"test.focused","outcome":"ok","exit_code":0}',
      })
    );

    const result = createBatchCapabilityRunner()('/wt', 'test.focused');

    expect(result.outcome).toBe('automation-broken');
    expect(result.reason).toContain('no trusted envelope');
    expect(result.reason).toContain('disagrees with cap run exit 1');
  });

  it('#811: ETIMEDOUT after cap run exited with a verdict keeps that verdict', () => {
    const timedOut = new Error('spawnSync ETIMEDOUT') as Error & { code?: string };
    timedOut.code = 'ETIMEDOUT';
    vi.mocked(spawnSync).mockReturnValue(
      spawnResult({
        status: 0,
        error: timedOut,
        stdout: '{"cap_envelope":1,"capability":"test.focused","outcome":"ok","exit_code":0}\nlate',
      })
    );

    const result = createBatchCapabilityRunner({ timeoutMs: 50 })('/wt', 'test.focused');

    expect(result.outcome).toBe('ok');
  });

  it('carries the envelope duration_ms through to the gate result', () => {
    vi.mocked(spawnSync).mockReturnValue(
      spawnResult({
        status: 2,
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

  it('#1281: carries the envelope exit_code so a decline (exit 3) is told apart from an undeclared id', () => {
    vi.mocked(spawnSync).mockReturnValueOnce(
      spawnResult({
        status: 3,
        stdout:
          '{"cap_envelope":1,"capability":"test.focused","outcome":"capability-unavailable","exit_code":3,"reason":"command declined"}',
      })
    );
    vi.mocked(spawnSync).mockReturnValueOnce(
      spawnResult({
        status: 3,
        stdout:
          '{"cap_envelope":1,"capability":"test.focused","outcome":"capability-unavailable","exit_code":null}',
      })
    );
    const run = createBatchCapabilityRunner();

    expect(run('/wt', 'test.focused')).toMatchObject({
      outcome: 'capability-unavailable',
      exitCode: 3,
    });
    expect(run('/wt', 'test.focused')).toMatchObject({
      outcome: 'capability-unavailable',
      exitCode: null,
    });
  });

  it('#1281: exports DOSSIER_BATCH_ID and DOSSIER_BATCH_INTEGRATION_REF to a member gate', () => {
    vi.mocked(spawnSync).mockReturnValue(
      spawnResult({
        status: 0,
        stdout: '{"cap_envelope":1,"capability":"test.focused","outcome":"ok","exit_code":0}',
      })
    );

    createBatchCapabilityRunner()('/wt', 'test.focused', {
      batchId: 'b-1',
      integrationRef: 'batch/b-1-20261117',
    });

    const env = vi.mocked(spawnSync).mock.calls[0]?.[2]?.env ?? {};
    expect(env.DOSSIER_BATCH_ID).toBe('b-1');
    expect(env.DOSSIER_BATCH_INTEGRATION_REF).toBe('batch/b-1-20261117');
    // Not the aggregate gate's TARGET-branch variable — that scope would
    // still include landed siblings.
    expect(env).not.toHaveProperty('DOSSIER_BATCH_BASE');
  });

  it('#1281: without a ctx (or without an integration ref) no batch variable is invented', () => {
    vi.mocked(spawnSync).mockReturnValue(
      spawnResult({
        status: 0,
        stdout: '{"cap_envelope":1,"capability":"worktree.prepare","outcome":"ok","exit_code":0}',
      })
    );
    const run = createBatchCapabilityRunner();

    run('/wt', 'worktree.prepare');
    run('/wt', 'test.focused', { batchId: 'b-2' });

    const noCtxEnv = vi.mocked(spawnSync).mock.calls[0]?.[2]?.env ?? {};
    expect(noCtxEnv.DOSSIER_BATCH_ID).toBe(process.env.DOSSIER_BATCH_ID);
    const recheckEnv = vi.mocked(spawnSync).mock.calls[1]?.[2]?.env ?? {};
    expect(recheckEnv.DOSSIER_BATCH_ID).toBe('b-2');
    expect(recheckEnv).not.toHaveProperty('DOSSIER_BATCH_INTEGRATION_REF');
  });

  it('#1281: a ref inherited from the calling shell never leaks into a gate that omits it', () => {
    vi.mocked(spawnSync).mockReturnValue(
      spawnResult({
        status: 0,
        stdout: '{"cap_envelope":1,"capability":"test.focused","outcome":"ok","exit_code":0}',
      })
    );
    const saved = {
      ref: process.env.DOSSIER_BATCH_INTEGRATION_REF,
      base: process.env.DOSSIER_BATCH_BASE,
    };
    process.env.DOSSIER_BATCH_INTEGRATION_REF = 'stale-ref';
    process.env.DOSSIER_BATCH_BASE = 'origin/stale';
    try {
      createBatchCapabilityRunner()('/wt', 'test.focused', { batchId: 'b-3' });
    } finally {
      if (saved.ref === undefined) delete process.env.DOSSIER_BATCH_INTEGRATION_REF;
      else process.env.DOSSIER_BATCH_INTEGRATION_REF = saved.ref;
      if (saved.base === undefined) delete process.env.DOSSIER_BATCH_BASE;
      else process.env.DOSSIER_BATCH_BASE = saved.base;
    }

    const env = vi.mocked(spawnSync).mock.calls[0]?.[2]?.env ?? {};
    expect(env.DOSSIER_BATCH_ID).toBe('b-3');
    expect(env).not.toHaveProperty('DOSSIER_BATCH_INTEGRATION_REF');
    expect(env).not.toHaveProperty('DOSSIER_BATCH_BASE');
  });
});
