# Issue #1110: active pause, cancel and fresh-VM resume

## Problem
The composed controller has a root incident fence but no durable per-run control channel for a legitimate second process. Active user pause must interrupt guests without reading worker files; cancellation must reconcile publication and revoke credentials independently of guest cleanup. All issue/epic comments and owner clarification 6097937051 were read. Accidental corruption, crash prefixes and concurrent legitimate controllers are in scope; deliberate same-user lock/symlink tampering is outside scope.

## Acceptance Criteria
- [ ] AC1 Scenario 9: a pause requested mid-implementation stops before the next model call or command. The VM is destroyed and the run is `paused_user` with the ledger intact. Resume continues on a new VM, and the final candidate equals the uninterrupted run's candidate (same scripted model).
- [ ] AC2 A pause request that arrives during a long `exec` (the fake blocks) is applied by destroying the VM, and no further command runs.
- [ ] AC3 Cancel before shipping revokes the credentials (the fake broker records `endRun('cancelled')`) and makes no push.
- [ ] AC4 Cancel after a pending PR link reconciles first. A submitted PR is reported, and the run is `cancelled` with that PR URL in status.
- [ ] AC5 A control request file that is corrupt or unknown is refused and does not stop the controller silently. Status reports it.
- [ ] AC6 Teardown failure during pause or cancel gives `blocked_cleanup`.

## Approach
1. Add atomic fsynced immutable request files and digest-bound acknowledgments in a separate control child directory. Writers use observational RunStore access, never the controller lock. Strict bounded parsing fails closed on corrupt/unknown bytes with fixed diagnostics and no echo of reasons.
2. Poll requests while running and check synchronously at phase, model, VM and command admission. Abort admission immediately; destroy the run VM to interrupt active work, then join accounting and reconcile effect observations before lifecycle persistence. Cancellation joins revocation even when guest cleanup fails.
3. Persist controller-owned agent messages, admitted overlay and pending action at turn boundaries. Restore against exact held base/plan and reprovision a fresh VM; interrupted commands may replay only on that fresh VM. Retain unknown budget holds and exact checkpoint approval binding.
4. Resume a user pause to its history-bound interrupted phase; an unresolved checkpoint still requires explicit approval. Refuse pause without compute and cancel during blocked cleanup.
5. Expose immediate durable CLI requests and read-only pending/refusal/publication status. Document public APIs and run offline edge-fake E2Es and package gates.

## Predicted Files
- `packages/zero-trust/src/controller/control.ts` — durable requests, results and status.
- `packages/zero-trust/src/controller/control.test.ts` — corruption, concurrency and crash-prefix tests.
- `packages/zero-trust/src/controller/controller.ts` — interruption, reconciliation and resume.
- `packages/zero-trust/src/controller/wiring.ts` — admission fences and credential lifecycle hook.
- `packages/zero-trust/src/controller/agent-loop.ts` — controller snapshot continuation.
- `packages/zero-trust/src/controller/steps.ts` — held overlay/messages reconstruction.
- `packages/zero-trust/src/controller/__tests__/e2e-fakes.test.ts` — real composition control tests.
- `packages/zero-trust/scripts/zt-run-bindings.mjs` — safe requests and observational status.
- `packages/zero-trust/scripts/zt-run-lib.mjs` — closed pause/cancel CLI commands.
- `packages/zero-trust/scripts/zt-run-bindings.test.mjs` — concurrent request/status tests.
- `packages/zero-trust/scripts/zt-run.test.mjs` — parser/rendering tests.
- `packages/zero-trust/src/index.ts` — credential-free API exports.
- `packages/zero-trust/README.md` — API and behavior contract.

## Reachability Evidence
N/A — local controller infrastructure driven by explicit user CLI actions, not a production database condition. The existing real createController edge-fake journey reaches implementing and pending contributor publication; existing state edges already support pause/resume for every active phase.

## Reusable Code
- RunStore observational opens, pinned child operations and immutable confirmed lifecycle history.
- durable-fs atomic fsynced private files; BudgetLedger known/null settlements; teardownVm retry/block behavior.
- IntentDriver.resume, HandoffDriver.resume and PrTracker.requestWithdrawal preserve contributor-only upstream writes.
- StepArtifacts content-addressed snapshots; WorkspaceOverlay admitted writes; existing offline composition rig.

## Risk Areas
Full updated trap index read and searched: unresolved work holds must not fence mandatory destruction; revocation must run independently of cleanup; pool dist may be stale; phase allocation adapters must remain lease-specific; checkpoint bytes/approvals stay digest-bound; request readers must not observe a half-published file. No private package version bump. No live service tests. Harness has no model-tier selector; executing model is openai/gpt-6.1-sol.

## Test Scope
Meaningful offline createController E2Es for all six ACs, including blocked execution, command admission races, new VM identity, identical candidate, retained ledger, publication response loss and credential hook recording. Unit tests for every new module with actual private files, concurrent writers, malformed UTF-8/JSON/schema and acknowledgment corruption. Run strict package build, 90/90/90/85 coverage gate, credential isolation, CLI script tests and repo CI-parity gates.

## Open Questions
None.

## Visual Review
- [x] Not required (controller and CLI only).

## Base Branch
`main`, updated origin/main at 8971e4b.
