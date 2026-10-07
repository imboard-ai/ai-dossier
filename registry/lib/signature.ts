import {
  buildVerificationPayload,
  getErrorMessage,
  isKmsKeyIdentifier,
  type ParsedDossier,
  type SignatureCoverage,
  type SignatureResult,
  signatureCoverage,
  verifySignature,
} from '@ai-dossier/core';

/** The algorithm whose key material is an AWS KMS key ARN (see core's `KmsVerifier`). */
const KMS_ALGORITHM = 'ECDSA-SHA-256';

function isBase64(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.from(value, 'base64').toString('base64') === value
  );
}

/**
 * Outcome of checking a submitted dossier's signature at publish time.
 *
 * - `unsigned`: no signature block — publishing unsigned dossiers stays allowed.
 * - `verified`: the signature matches the bytes it claims to cover.
 * - `not-checked`: structurally sound (scheme, shape, key ARN, base64 value), but the
 *   registry cannot run the cryptographic check itself (AWS KMS needs credentials it
 *   does not hold); clients verify on install.
 * - `invalid`: refused — a tampered payload, an unknown `covers`, a scheme that does not
 *   match the file's shape (e.g. a v2 signature carried onto a spec-shaped file), an
 *   algorithm no verifier supports, or a legacy minisign key nothing can verify any more.
 */
export type PublishSignatureCheck =
  | { status: 'unsigned' }
  | { status: 'verified'; covers: SignatureCoverage }
  | { status: 'not-checked'; covers: SignatureCoverage; reason: string }
  | { status: 'invalid'; reason: string };

/**
 * Check the signature of a parsed submission before it is stored.
 *
 * Verifies through core's `buildVerificationPayload`, which picks v1/v2/v3 from
 * `signature.covers` and binds each scheme to the shape it was defined for — a v3
 * signature covers the on-disk spec frontmatter (`rawFrontmatter`), never the logical
 * view. Every failure, including ones core reports by throwing, comes back as
 * `invalid` so the caller can answer 400 instead of 500.
 */
export async function checkPublishSignature(
  parsed: Pick<ParsedDossier, 'frontmatter' | 'body' | 'rawFrontmatter' | 'shape'>
): Promise<PublishSignatureCheck> {
  const signature = parsed.frontmatter.signature;
  if (!signature) {
    return { status: 'unsigned' };
  }

  let covers: SignatureCoverage;
  let payload: string;
  try {
    covers = signatureCoverage(signature);
    payload = buildVerificationPayload(parsed);
  } catch (err) {
    return { status: 'invalid', reason: getErrorMessage(err) };
  }

  if (signature.algorithm === KMS_ALGORITHM) {
    // Without credentials the cryptographic check is out of reach, but a block that
    // could never verify anywhere is still refused, so relabelling a bad signature as
    // KMS is not a way around the check above.
    if (typeof signature.key_id !== 'string' || !isKmsKeyIdentifier(signature.key_id)) {
      return { status: 'invalid', reason: 'AWS KMS signature has no KMS key ARN in key_id' };
    }
    if (!isBase64(signature.signature)) {
      return { status: 'invalid', reason: 'AWS KMS signature value is not base64' };
    }
    return {
      status: 'not-checked',
      covers,
      reason: 'AWS KMS signatures are verified by clients (`ai-dossier verify`), not the registry',
    };
  }

  if (typeof signature.public_key === 'string' && signature.public_key.trim().startsWith('RWT')) {
    return {
      status: 'invalid',
      reason:
        'minisign public keys are no longer verifiable; re-sign the dossier with `ai-dossier sign`',
    };
  }

  try {
    const result = await verifySignature(payload, signature as SignatureResult);
    if (result.valid) {
      return { status: 'verified', covers };
    }
    return {
      status: 'invalid',
      reason: result.error
        ? `Verification error: ${result.error}`
        : `Signature does not match the ${covers} payload`,
    };
  } catch (err) {
    return { status: 'invalid', reason: getErrorMessage(err) };
  }
}
