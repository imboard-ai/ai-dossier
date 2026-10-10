# Issue #1108: controller composition root

## Problem
Connect the real controller phases from supplied issue to verified fork push and
contributor-submitted PR. Owner comment 6094631068 resolves the prior authorship
handoff: consume explicit persisted authorApproval, never infer identity in the root,
and refuse a missing approval or authenticated numeric-account mismatch.

## Acceptance Criteria
- [x] End-to-end test with edge fakes only reaches awaiting_contributor, then submitted with persisted PR URL and honestly pending/awaiting-approval/unknown CI; fork SHA equals independently verified candidate SHA.
- [x] Permission-required policy produces one engagement link and awaiting_maintainer; repeated resume produces no second link.
- [x] An AI ban blocks before VM creation.
- [x] Three verification failures exhaust the two repairs and fail without a fork push.
- [x] A boundary breach blocks with no receipt and untouched fork ref.
- [x] Credential isolation admits only the unexported wiring root and detects another source module importing it.

## Predicted Files
- `packages/zero-trust/src/controller/wiring.ts` — credential-bearing composition root, excluded from package exports.
- `packages/zero-trust/src/controller/steps.ts` — credential-free real phase glue.
- `packages/zero-trust/src/controller/__tests__/e2e-fakes.test.ts` — real producers/drivers and local Git with edge fakes.
- `packages/zero-trust/src/github/__tests__/isolation.test.ts` — wiring boundary and negative self-check.
- `packages/zero-trust/README.md` — composition contract.
- `packages/zero-trust/src/controller/config.ts` — closed author approval schema.
- `packages/zero-trust/src/controller/config.test.ts` — approval validation controls.
- `packages/zero-trust/src/controller/author-approval.ts` — authenticated approval binding.
- `packages/zero-trust/src/controller/author-approval.test.ts` — missing/mismatch refusal.

## Approach
1. Validate and digest-bind persisted authorApproval; recheck authenticated account
   before candidate construction, resume and shipping. CLI confirmation belongs to #1109.
2. Compose real gate/freshness, source/profile/evidence, model, scope, verifier,
   drift and shipping implementations under the existing RunController fence.
3. Construct credential drivers only in wiring; retain durable run-owned source,
   approval, candidate, verification, intent, receipt and hand-off bindings.
4. Exercise all acceptance paths using edge fakes only, and enforce package
   coverage, strict production/test typechecks and full repository CI-parity gates.

## Reachability Evidence
N/A — infrastructure composition of already implemented lifecycle states. The
trigger is trusted start(config) followed by explicit resume(runId), not a
production-data condition. Existing canonical and shipping fixtures demonstrate
that a real candidate needs explicit held author inputs.

## Reusable Code
- `canonical/reconstruct.ts:createCandidate` and `reconstructCandidate` bind exact approved author and parent.
- `controller/controller.ts:RunController` owns state persistence, allocation admission, recovery and cleanup.
- `controller/shipping.ts:makeAuthorize` and `makeHandoffAdmission` bind immutable verification, fresh authority and verified remote read-back.
- `github/contributor.ts:ContributorAuthorization` binds authenticated login/user ID without exposing credentials.
- Existing evidence runner, model loop, verifier, boundary probe and local bare-repository push rig supply the real implementation and test building blocks.

## Risk Areas
The owner threat model in issue #1105 comment 6089198490 applies: constructed
in-process components are trusted; external state/timing, filesystem corruption,
VM/model output and legitimate concurrent stopping are untrusted.

Read the complete trap index and searched controller, composition, credentials and
zero-trust paths. Relevant traps include transactional hand-off reservations,
fresh admission, unknown budget holds versus teardown, ignored planning files,
stale pool dist, source acquisition bounds and exact-SHA CI/release evidence.
This package is private; no version bump or changeset is appropriate.

## Test Scope
After the decision: offline edge-only E2E paths and focused step tests; real local
upstream/fork SHA read-back; zero-trust coverage at unchanged 90/90/90/85 thresholds;
strict builds and supplemental test typechecks; warning-as-error repository lint
and repository CI-parity checks. No implementation or test success is claimed.

## Open Questions
Resolved by owner comment 6094631068 (2026-10-10). The historical investigation
below is retained for provenance; it is no longer an open decision. Implement
authorApproval { userId, login, name, email, source, approvedAt } in trusted config;
consume only that approval and refuse missing/mismatched account authority.

