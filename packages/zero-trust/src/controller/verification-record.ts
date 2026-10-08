/** Controller-owned verification record (#1102; PRD §5.6 steps 6 to 8, §5.9). The
 * verifier writes one per candidate SHA, once, under the run store's
 * `artifacts/verification/<candidateSha>.json`. It holds the evidence a receipt will
 * carry; shipping signs a receipt from it just in time (receipts bind the fork repository
 * ID and expire after 15 minutes, so nothing is signed here). Reading it back fails
 * closed: anything unreadable, unknown, inconsistent or detached from its evidence
 * artifacts throws. */
import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { sha256 } from '../canonical/export';
import { assertDirectoryAncestors, privateDir, publishPrivate, readPrivate } from '../durable-fs';
import type { RegressionProof } from '../ecosystem/classify';
import {
  COMMANDS_SCHEMA,
  type CommandEvidence,
  canonicalJson,
  evidenceVerified,
} from '../receipt/schema';
import { runBoundaryVerdict } from '../vm/boundary-probe';
import { type BoundaryInput, isCleanHeldVerdict } from '../vm/evidence';

export const VERIFICATION_RECORD_VERSION = 'ztfc-verification-v1' as const;
/** Subdirectory of the run store's `artifacts` directory. */
export const VERIFICATION_DIRECTORY = 'verification';
const MAX_RECORD_BYTES = 1024 * 1024;
/** `prepareBoundary` names its artifact `boundary-<32 hex>.json` in the same directory. */
const BOUNDARY_ARTIFACT = /^boundary-[a-f0-9]{32}\.json$/u;
const SHA = /^[a-f0-9]{40}$/u;

export type VerificationVerdict = 'passed' | 'failed' | 'inconclusive';

/** The boundary evidence the verdict was computed from: an artifact beside the record
 * (basename only) and the SHA-256 of its exact bytes. */
export interface BoundaryInputRef {
  readonly artifact: string;
  readonly digest: string;
}

export interface VerificationRecord {
  readonly schemaVersion: typeof VERIFICATION_RECORD_VERSION;
  readonly runId: string;
  readonly candidateSha: string;
  readonly baseSha: string;
  readonly parentSha: string;
  /** From `profileReceiptBinding(record, vm.accelerator)`. */
  readonly profileDigest: string;
  readonly profile: {
    readonly name: string;
    readonly runtime: string;
    readonly imageDigest: string;
    readonly accelerator: 'kvm' | 'tcg';
  };
  readonly networkPolicy: { readonly provisioning: 'package_proxy'; readonly verification: 'none' };
  /** Receipt evidence for every report-classified test command (suite and regression). */
  readonly commands: readonly CommandEvidence[];
  readonly regression: RegressionProof;
  readonly verdict: VerificationVerdict;
  /** `false` blocks the run; no receipt may ever be issued for this record. */
  readonly boundaryHeld: boolean;
  readonly boundaryInputRef: BoundaryInputRef;
  /** Digests of every command log in the verification VM, provisioning included. */
  readonly logsDigests: readonly string[];
  readonly verifiedAt: string;
  /** SHA-256 of the canonical JSON of every other field. */
  readonly recordDigest: string;
}

export type VerificationRecordInput = Omit<VerificationRecord, 'schemaVersion' | 'recordDigest'>;

export type VerificationRecordErrorCode =
  | 'record_exists'
  | 'unavailable'
  | 'invalid_record'
  | 'evidence_mismatch';

/** Fixed, non-echoing reason: nothing read from disk is quoted. */
export class VerificationRecordError extends Error {
  constructor(readonly code: VerificationRecordErrorCode) {
    super(`Verification record refused (${code})`);
    this.name = 'VerificationRecordError';
  }
}

const id = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' };
const text = { type: 'string', minLength: 1, maxLength: 4096 };
const sha = { type: 'string', pattern: '^[a-f0-9]{40}$' };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const time = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' };
function object(properties: Record<string, unknown>) {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}
export const VERIFICATION_RECORD_SCHEMA = object({
  schemaVersion: { const: VERIFICATION_RECORD_VERSION },
  runId: id,
  candidateSha: sha,
  baseSha: sha,
  parentSha: sha,
  profileDigest: digest,
  profile: object({
    name: text,
    runtime: text,
    imageDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    accelerator: { enum: ['kvm', 'tcg'] },
  }),
  networkPolicy: object({
    provisioning: { const: 'package_proxy' },
    verification: { const: 'none' },
  }),
  commands: COMMANDS_SCHEMA,
  regression: { enum: ['reproduced_and_fixed', 'not_reproduced', 'still_failing', 'inconclusive'] },
  verdict: { enum: ['passed', 'failed', 'inconclusive'] },
  boundaryHeld: { type: 'boolean' },
  boundaryInputRef: object({
    artifact: { type: 'string', pattern: BOUNDARY_ARTIFACT.source },
    digest,
  }),
  logsDigests: { type: 'array', minItems: 1, maxItems: 256, uniqueItems: true, items: digest },
  verifiedAt: time,
  recordDigest: digest,
});
const validate = new Ajv({ strict: true }).compile<VerificationRecord>(VERIFICATION_RECORD_SCHEMA);

function digestOf(record: Omit<VerificationRecord, 'recordDigest'>): string {
  return sha256(canonicalJson(record, MAX_RECORD_BYTES));
}

/** Facts the schema cannot express. A `passed` verdict needs the regression proved
 * and receipt-grade evidence; every command log must be one of the record's logs. */
