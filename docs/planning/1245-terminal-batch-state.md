# Issue #1245: terminal batch state corruption

## Problem

The previous trusted light plan at head `47018d2` passes deterministic validation,
but fails the fresh sanity check: `requeueMember` does not remove batch membership,
and an abandon-only change misses the reproduced producer. Consequently
`plan_reused=false`. This plan supersedes the earlier artifact append-only, retaining
its three acceptance criteria, cleanup-evidence requirement and terminal-only
resilience scope. The user's restart authorizes the factual trigger correction.

On baseline `bdf2c58`, the real sequence is **abandonBatch → abandonIssue on the
requeued issues → enqueueEntries**. `scheduler.ts:433-473` dissolves the batch,
releases slots and requeues its entries while retaining members/member_runs.
`enqueue.ts:611-630` later removes historical membership but retains the runs.
`state.ts:834-871` then rejects those runs because each issue must be a member;
`persist.ts:399-425` refuses the whole state. The supervised engine cannot reach
its terminal cleanup safety net because loading fails first.

AC1 already passes on this base and needs a durable regression. The remaining
work prevents the actual producer, preserves unfinished cleanup evidence, safely
quarantines malformed terminal records and replaces whole-queue-reset advice.
The original incident's complete deployed history was not inspected; the local
sequence is a demonstrated current-code trigger, not a claim about unseen history.

## Acceptance Criteria

- [ ] `abandon --batch` on a batch with running member runs leaves a state file that loads (test)
- [ ] A malformed terminal batch record does not take the engine down (test)
- [ ] The corrupt-state error points at the offending record and the minimal repair

### Conformance interpretation

- AC1: retain abandon-only coverage AND add the demonstrated abandon/abandon/re-enqueue
  save/load regression. Both old run records, pending/failed cleanup and OpenAI
  dispatch provenance must survive. A green abandon-only test does not fix #1245.
- AC2: quarantine malformed positively identified terminal history, preserve its
  exact evidence and keep unrelated valid work runnable; never execute malformed
  run paths/PIDs. An active batch, active entry/slot coupled to the damaged record,
  ambiguous identity, or independently corrupt global state must still fail closed.
- AC3: name state file, record index/identity, failing field/run index and the
  record-local repair/evidence location. No default suggestion to delete the queue.

## Approach

1. **Fix enqueue without erasing cleanup history.** For a terminal batch, preserve
   historical membership for issues with retained member_runs when the fresh entry
   moves elsewhere. Keep those run objects and teardown flags unchanged. Continue
   #502's membership removal for unrelated members with no run evidence. Enqueue
   remains a pure function: no worktree deletion, process signalling or fabricated
   `torn_down`. For a nonterminal batch, do not silently detach a retained run:
   refuse that move with a record-local explanation until its batch is terminal,
   rather than writing an invalid association or losing the obligation. Preserve
   existing re-enqueue paths without retained runs.
2. **Make current dependency ownership explicit.** `readiness.ts:35-37` currently
   finds the first batch containing an issue. Resolve via the current queue entry's
   `batch` instead; `batch=null` means standalone even when terminal history names
   the issue. Cover an old dissolved batch followed by a fresh batch, and the
   standalone dependency case. Audit membership-based consumers: stop/abandon
   refuse terminal batches already; terminal teardown is keyed by batch/run and
   must not mutate a fresh entry or its new slot. Keep the current association
   guard `memberStillInBatch` and batch-member slot identity semantics.
3. **Separate strict validation from recoverable terminal isolation.** Extract the
   existing batch-record validation into a reusable pure internal helper with
   structured record/field context (including null-safe malformed run handling).
   `validateState` stays strict for callers/tests; do not globally relax the
   member/run invariant. Persistence may isolate a bad batch only after schema,
   top-level arrays, queue entries, unique identities and slots are validated.
   Only exact `done`, `dissolved`, `stopped` statuses qualify (the existing
   TERMINAL_BATCH_STATUSES vocabulary); blocked, dissolving and unknown states do
   not. Duplicate/missing IDs, invalid global state, active references or held
   batch/member slots refuse recovery. Validate the entire proposed safe state
   before committing quarantine so a terminal exception cannot hide another error.
