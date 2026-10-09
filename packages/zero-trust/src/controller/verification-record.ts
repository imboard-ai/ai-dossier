/** Controller-owned verification record (#1102; PRD §5.6 steps 6 to 8, §5.9). The
 * verifier writes one per candidate SHA, once, under the run store's
 * `artifacts/verification/<candidateSha>.json`. It holds the evidence a receipt will
 * carry; shipping signs a receipt from it just in time (receipts bind the fork repository
 * ID and expire after 15 minutes, so nothing is signed here). Reading it back fails
 * closed: anything unreadable, unknown, inconsistent or detached from its evidence
 * artifacts throws. */
import path from 'node:path';
import Ajv from 'ajv';
import { sha256 } from '../canonical/export';
import {
  assertDirectoryAncestors,
  createPrivateOnce,
  lstatIfPresent,
  privateDir,
  readPrivate,
} from '../durable-fs';
import type { RegressionProof } from '../ecosystem/classify';
import {
  COMMANDS_SCHEMA,
  type CommandEvidence,
  canonicalJson,
  evidenceVerified,
  PROFILE_SCHEMA,
  SCHEMA_TYPES,
  strictObject,
} from '../receipt/schema';
import { runBoundaryVerdict } from '../vm/boundary-probe';
import { isCleanHeldVerdict } from '../vm/evidence';
import { logArtifactName } from './evidence-runner';

export const VERIFICATION_RECORD_VERSION = 'ztfc-verification-v1' as const;
/** Subdirectory of the run store's `artifacts` directory. */
export const VERIFICATION_DIRECTORY = 'verification';
/** Suffix that keeps a regression-target command's id distinct from the suite's. */
export const REGRESSION_COMMAND_SUFFIX = '-regression';
export const VERIFICATION_VERDICTS = Object.freeze(['passed', 'failed', 'inconclusive'] as const);
export type VerificationVerdict = (typeof VERIFICATION_VERDICTS)[number];
const REGRESSION_PROOFS = Object.freeze([
  'reproduced_and_fixed',
  'not_reproduced',
  'still_failing',
  'inconclusive',
] as const satisfies readonly RegressionProof[]);
const MAX_RECORD_BYTES = 1024 * 1024;
/** `prepareBoundary` names its artifact `boundary-<32 hex>.json` in the same directory;
 * a load fails closed if that ever changes. */
const BOUNDARY_ARTIFACT = /^boundary-[a-f0-9]{32}\.json$/u;
const SHA = new RegExp(SCHEMA_TYPES.sha.pattern, 'u');
/** Marks a verification that started; a crash leaves it behind, so the same candidate is
 * never silently verified again. */
const ATTEMPT_SUFFIX = '.attempt';

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
  | 'evidence_mismatch'
  | 'not_shippable';

/** Fixed, non-echoing reason: nothing read from disk is quoted. */
export class VerificationRecordError extends Error {
  constructor(readonly code: VerificationRecordErrorCode) {
    super(`Verification record refused (${code})`);
    this.name = 'VerificationRecordError';
  }
}

const { id, sha, digest, time } = SCHEMA_TYPES;
export const VERIFICATION_RECORD_SCHEMA = strictObject({
  schemaVersion: { const: VERIFICATION_RECORD_VERSION },
  runId: id,
  candidateSha: sha,
  baseSha: sha,
  parentSha: sha,
  profileDigest: digest,
  profile: PROFILE_SCHEMA,
  networkPolicy: strictObject({
    provisioning: { const: 'package_proxy' },
    verification: { const: 'none' },
  }),
  commands: COMMANDS_SCHEMA,
  regression: { enum: REGRESSION_PROOFS },
  verdict: { enum: VERIFICATION_VERDICTS },
  boundaryHeld: { type: 'boolean' },
  boundaryInputRef: strictObject({
    artifact: { type: 'string', pattern: BOUNDARY_ARTIFACT.source },
    digest,
  }),
  logsDigests: { type: 'array', minItems: 1, maxItems: 256, uniqueItems: true, items: digest },
  verifiedAt: time,
  recordDigest: digest,
});
const validate = new Ajv({ strict: true }).compile<VerificationRecord>(VERIFICATION_RECORD_SCHEMA);

const isRegressionCommand = (command: CommandEvidence) =>
  command.id.endsWith(REGRESSION_COMMAND_SUFFIX);

/** The one rule for a `passed` verdict: the regression was reproduced on the base and
 * fixed here, a passed regression command and a required suite command show it, and the
 * evidence is receipt-grade. */
export function receiptGrade(
  regression: RegressionProof,
  commands: readonly CommandEvidence[]
): boolean {
  return (
    regression === 'reproduced_and_fixed' &&
    commands.some((c) => isRegressionCommand(c) && c.status === 'passed') &&
    commands.some((c) => !isRegressionCommand(c) && c.required) &&
    evidenceVerified(commands)
  );
}

function digestOf(record: Omit<VerificationRecord, 'recordDigest'>): string {
  return sha256(canonicalJson(record, MAX_RECORD_BYTES));
}

/** Facts the schema cannot express: its own digest, base equals parent, unique command
 * ids, every command log among the record's logs, a regression claim backed by a passed
 * regression command, and a `passed` verdict only when `receiptGrade`. */
function isConsistent(record: VerificationRecord): boolean {
  const { recordDigest, ...body } = record;
  const ids = record.commands.map((c) => c.id);
  return (
    recordDigest === digestOf(body) &&
    record.baseSha === record.parentSha &&
    new Set(ids).size === ids.length &&
    record.commands.every((c) => record.logsDigests.includes(c.sanitizedLogDigest)) &&
    (record.regression !== 'reproduced_and_fixed' ||
      record.commands.some((c) => isRegressionCommand(c) && c.status === 'passed')) &&
    (record.verdict !== 'passed' || receiptGrade(record.regression, record.commands))
  );
}

