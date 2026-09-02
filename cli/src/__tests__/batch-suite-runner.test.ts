import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { SchedConfig } from '@ai-dossier/sched';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBatchSuiteRunner } from '../batch-suite-runner';

vi.mock('node:fs');
vi.mock('node:child_process');

const mockedFs = vi.mocked(fs);

const spawnResult = (opts: {
  status?: number | null;
  stdout?: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
}): SpawnSyncReturns<string> =>
  ({
    status: opts.status ?? null,
    stdout: opts.stdout ?? '',
    stderr: '',
    signal: opts.signal ?? null,
    error: opts.error,
    pid: 1,
    output: [],
  }) as SpawnSyncReturns<string>;

const vitestReport = (failing: number): string =>
  JSON.stringify({
    testResults: [
      {
        name: 'a.test.ts',
        assertionResults: Array.from({ length: failing }, (_, i) => ({
          status: 'failed',
          fullName: `fails ${i}`,
        })),
      },
    ],
  });

const config = (dispatch: SchedConfig['dispatch'] = {}): SchedConfig => ({
  max_slots: 1,
  dispatch,
});

const CAP_UNAVAILABLE = spawnResult({
  status: 3,
  stdout: '{"capability":"test.full","outcome":"capability-unavailable"}',
});

describe('createBatchSuiteRunner (#562)', () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
    mockedFs.readFileSync.mockReset();
  });

  it('tier 1: prefers `cap run test.full` when the manifest declares it', () => {
    vi.mocked(spawnSync).mockImplementation((cmd) => {
      if (cmd === 'ai-dossier') {
        return spawnResult({
          status: 0,
          stdout: `${vitestReport(0)}\n{"capability":"test.full","outcome":"ok","exit_code":0}`,
        });
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    const result = createBatchSuiteRunner(config())('/wt');

    expect(result).toMatchObject({ ok: true, failing: [], readable: true });
    expect(spawnSync).toHaveBeenCalledWith(
      'ai-dossier',
      ['cap', 'run', 'test.full'],
      expect.objectContaining({ cwd: '/wt' })
    );
    expect(spawnSync).toHaveBeenCalledTimes(1); // no fallback needed
  });

  it('tier 2: falls through to dispatch.suite_command when the capability is unavailable', () => {
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
      if (cmd === 'ai-dossier') return CAP_UNAVAILABLE;
      if (cmd === 'make' && (args as string[])?.[0] === 'test') {
        return spawnResult({ status: 0, stdout: vitestReport(0) });
      }
      throw new Error(`unexpected command: ${cmd} ${JSON.stringify(args)}`);
    });

    const result = createBatchSuiteRunner(config({ suite_command: ['make', 'test'] }))('/wt');

    expect(result).toMatchObject({ ok: true, readable: true });
    expect(spawnSync).toHaveBeenCalledWith(
      'make',
      ['test'],
      expect.objectContaining({ cwd: '/wt' })
    );
  });

  it('tier 3 (regression, #562 root cause): a make-delegated `test` script runs as plain `npm test` — no reporter flags forwarded through the wrapper', () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ scripts: { test: 'make test' } }));
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
      if (cmd === 'ai-dossier') return CAP_UNAVAILABLE;
      if (cmd === 'npm') {
        // The #562 bug: `npm test -- --reporter=json` reaches a make-delegated
        // script as an unrecognized `make` option and aborts before running
        // anything. The fix is exactly that `args` here is `['test']` — no
        // trailing flags — so a real green suite reports green.
        expect(args).toEqual(['test']);
        return spawnResult({ status: 0, stdout: '✓ Tests completed\n' });
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    const result = createBatchSuiteRunner(config())('/wt');

    expect(result.ok).toBe(true);
  });

  it('tier 3 detects a direct vitest test script and appends its own JSON reporter', () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ scripts: { test: 'vitest run' } }));
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
      if (cmd === 'ai-dossier') return CAP_UNAVAILABLE;
      if (cmd === 'npx') {
        expect(args).toEqual(['vitest', 'run', '--reporter=json']);
        return spawnResult({ status: 0, stdout: vitestReport(0) });
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    const result = createBatchSuiteRunner(config())('/wt');
    expect(result.ok).toBe(true);
  });

  it('regression: an unreadable report (missing/broken reporter) retries once with the detected fallback and never looks like a parseable zero-failure report', () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ scripts: { test: 'make test' } }));
    vi.mocked(spawnSync).mockImplementation((cmd) => {
      if (cmd === 'ai-dossier') {
        // Genuinely ran, genuinely failed, but the reporter never produced
        // parseable JSON — plain text, not `{ testResults: [...] }`.
        return spawnResult({
          status: 1,
          stdout:
            'some tests failed, no json reporter configured\n{"outcome":"task-failed","exit_code":1}',
        });
      }
      if (cmd === 'npm') {
        return spawnResult({ status: 1, stdout: 'make: *** [test] Error 1\n' });
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    const result = createBatchSuiteRunner(config())('/wt');

    expect(result.ok).toBe(false);
    expect(result.readable).toBe(false);
    expect(result.failing).toEqual([]);
    // Both tiers were tried: primary, then the one fallback retry.
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });

  it('regression: a timeout/spawn error is unreadable, not an attributable empty report', () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ scripts: { test: 'make test' } }));
    const timeoutError = Object.assign(new Error('spawnSync npm ETIMEDOUT'), { code: 'ETIMEDOUT' });
    vi.mocked(spawnSync).mockImplementation((cmd) => {
      if (cmd === 'ai-dossier') return CAP_UNAVAILABLE;
      if (cmd === 'npm') return spawnResult({ error: timeoutError });
      throw new Error(`unexpected command: ${cmd}`);
    });

    const result = createBatchSuiteRunner(config())('/wt');

    expect(result.ok).toBe(false);
    expect(result.readable).toBe(false);
    expect(result.detail).toContain('ETIMEDOUT');
  });

  it('a genuinely red, parseable report stays readable so attribution can still run', () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ scripts: { test: 'vitest run' } }));
    vi.mocked(spawnSync).mockImplementation((cmd) => {
      if (cmd === 'ai-dossier') return CAP_UNAVAILABLE;
      if (cmd === 'npx') return spawnResult({ status: 1, stdout: vitestReport(2) });
      throw new Error(`unexpected command: ${cmd}`);
    });

    const result = createBatchSuiteRunner(config())('/wt');

    expect(result.ok).toBe(false);
    expect(result.readable).toBe(true);
    expect(result.failing).toHaveLength(2);
    expect(spawnSync).toHaveBeenCalledTimes(2); // cap (unavailable) + detected — no fallback retry
  });
});
