# Issue #1220: Retain policy gate hand-off evidence

## Problem
The composed gate discards assessPolicy's per-dimension evidence on hand-off, leaving status with only a reason and a false claim that no model work ran. No existing plan artifact was present.

## Acceptance Criteria
- [ ] AC1 Policy gate hand-offs retain the complete per-dimension decision evidence as a durable step artifact.
- [ ] AC2 Human and JSON status show escalated dimensions, decision reasons and available citations without model calls or writes.
- [ ] AC3 Gate notices distinguish policy decision calls from implementation work and never claim no model work ran.
- [ ] AC4 Retry and later lifecycle stops do not display stale policy evidence; legacy runs remain readable.

## Predicted Files
- `packages/zero-trust/src/controller/steps.ts` — write assessment before gate outcome.
- `packages/zero-trust/src/controller/stop-notice.ts` — accurate notice.
- `packages/zero-trust/src/status.ts` — bounded diagnostic status facts.
- `packages/zero-trust/scripts/zt-run-bindings.mjs` — observational artifact read and projection.
- `packages/zero-trust/scripts/zt-run-bindings.test.mjs` — actual CLI status regressions.
- `packages/zero-trust/src/controller/__tests__/composition.test.ts` — real producer regression (or dedicated suite using the fixture).
- `packages/zero-trust/README.md` — additive evidence contract.
- `docs/guides/zero-trust-contributions.md` — additive inspection guidance.

## Approach
1. Retain full policy assessment and gate outcome under a dedicated diagnostic artifact with the current history length and session binding, before returning any policy gate outcome.
2. Clear the selected diagnostic at each new gate attempt so early unknown reads cannot reuse old assessment.
3. Project exact current gating evidence into an optional bounded, secret-scanned status field; preserve accepted and escalated metadata and empty citation arrays honestly.
4. Replace the gate notice's no-model-work claim with precise implementation/VM/publication wording acknowledging policy calls may have been charged.
5. Exercise real typed assessment, durable reopen, status renderers, stale/legacy and corruption boundaries.

## Reachability Evidence
N/A — no new reachable state. This adds diagnostics to the existing policy hand-off branch. The issue records live run ztc-ac49377b173a99f1-run-1, ownership_unclear and nine charged calls. steps.gate already returns hand_off from decideGate; lifecycle behavior is unchanged.

## Reusable Code
StepArtifacts digest-named immutable records, policy assessment metadata, stopNoticeAction exact-history binding, canonicalJson bounded descriptor snapshots, assertSecretFree and existing composition fixtures.

## Risk Areas
Keep evidence diagnostic-only, separate from admitted GateRecord. Preserve decimal confidence strings and full validated citations. Empty citations are not invented evidence. Existing traps: integer-only StepArtifacts (#1111), stale warm dist (#1027), observational status and getter-safe secret guards (#1004). Package is private and requires no npm release bump. Parallel #1217 owns execution boundaries, #1219 decision headroom and #1223 implementation feedback; shared docs additions only.

## Test Scope
Real composed gate malformed typed response and paid ledger, successful/early retry clearing, JSON/human status with citations, legacy absence, stale history/session, corrupted artifact and secret-safe output. Build zero-trust first, focused suites, package coverage and repository lint/build/tests as required by implement dossier.

## Open Questions
None.

## Visual Review
- [x] Not required (controller and CLI diagnostics only).

## Base Branch
`main`
