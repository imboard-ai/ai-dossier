import { sign as cryptoSign, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  loadTrustedKeys,
  parseTrustedKeys,
  reportTrustedKeyProblems,
  verifyWithEd25519,
} from '../signature';

describe('loadTrustedKeys', () => {
  const createTempDir = () => {
    const dir = join(tmpdir(), `dossier-test-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  const cleanup = (path: string) => {
    if (existsSync(path)) {
      rmSync(path, { recursive: true, force: true });
    }
  };

  // Both encodings of one real key. The raw form is sliced off the SPKI DER here
  // rather than borrowed from normalizePublicKey, so these tests stay an
  // independent check on the code under test.
  const ed25519PublicKey = (): { pem: string; rawBase64: string } => {
    const { publicKey } = generateKeyPairSync('ed25519');
    return {
      pem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
      rawBase64: publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64'),
    };
  };

  it('should load trusted keys from file', () => {
    const tempDir = createTempDir();
    const keysFile = join(tempDir, 'trusted-keys.txt');

    writeFileSync(
      keysFile,
      `RWTKey1== official-key-1
RWTKey2== official-key-2`,
      'utf8'
    );

    const keys = loadTrustedKeys(keysFile);

    expect(keys.size).toBe(2);
    expect(keys.get('RWTKey1==')).toBe('official-key-1');
    expect(keys.get('RWTKey2==')).toBe('official-key-2');

    cleanup(tempDir);
  });

  it('should skip empty lines', () => {
    const tempDir = createTempDir();
    const keysFile = join(tempDir, 'trusted-keys.txt');

    writeFileSync(
      keysFile,
      `RWTKey1== key-1

RWTKey2== key-2

`,
      'utf8'
    );

    const keys = loadTrustedKeys(keysFile);

    expect(keys.size).toBe(2);
    expect(keys.get('RWTKey1==')).toBe('key-1');
    expect(keys.get('RWTKey2==')).toBe('key-2');

    cleanup(tempDir);
  });

  it('should skip comment lines starting with #', () => {
    const tempDir = createTempDir();
    const keysFile = join(tempDir, 'trusted-keys.txt');

    writeFileSync(
      keysFile,
      `# This is a comment
RWTKey1== key-1
# Another comment
RWTKey2== key-2`,
      'utf8'
    );

    const keys = loadTrustedKeys(keysFile);

    expect(keys.size).toBe(2);
    expect(keys.get('RWTKey1==')).toBe('key-1');

    cleanup(tempDir);
  });

  it('should handle key IDs with spaces', () => {
    const tempDir = createTempDir();
    const keysFile = join(tempDir, 'trusted-keys.txt');

    writeFileSync(
      keysFile,
      `RWTKey1== Official Key Name
RWTKey2== Another Key With Spaces`,
      'utf8'
    );

    const keys = loadTrustedKeys(keysFile);

    expect(keys.size).toBe(2);
    expect(keys.get('RWTKey1==')).toBe('Official Key Name');
    expect(keys.get('RWTKey2==')).toBe('Another Key With Spaces');

    cleanup(tempDir);
  });

  it('should index a raw base64 key under its own form', () => {
    const tempDir = createTempDir();
    const keysFile = join(tempDir, 'trusted-keys.txt');
    const { rawBase64 } = ed25519PublicKey();

    writeFileSync(keysFile, `${rawBase64} team-key\n`, 'utf8');

    const keys = loadTrustedKeys(keysFile);

    expect(keys.get(rawBase64)).toBe('team-key');

    cleanup(tempDir);
  });

  it('should recover a multi-line PEM block written by older `keys add`', () => {
    const tempDir = createTempDir();
    const keysFile = join(tempDir, 'trusted-keys.txt');
    const { pem, rawBase64 } = ed25519PublicKey();

    // Exactly what `keys add "<pem>" "<id>"` used to append: the PEM verbatim,
    // so the identifier lands on its own line after the trailing newline.
    writeFileSync(keysFile, `${pem} team-key\n`, 'utf8');

    const keys = loadTrustedKeys(keysFile);

    expect(keys.get(rawBase64)).toBe('team-key');

    cleanup(tempDir);
  });

  it('should recover a PEM block whose identifier trails the END marker', () => {
    const tempDir = createTempDir();
    const keysFile = join(tempDir, 'trusted-keys.txt');
    const { pem, rawBase64 } = ed25519PublicKey();

    writeFileSync(keysFile, `${pem.trimEnd()} team-key\n`, 'utf8');

    const keys = loadTrustedKeys(keysFile);

    expect(keys.get(rawBase64)).toBe('team-key');

    cleanup(tempDir);
  });

  it('should keep parsing entries that follow a PEM block', () => {
    const tempDir = createTempDir();
    const keysFile = join(tempDir, 'trusted-keys.txt');
    const { pem } = ed25519PublicKey();

    writeFileSync(keysFile, `${pem} pem-key\nRWTKey1== raw-key\n`, 'utf8');

    const keys = loadTrustedKeys(keysFile);

    expect(keys.get('RWTKey1==')).toBe('raw-key');

    cleanup(tempDir);
  });

  it('should trust nothing from an unterminated PEM block', () => {
    const tempDir = createTempDir();
    const keysFile = join(tempDir, 'trusted-keys.txt');

    writeFileSync(keysFile, '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n', 'utf8');

    const keys = loadTrustedKeys(keysFile);

    expect(keys.size).toBe(0);

    cleanup(tempDir);
  });

  it('should ignore a PEM block with no identifier', () => {
    const tempDir = createTempDir();
    const keysFile = join(tempDir, 'trusted-keys.txt');
    const { pem } = ed25519PublicKey();

    writeFileSync(keysFile, pem, 'utf8');

    const keys = loadTrustedKeys(keysFile);

    expect(keys.size).toBe(0);

    cleanup(tempDir);
  });

  it('should handle missing file gracefully', () => {
    const nonExistentPath = '/tmp/nonexistent-dossier-keys-12345.txt';

    const keys = loadTrustedKeys(nonExistentPath);

    expect(keys.size).toBe(0);
  });

  it('should return empty map for empty file', () => {
    const tempDir = createTempDir();
    const keysFile = join(tempDir, 'trusted-keys.txt');

    writeFileSync(keysFile, '', 'utf8');

    const keys = loadTrustedKeys(keysFile);

    expect(keys.size).toBe(0);

    cleanup(tempDir);
  });

  it('should return empty map for file with only comments', () => {
    const tempDir = createTempDir();
    const keysFile = join(tempDir, 'trusted-keys.txt');

    writeFileSync(
      keysFile,
      `# Comment 1
# Comment 2
# Comment 3`,
      'utf8'
    );

    const keys = loadTrustedKeys(keysFile);

    expect(keys.size).toBe(0);

    cleanup(tempDir);
  });

  it('should skip lines with only whitespace', () => {
    const tempDir = createTempDir();
    const keysFile = join(tempDir, 'trusted-keys.txt');

    writeFileSync(
      keysFile,
      `RWTKey1== key-1


RWTKey2== key-2`,
      'utf8'
    );

    const keys = loadTrustedKeys(keysFile);

    expect(keys.size).toBe(2);

    cleanup(tempDir);
  });

  it('should handle malformed lines gracefully', () => {
    const tempDir = createTempDir();
    const keysFile = join(tempDir, 'trusted-keys.txt');

    // Lines without space delimiter should be skipped
    writeFileSync(
      keysFile,
      `RWTKey1== key-1
InvalidLineWithoutSpace
RWTKey2== key-2`,
      'utf8'
    );

    const keys = loadTrustedKeys(keysFile);

    // Should only load valid lines
    expect(keys.size).toBe(2);
    expect(keys.get('RWTKey1==')).toBe('key-1');
    expect(keys.get('RWTKey2==')).toBe('key-2');

    cleanup(tempDir);
  });

  it('should trim whitespace from keys and IDs', () => {
    const tempDir = createTempDir();
    const keysFile = join(tempDir, 'trusted-keys.txt');

    writeFileSync(
      keysFile,
      `  RWTKey1==   key-1
	RWTKey2==	key-2	`,
      'utf8'
    );

    const keys = loadTrustedKeys(keysFile);

    expect(keys.size).toBe(2);
    expect(keys.get('RWTKey1==')).toBe('key-1');
    expect(keys.get('RWTKey2==')).toBe('key-2');

    cleanup(tempDir);
  });

  it('should handle multiple keys correctly', () => {
    const tempDir = createTempDir();
    const keysFile = join(tempDir, 'trusted-keys.txt');

    const manyKeys = Array.from({ length: 100 }, (_, i) => `RWTKey${i}== key-${i}`).join('\n');

    writeFileSync(keysFile, manyKeys, 'utf8');

    const keys = loadTrustedKeys(keysFile);

    expect(keys.size).toBe(100);
    expect(keys.get('RWTKey0==')).toBe('key-0');
    expect(keys.get('RWTKey99==')).toBe('key-99');

    cleanup(tempDir);
  });
});

