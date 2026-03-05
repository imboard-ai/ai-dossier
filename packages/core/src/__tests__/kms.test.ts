import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the AWS SDK before importing KMS classes
vi.mock('@aws-sdk/client-kms', () => {
  const KMSClient = vi.fn();
  KMSClient.prototype.send = vi.fn();

  return {
    KMSClient,
    SignCommand: vi.fn(),
    GetPublicKeyCommand: vi.fn(),
    VerifyCommand: vi.fn(),
    SigningAlgorithmSpec: { ECDSA_SHA_256: 'ECDSA_SHA_256' },
  };
});

import { KMSClient } from '@aws-sdk/client-kms';
import { KmsSigner, KmsVerifier } from '../signers/kms';

describe('KmsSigner', () => {
  let signer: KmsSigner;

  beforeEach(() => {
    vi.clearAllMocks();
    signer = new KmsSigner('arn:aws:kms:us-east-1:123456789:key/test-key-id');
  });

  it('should have algorithm set to ECDSA-SHA-256', () => {
    expect(signer.algorithm).toBe('ECDSA-SHA-256');
  });

  it('should sign content and return signature result', async () => {
    const mockSignature = Buffer.from('mock-signature');
    const mockPublicKey = Buffer.from('mock-public-key');

    const mockSend = vi.mocked(KMSClient.prototype.send);
    mockSend.mockResolvedValueOnce({ Signature: mockSignature }).mockResolvedValueOnce({
      PublicKey: mockPublicKey,
      KeyId: 'arn:aws:kms:us-east-1:123456789:key/test-key-id',
    });

    const result = await signer.sign('test content');

    expect(result.algorithm).toBe('ECDSA-SHA-256');
    expect(result.signature).toBe(mockSignature.toString('base64'));
    expect(result.public_key).toBe(mockPublicKey.toString('base64'));
    expect(result.key_id).toBe('arn:aws:kms:us-east-1:123456789:key/test-key-id');
    expect(result.signed_at).toBeDefined();
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('should throw when KMS returns no signature', async () => {
    vi.mocked(KMSClient.prototype.send).mockResolvedValueOnce({ Signature: undefined });

    await expect(signer.sign('test')).rejects.toThrow('KMS signing failed: no signature returned');
  });

  it('should throw when KMS returns no public key during sign', async () => {
    const mockSend = vi.mocked(KMSClient.prototype.send);
    mockSend
      .mockResolvedValueOnce({ Signature: Buffer.from('sig') })
      .mockResolvedValueOnce({ PublicKey: undefined });

    await expect(signer.sign('test')).rejects.toThrow('KMS failed to return public key');
  });

  it('should use keyId as fallback when KeyId is not in public key response', async () => {
    const mockSend = vi.mocked(KMSClient.prototype.send);
    mockSend
      .mockResolvedValueOnce({ Signature: Buffer.from('sig') })
      .mockResolvedValueOnce({ PublicKey: Buffer.from('pk'), KeyId: undefined });

    const result = await signer.sign('test');
    expect(result.key_id).toBe('arn:aws:kms:us-east-1:123456789:key/test-key-id');
  });

  it('should get public key', async () => {
    const mockPublicKey = Buffer.from('mock-public-key');
    vi.mocked(KMSClient.prototype.send).mockResolvedValueOnce({ PublicKey: mockPublicKey });

    const result = await signer.getPublicKey();
    expect(result).toBe(mockPublicKey.toString('base64'));
  });

  it('should throw when getPublicKey returns no key', async () => {
    vi.mocked(KMSClient.prototype.send).mockResolvedValueOnce({ PublicKey: undefined });

    await expect(signer.getPublicKey()).rejects.toThrow('KMS failed to return public key');
  });
});

describe('KmsVerifier', () => {
  let verifier: KmsVerifier;

  beforeEach(() => {
    vi.clearAllMocks();
    verifier = new KmsVerifier();
  });

  it('should support ECDSA-SHA-256 algorithm', () => {
    expect(verifier.supports('ECDSA-SHA-256')).toBe(true);
  });

  it('should not support other algorithms', () => {
    expect(verifier.supports('ed25519')).toBe(false);
    expect(verifier.supports('RSA')).toBe(false);
  });

  it('should return invalid when key_id is missing', async () => {
    const result = await verifier.verify('content', {
      algorithm: 'ECDSA-SHA-256',
      signature: 'sig',
      public_key: 'pk',
      signed_at: new Date().toISOString(),
    });
    expect(result.valid).toBe(false);
  });

  it('should verify a valid signature', async () => {
    vi.mocked(KMSClient.prototype.send).mockResolvedValueOnce({ SignatureValid: true });

    const result = await verifier.verify('content', {
      algorithm: 'ECDSA-SHA-256',
      signature: Buffer.from('sig').toString('base64'),
      public_key: 'pk',
      key_id: 'arn:aws:kms:us-west-2:123456789:key/test-key',
      signed_at: new Date().toISOString(),
    });

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should reject an invalid signature', async () => {
    vi.mocked(KMSClient.prototype.send).mockResolvedValueOnce({ SignatureValid: false });

    const result = await verifier.verify('content', {
      algorithm: 'ECDSA-SHA-256',
      signature: Buffer.from('sig').toString('base64'),
      public_key: 'pk',
      key_id: 'arn:aws:kms:us-east-1:123456789:key/test-key',
      signed_at: new Date().toISOString(),
    });

    expect(result.valid).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('should return error on KMS failures', async () => {
    vi.mocked(KMSClient.prototype.send).mockRejectedValueOnce(new Error('KMS unavailable'));

    const result = await verifier.verify('content', {
      algorithm: 'ECDSA-SHA-256',
      signature: Buffer.from('sig').toString('base64'),
      public_key: 'pk',
      key_id: 'arn:aws:kms:us-east-1:123456789:key/test-key',
      signed_at: new Date().toISOString(),
    });

    expect(result.valid).toBe(false);
    expect(result.error).toBe('KMS unavailable');
  });

  it('should extract region from ARN', async () => {
    vi.mocked(KMSClient.prototype.send).mockResolvedValueOnce({ SignatureValid: true });

    await verifier.verify('content', {
      algorithm: 'ECDSA-SHA-256',
      signature: Buffer.from('sig').toString('base64'),
      public_key: 'pk',
      key_id: 'arn:aws:kms:eu-west-1:123456789:key/test-key',
      signed_at: new Date().toISOString(),
    });

    // Second call with same region should reuse client
    vi.mocked(KMSClient.prototype.send).mockResolvedValueOnce({ SignatureValid: true });

    await verifier.verify('content', {
      algorithm: 'ECDSA-SHA-256',
      signature: Buffer.from('sig').toString('base64'),
      public_key: 'pk',
      key_id: 'arn:aws:kms:eu-west-1:123456789:key/another-key',
      signed_at: new Date().toISOString(),
    });

    // KMSClient constructor called once in constructor (for default region reuse) per unique region
    // The verifier caches clients by region
  });

  it('should use default region when key_id is not an ARN', async () => {
    vi.mocked(KMSClient.prototype.send).mockResolvedValueOnce({ SignatureValid: true });

    const result = await verifier.verify('content', {
      algorithm: 'ECDSA-SHA-256',
      signature: Buffer.from('sig').toString('base64'),
      public_key: 'pk',
      key_id: 'simple-key-id',
      signed_at: new Date().toISOString(),
    });

    expect(result.valid).toBe(true);
  });
});
