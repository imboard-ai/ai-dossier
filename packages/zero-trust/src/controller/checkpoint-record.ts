import { createHash } from 'node:crypto';
import { assertSecretFree } from '../redaction';
import { isRecord, isTimestamp, ReasonCode, type RunRecord } from '../state';

export type CheckpointPoint = 'plan' | 'patch' | 'verification';
export type CheckpointPhase = 'planning' | 'verifying' | 'shipping';
export interface CheckpointBindings {
  readonly planDigest?: string;
  readonly candidateSha?: string;
  readonly verificationDigest?: string;
  readonly policyDigest: string;
  readonly budgetSessionId: string;
}
export interface CheckpointRecord {
  readonly point: CheckpointPoint;
  readonly runId: string;
  readonly interruptedState: CheckpointPhase;
  readonly interruptedHistoryLength: number;
  readonly bindings: CheckpointBindings;
  readonly digest: string;
  readonly createdAt: string;
  readonly status: 'open' | 'approved' | 'rejected';
  readonly resolvedAt?: string;
  readonly rejectionReason?: string;
}
export type CheckpointErrorCode =
  | 'checkpoint_stale'
  | 'checkpoint_closed'
  | 'checkpoint_not_open'
  | 'checkpoint_invalid';
export class CheckpointError extends Error {
  constructor(readonly code: CheckpointErrorCode) {
    super(`Checkpoint refused (${code})`);
    this.name = 'CheckpointError';
  }
}
export function checkpointFail(code: CheckpointErrorCode): never {
  throw new CheckpointError(code);
}
/** Native clone failures may echo function source or thrown getter messages. */
export function checkpointSnapshot(input: unknown): unknown {
  try {
    return structuredClone(input);
  } catch {
    return checkpointFail('checkpoint_invalid');
  }
}
export function checkpointResumeReason(point: CheckpointPoint): ReasonCode {
  checkpointPhase(point);
  return point === 'plan'
    ? ReasonCode.ResumePlanning
    : point === 'patch'
      ? ReasonCode.ResumeVerifying
      : ReasonCode.ResumeShipping;
}
export function checkpointPhase(point: unknown): CheckpointPhase {
  if (point === 'plan') return 'planning';
  if (point === 'patch') return 'verifying';
  if (point === 'verification') return 'shipping';
  return checkpointFail('checkpoint_invalid');
}
function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
/** Detach once and hash only validated primitive facts in a canonical order. */
export function checkpointBindings(
  input: unknown,
  point: CheckpointPoint,
  runId: string
): CheckpointBindings {
  checkpointPhase(point);
  const value = checkpointSnapshot(input);
  assertSecretFree(value);
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'planDigest',
          'candidateSha',
          'verificationDigest',
          'policyDigest',
          'budgetSessionId',
        ].includes(key)
    ) ||
    !digest(value.policyDigest) ||
    typeof value.budgetSessionId !== 'string' ||
    !value.budgetSessionId.startsWith(`${runId}-s`) ||
    !/^[1-9][0-9]*$/u.test(value.budgetSessionId.slice(runId.length + 2)) ||
    !Number.isSafeInteger(Number(value.budgetSessionId.slice(runId.length + 2))) ||
    (point === 'plan'
      ? !digest(value.planDigest) ||
        value.candidateSha !== undefined ||
        value.verificationDigest !== undefined
      : value.planDigest !== undefined ||
        typeof value.candidateSha !== 'string' ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.candidateSha) ||
        (point === 'verification'
          ? !digest(value.verificationDigest)
          : value.verificationDigest !== undefined))
  )
    checkpointFail('checkpoint_invalid');
  return Object.freeze({
    ...(point === 'plan'
      ? { planDigest: value.planDigest as string }
      : { candidateSha: value.candidateSha as string }),
    ...(point === 'verification' ? { verificationDigest: value.verificationDigest as string } : {}),
    policyDigest: value.policyDigest,
    budgetSessionId: value.budgetSessionId,
  });
}
export function sameCheckpointBindings(a: CheckpointBindings, b: CheckpointBindings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function recordDigest(
  record: Omit<CheckpointRecord, 'digest' | 'status' | 'resolvedAt' | 'rejectionReason'>
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        point: record.point,
        runId: record.runId,
        interruptedState: record.interruptedState,
        interruptedHistoryLength: record.interruptedHistoryLength,
        bindings: record.bindings,
        createdAt: record.createdAt,
      })
    )
    .digest('hex');
}
export function newCheckpoint(
  run: RunRecord,
  point: CheckpointPoint,
  bindings: CheckpointBindings,
  createdAt: string
): CheckpointRecord {
  const base = {
    point,
    runId: run.runId,
    interruptedState: checkpointPhase(point),
    interruptedHistoryLength: run.history.length,
    bindings: checkpointBindings(bindings, point, run.runId),
    createdAt,
  };
  return restoreCheckpoint({ ...base, digest: recordDigest(base), status: 'open' });
}
export function restoreCheckpoint(input: unknown): CheckpointRecord {
  const value = checkpointSnapshot(input);
  assertSecretFree(value);
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'point',
          'runId',
          'interruptedState',
          'interruptedHistoryLength',
          'bindings',
          'digest',
          'createdAt',
          'status',
          'resolvedAt',
          'rejectionReason',
        ].includes(key)
    ) ||
    typeof value.runId !== 'string' ||
    !/^ztc-[a-f0-9]{16}-run-[1-9][0-9]*$/u.test(value.runId) ||
    value.interruptedState !== checkpointPhase(value.point) ||
    !Number.isSafeInteger(value.interruptedHistoryLength) ||
    Number(value.interruptedHistoryLength) < 0 ||
    !isTimestamp(value.createdAt) ||
    !['open', 'approved', 'rejected'].includes(value.status as string) ||
    (value.status === 'open'
      ? value.resolvedAt !== undefined || value.rejectionReason !== undefined
      : !isTimestamp(value.resolvedAt) ||
        Date.parse(value.resolvedAt) < Date.parse(value.createdAt)) ||
    (value.status === 'rejected'
      ? typeof value.rejectionReason !== 'string' ||
        value.rejectionReason.trim().length === 0 ||
        value.rejectionReason.length > 500
      : value.rejectionReason !== undefined)
  )
    checkpointFail('checkpoint_invalid');
  const record = {
    point: value.point as CheckpointPoint,
    runId: value.runId,
    interruptedState: value.interruptedState as CheckpointPhase,
    interruptedHistoryLength: value.interruptedHistoryLength as number,
    bindings: checkpointBindings(value.bindings, value.point as CheckpointPoint, value.runId),
    createdAt: value.createdAt,
  };
  if (!digest(value.digest) || value.digest !== recordDigest(record))
    checkpointFail('checkpoint_invalid');
  return Object.freeze({
    ...record,
    digest: value.digest,
    status: value.status as CheckpointRecord['status'],
    ...(value.resolvedAt === undefined ? {} : { resolvedAt: value.resolvedAt as string }),
    ...(value.rejectionReason === undefined
      ? {}
      : { rejectionReason: value.rejectionReason as string }),
  });
}