4. **Use a locked evidence-first quarantine transaction.** `load()` currently reads
   without locking and `withLock()` calls it while locked. Introduce a private
   lock-held loader; public load acquires the same state mutex, and withLock calls
   the private loader directly (no recursive lock). Under that lock, preserve the
   original raw snapshot in a deterministic content-digest-named sidecar under a
   fixed store-owned quarantine directory; include a manifest of batch indexes,
   IDs and validation reasons. Use generated digest filenames, never a raw batch
   ID/path as a filesystem component. Publish/fsync evidence before atomic state
   replacement. Reuse the existing writer conventions, with mandatory evidence
   durability before replacing the only original. Evidence write/verification
   failure must leave state.json unchanged and throw an actionable error.
5. **Keep terminal references inert and evidence visible.** Replace each quarantined
   batch's executable payload with a minimal, valid terminal placeholder at the
   same unique ID/status, constructed from safe defaults and validated terminal
   entry references. No copied worktree/branch/anchor/PR, member runs, ranges,
   PID or cleanup targets. Record a generated quarantine marker/evidence locator
   in existing diagnostic metadata (`blocked_reason`) so reopening can warn and
   name the preserved original; no new batch status or schema version required.
   This avoids retagging terminal queue entries into fresh full-cycle work and
   preserves referential validity. Do not replace any batch referenced by an
   active/parked entry or nonidle batch/member slot. Never mark original runs as
   successfully torn down: their exact pending obligations remain quarantined for
   record-local operator reconciliation. Reopen must reuse evidence, not multiply
   backups, erase it, or attempt cleanup from it. Recovery warns with the batch
   index/ID, reason and evidence path; repeated same-process reads may deduplicate
   that warning, but a fresh process must see it.
6. **Improve diagnostics and verify the real boundary.** CorruptStateError should
   retain the offending location and suggest preserving evidence and repairing
   only that record; distinguish JSON/schema/I/O failure guidance. Keep newer
   schemas as EngineTooOldError. Add durable producer, quarantine, restart,
   failure-injection and engine-continuity tests; bump the scheduler patch version
   with synchronized lock metadata and run the release gate against current main.

The placeholder is an inert index/reference record, not a repaired executable
batch. The raw record and its cleanup obligations live in quarantine. Implementation
may simplify helper layout while retaining this safety contract; a design change
that weakens it requires updating this plan and its tests before proceeding.

## Reachability Evidence

- State: corrupt historical terminal batch. Trigger: two valid running parallel
  runs → abandonBatch → abandonIssue for requeued entries → enqueueEntries for
  those issues. Traced in scheduler.ts, enqueue.ts and state.ts and reproduced
  with the real built package. Prod check: skipped (`prod_data_access=none`).
  Verdict: **N/A — no production access by policy**, local trigger confirmed.
- Flow: terminal quarantine at SchedStore.load. Trigger: persisted supported-schema
  snapshot with exact terminal status and malformed member_runs; original issue
  and fixture show this can occur. Active-state refusal uses the same malformed
  record with executing/blocked status or active references as a negative control.
  Prod check: skipped (`prod_data_access=none`); same policy verdict.

### Bounded local probe, 2026-10-16

Command: `node /tmp/opencode/probe-1245-409c.cjs`, after `make build-all` on baseline
`bdf2c58`. Two assertion scenarios passed:

```text
PASS AC1 baseline: abandonBatch -> save/load retains 2 members and 2 running runs; OpenAI retained
PASS reproduced defect: abandonBatch -> abandonIssue x2 -> enqueueEntries -> save/load throws malformed member_runs; members=[]; 2 original runs retained
```

Fixture recipe: createEmptyState; enqueue slot members 674/946 in b-probe with
dispatch=openai; transition batch ready→executing; patch two well-formed running
MemberRun records (absolute fixture worktrees, safe refs, pool_claimed=true,
torn_down=false, teardown_failed_at=null); validate initial state. Call
abandonBatch, save/load and assert members/runs/profile retained. Call abandonIssue
for 674/946, enqueue both as full-mode/openai, assert empty old membership and
unchanged runs, save and assert load throws malformed member_runs. The probe used
mkdtemp state and removed only its allocated directory in finally; no production
state, live agents or repository source were mutated. The throwaway script was
removed after recording this evidence; the implementation should add permanent
source-level regressions from this recipe.

## Predicted Files

