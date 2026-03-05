import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPullCommand } from '../../commands/pull';
import * as registryClient from '../../registry-client';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('node:fs');
vi.mock('../../registry-client');

const mockedFs = vi.mocked(fs);

describe('pull command', () => {
  const mockClient = {
    getDossier: vi.fn(),
    getDossierContent: vi.fn(),
    getRegistryBaseUrl: () => 'https://registry.example.com',
  };

  beforeEach(() => {
    mockClient.getDossier.mockReset();
    mockClient.getDossierContent.mockReset();
    mockedFs.existsSync.mockReset();
    mockedFs.mkdirSync.mockReset();
    mockedFs.writeFileSync.mockReset();
    vi.mocked(registryClient.getClient).mockReturnValue(mockClient as any);
    vi.mocked(registryClient.parseNameVersion).mockImplementation((name: string) => {
      if (name.includes('@')) {
        const idx = name.lastIndexOf('@');
        return [name.slice(0, idx), name.slice(idx + 1)];
      }
      return [name, null];
    });
  });

  it('should download and cache a dossier', async () => {
    mockClient.getDossier.mockResolvedValue({ version: '1.0.0' });
    mockClient.getDossierContent.mockResolvedValue({
      content: '# Dossier',
      digest: null,
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
    mockClient.getDossier.mockResolvedValue({ version: '1.0.0' });
    // existsSync: true for both contentFile and metaFile checks
    mockedFs.existsSync.mockReturnValue(true);

    const program = createTestProgram();
    registerPullCommand(program);

    await program.parseAsync(['node', 'dossier', 'pull', 'org/my-dossier']);

    expect(mockClient.getDossierContent).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('already cached'));
  });

  it('should force re-download with --force', async () => {
    mockClient.getDossier.mockResolvedValue({ version: '1.0.0' });
    mockClient.getDossierContent.mockResolvedValue({
      content: '# Updated',
      digest: null,
    });
    mockedFs.existsSync.mockReturnValue(true);

    const program = createTestProgram();
    registerPullCommand(program);

    await program.parseAsync(['node', 'dossier', 'pull', 'org/my-dossier', '--force']);

    expect(mockClient.getDossierContent).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('updated'));
  });

  it('should handle 404 error', async () => {
    mockClient.getDossier.mockRejectedValue(
      Object.assign(new Error('Not found'), { statusCode: 404 })
    );
    mockedFs.existsSync.mockReturnValue(false);

    const program = createTestProgram();
    registerPullCommand(program);

    await program.parseAsync(['node', 'dossier', 'pull', 'missing/dossier']);

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });

  it('should pull specific version', async () => {
    mockClient.getDossierContent.mockResolvedValue({
      content: '# Content',
      digest: null,
    });
    mockedFs.existsSync.mockReturnValue(false);

    const program = createTestProgram();
    registerPullCommand(program);

    await program.parseAsync(['node', 'dossier', 'pull', 'org/dossier@2.0.0']);

    expect(mockClient.getDossierContent).toHaveBeenCalledWith('org/dossier', '2.0.0');
  });
});
