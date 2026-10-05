# Issue #1005: Fail-closed journal and write reconciliation

## Problem
The new controller needs durable evidence before provider mutations and must recover lost responses without duplicate writes. This slice uses injected adapters only; no GitHub credentials or live mutations. No prior plan artifact exists.

## Acceptance Criteria
- [ ] **Fail closed:** unlike `packages/sched/src/journal.ts` (which swallows write errors), a failed journal write here MUST throw and block the operation. Files created `0o700`/`0o600`; fsync before returning.
- [ ] Idempotency key = `(contributionId, target, operationKind, candidateSha)`; `operationKind ∈ {engagement_comment, fork_ensure, push_branch, pr_create, pr_update, pr_close}`.
- [ ] Intent lifecycle: `intended → attempted → confirmed | ambiguous`. Intent is persisted **before** the mutation callback runs.
- [ ] On resume, any `attempted`/`ambiguous` intent calls an injected `reconcile(intent)` (search existing artifacts) **before** any new mutation is admitted. Results: `found(artifactRef)` → confirmed, no rewrite; `absent` → may retry once; `unknown` → transition run to `blocked` (hand off), never repeat the write.
- [ ] Push reconciliation is by remote SHA: expected SHA present → confirmed; unexpected SHA → `blocked` (no force).
- [ ] Engagement comments carry a hidden marker `<!-- ai-dossier:ztfc contribution=<id> op=engagement -->`; helper to build/parse it.
- [ ] Journal replay rebuilds state equal to the persisted state (property-style test over a random op sequence).

## Predicted Files
- `packages/zero-trust/src/journal.ts` — strict durable JSONL storage.
- `packages/zero-trust/src/intents.ts` — validated events, replay, serialized driver and reconciliation.
- `packages/zero-trust/src/__tests__/intents.test.ts` — adapter, persistence and adversarial tests.
- `packages/zero-trust/src/index.ts` — public exports.
- `packages/zero-trust/README.md` — controller ownership and adapter contracts.

## Approach
1. Persist validated, versioned events with exclusive file creation, restrictive permissions, no symlink following, complete writes and file/directory fsync. Reject corrupt/torn records rather than skip them. Poison the writer after uncertain persistence.
2. Replay events through a deterministic validator: immutable tuple keys, legal lifecycle edges, durable attempt count capped at two, durable blocked run state.
3. Serialize operations on one controller-owned driver. Reconcile all pending operations before new admissions; an absent observation grants only one durable retry, found confirms, unknown blocks permanently.
4. Require SHA evidence for pushes and validate artifact references and engagement markers. Never persist adapter exceptions or credentials.
5. Integrate the existing pure RunRecord lifecycle; persist initial and blocked run records in the same journal.

## Reachability Evidence
N/A — explicitly requested greenfield controller mechanism against injected interfaces. Triggers are deterministic adapter outcomes and process interruption, demonstrated with fixtures; no production data condition or real GitHub call is required.

## Reusable Code
- `state.ts`: restoreRun/transitionRun and PolicyBlocked.
- `redaction.ts`: assertNoSecrets for persisted strings.
- Scheduler JSONL layout is a reference only; swallowing failures and skipping bad records are forbidden here.

## Risk Areas
Lost acknowledgments, persistence failure after remote success, crash during append, retry budget resetting on restart, caller mutation during async operations, concurrent admissions, symlink/path substitution, corrupt replay, secret-bearing adapter errors. Journal directory is trusted controller-owned storage; one controller owns it, never workers. Private package needs no npm release bump. Existing local hostname traps and Vercel preview quota traps are documented in agent-traps.md; native Node 20/22 CI is authoritative for the full repository suite.

## Test Scope
Meaningful fake-adapter tests for lost PR/comment/push responses, retry cap across restart, global reconciliation barrier, blocked run replay, concurrent same-key calls, malformed events and truncated JSONL, permissions, fsync/write failures before callbacks, process death after durable attempted event and remote effect, seeded random event sequences. Run package coverage/build, repository lint/build and full suite with known host normalization disclosed if necessary; require native PR CI.

## Open Questions
None.

## Visual Review
- [x] Not required (backend only)

## Base Branch
`main` — initial base afe81af6eca7a1071c6afd4bf0749535e4ef68a3.
