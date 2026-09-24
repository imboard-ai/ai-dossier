import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { SchedConfig } from '@ai-dossier/sched';
import { readPoolFileConfig } from '@ai-dossier/worktree-pool';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BATCH_SUITE_TIMEOUT_MS,
  batchGateRefusal,
  CAP_RUN_SETUP_GRACE_MS,
  createBatchSuiteRunner,
} from '../batch-suite-runner';
import type { CapabilityEntry, CapabilityManifest } from '../capability';

vi.mock('node:fs');
vi.mock('node:child_process');
vi.mock('@ai-dossier/worktree-pool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ai-dossier/worktree-pool')>();
  return { ...actual, readPoolFileConfig: vi.fn(actual.readPoolFileConfig) };
});

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
    mockedFs.mkdtempSync.mockReturnValue('/tmp/ai-dossier-cap-test');
    vi.mocked(readPoolFileConfig).mockReset();
    vi.mocked(readPoolFileConfig).mockReturnValue({} as ReturnType<typeof readPoolFileConfig>);
    // Detection needs a package manifest; capability manifests remain absent unless a test supplies one.
    mockedFs.existsSync.mockImplementation((file) => !String(file).includes('.dossier/automation'));
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
      expect.objectContaining({
        cwd: '/wt',
        timeout: BATCH_SUITE_TIMEOUT_MS + CAP_RUN_SETUP_GRACE_MS,
      })
    );
    expect(spawnSync).toHaveBeenCalledTimes(1); // no fallback needed
  });

  it('uses an active declared test.full timeout only for cap run', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((file) =>
      String(file).includes('.dossier/automation')
        ? 'version: 1\ncapabilities:\n  test.full:\n    command: make test\n    lifecycle: active\n    timeout_ms: 900000\n'
        : JSON.stringify({ scripts: { test: 'make test' } })
    );
    vi.mocked(spawnSync).mockReturnValue(
      spawnResult({
        status: 0,
        stdout: `${vitestReport(0)}\n{"capability":"test.full","outcome":"ok","exit_code":0}`,
      })
    );

    createBatchSuiteRunner(config())('/wt');

    expect(spawnSync).toHaveBeenCalledWith(
      'ai-dossier',
      ['cap', 'run', 'test.full'],
      expect.objectContaining({ timeout: 900_000 + CAP_RUN_SETUP_GRACE_MS })
    );
    expect(BATCH_SUITE_TIMEOUT_MS).toBe(600_000);
  });

  it('does not let a shadow test.full entry control the cap-run timeout', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((file) =>
      String(file).includes('.dossier/automation')
        ? 'version: 1\ncapabilities:\n  test.full:\n    command: make test\n    lifecycle: shadow\n    timeout_ms: 900000\n'
        : JSON.stringify({ scripts: { test: 'make test' } })
    );
    vi.mocked(spawnSync).mockImplementation((cmd) => {
      if (cmd === 'ai-dossier') return CAP_UNAVAILABLE;
      if (cmd === 'npm') return spawnResult({ status: 0, stdout: 'green\n' });
      throw new Error(`unexpected command: ${cmd}`);
    });

    createBatchSuiteRunner(config(), { timeoutMs: 1234 })('/wt');

    expect(spawnSync).toHaveBeenNthCalledWith(
      1,
      'ai-dossier',
      ['cap', 'run', 'test.full'],
      expect.objectContaining({ timeout: 1234 + CAP_RUN_SETUP_GRACE_MS })
    );
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
      'npm',
      ['test'],
      expect.objectContaining({ timeout: 1234 })
    );
  });

  it('keeps the configured runner timeout for tier 2 after cap is unavailable', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      'version: 1\ncapabilities:\n  test.full:\n    command: make test\n    lifecycle: active\n    timeout_ms: 900000\n'
    );
    vi.mocked(spawnSync).mockImplementation((cmd) => {
      if (cmd === 'ai-dossier') return CAP_UNAVAILABLE;
      if (cmd === 'make') return spawnResult({ status: 0, stdout: vitestReport(0) });
      throw new Error(`unexpected command: ${cmd}`);
    });

    createBatchSuiteRunner(config({ suite_command: ['make', 'test'] }), { timeoutMs: 1234 })('/wt');

    expect(spawnSync).toHaveBeenNthCalledWith(
      1,
      'ai-dossier',
      ['cap', 'run', 'test.full'],
      expect.objectContaining({ timeout: 900_000 + CAP_RUN_SETUP_GRACE_MS })
    );
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
      'make',
      ['test'],
      expect.objectContaining({ timeout: 1234 })
    );
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

  it('tier 2 (regression): a spawn error on tier 1 (no `ai-dossier` on PATH) still falls through to dispatch.suite_command, never straight to tier 3', () => {
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
      if (cmd === 'ai-dossier') {
        return spawnResult({
          error: Object.assign(new Error('spawnSync ai-dossier ENOENT'), { code: 'ENOENT' }),
        });
      }
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

  it('tier 1 (regression): a declared capability failure without an envelope is preserved without detection fallback', () => {
    vi.mocked(spawnSync).mockImplementation((cmd) => {
      if (cmd === 'ai-dossier') {
        return spawnResult({
          status: 1,
          stdout: 'test command failed before the harness emitted its envelope',
        });
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    const result = createBatchSuiteRunner(config())('/wt');

    expect(result.detail).toContain('task-failed');
    expect(result.detail).toContain('harness produced no envelope');
    expect(result.ok).toBe(false);
    expect(result.readable).toBe(false);
    expect(spawnSync).toHaveBeenCalledTimes(1);
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
        expect(args).toEqual(['--no', 'vitest', 'run', '--reporter=json']);
        return spawnResult({ status: 0, stdout: vitestReport(0) });
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    const result = createBatchSuiteRunner(config())('/wt');
    expect(result.ok).toBe(true);
  });

  it('regression: an unreadable configured suite retries once with detected fallback and never looks like a parseable zero-failure report', () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ scripts: { test: 'make test' } }));
    vi.mocked(spawnSync).mockImplementation((cmd) => {
      if (cmd === 'ai-dossier') return CAP_UNAVAILABLE;
      if (cmd === 'make') return spawnResult({ status: 1, stdout: 'configured suite failed' });
      if (cmd === 'npm') {
        return spawnResult({ status: 1, stdout: 'make: *** [test] Error 1\n' });
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    const result = createBatchSuiteRunner(config({ suite_command: ['make', 'test'] }))('/wt');

    expect(result.ok).toBe(false);
    expect(result.readable).toBe(false);
    expect(result.failing).toEqual([]);
    // Capability availability, configured suite, then the one fallback retry.
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });

  it('runs detected suites from the configured nested project root', () => {
    mockedFs.existsSync.mockReturnValue(true);
    vi.mocked(readPoolFileConfig).mockReturnValue({
      project_subdir: 'main',
    } as ReturnType<typeof readPoolFileConfig>);
    mockedFs.readFileSync.mockImplementation((_file) => {
      return JSON.stringify({ scripts: { test: 'vitest run' } });
    });
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
      if (cmd === 'ai-dossier') return CAP_UNAVAILABLE;
      if (cmd === 'npx') {
        expect(args).toEqual(['--no', 'vitest', 'run', '--reporter=json']);
        return spawnResult({ status: 0, stdout: vitestReport(0) });
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    const result = createBatchSuiteRunner(config())('/wt');

    expect(result.ok).toBe(true);
    expect(spawnSync).toHaveBeenLastCalledWith(
      'npx',
      ['--no', 'vitest', 'run', '--reporter=json'],
      expect.objectContaining({ cwd: '/wt/main' })
    );
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

  it('#811: a verdict survives ETIMEDOUT when cap run already exited and wrote its envelope file (a descendant held stdout)', () => {
    mockedFs.readFileSync.mockImplementation((file) =>
      String(file).includes('ai-dossier-cap-test')
        ? JSON.stringify({ cap_envelope: 1, capability: 'test.full', outcome: 'ok', exit_code: 0 })
        : JSON.stringify({ scripts: { test: 'make test' } })
    );
    const timeoutError = Object.assign(new Error('spawnSync ai-dossier ETIMEDOUT'), {
      code: 'ETIMEDOUT',
    });
    vi.mocked(spawnSync).mockReturnValue(
      spawnResult({ status: 0, error: timeoutError, stdout: 'late descendant output' })
    );

    const result = createBatchSuiteRunner(config())('/wt');

    expect(result).toMatchObject({ ok: true, readable: true });
    expect(result.detail).toContain('envelope=file');
    expect(result.detail).toContain('a descendant held cap run');
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("#811: an envelope whose outcome disagrees with cap run's exit code is never trusted (a forged ok)", () => {
    vi.mocked(spawnSync).mockReturnValue(
      spawnResult({
        status: 1,
        stdout: `${JSON.stringify({ cap_envelope: 1, capability: 'test.full', outcome: 'ok', exit_code: 0 })}\n`,
      })
    );

    const result = createBatchSuiteRunner(config())('/wt');

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('harness produced no envelope');
    expect(result.detail).toContain('disagrees with cap run exit 1');
  });

  it('a declared non-default test.full timeout is terminal, reports its budget and elapsed time, and never reaches a fallback', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      'version: 1\ncapabilities:\n  test.full:\n    command: make test\n    lifecycle: active\n    timeout_ms: 900000\n'
    );
    const timeoutError = Object.assign(new Error('spawnSync ai-dossier ETIMEDOUT'), {
      code: 'ETIMEDOUT',
    });
    vi.mocked(spawnSync).mockReturnValue(spawnResult({ error: timeoutError }));
    vi.spyOn(Date, 'now').mockReturnValueOnce(10_000).mockReturnValueOnce(910_123);

    const result = createBatchSuiteRunner(config(), { timeoutMs: 1234 })('/wt');

    expect(result).toMatchObject({ ok: false, readable: false });
    expect(result.detail).toContain('command timed out after 900000ms');
    expect(result.detail).toContain('elapsed 900123ms');
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenLastCalledWith(
      'ai-dossier',
      ['cap', 'run', 'test.full'],
      expect.objectContaining({ timeout: 900_000 + CAP_RUN_SETUP_GRACE_MS })
    );
  });

  it('does not spawn npm when tier 3 has no project package.json', () => {
    mockedFs.existsSync.mockReturnValue(false);
    vi.mocked(spawnSync).mockReturnValue(CAP_UNAVAILABLE);

    const result = createBatchSuiteRunner(config())('/wt');

    expect(result).toMatchObject({ ok: false, readable: false });
    expect(result.detail).toContain('capability unavailable: no package.json');
    expect(spawnSync).toHaveBeenCalledTimes(1);
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

describe('gate.batch capability (#777)', () => {
  const CTX = { batchId: 'b-777', baseRef: 'origin/main' };
  const manifest = (gateLifecycle: 'active' | 'shadow' | null, extra = ''): string =>
    'version: 1\ncapabilities:\n' +
    (gateLifecycle !== null
      ? `  gate.batch:\n    command: scripts/ci-parity.sh\n    lifecycle: ${gateLifecycle}\n    timeout_ms: 1800000\n`
      : '') +
    `  test.full:\n    command: make test\n    lifecycle: active\n${extra}`;
  const envelope = (id: string, outcome: string, exit = 0, reason?: string): string =>
    JSON.stringify({ capability: id, outcome, exit_code: exit, ...(reason ? { reason } : {}) });

  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
    mockedFs.readFileSync.mockReset();
    mockedFs.mkdtempSync.mockReturnValue('/tmp/ai-dossier-cap-test');
    vi.mocked(readPoolFileConfig).mockReset();
    vi.mocked(readPoolFileConfig).mockReturnValue({} as ReturnType<typeof readPoolFileConfig>);
    mockedFs.existsSync.mockReturnValue(true);
  });

  const withManifest = (text: string): void => {
    mockedFs.readFileSync.mockImplementation((file) =>
      String(file).includes('.dossier/automation')
        ? text
        : JSON.stringify({ scripts: { test: 'make test' } })
    );
  };

  it('prefers an active gate.batch over test.full — one spawn, its own timeout, batch env', () => {
    withManifest(manifest('active'));
    vi.mocked(spawnSync).mockReturnValue(
      spawnResult({ status: 0, stdout: envelope('gate.batch', 'ok') })
    );

    const result = createBatchSuiteRunner(config())('/wt', CTX);

    expect(result).toMatchObject({ ok: true, readable: true });
    expect(result.detail).toContain('cap run gate.batch: outcome=ok');
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenCalledWith(
      'ai-dossier',
      ['cap', 'run', 'gate.batch'],
      expect.objectContaining({
        cwd: '/wt',
        timeout: 1_800_000 + CAP_RUN_SETUP_GRACE_MS,
        env: expect.objectContaining({
          DOSSIER_BATCH_ID: 'b-777',
          DOSSIER_BATCH_BASE: 'origin/main',
        }),
      })
    );
  });

  it.each([
    ['no gate.batch declared', null],
    ['a shadow gate.batch', 'shadow'],
  ] as const)('falls back to test.full with %s', (_label, lifecycle) => {
    withManifest(manifest(lifecycle));
    vi.mocked(spawnSync).mockReturnValue(
      spawnResult({ status: 0, stdout: envelope('test.full', 'ok') })
    );

    const result = createBatchSuiteRunner(config())('/wt', CTX);

    expect(result).toMatchObject({ ok: true });
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenCalledWith(
      'ai-dossier',
      ['cap', 'run', 'test.full'],
      expect.objectContaining({
        env: expect.objectContaining({ DOSSIER_BATCH_BASE: 'origin/main' }),
      })
    );
  });

  it('falls back to test.full when cap run reports gate.batch capability-unavailable', () => {
    withManifest(manifest('active'));
    vi.mocked(spawnSync).mockImplementation((_cmd, args) =>
      (args as string[])[2] === 'gate.batch'
        ? spawnResult({ status: 3, stdout: envelope('gate.batch', 'capability-unavailable', 3) })
        : spawnResult({ status: 0, stdout: envelope('test.full', 'ok') })
    );

    const result = createBatchSuiteRunner(config())('/wt', CTX);

    expect(result.detail).toContain('cap run test.full');
    expect(vi.mocked(spawnSync).mock.calls.map((c) => (c[1] as string[])[2])).toEqual([
      'gate.batch',
      'test.full',
    ]);
  });

  it('omits the batch env when no context is supplied (pre-#777 callers)', () => {
    withManifest(manifest('active'));
    vi.mocked(spawnSync).mockReturnValue(
      spawnResult({ status: 0, stdout: envelope('gate.batch', 'ok') })
    );

    createBatchSuiteRunner(config())('/wt');

    // #811: `env` now always carries the envelope-file channel — never the batch keys.
    const env = vi.mocked(spawnSync).mock.calls[0]?.[2]?.env ?? {};
    expect(env).not.toHaveProperty('DOSSIER_BATCH_ID');
    expect(env).not.toHaveProperty('DOSSIER_BATCH_BASE');
    expect(env).toHaveProperty('DOSSIER_CAP_ENVELOPE_FILE');
  });

  // AC: outcomes map identically whichever capability is the gate.
  describe.each([
    ['gate.batch', manifest('active')],
    ['test.full', manifest(null)],
  ])('outcome mapping via %s', (id, text) => {
    beforeEach(() => withManifest(text));

    it('ok → green', () => {
      vi.mocked(spawnSync).mockReturnValue(spawnResult({ status: 0, stdout: envelope(id, 'ok') }));
      expect(createBatchSuiteRunner(config())('/wt', CTX)).toMatchObject({
        ok: true,
        failing: [],
        readable: true,
      });
    });

    it('task-failed with a parseable report → red and attributable', () => {
      vi.mocked(spawnSync).mockReturnValue(
        spawnResult({ status: 1, stdout: `${vitestReport(2)}\n${envelope(id, 'task-failed', 1)}` })
      );
      const result = createBatchSuiteRunner(config())('/wt', CTX);
      expect(result).toMatchObject({ ok: false, readable: true });
      expect(result.failing).toHaveLength(2);
      expect(spawnSync).toHaveBeenCalledTimes(1);
    });

    it('automation-broken → unreadable (suite-unreadable block), no detection fallback', () => {
      vi.mocked(spawnSync).mockReturnValue(
        spawnResult({
          status: 2,
          stdout: envelope(id, 'automation-broken', 2, 'assumption failed'),
        })
      );
      const result = createBatchSuiteRunner(config())('/wt', CTX);
      expect(result).toMatchObject({ ok: false, failing: [], readable: false });
      expect(result.detail).toContain(`cap run ${id}: outcome=automation-broken`);
      expect(spawnSync).toHaveBeenCalledTimes(1);
    });

    it('task-failed without a report → unreadable (suite-unreadable block), no detection fallback', () => {
      vi.mocked(spawnSync).mockReturnValue(
        spawnResult({ status: 1, stdout: `boom\n${envelope(id, 'task-failed', 1)}` })
      );
      const result = createBatchSuiteRunner(config())('/wt', CTX);
      expect(result).toMatchObject({ ok: false, readable: false });
      expect(spawnSync).toHaveBeenCalledTimes(1);
    });
  });
});

describe('batchGateRefusal (#777)', () => {
  const entry = (extra: Partial<CapabilityEntry> = {}): CapabilityEntry => ({
    command: 'x',
    lifecycle: 'active',
    ...extra,
  });
  const m = (capabilities: Record<string, CapabilityEntry>): CapabilityManifest => ({
    path: '/repo/.dossier/automation/manifest.yaml',
    capabilities,
  });

  it('refuses when the only full gate is a timeout-prone test.full', () => {
    const reason = batchGateRefusal(m({ 'test.full': entry({ timeoutProne: true }) }));
    expect(reason).toContain('timeout_prone');
    expect(reason).toContain('gate.batch');
  });

  it('allows when an active gate.batch exists alongside it', () => {
    expect(
      batchGateRefusal(m({ 'test.full': entry({ timeoutProne: true }), 'gate.batch': entry() }))
    ).toBeNull();
  });

  it('still refuses when gate.batch is only shadow', () => {
    expect(
      batchGateRefusal(
        m({
          'test.full': entry({ timeoutProne: true }),
          'gate.batch': entry({ lifecycle: 'shadow' }),
        })
      )
    ).not.toBeNull();
  });

  it.each([
    ['no manifest', {}],
    ['test.full not timeout-prone', { 'test.full': entry() }],
    [
      'a shadow timeout-prone test.full',
      { 'test.full': entry({ lifecycle: 'shadow', timeoutProne: true }) },
    ],
  ])('allows with %s', (_label, caps) => {
    expect(batchGateRefusal(m(caps as Record<string, CapabilityEntry>))).toBeNull();
  });
});
