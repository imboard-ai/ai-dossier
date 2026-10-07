# Issue #1093: credential-free upstream source acquisition

## Problem
The canonical candidate APIs consume complete Git packs, but production has no credential-free upstream acquisition producer. Implement the explicitly specified source-broker primitive; prior scheduling comments have been superseded by the authorized serial fleet.

## Acceptance Criteria
- [ ] AC1 Against a local bare "upstream", `acquireSource` returns a pack for which `createCandidate(...)` succeeds with that `baseSha`, and a manifest equal to `exportSource` of the same tree.
- [ ] AC2 A baseline that contains a symlink, a gitlink (submodule) or a `.git`-alias path is refused with `unsupported`.
- [ ] AC3 A malicious upstream with a `post-checkout` hook sentinel and a filter-driver sentinel in `.gitattributes`: neither sentinel fires (positive control: the same sentinel fires when run outside `TrustedGit`).
- [ ] AC4 The URL builder rejects owner and repo names with `/`, `..`, `%`, whitespace or a scheme, and only ever yields `https://github.com/…`.
- [ ] AC5 Without the test seam, the fetch refuses every non-HTTPS protocol (unit test on the config `TrustedGit` passes).
- [ ] AC6 The pack size bound is enforced: an oversize pack is refused without being written to the run store.

## Approach
1. Add a locally structural credential-free reader and validated fixed GitHub URL construction; resolve only a valid branch head SHA.
2. Add per-fetch TrustedGit source transport options, disjoint from credential environments, disabling redirects and other protocols.
3. Fetch shallow into fresh bare storage, produce a bounded pack and retry with complete ancestry only on strict shallow-import rejection.
4. Export baseManifest using importBase/inspectTree; map unsupported baseline paths and collisions to unsupported while preserving limits.
5. Export/document APIs and exercise offline adversarial fixtures and positive sentinel controls.

## Reachability Evidence
N/A — infrastructure primitive, not a production-data state. The existing createCandidate baselinePack input is the concrete consumer; local Git fixtures establish shallow parent rejection and complete-pack compatibility.

## Predicted Files
- `packages/zero-trust/src/canonical/acquire.ts` — acquisition API.
- `packages/zero-trust/src/canonical/trusted-git.ts` — narrowly scoped transport and bounded pack output.
- `packages/zero-trust/src/canonical/reconstruct.ts` — shared base manifest validation.
- `packages/zero-trust/src/canonical/export.ts` — unavailable error reason.
- `packages/zero-trust/src/index.ts` — public API exports.
- `packages/zero-trust/src/__tests__/acquire.test.ts` — offline acceptance/negative controls.
- `packages/zero-trust/README.md` — API and shallow fallback contract.

## Reusable Code
TrustedGit sanitized configuration; importBase strict object import; inspectTree raw traversal; exportSource manifest equality; existing canonical fixture patterns.

## Risk Areas
Incomplete shallow ancestry must not escape validation. Credentials must never accompany source fetch. Test URLs require VITEST and local file transport only. Pack limits must be enforced before successful output. Trap index: stale local main and skip-marker squash bodies require origin/main comparisons and clean shipping messages.

## Test Scope
Local bare repositories with parent commits, malicious tree entries and sentinel hooks/filters. Reader failures and URL injection. Protocol/env config rejection and oversize output. Strict workspace build, full 90/85 coverage, repo lint and full repo tests.

## Open Questions
None. The repo ignores PLANNING-*.md; this durable plan uses docs/planning/issue-1093-source-acquisition.md to respect the no-force-add rule.

## Visual Review
- [x] Not required (backend/infra only)

## Base Branch
`main`
