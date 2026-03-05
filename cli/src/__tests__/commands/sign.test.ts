import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { registerSignCommand } from '../../commands/sign';
import { createTestProgram, makeDossier } from '../helpers/test-utils';

vi.mock('node:fs');
vi.mock('@ai-dossier/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ai-dossier/core')>();
  return {
    ...actual,
    KmsSigner: class MockKmsSigner {
      async sign() {
        return {
          algorithm: 'ECDSA-SHA-256',
          signature: 'mock-sig',
          public_key: 'mock-pub',
          key_id: 'alias/my-org-key',
          signed_at: '2024-01-01T00:00:00.000Z',
        };
      }
    },
  };
});
vi.mock('../../helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../helpers')>();
  return {
    ...actual,
    OFFICIAL_KMS_KEYS: ['alias/dossier-official-prod'],
    REPO_ROOT: '/repo',
  };
});

const mockedFs = vi.mocked(fs);
const dossierContent = makeDossier();

describe('sign command', () => {
  it('should exit when file not found', async () => {
    mockedFs.existsSync.mockReturnValue(false);

    const program = createTestProgram();
    registerSignCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'sign', 'missing.ds.md'])
    ).rejects.toThrow();
  });

  it('should exit for official KMS key without --force', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(dossierContent);

    const program = createTestProgram();
    registerSignCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'sign', 'test.ds.md'])
    ).rejects.toThrow();

    // Should not have written the file (signing was blocked)
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('should exit for unknown signing method', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(dossierContent);

    const program = createTestProgram();
    registerSignCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'sign', 'test.ds.md', '--method', 'unknown'])
    ).rejects.toThrow();

    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('should exit for ed25519 without --key', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(dossierContent);

    const program = createTestProgram();
    registerSignCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'sign', 'test.ds.md', '--method', 'ed25519'])
    ).rejects.toThrow();

    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('should sign with KMS using custom key', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(dossierContent);

    const program = createTestProgram();
    registerSignCommand(program);

    await program.parseAsync([
      'node',
      'dossier',
      'sign',
      'test.ds.md',
      '--key-id',
      'alias/my-org-key',
    ]);

    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('"algorithm": "ECDSA-SHA-256"'),
      'utf8'
    );
  });
});
