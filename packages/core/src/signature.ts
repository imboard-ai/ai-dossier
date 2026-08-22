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
import { isSupportedPublicKey, normalizePublicKey, toSpkiPem } from './signing-payload';
import { sha256Hash } from './utils/crypto';
import { readFileIfExists } from './utils/fs';

/** One `<public-key> <key-id>` entry from a trusted-keys file, as written. */
export interface TrustedKeyEntry {
  publicKey: string;
  keyId: string;
}

/**
 * A line of a trusted-keys file that could not be read as an entry.
 *
 * Reported rather than silently dropped: a skipped entry means a key the user
 * believes is trusted is not, and the only downstream symptom is `dossier verify`
 * saying "not trusted" with nothing pointing back at the file.
 */
export interface TrustedKeyProblem {
  /** 1-based line number in the trusted-keys file. */
  line: number;
  message: string;
}

/** Whether a line reads as an entry in its own right. */
function looksLikeKeyEntry(line: string): boolean {
  const parts = line.trim().split(/\s+/);
  return parts.length >= 2 && isSupportedPublicKey(parts[0]);
}

/**
 * Split a trusted-keys file into `<public-key> <key-id>` pairs.
 *
 * One entry per line, except for PEM blocks: `dossier keys add` used to write its
 * argument verbatim, so passing a PEM appended four lines that a line-oriented
 * parse then shredded into entries matching nothing. Those blocks are rejoined so
 * an already written file works without hand-editing — this only reassembles what
 * the user wrote, it cannot widen a match.
 *
 * This is the single definition of what the trusted-key file format is: anything
 * that lists, counts, or matches trusted keys must go through it, so `keys list`
 * can never disagree with what verification actually trusts.
 *
 * Skipped lines come back alongside the entries rather than being dropped: every
 * skip is a key the user thinks is trusted and isn't, so callers that can show
 * the user something — `keys list`, and verification via `loadTrustedKeys` —
 * report them instead of failing mute.
 */
export function parseTrustedKeys(content: string): {
  entries: TrustedKeyEntry[];
  problems: TrustedKeyProblem[];
} {
  const entries: TrustedKeyEntry[] = [];
  const problems: TrustedKeyProblem[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line || line.startsWith('#')) {
      continue;
    }

    if (!line.startsWith('-----BEGIN')) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        entries.push({ publicKey: parts[0], keyId: parts.slice(1).join(' ') });
      } else {
        problems.push({
          line: i + 1,
          message: 'public key has no identifier — expected "<public-key> <identifier>"',
        });
      }
      continue;
    }

    const blockStart = i;
    const block: string[] = [line];
    while (i + 1 < lines.length && !block[block.length - 1].includes('-----END')) {
      i++;
      block.push(lines[i].trim());
    }

    // The identifier trails the END marker, or sits on the next line when the
    // PEM carried its own trailing newline.
    const endLine = block[block.length - 1];
    const endMarker = /-----END [^-]*-----/.exec(endLine);
    if (!endMarker) {
      // The scan above ran to end-of-file looking for the END marker, so every
      // later entry was swallowed with it. Say so explicitly: otherwise one
      // truncated paste revokes trust for the whole file with no visible cause.
      problems.push({
        line: blockStart + 1,
        message:
          'public key block has no "-----END" marker — this block and every entry after it were ignored',
      });
      continue;
    }
    let keyId = endLine.slice(endMarker.index + endMarker[0].length).trim();
    // Drop the identifier back off the END line, so the reassembled block is a
    // bare PEM. Key parsing requires one block and nothing around it — trailing
    // text would make this key unreadable and therefore untrusted.
    block[block.length - 1] = endLine.slice(0, endMarker.index + endMarker[0].length);
    // Only adopt the next line as the identifier when it is not plainly an entry
    // of its own, or a bare PEM block would swallow the key that follows it.
    if (!keyId && i + 1 < lines.length && !looksLikeKeyEntry(lines[i + 1])) {
      i++;
      keyId = lines[i].trim();
    }

    if (keyId) {
      entries.push({ publicKey: block.join('\n'), keyId });
    } else {
      problems.push({
        line: blockStart + 1,
        message: 'public key block has no identifier after the "-----END" marker — entry ignored',
      });
    }
  }

  return { entries, problems };
}

/** Cap on printed problems, so a mangled file cannot flood every verify run. */
const MAX_REPORTED_TRUSTED_KEY_PROBLEMS = 3;

