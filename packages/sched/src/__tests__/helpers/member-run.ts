import type { MemberRun } from '../../index';

/**
 * A minimal, valid `MemberRun` (#809 parallel-dispatch member) with the ones
 * a test cares about spread over it — same "inert defaults, override what
 * you need" convention as `stubGroundTruth` (`./ground-truth.ts`). Used by
 * `#834`'s `keptWorktreeCandidates`/`reconcileKeptWorktrees` tests in both
 * `status.test.ts` and `batch-integration.test.ts`, which previously each
 * defined an identical copy inline.
 */
export function memberRun(patch: Partial<MemberRun> = {}): MemberRun {
  return {
    issue: 901,
    index: 1,
    branch: 'feature/901-x',
    worktree: '/repo/worktrees/batch-b1-901',
    pool_claimed: false,
    status: 'landed',
    gate_inconclusive: null,
    torn_down: false,
    teardown_failed_at: null,
    ...patch,
  };
}
