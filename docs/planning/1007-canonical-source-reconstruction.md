# Issue #1007: Canonical source export and deterministic reconstruction

## Problem
Implement PRD §5.7/5.9 scenario 17 as a pure controller-owned mechanism. Worker files and Git settings cannot determine the tested/shipped commit identity. No prior plan artifact exists. Foundation #1004 and predecessors #1005/#1006 are merged.

## Acceptance Criteria
- [ ] Accepts only regular files (with exec bit) and directories. **Rejects** (never silently drops): symlinks, gitlinks/submodules, FIFOs/devices/sockets, any `.git` path component, `..`/absolute paths, case-folding collisions (`A.txt` vs `a.txt`), Unicode-normalization collisions, files over a configurable size cap (default 10 MiB), total size over cap.
- [ ] Same rejection applies to the **baseline** tree: a baseline containing symlinks/gitlinks → `unsupported` reason.
- [ ] Trusted git runs with an isolated environment: `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `HOME` → empty temp dir, `core.hooksPath=/dev/null`, no credential helper, no filters/attributes from the artifact (`GIT_ATTR_NOSYSTEM=1`, ignore in-tree `.gitattributes` for filter/diff drivers), `protocol.allow=never` except explicitly passed.
- [ ] Commit fields: parent = supplied upstream base SHA; author name/email/UTC timestamp recorded once from contributor approval; committer = disclosed ai-dossier identity with fixed recorded timestamp/message. Inputs persisted so reconstruction is **byte-for-byte reproducible** (same inputs → same SHA, asserted in test).
- [ ] Wrong parent, altered author fields, or recomputed tree ≠ manifest → typed rejection.

## Predicted Files
- `packages/zero-trust/src/canonical/export.ts` — bounded descriptor-anchored source snapshot and path validation.
- `packages/zero-trust/src/canonical/trusted-git.ts` — isolated temporary bare Git, no inherited environment/config/template.
- `packages/zero-trust/src/canonical/reconstruct.ts` — baseline inspection, immutable contract and deterministic plumbing.
- `packages/zero-trust/src/__tests__/canonical.test.ts` — real hostile files, hooks/filters/config/environment, deterministic identity and tamper fixtures.
- `packages/zero-trust/src/index.ts` — public exports.
- `packages/zero-trust/README.md` — API trust boundaries, persistence, limits/platform contract.

## Approach
1. Reject unsafe names and source object types; cap bytes, entries and depth. Use Linux descriptor-relative paths and O_NOFOLLOW with pre/post identity checks to prevent directory/symlink races; fail closed on unsupported platforms.
2. Export copied blob bytes as immutable base64 plus digests/modes/paths; validate and bind their canonical manifest in controller-owned persisted records. Directories participate in validation (empty directories have no Git identity).
3. Receive upstream objects as a bounded Git pack, never a worker repository path. Import into a newly initialized private bare repository using strict plumbing; inspect baseline trees recursively before accepting candidates.
4. Persist approved contributor fields, fixed UTC seconds, disclosed committer, message, parent/tree/candidate SHAs and manifest digest once. Reconstruction checks independent controller binding and exact inputs; read back commit/tree for conformance.
5. Run full security/architecture/quality/conformance inline (no subagent tool available), local CI-parity and native Node20/22 CI; ship via head-pinned REST then confirm two exact-SHA Vercel production deployments.

## Reachability Evidence
N/A — greenfield pure source/commit mechanism, not a production-data-reachable state. Real hostile temporary filesystem and Git object fixtures supply inputs; provider/runtime integration is outside this issue.

## Reusable Code
- `packages/zero-trust/src/intents.ts` — immutable input snapshots and typed non-echoing rejection pattern.
- `packages/zero-trust/src/journal.ts` — mutable default fs import for meaningful failure/race injection.
- Node crypto SHA-256 and Git raw plumbing; no new dependencies.

## Risk Areas
Filesystem TOCTOU, malformed raw trees and invalid UTF-8 paths, inherited Git env/config/template/filter execution, mutation after validation, resource bounds. Do not open any worker Git repository. Controller must persist binding outside worker access. Shared worktree/stash untouched. Pool replenishment hit max10; existing warm entry claimed and verified at fresh origin/main 5cd28db.
Read AGENTS, full PRD, infrastructure lessons and trap index. Known local hostname fixture trap (#1012): reproduce baseline failures independently, disclose normalization, require native CI. Git skip markers must never appear in squash message.

## Test Scope
Real symlink/FIFO/socket/gitlink, traversal/case/Unicode/invalid byte paths, size/depth/entry limits, file/directory replacement race fixtures; baseline rejection; sentinel-producing real attributes/filter/hooks and inherited environment poisoning; byte-identical double reconstruction; parent/author/tree/manifest tampering and serialized roundtrip. Build all, lint, audit, full coverage plus scripts; baseline reproduce fixture failures.

## Open Questions
None.

## Visual Review
- [x] Not required (backend pure mechanism only)

## Base Branch
`main`
