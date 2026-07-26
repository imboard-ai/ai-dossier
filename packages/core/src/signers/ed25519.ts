/**
 * Ed25519 Signer and Verifier using Node.js crypto
 */

import type { KeyObject } from 'node:crypto';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { normalizePublicKey, toSpkiPem } from '../signing-payload';
import type { SignatureResult, Signer, Verifier, VerifyResult } from './index';

export class Ed25519Signer implements Signer {
  readonly algorithm = 'ed25519';
  private privateKey: KeyObject;
  private publicKeyBase64: string;

  constructor(privateKeyPath: string) {
    // Load private key from PEM file
    const privateKeyPem = readFileSync(privateKeyPath, 'utf8');
    this.privateKey = createPrivateKey({
      key: privateKeyPem,
      format: 'pem',
      type: 'pkcs8',
    });

    // Emit raw 32-byte base64 — the form `dossier keys add` prints, the trusted-key
    // list stores, and the published corpus carries. Signing emitted SPKI PEM between
    // 2025-11-18 and this change, which could never match a trusted-key entry.
    const publicKey = createPublicKey(this.privateKey);
    const publicKeyPem = publicKey.export({
      type: 'spki',
      format: 'pem',
    }) as string;
    this.publicKeyBase64 = normalizePublicKey(publicKeyPem);
  }

  async sign(content: string): Promise<SignatureResult> {
    const contentBuffer = Buffer.from(content, 'utf8');
    const signatureBuffer = sign(null, contentBuffer, this.privateKey);

    return {
      algorithm: this.algorithm,
      signature: signatureBuffer.toString('base64'),
      public_key: this.publicKeyBase64,
      signed_at: new Date().toISOString(),
    };
  }

  async getPublicKey(): Promise<string> {
    return this.publicKeyBase64;
  }
}

export class Ed25519Verifier implements Verifier {
  supports(algorithm: string): boolean {
    return algorithm === 'ed25519';
  }

  async verify(content: string, signature: SignatureResult): Promise<VerifyResult> {
    try {
      const signatureBuffer = Buffer.from(signature.signature, 'base64');
      const contentBuffer = Buffer.from(content, 'utf8');

      // Accept raw base64 or SPKI PEM — both are in circulation.
      const publicKeyObject = createPublicKey({
        key: toSpkiPem(signature.public_key),
        format: 'pem',
        type: 'spki',
      });

      // Verify Ed25519 signature
      const valid = verify(null, contentBuffer, publicKeyObject, signatureBuffer);
      return { valid };
    } catch (err) {
      return { valid: false, error: (err as Error).message };
    }
  }
}