describe('verifyWithEd25519', () => {
  it('should verify valid Ed25519 signature', () => {
    // Generate a test keypair
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');

    // Export keys in PEM format
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

    // Sign some content
    const content = 'This is test content for Ed25519 signature verification';
    const contentBuffer = Buffer.from(content, 'utf8');
    const signatureBuffer = cryptoSign(null, contentBuffer, privateKey);
    const signatureBase64 = signatureBuffer.toString('base64');

    // Verify signature
    const result = verifyWithEd25519(content, signatureBase64, publicKeyPem);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should reject tampered content', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

    const originalContent = 'Original content';
    const tamperedContent = 'Tampered content';

    const signatureBuffer = cryptoSign(null, Buffer.from(originalContent, 'utf8'), privateKey);
    const signatureBase64 = signatureBuffer.toString('base64');

    const result = verifyWithEd25519(tamperedContent, signatureBase64, publicKeyPem);

    expect(result.valid).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('should reject wrong public key', () => {
    const { privateKey: privateKey1 } = generateKeyPairSync('ed25519');
    const { publicKey: publicKey2 } = generateKeyPairSync('ed25519');

    const publicKeyPem2 = publicKey2.export({ type: 'spki', format: 'pem' }) as string;

    const content = 'Test content';
    const signatureBuffer = cryptoSign(null, Buffer.from(content, 'utf8'), privateKey1);
    const signatureBase64 = signatureBuffer.toString('base64');

    const result = verifyWithEd25519(content, signatureBase64, publicKeyPem2);

    expect(result.valid).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('should return error for invalid PEM format', () => {
    const content = 'Test content';
    const signature = 'dGVzdA==';
    const invalidPem = 'not-a-valid-pem';

    const result = verifyWithEd25519(content, signature, invalidPem);

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should return false for invalid signature base64', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

    const result = verifyWithEd25519('content', 'invalid!!!base64', publicKeyPem);

    // Buffer.from silently ignores invalid base64 chars, so crypto.verify
    // just returns false (wrong signature bytes) rather than throwing
    expect(result.valid).toBe(false);
  });

  it('should work with multiline content', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

    const content = `Line 1
Line 2
Line 3
With special chars: 你好 🎉`;

    const signatureBuffer = cryptoSign(null, Buffer.from(content, 'utf8'), privateKey);
    const signatureBase64 = signatureBuffer.toString('base64');

    const result = verifyWithEd25519(content, signatureBase64, publicKeyPem);

    expect(result.valid).toBe(true);
  });

  it('should detect whitespace changes', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

    const originalContent = 'Content without trailing newline';
    const modifiedContent = 'Content without trailing newline\n';

    const signatureBuffer = cryptoSign(null, Buffer.from(originalContent, 'utf8'), privateKey);
    const signatureBase64 = signatureBuffer.toString('base64');

    const result = verifyWithEd25519(modifiedContent, signatureBase64, publicKeyPem);

    expect(result.valid).toBe(false);
    expect(result.error).toBeUndefined();
  });
});

describe('verifyWithKms', () => {
  // Full KMS signer/verifier tests with mocked AWS SDK are in kms.test.ts
  it.skip('requires mocked AWS SDK — see kms.test.ts for comprehensive tests', () => {});
});

describe('parseTrustedKeys problem reporting', () => {
  // A skipped entry is a key the user believes is trusted and is not. The only
  // downstream symptom is `dossier verify` saying "not trusted", so the skip has
  // to be reportable back at the file that caused it.
  const ed25519Pem = (): string => {
    const { publicKey } = generateKeyPairSync('ed25519');
    return publicKey.export({ type: 'spki', format: 'pem' }) as string;
  };

  it('reports nothing for a well-formed file', () => {
    const { problems } = parseTrustedKeys(
      '# a comment\n\nRWTKey1== official-key\nRWTKey2== other key\n'
    );

    expect(problems).toEqual([]);
  });

  it('reports an entry that has a key but no identifier', () => {
    const { entries, problems } = parseTrustedKeys('RWTKey1==\nRWTKey2== other-key\n');

    expect(entries).toHaveLength(1);
    expect(problems).toHaveLength(1);
    expect(problems[0].line).toBe(1);
    expect(problems[0].message).toContain('no identifier');
  });

  it('reports a PEM block with no identifier', () => {
    const { entries, problems } = parseTrustedKeys(ed25519Pem());

    expect(entries).toHaveLength(0);
    expect(problems).toHaveLength(1);
    expect(problems[0].line).toBe(1);
    expect(problems[0].message).toContain('no identifier');
  });

  it('reports that an unterminated PEM block also swallowed every later entry', () => {
    const { entries, problems } = parseTrustedKeys(
      'RWTKey1== first-key\n-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\nRWTKey2== lost-key\n'
    );

    // The scan for the END marker consumes the rest of the file, so `lost-key`
    // is gone. That must not be silent.
    expect(entries).toHaveLength(1);
    expect(entries[0].keyId).toBe('first-key');
    expect(problems).toHaveLength(1);
    expect(problems[0].line).toBe(2);
    expect(problems[0].message).toContain('-----END');
    expect(problems[0].message).toContain('every entry after it');
  });

  it('does not let an identifier-less PEM block swallow the next entry', () => {
    const { entries, problems } = parseTrustedKeys(
      `${ed25519Pem().trimEnd()}\nRWTKey1== keep-me\n`
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].publicKey).toBe('RWTKey1==');
    expect(entries[0].keyId).toBe('keep-me');
    expect(problems).toHaveLength(1);
  });

  it('stays silent on well-formed files loaded from disk', () => {
    const dir = mkdirSync(join(tmpdir(), `dossier-quiet-${Date.now()}-${Math.random()}`), {
      recursive: true,
    }) as string;
    const keysFile = join(dir, 'trusted-keys.txt');
    writeFileSync(keysFile, 'RWTKey1== official-key\n', 'utf8');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadTrustedKeys(keysFile);

    // loadTrustedKeys runs on every verify — it must not warn about healthy files.
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('warns, naming the file, when a loaded file has unusable entries', () => {
    const dir = mkdirSync(join(tmpdir(), `dossier-noisy-${Date.now()}-${Math.random()}`), {
      recursive: true,
    }) as string;
    const keysFile = join(dir, 'trusted-keys.txt');
    writeFileSync(keysFile, '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n', 'utf8');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadTrustedKeys(keysFile);

    const output = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain(keysFile);
    expect(output).toContain('NOT trusted');

    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('caps how much it prints so a mangled file cannot flood a verify run', () => {
    const problems = Array.from({ length: 12 }, (_, i) => ({ line: i + 1, message: 'broken' }));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reportTrustedKeyProblems(problems, '/tmp/trusted-keys.txt');

    const output = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('12 unusable');
    expect(output).toContain('...and 9 more');
    expect(warn.mock.calls.length).toBeLessThan(8);

    warn.mockRestore();
  });
});
