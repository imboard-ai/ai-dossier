import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRunCommand } from '../../commands/run';
import * as config from '../../config';
import * as helpers from '../../helpers';
import * as multiRegistry from '../../multi-registry';
import * as registryClient from '../../registry-client';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('node:fs');
vi.mock('node:child_process');
vi.mock('../../config');
vi.mock('../../multi-registry');
vi.mock('../../registry-client');
vi.mock('../../helpers');

const mockedFs = vi.mocked(fs);

describe('run command', () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
    vi.mocked(registryClient.parseNameVersion).mockImplementation((name: string) => {
      if (name.includes('@')) {
        const idx = name.lastIndexOf('@');
        return [name.slice(0, idx), name.slice(idx + 1)];
      }
      return [name, null];
    });
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
    vi.mocked(multiRegistry.multiRegistryGetDossier).mockResolvedValue(null);

    const program = createTestProgram();
    registerRunCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'run', 'missing/dossier'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Not found'));
  });

  it('should exit 2 when no LLM detected', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('---dossier\n{"title":"Test"}\n---\nBody');
    vi.mocked(helpers.detectLlm).mockReturnValue(null);

    const program = createTestProgram();
    registerRunCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'run', 'test.ds.md'])).rejects.toThrow();
  });
});
