# Issue #1113: gate 4 lifecycle release suite

## Problem
The primitives and composition smoke tests exist, but release gate 4 needs explicit lifecycle scenarios exercising createController with only physical edge fakes. Historical blockers are obsolete: #1110 is closed. Owner threat model includes crashes, corruption, timing and legitimate concurrent control requests; hostile in-process code and active same-user filesystem tampering are hardening notes only.

## Acceptance Criteria
- [ ] Every scenario above is a passing test with its metadata (actor, expected outcome, slice).
- [ ] The global invariants are asserted after every scenario by one shared helper.
- [ ] Any production bug found is fixed in this PR with a regression test. If it is too large, file it as a sub-issue of #1002, mark the scenario `it.fails` with a link, and note it in the PR. **The gate cannot pass while any scenario is `it.fails`.**
- [ ] The suite runs in normal CI (no VM, no network) in under 60 seconds.

## Predicted Files
- `packages/zero-trust/src/__tests__/gate4-lifecycle.test.ts` — assembled lifecycle scenarios and shared invariant audit.
- `packages/zero-trust/src/controller/__tests__/composition-fixture.ts` — extract the existing edge-only composition rig for reuse.
- `packages/zero-trust/src/controller/__tests__/e2e-fakes.test.ts` — consume extracted fixture, preserve existing tests.
- `packages/zero-trust/src/controller/controller.ts` — narrowly repair lifecycle defects only if reproduced.
- `packages/zero-trust/src/controller/wiring.ts` — narrowly repair assembled credential/cleanup defects only if reproduced.
- `packages/zero-trust/README.md` — document gate evidence and repaired public behavior.

## Approach
1. Reuse the offline composition rig (bare upstream/fork, scripted model, fake VM, real journals and stores); add controllable edge timing and bounded waits.
2. Exercise cancellation at gating, implementing, verifying, shipping before push, and pending contributor publication; cleanup failure with reported guest IDs and CleanupCompleted remaining blocked.
3. Exercise budget refusal before model/verification calls, retained ledger history with approved ceiling extension, crash/reopen with unknown holds and cleanup reserve, pause/checkpoint resume.
4. Exercise reauthorization refusal, mid-push 15-minute expiry with voided attempt/fresh receipt, delayed fork recovery, and broad-installation refusal.
5. Audit receipt/push correspondence, duplicate link/write identity, supervisor evidence, guests destroyed or reported, and token revocation through one shared helper after every case; fix reproduced in-scope production bugs.
6. Run focused suite, build, warning-strict lint, full package coverage and CI-equivalent checks; independent full-risk review before shipping.

## Reachability Evidence
N/A — release tests exercise existing states and external failure conditions. This adds no new user state or data-reachable flow. No production database applies to an offline controller acceptance suite.

## Reusable Code
- `controller/__tests__/e2e-fakes.test.ts:rig` — real createController vertical slice.
- `__tests__/verifier-fixture.ts` — actual canonical candidate and scripted VM evidence.
- `github/__tests__/github-fake.ts` and `push-rig.ts` — narrowed token transport and local bare repositories.
- `controller/control.ts`, `checkpoints.ts`, `outcome-records.ts` — real concurrent controls, approval and ledger evidence.

## Risk Areas
- Security risk floor requires full independent review; test metadata must name actor, expected outcome and S1–S5 owner.
- Credential isolation includes transitive type imports. Only test fixtures and wiring may import credential modules.
- #1112 concurrently adds controller/edits.ts and CLI edit/resume handling; do not touch that new module. #1111 owns revision changes.
- Never fabricate observations to settle unknown budget holds. No it.fails can count as a gate pass.
- Existing trap index read in full and searched: stale-base diff and squash-body CI skip markers matter at review/ship.

## Test Scope
Gate suite under 60 seconds without live providers or VM; real local git is allowed. All existing composition tests remain. Full zero-trust coverage (90% statements/functions/lines, 85% branches), strict TypeScript build, isolation scanner and root CI lint. Repo CI workflows determine broader parity.

## Open Questions
None.

## Visual Review
- [x] Not required (backend/offline tests only)

## Base Branch
`main`
