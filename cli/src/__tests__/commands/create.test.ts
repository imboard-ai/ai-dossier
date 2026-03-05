import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { registerCreateCommand } from '../../commands/create';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('node:fs');
vi.mock('node:child_process');
vi.mock('../../config');
vi.mock('../../helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../helpers')>();
  return {
    ...actual,
    detectLlm: vi.fn(),
  };
});
vi.mock('../../registry-client', () => ({
  getClient: vi.fn(() => ({
    getDossier: vi.fn().mockResolvedValue({ version: '1.0.0' }),
    getDossierContent: vi.fn().mockResolvedValue({ content: '# Meta dossier content' }),
  })),
  parseNameVersion: vi.fn((name: string) => {
    const parts = name.split('@');
    return [parts[0], parts[1] || ''];
  }),
}));

const mockedFs = vi.mocked(fs);

// Import after mock setup
const { detectLlm } = await import('../../helpers');

describe('create command', () => {
  it('should exit 2 when LLM not detected', async () => {
    vi.mocked(detectLlm).mockReturnValue(null);

    const program = createTestProgram();
    registerCreateCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'create'])).rejects.toThrow();
  });

  it('should exit 2 when template not found in registry', async () => {
    vi.mocked(detectLlm).mockReturnValue('claude-code');
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.readdirSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const { getClient } = await import('../../registry-client');
    vi.mocked(getClient).mockReturnValue({
      getDossier: vi.fn().mockRejectedValue({ statusCode: 404 }),
    } as any);

    const program = createTestProgram();
    registerCreateCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'create'])).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Template not found'));
  });

  it('should fetch template from registry and launch LLM', async () => {
    vi.mocked(detectLlm).mockReturnValue('claude-code');
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.readdirSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as any);

    const { getClient } = await import('../../registry-client');
    vi.mocked(getClient).mockReturnValue({
      getDossier: vi.fn().mockResolvedValue({ version: '1.0.0' }),
      getDossierContent: vi.fn().mockResolvedValue({ content: '# Meta dossier content' }),
    } as any);

    const program = createTestProgram();
    registerCreateCommand(program);

    await program.parseAsync(['node', 'dossier', 'create', '--title', 'My Dossier']);

    expect(spawnSync).toHaveBeenCalledWith('claude', [expect.stringContaining('dossier-create-')], {
      stdio: 'inherit',
    });
    expect(mockedFs.writeFileSync).toHaveBeenCalled();
    expect(mockedFs.unlinkSync).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('completed'));
  });

  it('should clean up temp file on exec failure', async () => {
    vi.mocked(detectLlm).mockReturnValue('claude-code');
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.readdirSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    vi.mocked(spawnSync).mockReturnValue({ status: 1 } as any);

    const { getClient } = await import('../../registry-client');
    vi.mocked(getClient).mockReturnValue({
      getDossier: vi.fn().mockResolvedValue({ version: '1.0.0' }),
      getDossierContent: vi.fn().mockResolvedValue({ content: '# Meta dossier' }),
    } as any);

    const program = createTestProgram();
    registerCreateCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'create'])).rejects.toThrow();

    expect(mockedFs.unlinkSync).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('creation failed'));
  });
});
