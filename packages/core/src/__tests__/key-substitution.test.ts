/**
 * Trust must be decided on the same key the signature is verified against.
 *
 * These are regression tests for a confirmed key-substitution vulnerability: a
 * dossier could verify under an attacker's key while being reported as
 * "Verified signature from trusted source: <victim>". Two independent primitives
 * made that possible, and each gets its own test below.
 */

import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { findTrustedIdentifier, verifyWithEd25519 } from '../signature';
import { isSupportedPublicKey, normalizePublicKey, toSpkiPem } from '../signing-payload';

const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    pem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    raw: publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64'),
  };
};

describe('key normalization cannot disagree with key parsing', () => {
  // Node's base64 decoder stops at the first `=` padding, and every raw Ed25519
  // key is 44 base64 chars ending in `=`. OpenSSL, meanwhile, skips anything
  // before `-----BEGIN`. Together those let one string mean two different keys.
  it('does not resolve a victim-key prefix + attacker PEM to the victim key', () => {
    const victim = keyPair();
    const attacker = keyPair();
    const crafted = `${victim.raw}\n${attacker.pem}`;

    expect(normalizePublicKey(crafted)).not.toBe(victim.raw);
    expect(isSupportedPublicKey(crafted)).toBe(false);
  });

  it('does not resolve trailing bytes after a whole key to that key', () => {
    const victim = keyPair();

    expect(normalizePublicKey(`${victim.raw}trailing-junk`)).not.toBe(victim.raw);
    expect(normalizePublicKey(`${victim.pem}${victim.raw}`)).not.toBe(victim.raw);
  });

  // The invariant that actually closes the hole: whatever normalization says a
  // string denotes, that is the key `verify` receives.
  it('verifies against exactly the key it normalizes to', () => {
    const victim = keyPair();
    const attacker = keyPair();
    const body = 'signed body';
    const attackerSignature = sign(null, Buffer.from(body, 'utf8'), attacker.privateKey).toString(
      'base64'
    );

    for (const crafted of [
      `${victim.raw}\n${attacker.pem}`,
      `junk\n${victim.raw}\njunk\n${attacker.pem}`,
      `${attacker.pem}\n${victim.raw}`,
    ]) {
      // Either the string does not resolve to the victim, or if it somehow did,
      // the rebuilt PEM would be the victim's and the attacker's signature would
      // fail. Both branches deny trust; assert the pair can never both favour it.
      const resolvesToVictim = normalizePublicKey(crafted) === victim.raw;
      const verifiesForAttacker = verifyWithEd25519(body, attackerSignature, crafted).valid;
      expect(resolvesToVictim && verifiesForAttacker).toBe(false);
    }
  });

  it('still round-trips every legitimate encoding to one key', () => {
    const { pem, raw } = keyPair();

    expect(normalizePublicKey(pem)).toBe(raw);
    expect(normalizePublicKey(raw)).toBe(raw);
    expect(normalizePublicKey(toSpkiPem(raw))).toBe(raw);
    expect(toSpkiPem(pem).trim()).toBe(pem.trim());
    expect(isSupportedPublicKey(pem)).toBe(true);
    expect(isSupportedPublicKey(raw)).toBe(true);
  });
});

describe('findTrustedIdentifier binds trust to the verifying key', () => {
  // The trust list is keyed by public key and public keys are public, so a
  // `key_id` naming the victim's public key must not confer the victim's trust
  // on a dossier that verifies under someone else's `public_key`.
  it('ignores key_id when the signature carries a public key', () => {
    const victim = keyPair();
    const attacker = keyPair();
    const trustedKeys = new Map([[victim.raw, 'victim-signer']]);

    expect(
      findTrustedIdentifier(trustedKeys, { public_key: attacker.pem, key_id: victim.raw })
    ).toBeUndefined();
  });

  it('still trusts the signature’s own key in either encoding', () => {
    const victim = keyPair();
    const trustedKeys = new Map([[victim.raw, 'victim-signer']]);

    expect(findTrustedIdentifier(trustedKeys, { public_key: victim.pem })).toBe('victim-signer');
    expect(findTrustedIdentifier(trustedKeys, { public_key: victim.raw })).toBe('victim-signer');
  });

  // KmsVerifier verifies against `key_id` and never reads `public_key`, even
  // though KMS signatures carry one — so for KMS the ARN is the key material,
  // and the public key it ships must not confer trust.
  it('keys KMS trust on the ARN, not the public key it also carries', () => {
    const arn = 'arn:aws:kms:us-east-1:1:key/abc';
    const attacker = keyPair();
    const trustedKeys = new Map([[arn, 'kms-signer']]);

    expect(
      findTrustedIdentifier(trustedKeys, {
        algorithm: 'ECDSA-SHA-256',
        key_id: arn,
        public_key: attacker.raw,
      })
    ).toBe('kms-signer');
  });

  it('does not let a KMS public key stand in for an untrusted ARN', () => {
    const victim = keyPair();
    const trustedKeys = new Map([[victim.raw, 'victim-signer']]);

    expect(
      findTrustedIdentifier(trustedKeys, {
        algorithm: 'ECDSA-SHA-256',
        key_id: 'arn:aws:kms:us-east-1:1:key/untrusted',
        public_key: victim.raw,
      })
    ).toBeUndefined();
  });

  // An Ed25519 signature verifies against `public_key` alone, so a bare `key_id`
  // must not stand in for it.
  it('ignores key_id for a non-KMS signature with no public key', () => {
    const victim = keyPair();
    const trustedKeys = new Map([[victim.raw, 'victim-signer']]);

    expect(
      findTrustedIdentifier(trustedKeys, { algorithm: 'ed25519', key_id: victim.raw })
    ).toBeUndefined();
  });
});