- `packages/sched/src/enqueue.ts` — retain terminal run-associated history and refuse unsafe active-run detachment.
- `packages/sched/src/readiness.ts` — use authoritative current queue ownership for dependency batches.
- `packages/sched/src/state.ts` — reusable strict batch validation and precise error location; maintain invariant.
- `packages/sched/src/persist.ts` — locked evidence-first quarantine, inert terminal references, warnings and minimal repair errors.
- `packages/sched/src/__tests__/enqueue.test.ts` — reproduced producer, no-run #502 controls and active-run refusal.
- `packages/sched/src/__tests__/scheduler.test.ts` — abandon save/load and historical/current dependency ownership.
- `packages/sched/src/__tests__/state-machine.test.ts` — strict validation, record/field diagnostics and active corruption controls.
- `packages/sched/src/__tests__/persist.test.ts` — physical quarantine bytes, atomicity, concurrent/repeated load and refusal boundaries.
- `packages/sched/src/__tests__/batch-integration.test.ts` — unrelated queue continuity and zero malformed cleanup effects.
- `packages/sched/package.json` — patch release above current 0.70.0, rechecked against origin/main at ship.
- `package-lock.json` — only corresponding workspace version metadata.

11 predicted implementation/release files, plus this durable planning file.
Read-only integration surfaces: cli/src/commands/sched.ts, scheduler.ts,
batch-dispatch.ts, recovery.ts, types.ts and status.ts. If their contracts require
an edit, update the prediction with evidence rather than silently growing scope.
Review remains full (broad persistence/cleanup scope, >8 files).

## Reusable Code

- `state.ts:validateState`, batch-record checks, validateQueueEntry and migration
  defaults — strict shape/invariant authority; reuse rather than parallel validators.
- `state.ts:createBatch` — safe inert field defaults; do not carry unsafe input into
  the quarantine placeholder. Preserve original bytes separately.
- `persist.ts:writeAtomic`, acquireLock/releaseLock, SchedStore.withLock — existing
  serialized atomic publication; note writeAtomic's directory fsync is currently
  best-effort, so evidence durability cannot be assumed from it alone.
- `scheduler.ts:abandonBatch`, abandonIssue and state.ts:requeueMember — actual
  producer chain and OpenAI profile carry; abandon need not be rewritten.
- `batch-dispatch.ts:teardownParallelRuns`, recordRunTeardown, memberStillInBatch,
  batch-member slot identity — cleanup succeeds only on verified teardown; failed
  teardown evidence remains pending, never cleared merely to satisfy validation.
- `__tests__/helpers/member-run.ts:memberRun` and existing filesystem/integration
  harnesses — realistic inert fixture defaults and independent effect recording.

## Risk Areas

- Read AGENTS.md and docs/agent-traps.md in full, including current-base additions;
  grepped abandon/enqueue/member_runs/terminal/persist/quarantine/#502/#855.
  #502 requires current ownership to win over old membership; #855 says tick's
  safety net can mask a helper's behavior. Assert the actual path/effects, and
  isolate a helper test if changing one.
- Terminal does not mean cleaned up. Retained run history must continue through
  normal cleanup (including failures/kept trees); quarantined malformed targets
  are evidence only. No unvalidated worktree/PID may cause destructive effects.
- Avoid recursive state locking and unguarded read→rewrite races. Test a public
  load and a load inside withLock, process interruption between evidence and state
  publication, plus two competing readers. No success if evidence is unavailable.
- Strict validation must not be weakened for active batches, parked entries,
  unknown/newer schemas, duplicate identities, invalid JSON or unrelated corruption.
  A recoverable terminal record plus a corrupt active record must still refuse.
- Placeholder terminal status must not satisfy a new attempt's dependency: current
  queue ownership controls readiness, and quarantine must not manufacture a PR,
  anchor close, completed cleanup or shipped outcome.
- #1244 shares batch cleanup tests/context but is not a dependency; coordinate if
  it lands while this run is implementing. #1243 has now landed and current main
  includes its CLI fixes. #1250 is the prior batch anchor, not an active claim for
  this run. Prior member had no retained implementation changes.
- Setup pool claim failed on missing Git admin directory; cold fallback used.
  No pool maintenance/prune performed. Original main had unrelated untracked
  ship-issue.ds.md, which is user work. npm install on the new worktree introduced
  no lock drift. Preserve these facts rather than staging unrelated/generated work.
