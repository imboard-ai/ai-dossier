import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ed25519Signer, Ed25519Verifier } from '../signers/ed25519';
import {
  buildSignedPayload,
  canonicalizeFrontmatter,
  isSupportedPublicKey,
  normalizePublicKey,
  publicKeysMatch,
  signatureCoverage,
  toSpkiPem,
} from '../signing-payload';

// A real published key, in the raw base64 form the corpus and trusted-key list use.
const PUBLISHED_RAW_KEY = 'rwZMHabZOn44qGc9tIRVPjFsHpoB3KxbsLhoULI5Xrw=';

describe('normalizePublicKey', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const raw = der.subarray(der.length - 32).toString('base64');

  it('converts SPKI PEM to raw base64', () => {
    expect(normalizePublicKey(pem)).toBe(raw);
  });

  it('is idempotent on raw base64', () => {
    expect(normalizePublicKey(raw)).toBe(raw);
    expect(normalizePublicKey(normalizePublicKey(pem))).toBe(raw);
  });

  it('converts base64 SPKI DER to raw base64', () => {
    expect(normalizePublicKey(der.toString('base64'))).toBe(raw);
  });

  it('leaves legacy minisign keys untouched', () => {
    expect(normalizePublicKey('RWTabc123=')).toBe('RWTabc123=');
  });

  it('returns uninterpretable input unchanged so exact matching still works', () => {
    expect(normalizePublicKey('not-a-key')).toBe('not-a-key');
  });

  it('handles the raw form carried by published dossiers', () => {
    expect(normalizePublicKey(PUBLISHED_RAW_KEY)).toBe(PUBLISHED_RAW_KEY);
  });
});

describe('toSpkiPem', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const raw = normalizePublicKey(pem);

  it('rebuilds a PEM that node:crypto accepts', () => {
    const rebuilt = toSpkiPem(raw);
    expect(rebuilt).toContain('BEGIN PUBLIC KEY');
    const reparsed = createPublicKey({ key: rebuilt, format: 'pem', type: 'spki' });
    expect(reparsed.export({ type: 'spki', format: 'pem' })).toBe(pem);
  });

  it('passes PEM through unchanged', () => {
    expect(toSpkiPem(pem).trim()).toBe(pem.trim());
  });
});

describe('publicKeysMatch', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

  it('matches the same key across encodings', () => {
    expect(publicKeysMatch(pem, normalizePublicKey(pem))).toBe(true);
  });

  it('does not match different keys', () => {
    expect(publicKeysMatch(pem, PUBLISHED_RAW_KEY)).toBe(false);
  });

  it('is false when either side is missing', () => {
    expect(publicKeysMatch(undefined, pem)).toBe(false);
    expect(publicKeysMatch(pem, undefined)).toBe(false);
  });
});

describe('canonicalizeFrontmatter', () => {
  it('is independent of key insertion order', () => {
    const a = canonicalizeFrontmatter({ title: 'T', risk_level: 'low', version: '1.0.0' });
    const b = canonicalizeFrontmatter({ version: '1.0.0', title: 'T', risk_level: 'low' });
    expect(a).toBe(b);
  });

  it('sorts nested object keys too', () => {
    const a = canonicalizeFrontmatter({ checksum: { algorithm: 'sha256', hash: 'abc' } });
    const b = canonicalizeFrontmatter({ checksum: { hash: 'abc', algorithm: 'sha256' } });
    expect(a).toBe(b);
  });

  it('preserves array order, which is meaningful', () => {
    const a = canonicalizeFrontmatter({ tags: ['a', 'b'] });
    const b = canonicalizeFrontmatter({ tags: ['b', 'a'] });
    expect(a).not.toBe(b);
  });

  it('excludes the signature block', () => {
    const withSig = canonicalizeFrontmatter({
      title: 'T',
      signature: { algorithm: 'ed25519', signature: 'xxx' },
    });
    expect(withSig).toBe(canonicalizeFrontmatter({ title: 'T' }));
  });
});

describe('signatureCoverage', () => {
  it('defaults to body-only for legacy signatures', () => {
    expect(signatureCoverage(undefined)).toBe('body');
    expect(signatureCoverage({})).toBe('body');
  });

  it('reads the explicit v2 marker', () => {
    expect(signatureCoverage({ covers: 'frontmatter+body' })).toBe('frontmatter+body');
  });
});

describe('buildSignedPayload', () => {
  const frontmatter = { title: 'T', risk_level: 'low' };

  it('returns the body alone under the legacy scheme', () => {
    expect(buildSignedPayload(frontmatter, 'body text', 'body')).toBe('body text');
  });

  it('tags the v2 payload so it cannot be replayed as v1', () => {
    const payload = buildSignedPayload(frontmatter, 'body text');
    expect(payload.startsWith('dossier-signature-v2\n')).toBe(true);
    expect(payload).not.toBe('body text');
  });
});

