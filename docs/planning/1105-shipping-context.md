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

## Execution outcome — bounded review handoff

Run `r-1105-1a9a` completed implementation and three progressing repair passes.
Initial full independent review covered DRY, security, supportability,
maintainability, documentation, conventions and blind conformance. Subsequent
fresh blind conformance reports marked all nine criteria met, but independent
runtime security/supportability probes still reproduced unresolved defects on
`9790535`:

1. A mutable HandoffAdmission adapter can replace `commitPr` during reconciliation
   and publish after authoritative cancellation. Capture/bind every admission
   method and reject replacements before publication.
2. The captured RunStore validation method still delegates to mutable public
   `validateOutcomeEvidence`; replacing that method can mask durable cancellation.
   Fix the authoritative validation chain rather than adding another field guard.
3. A request's aliased intent can change during final policy admission; the
   journal then records a different candidate SHA than the verified receipt.
   Detach the entire request before queueing/asynchronous work.
4. Receipt reservation insertion still precedes the outer asynchronous wrapper's
   authority check. A queued microtask can make admission return false while
   retaining the digest, preventing a same-instance retry. Commit reservations
   only after the enclosing check or roll back this invocation's reservation.
5. Final commit admission refreshes receipt/context but omits fresh contributor,
   fork-readiness and verified remote-head results after PR reconciliation.

No PR was opened and no merge/deploy was authorized. The review repair cap is
reached; continuation requires an explicitly authorized renewed repair cycle.
Last full package gate: 4,464 tests passed; 14 opt-in VM tests skipped. Coverage
96.13% statements, 93.56% branches, 98.34% functions, 97.71% lines. Strict build,
test-inclusive typecheck, warning-as-error lint and version-bump check passed.
The checkpoint path regression was independently reproduced red on isolated
origin/main and green with the corrected source.

## Owner-authorized renewal (2026-10-09)

Owner comment 6089198490 renews one standard cycle, at most three progressing
repair loops, on the preserved run and branch. The explicit threat model trusts
controller modules and constructed adapters; external responses/timing, VM/model/
repository/policy output, run-store filesystem contents and legitimate concurrent
lifecycle changes remain untrusted. Prior hostile method-substitution findings
are out-of-scope hardening notes, not unresolved blockers.

Renewed loop 1 binds driver admission and store validation callbacks once, freezes
one detached PR request at entry, commits receipt reservations only after the
enclosing authority/replay checks, and refreshes contributor/fork/verified remote
SHA before final receipt/context checks. Refused commit admission releases only its
own reservation token. Offline real-driver tests observe unchanged rendered/journal
provenance, changed external facts after PR reads, zero body/link effects on refusal,
and same-instance retry after legitimate pause/resume.

Renewed loop 2: independent report-only security/supportability/convention and
DRY/maintainability/documentation review reproduced a legitimate cancellation
after the final admission promise resolves, two missing-callback contract failures,
and valid source manifests refused by receipt JSON limits. These are valid,
deterministic fixes; duplicate callback/documentation findings collapse into one.
The driver now uses mandatory synchronous finalizePr immediately before publication;
the shipping admission rechecks held evidence/expiry and releases refused holds.
Missing callback capture remains fail-closed with fixed admission codes. Source
capture reuses validateManifest and compares its revalidated digest across awaits.
New tests record no body/link on final-promise cancellation/pause and exercise both
single-file and aggregate source sizes beyond receipt limits. No scope escalation.
