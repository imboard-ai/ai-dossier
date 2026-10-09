# Issue #1107: upstream drift recheck and rebase before shipping

Planning path uses the tracked docs convention because repository-wide PLANNING-* files are ignored; no ignored file is force-added.

## Type
feature

## Problem
Shipping must fail closed on upstream drift and rebuild candidates only before publication intent. Source acquisition and verification are merged. Controller wiring (#1108), revisions (#1111), and gate scenarios (#1114) consume this API in later issues; they are not duplicate implementations. #1104 owns retention/receipt/run-store and remains disjoint.

## Acceptance Criteria
- [ ] AC1 `state.test.ts`: `base_advanced` is legal only from `shipping` to `verifying`, and every other state refuses it.
- [ ] AC2 Unchanged base: no new candidate.
- [ ] AC3 Advanced base touching no overlay path: a new candidate on the new parent, the old verification is not reused, and the run goes back to `verifying`.
- [ ] AC4 Advanced base touching an overlay path: `rebase_conflict` hand-off and no candidate.
- [ ] AC5 Three consecutive advances: `base_unstable` hand-off.
- [ ] AC6 Drift after the push: recorded, no transition, and the PR limitation text names both SHAs.
- [ ] AC7 `unknown` never results in shipping.

## Approach
1. Add only BaseAdvanced to the lifecycle and its independently asserted legal edge.
2. Expose immutable admitted overlay writes for drift reconstruction without reading guest files.
3. Add checkBase using resolveBase and rebaseCandidate using strict manifests, pack binding and createCandidate; conflicts include mode/structural changes as well as changed blob hashes, never text merge.
4. Add a credential-free checkShippingBase orchestration API: pre-intent unchanged admission, advanced rebuild/transition, unknown defer, conflict handoff, session counter cap. Post-intent and contributor waits return observations only, never rebuilding. Caller durably records outcomes/counter before journaled push intent, and revisions use the identical shipping guard.
5. Export and document APIs; verify offline with local bare source acquisition, canonical reconstruction and candidate-specific verification semantics.

## Reachability Evidence
N/A — local Git/controller infrastructure, not a production-database condition. A bound upstream branch moving while a canonical candidate is verified is the concrete trigger; local bare-repository tests exercise that input. No application data query applies.

## Predicted Files
- `packages/zero-trust/src/state.ts` — single new reason and edge.
- `packages/zero-trust/src/state.test.ts` — independent adjacency and every-state refusal.
- `packages/zero-trust/src/controller/workspace-overlay.ts` — immutable admitted delta API.
- `packages/zero-trust/src/controller/drift.ts` — credential-free drift check/reconstruction/policy.
- `packages/zero-trust/src/controller/drift.test.ts` — offline adversarial and AC tests.
- `packages/zero-trust/src/index.ts` — additive API export.
- `packages/zero-trust/README.md` — public API and state notes.

## Reusable Code
- `canonical/acquire.ts:resolveBase/acquireSource` — validated branch read and strict isolated Git import.
- `canonical/export.ts:validateManifest/createManifest/parentPaths` — frozen canonical source snapshots.
- `canonical/reconstruct.ts:baseManifest/createCandidate` — pack-to-manifest check, fixed author/message and new commit identity.
- `controller/workspace-overlay.ts:WorkspaceOverlay` — admitted controller-held writes, no guest adoption.
- `state.ts:transitionRun` — validated replayable lifecycle.

## Risk Areas
- Publication starts at journaled push intent, earlier than success: fence rebase on that boundary including failed/uncertain push and awaiting_contributor.
- A supplied new manifest must match the new parent's pack; reject collisions and ancestor file replacements without merging text.
- Counter is persisted by the composition root per budget session, never reset by unchanged checks.
- Private package: no version bump or changeset. Security isolation/no live network and coverage gate remain mandatory.
- Trap hits: build zero-trust before tests relying on dist; use fresh origin/main for conformance; never shared stash. Reconcile additive README/exports after parallel merges.

## Test Scope
Offline bare upstream advances, acquireSource test seam, synthetic overlay conflicts (changed/deleted/mode/ancestor), strict pack/manifest binding, malformed responses, new parent/author/message/SHA, old SHA record mismatch, pre-intent and post-intent policy, contributor wait and revision shipping, two-rebase counter across transitions. Run package build, full coverage, isolation and repo lint/build/test gates.

## Open Questions
None.

## Visual Review
- [x] Not required (backend/infra only)

## Base Branch
`main`