describe('end-to-end signing', () => {
  let tempDir: string;
  let privateKeyPath: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `signing-payload-test-${Date.now()}-${process.pid}`);
    if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });

    const { privateKey } = generateKeyPairSync('ed25519');
    privateKeyPath = join(tempDir, 'key.pem');
    writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  });

  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  const frontmatter = {
    title: 'Test',
    risk_level: 'critical',
    requires_approval: true,
    checksum: { algorithm: 'sha256', hash: 'abc' },
  };
  const body = '# Body\n\nSome instructions.\n';

  it('verifies a v2 signature over frontmatter + body', async () => {
    const signer = new Ed25519Signer(privateKeyPath);
    const sig = await signer.sign(buildSignedPayload(frontmatter, body));

    const verifier = new Ed25519Verifier();
    const result = await verifier.verify(buildSignedPayload(frontmatter, body), sig);
    expect(result.valid).toBe(true);
  });

  // The reason this change exists: risk_level and requires_approval gate execution,
  // and under the body-only scheme they could be rewritten without breaking the signature.
  it('rejects a downgraded risk_level', async () => {
    const signer = new Ed25519Signer(privateKeyPath);
    const sig = await signer.sign(buildSignedPayload(frontmatter, body));

    const tampered = { ...frontmatter, risk_level: 'low', requires_approval: false };
    const verifier = new Ed25519Verifier();
    const result = await verifier.verify(buildSignedPayload(tampered, body), sig);
    expect(result.valid).toBe(false);
  });

  it('still rejects a tampered body', async () => {
    const signer = new Ed25519Signer(privateKeyPath);
    const sig = await signer.sign(buildSignedPayload(frontmatter, body));

    const verifier = new Ed25519Verifier();
    const result = await verifier.verify(buildSignedPayload(frontmatter, `${body}rm -rf /\n`), sig);
    expect(result.valid).toBe(false);
  });

  it('still verifies legacy body-only signatures', async () => {
    const signer = new Ed25519Signer(privateKeyPath);
    const sig = await signer.sign(body);

    const verifier = new Ed25519Verifier();
    const result = await verifier.verify(buildSignedPayload(frontmatter, body, 'body'), sig);
    expect(result.valid).toBe(true);
  });

  // Stripping `covers` from a v2 signature must not silently fall back to the
  // weaker body-only check.
  it('rejects a v2 signature presented as body-only', async () => {
    const signer = new Ed25519Signer(privateKeyPath);
    const sig = await signer.sign(buildSignedPayload(frontmatter, body));

    const verifier = new Ed25519Verifier();
    const result = await verifier.verify(buildSignedPayload(frontmatter, body, 'body'), sig);
    expect(result.valid).toBe(false);
  });

  it('verifies when the public key is presented as PEM instead of raw base64', async () => {
    const signer = new Ed25519Signer(privateKeyPath);
    const sig = await signer.sign(buildSignedPayload(frontmatter, body));

    const asPem = { ...sig, public_key: toSpkiPem(sig.public_key) };
    const verifier = new Ed25519Verifier();
    const result = await verifier.verify(buildSignedPayload(frontmatter, body), asPem);
    expect(result.valid).toBe(true);
  });
});

describe('isSupportedPublicKey', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');

  it('accepts every form a key legitimately arrives in', () => {
    expect(isSupportedPublicKey(raw)).toBe(true);
    expect(isSupportedPublicKey(pem)).toBe(true);
    expect(isSupportedPublicKey(PUBLISHED_RAW_KEY)).toBe(true);
    expect(isSupportedPublicKey('RWTsomeMinisignKey==')).toBe(true);
  });

  it('rejects input normalizePublicKey would hand back uninterpreted', () => {
    // These all survive normalizePublicKey unchanged, which is correct for the
    // read path and disastrous on the write path: `keys add` would store them as
    // trusted keys and the only symptom would be a permanent "not trusted".
    for (const bad of [
      '',
      '   ',
      'notakey',
      '~/.dossier/default.pub',
      '/home/me/.dossier/default.pub',
      'default.pub',
      raw.slice(0, 20),
      '-----BEGIN PUBLIC KEY-----\nnot base64 at all\n-----END PUBLIC KEY-----',
    ]) {
      expect(isSupportedPublicKey(bad), `expected ${JSON.stringify(bad)} to be rejected`).toBe(
        false
      );
    }
  });
});
