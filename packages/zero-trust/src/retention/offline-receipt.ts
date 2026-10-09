import type { SignatureResult } from '@ai-dossier/core';
import { upstreamIssueBinding } from '../github/handoff';
import { receiptIntegrity } from '../receipt/integrity';
import { receiptDigest, type SignedReceipt } from '../receipt/issue';
import { parseReceipt } from '../receipt/schema';
import { isRecord, isTimestamp, type RunRecord } from '../state';
import { refuse } from './files';

export const signatureSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['algorithm', 'signature', 'public_key', 'signed_at'],
  properties: {
    algorithm: { const: 'ed25519' },
    signature: { type: 'string', maxLength: 8192 },
    public_key: { type: 'string', maxLength: 8192 },
    signed_at: { type: 'string', maxLength: 8192 },
    key_id: { type: 'string', maxLength: 8192 },
    signed_by: { type: 'string', maxLength: 8192 },
    covers: { enum: ['body', 'frontmatter+body', 'spec-frontmatter+body'] },
  },
};
/** Offline integrity only: grants neither trusted-key nor unexpired shipping authority. */
export function offlineReceipt(
  input: unknown,
  run: RunRecord,
  contributionId: string
): SignedReceipt {
  if (
    !isRecord(input) ||
    typeof input.digest !== 'string' ||
    Object.keys(input).sort().join(',') !== 'digest,receipt,signature' ||
    !isRecord(input.signature)
  )
    refuse();
  const s = input.signature;
  if (Object.values(s).some((value) => typeof value !== 'string' || value.length > 8192)) refuse();
  if (
    Object.keys(s).some((key) => !Object.hasOwn(signatureSchema.properties, key)) ||
    s.algorithm !== 'ed25519' ||
    typeof s.signature !== 'string' ||
    typeof s.public_key !== 'string' ||
    !isTimestamp(s.signed_at) ||
    ['key_id', 'signed_by'].some((key) => s[key] !== undefined && typeof s[key] !== 'string') ||
    (s.covers !== undefined &&
      s.covers !== 'body' &&
      s.covers !== 'frontmatter+body' &&
      s.covers !== 'spec-frontmatter+body')
  )
    refuse();
  const signature: SignatureResult = {
    algorithm: s.algorithm,
    signature: s.signature,
    public_key: s.public_key,
    signed_at: s.signed_at,
    ...(typeof s.key_id === 'string' ? { key_id: s.key_id } : {}),
    ...(typeof s.signed_by === 'string' ? { signed_by: s.signed_by } : {}),
    ...(s.covers === 'body' ||
    s.covers === 'frontmatter+body' ||
    s.covers === 'spec-frontmatter+body'
      ? { covers: s.covers }
      : {}),
  };
  try {
    const receipt = receiptIntegrity({
      receipt: parseReceipt(input.receipt),
      digest: input.digest,
      signature,
    });
    const issue = upstreamIssueBinding(run.upstreamIssue);
    const session = receipt.sessionId.slice(`${run.runId}-s`.length);
    if (
      receipt.runId !== run.runId ||
      receipt.contributionId !== contributionId ||
      receipt.contributor !== run.contributor ||
      receipt.issue !== issue.issue ||
      !receipt.sessionId.startsWith(`${run.runId}-s`) ||
      !/^[1-9][0-9]{0,15}$/u.test(session) ||
      !Number.isSafeInteger(Number(session)) ||
      input.digest !== receiptDigest(receipt)
    )
      refuse();
    return { receipt, digest: receiptDigest(receipt), signature };
  } catch {
    return refuse();
  }
}
