import { assertSecretFree } from '../redaction';
import {
  isRecord,
  isTimestamp,
  ReasonCode,
  type RunRecord,
  sameRunRecord,
  transitionRun,
} from '../state';
import {
  type CheckpointBindings,
  type CheckpointPoint,
  type CheckpointRecord,
  checkpointBindings,
  checkpointFail,
  checkpointPhase,
  checkpointResumeReason,
  checkpointSnapshot,
  newCheckpoint,
  restoreCheckpoint,
  sameCheckpointBindings,
} from './checkpoint-record';
import type { RunStore } from './run-store';

export * from './checkpoint-record';

/** Only persisted user config is consulted by pauseAtCheckpoint. */
export function checkpointDue(
  checkpoints: readonly CheckpointPoint[],
  point: CheckpointPoint
): boolean {
  checkpointPhase(point);
  if (!Array.isArray(checkpoints) || new Set(checkpoints).size !== checkpoints.length)
    checkpointFail('checkpoint_invalid');
  for (const value of checkpoints) checkpointPhase(value);
  return checkpoints.includes(point);
}
function current(store: RunStore, run: RunRecord, now: Date | string): string {
  if (!sameRunRecord(run, store.run)) checkpointFail('checkpoint_stale');
  if (now instanceof Date && !Number.isFinite(now.getTime())) checkpointFail('checkpoint_invalid');
  const at = now instanceof Date ? now.toISOString() : now;
  if (!isTimestamp(at) || Date.parse(at) < Date.parse(run.updatedAt))
    checkpointFail('checkpoint_invalid');
  return at;
}
export function pauseAtCheckpoint(
  store: RunStore,
  run: RunRecord,
  point: CheckpointPoint,
  bindings: CheckpointBindings,
  now: Date | string
): RunRecord {
  const at = current(store, run, now);
  if (!checkpointDue(store.config.checkpoints, point)) return store.run;
  const existing = store.checkpoint(point);
  if (existing?.status !== undefined && existing.status !== 'open') return store.run;
  const record = newCheckpoint(run, point, bindings, at);
  if (existing) {
    if (!sameCheckpointBindings(record.bindings, existing.bindings))
      checkpointFail('checkpoint_stale');
    if (
      run.state === 'paused_user' &&
      run.history.length === existing.interruptedHistoryLength + 1 &&
      run.history.at(-1)?.from === existing.interruptedState
    )
      return store.run;
    if (
      run.state !== existing.interruptedState ||
      run.history.length !== existing.interruptedHistoryLength
    )
      checkpointFail('checkpoint_not_open');
  } else {
    if (run.state !== checkpointPhase(point)) checkpointFail('checkpoint_not_open');
    store.recordCheckpointBindings(point, record.bindings);
    store.persistCheckpoint(record);
  }
  store.persistRun(transitionRun(store.run, ReasonCode.UserPaused, at));
  return store.run;
}
function openCheckpoint(
  store: RunStore,
  run: RunRecord,
  answer: unknown,
  now: Date | string,
  requireFresh = true
): { record: CheckpointRecord; at: string } {
  const at = current(store, run, now);
  const value = checkpointSnapshot(answer);
  assertSecretFree(value);
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !['point', 'digest'].includes(key)) ||
    typeof value.digest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.digest)
  )
    checkpointFail('checkpoint_invalid');
  checkpointPhase(value.point);
  const record = store.checkpoint(value.point as CheckpointPoint);
  if (record && record.status !== 'open') checkpointFail('checkpoint_closed');
  if (
    !record ||
    run.state !== 'paused_user' ||
    run.history.length !== record.interruptedHistoryLength + 1 ||
    run.history.at(-1)?.from !== record.interruptedState
  )
    checkpointFail('checkpoint_not_open');
  const bindings = store.currentCheckpointBindings(record.point);
  if (
    value.digest !== record.digest ||
    (requireFresh && (!bindings || !sameCheckpointBindings(bindings, record.bindings)))
  )
    checkpointFail('checkpoint_stale');
  return { record, at };
}
export function approveCheckpoint(
  store: RunStore,
  run: RunRecord,
  answer: { point: CheckpointPoint; digest: string },
  now: Date | string
): RunRecord {
  const { record, at } = openCheckpoint(store, run, answer, now);
  const reason = checkpointResumeReason(record.point);
  store.resolveCheckpoint(
    restoreCheckpoint({ ...record, status: 'approved', resolvedAt: at }),
    transitionRun(run, reason, at)
  );
  return store.run;
}
export function rejectCheckpoint(
  store: RunStore,
  run: RunRecord,
  answer: { point: CheckpointPoint; digest: string },
  reason: string,
  now: Date | string
): RunRecord {
  const { record, at } = openCheckpoint(store, run, answer, now, false);
  store.resolveCheckpoint(
    restoreCheckpoint({ ...record, status: 'rejected', resolvedAt: at, rejectionReason: reason }),
    transitionRun(run, ReasonCode.UserCancelled, at)
  );
  return store.run;
}
export function checkpointStatus(
  input: CheckpointRecord,
  currentBindings?: CheckpointBindings
): { nextPermittedAction: string } {
  const record = restoreCheckpoint(input);
  const review =
    record.point === 'plan'
      ? 'plan text at artifacts/plan.txt'
      : record.point === 'patch'
        ? `candidate ${record.bindings.candidateSha} and diff at artifacts/candidate.diff`
        : `candidate ${record.bindings.candidateSha} and verification summary at artifacts/verification.json`;
  const stale =
    currentBindings !== undefined &&
    !sameCheckpointBindings(
      checkpointBindings(currentBindings, record.point, record.runId),
      record.bindings
    );
  const nextPermittedAction =
    record.status === 'open'
      ? stale
        ? `Checkpoint ${record.point} is stale; reject with <zt-run> reject --run ${record.runId} --point ${record.point} --digest ${record.digest} --reason <reason>.`
        : `Checkpoint ${record.point}: review ${review}; approve exactly with <zt-run> approve --run ${record.runId} --point ${record.point} --digest ${record.digest}.`
      : `Checkpoint ${record.point} is ${record.status}; no further approval is permitted.`;
  assertSecretFree(nextPermittedAction);
  return { nextPermittedAction };
}
