import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { registerFromFileCommand } from '../../commands/from-file';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('node:fs');
vi.mock('@ai-dossier/core', () => ({
  calculateChecksum: vi.fn().mockReturnValue('abc123hash'),
  Ed25519Signer: vi.fn().mockImplementation(() => ({
    sign: vi.fn().mockResolvedValue({
      algorithm: 'ed25519',
      signature: 'sig-base64',
      public_key: 'pub-pem',
      signed_at: '2025-01-01T00:00:00Z',
    }),
  })),
}));

const mockedFs = vi.mocked(fs);

describe('from-file command', () => {
  it('should create a dossier from a text file', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('Body content here.');

    const program = createTestProgram();
    registerFromFileCommand(program);

    await expect(
      program.parseAsync([
        'node',
        'dossier',
        'from-file',
        'input.txt',
        '--name',
        'test-dossier',
        '--title',
        'Test Dossier',
        '--objective',
        'Test objective',
        '--author',
        'Alice',
      ])
    ).rejects.toThrow();

    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('test-dossier.ds.md'),
      expect.stringContaining('---dossier'),
      'utf8'
    );
  });

  it('should fail when input file not found', async () => {
    mockedFs.existsSync.mockReturnValue(false);

    const program = createTestProgram();
    registerFromFileCommand(program);

    await expect(
      program.parseAsync([
        'node',
        'dossier',
        'from-file',
        'missing.txt',
        '--name',
        'test',
        '--title',
        'Test',
        '--objective',
        'Test',
        '--author',
        'Alice',
      ])
    ).rejects.toThrow();
  });

  it('should fail when required fields are missing', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('Body content.');

    const program = createTestProgram();
    registerFromFileCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'from-file', 'input.txt'])).rejects.toThrow();
  });

  it('should load metadata from --meta file', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((filePath: any) => {
      if (String(filePath).includes('meta.json')) {
        return JSON.stringify({
          name: 'meta-dossier',
          title: 'Meta Title',
          objective: 'Meta objective',
          authors: ['Bob'],
        });
      }
      return 'Body from file.';
    });

    const program = createTestProgram();
    registerFromFileCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'from-file', 'input.txt', '--meta', 'meta.json'])
    ).rejects.toThrow();

    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('meta-dossier.ds.md'),
      expect.stringContaining('Meta Title'),
      'utf8'
    );
  });

  it('should use custom output path with -o', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('Body.');

    const program = createTestProgram();
    registerFromFileCommand(program);

    await expect(
      program.parseAsync([
        'node',
        'dossier',
        'from-file',
        'input.txt',
        '--name',
        'test',
        '--title',
        'Test',
        '--objective',
        'Test',
        '--author',
        'Alice',
        '-o',
        'custom-output.ds.md',
      ])
    ).rejects.toThrow();

    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('custom-output.ds.md'),
      expect.any(String),
      'utf8'
    );
  });

  it('should accept --dossier-version to set version', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('Body content.');

    const program = createTestProgram();
    registerFromFileCommand(program);

    await expect(
      program.parseAsync([
        'node',
        'dossier',
        'from-file',
        'input.txt',
        '--name',
        'test',
        '--title',
        'Test',
        '--objective',
        'Test',
        '--author',
        'Alice',
        '--dossier-version',
        '2.0.0',
      ])
    ).rejects.toThrow();

    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('"version": "2.0.0"'),
      'utf8'
    );
  });

  it('should use version from --meta when --dossier-version not provided', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockImplementation((filePath: any) => {
      if (String(filePath).includes('meta.json')) {
        return JSON.stringify({
          name: 'meta-dossier',
          title: 'Meta Title',
          objective: 'Meta objective',
          authors: ['Bob'],
          version: '3.5.0',
        });
      }
      return 'Body from file.';
    });

    const program = createTestProgram();
    registerFromFileCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'from-file', 'input.txt', '--meta', 'meta.json'])
    ).rejects.toThrow();

    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('"version": "3.5.0"'),
      'utf8'
    );
  });

  it('should fail --sign without --key', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('Body.');

    const program = createTestProgram();
    registerFromFileCommand(program);

    await expect(
      program.parseAsync([
        'node',
        'dossier',
        'from-file',
        'input.txt',
        '--name',
        'test',
        '--title',
        'Test',
        '--objective',
        'Test',
        '--author',
        'Alice',
        '--sign',
      ])
    ).rejects.toThrow();

  });
});
