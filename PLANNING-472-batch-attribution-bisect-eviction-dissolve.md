# Issue #472: feat(sched): batch failure attribution, bisect, eviction, and dissolve

## Problem

The scheduler needs the batch failure recovery core of RFC-0001 §F (F.2/F.8/F.9; authoritative text lives on branch `docs/batch-cycles-rfc`, file `rfcs/0001-batch-cycles.md` — not merged to main). When the aggregate suite or batch CI fails, the scheduler must attribute failures to members deterministically, attempt one bounded fix, evict surgically (reverting commit ranges, eviction groups together), requeue evicted members as full-cycle with their context, and dissolve the batch as a last resort — nothing green is thrown away. Today `packages/sched` has only the state-machine *rails* (`attributing/fixing/evicting/dissolving/rebasing` in types.ts/state.ts, the `evicted → requeued` issue rail, and operator-triggered `abandonBatch` in scheduler.ts:191); no code drives any of them. There is no attribution, no bisect, no revert, no requeue-with-evidence, no automatic dissolve triggers, and the batch-PR conflict path does not exist (the #468 PR watcher fails the issue unit instead).

**Why the plan:v1 artifact was rejected (fresh planning path):** `ai-dossier plan validate` reported error-severity reasons — predicted paths `packages/sched/src/attribution.ts` and `packages/sched/src/__tests__/attribution.test.ts` absent at HEAD (the artifact lists them as "(new)", which the validator cannot verify) — and 4 commits landed since the artifact's `head=83a1226`, including bdf6020 (PR #494, dependency #470) which heavily reworked `packages/sched` (teardown.ts added, engine grew ~600 lines). The artifact's Predicted Files (4 files) also materially understate the recovery core relative to the issue's own requirements and the classifier's grounded estimate (14 files).

## Acceptance Criteria

Verbatim from the issue:

- [ ] AC1 Attribution: failing tests mapped to members via changed-path + focused-test overlap; ambiguity resolved by `git bisect` over issue-boundary commits running only the failing tests (pure script, no LLM)
- [ ] AC2 One bounded fix attempt (mid-tier agent dispatch) per offending member; still red → evict: revert the member's commit range (eviction groups revert together), re-run the suite, requeue the member as full-cycle with its plan artifact + failure evidence attached
- [ ] AC3 Dissolve triggers: >1/3 of members evicted, or a revert conflict; dissolve = abandon branch, requeue all unshipped members (halved batches or full-cycle), report what was preserved
- [ ] AC4 Batch-PR conflict/`auto-merge-blocked` path: rebase batch branch, re-run suite, re-ship once; second occurrence → dissolve into two half-batches
- [ ] AC5 Every eviction/dissolve posts a batch milestone with reasons; per-member outcome recorded (classifier feedback signal)
- [ ] AC6 Unit/integration tests on synthetic repos: clean revert, eviction-group revert, bisect attribution, dissolve-on-conflict

## Approach

The recovery core is delivered as library modules in `packages/sched` — pure state functions plus injected-effect orchestration, exactly the package's established pattern (state.ts pure, teardown.ts script-based with `ExecFn`, engine.ts orchestration). The batch *execution* loop (driving `ready → executing → validating`) is a separate follow-up (#464 non-goal); #472 provides the machinery that loop will call, testable standalone.

1. **Schema 1.3.0 + types** (types.ts, state.ts, enqueue.ts): `BatchEntry` gains `anchor` (issue number — where batch milestones post), `branch`, `run_id`, `eviction_groups` (RFC §E.4 — members that revert together), `evictions` (eviction history, §D.4), `fix_attempts`, `rebase_attempts`; `QueueEntry` gains `failure_evidence` (requeue-with-context payload: batch, failing tests, attribution method, reverted commits). New journal events (`suite-failed`, `attributed`, `fix-dispatched`, `member-evicted`, `batch-rebased`, `batch-dissolved`). Migration 1.2.0 → 1.3.0 backfills nulls/empties per the state.ts:343 pattern; `enqueueEntries` accepts optional `anchor`/`run_id`/`eviction_groups` at batch creation (batch-prep knows them).
2. **`attribution.ts` (new)** — AC1 stage 1: pure overlap attribution. `attributeByOverlap(failingTests, memberFootprints)` maps each failing test to a member via (a) focused-test match (member's recorded focused tests), then (b) changed-path overlap (test file changed by, or under a directory changed by, the member); unique → attributed, multiple → ambiguous, none → unattributed. Plus parsers: `parseVitestJson(stdout)` → failing tests (file + id), `parseBoundaryCommits(gitLogOutput)` → ordered boundary commits with the `(#N)` trailer issue mapping (the established commit↔member key used by slot-cycle/review-issue examples).
3. **`bisect.ts` (new)** — AC1 stage 2: deterministic bisect runner. `runAttributionBisect` drives real `git bisect start <head> <base>` + `git bisect run <testCommand>` (the command runs ONLY the failing tests) in the batch checkout via injectable `ExecFn`; parses the first-bad commit; maps it to a member through the boundary list; returns `first-bad { issue }` / `green` / `unattributable` (first-bad is not a member boundary commit — e.g. a batch-level fix commit) / `error`. Always `git bisect reset` (finally). Shas validated hex-before-argv (CWE-88 pattern from groundtruth.ts:173).
4. **`recovery.ts` (new)** — AC2/AC3/AC4/AC5 orchestration, all effects injected (`ExecFn` git, `Journal`, `postBatchMilestone`, suite-runner), state transitions on the existing rails:
   - `beginFixAttempt`/`resolveFixAttempt`: batch `attributing → fixing`, record the one bounded attempt, return a dispatch instruction (mid-tier command+prompt — the caller spawns via SpawnDeps; sched never calls an LLM); red outcome → back to `validating` (suite re-run) → still red → `attributing → evicting` with the recorded attempt suppressing a second dispatch (fix attempts capped at 1 per member).
   - `evictMembers`: revert the member's commit range (`git revert --no-edit <range>`; eviction group members' ranges revert together); revert conflict → abort + dissolve path; entries `evicted → requeued{full}` with `failure_evidence` attached (plan artifact already lives on the issue as the `plan:v1` comment); journal + batch milestone; re-run the suite via the injected runner; check the >1/3 trigger.
   - `checkDissolveTrigger` (strictly more than one third evicted) and `dissolveBatch`: `dissolving → dissolved`, requeue every unshipped member — strategy `full` (abandonBatch semantics: nothing green discarded) or `halved` (`splitBatch`: two `forming` batches `<id>-a`/`<id>-b` with the unshipped members split in dispatch order, entries retagged, eviction groups inherited by membership); posts the dissolve milestone reporting what was preserved.
   - `handlePrConflict`: `awaiting-merge → rebasing → re-validating → shipping` on first CONFLICTING/auto-merge-blocked (rebase onto `origin/<base>`, re-run suite, re-ship once — `rebase_attempts` guard); second occurrence → dissolve into two half-batches.
   - Milestone posting (AC5) via `BatchMilestonePoster` — exec-based default shells `ai-dossier runstate post --issue <anchor> --phase batch-validate|batch-ship --status blocked|done --kv reason=… evicted=… dissolved=…`; per-member outcomes recorded in the journal (the classifier feedback signal) and in `evictions`.
5. **Wire-up**: index.ts exports; README documents the recovery core; package.json 0.3.0 → 0.4.0 (AGENTS.md version-bump policy).
6. **Tests** per the issue's test strategy: scripted scratch-repo fixtures with seeded failures, deterministic, no LLM (details in Test Scope).

## Reachability Evidence

- State: batch failure recovery paths | Trigger: red aggregate suite / conflicting batch PR during a batch cycle | Prod check: N/A | Verdict: N/A — not a data-reachable state

`packages/sched` is library code in a CLI tool (`@ai-dossier/sched`); this project has no production data store to query (the `mongodb-prod` MCP serves the imboard project, not this repo). The triggering conditions are documented, real failure modes (RFC-0001 §F — fleet-cycle's failure history motivated the RFC; F.2/F.9 name the exact triggers this code handles), and the states driven are the RFC §D.2 batch states already declared in types.ts:87. Reachability by production data is N/A for library/infra code; the demand-side evidence is the RFC's own failure analysis and epic #474's implementation plan (issue #472 = its step 13 "eviction/bisect machinery").

## Predicted Files

- `packages/sched/src/types.ts` — schema 1.3.0: BatchEntry recovery fields (anchor/branch/run_id/eviction_groups/evictions/fix_attempts/rebase_attempts), QueueEntry.failure_evidence, FailureEvidence/EvictionRecord/FixAttemptRecord types, new journal events, recovery constants
- `packages/sched/src/state.ts` — validateState for the new fields + 1.2.0 → 1.3.0 migration backfills
- `packages/sched/src/enqueue.ts` — optional anchor/run_id/eviction_groups accepted at batch creation
- `packages/sched/src/attribution.ts` — new: overlap attribution + vitest-JSON and boundary-commit parsers
- `packages/sched/src/bisect.ts` — new: deterministic git-bisect attribution runner
- `packages/sched/src/recovery.ts` — new: fix-attempt bookkeeping, eviction/revert, dissolve + split, PR-conflict rebase path, batch milestone poster
- `packages/sched/src/index.ts` — export the new surface
- `packages/sched/src/__tests__/attribution.test.ts` — new: pure attribution + parser tests
- `packages/sched/src/__tests__/bisect.test.ts` — new: real-git scratch-repo bisect integration tests
- `packages/sched/src/__tests__/recovery.test.ts` — new: scratch-repo revert/eviction/dissolve/conflict tests + pure state tests
- `packages/sched/src/__tests__/state-machine.test.ts` — extend: 1.2.0 → 1.3.0 migration tests
- `packages/sched/src/__tests__/enqueue.test.ts` — extend: batch creation with anchor/run_id/eviction_groups
- `packages/sched/README.md` — document the recovery core
- `packages/sched/package.json` — version bump 0.3.0 → 0.4.0 (AGENTS.md policy)

## Reusable Code

- `packages/sched/src/state.ts:transitionBatch/transitionIssue` — every batch/issue status change goes through the typed rails; recovery never hand-writes status
- `packages/sched/src/scheduler.ts:abandonBatch` (l.191) — dissolve strategy `full` reuses its nothing-green-discarded requeue semantics (refactor to share, don't duplicate)
- `packages/sched/src/project.ts:createExecFn/ExecFn` (l.24–46) — the injectable exec pattern for all new git work; `groundTruthExec` shows the timeout+stderr-observer shape
- `packages/sched/src/groundtruth.ts:167–178` — ref/sha validation before argv + `--` terminator (CWE-88) — replicate for revert/bisect/rebase args
- `packages/sched/src/dispatch.ts` — `resolveDispatch`/`buildAgentCommand`/`buildPrompt` (l.106–169) and the tier-model mapping: the mid-tier fix-attempt dispatch instruction builds on these; `DEFAULT_TIER_MODELS.mid` is the fix tier
- `packages/sched/src/journal.ts:unitEvent` — journal event shape; batch events carry `unit: batch:<id>`
- `packages/sched/src/__tests__/integration.test.ts:scratchRepo` (l.390) — the scratch-repo fixture pattern (bare origin + work clone, execFileSync git) for all new integration tests
- `packages/sched/src/__tests__/engine.test.ts:harness` (l.28–151) — fake store/journal/ground-truth harness conventions for the unit tests

## Risk Areas

- **Rails-only today**: nothing drives batches past `forming` (engine dispatches `['issue']` only, engine.ts:1017); recovery.ts is a library the future batch-execution loop calls — engine wiring is explicitly out of scope (matches #464's non-goal and the issue's `packages/sched/` scope)
- `git bisect run` output parsing must be defensive across git versions (regex the `<sha> is the first bad commit` line; treat unparsable output as `error`, never a guess) and MUST always `git bisect reset`, including on failure paths
- `git revert` conflicts leave the worktree mid-merge — `--abort` on any non-zero exit before taking the dissolve path (a dirty worktree poisons every later git operation)
- The `(#N)` trailer regex is the established commit↔member mapping (slot-cycle/review-issue examples) — reuse it verbatim; a member committing without the trailer parses as `issue: null` → unattributable → decision-pending, never a silent guess
- Suite re-runs and bisect test commands run OUTSIDE the state lock (engine discipline, engine.ts header) — recovery's orchestration shape must keep exec effects separable from the pure state transitions
- F.3 (CI failure on the batch PR → force-push rebuild) is adjacent but NOT in this issue's ACs — do not build it here
- `docs/agent-traps.md` does not exist in this repo (checked) — no trap hits to carry
- Schema migration must accept real 1.2.0 states written by the current CLI release (state-machine.test.ts migration tests cover the shape)

## Test Scope

- New `attribution.test.ts` (pure): unique focused-test match; changed-path match (file + directory prefix); ambiguous → multiple; unattributed; vitest JSON parsing (failed assertions only, file extraction); boundary-commit parsing incl. `(#N)` trailer, non-boundary commits, malformed lines
- New `bisect.test.ts` (real git, scratch repos): seeded member commits where exactly one breaks a test → first-bad maps to that member; green-at-head → `green`; failure introduced by a non-boundary commit → `unattributable`; bisect always resets (worktree clean after)
- New `recovery.test.ts` (scratch repos + fake deps): clean revert of one member's range; eviction-group revert reverts the group together; requeue carries failure_evidence (evicted → requeued{full}); one fix attempt only (second red resolution evicts without re-dispatch); suite re-run invoked after eviction/rebase; >1/3 evicted → dissolve; revert conflict → dissolve; dissolve preserves shipped/validated members (nothing green discarded); halved split creates two forming batches with retagged entries; PR-conflict first occurrence rebases and re-ships, second dissolves into halves; milestone poster called with reasons on every eviction/dissolve; journal events recorded
- Extend `state-machine.test.ts`: 1.2.0 state (with pr/cleanup/last_pr_poll_at) migrates to 1.3.0 with backfilled recovery fields; validateState rejects bad shapes (negative anchor, non-array eviction_groups…)
- Extend `enqueue.test.ts`: batch created with anchor/run_id/eviction_groups; conflicting re-supply rejected
- Existing suites must stay green: `cd packages/sched && npm test`, then `make test` (all workspaces + scripts)

## Open Questions

(none — engine wiring of the recovery core is a documented design decision, not an ambiguity: the execution loop is a separate issue, and the recovery library is fully testable standalone)

## Visual Review

- [x] Not required (backend/library only)

## Base Branch

`main` — PRs for this issue target this branch.
