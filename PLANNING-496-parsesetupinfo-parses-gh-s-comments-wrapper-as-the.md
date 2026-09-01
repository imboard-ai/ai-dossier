# Issue #496: bug(sched): parseSetupInfo parses gh's {"comments":[...]} wrapper as the array — teardown always fails with failed-missing-setup-info

## Problem
`packages/sched/src/groundtruth.ts`'s `setupInfo()` calls `gh issue view <issue> --json comments`, whose real stdout shape is the wrapper object `{"comments": [...]}` — never a bare array. `parseSetupInfo()` (line 244) does `JSON.parse(commentsJson)` and immediately requires `Array.isArray(comments)`, which is false for every real invocation, so it returns `null` ("verifiably no setup milestone") even when the setup milestone plainly exists on the issue. `runTeardownFor` then records `cleanup: 'failed-missing-setup-info'` and never runs teardown — every merged unit's pool-claimed worktree is never returned and cold worktrees are never removed (a silent worktree/pool leak per merge, confirmed by the #3810 repro during #471 fleet-parity validation).

The bug is masked in tests: `packages/sched/src/__tests__/groundtruth.test.ts`'s `parseSetupInfo` describe block builds its fixture with `JSON.stringify(bodies.map((body) => ({ body })))` (line 222) — a bare array — which is not what `gh issue view --json comments` actually returns. The fixture encodes the same wrong assumption the parser makes, so the test suite is green while the real code path is fully broken.

## Acceptance Criteria
- [ ] AC1: `parseSetupInfo` correctly recovers the setup milestone's teardown inputs (`worktree`, `poolClaimed`, `branch`) when given gh's real output shape `{"comments": [...]}` (an object wrapping the array, not a bare array)
- [ ] AC2: `parseSetupInfo` still returns `null` for genuinely absent/malformed input (`null`, empty string, invalid JSON, `{"comments": []}`, a bare array — since that is no longer the expected real shape but should not crash) — existing negative-path tests keep passing
- [ ] AC3: The author-trust filtering (only OWNER/MEMBER/COLLABORATOR comments considered) and "newest setup milestone wins" behavior are preserved unchanged
- [ ] AC4: The test fixture in `groundtruth.test.ts` is updated to mirror gh's real `{"comments": [...]}` wrapper shape, so the test suite can no longer be green while this parser is broken
- [ ] AC5: A regression test exists that passes the exact wrapper shape (`{"comments": [...]}`) through `parseSetupInfo` and asserts a non-null `SetupInfo` is recovered — the shape #3810 actually failed on

## Approach
1. In `packages/sched/src/groundtruth.ts`, change `parseSetupInfo` to accept the gh wrapper shape: after `JSON.parse`, if the parsed value is a plain object with a `comments` property that is an array, unwrap to that array; if the parsed value is itself an array (defensive, in case a caller ever passes the unwrapped form), use it directly; otherwise return `null`.
2. Update the JSDoc comment above `parseSetupInfo` (lines 226-235) to state the real input shape explicitly (the wrapper object), so a future reader doesn't reintroduce the same wrong assumption.
3. In `packages/sched/src/__tests__/groundtruth.test.ts`, change the local `comments` helper (line 222) to wrap its array in `{ comments: [...] }`, matching gh's real output — this makes the whole `parseSetupInfo` describe block (lines 221-273-ish) exercise the real shape rather than the wrong one.
4. Update any other direct `parseSetupInfo(JSON.stringify([...]))` call sites in the test file (e.g. `'[]'` negative case, the author-trust block using `JSON.stringify([setup(...)])`) to use the wrapper shape consistently, and add `parseSetupInfo('{"comments":[]}')` as an explicit negative case alongside the existing `'[]'` one.
5. Add one explicit regression test asserting the exact bug: build a wrapper-shaped JSON string via `JSON.stringify({ comments: [...] })` with a valid `phase=setup status=done worktree=... pool_claimed=true` milestone body, and assert `parseSetupInfo` returns the expected `SetupInfo` (not `null`).
6. Bump `packages/sched/package.json` version (patch, `0.4.0` → `0.4.1`) since `src/` changes in this publishable package (per repo CI's version-bump gate).
7. Run `make build-all` and `make test` in the worktree to confirm the fix and no regressions.

## Reachability Evidence
N/A — this is a bug fix to an existing, already-reachable code path (`setupInfo()` is called on every teardown attempt for every merged unit); no new state or flow is introduced.

## Predicted Files
- `packages/sched/src/groundtruth.ts` — fix `parseSetupInfo` to unwrap gh's `{"comments":[...]}` object shape instead of requiring a bare array; update JSDoc
- `packages/sched/src/__tests__/groundtruth.test.ts` — fix the `comments` fixture helper and related call sites to use the real wrapper shape; add a regression test for the wrapper shape
- `packages/sched/package.json` — patch version bump (`0.4.0` → `0.4.1`) per this repo's publishable-package CI gate

## Reusable Code
- `parseMilestoneKeys()` (`packages/sched/src/groundtruth.ts:281`) — already handles the `key=value` extraction from a milestone comment body; unchanged by this fix, reused as-is by `parseSetupInfo`
- `TRUSTED_ASSOCIATIONS` set and the "newest milestone wins" reverse-iteration pattern in the existing `parseSetupInfo` — kept, only the top-level array/object handling changes

## Risk Areas
- Must preserve backward compatibility with any caller that might already pass a bare array (defensive fallback keeps this working, though no current call site does so per the codebase search)
- `docs/agent-traps.md` does not exist in this repo — no traps to check
- The fix is narrowly scoped to parsing; no changes to teardown execution logic (`teardown.ts`) are needed or planned, since the root cause is entirely in shape-parsing

## Test Scope
- Existing unit tests in `packages/sched/src/__tests__/groundtruth.test.ts` (`parseSetupInfo` and `parseSetupInfo author trust` describe blocks) — updated to use the real wrapper shape and re-verified
- New regression test asserting the exact wrapper shape recovers a valid `SetupInfo`
- Full `make build-all` and `make test` run in the worktree before shipping — repo-wide regression check (`packages/sched` unit tests plus the rest of the monorepo test suite)

## Open Questions
(none)

## Visual Review
- [x] Not required (backend/infra only)

## Base Branch
`main` — PRs for this issue target this branch.
