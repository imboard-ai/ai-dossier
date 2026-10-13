# Issue #1181: live export evidence

## Problem
Live controller runs never write the three evidence sources consumed by retention export. Only fixture runs currently export receipts, independent verification, disclosure and policy citations.

## Acceptance Criteria
- [ ] AC1 Shipping/verification producers persist export evidence with the real candidate identity.
- [ ] AC2 Export of a submitted composed run contains a signed receipt bound to candidateSha, verification summary, disclosure text and policy citations.
- [ ] AC3 Evidence persistence is durable, bounded, secret-checked and preserves fail-closed validation and retry/revision semantics.

## Approach
1. Add a controller evidence writer using the RunStore pinned directory and private atomic durable writes.
2. Persist actual verification CommandRecords before publishing verification completion; no invented report counts on recovery.
3. Retain distinct signed receipts before handing authorization to the pusher, preserving prior candidate evidence.
4. Persist the same disclosure rendered into PR content plus actual gate policy citations before issuing a handoff.
5. Add a real composed submitted export regression and focused failure/corruption checks.

## Reachability Evidence
N/A — repairs existing local controller persistence, introduces no new reachable state. Existing composed shipping and submission fixtures exercise the real producers with physical edges faked.

## Predicted Files
- `packages/zero-trust/src/controller/export-evidence.ts` — durable evidence producer helper.
- `packages/zero-trust/src/controller/steps.ts` — verification writer callback.
- `packages/zero-trust/src/controller/verifier.ts` — raw command evidence publication before completion.
- `packages/zero-trust/src/controller/wiring.ts` — narrow receipt and portfolio writes.
- `packages/zero-trust/src/github/pr-body.ts` — share exact disclosure rendering.
- `packages/zero-trust/src/controller/__tests__/e2e-fakes.test.ts` — submitted-run export regression.
- `packages/zero-trust/README.md` — document live producer storage.

## Reusable Code
RunStore.withPinnedDirectory, replacePrivate/readPrivate, canonicalJson, assertSecretFree, parseVerification, parsePortfolio and offlineReceipt provide existing storage/validation conventions.

## Risk Areas
Read AGENTS.md and docs/agent-traps.md in full. Preserve actual skipped counts, candidate/receipt binding and historical evidence; avoid inferred verification success. Writes must precede externally visible shipping and completion. #1182 owns broker cleanup and #1191 owns Controller.step stop notices; do not modify those symbols. Inspect updated origin/main before merge. Private zero-trust package is not npm-published.

## Test Scope
Composed submitted export without manual seeding; candidate SHA and all evidence nonempty; resume/revision regressions; retention validation suites; full build, lint and repository CI-equivalent tests with longer fs-heavy deadlines as necessary.

## Open Questions
None.

## Visual Review
- [x] Not required (backend only).

## Base Branch
`main`
