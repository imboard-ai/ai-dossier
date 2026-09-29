# Issue #864: sched tests: crash-injection coverage for the blocked and wrong-procedure eviction rails (#844 follow-up)

## Problem

The serial crash-injection tests cover dead-member eviction, but not the self-reported hand-back or either wrong-procedure eviction rail. All three pass their slot release as `preWrite` to `evictMemberDirectly`; a future split release could therefore regress without test coverage.

## Acceptance Criteria

- [ ] `--evict-members` crash coverage proves the handed-back member is parked with its slot released and is not dispatched after restart.
- [ ] `--wrong-procedure-always` crash coverage proves eviction after re-prompt has the slot released and is not dispatched after restart.
- [ ] `--wrong-procedure-shipped` crash coverage proves immediate eviction has the slot released and is not dispatched after restart.

## Approach

1. Reuse the existing `crashAfterSlotRelease` integration helper at each requested serial member rail.
2. Assert durable post-crash entry state and released slot before restoring the store lock.
3. Drive the restarted batch to its parked PR state and count dispatch preambles for the evicted member.
4. Bump the publishable scheduler package patch version and regenerate the root lockfile.

## Reachability Evidence

- N/A - no new production state or flow; this change adds regression coverage to existing test-only rails.

## Predicted Files

- `packages/sched/src/__tests__/batch-integration.test.ts` - add crash-injection tests for the three eviction entry rails.
- `packages/sched/package.json` - patch version required for a publishable scheduler source change.
- `package-lock.json` - regenerate workspace package version metadata.

## Reusable Code

- `packages/sched/src/__tests__/batch-integration.test.ts:crashAfterSlotRelease()` - simulates a process crash immediately after the atomic store write.
- `packages/sched/src/__tests__/batch-integration.test.ts:memberDispatchCount()` - counts durable member dispatches from preamble logs.
- `packages/sched/src/__tests__/batch-integration.test.ts:tickUntil()` - advances the real batch harness through restart recovery.

## Risk Areas

- The wrong-procedure rail first re-prompts in place; the repeated-procedure test must inject only on its second decision.
- Scheduler source changes require a package version bump and lockfile synchronization (agent-traps version-bump row).

## Test Scope

- Run the three new focused integration tests.
- Run the full scheduler integration test file and package suite.
- Run formatting/lint and the version-bump checker against `origin/main`.

## Open Questions

None.

## Visual Review

- [x] Not required (test-only scheduler change)

## Base Branch

`main` - PRs for this issue target this branch.
