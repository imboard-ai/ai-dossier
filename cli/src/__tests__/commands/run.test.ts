import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as cacheResolver from '../../cache-resolver';
import { registerRunCommand } from '../../commands/run';
import * as config from '../../config';
import * as helpers from '../../helpers';
import * as multiRegistry from '../../multi-registry';
import * as registryClient from '../../registry-client';
import * as runLog from '../../run-log';
import { createTestProgram, parseNameVersionImpl } from '../helpers/test-utils';

vi.mock('node:fs');
vi.mock('node:child_process');
vi.mock('../../config');
vi.mock('../../multi-registry');
vi.mock('../../registry-client');
vi.mock('../../helpers');
vi.mock('../../run-log');
vi.mock('../../cache-resolver');

const mockedFs = vi.mocked(fs);

/** Typed spawnSync result for the #458 tests (status + optional stdout). */
const spawnResult = (status: number | null, stdout?: string): SpawnSyncReturns<string> =>
  ({ status, stdout }) as SpawnSyncReturns<string>;

describe('run command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(spawnSync).mockReset();
    vi.mocked(registryClient.parseNameVersion).mockImplementation(parseNameVersionImpl);
    vi.mocked(helpers.runVerification).mockResolvedValue({ passed: true, checks: [] });
    vi.mocked(helpers.detectLlm).mockReturnValue('claude-code');
    vi.mocked(helpers.detectNestedHost).mockReturnValue(null);
    vi.mocked(helpers.buildLlmCommand).mockReturnValue({
      cmd: 'claude',
      args: ['test.ds.md'],
      description: 'claude "test.ds.md"',
      agent: 'claude-code',
    });
    vi.mocked(helpers.safeDossierPath).mockImplementation((_base: string, name: string) => {
      return `/home/.dossier/cache/${name}`;
    });
    vi.mocked(config.getConfig).mockReturnValue(undefined);
    // Reset the parseAgentUsage implementation explicitly: clearAllMocks only
    // clears call history, so a mockReturnValue from a previous test would
    // otherwise leak into the next one.
    vi.mocked(helpers.parseAgentUsage).mockReset();
    vi.mocked(helpers.parseOpenCodeUsage).mockReset();
    // cache-resolver helpers used by run.ts after the resolveCachedVersion call.
    // The module is fully mocked, so these need explicit stubs or they return undefined
    // and break the URL-detection branch below.
    vi.mocked(cacheResolver.cachedContentPath).mockImplementation(
      (name: string, version: string) => `/home/.dossier/cache/${name}/${version}.ds.md`
    );
    vi.mocked(cacheResolver.writeCachedContent).mockImplementation(() => {});
    // Mock TOCTOU mitigation temp file operations
    mockedFs.mkdtempSync.mockReturnValue('/tmp/dossier-run-test');
    mockedFs.writeFileSync.mockReturnValue(undefined);
    mockedFs.unlinkSync.mockReturnValue(undefined);
    mockedFs.rmdirSync.mockReturnValue(undefined);
  });

  it('should run a local dossier file', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as any);

    const program = createTestProgram();
    registerRunCommand(program);

    await program.parseAsync(['node', 'dossier', 'run', 'test.ds.md']);

    expect(spawnSync).toHaveBeenCalled();
    expect(helpers.runVerification).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Executing'));
  });

  it('should exit 1 when verification fails', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');
    vi.mocked(helpers.runVerification).mockResolvedValue({ passed: false, checks: [] });

    const program = createTestProgram();
    registerRunCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'run', 'test.ds.md'])).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Verification failed'));
  });

  it('should show dry run info without executing', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');

    const program = createTestProgram();
    registerRunCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'run', 'test.ds.md', '--dry-run'])
    ).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('DRY RUN'));
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('should exit 1 when registry dossier not found (resolver throws)', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.readdirSync.mockReturnValue([]);
    vi.mocked(cacheResolver.resolveCachedVersion).mockRejectedValue(
      new Error('Failed to resolve missing/dossier: registry unreachable and no cached version')
    );

    const program = createTestProgram();
    registerRunCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'run', 'missing/dossier'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to resolve'));
  });

  it('should exit 2 when no LLM detected', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');
    vi.mocked(helpers.detectLlm).mockReturnValue(null);

    const program = createTestProgram();
    registerRunCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'run', 'test.ds.md'])).rejects.toThrow();
  });

  it('should call appendRunLog on successful run', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as any);

    const program = createTestProgram();
    registerRunCommand(program);

    await program.parseAsync(['node', 'dossier', 'run', 'test.ds.md']);

    expect(runLog.appendRunLog).toHaveBeenCalledWith(
      expect.objectContaining({
        dossier: 'test.ds.md',
        verification: 'passed',
        nested: false,
      })
    );
  });

  it('should call appendRunLog with failed verification', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');
    vi.mocked(helpers.runVerification).mockResolvedValue({ passed: false, checks: [] });

    const program = createTestProgram();
    registerRunCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'run', 'test.ds.md'])).rejects.toThrow();

    expect(runLog.appendRunLog).toHaveBeenCalledWith(
      expect.objectContaining({
        dossier: 'test.ds.md',
        verification: 'failed',
        nested: false,
      })
    );
  });

  it('should call appendRunLog in nested mode (Claude Code)', async () => {
    vi.mocked(helpers.detectNestedHost).mockReturnValue('Claude Code');
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');

    const program = createTestProgram();
    registerRunCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'run', 'test.ds.md'])).rejects.toThrow();

    expect(runLog.appendRunLog).toHaveBeenCalledWith(
      expect.objectContaining({
        dossier: 'test.ds.md',
        verification: 'nested-skip',
        nested: true,
      })
    );
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('should call appendRunLog in nested mode (opencode)', async () => {
    vi.mocked(helpers.detectNestedHost).mockReturnValue('opencode');
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');

    const program = createTestProgram();
    registerRunCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'run', 'test.ds.md'])).rejects.toThrow();

    expect(runLog.appendRunLog).toHaveBeenCalledWith(
      expect.objectContaining({
        dossier: 'test.ds.md',
        verification: 'nested-skip',
        nested: true,
      })
    );
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('should log verification as skipped with --skip-all-checks', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as any);

    const program = createTestProgram();
    registerRunCommand(program);

    await program.parseAsync(['node', 'dossier', 'run', 'test.ds.md', '--skip-all-checks']);

    expect(runLog.appendRunLog).toHaveBeenCalledWith(
      expect.objectContaining({
        verification: 'skipped',
      })
    );
  });

  it('auto-resolves to the registry version when a stale version is cached (regression: #401)', async () => {
    // Cache has 1.0.0 on disk, but registry says 1.1.0 is current.
    // Old behavior: silently used 1.0.0 + cosmetic "Update available" warning.
    // New behavior: resolveCachedVersion returns 1.1.0 — we re-fetch and execute that.
    vi.mocked(cacheResolver.resolveCachedVersion).mockResolvedValue({
      version: '1.1.0',
      source: 'registry',
      registry: 'public',
    });
    // 1.1.0 content file is not yet cached — forces a registry fetch.
    mockedFs.existsSync.mockImplementation((p: any) => {
      const ps = String(p);
      if (ps.endsWith('1.0.0.ds.md')) return true;
      if (ps.endsWith('1.1.0.ds.md')) return false;
      return false;
    });
    vi.mocked(multiRegistry.multiRegistryGetContent).mockResolvedValue({
      result: {
        content: '---dossier\n{"title":"Test"}\n---\nBody',
        digest: null,
        _registry: 'public',
      },
      errors: [],
    } as any);
    mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as any);

    const program = createTestProgram();
    registerRunCommand(program);

    await program.parseAsync(['node', 'dossier', 'run', 'org/test']);

    expect(cacheResolver.resolveCachedVersion).toHaveBeenCalledWith(
      'org/test',
      expect.objectContaining({ fresh: undefined })
    );
    expect(multiRegistry.multiRegistryGetContent).toHaveBeenCalledWith('org/test', '1.1.0');
    expect(runLog.appendRunLog).toHaveBeenCalledWith(
      expect.objectContaining({ resolved_version: '1.1.0' })
    );
  });

  it('uses cached content when resolver returns a version that is already on disk', async () => {
    vi.mocked(cacheResolver.resolveCachedVersion).mockResolvedValue({
      version: '1.2.3',
      source: 'cache',
      registry: 'public',
    });
    mockedFs.existsSync.mockImplementation((p: any) => {
      const ps = String(p);
      // 1.2.3 content file exists in cache.
      if (ps.endsWith('1.2.3.ds.md')) return true;
      return false;
    });
    mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as any);

    const program = createTestProgram();
    registerRunCommand(program);

    await program.parseAsync(['node', 'dossier', 'run', 'org/test']);

    expect(multiRegistry.multiRegistryGetContent).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Using cached'));
  });

  it('does not call the version resolver for pinned name@version', async () => {
    mockedFs.existsSync.mockImplementation((p: any) => {
      const ps = String(p);
      if (ps.endsWith('2.5.0.ds.md')) return true;
      return false;
    });
    mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as any);

    const program = createTestProgram();
    registerRunCommand(program);

    await program.parseAsync(['node', 'dossier', 'run', 'org/test@2.5.0']);

    expect(cacheResolver.resolveCachedVersion).not.toHaveBeenCalled();
    expect(runLog.appendRunLog).toHaveBeenCalledWith(
      expect.objectContaining({ resolved_version: '2.5.0' })
    );
  });

  describe('run log cost/observability fields (#458)', () => {
    it('records usage, spawned command, exit code and duration from headless JSON output', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');
      vi.mocked(spawnSync).mockReturnValue(spawnResult(0, '{"type":"result"}'));
      vi.mocked(helpers.parseAgentUsage).mockReturnValue({
        model: 'claude-opus-4-20250514',
        input_tokens: 1234,
        output_tokens: 567,
        total_cost_usd: 0.0123,
        result_text: 'done',
      });
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      const program = createTestProgram();
      registerRunCommand(program);

      await program.parseAsync(['node', 'dossier', 'run', 'test.ds.md', '--headless']);

      expect(spawnSync).toHaveBeenCalledWith(
        'claude',
        ['test.ds.md'],
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'inherit'],
          // Explicit cap: spawnSync's 1MB default kills children with large JSON results.
          maxBuffer: 32 * 1024 * 1024,
        })
      );
      expect(runLog.appendRunLog).toHaveBeenCalledWith(
        expect.objectContaining({
          duration_ms: expect.any(Number),
          spawned_command: 'claude test.ds.md',
          llm: 'claude-code',
          model: 'claude-opus-4-20250514',
          exit_code: 0,
          input_tokens: 1234,
          output_tokens: 567,
          total_cost_usd: 0.0123,
        })
      );
      // The captured result text is re-emitted on stdout.
      expect(stdoutSpy).toHaveBeenCalledWith('done\n');
    });

    it('records null usage fields and re-emits raw stdout when output is not JSON', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');
      vi.mocked(spawnSync).mockReturnValue(spawnResult(0, 'plain output'));
      vi.mocked(helpers.parseAgentUsage).mockReturnValue(null);
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const program = createTestProgram();
      registerRunCommand(program);

      await program.parseAsync(['node', 'dossier', 'run', 'test.ds.md', '--headless']);

      expect(runLog.appendRunLog).toHaveBeenCalledWith(
        expect.objectContaining({
          exit_code: 0,
          model: null,
          input_tokens: null,
          output_tokens: null,
          total_cost_usd: null,
        })
      );
      expect(stdoutSpy).toHaveBeenCalledWith('plain output\n');
      // The operator can tell WHY usage is null: the output was not parseable.
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('usage/cost not recorded'));
    });

    it('records null usage fields in interactive mode and keeps the requested --model alias', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');
      vi.mocked(spawnSync).mockReturnValue(spawnResult(0));

      const program = createTestProgram();
      registerRunCommand(program);

      await program.parseAsync(['node', 'dossier', 'run', 'test.ds.md', '--model', 'opus']);

      expect(helpers.parseAgentUsage).not.toHaveBeenCalled();
      expect(runLog.appendRunLog).toHaveBeenCalledWith(
        expect.objectContaining({
          duration_ms: expect.any(Number),
          spawned_command: 'claude test.ds.md',
          model: 'opus',
          exit_code: 0,
          input_tokens: null,
          output_tokens: null,
          total_cost_usd: null,
        })
      );
    });

    it('records exit code and captured usage when execution fails', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');
      vi.mocked(spawnSync).mockReturnValue(spawnResult(7, '{"type":"result"}'));
      vi.mocked(helpers.parseAgentUsage).mockReturnValue({
        model: 'claude-opus-4-20250514',
        input_tokens: 1,
        output_tokens: 2,
        total_cost_usd: 0.001,
        result_text: 'error occurred',
      });
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      const program = createTestProgram();
      registerRunCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'run', 'test.ds.md', '--headless'])
      ).rejects.toThrow('process.exit(7)');

      expect(runLog.appendRunLog).toHaveBeenCalledWith(
        expect.objectContaining({
          exit_code: 7,
          input_tokens: 1,
          output_tokens: 2,
          total_cost_usd: 0.001,
          spawned_command: 'claude test.ds.md',
        })
      );
    });

    it('records the spawn error when the child is killed by a signal or fails to spawn', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');
      vi.mocked(spawnSync).mockReturnValue({
        status: null,
        signal: 'SIGTERM',
        error: new Error('spawn claude ENOBUFS'),
        stdout: '',
      } as unknown as ReturnType<typeof spawnSync>);
      vi.mocked(helpers.parseAgentUsage).mockReturnValue(null);
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const program = createTestProgram();
      registerRunCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'run', 'test.ds.md', '--headless'])
      ).rejects.toThrow('process.exit(2)');

      expect(runLog.appendRunLog).toHaveBeenCalledWith(
        expect.objectContaining({
          exit_code: null,
          spawn_error: 'spawn claude ENOBUFS',
        })
      );
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('spawn claude ENOBUFS'));
    });

    it('records null usage fields when the agent reports nothing (usage-unavailable path)', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');
      // No stdout on the spawn result; parseAgentUsage auto-mock returns undefined.
      vi.mocked(spawnSync).mockReturnValue(spawnResult(0));

      const program = createTestProgram();
      registerRunCommand(program);

      await program.parseAsync(['node', 'dossier', 'run', 'test.ds.md', '--headless']);

      expect(runLog.appendRunLog).toHaveBeenCalledWith(
        expect.objectContaining({
          exit_code: 0,
          model: null,
          input_tokens: null,
          output_tokens: null,
          total_cost_usd: null,
        })
      );
    });

    it('records exit code 0 with null spawned command on dry-run', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');

      const program = createTestProgram();
      registerRunCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'run', 'test.ds.md', '--dry-run'])
      ).rejects.toThrow('process.exit(0)');

      expect(runLog.appendRunLog).toHaveBeenCalledWith(
        expect.objectContaining({
          exit_code: 0,
          spawned_command: null,
          model: null,
          input_tokens: null,
          output_tokens: null,
          total_cost_usd: null,
          duration_ms: expect.any(Number),
        })
      );
    });

    it('records exit code 1 on failed verification', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');
      vi.mocked(helpers.runVerification).mockResolvedValue({ passed: false, checks: [] });

      const program = createTestProgram();
      registerRunCommand(program);

      await expect(program.parseAsync(['node', 'dossier', 'run', 'test.ds.md'])).rejects.toThrow(
        'process.exit(1)'
      );

      expect(runLog.appendRunLog).toHaveBeenCalledWith(
        expect.objectContaining({
          verification: 'failed',
          exit_code: 1,
          spawned_command: null,
          duration_ms: expect.any(Number),
        })
      );
    });

    it('records exit code 0 and nulls in nested mode', async () => {
      vi.mocked(helpers.detectNestedHost).mockReturnValue('opencode');
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');

      const program = createTestProgram();
      registerRunCommand(program);

      await expect(program.parseAsync(['node', 'dossier', 'run', 'test.ds.md'])).rejects.toThrow(
        'process.exit(0)'
      );

      expect(runLog.appendRunLog).toHaveBeenCalledWith(
        expect.objectContaining({
          verification: 'nested-skip',
          exit_code: 0,
          spawned_command: null,
          model: null,
          input_tokens: null,
          output_tokens: null,
          total_cost_usd: null,
          duration_ms: expect.any(Number),
        })
      );
    });
  });

  describe('opencode agent support (#459)', () => {
    it('records the resolved agent CLI in llm and parses opencode JSONL usage', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');
      vi.mocked(helpers.detectLlm).mockReturnValue('opencode');
      vi.mocked(helpers.buildLlmCommand).mockReturnValue({
        cmd: 'opencode',
        args: ['run', '--format', 'json'],
        stdin: '---dossier\n{"title":"Test"}\n---\nBody',
        description: 'cat "test.ds.md" | opencode run --format json',
        agent: 'opencode',
      });
      vi.mocked(spawnSync).mockReturnValue(
        spawnResult(0, '{"type":"text"}\n{"type":"step_finish"}')
      );
      vi.mocked(helpers.parseOpenCodeUsage).mockReturnValue({
        model: null,
        input_tokens: 73,
        output_tokens: 6,
        total_cost_usd: 0.00774516,
        result_text: 'PIPED-OK',
      });
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      const program = createTestProgram();
      registerRunCommand(program);

      await program.parseAsync([
        'node',
        'dossier',
        'run',
        'test.ds.md',
        '--headless',
        '--llm',
        'opencode',
      ]);

      // Usage parsing dispatches on the spawned agent's CLI.
      expect(helpers.parseOpenCodeUsage).toHaveBeenCalled();
      expect(helpers.parseAgentUsage).not.toHaveBeenCalled();
      expect(spawnSync).toHaveBeenCalledWith(
        'opencode',
        ['run', '--format', 'json'],
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'inherit'],
          maxBuffer: 32 * 1024 * 1024,
        })
      );
      // The run log records WHICH agent CLI was spawned — the resolved
      // 'opencode', not the raw --llm option value.
      expect(runLog.appendRunLog).toHaveBeenCalledWith(
        expect.objectContaining({
          llm: 'opencode',
          spawned_command: 'opencode run --format json',
          model: null, // opencode events carry no model id; no --model alias given
          input_tokens: 73,
          output_tokens: 6,
          total_cost_usd: 0.00774516,
          exit_code: 0,
        })
      );
      // The extracted result text is re-emitted on stdout.
      expect(stdoutSpy).toHaveBeenCalledWith('PIPED-OK\n');
    });

    it('re-emits raw stdout and warns when opencode output is not a JSONL event stream', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');
      vi.mocked(helpers.detectLlm).mockReturnValue('opencode');
      vi.mocked(helpers.buildLlmCommand).mockReturnValue({
        cmd: 'opencode',
        args: ['run', '--format', 'json'],
        stdin: 'content',
        description: 'cat "test.ds.md" | opencode run --format json',
        agent: 'opencode',
      });
      vi.mocked(spawnSync).mockReturnValue(spawnResult(0, 'plain output'));
      vi.mocked(helpers.parseOpenCodeUsage).mockReturnValue(null);
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const program = createTestProgram();
      registerRunCommand(program);

      await program.parseAsync([
        'node',
        'dossier',
        'run',
        'test.ds.md',
        '--headless',
        '--llm',
        'opencode',
      ]);

      expect(runLog.appendRunLog).toHaveBeenCalledWith(
        expect.objectContaining({
          llm: 'opencode',
          exit_code: 0,
          model: null,
          input_tokens: null,
          output_tokens: null,
          total_cost_usd: null,
        })
      );
      expect(stdoutSpy).toHaveBeenCalledWith('plain output\n');
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('not an opencode JSONL event stream')
      );
    });

    it('records the resolved agent in llm when execution fails (opencode)', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');
      vi.mocked(helpers.detectLlm).mockReturnValue('opencode');
      vi.mocked(helpers.buildLlmCommand).mockReturnValue({
        cmd: 'opencode',
        args: ['run', '--format', 'json'],
        stdin: 'content',
        description: 'cat "test.ds.md" | opencode run --format json',
        agent: 'opencode',
      });
      vi.mocked(spawnSync).mockReturnValue(spawnResult(7, ''));
      vi.mocked(helpers.parseOpenCodeUsage).mockReturnValue(null);
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const program = createTestProgram();
      registerRunCommand(program);

      await expect(
        program.parseAsync([
          'node',
          'dossier',
          'run',
          'test.ds.md',
          '--headless',
          '--llm',
          'opencode',
        ])
      ).rejects.toThrow('process.exit(7)');

      expect(runLog.appendRunLog).toHaveBeenCalledWith(
        expect.objectContaining({
          llm: 'opencode',
          spawned_command: 'opencode run --format json',
          exit_code: 7,
        })
      );
    });
  });
});