/**
 * Print unusable trusted-key entries to stderr, bounded.
 *
 * `loadTrustedKeys` runs on every `dossier verify`, so this stays silent unless
 * the file is genuinely malformed — and a malformed trust file is precisely when
 * the user needs to hear about it.
 */
export function reportTrustedKeyProblems(problems: TrustedKeyProblem[], source?: string): void {
  if (problems.length === 0) {
    return;
  }

  const where = source ? ` in ${source}` : '';
  console.warn(`Warning: ${problems.length} unusable trusted-key entry(s)${where}:`);
  for (const problem of problems.slice(0, MAX_REPORTED_TRUSTED_KEY_PROBLEMS)) {
    console.warn(`  line ${problem.line}: ${problem.message}`);
  }
  if (problems.length > MAX_REPORTED_TRUSTED_KEY_PROBLEMS) {
    console.warn(`  ...and ${problems.length - MAX_REPORTED_TRUSTED_KEY_PROBLEMS} more`);
  }
  console.warn(
    '  Those keys are NOT trusted. Re-add each with: ai-dossier keys add <public-key> <identifier>'
  );
}

/**
 * Build the trusted-key map from the contents of a trusted-keys file.
 *
 * Keys are indexed under both the form they were written in and their normalized
 * form, so a key registered in one encoding still matches a signature that
 * carries another.
 *
 * @param source - Path named in warnings about unusable entries. Omit to stay silent.
 */
export function trustedKeysFromContent(content: string, source?: string): Map<string, string> {
  const keys = new Map<string, string>();
  const { entries, problems } = parseTrustedKeys(content);

  for (const { publicKey, keyId } of entries) {
    keys.set(publicKey, keyId);

    const normalized = normalizePublicKey(publicKey);
    if (normalized !== publicKey) {
      keys.set(normalized, keyId);
    }
  }

  if (source) {
    reportTrustedKeyProblems(problems, source);
  }

  return keys;
}

/**
 * Load trusted keys from file
 * Default location: ~/.dossier/trusted-keys.txt
 * Format: <public-key> <key-id>
 */
export function loadTrustedKeys(filePath?: string): Map<string, string> {
  const keysPath = filePath || join(homedir(), '.dossier', 'trusted-keys.txt');
  const content = readFileIfExists(keysPath);
  // Pass the path so unusable entries name the file the user has to fix.
  return content ? trustedKeysFromContent(content, keysPath) : new Map();
}

/** The algorithm `KmsVerifier` claims, whose key material is the KMS key ARN. */
const KMS_ALGORITHM = 'ECDSA-SHA-256';

function isKmsAlgorithm(algorithm: string | undefined): boolean {
  return algorithm === KMS_ALGORITHM;
}

/**
 * Whether a string identifies an AWS KMS key, and so is a usable trust-list entry
 * for a KMS-signed dossier.
 */
export function isKmsKeyIdentifier(value: string): boolean {
  return /^arn:aws[a-z-]*:kms:/.test(value.trim());
}

/**
 * Resolve the identifier a signature is trusted under, or `undefined` if none of
 * its key forms appear in the trust list.
 *
 * The signature and the trust list need not agree on encoding, so every form the
 * *verifying* key carries is tried: the public key as written and normalized to
 * raw base64. Every trust decision goes through here so "is it trusted" and "who
 * is it" can never drift apart.
 *
 * Only the key material the verifier actually used is eligible, which is decided
 * by the algorithm, not by which fields happen to be populated. `KmsVerifier`
 * verifies against `key_id` and ignores `public_key` — which KMS signatures carry
 * anyway — so for KMS only `key_id` can confer trust. Everything else verifies
 * against `public_key`, so only that may.
 *
 * Letting a field the verifier ignored confer trust would hand it out for free:
 * the trust list is keyed by public key and public keys are public, so an Ed25519
 * dossier carrying `key_id: "<any trusted public key>"` would be trusted as that
 * signer while verifying under an attacker's `public_key`.
 */
export function findTrustedIdentifier(
  trustedKeys: Map<string, string>,
  signature: { algorithm?: string; key_id?: string; public_key?: string }
): string | undefined {
  const candidates = isKmsAlgorithm(signature.algorithm)
    ? [signature.key_id]
    : signature.public_key
      ? [signature.public_key, normalizePublicKey(signature.public_key)]
      : [];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const identifier = trustedKeys.get(candidate);
    if (identifier !== undefined) {
      return identifier;
    }
  }

  return undefined;
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

    // Accept raw base64 or SPKI PEM — both are in circulation.
    const publicKeyObject = createPublicKey({
      key: toSpkiPem(publicKey),
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
