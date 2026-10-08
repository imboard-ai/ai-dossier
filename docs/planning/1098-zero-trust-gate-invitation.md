# Issue #1098: zero-trust gate decision, engagement and invitation

## Problem
Policy assessment and structured eligibility exist, and HandoffDriver already reconciles one contributor-confirmed engagement request. Add the policy composition and explicit-resume invitation observation APIs. Earlier fleet scheduling holds are superseded; #1091/#1092 are closed. No existing plan artifact.

## Acceptance Criteria
- [ ] AC1 Each `decideGate` table row is a test, including scenario 1 (ban, cited), scenario 2 (assignment required gives `request_permission`) and scenario 3 (direct PR welcomed gives `proceed` with no comment).
- [ ] AC2 Scenario 2, repeated resume: with the existing `HandoffDriver`, a second gate pass after the request was issued issues **no** second link (reuse the driver's existing reconciliation and assert it).
- [ ] AC3 `checkInvitation` gives `invited` only for an assignment of the contributor, or an affirmative comment by OWNER/MEMBER/COLLABORATOR, or by the issue author when the policy grants it. A CONTRIBUTOR or NONE association never counts.
- [ ] AC4 The evidence persisted for `invited` holds the actor, association, URL, policy digest and timestamp.
- [ ] AC5 A plan-first request gives `ambiguous`, with no transition and no new link.
- [ ] AC6 `engagementBody` always contains the LLM disclosure and passes `assertNoSecrets`, and it rejects facts that would push it over 1,500 characters.

## Approach
1. Add ordered data-driven gate rows with validated assessed input, ban citation, no effects, and ReasonCode suggestions for blocking/permission outcomes.
2. Render a bounded deterministic engagement template from whitelisted controller primitives, snapshot/scan before interpolation, always disclose substantial LLM assistance and request assignment/welcome.
3. Add a bounded credential-free invitation reader called only on explicit resume. Snapshot bindings/options and each REST page; validate identity, timestamps, association and completeness. Never follow response URLs. Interpret only whole unqualified affirmative/negative phrases; caveats, conflicting signals and other authorized prose are ambiguous.
4. Accept contributor assignments as authority evidence; apply explicit controller-resolved repository authority policy for author comments. Combine chronological comments/events, fail closed on incomplete data, persist only unambiguous invitation evidence via an injected callback before returning the transition suggestion.
5. Export/document APIs and add offline fixture tests plus a real HandoffDriver/github-fake durable round trip for single-request reconciliation.

## Reachability Evidence
N/A — this is a controller policy API addition implementing the specified imminent S2 workflow, not a production database state. Concrete inputs are existing PolicyAssessment/Eligibility and GitHub REST comments/timeline responses; offline recorded-shape fixtures verify reachable branches. No production data store is involved.

## Predicted Files
- `packages/zero-trust/src/policy/gate.ts` — ordered gate table
- `packages/zero-trust/src/policy/engagement.ts` — deterministic body
- `packages/zero-trust/src/policy/invitation.ts` — bounded explicit-resume reads and persistence
- `packages/zero-trust/src/policy/__tests__/gate.test.ts` — table and driver integration
- `packages/zero-trust/src/policy/__tests__/engagement.test.ts` — disclosure, bounds and secrets
- `packages/zero-trust/src/policy/__tests__/invitation.test.ts` — authority, completeness and ambiguity
- `packages/zero-trust/src/index.ts` — API exports
- `packages/zero-trust/README.md` — public contract

## Reusable Code
- `github/handoff.ts` issueBinding/isGitHubLogin, `github/reconcile.ts` GitHubRead.
- `github/handoff-driver.ts` existing at-most-one request and reconciliation; unchanged.
- `policy/classify.ts` PolicyAssessment and citation shape; `policy/eligibility.ts` Eligibility.
- `redaction.ts` assertNoSecrets, `state.ts` ReasonCode/isTimestamp.

## Risk Areas
- Credential import-chain isolation, page completeness, reader mutation, negated or qualified invitation prose and authority spoofing. Explicit association validation and anchored conservative rules, no model or polling.
- Prior traps: snapshot primitives before redaction/interpolation; detach REST pages across awaits; no credential type imports. Warm dist must be rebuilt before package coverage.
- Root PLANNING artifacts are ignored: this tracked docs/planning file is the durable plan.
- Private package: no version bump/changeset. New source/tests already included by package CI.

## Test Scope
Focused API tests, existing HandoffDriver round trip with fake GitHub and external temporary journal, package build + full coverage (90/90/90/85 thresholds), CI-mode lint and version gate. Native PR CI includes VM gate.

## Open Questions
None. Author authority is a typed controller-owned repository-policy fact, not inferred from comment text. Ambiguous prose never grants permission.

## Visual Review
- [x] Not required (backend only)

## Base Branch
`main`
