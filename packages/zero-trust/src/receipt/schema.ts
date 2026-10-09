import Ajv from 'ajv';
import { dataDescriptors } from '../data-descriptors';
import { assertNoSecrets } from '../redaction';
import { object } from '../schema-object';

export const RECEIPT_VERSION = 'ztfc-receipt-v2' as const;
export const RECEIPT_TTL_MS = 15 * 60 * 1000;
export const SHIPPING_KINDS = ['push_branch', 'pr_create', 'pr_update'] as const;
export type ShippingKind = (typeof SHIPPING_KINDS)[number];
export type CommandStatus = 'passed' | 'failed' | 'inconclusive' | 'skipped';
export interface CommandEvidence {
  id: string;
  command: string;
  required: boolean;
  status: CommandStatus;
  exitStatus: number | 'unknown';
  suites: number | 'unknown';
  sanitizedLogDigest: string;
}
export interface ShippingGrant {
  kind: ShippingKind;
  target: string;
  operationKey: string;
  nonce: string;
  expectedRemoteSha: string | null;
}
export interface Receipt {
  schemaVersion: typeof RECEIPT_VERSION;
  contributionId: string;
  runId: string;
  sessionId: string;
  contributor: string;
  upstreamRepositoryId: number;
  issue: number;
  defaultBranch: string;
  forkRepositoryId: number;
  baseSha: string;
  parentSha: string;
  candidateSha: string;
  profileDigest: string;
  policyDigest: string;
  /** `accelerator` records how the VM ran: same isolation, different speed. */
  profile: { name: string; runtime: string; imageDigest: string; accelerator: 'kvm' | 'tcg' };
  commands: CommandEvidence[];
  networkPolicy: {
    acquisition: string;
    provisioning: string;
    verification: string;
    shipping: string;
  };
  issuedAt: string;
  expiresAt: string;
  permittedShippingOperations: ShippingGrant[];
  verified: boolean;
}
export class ReceiptError extends Error {
  constructor(readonly code: string) {
    super(`Zero-trust receipt rejected: ${code}`);
    this.name = 'ReceiptError';
  }
}
/** Schema building blocks shared by the receipt and the persisted verification record. */
export const SCHEMA_TYPES = Object.freeze({
  text: { type: 'string', minLength: 1, maxLength: 4096 },
  id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
  sha: { type: 'string', pattern: '^[a-f0-9]{40}$' },
  digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  time: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' },
});
const { text, id, sha, digest, time } = SCHEMA_TYPES;
const positive = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };

