import fs from 'node:fs';
import { buildVerificationPayload, parseDossierContent } from '@ai-dossier/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSignCommand } from '../../commands/sign';
import { createTestProgram, makeDossier } from '../helpers/test-utils';

vi.mock('node:fs');

/** Every payload the mock KMS signer was asked to sign. */
const signedPayloads: string[] = [];

vi.mock('@ai-dossier/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ai-dossier/core')>();
  return {
    ...actual,
    KmsSigner: class MockKmsSigner {
      async sign(payload: string) {
        signedPayloads.push(payload);
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
  };
});

const mockedFs = vi.mocked(fs);
const dossierContent = makeDossier();

const specShaped =
  "---\nname: 'x'\ndescription: 'd'\nmetadata:\n  dossier.title: 'T'\n  other.tool: 'kept'\n---\n# Body\n";

/** Sign `content` with the mocked KMS key; return the written file and the signed payload. */
async function signWithKms(content: string, file = 'test.ds.md') {
  mockedFs.existsSync.mockReturnValue(true);
  mockedFs.readFileSync.mockReturnValue(content);
  mockedFs.writeFileSync.mockReset();
  signedPayloads.length = 0;

  const program = createTestProgram();
  registerSignCommand(program);
  await program.parseAsync(['node', 'dossier', 'sign', file, '--key-id', 'alias/my-org-key']);

  expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(1);
  expect(signedPayloads).toHaveLength(1);
  return { written: mockedFs.writeFileSync.mock.calls[0][1] as string, payload: signedPayloads[0] };
}

describe('sign command', () => {
  beforeEach(() => {
    mockedFs.writeFileSync.mockReset();
  });

  it('writes a legacy dossier in the spec layout under a v3 signature over that object', async () => {
    const { written, payload } = await signWithKms(dossierContent, 'dir/my-dossier.ds.md');
    const parsed = parseDossierContent(written);

    expect(written.startsWith('---\n')).toBe(true);
    expect(parsed.shape).toBe('spec');
    expect(parsed.frontmatter.signature?.covers).toBe('spec-frontmatter+body');
    expect(parsed.frontmatter.checksum?.hash).toMatch(/^[0-9a-f]{64}$/);
    // The verifier rebuilds exactly the bytes that were signed.
    expect(buildVerificationPayload(parsed)).toBe(payload);
  });

  it('derives the Agent Skills name and description when the dossier has none', async () => {
    const { written } = await signWithKms(dossierContent, 'dir/my-dossier.ds.md');
    const { frontmatter } = parseDossierContent(written);
    const source = parseDossierContent(dossierContent).frontmatter;
    expect(frontmatter.name).toBe(source.name ?? 'my-dossier');
    expect(frontmatter.description).toBe(source.description ?? source.objective);
  });

  it("re-signs a spec-shaped dossier, keeping other tools' metadata under the signature", async () => {
    const { written, payload } = await signWithKms(specShaped);
    const parsed = parseDossierContent(written);

    expect(parsed.shape).toBe('spec');
    expect((parsed.rawFrontmatter.metadata as Record<string, string>)['other.tool']).toBe('kept');
    expect(payload).toContain('other.tool');
    expect(buildVerificationPayload(parsed)).toBe(payload);
  });

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

    await expect(program.parseAsync(['node', 'dossier', 'sign', 'test.ds.md'])).rejects.toThrow();

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
    const { written } = await signWithKms(dossierContent);
    expect(parseDossierContent(written).frontmatter.signature).toMatchObject({
      algorithm: 'ECDSA-SHA-256',
      key_id: 'alias/my-org-key',
    });
  });
});
