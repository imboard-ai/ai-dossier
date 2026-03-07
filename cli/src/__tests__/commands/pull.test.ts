import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPullCommand } from '../../commands/pull';
import * as multiRegistry from '../../multi-registry';
import * as registryClient from '../../registry-client';
import { createTestProgram, parseNameVersionImpl } from '../helpers/test-utils';

vi.mock('node:fs');
vi.mock('../../multi-registry');
vi.mock('../../registry-client');

const mockedFs = vi.mocked(fs);

describe('pull command', () => {
  beforeEach(() => {
    vi.mocked(multiRegistry.multiRegistryGetDossier).mockReset();
    vi.mocked(multiRegistry.multiRegistryGetContent).mockReset();
    mockedFs.existsSync.mockReset();
    mockedFs.mkdirSync.mockReset();
    mockedFs.writeFileSync.mockReset();
    vi.mocked(registryClient.parseNameVersion).mockImplementation(parseNameVersionImpl);
  });

  it('should download and cache a dossier', async () => {
    vi.mocked(multiRegistry.multiRegistryGetDossier).mockResolvedValue({
      result: { version: '1.0.0', _registry: 'public' },
      errors: [],
    } as any);
    vi.mocked(multiRegistry.multiRegistryGetContent).mockResolvedValue({
      result: { content: '# Dossier', digest: null, _registry: 'public' },
      errors: [],
    });
    mockedFs.existsSync.mockReturnValue(false);

    const program = createTestProgram();
    registerPullCommand(program);

    await program.parseAsync(['node', 'dossier', 'pull', 'org/my-dossier']);

    expect(mockedFs.mkdirSync).toHaveBeenCalled();
    expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(2); // content + meta
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('downloaded'));
  });

  it('should skip already cached dossier', async () => {
    vi.mocked(multiRegistry.multiRegistryGetDossier).mockResolvedValue({
      result: { version: '1.0.0', _registry: 'public' },
      errors: [],
    } as any);
    mockedFs.existsSync.mockReturnValue(true);

    const program = createTestProgram();
    registerPullCommand(program);

    await program.parseAsync(['node', 'dossier', 'pull', 'org/my-dossier']);

    expect(multiRegistry.multiRegistryGetContent).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('already cached'));
  });

  it('should force re-download with --force', async () => {
    vi.mocked(multiRegistry.multiRegistryGetDossier).mockResolvedValue({
      result: { version: '1.0.0', _registry: 'public' },
      errors: [],
    } as any);
    vi.mocked(multiRegistry.multiRegistryGetContent).mockResolvedValue({
      result: { content: '# Updated', digest: null, _registry: 'public' },
      errors: [],
    });
    mockedFs.existsSync.mockReturnValue(true);

    const program = createTestProgram();
    registerPullCommand(program);

    await program.parseAsync(['node', 'dossier', 'pull', 'org/my-dossier', '--force']);

    expect(multiRegistry.multiRegistryGetContent).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('updated'));
  });

  it('should exit 1 when all items fail', async () => {
    vi.mocked(multiRegistry.multiRegistryGetDossier).mockResolvedValue({
      result: null,
      errors: [],
    } as any);
    mockedFs.existsSync.mockReturnValue(false);

    const program = createTestProgram();
    registerPullCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'pull', 'missing/dossier'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });

  it('should exit 1 on cache write failure when all items fail', async () => {
    vi.mocked(multiRegistry.multiRegistryGetDossier).mockResolvedValue({
      result: { version: '1.0.0', _registry: 'public' },
      errors: [],
    } as any);
    vi.mocked(multiRegistry.multiRegistryGetContent).mockResolvedValue({
      result: { content: '# Dossier', digest: null, _registry: 'public' },
      errors: [],
    });
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.mkdirSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const program = createTestProgram();
    registerPullCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'pull', 'org/my-dossier'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('failed to write cache files')
    );
  });

  it('should exit 0 when some items succeed and some fail', async () => {
    vi.mocked(multiRegistry.multiRegistryGetDossier).mockImplementation(async (name: string) => {
      if (name === 'org/good') {
        return { result: { version: '1.0.0', _registry: 'public' } as any, errors: [] };
      }
      return { result: null, errors: [] };
    });
    vi.mocked(multiRegistry.multiRegistryGetContent).mockResolvedValue({
      result: { content: '# Dossier', digest: null, _registry: 'public' },
      errors: [],
    });
    mockedFs.existsSync.mockReturnValue(false);

    const program = createTestProgram();
    registerPullCommand(program);

    await program.parseAsync(['node', 'dossier', 'pull', 'org/good', 'org/missing']);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('downloaded'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });

  it('should pull specific version', async () => {
    vi.mocked(multiRegistry.multiRegistryGetContent).mockResolvedValue({
      result: { content: '# Content', digest: null, _registry: 'public' },
      errors: [],
    });
    mockedFs.existsSync.mockReturnValue(false);

    const program = createTestProgram();
    registerPullCommand(program);

    await program.parseAsync(['node', 'dossier', 'pull', 'org/dossier@2.0.0']);

    expect(multiRegistry.multiRegistryGetContent).toHaveBeenCalledWith('org/dossier', '2.0.0');
  });
});
