/**
 * Script-based teardown for merged units (#468 AC2) — the tail work that the
 * fleet pattern used to re-dispatch a whole full-cycle run for.
 *
 * Two scripts, chosen by the run's `setup` milestone:
 * - pool-claimed worktree → `worktree-pool return --path <wt> --json` — the
 *   pool's own self-check (#453: `verification.entry_status`) is the
 *   verification; a non-`warm` entry or a failed exit is a failed step.
 * - cold worktree → `git worktree remove --force <wt>` + a path-gone check
 *   (verify-first, so a re-run after a crash between subprocess and state
 *   write is idempotent).
 *
 * `--force` on the remove is deliberate: the WIP-sync rule pushes everything
 * durable to origin, so untracked leftovers (logs, warmup status) are trash.
 *
 * A failed teardown is DEGRADATION, never unit failure — the PR is already
 * merged. The outcome is recorded as `cleanup=failed-<step>` on the entry and
 * journaled, and the report agent is dispatched regardless so the failure is
 * surfaced in the report.
 *
 * Everything runs through an injectable `ExecFn` (the project.ts pattern) —
 * tests script the subprocesses, no real pool or git is touched.
 */

import * as fs from 'node:fs';
import type { SetupInfo } from './groundtruth';
import type { ExecFn } from './project';

/** Timeout for teardown subprocesses — pool return shells out through npx and recycles a worktree (git ops), which is slow. */
export const TEARDOWN_TIMEOUT_MS = 120_000;

/** Pool CLI invocation (the pinned form every other dossier uses; ≤0.5.0 has a data-loss gc). */
const POOL_BIN = 'npx';
const POOL_ARGS_PREFIX = ['-y', '@ai-dossier/worktree-pool@^0.5.1'];

/** The outcome recorded on the entry's `cleanup` and in the journal. */
export interface TeardownResult {
  /** `done` or `failed-<step>` — the entry's `cleanup` value verbatim. */
  cleanup: string;
  /** Human-readable detail for the journal (empty when none). */
  detail: string;
}

/** Whether a path exists (injectable so tests need no filesystem). */
export type FsExists = (p: string) => boolean;

/** Path-listing of `git worktree list --porcelain` (null when the call fails). */
function worktreeList(exec: ExecFn, repoDir: string): string | null {
  return exec('git', ['worktree', 'list', '--porcelain'], repoDir);
}

/** Whether `worktree` still appears in git's worktree listing. */
function listedAsWorktree(exec: ExecFn, repoDir: string, worktree: string): boolean {
  const list = worktreeList(exec, repoDir);
  if (list === null) return true; // unknown — assume still present (conservative)
  return list
    .split('\n')
    .some((line) => line.startsWith('worktree ') && line.slice('worktree '.length) === worktree);
}

/**
 * Run the teardown script for one merged unit. `info` comes from the unit's
 * setup milestone (groundtruth.setupInfo); a missing `info` is the caller's
 * `failed-missing-setup-info` case — this function always has one.
 */
export function runTeardown(
  exec: ExecFn,
  repoDir: string,
  info: SetupInfo,
  fsExists: FsExists = (p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  }
): TeardownResult {
  if (info.poolClaimed) {
    return poolReturn(exec, repoDir, info.worktree);
  }
  return worktreeRemove(exec, repoDir, info.worktree, fsExists);
}

function poolReturn(exec: ExecFn, repoDir: string, worktree: string): TeardownResult {
  // Verify-first idempotency: if the pool already lists this path as a warm
  // (unassigned) spare, a previous return landed and the state write was
  // lost — claim done rather than erroring a second return.
  const statusJson = exec(POOL_BIN, [...POOL_ARGS_PREFIX, 'status', '--json'], repoDir);
  if (statusJson !== null && poolEntryFor(statusJson, worktree) === 'warm') {
    return { cleanup: 'done', detail: 'already returned to pool (idempotent re-run)' };
  }

  const out = exec(
    POOL_BIN,
    [...POOL_ARGS_PREFIX, 'return', '--path', worktree, '--json'],
    repoDir
  );
  if (out === null) {
    return {
      cleanup: 'failed-pool-return',
      detail:
        'worktree-pool return exited non-zero (entry left broken — inspect `worktree-pool status`)',
    };
  }
  // Verified before claimed: the pool's own self-check must report the
  // recycled entry as `warm` — anything else is a failed step.
  const entryStatus = parseReturnVerification(out);
  if (entryStatus === null) {
    return {
      cleanup: 'failed-pool-return',
      detail: 'worktree-pool return produced unparseable output',
    };
  }
  if (entryStatus !== 'warm') {
    return {
      cleanup: 'failed-pool-return',
      detail: `pool self-check reports entry_status=${entryStatus}`,
    };
  }
  return { cleanup: 'done', detail: 'returned to pool as a warm spare' };
}

function worktreeRemove(
  exec: ExecFn,
  repoDir: string,
  worktree: string,
  fsExists: FsExists
): TeardownResult {
  // Verify-first idempotency: already gone → a previous remove landed.
  if (!fsExists(worktree) && !listedAsWorktree(exec, repoDir, worktree)) {
    return { cleanup: 'done', detail: 'worktree already removed (idempotent re-run)' };
  }

  const out = exec('git', ['worktree', 'remove', '--force', '--', worktree], repoDir);
  if (out === null) {
    return {
      cleanup: 'failed-worktree-remove',
      detail: 'git worktree remove exited non-zero',
    };
  }
  // Verified before claimed: the path must be gone AND git must no longer
  // list it — a lingering entry means the removal did not fully land.
  if (fsExists(worktree) || listedAsWorktree(exec, repoDir, worktree)) {
    return {
      cleanup: 'failed-worktree-remove',
      detail: 'worktree still present after git worktree remove',
    };
  }
  return { cleanup: 'done', detail: 'worktree removed' };
}

/** The pool entry status (`warm`/`assigned`/…) for `worktree`, or null when absent/unparseable. */
function poolEntryFor(statusJson: string, worktree: string): string | null {
  try {
    const parsed: unknown = JSON.parse(statusJson);
    if (parsed === null || typeof parsed !== 'object') return null;
    const worktrees = (parsed as { worktrees?: unknown }).worktrees;
    if (!Array.isArray(worktrees)) return null;
    for (const raw of worktrees) {
      if (raw === null || typeof raw !== 'object') continue;
      const entry = raw as { path?: unknown; status?: unknown };
      if (entry.path === worktree && typeof entry.status === 'string') return entry.status;
    }
    return null;
  } catch {
    return null;
  }
}

/** `verification.entry_status` of a successful `return --json`, or null when unparseable. */
function parseReturnVerification(returnJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(returnJson);
    if (parsed === null || typeof parsed !== 'object') return null;
    const verification = (parsed as { verification?: unknown }).verification;
    if (verification === null || typeof verification !== 'object') return null;
    const status = (verification as { entry_status?: unknown }).entry_status;
    return typeof status === 'string' ? status : null;
  } catch {
    return null;
  }
}
