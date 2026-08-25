# Issue #453: worktree-pool: partial `return` failure leaves state 'assigned' + dirty dir, while callers report success

## Problem

`returnWorktree()` (`packages/worktree-pool/src/pool-actions.ts:810`) recycles an assigned pool
worktree back to `warm`. Its failure handling has two defects that together let a caller report
success over a pool that is actually broken:

1. **Failure destroys the worktree and erases the record.** The `catch` block calls
   `destroyWorktree()` on both the old and new paths and then `removeWorktree(state, entry.id)` —
   the entry vanishes from `.pool-state.json` entirely. A `return --path` that errors at the
   re-branch step therefore eats the directory *and* leaves nothing behind that says why. If
   `destroyWorktree` itself refuses (provenance unproven), the directory survives on disk with no
   state entry at all — the "inconsistent state" from the issue.
2. **A failure before the `recycling` mark, or one that never reaches the CLI, leaves `assigned`.**
   The entry is only flipped `recycling` → `warm` at the very end; any earlier throw that a caller
   swallows leaves it `assigned` with a dirty directory, which is exactly what the 2026-08-24 fleet
   run recorded (`cleanup=pool_returned` posted while the pool still said `assigned`, imboard#3692).

There is also no cheap way for a caller (a dossier ship tail) to *check*: `worktree-pool status`
prints human text only — no `--json` — so "did the return actually happen" cannot be asserted.

No clarifying comments on the issue; the body's four ACs are the spec.

## Acceptance Criteria

- [ ] AC1 `return` is transactional in outcome: on ANY failure it leaves the entry in a `broken`-classified state (not `assigned`, not `warm`) and exits non-zero with the failed step named.
- [ ] AC2 On success it verifies before exiting: entry `warm`, directory clean, temp branch checked out — a final self-check, printed.
- [ ] AC3 Callers can verify cheaply: `worktree-pool status --json` includes per-entry state so a dossier can assert the return actually happened.
- [ ] AC4 Tests for the partial-failure paths (dirty dir blocking re-branch; missing admin dir).

## Approach

1. **Add `'broken'` to `WorktreeStatus`** (`types.ts`) plus two optional diagnostic fields on
   `PoolWorktree` — `broken_step` and `broken_reason` — so a broken entry says *which* step failed
   without a caller re-deriving it. `getPoolStatus()` already buckets anything that is not
   warm/assigned/creating into `other`, and `claimWorktree()` only ever selects `warm`, so a broken
   entry is inert to `claim` with no extra guard.
2. **Restructure `returnWorktree()` as named steps.** Wrap each git/fs operation in a `step()`
   helper that tags any throw with the step name (`fetch`, `checkout-temp-branch`, `clean`,
   `rename`, `repair`, `warm-commands`, `commit-state`, `verify`). Track the worktree's *actual*
   current path and temp branch as the steps progress, so the failure record points at where the
   directory really is after a partial rename.
3. **Replace destroy-on-failure with mark-broken.** The `catch` block stops calling
   `destroyWorktree`/`removeWorktree` and instead updates the entry in place: `status: 'broken'`,
   `path` = wherever the directory now is, `temp_branch` = whichever branch is actually checked out,
   `broken_step` / `broken_reason` set. It rethrows a `ReturnFailure` naming the step; the CLI's
   existing `catch` prints it and exits 1 (AC1). Not destroying is the point of the issue — the
   directory is preserved for `gc`/human repair, and provenance stays intact so `gc` can still
   remove it later.
4. **Add the success self-check (AC2).** After the state commit, re-read state and assert: entry
   `status === 'warm'`, `git status --porcelain` empty in the recycled directory, and
   `git rev-parse --abbrev-ref HEAD` equals the new temp branch. Return the three facts from
   `returnWorktree()` as a `ReturnResult`; the CLI prints them. A failed self-check goes through the
   same mark-broken path with `step: 'verify'` — success is never claimed over an unverified pool.
5. **Add `status --json` (AC3).** New flag on the CLI `status` command that emits the whole status
   object (which already carries `worktrees[]` with per-entry `status`, plus `foreign`/`broken`
   reports) as JSON on stdout. Keeps the human output byte-identical when the flag is absent.
6. **Tests (AC4)** in a new `src/__tests__/pool-return.test.ts`, using the existing `createTempRepo`
   fixture and `runPool` pattern: dirty-dir-blocks-re-branch, missing-admin-dir, success self-check,
   and `status --json` shape.
7. **Bump `packages/worktree-pool` 0.5.3 → 0.5.4** — the repo's `version-bump` CI check requires it
   for any change under `packages/worktree-pool/src`.

## Reachability Evidence

- State: `broken` pool entry after a failed `return` | Trigger: any git/fs failure inside
  `returnWorktree` (dirty tree blocking `checkout -b`, missing `.git` admin dir, rename target
  exists) | Prod check: **N/A — not a data-reachable state.** This is local developer/agent CLI
  state in `.pool-state.json`; there is no production datastore to count against, so the
  `prod_data_access` (mongodb-prod) check does not apply. | Verdict: **reachable, evidenced by a
  real incident** — the issue cites the 2026-08-24 fleet run (imboard#3692) where a return left the
  entry `assigned` with a dirty directory while the caller reported `cleanup=pool_returned`, and a
  second occurrence where `return --path` errored at re-branch and destroyed the worktree. Both are
  the failure paths this change classifies.

## Files to Modify

- `packages/worktree-pool/src/types.ts` — add `'broken'` to `WorktreeStatus`; add optional
  `broken_step` / `broken_reason` to `PoolWorktree`.
- `packages/worktree-pool/src/pool-actions.ts` — restructure `returnWorktree()` into named steps,
  mark-broken instead of destroy-on-failure, add the success self-check, export `ReturnResult` /
  `ReturnFailure`.
- `packages/worktree-pool/src/cli.ts` — `status --json`; print the return self-check; print the
  failed step on a `return` failure.
- `packages/worktree-pool/src/index.ts` — export the new `ReturnResult` / `ReturnFailure` types.
- `packages/worktree-pool/src/__tests__/pool-return.test.ts` — **new**, the AC4 partial-failure tests.
- `packages/worktree-pool/package.json` — version 0.5.3 → 0.5.4.

## Reusable Code

- `pool-state.ts:classifyPoolDirEntry()` — already computes an on-disk `broken` flag (missing git
  admin dir). The new entry `status: 'broken'` is the *state-side* counterpart; do not duplicate the
  on-disk detection, and keep the entry `owned` so `gc` can still clear it.
- `pool-actions.ts:withLock()` / `pool-state.ts:updateWorktree()` — the existing atomic
  read-modify-write; the mark-broken path must use them, not a bare `writeState`.
- `pool-actions.ts:isWorktreeAdminDirMissing()` / `resolveWorktreeAdminDir()` — reuse for the
  missing-admin-dir test setup and any verify-step probing.
- `pool-state.ts:getPoolStatus()` — already returns `worktrees[]` with per-entry `status`; `--json`
  just serializes it, no new aggregation.
- `src/__tests__/helpers/setup.ts:createTempRepo()` and `pool-cli.test.ts`'s `runPool` /
  `runPoolCombined` / `readPoolState` helpers — the new test file mirrors them.

## Risk Areas

- **Behaviour change: failure no longer cleans up.** A broken directory now persists where it used
  to be destroyed. That is the issue's explicit request (silent destruction was the bug), but it
  means the pool can accumulate broken entries; they are visible in `status` and removable by `gc`,
  which is the documented human repair path. Callers must not treat a non-zero `return` as "pool is
  fine".
- **`findStaleWorktrees()` excludes only `assigned`,** so a `broken` entry becomes gc-eligible after
  `stale_after_hours`. That is acceptable (gc is human-run and owns cleanup) — but worth stating so
  it is a decision, not an accident.
- **Partial rename.** If `fs.renameSync` succeeded but `worktree repair` failed, the directory is at
  the new path while state holds the old one. The failure record must write the *actual* path or the
  entry becomes an orphan that `gc` cannot match.
- **Provenance must survive.** The broken entry has to stay `owned` by `classifyPoolDirEntry` — if
  the recorded `temp_branch` does not match what is checked out, the entry classifies `foreign` and
  `gc` will refuse to clean it forever (#438's refusal logic).
- **No `docs/agent-traps.md`** in this repo — nothing to grep.
- Version bump is required by the `version-bump` CI check for `packages/worktree-pool/src` changes.

## Test Strategy

- New `src/__tests__/pool-return.test.ts` (real git repos via `createTempRepo`, `describe.sequential`
  like the sibling CLI suite):
  - **dirty dir blocks re-branch** — replenish, claim, commit a divergent change on the assigned
    branch plus leave a conflicting uncommitted edit so `git checkout -b <temp> origin/main` fails;
    assert exit code ≠ 0, stderr names the failing step, `.pool-state.json` entry is `status:
    'broken'` (not `assigned`, not `warm`), and the directory still exists.
  - **missing admin dir** — claim, delete the worktree's `.git` admin dir, `return`; assert non-zero
    exit, step named, entry `broken`.
  - **success self-check** — replenish, claim, return; assert exit 0, the printed self-check lines,
    entry back to `warm`, clean directory, `pool/spare-*` checked out.
  - **`status --json`** — assert valid JSON with `worktrees[].status` per entry, and that a caller
    can read `warm` after a successful return.
- Existing suites to re-run: `npm run test -w packages/worktree-pool` (122 tests green on the base
  branch — baseline recorded in WARMUP-STATUS.md), plus `packages/core`, `cli`, `mcp-server` for the
  workspace-wide check, and `npx biome check .`.

## Open Questions

(none — the four ACs are unambiguous and the failure paths are all local git/fs)

## Visual Review

- [x] Not required (backend/infra only — CLI + library, no frontend files touched)

## Base Branch

`main` — PRs for this issue target this branch.
