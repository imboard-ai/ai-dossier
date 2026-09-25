/**
 * `sched attach-pr --batch <id> <pr>` (#824): the operator's explicit, auditable
 * way to record `batch.pr` when #789's automatic detection refused to guess
 * (`pr-detect-ambiguous` — two or more merged PRs share the batch branch), and
 * the scripted form of the `batch-integrate` dossier's manual-recovery step
 * that hand-records a batch PR (the registry dossier's Step 6b).
 *
 * Trust boundary: the operator's word is not evidence. The named PR must pass
 * the SAME candidate checks #789's automatic path applies
 * (`checkBatchPrCandidate`) plus an explicit `state === 'MERGED'` and a
 * positively-read same-repo flag, read through a ground truth pinned with `-R`
 * to the verified project repository — absent that pin, nothing is read and
 * nothing is recorded. There is no `--force`: every check reads a field
 * `gh pr view` always returns, so an unreadable one refuses rather than
 * inviting an override.
 *
 * Recording is ALL this does: `batch.pr` is set (and any
 * `pr_detect_ambiguous_*` streak cleared) under the store lock, with no status
 * transition and no GitHub write. The next engine tick's
 * `reconcileStaleBlockedBatches` then settles the batch on its ordinary
 * `pr-merged` evidence, and the anchor closes (or not) only through #768's own
 * evidence-gated `reconcileAnchorClosure` — which never reads `batch.pr`.
 */

import { undispatchedSurvivingMembers } from './batch-dispatch';
import type { BatchPrCheck, GroundTruth } from './groundtruth';
import { checkBatchPrCandidate } from './groundtruth';
import type { Journal } from './journal';
import { unitEvent } from './journal';
import type { SchedStore } from './persist';
import { CLEARED_PR_DETECT_AMBIGUOUS_FIELDS, findBatch, patchBatch } from './state';
import { type BatchEntry, SchedNotFoundError, type SchedState } from './types';

export interface AttachPrDeps {
  store: SchedStore;
  journal: Journal;
  /** Must come from `createExecGroundTruth` with a verified `repo` — else `batchPrCandidate` is absent and the attach refuses. */
  groundTruth: GroundTruth;
  /** The verified `owner/name` the ground truth is pinned to — named in refusals and the journal line. */
  repo?: string;
}

export type AttachPrResult =
  | {
      outcome: 'attached';
      pr: number;
      mergedAt: string;
      /** Ticks of the `pr-detect-ambiguous` streak this attach cleared (0 when none was open). */
      clearedAmbiguousTicks: number;
    }
  | { outcome: 'already-attached'; pr: number };

/** A batch the ledger checks passed on: blocked, no PR yet, a branch to check the PR's head against. */
type AttachableBatch = BatchEntry & { branch: string };

/**
 * Why each shared candidate check refuses, in operator words. `number` and
 * `fork` are pre-empted by `verifyCandidate`'s own stricter checks and exist
 * for the record's exhaustiveness (`fork` is also used directly there).
 */
const CHECK_REFUSALS: Record<
  BatchPrCheck,
  (pr: Record<string, unknown>, batch: AttachableBatch) => string
> = {
  fork: () => 'it is from a fork (isCrossRepository=true), not the project repository',
  head: (pr, batch) =>
    `its head is ${JSON.stringify(pr.headRefName)}, not the batch branch ${JSON.stringify(batch.branch)}`,
  base: (pr, batch) =>
    `its base is ${JSON.stringify(pr.baseRefName)}, not the batch base ${JSON.stringify(batch.base_branch)}`,
  unmerged: () => 'it has no merge timestamp — not merged',
  'created-before-batch': (pr, batch) =>
    `it was created ${JSON.stringify(pr.createdAt)}, before the batch itself (${batch.created_at}) — a PR from an earlier use of the branch`,
  number: () => 'gh returned no usable PR number',
};

/** The one refusal shape every PR-level refusal uses. */
function refusal(batchId: string, pr: number, why: string): SchedNotFoundError {
  return new SchedNotFoundError(`Refusing to attach PR #${pr} to batch ${batchId}: ${why}`);
}

/**
 * The ledger-only preconditions, re-run under the lock on fresh state.
 * Throws `SchedNotFoundError` naming why on every refusal.
 */
function precheck(
  state: SchedState,
  batchId: string,
  pr: number
): { noop: true } | { noop: false; batch: AttachableBatch } {
  const batch = findBatch(state, batchId);
  if (!batch) throw new SchedNotFoundError(`Batch not found: ${batchId}`);
  if (batch.pr === pr) return { noop: true };
  if (batch.pr !== null) {
    throw new SchedNotFoundError(
      `Batch ${batchId} already has PR #${batch.pr} recorded — refusing to replace it with #${pr}`
    );
  }
  if (batch.status !== 'blocked') {
    throw new SchedNotFoundError(
      `Batch ${batchId} is ${batch.status} — attach-pr only applies to a blocked batch (the state whose merge evidence reconcileStaleBlockedBatches settles from a recorded PR)`
    );
  }
  const { branch } = batch;
  if (branch === null) {
    throw new SchedNotFoundError(
      `Batch ${batchId} has no branch recorded — nothing to check PR #${pr}'s head against`
    );
  }
  // The reconcile never settles a batch with a surviving member that was never
  // dispatched (it would call an issue `done` that shipped nothing), so a PR
  // recorded here would sit unused forever — refuse instead of reporting a
  // reconcile that will not happen.
  const undispatched = undispatchedSurvivingMembers(state, batch);
  if (undispatched.length > 0) {
    throw new SchedNotFoundError(
      `Batch ${batchId} has member(s) ${undispatched.map((m) => `#${m}`).join(', ')} that were never dispatched — the stale-blocked reconcile will not settle it on PR evidence (it would mark unshipped work done); \`sched abandon --batch ${batchId}\` requeues them instead`
    );
  }
  return { noop: false, batch: { ...batch, branch } };
}

