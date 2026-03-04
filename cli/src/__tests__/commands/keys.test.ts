import crypto from 'node:crypto';
import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { registerKeysCommand } from '../../commands/keys';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('node:fs');
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  return {
    ...actual,
    default: {
      ...actual,
      generateKeyPairSync: vi.fn().mockReturnValue({
        privateKey: {
          export: vi
            .fn()
            .mockReturnValue('-----BEGIN PRIVATE KEY-----\nmock\n-----END PRIVATE KEY-----\n'),
        },
        publicKey: {
          export: vi.fn().mockImplementation((opts: any) => {
            if (opts.format === 'der') {
              // Return a buffer with 44 bytes (12 header + 32 key)
              return Buffer.alloc(44, 0);
            }
            return '-----BEGIN PUBLIC KEY-----\nmock\n-----END PUBLIC KEY-----\n';
          }),
        },
      }),
    },
  };
});

const mockedFs = vi.mocked(fs);

describe('keys command', () => {
  describe('keys list', () => {
    it('should show message when no trusted keys file', async () => {
      mockedFs.existsSync.mockReturnValue(false);
      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(program.parseAsync(['node', 'dossier', 'keys', 'list'])).rejects.toThrow(
        'process.exit(0)'
      );

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No trusted keys file'));
    });

    it('should display trusted keys', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('abc123key team-key-2025\ndef456key other-key\n');
      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(program.parseAsync(['node', 'dossier', 'keys', 'list'])).rejects.toThrow(
        'process.exit(0)'
      );

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('2 trusted key(s)'));
    });

    it('should output JSON with --json', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('abc123key team-key\n');
      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'keys', 'list', '--json'])
      ).rejects.toThrow('process.exit(0)');

      const jsonCalls = vi
        .mocked(console.log)
        .mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('public_key'));
      expect(jsonCalls.length).toBeGreaterThan(0);
    });
  });

  describe('keys generate', () => {
    it('should generate a key pair', async () => {
      mockedFs.existsSync.mockReturnValue(false);

      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(program.parseAsync(['node', 'dossier', 'keys', 'generate'])).rejects.toThrow(
        'process.exit(0)'
      );

      expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(2);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Key pair generated'));
    });

    it('should use custom name', async () => {
      mockedFs.existsSync.mockReturnValue(false);

      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'keys', 'generate', '--name', 'mykey'])
      ).rejects.toThrow('process.exit(0)');

      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('mykey.pem'),
        expect.any(String),
        expect.any(Object)
      );
    });

    it('should refuse to overwrite without --force', async () => {
      mockedFs.existsSync.mockReturnValue(true);

      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(program.parseAsync(['node', 'dossier', 'keys', 'generate'])).rejects.toThrow(
        'process.exit(1)'
      );

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('already exist'));
    });

    it('should overwrite with --force', async () => {
      mockedFs.existsSync.mockImplementation(() => true);
      mockedFs.writeFileSync.mockClear();

      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'keys', 'generate', '--force'])
      ).rejects.toThrow('process.exit(0)');

      expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(2);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Key pair generated'));
    });
  });

  describe('keys add', () => {
    it('should add a new key', async () => {
      // First call (existsSync for dossierDir): true
      // Second call (existsSync for trustedKeysPath): false (new file)
      mockedFs.existsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);
      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'keys', 'add', 'newkey123', 'my-key'])
      ).rejects.toThrow('process.exit(0)');

      expect(mockedFs.appendFileSync).toHaveBeenCalledWith(
        expect.any(String),
        'newkey123 my-key\n',
        'utf8'
      );
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Key added'));
    });

    it('should detect duplicate key', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('existingkey team-key\n');
      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'keys', 'add', 'existingkey', 'my-key'])
      ).rejects.toThrow('process.exit(0)');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('already exists'));
    });
  });
});
