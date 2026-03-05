/**
 * Dossier Signature Verification
 *
 * This module provides signature verification for dossiers,
 * supporting multiple signature schemes (Ed25519 and AWS KMS).
 */

import { createPublicKey, verify } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KMSClient, SigningAlgorithmSpec, VerifyCommand } from '@aws-sdk/client-kms';
import type { SignatureResult, VerifyResult } from './signers';
import { getVerifierRegistry } from './signers';
import { sha256Hash } from './utils/crypto';
import { readFileIfExists } from './utils/fs';

/**
 * Load trusted keys from file
 * Default location: ~/.dossier/trusted-keys.txt
 * Format: <public-key> <key-id>
 */
export function loadTrustedKeys(filePath?: string): Map<string, string> {
  const keysPath = filePath || join(homedir(), '.dossier', 'trusted-keys.txt');
  const keys = new Map<string, string>();

  const content = readFileIfExists(keysPath);
  if (!content) {
    return keys;
  }

  try {
    for (const line of content.split('\n')) {
      const trimmed = line.trim();

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      // Parse: <public-key> <key-id>
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        const publicKey = parts[0];
        const keyId = parts.slice(1).join(' ');
        keys.set(publicKey, keyId);
      }
    }
  } catch (err) {
    console.error(`Warning: failed to parse trusted keys: ${(err as Error).message}`);
  }

  return keys;
}

/**
 * Verify signature using Ed25519
 * @param content - The content to verify
 * @param signature - Base64-encoded signature
 * @param publicKey - PEM-format Ed25519 public key
 */
export function verifyWithEd25519(
  content: string,
  signature: string,
  publicKey: string
): VerifyResult {
  try {
    const signatureBuffer = Buffer.from(signature, 'base64');
    const contentBuffer = Buffer.from(content, 'utf8');

    // Create public key object from PEM
    const publicKeyObject = createPublicKey({
      key: publicKey,
      format: 'pem',
      type: 'spki',
    });

    // Verify Ed25519 signature (algorithm is null for Ed25519)
    const valid = verify(null, contentBuffer, publicKeyObject, signatureBuffer);
    return { valid };
  } catch (err) {
    return { valid: false, error: (err as Error).message };
  }
}

/**
 * Verify signature using AWS KMS (ECDSA-SHA-256)
 */
export async function verifyWithKms(
  content: string,
  signature: string,
  keyId: string,
  region = 'us-east-1'
): Promise<VerifyResult> {
  const client = new KMSClient({ region });

  // Calculate SHA256 digest of content (must match signing process)
  const hash = sha256Hash(content);

  const signatureBuffer = Buffer.from(signature, 'base64');

  const command = new VerifyCommand({
    KeyId: keyId,
    Message: hash,
    MessageType: 'DIGEST',
    Signature: signatureBuffer,
    SigningAlgorithm: SigningAlgorithmSpec.ECDSA_SHA_256,
  });

  try {
    const response = await client.send(command);
    return { valid: response.SignatureValid === true };
  } catch (err) {
    return { valid: false, error: (err as Error).message };
  }
}

/**
 * Verify signature using the registry pattern
 * This is a convenience function that encapsulates registry lookup
 * @param content - The content to verify
 * @param signature - Signature result object containing algorithm and signature data
 * @returns Promise<boolean> - true if signature is valid, false otherwise
 */
export async function verifySignature(
  content: string,
  signature: SignatureResult
): Promise<VerifyResult> {
  const verifierRegistry = getVerifierRegistry();
  const verifier = verifierRegistry.get(signature.algorithm);
  return await verifier.verify(content, signature);
}
