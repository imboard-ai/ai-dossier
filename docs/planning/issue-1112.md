# Issue #1112: Mid-run user edits, model-profile and checkpoint changes

## Problem
Paused runs need trusted contributor source edits and model/checkpoint changes without changing identity, targets, budgets, or reusing stale verification. Historical dependency blockers are obsolete: #1110 merged at 6f945b9. The epic owner excludes hostile in-process and active same-user attacks; corruption, crashes and concurrent legitimate controllers remain in scope.

## Acceptance Criteria
- [ ] AC1 A user patch while paused in `implementing` goes through `CandidateReady`, then a **fresh verification**, and the shipped candidate includes the user's change.
- [ ] AC2 A patch with a traversal path, a symlink, a binary hunk or a `.git` path is refused, and the overlay is unchanged.
- [ ] AC3 An edit when paused from `shipping` is refused with `edit_after_verification`.
- [ ] AC4 A model change keeps every ledger session and reservation byte-for-byte, the next model call uses the new adapter, and verification is not invalidated (scenario 8: the same admission rules apply).
- [ ] AC5 Missing rates for the new model refuse the change, and the run stays paused.
- [ ] AC6 Changing the contributor or issue is refused.

## Predicted Files
- `packages/zero-trust/src/controller/edits.ts` — trusted patch application and closed user mutation APIs.
- `packages/zero-trust/src/controller/edits.test.ts` — offline crafted patches and durable mutation tests.
- `packages/zero-trust/src/controller/run-store.ts` — journaled paused mutations under the lifetime guard.
- `packages/zero-trust/src/controller/steps.ts` — candidate reconstruction and edited source consumption.
- `packages/zero-trust/src/controller/controller.ts` — invalidate cached phase outcomes after source edits.
- `packages/zero-trust/src/controller/wiring.ts` — current model selection and contributor-edit disclosure.
- `packages/zero-trust/src/controller/verification-record.ts` — reject superseded evidence.
- `packages/zero-trust/scripts/zt-run-lib.mjs` — edit and resume option parsing.
- `packages/zero-trust/scripts/zt-run-bindings.mjs` — local trusted mutation dispatch before resume.
- `packages/zero-trust/README.md` — public API and shipping-pause refusal.

## Approach
1. Journal closed paused mutations with integrity digests under RunStore's existing exclusive guard; retain immutable original configuration and replay effective profile/checkpoint settings in event order.
2. Strictly validate text Git diffs and paths, apply check/apply in TrustedGit's fresh controller-owned workspace, export the result, reconstruct a unique canonical candidate, and retain patch digest/files/time disclosure.
3. Fence old verification records and cached outcomes; resume implementing through CandidateReady or verifying through ResumeVerifying with a fresh review and verifier. Keep checkpoint approvals bound to the edited candidate.
4. Validate profile rates, adapter availability and key presence before publishing; never touch the ledger. CLI is the only route for checkpoint configuration input.
5. Run offline regression and composed controller fixtures, strict build, lint, coverage and repository CI parity, followed by independent security/architecture/quality/conformance review.

## Reachability Evidence
N/A — explicit local CLI/controller commands, not a production data-reachable condition. #1110 supplies paused_user from implementing/verifying/shipping; the concrete trigger is contributor invocation of edit or resume options. This new private capability has no production database.

## Reusable Code
TrustedGit, WorkspaceOverlay.materialize, exportSource, createCandidate/reconstructCandidate, StepArtifacts, RunStore lifetime guard, validateRunConfig/requireBudgetRates and existing offline controller edge fixtures.

## Risk Areas
Crash consistency across candidate publication and supersession; stale cached outcomes and checkpoint approvals; execution-bit/deletion/rename semantics; profile cache and ledger rate admission. Preserve unrelated main-worktree dossier and sibling #1113 lifecycle test file; #1111 owns revision integration. Trap index read in full: skip-marker squash bodies, stale local-base review diffs, bound waits and latest check-run selection apply at ship.

## Test Scope
Crafted traversal, symlink, binary, mode and .git patches; valid text/exec-bit patches; unchanged overlay on refusal; paused shipping refusal; reopening and corruption; model changes preserve exact ledger bytes and fail missing rates/keys; identity refusals; controller resume with fresh verification and edited candidate. No live GitHub/model/registry calls.

## Open Questions
None.

## Visual Review
- [x] Not required (controller and CLI only).

## Base Branch
`main`
