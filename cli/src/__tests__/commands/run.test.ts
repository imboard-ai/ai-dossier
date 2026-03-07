import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const mockedFs = vi.mocked(fs);

describe('run command', () => {
  beforeEach(() => {
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

  it('should exit 1 when registry dossier not found', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.readdirSync.mockReturnValue([]);
    vi.mocked(multiRegistry.multiRegistryGetDossier).mockResolvedValue({
      result: null,
      errors: [],
    } as any);

    const program = createTestProgram();
    registerRunCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'run', 'missing/dossier'])
    ).rejects.toThrow();

    expect(helpers.printRegistryNotFoundError).toHaveBeenCalledWith('missing/dossier', []);
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

  it('should show stale cache warning when meta has newer version', async () => {
    // Set up as registry name (not local file)
    mockedFs.existsSync.mockImplementation((p: any) => {
      const ps = String(p);
      // Not a local file, but cache dir + content file exist
      if (ps.includes('cache/org/test')) return true;
      if (ps.endsWith('.ds.md') && ps.includes('cache')) return true;
      return false;
    });
    mockedFs.readdirSync.mockReturnValue(['1.0.0.meta.json'] as any);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const ps = String(p);
      if (ps.includes('.meta.json')) {
        return JSON.stringify({
          cached_at: '2026-03-06T10:00:00Z',
          version: '1.0.0',
          latest_known_version: '2.0.0',
          latest_checked_at: new Date().toISOString(),
        });
      }
      return '---dossier\n{"title":"Test"}\n---\nBody';
    });
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as any);

    const program = createTestProgram();
    registerRunCommand(program);

    await program.parseAsync(['node', 'dossier', 'run', 'org/test']);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Update available'));
  });
});