/** Refuse unless `candidate` is provably the batch's own merged PR `pr`; returns its merge time. */
function verifyCandidate(
  candidate: Record<string, unknown>,
  batch: AttachableBatch,
  pr: number
): string {
  if (candidate.number !== pr) {
    throw refusal(
      batch.id,
      pr,
      `gh answered for PR ${JSON.stringify(candidate.number)}, not #${pr}`
    );
  }
  if (candidate.state !== 'MERGED') {
    throw refusal(batch.id, pr, `it is ${JSON.stringify(candidate.state)}, not MERGED`);
  }
  // Positive evidence only: `checkBatchPrCandidate` treats a MISSING flag as
  // "not a fork" (its #789 list convention); an operator-named PR must be
  // read as same-repo explicitly.
  if (candidate.isCrossRepository !== false) {
    throw refusal(
      batch.id,
      pr,
      candidate.isCrossRepository === true
        ? CHECK_REFUSALS.fork(candidate, batch)
        : 'gh did not report whether it is from the project repository or a fork (isCrossRepository unreadable)'
    );
  }
  const verdict = checkBatchPrCandidate(
    candidate,
    batch.branch,
    batch.base_branch,
    Date.parse(batch.created_at)
  );
  if (!verdict.ok) throw refusal(batch.id, pr, CHECK_REFUSALS[verdict.check](candidate, batch));
  return verdict.mergedAt;
}

/** The `pr-attached` journal line's `detail`. */
function attachedDetail(
  prRef: string,
  mergedAt: string,
  batch: AttachableBatch,
  clearedAmbiguousTicks: number
): string {
  return (
    `operator attached ${prRef} (MERGED ${mergedAt}, head=${batch.branch}, base=${batch.base_branch}, same repository) — recorded batch.pr` +
    (clearedAmbiguousTicks > 0
      ? `; cleared the pr-detect-ambiguous streak (${clearedAmbiguousTicks} tick(s))`
      : '') +
    '; the next engine tick reconciles the batch on pr-merged evidence — the anchor is left to #768'
  );
}

/**
 * Record an operator-named PR as `batch.pr` after verifying it (see the module
 * comment). Throws `SchedNotFoundError` — nothing written, nothing journaled —
 * on every refusal; returns `already-attached` (also nothing written) when the
 * same PR is already recorded.
 */
export function attachBatchPr(
  deps: AttachPrDeps,
  batchId: string,
  pr: number,
  now: Date = new Date()
): AttachPrResult {
  if (!Number.isInteger(pr) || pr <= 0) {
    throw new SchedNotFoundError(`PR must be a positive integer, got ${pr}`);
  }
  const first = precheck(deps.store.load(), batchId, pr);
  if (first.noop) return { outcome: 'already-attached', pr };

  const repo = deps.repo ?? 'the project repository';
  const read = deps.groundTruth.batchPrCandidate;
  if (read === undefined) {
    throw refusal(
      batchId,
      pr,
      "the project's GitHub repository is not verified, so the PR cannot be read with a pinned -R — run from the project's own checkout (or check --project)"
    );
  }
  const candidate = read(pr);
  if (candidate === undefined) {
    throw refusal(
      batchId,
      pr,
      `could not read it from ${repo} (\`gh pr view ${pr} -R ${repo}\` failed or returned an unusable payload — see the stderr line above) — nothing recorded`
    );
  }
  verifyCandidate(candidate, first.batch, pr);

  // The GitHub read ran outside the lock: re-run the ledger checks AND the
  // candidate checks against the fresh batch, so a batch that left `blocked`,
  // had a PR recorded, or changed its branch/base meanwhile is refused rather
  // than written over.
  const applied = deps.store.withLock((s) => {
    const fresh = precheck(s, batchId, pr);
    if (fresh.noop) return { state: s, result: null };
    const mergedAt = verifyCandidate(candidate, fresh.batch, pr);
    // `updated_at` IS touched (unlike the dedup writes): an operator attach is
    // real activity, and it re-arms the stale-blocked reconcile window
    // (measured from `updated_at`), so the PR is acted on even when the batch
    // had been blocked longer than that window.
    return {
      state: patchBatch(s, batchId, { pr, ...CLEARED_PR_DETECT_AMBIGUOUS_FIELDS }, now),
      result: {
        batch: fresh.batch,
        mergedAt,
        clearedAmbiguousTicks: fresh.batch.pr_detect_ambiguous_ticks,
      },
    };
  });
  if (applied === null) return { outcome: 'already-attached', pr };

  deps.journal.append(
    unitEvent('pr-attached', `batch:${batchId}`, {
      pr,
      mergedAt: applied.mergedAt,
      branch: applied.batch.branch,
      detail: attachedDetail(
        deps.repo !== undefined ? `${deps.repo}#${pr}` : `PR #${pr}`,
        applied.mergedAt,
        applied.batch,
        applied.clearedAmbiguousTicks
      ),
    }),
    now
  );
  return {
    outcome: 'attached',
    pr,
    mergedAt: applied.mergedAt,
    clearedAmbiguousTicks: applied.clearedAmbiguousTicks,
  };
}
