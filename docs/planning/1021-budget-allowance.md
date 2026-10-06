# Issue #1021: Isolate the budget cleanup allowance

## Problem
Settled work overruns currently consume the protected cleanup allowance because monetary admission uses aggregate spend for both purposes. Provider observations must remain uncapped while teardown retains its protected funds.

## Acceptance Criteria
- [ ] AC1 After a work reservation settles above its estimate, even above the whole ceiling, a teardown reservation up to `cleanupAllowance` is still admitted (test reproducing the probe above).
- [ ] AC2 After such an overrun, further `work` reservations are denied.
- [ ] AC3 Teardown reservations beyond the allowance plus remaining unreserved work budget are still denied.
- [ ] AC4 `budgetTotals` keeps reporting the true observed spend. No capping.

## Predicted Files
- `packages/zero-trust/src/budget.ts` — isolate monetary admission by reservation purpose without changing persisted schema or public totals.
- `packages/zero-trust/src/__tests__/budget.test.ts` — add durable, boundary, and concurrency regressions.

## Approach
1. Derive exact bigint committed money for work and teardown from the validated snapshot inside the existing mutation lock. Reserved rows charge their estimate; settled rows charge max(estimate, observation); released rows charge nothing.
2. For teardown, allow cleanupAllowance plus max(0, work ceiling minus work commitments), minus teardown commitments. Work overruns never subtract from cleanupAllowance.
3. Preserve existing conservative work admission against aggregate commitments and the work ceiling; this prevents double-spending funds already allocated to teardown and blocks even zero-money work after an overrun.
4. Keep public budgetTotals and cumulative token/time checks unchanged. No schema, dependency, package-version, or lockfile change.
5. Test overruns at and above the ceiling, partially spent cleanup, surplus borrowing, rejected mutations, reload, releases, session isolation, safe-integer boundaries, and real concurrent teardown admission.

## Test Scope
- Demonstrate new overrun regressions fail on the existing implementation before applying the fix.
- Run zero-trust package tests/build, repository lint, version-bump gate, and the repository's documented full verification gate.
- Review each acceptance criterion against code and executed regressions, with adversarial monetary boundaries and double-spend analysis.

## Reachability Evidence
N/A — this repairs an existing local-filesystem admission path, not a new production-data state. The issue supplies a confirmed provider-overrun reproduction against the exact pool base a3c0cde; tests will execute that path with real persisted ledgers.

## Reusable Code
- BudgetLedger.mutate/locked validates and serializes all admission decisions.
- budgetTotals supplies the unchanged conservative resource totals.
- Existing test estimate, price, code, and compiledModule helpers support real-file/process regressions.

## Risk Areas
- The repository ignores root PLANNING-* files; this durable plan lives under docs/planning to respect the no-force-add workflow rule.
- Teardown commitments must be counted across settled/reserved rows and never recreated on reload.
- Teardown borrowing from unused work budget must not make that money available to subsequent work.
- Use bigint for admission so aggregate overrun arithmetic cannot erase the allowance through number overflow.
- Token/time limits remain global and can independently deny teardown; this issue protects the monetary allowance only.
- Read AGENTS.md and docs/agent-traps.md fully. Relevant traps: no shared stash (including hooks), stale pool dist, native auto-merge readback, exact CI SHA, warning-sensitive lint, and hostname-dependent baseline tests.
- Fleet siblings #1019/#1020 own intents/canonical; this issue changes budget only. zero-trust is private, so no release bump.

## Open Questions
None.

## Visual Review
- [x] Not required (backend only)

## Base Branch
`main`