- Publishable source needs a scheduler version bump; inspect latest main before
  choosing version. Patch within 0.70.x does not require changing consumer minor
  ranges. Use the absolute authorized CLI for workflow posts (stale-shadow trap).

## Test Scope

**broad** — permanent regressions and scheduler suite, followed by required root
checks during implementation. Planning itself only establishes bounded baselines.

| Scenario | Required observation |
|---|---|
| AC1 abandon only | Real save/reopen succeeds with running parallel runs and released slots; membership/profile retained. |
| Corrected producer | Abandon → abandon issues → re-enqueue → physical save/reopen succeeds; runs/cleanup evidence retained exactly; input object unmodified. |
| Re-enqueue destinations | Standalone and new batch work use current ownership; old terminal history cannot gate dependencies or retarget new work. |
| #502 controls | No-run old membership is removed; one queue entry per issue; unsafe active-run detachment refuses without mutation. |
| Terminal quarantine | done/dissolved/stopped malformed run and other batch-field cases survive load; exact original bytes plus location/reason retained before state changes. |
| Terminal references | Valid terminal queue references remain valid via inert placeholder; active/parked references and held batch/member slots refuse, with original bytes unchanged. |
| Strict controls | Same malformed active record, invalid JSON, duplicates, unsupported/newer schema, invalid slot/entry and mixed terminal+active corruption fail closed; EngineTooOldError retained. |
| Crash/I/O boundaries | Evidence write/fsync and state publication faults; reopen after each prefix; two processes loading concurrently; no lock recursion, lost healthy update or duplicate evidence. |
| Engine continuity | Real store plus existing tick harness advances healthy unrelated work; recorded spawn/exec/kill/pool calls never use quarantined paths/PIDs. |
| Cleanup lifecycle | Valid historical pending run still reaches normal verified cleanup; kept/failed teardown remains visible, no false torn_down; no fresh entry/slot altered. |
| Diagnostics | State file, batch index/id, run index/failing field, evidence path/minimal repair; no whole-queue reset advice; fresh reopen warns. |

Observed planning checks on unmodified baseline:

- `npm install` and `make build-all`: passed; no package-lock diff.
- Bounded external probe: both assertion scenarios passed, with the second
  explicitly expecting the currently broken load.
- `npx vitest run src/__tests__/scheduler.test.ts src/__tests__/enqueue.test.ts src/__tests__/persist.test.ts src/__tests__/readiness.test.ts src/__tests__/state-machine.test.ts`
  from packages/sched: **4 files, 237 tests passed**. readiness.test.ts does not
  exist; dependency coverage resides in scheduler.test.ts. No fifth suite claimed.

Implementation verification: focused changed suites (existing actual filenames),
scheduler workspace suite/build, `make build-all`, `make lint`, required aggregate
`make test`/configured gate, and `scripts/check-version-bumps.mjs` against current
origin/main. Use a timeout covering the full aggregate gate (documented roughly
21-minute host runtime). Full aggregate tests, new quarantine regressions and
failure injection have not been run at planning time.

## Open Questions

None unresolved. The prior observable trigger mismatch is resolved by current-code
tracing and the bounded fixture; it is not a new handoff. Quarantine mechanism and
current-ownership handling above are technical decisions within the authorized
scope. Any implementation-discovered mechanical adjustment should be recorded.

## Visual Review

- [x] Not required (scheduler persistence/backend only).

## Base Branch

`main` — branch cut from fetched origin/main `bdf2c58` (full SHA recorded by git).

## Run Context

- Run: r-1245-409c; fresh full-mode entry, prior slot run r-1245-7687 in
  terminal batch b-20261016-01. Do not resume the member-cycle procedure.
- Branch: bug/1245-sched-terminal-batch-state-corruption.
- Worktree: worktrees/bug-1245-sched-terminal-batch-state-corruption under main.
- pool_claimed=false; pool_note=claim-missing-git-admin; cold warmup COMPLETED.
- Profile openai; model openai/gpt-6.1-sol; prod_data_access=none;
  ship_mode=attached; warmup_dossier=imboard-ai/git/warm-worktree.
- This delegated phase ends at PLAN done; parent dispatches implementation using
  this same run, branch, pushed plan and setup context.
