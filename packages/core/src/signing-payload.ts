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
 *
 *    v3 (`spec-frontmatter+body`) is the scheme for spec-shaped dossiers (#1088):
 *    it covers the frontmatter exactly as it sits on disk — Agent Skills fields at
 *    the top level, Dossier fields as `metadata["dossier.*"]` strings — not the
 *    logical flat view, because a signature should cover what is actually shipped.
 *    Each scheme is bound to one shape: v3 only on spec-shaped files, v1/v2 only on
 *    legacy ones, and an unrecognized `covers` value is refused, never guessed.
 */

import { DOSSIER_METADATA_PREFIX, isSpecShapedFrontmatter } from './spec-shape';
import type { ParsedDossier } from './types';
import { stableStringify } from './utils/canonical-json';

/** SPKI DER prefix for an Ed25519 public key: 12 bytes, then the raw 32-byte key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const ED25519_RAW_KEY_BYTES = 32;

/** Every `signature.covers` scheme a verifier accepts: v1, v2, v3. */
export const SIGNATURE_COVERAGES = ['body', 'frontmatter+body', 'spec-frontmatter+body'] as const;

export type SignatureCoverage = (typeof SIGNATURE_COVERAGES)[number];

/** Key of the signature block inside a spec-shaped `metadata` map. */
const SPEC_SIGNATURE_KEY = `${DOSSIER_METADATA_PREFIX}signature`;

/**
 * Coverage of a signature block, defaulting to the legacy body-only scheme when
 * the field is absent.
 *
 * An unrecognized `covers` throws. Falling back to body-only would let anyone
 * relabel a signature into the weakest scheme, and a scheme this code does not
 * know cannot be verified correctly anyway — refusing is the only safe answer.
 */
export function signatureCoverage(signature: { covers?: unknown } | undefined): SignatureCoverage {
  const covers = signature?.covers;
  if (covers === undefined) {
    return 'body';
  }
  if (typeof covers === 'string' && (SIGNATURE_COVERAGES as readonly string[]).includes(covers)) {
    return covers as SignatureCoverage;
  }
  throw new Error(
    `Unsupported signature coverage ${JSON.stringify(covers)}; refusing to verify (this dossier may need a newer ai-dossier CLI or VS Code extension)`
  );
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
 * Canonical form of the frontmatter for signing: every field except the
 * signature block, serialized deterministically.
 */
export function canonicalizeFrontmatter(frontmatter: Record<string, unknown>): string {
  const { signature: _excluded, ...rest } = frontmatter;
  return stableStringify(rest);
}

/**
 * Canonical form of on-disk spec-shaped frontmatter for v3 signing: everything
 * as written except `metadata["dossier.signature"]`, serialized deterministically.
 */
export function canonicalizeSpecFrontmatter(frontmatter: Record<string, unknown>): string {
  if (!isSpecShapedFrontmatter(frontmatter)) {
    throw new Error(
      'A v3 (spec-frontmatter+body) payload needs the on-disk spec-shaped frontmatter, not the logical view'
    );
  }
  const { metadata, ...rest } = frontmatter;
  const { [SPEC_SIGNATURE_KEY]: _excluded, ...unsignedMetadata } = metadata as Record<
    string,
    unknown
  >;
  return stableStringify({ ...rest, metadata: unsignedMetadata });
}

/**
 * The exact bytes a signature covers.
 *
 * v2 takes the flat frontmatter; v3 takes the on-disk spec-shaped frontmatter
 * (`ParsedDossier.rawFrontmatter`). The version tag is inside the signed payload
 * on purpose: it stops a signature made under one scheme from being replayed as
 * another.
 */
export function buildSignedPayload(
  frontmatter: Record<string, unknown>,
  body: string,
  coverage: SignatureCoverage = 'frontmatter+body'
): string {
  if (coverage === 'body') {
    return body;
  }
  if (coverage === 'spec-frontmatter+body') {
    return `dossier-signature-v3\n${canonicalizeSpecFrontmatter(frontmatter)}\n${body}`;
  }
  return `dossier-signature-v2\n${canonicalizeFrontmatter(frontmatter)}\n${body}`;
}

/**
 * The payload a parsed dossier's signature must verify against.
 *
 * Selects v1/v2/v3 from `signature.covers` and binds each scheme to the shape it
 * was defined for: a spec-shaped file verifies only under v3, a legacy file only
 * under v1 or v2. Without the binding, a legacy v2 signature could be carried
 * onto a spec-shaped rewrite (same logical fields, so the v2 payload matches)
 * and vouch for on-disk bytes it never covered. Throws when the dossier is
 * unsigned, `covers` is unrecognized, or scheme and shape disagree.
 */
export function buildVerificationPayload(
  parsed: Pick<ParsedDossier, 'frontmatter' | 'body' | 'rawFrontmatter' | 'shape'>
): string {
  const signature = parsed.frontmatter.signature;
  if (!signature) {
    throw new Error('Dossier is not signed');
  }

  const coverage = signatureCoverage(signature);
  if (parsed.shape === 'spec') {
    if (coverage !== 'spec-frontmatter+body') {
      throw new Error(
        `Spec-shaped dossier carries a ${coverage} signature; only spec-frontmatter+body (v3) covers this shape`
      );
    }
    return buildSignedPayload(parsed.rawFrontmatter, parsed.body, coverage);
  }

  if (coverage === 'spec-frontmatter+body') {
    throw new Error(
      'Legacy-shaped dossier carries a spec-frontmatter+body (v3) signature, which only covers the spec shape'
    );
  }
  return buildSignedPayload(parsed.frontmatter, parsed.body, coverage);
}
