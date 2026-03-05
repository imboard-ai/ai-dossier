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
import { verifyDossier } from '../verifyDossier';

describe('verifyDossier tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return verification result from CLI', async () => {
    const mockResult = {
      passed: true,
      stages: [
        { stage: 1, name: 'Integrity Check', passed: true },
        { stage: 2, name: 'Authenticity Check', passed: true },
      ],
    };
    vi.mocked(execCli).mockResolvedValue(mockResult);

    const result = await verifyDossier({ path: '/test/dossier.ds.md' });

    expect(result).toEqual(mockResult);
    expect(execCli).toHaveBeenCalledWith('verify', ['/test/dossier.ds.md', '--json']);
  });

  it('should return failed verification from CLI', async () => {
    const mockResult = {
      passed: false,
      stages: [{ stage: 1, name: 'Integrity Check', passed: false }],
    };
    vi.mocked(execCli).mockResolvedValue(mockResult);

    const result = await verifyDossier({ path: '/test/bad.ds.md' });

    expect(result.passed).toBe(false);
    expect(result.stages[0].passed).toBe(false);
  });

  it('should return CLI check failure when CLI is not found', async () => {
    vi.mocked(execCli).mockRejectedValue(new CliNotFoundError());

    const result = await verifyDossier({ path: '/test/dossier.ds.md' });

    expect(result.passed).toBe(false);
    expect(result.stages).toEqual([{ stage: 0, name: 'CLI Check', passed: false }]);
  });

  it('should propagate non-CLI errors', async () => {
    vi.mocked(execCli).mockRejectedValue(new Error('unexpected error'));

    await expect(verifyDossier({ path: '/test/dossier.ds.md' })).rejects.toThrow(
      'unexpected error'
    );
  });
});
