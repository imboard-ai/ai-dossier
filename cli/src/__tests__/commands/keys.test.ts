import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
          // A real Ed25519 SPKI PEM, so the raw-base64 the command derives from
          // it is a real key rather than a placeholder that normalizes to junk.
          export: vi
            .fn()
            .mockReturnValue(
              '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA5kr+/8mNiyCqjDmuS6auuSMfkY0FVaUS1dZkDkoVo1M=\n-----END PUBLIC KEY-----\n'
            ),
        },
      }),
    },
  };
});

const mockedFs = vi.mocked(fs);

const SAMPLE_PEM =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA5kr+/8mNiyCqjDmuS6auuSMfkY0FVaUS1dZkDkoVo1M=\n-----END PUBLIC KEY-----\n';
const SAMPLE_RAW_BASE64 = '5kr+/8mNiyCqjDmuS6auuSMfkY0FVaUS1dZkDkoVo1M=';

describe('keys command', () => {
  describe('keys list', () => {
    it('should show message when no trusted keys file', async () => {
      mockedFs.existsSync.mockReturnValue(false);
      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(program.parseAsync(['node', 'dossier', 'keys', 'list'])).rejects.toThrow();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No trusted keys file'));
    });

    it('should display trusted keys', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockReturnValue([] as any);
      mockedFs.readFileSync.mockReturnValue('abc123key team-key-2025\ndef456key other-key\n');
      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(program.parseAsync(['node', 'dossier', 'keys', 'list'])).rejects.toThrow();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('2 trusted key(s)'));
    });

    it('should list generated key pairs', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockReturnValue(['default.pem', 'default.pub', 'mykey.pem'] as any);
      mockedFs.readFileSync.mockReturnValue('abc123key team-key\n');
      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(program.parseAsync(['node', 'dossier', 'keys', 'list'])).rejects.toThrow();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Generated Key Pairs'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('2 key pair(s)'));
    });

    it('should output JSON with --json', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockReturnValue(['default.pem', 'default.pub'] as any);
      mockedFs.readFileSync.mockReturnValue('abc123key team-key\n');
      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'keys', 'list', '--json'])
      ).rejects.toThrow();

      const jsonCalls = vi
        .mocked(console.log)
        .mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('"trusted"'));
      expect(jsonCalls.length).toBeGreaterThan(0);
    });

    // The nastiest trust failure: an unterminated PEM block makes the parser
    // consume the rest of the file, so a file full of keys lists as empty. Left
    // unexplained, there is nothing connecting "not trusted" back to the file.
    it('should explain why a file full of keys lists as empty', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockReturnValue([] as any);
      mockedFs.readFileSync.mockReturnValue(
        '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\nabc123key team-key\n'
      );
      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(program.parseAsync(['node', 'dossier', 'keys', 'list'])).rejects.toThrow();

      const warnings = vi
        .mocked(console.warn)
        .mock.calls.map((c) => String(c[0]))
        .join('\n');
      expect(warnings).toContain('unusable trusted-key entry');
      expect(warnings).toContain('line 1');
      expect(warnings).toContain('trusted-keys.txt');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No trusted keys'));
    });

    it('should stay quiet about problems for a healthy file', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockReturnValue([] as any);
      mockedFs.readFileSync.mockReturnValue('abc123key team-key\n');
      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(program.parseAsync(['node', 'dossier', 'keys', 'list'])).rejects.toThrow();

      expect(console.warn).not.toHaveBeenCalled();
    });
  });

  describe('keys generate', () => {
    it('should generate a key pair', async () => {
      mockedFs.existsSync.mockReturnValue(false);

      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(program.parseAsync(['node', 'dossier', 'keys', 'generate'])).rejects.toThrow();

      expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(2);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Key pair generated'));
    });

    // The printed key is copy-pasted straight into `keys add`, so it has to be
    // the same canonical raw base64 the trust list stores.
    it('should print the public key as canonical raw base64', async () => {
      mockedFs.existsSync.mockReturnValue(false);

      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(program.parseAsync(['node', 'dossier', 'keys', 'generate'])).rejects.toThrow();

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining(`Public key (base64): ${SAMPLE_RAW_BASE64}`)
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining(`ai-dossier keys add ${SAMPLE_RAW_BASE64}`)
      );
    });

    it('should use custom name', async () => {
      mockedFs.existsSync.mockReturnValue(false);

      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'keys', 'generate', '--name', 'mykey'])
      ).rejects.toThrow();

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

      await expect(program.parseAsync(['node', 'dossier', 'keys', 'generate'])).rejects.toThrow();

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('already exist'));
    });

    it('should overwrite with --force', async () => {
      mockedFs.existsSync.mockImplementation(() => true);
      mockedFs.writeFileSync.mockClear();

      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'keys', 'generate', '--force'])
      ).rejects.toThrow();

      expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(2);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Key pair generated'));
    });
  });

  describe('keys add', () => {
    // vi.mock('node:fs') automocks persist call history across tests.
    beforeEach(() => {
      vi.mocked(fs.appendFileSync).mockClear();
      vi.mocked(fs.existsSync).mockReset();
      vi.mocked(fs.readFileSync).mockReset();
    });

    it('should add a new key', async () => {
      // First call (existsSync for dossierDir): true
      // Second call (existsSync for trustedKeysPath): false (new file)
      mockedFs.existsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);
      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'keys', 'add', SAMPLE_RAW_BASE64, 'my-key'])
      ).rejects.toThrow();

      expect(mockedFs.appendFileSync).toHaveBeenCalledWith(
        expect.any(String),
        `${SAMPLE_RAW_BASE64} my-key\n`,
        'utf8'
      );
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Key added'));
    });

    it('should detect duplicate key', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(`${SAMPLE_RAW_BASE64} team-key\n`);
      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'keys', 'add', SAMPLE_RAW_BASE64, 'my-key'])
      ).rejects.toThrow();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('already exists'));
    });

    // A PEM starts with `-`, so it must follow `--` for commander to treat it as
    // an argument rather than an unknown option.
    it('should store a PEM argument as canonical raw base64', async () => {
      mockedFs.existsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);
      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'keys', 'add', '--', SAMPLE_PEM, 'my-key'])
      ).rejects.toThrow();

      expect(mockedFs.appendFileSync).toHaveBeenCalledWith(
        expect.any(String),
        `${SAMPLE_RAW_BASE64} my-key\n`,
        'utf8'
      );
    });

    it('should treat a PEM key as a duplicate of its raw base64 form', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(`${SAMPLE_RAW_BASE64} team-key\n`);
      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'keys', 'add', '--', SAMPLE_PEM, 'my-key'])
      ).rejects.toThrow();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('already exists'));
      expect(mockedFs.appendFileSync).not.toHaveBeenCalled();
    });

    it('should treat a key already stored as a PEM block as a duplicate', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(`${SAMPLE_PEM} team-key\n`);
      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'keys', 'add', SAMPLE_RAW_BASE64, 'my-key'])
      ).rejects.toThrow();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('already exists'));
      expect(mockedFs.appendFileSync).not.toHaveBeenCalled();
    });

    it('should pass a minisign key through unchanged', async () => {
      mockedFs.existsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);
      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'keys', 'add', 'RWTKey1==', 'my-key'])
      ).rejects.toThrow();

      expect(mockedFs.appendFileSync).toHaveBeenCalledWith(
        expect.any(String),
        'RWTKey1== my-key\n',
        'utf8'
      );
    });

    it('should reject a key it cannot canonicalize instead of corrupting the file', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(
        program.parseAsync([
          'node',
          'dossier',
          'keys',
          'add',
          '--',
          '-----BEGIN PUBLIC KEY-----\nnot base64 at all\n-----END PUBLIC KEY-----',
          'my-key',
        ])
      ).rejects.toThrow();

      expect(mockedFs.appendFileSync).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Unrecognized public key format')
      );
    });

    // KMS-signed dossiers are verified against the key ARN, so the ARN is the
    // only thing that can make one trusted — it has to be addable.
    it('should accept an AWS KMS key ARN', async () => {
      const arn = 'arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab';
      mockedFs.existsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);
      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'keys', 'add', arn, 'aws-signer'])
      ).rejects.toThrow();

      expect(mockedFs.appendFileSync).toHaveBeenCalledWith(
        expect.any(String),
        `${arn} aws-signer\n`,
        'utf8'
      );
    });

    // The trust file is write-only in practice: nothing reads it back to the user
    // at add time, so anything accepted here that is not a key becomes a silent,
    // permanent "not trusted" on every later verify.
    const rejectedArguments: [string, string][] = [
      ['a path to a .pub file', '/home/me/.dossier/default.pub'],
      ['a bare filename', 'default.pub'],
      ['a truncated key', '5kr+/8mNiyCqjDmuS6au'],
      ['prose', 'notakey'],
    ];

    for (const [label, argument] of rejectedArguments) {
      it(`should refuse ${label} rather than storing it as a trusted key`, async () => {
        mockedFs.existsSync.mockReturnValue(true);
        const program = createTestProgram();
        registerKeysCommand(program);

        await expect(
          program.parseAsync(['node', 'dossier', 'keys', 'add', argument, 'my-key'])
        ).rejects.toThrow();

        expect(mockedFs.appendFileSync).not.toHaveBeenCalled();
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining('Unrecognized public key format')
        );
      });
    }

    it('should tell someone who passed a file path how to pass the key instead', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'keys', 'add', '~/.dossier/default.pub', 'my-key'])
      ).rejects.toThrow();

      const errors = vi
        .mocked(console.error)
        .mock.calls.map((c) => String(c[0]))
        .join('\n');
      // Must show the `--`, or the suggested command fails on the PEM's leading dash.
      expect(errors).toContain('ai-dossier keys add -- "$(cat ~/.dossier/default.pub)" "my-key"');
      expect(errors).toContain('looks like a file path');
    });

    it('should name the rejected value so the mistake is visible', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      const program = createTestProgram();
      registerKeysCommand(program);

      await expect(
        program.parseAsync(['node', 'dossier', 'keys', 'add', 'notakey', 'my-key'])
      ).rejects.toThrow();

      const errors = vi
        .mocked(console.error)
        .mock.calls.map((c) => String(c[0]))
        .join('\n');
      expect(errors).toContain('"notakey"');
      expect(errors).toContain('dossier keys generate');
      expect(errors).toContain('dossier verify');
    });
  });
});