### Contributor-approved canonical author (owner preference, not runtime fact)
PRD §5.9 requires authenticated contributor-approved name/email recorded once
before canonical construction (`docs/features/zero-trust-full-cycle/prd.md:259`).
`ContributorApproval` requires login, name, email and timestamp
(`packages/zero-trust/src/canonical/reconstruct.ts:15-21`), and `createCandidate`
requires those approved inputs (`:278-285`). Reconstruction compares the exact
held author (`:328-331`); shipping uses that authority (`controller/shipping.ts:363-405`).

The closed RunConfig has a contributor login but no author approval field
(`controller/config.ts:42-80`); its raw allowlist rejects unknown fields
(`:175-190`). Contributor authorization returns authenticated login/user ID
(`github/contributor.ts:86-98`, `:170-177`), not a name/email approval.
The model candidate_ready action carries prose only and cannot approve identity
(`authority.ts:35-40`, `:55-61`). The optional checkpoints approve existing
plan/patch/verification bindings, not commit-author inputs.

The credentials probe used login plus numeric-ID GitHub noreply identity for its
owner-controlled fixture (`probes/github-credentials/probe.mjs:317-325`). That is
an available precedent, but no production contract says supplying contributor
or accepting OAuth consent approves that inferred identity for every user.

Owner choice needed:
1. Approve and document a universal default: authenticated login as author name,
   authenticated numeric-ID plus login as GitHub noreply email, with trusted
   whole-second timestamp. Explicitly define which existing consent approves it.
2. Add a trusted persisted author-approval input to config/start, bound to the
   authenticated login, with documented resume and CLI propagation semantics.
3. Add a distinct contributor identity-approval step before constructing candidates.

This is an attribution/consent preference. A throwaway runtime probe cannot decide
which identity the contributor authorized. Do not invent approval in production,
accept identity from repository/model output, or use an author override available
only to tests to simulate a production-complete path.

## Visual Review
- [x] Not required (controller infrastructure only).

## Base Branch
`main`. The issue branch includes the confirmed #1105 predecessor merge.

## Implementation phase evidence

The root and credential-free glue connect the real producers, broker, pusher,
handoff and tracker. The root consumes persisted approval and rechecks authenticated
numeric identity; it contains no identity-default or test-only author seam.
Permission requests preserve the actual contributor-comment journey. Phase VM
adapters use each current allocation lease; recovery reopens journals without
reinitializing consumed nonces. Immutable digest-named phase artifacts are validated
on reads. Scope discovery compares whole suites, not a targeted regression report
against the baseline suite. DCO trailers use the same approved identity.

Verification observed during implementation:

- Full zero-trust coverage: **4,526 passed**, 14 opt-in live VM tests skipped;
  97 passing test files and 2 opt-in files skipped.
- Coverage: **95.48% statements / 92.69% branches / 97.74% functions /
  97.24% lines**; unchanged 90/85/90/90 thresholds enforced over the complete package.
- **13 edge-only composition E2Es**, including all six issue controls, real
  loopback consent, persisted PR/CI observations, account mismatch on resume,
  prerequisite waits, DCO/real-name handling and legitimate mid-model cancellation.
- Focused artifact/approval/config/isolation suites passed, including actual-byte
  corruption, large source artifacts, config digest tampering and the actual import
  scanner run against a virtual unauthorized source import.
- Strict package build and strict no-emit typecheck including every changed/new test
  and its production/test dependencies passed. `make build-all` passed.
- Repository auto-fix and warning-as-error read-only lint passed; 408 repository
  script tests passed across 21 files.
- `ci_parity=skipped`: this repository has no `scripts/ci-parity.sh`; the gates above
  were run directly. `repro=n/a`: this is the composition feature.
- The first full coverage attempt had one cleanup-racer process flake; isolated
  replay and the complete one-worker coverage retry passed. No failing test was
  ignored, no coverage threshold changed, and no infrastructure implementation was
  changed to hide that flake.
- A strengthened model-request assertion found the real repair-state mapping:
  `repair_required` returns to `implementing`. The fixed composition uses the prior
  canonical candidate and its verified failure commands/verdict for repairs; the
  targeted assertion and final full coverage run both pass.

This is implementation evidence, not an independent review or shipping verdict.
