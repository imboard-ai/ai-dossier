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
import * as path from 'node:path';
import type { SetupInfo } from './groundtruth';
import type { ExecFn } from './project';
import type { CleanupStatus } from './types';

/** Timeout for teardown subprocesses — pool return shells out through npx and recycles a worktree (git ops), which is slow. */
export const TEARDOWN_TIMEOUT_MS = 120_000;

/**
 * Pool CLI invocation. Requires ≥0.6.0 — `status --json`, `return --json`,
 * and the `verification.entry_status` self-check (#453) all landed there, so
 * `^0.5.1` (which resolves to ≤0.5.3) cannot ever satisfy the JSON contract
 * and every pool teardown would record `failed-pool-return`. Versions ≤0.5.0
 * additionally carry the data-loss `gc` bug — never pin lower.
 */
const POOL_BIN = 'npx';
const POOL_ARGS_PREFIX = ['-y', '@ai-dossier/worktree-pool@^0.6.0'];

/** The outcome recorded on the entry's `cleanup` and in the journal. */
export interface TeardownResult {
  /** `done` or `failed-<step>` — the entry's `cleanup` value verbatim. */
  cleanup: CleanupStatus;
  /** Human-readable detail for the journal (empty when none). */
  detail: string;
}

/** Whether a path exists (injectable so tests need no filesystem). */
export type FsExists = (p: string) => boolean;

/**
 * Containment check for a worktree path recovered from an issue comment
 * (#468): the path must be absolute and fully resolved (no `..`/`.`/symlink
 * variance), and — for COLD worktrees — live under one of the two worktree
 * roots this project uses: `<repo>/worktrees/` (setup-issue-workflow's
 * inside-repo convention) or `<repo>/../worktrees/` (the AGENTS.md sibling
 * convention). A crafted milestone can otherwise make the scheduler
 * `git worktree remove --force` ANY registered worktree — including a
 * parallel agent's (CWE-22). Pool-claimed worktrees are validated by the
 * pool itself (return only accepts paths in pool state), so containment
 * applies to the cold path only.
 */
export function isSafeWorktree(repoRoot: string, worktree: string): boolean {
  if (worktree.includes('\0')) return false;
  if (!path.isAbsolute(worktree)) return false;
  if (path.resolve(worktree) !== worktree) return false;
  const roots = [path.resolve(repoRoot, 'worktrees'), path.resolve(repoRoot, '..', 'worktrees')];
  return roots.some((root) => worktree.startsWith(root + path.sep));
}

/** The repo's toplevel directory (containment root), or null when git cannot say. */
function repoToplevel(exec: ExecFn, repoDir: string): string | null {
  const out = exec('git', ['rev-parse', '--show-toplevel'], repoDir);
  return out !== null && path.isAbsolute(out) ? path.resolve(out) : null;
}

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
  // The worktree path originates from an issue comment written by the spawned
  // agent — validate it before any destructive subprocess (CWE-22).
  if (info.worktree.includes('\0') || !path.isAbsolute(info.worktree)) {
    return {
      cleanup: 'failed-invalid-worktree',
      detail: `worktree path rejected (must be absolute): ${info.worktree}`,
    };
  }
  if (info.poolClaimed) {
    // Pool membership is validated by the pool's own `return` (it only
    // accepts paths in pool state) — no local containment root applies.
    return poolReturn(exec, repoDir, info.worktree);
  }
  const root = repoToplevel(exec, repoDir) ?? path.resolve(repoDir);
  if (!isSafeWorktree(root, info.worktree)) {
    return {
      cleanup: 'failed-invalid-worktree',
      detail: `worktree path rejected (must be a resolved path under the repo's worktrees root ${path.join(root, 'worktrees')}): ${info.worktree}`,
    };
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
        'worktree-pool return failed (non-zero exit, timeout, or npx unavailable) — entry left unverified; inspect `worktree-pool status`',
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
      detail: 'git worktree remove failed (non-zero exit or timeout)',
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
