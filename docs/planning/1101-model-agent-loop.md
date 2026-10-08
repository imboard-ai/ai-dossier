# Issue #1101: zero-trust planning and implementation loop

## Problem
The model transport and provisioned evidence workspace exist, but no controller loop admits model proposals and retains the exact source bytes for an implementation candidate. Repository-generated VM files must never become candidate authority. No existing plan artifact was present.

## Acceptance Criteria
- [ ] AC1 With the scripted model (from the model adapter issue) and `FakeVmAdapter`, a happy path plans, writes a fix and a test, runs the test, and declares `candidate_ready`. The candidate manifest equals base plus exactly the written files.
- [ ] AC2 Scenario 5: a proposal with an extra `target`/`repo`/`token` field, a traversal path, or a secret-shaped argument is rejected by `admitModelAction` and never reaches the adapter.
- [ ] AC3 Bytes a repository process writes in the VM (simulated by the fake) never enter the candidate.
- [ ] AC4 A budget denial mid-loop stops before the next model call. Turn and active-time caps stop the loop, with distinct outcomes.
- [ ] AC5 Scenario 8: the loop has no model-specific branches; the same admission and limits apply to every adapter.
- [ ] AC6 `authority.test.ts` covers the two new actions (valid, oversized, extra field, secret).

## Approach
1. Extend closed authority with bounded secret-free plan and candidate metadata actions.
2. Build a validated, controller-owned source overlay, retaining baseline modes and rejecting collisions; materialize exclusively into a newly created private directory and export the result.
3. Share scope-review test-path classification with overlay test selection.
4. Build controller-authored tool schemas/prompts with JSON-framed untrusted issue, plan, repair and command output data.
5. Run a single provider-neutral metered loop with stage action restrictions, turn/time caps, five-consecutive-rejection hand-off, secret-free injected transcript persistence and offline VM mirroring.
6. Document public interfaces and limitations; verify offline recording tests, coverage, strict build and full repository gates.

## Reachability Evidence
N/A — this is new controller infrastructure, reached by a trusted caller supplying a provisioned workspace, source manifest, model adapter and ledger; no production-data occurrence condition exists. Offline scripted models exercise each new action and stop outcome.

## Predicted Files
- `packages/zero-trust/src/authority.ts` — two closed actions and bounds.
- `packages/zero-trust/src/__tests__/authority.test.ts` — admission regression cases.
- `packages/zero-trust/src/controller/workspace-overlay.ts` — controller-held candidate source.
- `packages/zero-trust/src/controller/workspace-overlay.test.ts` — source integrity and filesystem constraints.
- `packages/zero-trust/src/controller/agent-loop.ts` — admitted metered orchestration.
- `packages/zero-trust/src/controller/agent-loop.test.ts` — happy path and adversarial/cap outcomes.
- `packages/zero-trust/src/controller/prompts.ts` — trusted prompts and tool definitions.
- `packages/zero-trust/src/controller/prompts.test.ts` — untrusted framing and schemas.
- `packages/zero-trust/src/review/integrity.ts` — shared test-path predicate.
- `packages/zero-trust/src/index.ts` — public API exports.
- `packages/zero-trust/README.md` — spec-of-record API documentation.

## Reusable Code
- `admitModelAction`, `assertWorkspacePath`, `assertNoSecrets` for deterministic authority.
- `validateManifest`, `createManifest`, `exportSource` for canonical source bounds and identity.
- `meteredComplete` and `BudgetLedger` for reservation/settlement.
- `OutputCollector`, `provisionWorkspace`, `FakeVmAdapter`, `ScriptedModel` for evidence and offline tests.

## Risk Areas
- Model output and command output remain untrusted; no provider exception text is persisted.
- Keep all credential modules outside the transitive controller/VM import graph.
- Preserve executable modes, binary baseline blobs, directories and case-collision rules.
- Materialization refuses an existing directory, including symlinks; deletion is unsupported.
- Trap index read in full and searched: bounded guest capture, unknown reservations, secret normalization, isolated fixture cleanup, ignored planning files and VM bake flake apply.
- Private package: no version bump or changeset. Concurrent README/index changes require latest-base reconciliation before merge.

## Test Scope
Offline real-ledger tests plus scripted models and fake provisioned workspaces: exact candidate contents/modes, VM-written-file exclusion, rejected proposals producing zero worker operations, metered budget denial, turn/active ceilings, invalid responses, rejection reset, transcript redaction/persistence refusal, execution failure and repair framing. Overlay tests use owned temporary directories. Run package coverage (90% statements/functions/lines, 85% branches), strict build, make lint/build-all/test.

## Open Questions
None.

## Visual Review
- [x] Not required (controller library only).

## Base Branch
`main`
