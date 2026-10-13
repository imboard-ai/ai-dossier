# Issue #1193: zero-trust: start asks the contributor to authorize twice

## Problem
The live #1115 run 5 opened OAuth once for author approval and again for fork credentials. Pre-start consent currently revokes its token, so the controller cannot reuse it. The second prompt can expire after the contributor leaves.

## Acceptance Criteria
- [ ] AC1 Start shares the identity authorization with the credential owner, requiring one authorization page in the process.
- [ ] AC2 Access and refresh tokens remain private process memory; only existing credential metadata is journaled.
- [ ] AC3 Declined consent, start refusal, unused sessions and completed/paused runs revoke owned credentials; mismatched identity cannot seed a broker.
- [ ] AC4 Fresh-process resume retains existing identity checks and explicit reauthorization behavior.

## Approach
1. Add an opaque, disposable pre-start authorization session retaining a validated pair inside ContributorAuthorization; keep the existing one-shot prepareAuthor API.
2. Transfer that pair once to a fork-bound broker after recovery, preserving refresh ownership and bound numeric account identity.
3. Pass the session through command bindings into controller wiring without placing it in RunConfig or artifacts.
4. Dispose unconsumed sessions on confirmation refusal, start failure and release. Test one real loopback callback through the production composition.

## Reachability Evidence
N/A — repair of an existing controller credential flow, reported in live #1115 run 5; no new data-reachable lifecycle state.

## Predicted Files
- `packages/zero-trust/src/github/contributor.ts` — private pair ownership and one-shot adoption.
- `packages/zero-trust/src/controller/wiring.ts` — session creation and credential handover.
- `packages/zero-trust/scripts/zt-run-bindings.mjs` — pending session ownership.
- `packages/zero-trust/scripts/zt-run-lib.mjs` — disposal around confirmation.
- `packages/zero-trust/src/github/__tests__/contributor-author.test.ts` — transfer, identity and disposal regressions.
- `packages/zero-trust/src/controller/wiring-commands.test.ts` — composition credential regression.
- `packages/zero-trust/scripts/zt-run-bindings.test.mjs` — command lifecycle regressions.

## Reusable Code
ContributorAuthorization.hold/discard/bindLogin/refresh, broker.registerUserToken, existing broker recovery and controller release, real loopback fixtures.

## Risk Areas
Unjournaled credentials need an explicit owner before fork discovery. Recovery must precede adoption because recovery revokes held tokens. Keep #1202 broker mint/recovery methods untouched and #1194 provisioning wiring narrow. Do not import #1191's unmerged branch. Trap index: paused-run credential release (#1113), token-free approval/status, ignored planning artifacts, stale warm dist, native auto-merge confirmation and release exact-SHA proof.

## Test Scope
Targeted author/session, wiring and command suites; isolated base red-before-green single-page composition test; full zero-trust coverage, build, lint and repository CI parity where defined.

## Open Questions
None.

## Visual Review
- [x] Not required (controller/credential plumbing only).

## Base Branch
`main`
