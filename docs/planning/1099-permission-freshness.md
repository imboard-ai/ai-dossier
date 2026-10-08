# Issue #1099: zero-trust permission-freshness probe

## Problem
Existing HandoffAdmission, RevisionAdmission and ReceiptContext accept injected freshness answers; supply their credential-free read-only implementation. Earlier scheduling comments are superseded by owner instruction. No existing plan artifact was found. Prerequisites #1091/#1092 are closed and the branch includes #1098.

## Acceptance Criteria
- [ ] AC1 Each staleness reason has a fixture test, and scenario 16 is one: the issue is closed after implementation, so `policyFresh()` is false and a `HandoffDriver.issuePr` attempt with this probe is refused, with no link issued.
- [ ] AC2 Any read failure throws, never answering `true`.
- [ ] AC3 Wired into a `PrTracker.beginRevision()` test (with `github-fake.ts`): a revoked invitation blocks the revision.
- [ ] AC4 The probe never uses credentials (credential-free `GitHubRead` only).

## Approach
1. Add `createFreshnessProbe` with immutable validated controller bindings, bounded reads, sanitized unavailable errors and detached reports.
2. Assess current repository/issue facts and resolve the default branch head. Discover pinned policy files; compare their digest using the gated assessment to reuse typed permission only for an unchanged snapshot. Otherwise classify the new snapshot conservatively and record its new digest. No model calls or fallback permission.
3. Map closed/locked issue, competing assignment, missing required assignment and competing PR to explicit reasons; exempt only the contributor's explicitly bound own upstream PR. Block other ineligibility rather than treating it as fresh.
4. Reuse bounded `checkInvitation` after the gated invitation timestamp with a no-op persistence callback. Later authorized declines revoke; ambiguous/unknown observations throw. This probe cannot infer issue-author authority absent an explicit repository rule; maintainer association is the authority floor.
5. Export public API and document report/error semantics and admission/receipt usage. Add fixture and real caller-seam regressions, including GitHubFake recording assertions.

## Reachability Evidence
N/A — library admission infrastructure for existing publication/revision seams, not a new database-reachable product state. Concrete inputs are credential-free GitHub REST issue closure, assignment, cross-reference and comment records; PRD scenario 16 and the existing driver tests exercise their consumers offline.

## Predicted Files
- `packages/zero-trust/src/policy/freshness.ts` — public probe.
- `packages/zero-trust/src/policy/__tests__/freshness.test.ts` — bounded read/staleness fixtures.
- `packages/zero-trust/src/github/__tests__/track.test.ts` — real revision admission fixture.
- `packages/zero-trust/src/index.ts` — exports.
- `packages/zero-trust/README.md` — public API spec.
- `packages/zero-trust/src/github/__tests__/contributor-handoff.test.ts` — scenario 16 caller fixture (or existing hand-off test rig file).

## Reusable Code
- `discoverPolicy`, `classifyPolicy`, `policyDigest` — pinned bounded policy evidence and restriction-only floor.
- `assessIssue` — validated detached repository/issue/timeline/PR facts.
- `checkInvitation` — bounded comment/timeline authority and revocation observation.
- Credential-free handoff/value validators; existing HandoffDriver/PrTracker rigs.

## Risk Areas
- Unknown/truncated/malformed reads must throw even if another observation already establishes staleness.
- Policy classification no longer infers permission from prose (#1091/#1120): reuse typed gated assessment only for unchanged evidence. Changed permissive evidence must respect conservative classifier semantics.
- Invitation and eligibility mutation/identity traps (#1092/#1098); never retain mutable input across awaits or import credential modules even as types.
- Planning scaffold is ignored: durable plan lives here per #1091 trap; no force-add.
- Warm pool dist can be stale: rebuild before package/full gates. Private package requires no version bump or changeset.

## Test Scope
Fixture tests for each reason, unchanged policy, changed still-permitting policy, own-PR filtering, pagination/transport/shape failures, caller mutation, sanitized errors and credential-free request recording. Real HandoffDriver closure refusal and PrTracker revoked-invitation refusal; credential import isolation. Run lint, strict package build, package coverage and full repository gates prescribed by ship.

## Open Questions
None.

## Visual Review
- [x] Not required (library/backend only)

## Base Branch
`main`
