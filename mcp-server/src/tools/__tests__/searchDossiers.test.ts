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
import { searchDossiers } from '../searchDossiers';

describe('searchDossiers tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should search and return results', async () => {
    const mockResult = {
      dossiers: [{ name: 'deploy', title: 'Deploy App', version: '1.0.0', tags: ['devops'] }],
      total: 1,
    };
    vi.mocked(execCli).mockResolvedValue(mockResult);

    const result = await searchDossiers({ query: 'deploy' });

    expect(result.dossiers).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(execCli).toHaveBeenCalledWith('search', ['deploy', '--json']);
  });

  it('should pass category filter', async () => {
    vi.mocked(execCli).mockResolvedValue({ dossiers: [], total: 0 });

    await searchDossiers({ query: 'test', category: 'devops' });

    expect(execCli).toHaveBeenCalledWith('search', ['test', '--json', '--category', 'devops']);
  });

  it('should handle empty results', async () => {
    vi.mocked(execCli).mockResolvedValue({ dossiers: undefined, total: undefined });

    const result = await searchDossiers({ query: 'nonexistent' });

    expect(result.dossiers).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('should throw when CLI is not found', async () => {
    vi.mocked(execCli).mockRejectedValue(new CliNotFoundError());

    await expect(searchDossiers({ query: 'test' })).rejects.toThrow('ai-dossier CLI not found');
  });
});
