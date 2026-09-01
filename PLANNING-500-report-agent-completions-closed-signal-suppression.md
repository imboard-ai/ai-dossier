# Issue #500: bug(sched): report-agent completion's closed-signal suppression is defeated by phase-updated — units complete without a report milestone

## Problem
`packages/sched/src/engine.ts`'s `effectiveClosedSignal()` is supposed to suppress the
issue-closed completion signal for report agents (`slot.phase === 'report' ? false :
truth.closed`), so that a report-phase slot can only be verified complete by its own
`report done` runstate milestone — never by the issue already being closed (which is
always true by the time a report agent runs, since the PR merge auto-closes the issue).

But `applyProgressSignals()` resyncs `slot.phase` to the issue's LATEST polled milestone
on every reconcile tick (`phase-updated`). For a report-phase slot, the issue's latest
milestone stays at whatever the pre-report phase left it (`ship`/`awaiting-merge`) until
the report agent itself posts one — so this resync silently overwrites `slot.phase` away
from `'report'` while a report agent is still running, mid-run, with no report milestone
ever posted. Once that happens, `effectiveClosedSignal` reads the corrupted `phase`,
returns `truth.closed` (true), and `isVerifiedComplete` completes the unit — with no
report ever produced. Confirmed in production (imboard#3891, filed via #471): a real
run completed with a rich "Final Report" comment posted, but no `report done` runstate
milestone, because this suppression was defeated exactly this way.

## Acceptance Criteria
- [ ] AC1 A report-phase slot's completion signal is immune to `slot.phase` being resynced away from `'report'` by `phase-updated` — completion still requires the actual report milestone (or a genuine unverified-exit → redispatch, never a silent complete)
- [ ] AC2 The fix is keyed off a value fixed at spawn time, not derived from the mutable, milestone-driven `phase` field (matches the issue's stated fix direction: track the agent ROLE as its own field)
- [ ] AC3 Existing report-agent dispatch/respawn/escalation-ladder behavior (`spawnUnit`'s respawn-as-report-agent check, `enterRecovery`'s report ladder) is equally immune to the same `phase` corruption, since both keyed off `slot.phase === 'report'` before this fix and share the same root cause
- [ ] AC4 Persisted scheduler state from before this fix (`SCHEMA_VERSION` 1.3.0, no `role` field) loads and migrates cleanly, inferring `role` from the slot's last-known `phase`
- [ ] AC5 A regression test reproduces the exact production sequence (report dispatch → phase-updated corruption → agent exit with no milestone) and shows the unit is NOT completed, then IS completed once a real report milestone lands

## Approach
1. Add a `role: 'cycle' | 'report'` field to `SlotEntry` (`packages/sched/src/types.ts`), set once at spawn/assignment time and never touched afterward — unlike `phase`, which `applyProgressSignals` deliberately keeps live.
2. `assignToIdleSlot` (`packages/sched/src/scheduler.ts`) derives `role` from the `phase` argument at the moment of assignment (`phase === 'report' ? 'report' : 'cycle'`) — the one place role is decided.
3. `transitionSlot`'s `idle` clearing (`packages/sched/src/state.ts`) resets `role` to `'cycle'` alongside `phase`/`branch`/etc., so a freed slot never leaks a stale role into its next (possibly non-report) assignment.
4. Re-key the three places that read `slot.phase === 'report'` in `packages/sched/src/engine.ts` onto `slot.role === 'report'`: `effectiveClosedSignal` (the bug), `spawnUnit`'s respawn-as-report-agent branch, and `enterRecovery`'s report-ladder determination — all three share the same root cause (phase drift), even though only the first was reported.
5. Bump `SCHEMA_VERSION` to `1.4.0` (from `1.3.0`), add `1.3.0` to `LEGACY_SCHEMA_VERSIONS`, and backfill `role` in `validateState`'s migration: `slot.role ?? (slot.phase === 'report' ? 'report' : 'cycle')` — a best-effort inference for a report agent caught mid-flight by the upgrade.
6. Add validation for the new field (must be `'cycle'`, `'report'`, or absent/legacy) and a migration test alongside the existing 1.0.0/1.1.0/1.2.0 ones.
7. Add a regression test in `engine.test.ts` that reproduces the bug's exact event sequence and fails against the pre-fix code (verified manually by reverting the one-line fix and re-running).

## Reachability Evidence
N/A — this is an internal scheduler correctness fix (an added state-machine field), not a new user-facing state, flow, or UI surface. No product reachability question applies.

## Predicted Files
- `packages/sched/src/types.ts` — add `SlotEntry.role`; bump `SCHEMA_VERSION`, extend `LEGACY_SCHEMA_VERSIONS`
- `packages/sched/src/scheduler.ts` — derive and set `role` in `assignToIdleSlot`
- `packages/sched/src/state.ts` — validate `role`; backfill it in the schema migration; reset it on the `idle` transition
- `packages/sched/src/engine.ts` — re-key `effectiveClosedSignal`, `spawnUnit`, `enterRecovery` off `role`
- `packages/sched/src/__tests__/engine.test.ts` — regression test for the exact bug sequence
- `packages/sched/src/__tests__/state-machine.test.ts` — migration test for 1.3.0 → 1.4.0; a validation-rejection test for a malformed `role`
- `packages/sched/src/__tests__/status.test.ts` — the shared `slot()` fixture needed `role` to keep compiling
- `packages/sched/package.json` — version bump (0.4.1 → 0.4.2; `src/` changed)

## Reusable Code
- `packages/sched/src/state.ts` `validateState`'s existing legacy-migration pattern (branch/last_head/pid_start backfill, `LEGACY_SCHEMA_VERSIONS`) — the `role` migration follows the same shape.
- `packages/sched/src/groundtruth.ts` `isVerifiedComplete` / `isParkedMilestone` — unchanged; the fix only corrects the signal fed into them.

## Risk Areas
- Missed call sites: confirmed via `grep -rn "\.phase === 'report'"` across the whole repo that exactly three call sites in `engine.ts` existed and all three are now role-keyed; `groundtruth.ts:339`'s `milestone.phase === 'report'` is a check on the MILESTONE's own phase field (correct, unrelated) and was left untouched.
- Migration correctness for slots persisted mid-bug (phase already corrupted to something other than `'report'` for a slot that IS a report agent): the backfill can't recover role in that specific case (phase no longer reads `'report'` at load time), same class of limitation as any best-effort migration — but this only affects state files written by the buggy build, and the field is fixed going forward once running the fixed build.
- `docs/agent-traps.md` does not exist in this repo — skipped per plan-issue Step 4.

## Test Scope
- `packages/sched/src/__tests__/engine.test.ts`: new regression test `#500: an exit after phase-updated corrupts slot.phase still requires the report milestone (role survives the resync)` — manually verified to FAIL against the pre-fix `effectiveClosedSignal` and PASS against the fix.
- `packages/sched/src/__tests__/state-machine.test.ts`: new migration test (1.3.0 → 1.4.0, backfill role from phase) and a new validation-rejection test (malformed role).
- Full existing suite: `make test` (root) and `npx vitest run` (packages/sched) — 282/282 sched tests, 1115/1115 root scripts+registry combined suite pass unchanged.
- `npx tsc --noEmit` in `packages/sched` — clean.
- `make build-all` — clean.

## Open Questions
(none)

## Visual Review
- [x] Not required (backend/infra only)

## Base Branch
`main` — PRs for this issue target this branch.
