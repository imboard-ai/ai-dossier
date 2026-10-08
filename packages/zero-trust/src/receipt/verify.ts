import { isSupportedPublicKey, publicKeysMatch } from '@ai-dossier/core';
import { type Intent, idempotencyKey, MAX_ATTEMPT_SEQUENCE } from '../intents';
import { type BoundaryEvidence, isCleanHeldVerdict } from '../vm/evidence';
import { receiptIntegrity } from './integrity';
import type { SignedReceipt } from './issue';
import type { ReceiptNonceStore } from './nonces';
import {
  canonicalJson,
  type Receipt,
  ReceiptError,
  type ShippingGrant,
  snapshotJson,
} from './schema';

export interface ReceiptContext {
  contributionId: string;
  runId: string;
  sessionId: string;
  contributor: string;
  upstreamRepositoryId: number;
  forkRepositoryId: number;
  issue: number;
  defaultBranch: string;
  baseSha: string;
  parentSha: string;
  candidateSha: string;
  profileDigest: string;
  policyDigest: string;
  profile: Receipt['profile'];
  networkPolicy: Receipt['networkPolicy'];
  /** Trusted profile's command list, not a list derived from worker output. */
  requiredCommands: { id: string; command: string }[];
  /** Set by fresh controller policy/checkpoint admission immediately before use. */
  policyPermitsShipping: boolean;
  /** Fresh controller allowlist with authenticated target routing. */
  allowedShippingOperations: Pick<ShippingGrant, 'kind' | 'target' | 'expectedRemoteSha'>[];
  /** The run's host-side isolation evidence (`evaluateBoundary`). Shipping is refused
   * unless it shows the boundary held; missing evidence is refused too. */
  boundaryEvidence: BoundaryEvidence;
}

/** A run whose isolation was breached, or whose evidence is missing, not a clean
 * verdict or another run's, may never ship (scenario 4). Checked first and on its
 * own snapshot: a breach verdict carries guest text, which must classify as
 * `boundary_not_held`, never as some other failure of the context snapshot. */
function assertBoundaryHeldForShipping(context: ReceiptContext): void {
  let evidence: unknown;
  try {
    evidence = snapshotJson(context?.boundaryEvidence ?? null);
  } catch {
    throw new ReceiptError('boundary_not_held');
  }
  if (evidence === null || typeof evidence !== 'object')
    throw new ReceiptError('boundary_evidence_missing');
  if (!isCleanHeldVerdict(evidence)) throw new ReceiptError('boundary_not_held');
}
const BINDINGS = [
  'contributionId',
  'runId',
  'sessionId',
  'contributor',
  'upstreamRepositoryId',
  'forkRepositoryId',
  'issue',
  'defaultBranch',
  'baseSha',
  'parentSha',
  'candidateSha',
  'profileDigest',
  'policyDigest',
  'profile',
  'networkPolicy',
] as const;
/** Cryptographic/evidence validation only — NOT a shipping authorization.
 * authorizeShipping below additionally burns the nonce durably. */
export async function verifyReceipt(
  input: SignedReceipt,
  trustedControllerKey: string,
  context: ReceiptContext,
  now: () => number
): Promise<Receipt> {
  const envelope = snapshotJson(input);
  const expected = snapshotJson(context);
  const receipt = receiptIntegrity(envelope);
  const signature = envelope.signature;
  if (
    !signature ||
    signature.algorithm !== 'ed25519' ||
    typeof signature.public_key !== 'string' ||
    typeof signature.signature !== 'string' ||
    !isSupportedPublicKey(trustedControllerKey) ||
    !publicKeysMatch(signature.public_key, trustedControllerKey)
  )
    throw new ReceiptError('bad_signature');
  const clock = now();
  if (
    !Number.isSafeInteger(clock) ||
    clock < Date.parse(receipt.issuedAt) ||
    clock >= Date.parse(receipt.expiresAt)
  )
    throw new ReceiptError('expired');
  for (const field of BINDINGS) {
    if (canonicalJson(receipt[field]) !== canonicalJson(expected[field]))
      throw new ReceiptError(`wrong_${field}`);
  }
  if (expected.policyPermitsShipping !== true) throw new ReceiptError('policy_denied');
  if (
    !receipt.verified ||
    !Array.isArray(expected.requiredCommands) ||
    !expected.requiredCommands.length ||
    new Set(expected.requiredCommands.map((c) => c.id)).size !== expected.requiredCommands.length
  )
    throw new ReceiptError('unverified');
  const required = receipt.commands.filter((c) => c.required);
  if (
    canonicalJson(
      required.map(({ id, command }) => ({ id, command })).sort((a, b) => a.id.localeCompare(b.id))
    ) !== canonicalJson(expected.requiredCommands.sort((a, b) => a.id.localeCompare(b.id)))
  )
    throw new ReceiptError('required_commands_mismatch');
  return receipt;
}
/** Use in the trusted WriteAdapter.mutate, AFTER IntentDriver persisted attempted.
 * Identity and policy come from authenticated controller facts, never model text.
 * Return value is single-use: do the bound mutation once, then reconcile on crash. */
export async function authorizeShipping(
  input: SignedReceipt,
  trustedControllerKey: string,
  context: ReceiptContext,
  attemptedIntent: Intent,
  expectedRemoteSha: string | null,
  store: ReceiptNonceStore,
  now: () => number
): Promise<ShippingGrant> {
  assertBoundaryHeldForShipping(context);
  const envelope = snapshotJson(input);
  const intent = snapshotJson(attemptedIntent);
  const expected = snapshotJson(context);
  // Only this run's own verdict counts, compared on the same snapshot the receipt binds.
  if (expected.boundaryEvidence.runId !== expected.runId)
    throw new ReceiptError('boundary_wrong_run');
  const receipt = await verifyReceipt(envelope, trustedControllerKey, expected, now);
  const key = idempotencyKey(intent);
  if (
    intent.status !== 'attempted' ||
    intent.retryReady !== false ||
    intent.key !== key ||
    intent.contributionId !== receipt.contributionId ||
    intent.candidateSha !== receipt.candidateSha ||
    !Number.isSafeInteger(intent.attempts) ||
    intent.attempts < 1 ||
    intent.attempts > MAX_ATTEMPT_SEQUENCE
  )
    throw new ReceiptError('unjournaled_operation');
  const grant = receipt.permittedShippingOperations.find(
    (g) =>
      g.operationKey === key &&
      g.kind === intent.operationKind &&
      g.target === intent.target &&
      g.expectedRemoteSha === expectedRemoteSha
  );
  if (!grant) throw new ReceiptError('operation_denied');
  if (
    !Array.isArray(expected.allowedShippingOperations) ||
    !expected.allowedShippingOperations.some(
      (g) =>
        g.kind === grant.kind &&
        g.target === grant.target &&
        g.expectedRemoteSha === grant.expectedRemoteSha
    )
  )
    throw new ReceiptError('policy_scope_denied');
  // Recheck after asynchronous verification, immediately before synchronous consume.
  const clock = now();
  if (
    !Number.isSafeInteger(clock) ||
    clock < Date.parse(receipt.issuedAt) ||
    clock >= Date.parse(receipt.expiresAt)
  )
    throw new ReceiptError('expired');
  store.consume({
    nonce: grant.nonce,
    operationKey: key,
    receiptDigest: envelope.digest,
    attempt: intent.attempts,
  });
  return snapshotJson(grant);
}
