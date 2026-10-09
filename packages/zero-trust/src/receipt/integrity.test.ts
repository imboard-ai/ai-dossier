import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createFixtures, signedReceipt } from '../../fixtures/retention';
import { receiptIntegrity } from './integrity';
import { canonicalJson } from './schema';

const { rig, cleanup } = createFixtures();
afterEach(cleanup);
it('verifies Ed25519 but rejects algorithm confusion and noncanonical signature bytes', async () => {
  const envelope = await signedReceipt(rig());
  expect(receiptIntegrity(envelope)).toEqual(envelope.receipt);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const confused = structuredClone(envelope);
  confused.signature.public_key = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  confused.signature.signature = sign(
    null,
    Buffer.from(canonicalJson(envelope.receipt)),
    rsa.privateKey
  ).toString('base64');
  expect(() => receiptIntegrity(confused)).toThrow('bad_signature');
  for (const signature of [
    `${envelope.signature.signature}!ignored`,
    '',
    Buffer.alloc(64).toString('base64'),
  ]) {
    const corrupt = structuredClone(envelope);
    corrupt.signature.signature = signature;
    expect(() => receiptIntegrity(corrupt)).toThrow('bad_signature');
  }
  const digest = structuredClone(envelope);
  digest.digest = 'a'.repeat(64);
  expect(() => receiptIntegrity(digest)).toThrow('digest_mismatch');
  const algorithm = structuredClone(envelope);
  Object.assign(algorithm.signature, { algorithm: 'rsa' });
  expect(() => receiptIntegrity(algorithm)).toThrow('bad_signature');
});
