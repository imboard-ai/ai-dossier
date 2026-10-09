# Issue #1105: zero-trust shipping context

## Problem
The trusted controller lacks the credential-free composition between immutable verification, canonical reconstruction, fork authorization and contributor PR hand-off. Existing producers are merged; the verification checkpoint still names an obsolete artifact.

## Acceptance Criteria
- [ ] AC1 An integration test builds a real ForkPusher against the local bare-repo rig with a fake broker using makeAuthorize; push succeeds and read-back equals the candidate.
- [ ] AC2 Breached or missing boundary verdict refuses before nonce consumption or token minting and leaves the fork ref untouched.
- [ ] AC3 Changed candidate SHA or manifest bytes after verification refuse.
- [ ] AC4 Wrong contributor, fork ID or replayed receipt refuses.
- [ ] AC5 Stale or throwing policy probe refuses without consuming a nonce.
- [ ] AC6 Required commands come from the trusted profile; omitted required verification commands cannot authorize.
- [ ] AC7 Credential isolation remains green with shipping.ts scanned.
- [ ] AC8 HandoffDriver.issuePr with makeHandoffAdmission and github-fake issues a compare link only after verified push.
- [ ] AC9 Verification checkpoint references artifacts/verification/<sha>.json with regression coverage.

## Predicted Files
- `packages/zero-trust/src/controller/shipping.ts` — credential-free public composition APIs.
- `packages/zero-trust/src/controller/shipping.test.ts` — unit and hostile alias/identity tests.
- `packages/zero-trust/src/controller/shipping.integration.test.ts` — real bare-repository push and handoff tests.
- `packages/zero-trust/src/controller/checkpoints.ts` — per-candidate artifact path.
- `packages/zero-trust/src/controller/checkpoints.test.ts` — checkpoint path regression.
- `packages/zero-trust/src/index.ts` — public exports.
- `packages/zero-trust/README.md` — public contracts.

## Approach
1. Bind shipping facts to durable RunStore identity, authenticated fork readiness and trusted command/profile plan; detach mutable inputs before awaits.
2. Load immutable verification and use assertShippableVerification, reconstruct canonical candidate and compare all held bindings before signing exactly one fresh push grant.
3. Build fresh ReceiptContext with real run boundary evidence and fresh policy. Keep credential modules outside every import chain.
4. Compose authenticated contributor/fork/receipt/read-back admission and policy-governed PR content from verification evidence.
5. Correct checkpoint paths and test producer-to-consumer round trips plus refused hostile mutations with nonce/token/ref observations.

## Reachability Evidence
N/A — controller/infra composition of existing shipping and revising states, not a production data-reachable feature. Existing ForkPusher, VerificationRecord and HandoffDriver callers and local rig provide concrete triggers; no production database query applies.

## Reusable Code
- `receipt/issue.ts:issueReceipt` and `receipt/verify.ts:verifyReceipt` — v2 signing and fresh context validation.
- `controller/verification-record.ts:loadVerification` / `assertShippableVerification` — immutable receipt-grade evidence.
- `canonical/reconstruct.ts:reconstructCandidate` — exact manifest/author/tree/commit reconstruction.
- `github/fork.ts:checkForkReadiness` and `github/fork-ref.ts:forkTarget` — authenticated fork binding.
- Existing bare push rig and github-fake — offline integration adapters.

## Risk Areas
- Trap index read in full: immutable operation attempt replay is fenced separately from nonce; detached snapshots must span asynchronous probes; boundary evidence must be the run's own authoritative verdict.
- Durable planning uses docs/planning because PLANNING files are ignored; never force-add.
- Existing private-package coverage and strict warning-as-error lint remain mandatory. No version bump.

## Test Scope
Offline real ForkPusher / HandoffDriver round trip, all AC negative controls, missing records and command-plan mismatch, async caller mutation and reconstruction integrity. Run package coverage (90% statements/functions/lines, 85% branches), strict build, isolation and checkpoint tests, and repository CI parity.

## Open Questions
None.

## Visual Review
- [x] Not required (backend/infra only)

## Base Branch
`main`