function verificationDir(artifactsDir: string): string {
  return path.join(artifactsDir, VERIFICATION_DIRECTORY);
}

function recordPath(artifactsDir: string, candidateSha: string, suffix = '.json'): string {
  if (typeof candidateSha !== 'string' || !SHA.test(candidateSha))
    throw new VerificationRecordError('invalid_record');
  return path.join(verificationDir(artifactsDir), `${candidateSha}${suffix}`);
}

function exists(file: string): boolean {
  try {
    return lstatIfPresent(file) !== null;
  } catch {
    throw new VerificationRecordError('unavailable');
  }
}

/** `recorded` when a record entry exists (even a broken one), `attempted` when only a
 * started verification left its marker (an interrupted attempt), else `none`. */
export function verificationState(
  artifactsDir: string,
  candidateSha: string
): 'none' | 'attempted' | 'recorded' {
  const record = recordPath(artifactsDir, candidateSha);
  try {
    assertDirectoryAncestors(verificationDir(artifactsDir));
  } catch {
    throw new VerificationRecordError('unavailable');
  }
  if (exists(record)) return 'recorded';
  return exists(recordPath(artifactsDir, candidateSha, ATTEMPT_SUFFIX)) ? 'attempted' : 'none';
}

/** Claims the candidate before any VM work: exactly one caller can, even concurrently
 * (`record_exists` for every other). */
export function beginVerification(artifactsDir: string, candidateSha: string): void {
  const marker = recordPath(artifactsDir, candidateSha, ATTEMPT_SUFFIX);
  if (verificationState(artifactsDir, candidateSha) !== 'none')
    throw new VerificationRecordError('record_exists');
  writeOnce(marker, Buffer.from(`${candidateSha}\n`, 'utf8'));
}

function writeOnce(file: string, bytes: Buffer): void {
  try {
    assertDirectoryAncestors(path.dirname(file));
    privateDir(path.dirname(file));
    createPrivateOnce(file, bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new VerificationRecordError('record_exists');
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

/** Writes the record once, mode 0600, as canonical JSON plus a final newline, and returns
 * it frozen (its digest is `recordDigest`). Throws `invalid_record` for a record the
 * schema or the consistency rules refuse, `record_exists` when one is already there
 * (never replaced, even by a concurrent writer) and `unavailable` on a storage failure. */
export function publishVerification(
  artifactsDir: string,
  input: VerificationRecordInput
): VerificationRecord {
  const body = { schemaVersion: VERIFICATION_RECORD_VERSION, ...input };
  let record: unknown;
  let bytes: Buffer;
  try {
    record = JSON.parse(canonicalJson({ ...body, recordDigest: digestOf(body) }, MAX_RECORD_BYTES));
    bytes = Buffer.from(`${canonicalJson(record, MAX_RECORD_BYTES)}\n`, 'utf8');
  } catch {
    throw new VerificationRecordError('invalid_record');
  }
  if (!validate(record) || !isConsistent(record))
    throw new VerificationRecordError('invalid_record');
  writeOnce(recordPath(artifactsDir, record.candidateSha), bytes);
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
    // Unvalidated shape: `runBoundaryVerdict` fails any malformed input, and a throw is caught.
    const input: unknown = JSON.parse(decode(bytes));
    held = isCleanHeldVerdict(runBoundaryVerdict([input as never], record.runId));
  } catch {
    throw new VerificationRecordError('evidence_mismatch');
  }
  if (held !== record.boundaryHeld) throw new VerificationRecordError('evidence_mismatch');
}

/** Each log digest names a persisted log artifact (`logArtifactName`) whose own digest
 * and truncation flag agree with its name. */
function assertLogEvidence(artifactsDir: string, record: VerificationRecord): void {
  for (const logDigest of record.logsDigests) {
    let found = false;
    for (const truncated of [false, true]) {
      const file = path.join(artifactsDir, logArtifactName(logDigest, truncated));
      if (!exists(file)) continue;
      let artifact: { digest?: unknown; outputTruncated?: unknown };
      try {
        artifact = JSON.parse(decode(readEvidence(file)));
      } catch {
        throw new VerificationRecordError('evidence_mismatch');
      }
      if (artifact?.digest !== logDigest || artifact.outputTruncated !== truncated)
        throw new VerificationRecordError('evidence_mismatch');
      found = true;
    }
    if (!found) throw new VerificationRecordError('evidence_mismatch');
  }
}

export interface LoadVerificationOptions {
  /** The run the record must belong to. */
  readonly runId: string;
  /** The controller-held `recordDigest` from `verifyCandidate`, when the caller kept it. */
  readonly expectedDigest?: string;
}

/** Reads and validates a record: no-follow, single-link, private-mode reads under real
 * directories, strict UTF-8, at most 1 MiB, the exact canonical bytes it was written as,
 * the strict schema (unknown or missing fields fail), the consistency rules, the expected
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
    assertDirectoryAncestors(path.dirname(file));
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
  if (!validate(record) || !isConsistent(record))
    throw new VerificationRecordError('invalid_record');
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

/** The only route from a record to a receipt (#1105): a `passed` verdict (which the
 * consistency rules already tie to `receiptGrade`) on a boundary that held. */
export function assertShippableVerification(record: VerificationRecord): void {
  if (record.verdict !== 'passed' || record.boundaryHeld !== true || !isConsistent(record))
    throw new VerificationRecordError('not_shippable');
}
