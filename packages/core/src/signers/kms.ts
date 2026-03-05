/**
 * AWS KMS Signer and Verifier
 */

import {
  GetPublicKeyCommand,
  KMSClient,
  SignCommand,
  SigningAlgorithmSpec,
  VerifyCommand,
} from '@aws-sdk/client-kms';
import { sha256Hash } from '../utils/crypto';
import type { SignatureResult, Signer, Verifier, VerifyResult } from './index';

export class KmsSigner implements Signer {
  readonly algorithm = 'ECDSA-SHA-256';
  private client: KMSClient;

  constructor(
    private keyId: string,
    region: string = 'us-east-1'
  ) {
    this.client = new KMSClient({ region });
  }

  async sign(content: string): Promise<SignatureResult> {
    // Calculate SHA256 digest of content
    const hash = sha256Hash(content);

    // Sign the digest with KMS
    const signCommand = new SignCommand({
      KeyId: this.keyId,
      Message: hash,
      MessageType: 'DIGEST',
      SigningAlgorithm: SigningAlgorithmSpec.ECDSA_SHA_256,
    });

    const signResponse = await this.client.send(signCommand);
    if (!signResponse.Signature) {
      throw new Error('KMS signing failed: no signature returned');
    }

    const signature = Buffer.from(signResponse.Signature).toString('base64');

    // Get public key from KMS
    const pubKeyCommand = new GetPublicKeyCommand({
      KeyId: this.keyId,
    });

    const pubKeyResponse = await this.client.send(pubKeyCommand);
    if (!pubKeyResponse.PublicKey) {
      throw new Error('KMS failed to return public key');
    }

    const publicKey = Buffer.from(pubKeyResponse.PublicKey).toString('base64');
    const keyArn = pubKeyResponse.KeyId || this.keyId;

    return {
      algorithm: this.algorithm,
      signature,
      public_key: publicKey,
      key_id: keyArn,
      signed_at: new Date().toISOString(),
    };
  }

  async getPublicKey(): Promise<string> {
    const command = new GetPublicKeyCommand({
      KeyId: this.keyId,
    });

    const response = await this.client.send(command);
    if (!response.PublicKey) {
      throw new Error('KMS failed to return public key');
    }

    return Buffer.from(response.PublicKey).toString('base64');
  }
}

export class KmsVerifier implements Verifier {
  private clients: Map<string, KMSClient> = new Map();

  supports(algorithm: string): boolean {
    return algorithm === 'ECDSA-SHA-256';
  }

  async verify(content: string, signature: SignatureResult): Promise<VerifyResult> {
    if (!signature.key_id) {
      return { valid: false };
    }

    try {
      // Extract region from key ARN if available, otherwise use default
      const region = this.extractRegionFromArn(signature.key_id) || 'us-east-1';
      const client = this.getClient(region);

      // Calculate SHA256 digest to match what was signed
      const hash = sha256Hash(content);
      const signatureBuffer = Buffer.from(signature.signature, 'base64');

      const command = new VerifyCommand({
        KeyId: signature.key_id,
        Message: hash,
        MessageType: 'DIGEST',
        Signature: signatureBuffer,
        SigningAlgorithm: SigningAlgorithmSpec.ECDSA_SHA_256,
      });

      const response = await client.send(command);
      return { valid: response.SignatureValid === true };
    } catch (err) {
      return { valid: false, error: (err as Error).message };
    }
  }

  private getClient(region: string): KMSClient {
    const existing = this.clients.get(region);
    if (existing) {
      return existing;
    }
    const client = new KMSClient({ region });
    this.clients.set(region, client);
    return client;
  }

  private extractRegionFromArn(keyId: string): string | null {
    // ARN format: arn:aws:kms:REGION:ACCOUNT:key/KEY_ID
    const arnMatch = keyId.match(/^arn:aws:kms:([^:]+):/);
    return arnMatch ? arnMatch[1] : null;
  }
}
