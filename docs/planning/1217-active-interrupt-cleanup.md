# Issue #1217: Active interrupt cleanup

## Problem
SIGINT/SIGTERM currently cover ephemeral author preparation only. After broker adoption, an active start/resume can exit with live credentials and VMs, making the next resume fail closed despite the interrupted process having held the credential.

## Acceptance Criteria
- [ ] AC1 SIGINT, SIGTERM and SIGHUP during active start/resume request pause and join controller cleanup before process exit.
- [ ] AC2 Successful interruption revokes held credentials, destroys run VMs and retains a resumable pause; later resume continues the interrupted phase.
- [ ] AC3 Cleanup failure remains fail closed, repeated signals do not bypass cleanup, and all process-local owners are joined.
- [ ] AC4 Signal handlers are retired after operations complete, and author-to-broker ownership transfer has no signal gap.

## Approach
1. Reuse the controller durable pause/control path through a public interrupt-and-join operation, latched across initial store setup.
2. Extend the existing process-wide signal barrier to active controllers, retaining ownership until the operation and release finish.
3. Cover start/resume, repeated signals, delayed/failing cleanup and owner retirement with subprocess and controller regressions.

## Reachability Evidence
N/A — infrastructure signal handling, no new data-reachable state. Existing paused_user/control flow is reused. The issue records an actual verification interruption; signals reach the current missing post-adoption handlers.

## Predicted Files
- `packages/zero-trust/scripts/zt-run-bindings.mjs` — active controller ownership and process signal barrier.
- `packages/zero-trust/scripts/zt-run-bindings.test.mjs` — actual subprocess signals and cleanup evidence.
- `packages/zero-trust/src/controller/controller.ts` — interrupt-and-join using existing pause admission.
- `packages/zero-trust/src/controller/controller.test.ts` — verification-phase interruption and resume regression (corrected actual test path during implementation).
- `packages/zero-trust/src/controller/wiring.ts` — separate credential sweeping from resource retirement so late signal cleanup can still journal destruction (review-discovered lifecycle ordering).
- `packages/zero-trust/README.md` and `docs/guides/zero-trust-contributions.md` — scoped signal ownership, cleanup diagnostics, exit codes and existing verification-claim limitation.
- `docs/agent-traps.md` — record the ownership gap.

## Reusable Code
Controller observeControl/applyControl already abort, destroy VMs, reconcile holds and persist pause. Wiring release already sweeps broker-held credentials without permanently closing resumable admission. Existing authorOwners barrier joins multiple facades.

## Risk Areas
Trap rows #1110, #1109 and #1213: stop admission after awaits, join independent cleanup, and transfer token ownership without a gap. Concurrent workers #1219/#1220/#1223 own budget/gate/revision feedback changes; this scope is signal cleanup only. SIGKILL cannot run cleanup and remains recovery's responsibility.

Review confirmed that successful cleanup does not erase the verifier's once-only candidate claim. A claimed verification without a record remains fail-closed on resume; this existing verifier contract is retained and documented. Controller phase re-entry and resource-cleanup guarantees are tested independently.

## Test Scope
Run real process signal tests with disposable stores and recording credential/VM adapters; assert durable pause and resumed phase. Run binding suite, controller/package suite, build and CI-equivalent lint/coverage gates. Keep failures observable rather than catching assertions in production error boundaries.

## Open Questions
None.

## Visual Review
- [x] Not required (controller infrastructure only)

## Base Branch
`main`
