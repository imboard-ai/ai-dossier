# Issue #1006: budget reservation ledger

## Problem
Implement a durable admission ledger for the greenfield zero-trust foundation, distinct from the observational CLI usage ledger. Base is fresh origin/main at 451ed3da11cb986368c1b4d04f7525993319f0b3 (#1004 and #1005 merged).

## Acceptance Criteria
- [ ] AC1 Money is integer minor units per currency (no floats). Each rate entry records currency, unit, price, source, and a pinned FX rate + timestamp. Missing rate for a requested resource → admission error (`missing_rate`), which blocks startup.
- [ ] AC2 Contribution-wide history with **independent finite ceilings per session** (initial + each revision). A new session allocates a new ceiling; historical spend is never reset.
- [ ] AC3 `reserve(estimateMax)` is atomic (single-writer lock or compare-and-swap on the persisted file) and denies when `spent + reserved + estimateMax > ceiling − cleanupAllowance`. The cleanup allowance can never be consumed by a non-teardown reservation; teardown reservations may use it.
- [ ] AC4 `settle(reservationId, observed)` records **estimated vs provider-reported** separately. Reservations with unknown outcome stay reserved across crash/resume until explicitly reconciled.
- [ ] AC5 Reservation estimate helper accounts for: max output tokens, retry count, streaming time bound, VM minimum billing increment, retained storage.
- [ ] AC6 Zero-incremental-cost (subscription/local) models still require token/time limits — a reservation with cost 0 still checks those limits.
- [ ] AC7 Ledger is preserved unchanged when the model profile changes on resume (scenario 8/9).

## Predicted Files
- `packages/zero-trust/src/budget-types.ts` — validated money, rational FX, rates, estimate/session/reservation contracts.
- `packages/zero-trust/src/budget.ts` — conservative integer estimates, pure admission/accounting, locked atomic persistence.
- `packages/zero-trust/src/__tests__/budget.test.ts` — adversarial inputs, races, crash/reload, sessions, settlement, limits.
- `packages/zero-trust/src/index.ts` — public exports.
- `packages/zero-trust/README.md` — ledger usage and lock recovery contract.

## Approach
1. Use nonnegative safe-integer minor units; compute products/division through BigInt with upward rounding and reject overflow. Pin injected pricing/FX evidence into each reservation.
2. Store immutable session ceilings/limits and append-preserved reservations under a contribution identity. Derive totals from rows instead of trusting mutable counters. No model-profile rewrite on open/resume.
3. Reserve under an exclusive file lock, re-read/validate disk, write a unique same-directory temporary file, fsync, rename, and fsync directory. Never initialize missing state on resume and never auto-delete a possibly live lock.
4. Unknown outcomes remain reserved. Explicit settlement stores observed and estimated separately; bill conservatively at the greater amount. Explicit release requires no-charge evidence. Overruns block subsequent work but preserve reporting/teardown ability.
5. Bound cumulative tokens/time even at zero price; estimate retries, output tokens, streaming duration, minimum VM increments, and retained storage with fully injected rates.
6. Test independent instances and real subprocess races and SIGKILL after reservation; reject corrupt/missing ledger, unsafe input, cross-currency misuse and tampering.

## Reachability Evidence
N/A — explicit new greenfield controller primitive, no production data-dependent UI state. Direct library calls/configuration trigger admission; the issue requests these capabilities. No production occurrence query is applicable.

## Reusable Code
- `packages/sched/src/persist.ts` — same-directory fsync/rename pattern; avoid importing scheduler dependencies and avoid its stale-owner reclamation races.
- Existing zero-trust lifecycle/status contracts remain separate; monetary reporting there is observational, this ledger owns admission.

## Risk Areas
- Fail closed on corrupt, missing, mismatched state and unresolved locks. If a process dies while holding the short write lock, operator reconciliation is required; age/PID alone is not authority to unlink a shared lock.
- Controller-owned local filesystem only; callers cannot treat this primitive as a hostile-worker enforcement boundary or distributed/network filesystem lock.
- Safe integer overflow, fractional billing increments, settlement overruns, cumulative zero-cost limits.
- Documented native-host fixture trap in docs/agent-traps.md: reproduce on untouched base if encountered; disclose normalization and retain native CI evidence.
- No review-subagent tool is exposed: all applicable review dimensions will be performed inline and reported accurately.

## Test Scope
Meaningful focused budget tests plus all zero-trust tests/build, repository lint/build/full suites, version gate and native Node 20/22 CI. Races use two async callers and real separate processes; crash test kills a process after durable reservation before settlement. Check session history/ceilings, unknown charge retention, cleanup allowance, missing-rate startup rejection, exact rational FX rounding, cumulative zero-cost token/time bounds, and unchanged resume bytes.

## Open Questions
None.

## Visual Review
- [x] Not required (backend/infra only)

## Base Branch
`main`
