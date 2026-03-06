import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerExportCommand } from '../../commands/export';
import * as multiRegistry from '../../multi-registry';
import * as registryClient from '../../registry-client';
import { createTestProgram, parseNameVersionImpl } from '../helpers/test-utils';

vi.mock('node:fs');
vi.mock('../../multi-registry');
vi.mock('../../registry-client');

const mockedFs = vi.mocked(fs);

describe('export command', () => {
  beforeEach(() => {
    vi.mocked(registryClient.parseNameVersion).mockImplementation(parseNameVersionImpl);
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.writeFileSync.mockReset();
    mockedFs.mkdirSync.mockReset();
  });

  it('should export dossier to file', async () => {
    vi.mocked(multiRegistry.multiRegistryGetContent).mockResolvedValue({
      result: { content: '# Dossier content', digest: 'sha256:abc', _registry: 'public' },
      errors: [],
    });

    const program = createTestProgram();
    registerExportCommand(program);

    await program.parseAsync(['node', 'dossier', 'export', 'my-dossier']);

    expect(mockedFs.writeFileSync).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Exported'));
  });

  it('should export specific version', async () => {
    vi.mocked(multiRegistry.multiRegistryGetContent).mockResolvedValue({
      result: { content: 'content', digest: null, _registry: 'public' },
      errors: [],
    });

    const program = createTestProgram();
    registerExportCommand(program);

    await program.parseAsync(['node', 'dossier', 'export', 'my-dossier@1.0.0']);

    expect(multiRegistry.multiRegistryGetContent).toHaveBeenCalledWith('my-dossier', '1.0.0');
  });

  it('should write to stdout with --stdout', async () => {
    vi.mocked(multiRegistry.multiRegistryGetContent).mockResolvedValue({
      result: { content: 'dossier content here', digest: null, _registry: 'public' },
      errors: [],
    });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const program = createTestProgram();
    registerExportCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'export', 'my-dossier', '--stdout'])
    ).rejects.toThrow();

    expect(writeSpy).toHaveBeenCalledWith('dossier content here');
  });

  it('should exit 1 when not found', async () => {
    vi.mocked(multiRegistry.multiRegistryGetContent).mockResolvedValue({
      result: null,
      errors: [],
    });

    const program = createTestProgram();
    registerExportCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'export', 'missing-dossier'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Not found'));
  });

  it('should exit 1 with message on file write error', async () => {
    vi.mocked(multiRegistry.multiRegistryGetContent).mockResolvedValue({
      result: { content: '# Dossier content', digest: null, _registry: 'public' },
      errors: [],
    });
    mockedFs.writeFileSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const program = createTestProgram();
    registerExportCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'export', 'my-dossier'])).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to write file'));
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('EACCES: permission denied')
    );
  });

  it('should use custom output path with -o', async () => {
    vi.mocked(multiRegistry.multiRegistryGetContent).mockResolvedValue({
      result: { content: 'content', digest: null, _registry: 'public' },
      errors: [],
    });

    const program = createTestProgram();
    registerExportCommand(program);

    await program.parseAsync(['node', 'dossier', 'export', 'my-dossier', '-o', '/tmp/out.ds.md']);

    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('out.ds.md'),
      'content',
      'utf8'
    );
  });
});
