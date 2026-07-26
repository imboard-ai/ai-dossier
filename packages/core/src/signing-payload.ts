/**
 * Canonical signing payload and Ed25519 public-key normalization.
 *
 * Two concerns live here because they share one goal: making a signature mean
 * what people assume it means.
 *
 * 1. Key format. Ed25519 public keys circulate in three shapes in this project's
 *    history — minisign (`RWT...`, pre-2025-11-18), SPKI PEM (the signer since
 *    2025-11-18), and raw 32-byte base64 (`dossier keys generate`, the trusted-key
 *    list, and every dossier published before 2026-03). Raw base64 is canonical:
 *    it is what the trust list stores and what the published corpus carries.
 *    Everything is normalized to it before comparison, and PEM is still accepted
 *    on the read path so signatures made in between keep verifying.
 *
 * 2. Payload coverage. Signatures used to cover the body only, which left
 *    `risk_level`, `requires_approval`, `destructive_operations` and the rest of
 *    the frontmatter unprotected — exactly the fields the runner gates execution
 *    on. v2 payloads cover the frontmatter (minus the signature block itself)
 *    together with the body. `signature.covers` records which scheme was used;
 *    absent means the legacy body-only scheme.
 */

/** SPKI DER prefix for an Ed25519 public key: 12 bytes, then the raw 32-byte key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const ED25519_RAW_KEY_BYTES = 32;

export type SignatureCoverage = 'body' | 'frontmatter+body';

/**
 * Coverage of a signature block, defaulting to the legacy body-only scheme when
 * the field is absent.
 */
export function signatureCoverage(signature: { covers?: string } | undefined): SignatureCoverage {
  return signature?.covers === 'frontmatter+body' ? 'frontmatter+body' : 'body';
}

/**
 * Normalize an Ed25519 public key to raw 32-byte base64.
 *
 * Accepts SPKI PEM, raw base64, and base64 SPKI DER. Returns the input trimmed
 * when it cannot be interpreted, so callers can still do an exact-match
 * comparison against whatever the source actually contained.
 */
export function normalizePublicKey(publicKey: string): string {
  const trimmed = publicKey.trim();
  if (!trimmed) {
    return trimmed;
  }

  // minisign keys are a different encoding entirely (and carry a key id); nothing
  // has produced them since 2025-11-18. Leave them untouched.
  if (trimmed.startsWith('RWT')) {
    return trimmed;
  }

  const base64Body = trimmed.includes('BEGIN')
    ? trimmed
        .replace(/-----BEGIN [^-]+-----/g, '')
        .replace(/-----END [^-]+-----/g, '')
        .replace(/\s+/g, '')
    : trimmed.replace(/\s+/g, '');

  let decoded: Buffer;
  try {
    decoded = Buffer.from(base64Body, 'base64');
  } catch {
    return trimmed;
  }

  if (decoded.length === ED25519_RAW_KEY_BYTES) {
    return decoded.toString('base64');
  }

  if (
    decoded.length === ED25519_SPKI_PREFIX.length + ED25519_RAW_KEY_BYTES &&
    decoded.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return decoded.subarray(ED25519_SPKI_PREFIX.length).toString('base64');
  }

  return trimmed;
}

/**
 * Build an SPKI PEM from any accepted public-key form, for use with node:crypto.
 * Returns the input unchanged when it is already PEM.
 */
export function toSpkiPem(publicKey: string): string {
  const trimmed = publicKey.trim();
  if (trimmed.includes('BEGIN')) {
    return trimmed;
  }

  const raw = Buffer.from(normalizePublicKey(trimmed), 'base64');
  if (raw.length !== ED25519_RAW_KEY_BYTES) {
    // Not something we can rebuild; hand it back and let crypto report the error.
    return trimmed;
  }

  const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  const body = der
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trimEnd();
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
}

/**
 * Compare two public keys across encodings.
 */
export function publicKeysMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) {
    return false;
  }
  return normalizePublicKey(a) === normalizePublicKey(b);
}

/**
 * Deterministic JSON: object keys sorted recursively, no insignificant whitespace.
 * Array order is meaningful and is preserved.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);

  return `{${entries.join(',')}}`;
}

/**
 * Canonical form of the frontmatter for signing: every field except the
 * signature block, serialized deterministically.
 */
export function canonicalizeFrontmatter(frontmatter: Record<string, unknown>): string {
  const { signature: _excluded, ...rest } = frontmatter;
  return stableStringify(rest);
}

/**
 * The exact bytes a v2 signature covers.
 *
 * The version tag is inside the signed payload on purpose: it stops a v2
 * signature from being replayed as a v1 body-only signature, or the reverse.
 */
export function buildSignedPayload(
  frontmatter: Record<string, unknown>,
  body: string,
  coverage: SignatureCoverage = 'frontmatter+body'
): string {
  if (coverage === 'body') {
    return body;
  }
  return `dossier-signature-v2\n${canonicalizeFrontmatter(frontmatter)}\n${body}`;
}
