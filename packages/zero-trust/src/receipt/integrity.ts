import { createPublicKey, verify } from 'node:crypto';
import { toSpkiPem } from '@ai-dossier/core';
import { receiptDigest, type SignedReceipt } from './issue';
import { canonicalJson, parseReceipt, ReceiptError } from './schema';

/** Shared offline integrity, without trust, expiry or shipping authorization. */
export function receiptIntegrity(envelope: SignedReceipt) {
  const receipt = parseReceipt(envelope.receipt);
  if (
    Object.keys(envelope).sort().join(',') !== 'digest,receipt,signature' ||
    envelope.digest !== receiptDigest(receipt)
  )
    throw new ReceiptError('digest_mismatch');
  try {
    const signature = envelope.signature;
    if (signature.algorithm !== 'ed25519') throw new Error();
    const key = createPublicKey(toSpkiPem(signature.public_key));
    const bytes = Buffer.from(signature.signature, 'base64');
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      bytes.length !== 64 ||
      bytes.toString('base64') !== signature.signature ||
      !verify(null, Buffer.from(canonicalJson(receipt)), key, bytes)
    )
      throw new Error();
  } catch {
    throw new ReceiptError('bad_signature');
  }
  return receipt;
}
