# Issue #1104: artifact retention sweep and sanitized contribution export

## Problem
Controller-owned contribution stores retain bulky execution artifacts indefinitely and lack a portable, secret-checked portfolio export. Expiry must preserve reconciliation, replay protection, honest evidence and public links. The metrics slice is not a dependency: derive facts from existing run, tracker, receipt and budget evidence; missing or corrupt evidence must never become a known zero cost or successful outcome.

No existing plan artifact was present. The prior fleet scheduling comment is superseded by the direct run-store route confirmed in this run's pickup comment.

## Acceptance Criteria
- [ ] AC1 The dry-run plan lists only `artifacts/` files of expired contributions. `applySweep` keeps every protected store byte-for-byte (hash before and after).
- [ ] AC2 After a sweep, `summary.json` exists, `assertResumable` refuses, and status still shows the URLs and SHAs.
- [ ] AC3 A crash during `applySweep` (a fault injected after the summary is written) is idempotent on rerun.
- [ ] AC4 `exportContribution` output validates against `ztfc-export-v1`. A planted `ghp_…` string in any source record makes the export fail rather than redact silently.
- [ ] AC5 The retention period comes from `config.retentionDays` (default 30).

## Approach
1. Add explicit dry-run sweep planning with a fixed injected clock, per-store configured retention (30-day default), strict contribution identity and a removable-file allowlist confined to regular files beneath `artifacts/`. Reject symlinks, traversal, stale/forged plans, unreadable evidence and active lifetime guards. Never sweep `blocked_cleanup`.
2. Use the controller lifetime guard and pinned directory descriptors for applying a plan. Revalidate identity, activity, retention and file identity before any deletion. Publish a durable summary containing URLs, SHAs, receipt digests, evidence-derived outcome and cost totals before expiry/deletion. Keep all protected bytes unchanged, including `run.json` and journals; persist the monotonic `snapshotExpired` marker separately in summary metadata.
3. Make expiry crash-safe and idempotent: fsync the summary and expiry marker before deleting any planned regular files; fsync each changed parent directory. Reruns after an interrupted prefix reuse the same evidence and tolerate only already-removed planned files. Keep the artifacts root and protected directory skeleton.
4. Add `assertResumable(store)` and enforce it in the actual controller resume identity path. Expiry cannot be cleared to reuse the old snapshot; fresh acquisition/reconstruction and independent verification require a fresh run. Read-only status/export remain available.
5. Build `ztfc-export-v1` with a public schema and runtime validator. Export a detached run/history, status, summary, receipt envelopes with verified digests, verification metadata without logs, observed PR/outcome, disclosure and policy citations. Scan every raw source string before projection and every output string, exclude environment and credential/replay stores, validate before exclusive 0600 output creation, fsync file and parent directory.
6. Document every public API and storage/evidence convention in the package README, preserving receipt v2, credential isolation and contributor-confirmed upstream write authority. Use existing producers and local structural types, never import credential modules or copy the retained metrics branch.

## Reachability Evidence
- State: expired local artifact set | Trigger: controller contribution created by `RunStore.create`, activity timestamp older than configured retention, files under `artifacts/` | Prod check: N/A — explicit local filesystem infrastructure, no production database state or network workflow required. Real temporary RunStores and existing receipt/tracker/budget producers provide executable fixtures.
- State: expired-snapshot refusal and export | Trigger: explicit sweep/export API invocation | Prod check: N/A — local persistence APIs; fixed-clock crash-prefix fixtures cover the reachable condition.

## Predicted Files
- `packages/zero-trust/src/retention/retention.ts` — sweep plans, durable expiry and resumability checks.
- `packages/zero-trust/src/retention/export.ts` — schema, validation and exclusive sanitized export.
- `packages/zero-trust/src/retention/evidence.ts` — bounded credential-free evidence projection shared by sweep/export if needed.
- `packages/zero-trust/src/retention/retention.test.ts` — fixed-clock, protected-byte, crash and adversarial sweep tests.
- `packages/zero-trust/src/retention/export.test.ts` — producer-backed portable exports, secret detection and exclusive-file tests.
- `packages/zero-trust/src/retention/evidence.test.ts` — shared evidence corruption and missing-evidence coverage if factored.
- `packages/zero-trust/src/controller/run-store.ts` — pinned guarded retention access and resume expiry enforcement.
- `packages/zero-trust/src/index.ts` — public API exports.
- `packages/zero-trust/README.md` — spec of record.
- `docs/planning/1104-artifact-retention-export.md` — durable implementation blueprint.

## Reusable Code
- `controller/run-store.ts`: lifetime flock, pinned directory, durable config digest, control replay and immutable run snapshot.
- `controller/config.ts`: `retentionDays` validation and existing default 30.
- `durable-fs.ts`: private atomic publication and directory fsync.
- `receipt/schema.ts`: canonical JSON, receipt v2 parsing and strict JSON checks.
- `receipt/issue.ts`: actual signed envelope and canonical receipt digest.
- `github/track.ts`: actual `track`, `outcome`, `rebound` and revision journal records, verified and outcome SHAs.
- `budget.ts`: actual validated budget snapshots and conservative totals.
- `redaction.ts`: `assertNoSecrets` and recursive `assertSecretFree`.

## Risk Areas
- RunStore's confirmed journal/snapshot protocol prohibits editing run.json for expiry; separate durable metadata avoids divergence and satisfies protected-byte preservation.
- Existing checkpoint/replay barriers remain intact. Directory pinning and permanent lifetime guards must span planning/apply/export and resume checks.
- Missing evidence is unknown, not zero or merged. Optional evidence present but unreadable/corrupt is fail-closed. Export scans excluded fields in each selected source record before projection.
- Receipts and verification producers currently return records; define and document narrowly bounded controller evidence persistence conventions if no existing on-disk record exists. Do not infer authority from arbitrary artifacts.
- Traps: ignored planning scaffold (#1091), warm dist prerequisites (#1027), snapshot confirmation (#1090), mutable fs spies (#1005), strict test typecheck (#1024), concurrent coverage filesystem load (#1101), pool return from another worktree (#993).

## Test Scope
- Every AC gets real temporary-store assertions, including hashes of every protected file before/after apply and status links/SHAs after reopening.
- Fixed clocks cover configured/default retention, exact cutoff, fresh contributions and blocked_cleanup. Fault injection after summary and after deletions verifies durable idempotent replay.
- Adversarial symlink ancestors/leaves, traversal/forged plans, changed activity, held guard, corrupt/truncated evidence, planted credentials in nested/discarded source fields, missing optional evidence and exclusive destination tests.
- Build all before tests; full lint with warnings failing; full workspace/repo tests; zero-trust coverage with unchanged 90/85 thresholds; supplemental strict no-emit typecheck including changed tests.
- Independent report-only full review dimensions followed by serial fixes and blind AC conformance; fresh final-head conformance before merge authorization.

## Open Questions
None.

## Visual Review
- [x] Not required (local backend persistence only).

## Base Branch
`main` — PR targets this branch. Private zero-trust package requires no version bump or changeset. CLI exposure is outside this issue.
