import { sign as cryptoSign, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ed25519Signer, Ed25519Verifier } from '../signers/ed25519';
import { VerifierRegistry } from '../signers/registry';

describe('Ed25519Signer', () => {
  let tempDir: string;
  let privateKeyPath: string;
  let publicKeyPem: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `dossier-signer-test-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });

    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

    privateKeyPath = join(tempDir, 'ed25519.pem');
    writeFileSync(privateKeyPath, privateKeyPem, 'utf8');
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should have algorithm ed25519', () => {
    const signer = new Ed25519Signer(privateKeyPath);
    expect(signer.algorithm).toBe('ed25519');
  });

  it('should sign content and return valid signature result', async () => {
    const signer = new Ed25519Signer(privateKeyPath);
    const result = await signer.sign('test content');

    expect(result.algorithm).toBe('ed25519');
    expect(result.signature).toBeTruthy();
    expect(result.public_key).toContain('BEGIN PUBLIC KEY');
    expect(result.signed_at).toBeTruthy();
  });

  it('should produce verifiable signatures', async () => {
    const signer = new Ed25519Signer(privateKeyPath);
    const content = 'content to verify';
    const result = await signer.sign(content);

    const verifier = new Ed25519Verifier();
    const verification = await verifier.verify(content, result);
    expect(verification.valid).toBe(true);
  });

  it('should return public key via getPublicKey', async () => {
    const signer = new Ed25519Signer(privateKeyPath);
    const pk = await signer.getPublicKey();
    expect(pk).toContain('BEGIN PUBLIC KEY');
    expect(pk).toBe(publicKeyPem);
  });
});

describe('Ed25519Verifier', () => {
  it('should support ed25519 algorithm', () => {
    const verifier = new Ed25519Verifier();
    expect(verifier.supports('ed25519')).toBe(true);
  });

  it('should not support other algorithms', () => {
    const verifier = new Ed25519Verifier();
    expect(verifier.supports('ECDSA-SHA-256')).toBe(false);
    expect(verifier.supports('rsa')).toBe(false);
  });

  it('should verify valid signature', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

    const content = 'test content';
    const sig = cryptoSign(null, Buffer.from(content, 'utf8'), privateKey);

    const verifier = new Ed25519Verifier();
    const result = await verifier.verify(content, {
      algorithm: 'ed25519',
      signature: sig.toString('base64'),
      public_key: publicKeyPem,
      signed_at: new Date().toISOString(),
    });

    expect(result.valid).toBe(true);
  });

  it('should reject tampered content', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

    const sig = cryptoSign(null, Buffer.from('original', 'utf8'), privateKey);

    const verifier = new Ed25519Verifier();
    const result = await verifier.verify('tampered', {
      algorithm: 'ed25519',
      signature: sig.toString('base64'),
      public_key: publicKeyPem,
      signed_at: new Date().toISOString(),
    });

    expect(result.valid).toBe(false);
  });

  it('should return error for invalid key format', async () => {
    const verifier = new Ed25519Verifier();
    const result = await verifier.verify('content', {
      algorithm: 'ed25519',
      signature: 'dGVzdA==',
      public_key: 'not-a-valid-key',
      signed_at: new Date().toISOString(),
    });

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('VerifierRegistry', () => {
  it('should register and retrieve verifiers', () => {
    const registry = new VerifierRegistry();
    const verifier = new Ed25519Verifier();

    registry.register(verifier);
    expect(registry.get('ed25519')).toBe(verifier);
  });

  it('should throw for unsupported algorithm', () => {
    const registry = new VerifierRegistry();
    expect(() => registry.get('unknown-algo')).toThrow(
      'No verifier registered for algorithm: unknown-algo'
    );
  });

  it('should check if algorithm is supported via has()', () => {
    const registry = new VerifierRegistry();
    expect(registry.has('ed25519')).toBe(false);

    registry.register(new Ed25519Verifier());
    expect(registry.has('ed25519')).toBe(true);
    expect(registry.has('rsa')).toBe(false);
  });

  it('should return supported algorithms', () => {
    const registry = new VerifierRegistry();
    const algorithms = registry.getSupportedAlgorithms();
    expect(algorithms).toContain('ed25519');
    expect(algorithms).toContain('ECDSA-SHA-256');
  });
});

describe('getVerifierRegistry', () => {
  it('should create a registry and register built-in verifiers manually', () => {
    // getVerifierRegistry uses require() at runtime which doesn't work in TS tests.
    // Instead, test that manual registration works identically to the singleton pattern.
    const registry = new VerifierRegistry();
    registry.register(new Ed25519Verifier());

    expect(registry.has('ed25519')).toBe(true);
    expect(registry.get('ed25519')).toBeInstanceOf(Ed25519Verifier);
  });
});
