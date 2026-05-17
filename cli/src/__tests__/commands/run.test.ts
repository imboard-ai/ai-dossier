import { spawnSync } from 'node:child_process';
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

describe('run command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(spawnSync).mockReset();
    vi.mocked(registryClient.parseNameVersion).mockImplementation(parseNameVersionImpl);
    vi.mocked(helpers.runVerification).mockResolvedValue({ passed: true, checks: [] });
    vi.mocked(helpers.detectLlm).mockReturnValue('claude-code');
    vi.mocked(helpers.buildLlmCommand).mockReturnValue({
      cmd: 'claude',
      args: ['test.ds.md'],
      description: 'claude "test.ds.md"',
    });
    vi.mocked(helpers.safeDossierPath).mockImplementation((_base: string, name: string) => {
      return `/home/.dossier/cache/${name}`;
    });
    vi.mocked(config.getConfig).mockReturnValue(undefined);
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
    // Remove any CLAUDE_CODE env to prevent nested detection
    delete process.env.CLAUDE_CODE;
    delete process.env.CLAUDECODE;
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

  it('should call appendRunLog in nested mode', async () => {
    process.env.CLAUDE_CODE = '1';
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
});
