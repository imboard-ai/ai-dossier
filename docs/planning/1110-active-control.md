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

## Review evidence and repair (iteration 1)
Full seven-dimension report-only dispatch used the actual model openai/gpt-6.1-sol.
The first pass finished below the full-tier five-minute floor; its verdict is not
used as ship authority, and a complete fresh-head redo follows the scoped repairs.
Its findings were nevertheless concrete repair inputs. Validity/dedupe: 12 unique
Fix-now findings retained; the Convention duplicate of the README finding was
dismissed as duplicate-of-9; no product/business escalation.

1. Shared push/intent construction — private wiring helper, with explicit deny-only recovery authorization.
2. Stop during mint — broker checks synchronous stop admission after mint and revokes before credential hand-out; pusher receives phase signal.
3. Engagement reconciliation race — final synchronous stop fence before link/body publication.
4. Late complete model response — retain original data and known usage, never synthesize malformed interruption.
5. Unfunded cleanup crash prefix — share reconciliation, block unresolved obligations and still revoke.
6. Repair resume identity — derive interrupted repair from validated history and bind continuation to the attempt.
7. New test typing — use typed `vi.mocked` call tuples; supplemental strict check covers E2E/control tests.
8. CLI help — include required pause/cancel arguments and executable help assertions.
9. README contract — distinguish active user pause from an open checkpoint.
10. Recovered publication observers — core persists/notifies before separate withdrawal preparation.
11. Candidate identity across paused wall time — persist attempt timestamp before interruptible work; comparison tests advance resume clock.
12. Cancel sequencing — close admission immediately, reconcile publication, then destroy resources; ordered stale-guest and observer tests.

Focused repaired-edge gate: 13 composition E2Es pass, including deferred write,
exec, model, token mint, engagement read, repair and cancellation races. Core/CLI
gate: 97 tests pass, including unresolved/resolved real durable cleanup prefixes.
Final package coverage and complete independent review redo are required before ship.

## Full-tier redo and publication-boundary repair
The complete seven-role redo ran 321–495 seconds per role on acd5118 with real
offline source tests/probes. Conformance marked all six ACs met; DRY,
maintainability and documentation were clean. Security, Supportability and
Convention independently reproduced one shared legitimate-publication defect:
the hard-link staging prefix had nlink=2 and was rejected by the strict private
reader. One unique finding is retained; two duplicates are dismissed.

The scoped repair replaces hard-link publication with the existing single-link
atomic rename helper under a short publisher-only kernel guard independent of
the controller lifetime guard. No generic credential/private-file check is
relaxed. Tests read at the exact request/result visibility boundary and kill
real child writers immediately after rename, then verify complete evidence and
guard release. The composed cancellation fixture also observes admission at
that exact visibility boundary and records credential revocation/no push.

## Final full review and shared guard reuse
The complete final seven-role pass at ba2315e ran 336–416 seconds per role.
Security, Supportability, Maintainability, Documentation, Convention and
Conformance were clean; conformance independently executed the source fixtures
and marked all six ACs met. Multiple independent probes raced 3–12 real
publishers with lock-free readers and killed writers both before and after rename
without corrupt observations. One actionable DRY finding remained: duplicate
private permanent-inode acquisition. It is repaired by moving the existing
RunStore acquisition into `lock.ts:acquirePrivateGuard`, with explicit creation
and wait parameters and unchanged validation/lifetime rules. Controller and
publisher still use different guard paths. The final scoped review rechecks
DRY, security and blind conformance on that shared-helper head.