export { object as strictObject } from '../schema-object';
/** The receipt's `profile` (see `profileReceiptBinding`). */
export const PROFILE_SCHEMA = object({
  name: text,
  runtime: text,
  imageDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
  accelerator: { enum: ['kvm', 'tcg'] },
});
/** Supervised command evidence, shared with the persisted verification record. */
export const COMMANDS_SCHEMA = {
  type: 'array',
  minItems: 1,
  maxItems: 128,
  items: object({
    id,
    command: text,
    required: { type: 'boolean' },
    status: { enum: ['passed', 'failed', 'inconclusive', 'skipped'] },
    exitStatus: { anyOf: [{ type: 'integer', minimum: 0, maximum: 255 }, { const: 'unknown' }] },
    suites: {
      anyOf: [
        { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        { const: 'unknown' },
      ],
    },
    sanitizedLogDigest: digest,
  }),
};
/** The exported schema is also the runtime validator's single source of truth. */
export const RECEIPT_SCHEMA = object({
  schemaVersion: { const: RECEIPT_VERSION },
  contributionId: id,
  runId: id,
  sessionId: id,
  contributor: { type: 'string', pattern: '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$' },
  upstreamRepositoryId: positive,
  issue: positive,
  defaultBranch: text,
  forkRepositoryId: positive,
  baseSha: sha,
  parentSha: sha,
  candidateSha: sha,
  profileDigest: digest,
  policyDigest: digest,
  profile: PROFILE_SCHEMA,
  commands: COMMANDS_SCHEMA,
  networkPolicy: object({
    acquisition: text,
    provisioning: text,
    verification: text,
    shipping: text,
  }),
  issuedAt: time,
  expiresAt: time,
  permittedShippingOperations: {
    type: 'array',
    maxItems: 16,
    items: object({
      kind: { enum: SHIPPING_KINDS },
      target: text,
      operationKey: text,
      nonce: id,
      expectedRemoteSha: { anyOf: [sha, { type: 'null' }] },
    }),
  },
  verified: { type: 'boolean' },
});
const validate = new Ajv({ strict: true }).compile<Receipt>(RECEIPT_SCHEMA);
const validateCommands = new Ajv({ strict: true }).compile<CommandEvidence[]>(
  RECEIPT_SCHEMA.properties.commands
);

/** Reject accessors, custom prototypes, sparse arrays and lossy/non-JSON values.
 * Copy before any async boundary; nothing can change between validation/signing/use. */
export function canonicalJson(input: unknown, maxBytes = 128 * 1024): string {
  // Receipt callers retain the original budget. Other bounded evidence domains
  // may request up to 1 MiB without changing receipt parsing/signing limits.
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 1024 * 1024)
    throw new ReceiptError('invalid_json');
  let nodes = 0;
  let bytes = 0;
  function reserve(count: number): void {
    bytes += count;
    if (bytes > maxBytes) throw new ReceiptError('invalid_json');
  }
  function atom(text: string): string {
    reserve(Buffer.byteLength(text));
    return text;
  }
  function encode(value: unknown, depth: number): string {
    if (++nodes > 20000 || depth > 12) throw new ReceiptError('invalid_json');
    if (value === null || typeof value === 'boolean') return atom(JSON.stringify(value));
    if (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0))
      return atom(JSON.stringify(value));
    if (typeof value === 'string') {
      if (value.length > 8192 || Buffer.from(value).toString() !== value)
        throw new ReceiptError('invalid_json');
      assertNoSecrets(value);
      return atom(JSON.stringify(value));
    }
    if (typeof value !== 'object' || value === null) throw new ReceiptError('invalid_json');
    let container: ReturnType<typeof dataDescriptors>;
    try {
      container = dataDescriptors(value);
    } catch {
      throw new ReceiptError('invalid_json');
    }
    const { array, keys, descriptors } = container;
    if (array) {
      const length = descriptors.length.value as number;
      reserve(length + 1);
      const items: string[] = [];
      for (let i = 0; i < length; i++) {
        items.push(encode(descriptors[String(i)].value, depth + 1));
      }
      return `[${items.join(',')}]`;
    }
    reserve(keys.length * 2 + 1);
    return `{${(keys as string[])
      .sort()
      .map((key) => `${encode(key, depth + 1)}:${encode(descriptors[key].value, depth + 1)}`)
      .join(',')}}`;
  }
  const result = encode(input, 0);
  if (Buffer.byteLength(result) > maxBytes) throw new ReceiptError('invalid_json');
  return result;
}
export function snapshotJson<T>(input: T): T {
  return JSON.parse(canonicalJson(input)) as T;
}
export function evidenceVerified(commands: readonly CommandEvidence[]): boolean {
  // Unknown discovery counts cannot earn a verification claim. This conservative
  // contract deliberately refuses shipping even for an inconclusive optional check.
  return (
    commands.some((c) => c.required) &&
    commands.every(
      (c) =>
        c.status === 'passed' && c.exitStatus === 0 && typeof c.suites === 'number' && c.suites > 0
    )
  );
}
/** Receipt and standalone verification share command shape and unique identity. */
export function parseCommandEvidence(input: unknown): CommandEvidence[] {
  const copy = snapshotJson(input);
  if (!validateCommands(copy)) throw new ReceiptError('invalid_schema');
  if (new Set(copy.map((command) => command.id)).size !== copy.length)
    throw new ReceiptError('invalid_evidence');
  return copy;
}
export function parseReceipt(input: unknown): Receipt {
  const copy = snapshotJson(input);
  if (!validate(copy)) throw new ReceiptError('invalid_schema');
  const receipt = copy as Receipt;
  if (
    receipt.baseSha !== receipt.parentSha ||
    receipt.verified !== evidenceVerified(receipt.commands)
  )
    throw new ReceiptError('invalid_evidence');
  parseCommandEvidence(receipt.commands);
  const issued = Date.parse(receipt.issuedAt);
  const expires = Date.parse(receipt.expiresAt);
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    new Date(issued).toISOString() !== receipt.issuedAt ||
    new Date(expires).toISOString() !== receipt.expiresAt ||
    expires - issued !== RECEIPT_TTL_MS
  )
    throw new ReceiptError('invalid_expiry');
  const grants = receipt.permittedShippingOperations;
  if (
    new Set(grants.map((g) => g.nonce)).size !== grants.length ||
    new Set(grants.map((g) => g.operationKey)).size !== grants.length
  )
    throw new ReceiptError('invalid_scope');
  return receipt;
}
