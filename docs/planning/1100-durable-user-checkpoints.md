# Issue #1100: durable user checkpoints (plan, patch, verification)

## Problem
Optional user-configured checkpoints currently have lifecycle edges but no durable
record or approval binding. Prior fleet scheduling comments are superseded; #1090
and #1096–#1099 have merged. No prior plan artifact exists.

## Acceptance Criteria
- [ ] AC1 Each point pauses exactly once and persists its record before the `UserPaused` transition is persisted (crash between them: reopen finds the record and the run still at the pre-pause state, and pausing again is idempotent).
- [ ] AC2 An approval resumes to the interrupted phase only with the exact digest. A changed candidate SHA after the pause makes the old approval `checkpoint_stale`.
- [ ] AC3 The default config never pauses. A full run of fake steps reaches shipping without a checkpoint record.
- [ ] AC4 Records and status pass `assertNoSecrets`.

## Predicted Files
- `packages/zero-trust/src/controller/checkpoints.ts` — user checkpoint API.
- `packages/zero-trust/src/controller/checkpoint-record.ts` — pure validation and digest schema, without store cycles.
- `packages/zero-trust/src/controller/checkpoints.test.ts` — real temporary-store and crash tests.
- `packages/zero-trust/src/controller/run-store.ts` — guarded checkpoint journal persistence and recovery.
- `packages/zero-trust/src/index.ts` — public API exports.
- `packages/zero-trust/README.md` — spec of record for new APIs and binding updates.

## Approach
1. Validate immutable checkpoint records and canonical point-specific bindings; bind run identity, interrupted history, policy and budget session in the digest.
2. Persist checkpoint records in the existing guarded control journal before pausing. Retry reuses only the exact open record and phase; approved points never pause again.
3. Persist controller current bindings independently so candidate/policy/session changes invalidate approvals. Only persisted user config selects points.
4. Journal approval/rejection together with the exact lifecycle continuation, then publish the run snapshot using existing crash recovery semantics. Reject stale, closed and unrelated approvals with fixed non-echoing codes.
5. Render secret-free status with point-specific controller artifact paths and an exact approve-command placeholder; preserve contributor hand-offs.

## Reachability Evidence
N/A — this is local controller infrastructure, not a production-data condition.
User config already accepts the three points and the state machine already contains
phase-preserving pause/resume edges. Synthetic runs using the existing real RunStore
can reach planning, verifying and shipping. No production database query applies.

## Reusable Code
- `RunStore` lifetime guard, `persistRun`, journal replay and confirmed snapshot recovery.
- `transitionRun`, `restoreRun`, `sameRunRecord` for lifecycle and identity validation.
- `assertSecretFree` / `assertNoSecrets` and fixed non-echoing errors.
- `validateRunConfig` immutable persisted checkpoint selection (default empty).

## Risk Areas
- Crash ordering must distinguish pending snapshot publication from committed rollback (#1090 trap).
- Caller snapshots and current binding updates must be validated before mutations.
- Changed candidate content must invalidate old approvals rather than trusting caller digest alone.
- No imports through credential modules, including type imports; isolation scanner stays green.
- Warm pool may have stale dist; build before package/full gates.
- Ignored planning scaffold remains local; this tracked file is the durable plan (#1091 trap).

## Test Scope
All points, default fake lifecycle, exact/stale/mismatched/double approvals,
rejection reason, config spoofing, secret/malformed input, real reopen between
record and pause, snapshot publication interruptions and journal tampering.
Run strict package build, package coverage (90/90/90/85), credential isolation,
repository lint, build-all and full tests/CI checks. New files automatically enter
the existing zero-trust CI build and coverage glob.

## Open Questions
None.

## Visual Review
- [x] Not required (local controller APIs only).

## Base Branch
`main` (updated origin/main at 19382bc).
