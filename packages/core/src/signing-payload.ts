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
 * One PEM block and nothing else: no content before BEGIN or after END, matching
 * labels, and only base64 in between.
 *
 * Anchoring both ends is load-bearing. OpenSSL — so `crypto.createPublicKey` —
 * skips whatever precedes the BEGIN line and ignores whatever follows END, so a
 * blob with padding around a real block still parses, as the key inside the
 * block. If normalization read that same blob more loosely it could conclude the
 * string denotes a *different* key than the one `createPublicKey` will hand to
 * `verify`, and a trust check is exactly the place where those two answers must
 * never differ.
 */
const SINGLE_PEM_BLOCK = /^-----BEGIN ([A-Za-z0-9 ]+)-----([A-Za-z0-9+/=\s]*)-----END \1-----$/;

/**
 * Decode base64 only when the input is exactly what re-encoding those bytes gives.
 *
 * Node's base64 decoder is lenient by design: it silently discards characters it
 * does not recognize and stops at the first `=` padding. That leniency is a
 * key-substitution primitive here, because every raw Ed25519 key is 44 base64
 * characters ending in `=` — meaning `<any key><arbitrary trailing text>` decodes
 * to that key. Requiring a byte-exact round trip collapses each string onto at
 * most one key.
 */
function decodeExactBase64(value: string): Buffer | undefined {
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : undefined;
}

/**
 * The raw 32 key bytes a public-key string denotes, or `undefined` when it does
 * not unambiguously denote an Ed25519 key.
 *
 * The single source of truth behind `normalizePublicKey`, `toSpkiPem` and
 * `isSupportedPublicKey`, so the key a trust check matches on and the key a
 * signature is verified against are derived from one parse and cannot drift.
 */
function ed25519RawKey(publicKey: string): Buffer | undefined {
  const trimmed = publicKey.trim();
  if (!trimmed) {
    return undefined;
  }

  // minisign keys are a different encoding entirely (and carry a key id); nothing
  // has produced them since 2025-11-18. Leave them untouched.
  if (trimmed.startsWith('RWT')) {
    return undefined;
  }

  // `-` is not in the base64 alphabet, so this cannot misread a raw key as PEM —
  // whereas testing for the word "BEGIN" would, since B, E, G, I and N all are.
  let base64Body: string;
  if (trimmed.includes('-----')) {
    const block = SINGLE_PEM_BLOCK.exec(trimmed);
    if (!block) {
      return undefined;
    }
    base64Body = block[2].replace(/\s+/g, '');
  } else {
    base64Body = trimmed.replace(/\s+/g, '');
  }

  const decoded = decodeExactBase64(base64Body);
  if (!decoded) {
    return undefined;
  }

  if (decoded.length === ED25519_RAW_KEY_BYTES) {
    return decoded;
  }

  if (
    decoded.length === ED25519_SPKI_PREFIX.length + ED25519_RAW_KEY_BYTES &&
    decoded.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return decoded.subarray(ED25519_SPKI_PREFIX.length);
  }

  return undefined;
}

/**
 * Normalize an Ed25519 public key to raw 32-byte base64.
 *
 * Accepts SPKI PEM, raw base64, and base64 SPKI DER. Returns the input trimmed
 * when it cannot be interpreted, so callers can still do an exact-match
 * comparison against whatever the source actually contained.
 */
export function normalizePublicKey(publicKey: string): string {
  const raw = ed25519RawKey(publicKey);
  return raw ? raw.toString('base64') : publicKey.trim();
}

/**
 * Whether a public key is one this project can actually verify against.
 *
 * True for anything that normalizes to a raw 32-byte Ed25519 key (raw base64,
 * SPKI PEM, base64 SPKI DER) and for minisign keys, which are passed through.
 *
 * `normalizePublicKey` deliberately returns uninterpretable input unchanged so
 * exact-match comparison still works on the read path. On the *write* path —
 * `dossier keys add` — that same leniency would silently store a typo, a
 * truncated key, or a file path as if it were a trusted key, and the only
 * symptom would be `dossier verify` reporting "not trusted" forever after. Use
 * this to reject before writing.
 */
export function isSupportedPublicKey(publicKey: string): boolean {
  const trimmed = publicKey.trim();
  return trimmed.startsWith('RWT') || ed25519RawKey(trimmed) !== undefined;
}

/**
 * Build an SPKI PEM from any accepted public-key form, for use with node:crypto.
 *
 * Always rebuilt from the parsed key rather than passed through, so the bytes a
 * signature is verified against are the bytes the trust check matched. Returns
 * the input unchanged only when it denotes no Ed25519 key at all, leaving
 * `crypto` to report the error.
 */
export function toSpkiPem(publicKey: string): string {
  const raw = ed25519RawKey(publicKey);
  if (!raw) {
    return publicKey.trim();
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
