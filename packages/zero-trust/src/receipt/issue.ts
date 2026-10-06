import { createHash } from 'node:crypto';
import {
  Ed25519Verifier,
  isSupportedPublicKey,
  type SignatureResult,
  type Signer,
} from '@ai-dossier/core';
import { idempotencyKey } from '../intents';
import {
  canonicalJson,
  evidenceVerified,
  parseReceipt,
  RECEIPT_TTL_MS,
  RECEIPT_VERSION,
  type Receipt,
  ReceiptError,
  snapshotJson,
} from './schema';

export interface SignedReceipt {
  receipt: Receipt;
  digest: string;
  signature: SignatureResult;
}
export type ReceiptInput = Omit<Receipt, 'schemaVersion' | 'issuedAt' | 'expiresAt' | 'verified'>;
export function receiptDigest(receipt: Receipt): string {
  return createHash('sha256')
    .update(canonicalJson(parseReceipt(receipt)), 'utf8')
    .digest('hex');
}
/** Called only by the independent trusted verifier with supervised evidence.
 * The signer stays in controller storage; no key/path is part of this API's output. */
export async function issueReceipt(
  input: ReceiptInput,
  signer: Signer,
  now: () => number
): Promise<SignedReceipt> {
  const copy = snapshotJson(input);
  const issued = now();
  if (!Number.isSafeInteger(issued)) throw new ReceiptError('invalid_clock');
  const receipt = parseReceipt({
    ...copy,
    schemaVersion: RECEIPT_VERSION,
    issuedAt: new Date(issued).toISOString(),
    expiresAt: new Date(issued + RECEIPT_TTL_MS).toISOString(),
    verified: evidenceVerified(copy.commands),
  });
  for (const grant of receipt.permittedShippingOperations) {
    if (
      grant.operationKey !==
      idempotencyKey({
        contributionId: receipt.contributionId,
        target: grant.target,
        operationKind: grant.kind,
        candidateSha: receipt.candidateSha,
      })
    )
      throw new ReceiptError('invalid_scope');
  }
  if (signer.algorithm !== 'ed25519') throw new ReceiptError('unsupported_signer');
  const bytes = canonicalJson(receipt);
  const signature = snapshotJson(await signer.sign(bytes));
  if (
    signature.algorithm !== 'ed25519' ||
    !isSupportedPublicKey(signature.public_key) ||
    !(await new Ed25519Verifier().verify(bytes, signature)).valid
  )
    throw new ReceiptError('invalid_signature');
  return { receipt, digest: receiptDigest(receipt), signature };
}
