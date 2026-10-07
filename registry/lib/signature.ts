import {
  buildVerificationPayload,
  getErrorMessage,
  type ParsedDossier,
  type SignatureCoverage,
  type SignatureResult,
  signatureCoverage,
  verifySignature,
} from '@ai-dossier/core';

/** The algorithm whose key material is an AWS KMS key ARN (see core's `KmsVerifier`). */
const KMS_ALGORITHM = 'ECDSA-SHA-256';

/**
 * Outcome of checking a submitted dossier's signature at publish time.
 *
 * - `unsigned`: no signature block — publishing unsigned dossiers stays allowed.
 * - `verified`: the signature matches the bytes it claims to cover.
 * - `not-checked`: structurally sound, but the registry cannot run the cryptographic
 *   check itself (AWS KMS needs credentials it does not hold); clients verify on install.
 * - `invalid`: refused — a tampered payload, an unknown `covers`, or a scheme that does
 *   not match the file's shape (e.g. a v2 signature carried onto a spec-shaped file).
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
    return {
      status: 'not-checked',
      covers,
      reason: 'AWS KMS signatures are verified by clients (`ai-dossier verify`), not the registry',
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
