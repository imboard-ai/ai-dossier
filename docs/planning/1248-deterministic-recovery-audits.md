# Issue #1248: Deterministic recovery race

## Problem

The real-process budget-reclaimer race intermittently observes six rather than seven expected losing child exit codes. In recovery.test.ts:434–437, seven code-2 losers and exactly one reclaim audit are separate assertions; the reported array is not seven audit records. Determine test scheduling versus actual lost recovery accounting from child outcomes and persisted evidence. Classification-only light plan; dispatch_profile=openai (explicit user override), model=OpenAI gpt-6.1-sol, prod_data_access=none.

## Acceptance Criteria

- [ ] Root cause identified (test timing vs. real lost audit)
- [ ] The test is deterministic: it passes 50 consecutive runs locally under CPU pressure (e.g. `--repeat` with a busy-loop sibling)

## Predicted Files

- `packages/zero-trust/src/__tests__/recovery.test.ts` — primary change; lines 417–438 spawn eight children, discard diagnostics, map only two expected errors to code 2, join exits and assert one successful reservation/one audit.
- `packages/zero-trust/src/__tests__/recovery-fixture.ts` — conditional shared child lifecycle/barrier/diagnostic helpers; already owns budgetFixture and crashProcess.
- `packages/zero-trust/src/budget.ts` — conditional production fix only if evidence proves an accounting defect; locked() maps StoreLockedError to lock_timeout and records reclaim with pending reservation IDs.
- `packages/zero-trust/src/lock.ts` — conditional ownership/reclaim serialization fix if traced evidence establishes the defect; budget.ts imports withStoreLock and recordLockReclaim here.

## Approach

1. In an implementation worktree, capture each child's exit code, signal and bounded error diagnostics; trace the unexpected eighth result and exact durable reservation/audit records. Preserve current-source compiled process fixtures. Do not infer the root cause from a green rerun.
2. Distinguish valid contention/lock timeout, process lifecycle and admission failures from dropped audit evidence. Inspect the reserve and reclaim boundaries. Use explicit readiness/barriers or bounded completion synchronization where scheduling is the cause; if actual accounting is broken, repair the narrow producer and add a deterministic reproducer.
3. Preserve exactly one successful 60-minor reservation within the 100-minor ceiling, exactly one initial dead-owner reclaim audit, unknown-hold fencing, durable ownership checks and fail-closed recovery. Do not merely accept arbitrary child failures or relax accounting assertions.
4. Keep scope inside this recovery race. No schema migration, new package, published contract change or production operation is predicted. No dependency on submitted #1243/#1244/#1245; they concern scheduler service/process/state handling, not this zero-trust ledger.
5. Read agent-traps.md recovery entries (#1057/#1023), child-build prerequisite (#1027), CPU/fs-pressure guidance (#1101), and Vitest v4 repeat guidance (#696). Record measured root cause and implementation evidence.

## Test Scope

focused — named recovery.test.ts race and adjacent ownership-proven recovery tests, plus existing budget.test.ts if production paths change. The recovery suite exercises the shared lock producer through real processes. Build prerequisites with make build-zero-trust before the package gate. Run via the zero-trust workspace script so setup resolves correctly.

During implementation, run the exact named race 50 consecutive times under a controlled CPU busy-loop sibling, fail on the first failing iteration, retain iteration outcomes and pressure configuration, and clean up/join the owned pressure process. Vitest v4 has no --repeat; use a bounded 50-iteration shell loop invoking npm test --workspace=@ai-dossier/zero-trust -- src/__tests__/recovery.test.ts -t 'racing real budget reclaimers retain one audit and never overcommit'. This evidence has not been executed during classification. Run adjacent recovery and budget/lock regressions for any production fix and the required repository gate. Longer measured test deadlines may address host latency but must not substitute for root-cause evidence or the 50-run requirement.

## Reachability Evidence

N/A — no new reachable state; this is an existing real-process recovery test. The existing trigger is eight children reserving 60 minor units against the same 100-minor session after a dead owner marker. `prod_data_access=none` by repository policy.

## Reusable Code

- `compiledFixture` builds current source for real child processes.
- `budgetFixture`, `readJournal`, `processStartToken` and `withStoreLock` preserve real durable ownership/accounting evidence.

## Risk Areas

- Plan artifact validated at current HEAD; all five canonical sections preserved verbatim.
- Trap #1057: preserve one reclaim audit and unknown-hold fencing; never relax lock ownership.
- Trap #696: Vitest v4 requires an explicit repeat loop; #1101 documents fs/CPU pressure.
- Root cause still requires runtime evidence; code 3 currently hides its error and signal.
- Durable plan uses docs/planning because PLANNING files are ignored (#1091).

## Open Questions

None requiring a product decision; distinguish observed child outcomes during implementation.

## Visual Review

- [x] Not required (backend/test only)

## Base Branch

`main`
