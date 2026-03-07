import { sign as cryptoSign, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTrustedKeys, verifyWithEd25519 } from '../signature';

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