function consistent(record: VerificationRecord): boolean {
  const { recordDigest, ...body } = record;
  const ids = record.commands.map((c) => c.id);
  return (
    recordDigest === digestOf(body) &&
    record.baseSha === record.parentSha &&
    new Set(ids).size === ids.length &&
    record.commands.every((c) => record.logsDigests.includes(c.sanitizedLogDigest)) &&
    (record.verdict !== 'passed' ||
      (record.regression === 'reproduced_and_fixed' && evidenceVerified([...record.commands])))
  );
}

function recordPath(artifactsDir: string, candidateSha: string): string {
  if (typeof candidateSha !== 'string' || !SHA.test(candidateSha))
    throw new VerificationRecordError('invalid_record');
  return path.join(artifactsDir, VERIFICATION_DIRECTORY, `${candidateSha}.json`);
}

/** Whether a record already exists for this candidate (any entry counts, even a broken one). */
export function verificationExists(artifactsDir: string, candidateSha: string): boolean {
  try {
    fs.lstatSync(recordPath(artifactsDir, candidateSha));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new VerificationRecordError('unavailable');
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Writes the record once, with mode 0600, as canonical JSON. A record that already
 * exists for this candidate is never replaced. Returns the record and its digest. */
export function publishVerification(
  artifactsDir: string,
  input: VerificationRecordInput
): VerificationRecord {
  const body = { schemaVersion: VERIFICATION_RECORD_VERSION, ...input };
  let record: VerificationRecord;
  let bytes: Buffer;
  try {
    record = JSON.parse(canonicalJson({ ...body, recordDigest: digestOf(body) }, MAX_RECORD_BYTES));
    bytes = Buffer.from(`${canonicalJson(record, MAX_RECORD_BYTES)}\n`, 'utf8');
  } catch {
    throw new VerificationRecordError('invalid_record');
  }
  if (!validate(record) || !consistent(record)) throw new VerificationRecordError('invalid_record');
  if (verificationExists(artifactsDir, record.candidateSha))
    throw new VerificationRecordError('record_exists');
  try {
    assertDirectoryAncestors(artifactsDir);
    privateDir(path.join(artifactsDir, VERIFICATION_DIRECTORY));
    publishPrivate(recordPath(artifactsDir, record.candidateSha), bytes);
  } catch {
    throw new VerificationRecordError('unavailable');
  }
  return freeze(record);
}

function decode(bytes: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

function readEvidence(file: string): Buffer {
  try {
    return readPrivate(file);
  } catch {
    throw new VerificationRecordError('evidence_mismatch');
  }
}

/** The boundary artifact must be byte-identical to the one referenced, and the verdict
 * recomputed from it (never trusted from the record) must agree with `boundaryHeld`. */
function assertBoundaryEvidence(artifactsDir: string, record: VerificationRecord): void {
  const bytes = readEvidence(path.join(artifactsDir, record.boundaryInputRef.artifact));
  if (sha256(bytes) !== record.boundaryInputRef.digest)
    throw new VerificationRecordError('evidence_mismatch');
  let held: boolean;
  try {
    const input = JSON.parse(decode(bytes)) as BoundaryInput;
    held = isCleanHeldVerdict(runBoundaryVerdict([input], record.runId));
  } catch {
    throw new VerificationRecordError('evidence_mismatch');
  }
  if (held !== record.boundaryHeld) throw new VerificationRecordError('evidence_mismatch');
}

/** Each log digest names a persisted log artifact (`<digest>.<complete|truncated>.log.json`)
 * whose own digest field agrees. */
function assertLogEvidence(artifactsDir: string, record: VerificationRecord): void {
  for (const logDigest of record.logsDigests) {
    const found = ['complete', 'truncated'].filter((kind) => {
      const file = path.join(artifactsDir, `${logDigest}.${kind}.log.json`);
      try {
        fs.lstatSync(file);
      } catch {
        return false;
      }
      try {
        return JSON.parse(decode(readEvidence(file))).digest === logDigest;
      } catch {
        throw new VerificationRecordError('evidence_mismatch');
      }
    });
    if (found.length === 0) throw new VerificationRecordError('evidence_mismatch');
  }
}

export interface LoadVerificationOptions {
  /** The run the record must belong to. */
  readonly runId: string;
  /** The controller-held `recordDigest` from `verifyCandidate`, when the caller kept it. */
  readonly expectedDigest?: string;
}

/** Reads and validates a record: strict UTF-8, the exact canonical bytes it was written
 * as, the strict schema (unknown or missing fields fail), its own digest, the expected
 * candidate, run and digest, and the boundary and log artifacts it references. Any
 * deviation throws `VerificationRecordError`; nothing is repaired or defaulted. */
export function loadVerification(
  artifactsDir: string,
  candidateSha: string,
  options: LoadVerificationOptions
): VerificationRecord {
  const file = recordPath(artifactsDir, candidateSha);
  let bytes: Buffer;
  try {
    bytes = readPrivate(file);
  } catch {
    throw new VerificationRecordError('unavailable');
  }
  let record: unknown;
  try {
    if (bytes.length > MAX_RECORD_BYTES) throw new Error('oversize');
    const text = decode(bytes);
    record = JSON.parse(text);
    // Duplicate keys, reordering or whitespace edits change the canonical bytes.
    if (text !== `${canonicalJson(record, MAX_RECORD_BYTES)}\n`) throw new Error('not canonical');
  } catch {
    throw new VerificationRecordError('invalid_record');
  }
  if (!validate(record) || !consistent(record)) throw new VerificationRecordError('invalid_record');
  if (
    record.candidateSha !== candidateSha ||
    record.runId !== options.runId ||
    (options.expectedDigest !== undefined && record.recordDigest !== options.expectedDigest)
  )
    throw new VerificationRecordError('evidence_mismatch');
  assertBoundaryEvidence(artifactsDir, record);
  assertLogEvidence(artifactsDir, record);
  return freeze(record);
}
