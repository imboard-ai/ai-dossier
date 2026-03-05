import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/cli-wrapper', () => ({
  execCli: vi.fn(),
  CliNotFoundError: class CliNotFoundError extends Error {
    constructor() {
      super('ai-dossier CLI not found');
      this.name = 'CliNotFoundError';
    }
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { CliNotFoundError, execCli } from '../../utils/cli-wrapper';
import { listDossiers } from '../listDossiers';

describe('listDossiers tool', () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should list dossiers from CLI output', async () => {
    const mockDossiers = [
      { path: '/cwd/test.ds.md', filename: 'test.ds.md', title: 'Test', version: '1.0.0' },
    ];
    vi.mocked(execCli).mockResolvedValue(mockDossiers);

    const result = await listDossiers({ path: originalCwd });

    expect(result.dossiers).toEqual(mockDossiers);
    expect(result.count).toBe(1);
    expect(result.scannedPath).toBe(originalCwd);
  });

  it('should use cwd when no path is provided', async () => {
    vi.mocked(execCli).mockResolvedValue([]);

    const result = await listDossiers({});

    expect(result.scannedPath).toBe(originalCwd);
    expect(result.count).toBe(0);
  });

  it('should pass recursive flag', async () => {
    vi.mocked(execCli).mockResolvedValue([]);

    await listDossiers({ path: originalCwd, recursive: true });

    expect(execCli).toHaveBeenCalledWith('list', expect.arrayContaining(['--recursive']));
  });

  it('should not pass recursive flag when false', async () => {
    vi.mocked(execCli).mockResolvedValue([]);

    await listDossiers({ path: originalCwd, recursive: false });

    const args = vi.mocked(execCli).mock.calls[0][1];
    expect(args).not.toContain('--recursive');
  });

  it('should reject paths outside working directory', async () => {
    await expect(listDossiers({ path: '/etc/passwd' })).rejects.toThrow('Access denied');
  });

  it('should handle empty result gracefully', async () => {
    vi.mocked(execCli).mockResolvedValue(null);

    const result = await listDossiers({ path: originalCwd });

    expect(result.dossiers).toEqual([]);
    expect(result.count).toBe(0);
  });

  it('should throw when CLI is not found', async () => {
    vi.mocked(execCli).mockRejectedValue(new CliNotFoundError());

    await expect(listDossiers({ path: originalCwd })).rejects.toThrow('ai-dossier CLI not found');
  });
});
