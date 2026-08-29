# Issue #468: feat(sched): PR watching and script-based tail work (teardown + report dispatch)

## Problem

With the #464 dispatch engine merged (PR #483), the scheduler can spawn full-cycle agents, verify completion, and run the stall/escalation ladder — but a detached-ship run that parks a PR on `auto-merge` still has no owner for what happens next. Today the fleet pattern re-dispatches a whole full-cycle run just to execute teardown + report (the tail run), burning a full agent for mechanical work. RFC-0001 §C.1 assigns this to `dossier-sched` itself: deterministic PR watching plus script-based tail work. Nothing watches parked PRs, teardown/report never run as scripts, and PR failure states (conflict, closed-unmerged, auto-merge-blocked) don't fail units or block dependents.

## Acceptance Criteria

- [ ] AC1 Parked PRs polled every 2–3 min (`gh pr view --json state,mergedAt,mergeable`); merged is only accepted when `mergedAt` non-null AND state MERGED (and for issue units, the issue closed) — never inferred from agent exit
- [ ] AC2 On merge: teardown runs as a script (pool return or worktree remove, verified before claimed — `cleanup=failed-<step>` on mismatch), then a cheap-tier report agent is dispatched; the full-cycle tail-run pattern is not used
- [ ] AC3 `CONFLICTING` / closed-unmerged / `auto-merge-blocked` → unit failed with reason, transitive dependents blocked; no self-merging around the watcher
- [ ] AC4 Batch/wave gating on MERGE, not on park (a parked PR never unblocks dependents)
- [ ] AC5 Waiting units consume zero slots; live agents only count against `max_slots`
- [ ] AC6 e2e test with stubbed gh covering merged / conflicted / blocked paths and a sched restart mid-watch

## Approach

1. **New issue status `parked`** (D.1 extension): when a dispatched unit's agent exits and the latest milestone is `ship/awaiting-merge` with a `pr=` key, the exit is *verified as a park* (not an unverified exit): entry `dispatched → parked` (recording `pr`), slot walks `complete → idle` — the agent's contract was to park, and a parked unit holds no slot (AC5).
2. **PR watcher in the engine tick**: parked entries' PRs are polled via a new `GroundTruth.prState(pr)` (`gh pr view --json state,mergedAt,mergeable,labels`) on a dedicated cadence (`pr_poll_interval_ms`, default 150 s, persisted `last_pr_poll_at` in state.json — survives restarts). Polls run outside the state lock, tri-state unreachable like every other ground-truth signal (decision 2, option A).
3. **Merge acceptance (AC1)**: `state MERGED && mergedAt != null && issueClosed(issue)` → entry `parked → shipped` (dependents unblock at MERGE — AC4; `parked` is not in `SATISFIED_ISSUE_STATUSES`). `CONFLICTING` / `CLOSED`+unmerged / `auto-merge-blocked` label → `failUnit` with reason + transitive dependents blocked (AC3, reusing the #464 rail).
4. **Script-based teardown (AC2)**: after merge acceptance the engine fetches the run's setup info once (`GroundTruth.setupInfo(issue)` — parses `worktree=`/`pool_claimed=` from the issue's `setup` milestone comment via `gh issue view --json comments`; no polling-window dependency), then runs teardown outside the lock: `worktree-pool return --path <wt> --json` (pool-claimed; verified via the pool's own self-check + `--json` inventory) or `git worktree remove --force <wt>` + path-gone verification (idempotent on retry). Result recorded as `cleanup=done|failed-<step>` on the entry + journal; the report is dispatched regardless (cleanup failure is degradation, not unit failure — work is merged).
5. **Report dispatch (AC2)**: `shipped` + `pr` + `cleanup` set + no live slot + free capacity → a slot is assigned (phase `report`) and a **mechanical-tier** agent is spawned with a report-phase prompt (`dispatch.report_prompt`, placeholders `{issue}`/`{pr}`/`{cleanup}`). It completes like any agent: milestone `report done` → `shipped → done`. A report agent that stalls/dies rides the same ladder (mechanical → mid → strong, cap 2); at the cap the unit fails **without blocking dependents** (the PR is already merged — gating already released).
6. **Detached dispatch default**: the engine's default prompt switches to detached ship mode (park the PR on auto-merge and stop) so sched-dispatched runs engage the watcher by default; operator prompt overrides still work, and attached runs complete through the existing report-done path unchanged.
7. **CLI + status**: `sched start` wires the teardown exec (repo dir + 120 s timeout); `sched status`'s queue table gains a `pr` column; tick descriptions report parked/merge-accepted/report-dispatched events.

## Reachability Evidence

- N/A — pure infrastructure (scheduler package, pre-pilot). The trigger is the batch-cycles flow itself: #464's dispatch engine is merged (PR #483, 2026-08-29) and the batch pilot (#473) is the first consumer. No production datastore holds scheduler states; `state.json` is machine-local hot truth by design (RFC-0001 §D.4). A prod query has nothing to count.

## Files to Modify

- `packages/sched/src/types.ts` — `parked` status; `QueueEntry.pr/cleanup`; `SchedState.last_pr_poll_at`; `pr_poll_interval_ms` + `dispatch.report_prompt` config; new journal events; `DEFAULT_PR_POLL_INTERVAL_MS`; schema 1.2.0 (+config 1.2.0)
- `packages/sched/src/state.ts` — transition tables (`dispatched → parked`, `parked → shipped`), validation of new fields, 1.1.0 → 1.2.0 migration (backfill nulls)
- `packages/sched/src/groundtruth.ts` — `PrTruth`, `prState()`, `parsePrViewJson()`, `SetupInfo`, `setupInfo()`, `parseSetupInfo()`, `isParkedMilestone()`
- `packages/sched/src/teardown.ts` — NEW: `runTeardown()` (pool return / worktree remove, verified, idempotent worktree-remove)
- `packages/sched/src/dispatch.ts` — detached default prompt, `DEFAULT_REPORT_PROMPT_TEMPLATE`, `buildReportPrompt()`, `reportTierFor()`, `resolveDispatch` extensions
- `packages/sched/src/engine.ts` — `pollParkedPrs()`, `reconcileParked()`, `parkUnit()`, report-agent dispatch + ladder branch, teardown phase (outside lock, two-phase tick), report-phase completion rule (milestone-only — the issue is already closed at merge), `TickResult` extensions
- `packages/sched/src/index.ts` — exports
- `packages/sched/README.md` — watcher/teardown/report sections, config, prompt change
- `packages/sched/package.json` — 0.2.1 → 0.3.0
- `cli/src/commands/sched.ts` — teardown deps wiring, `pr` column, tick description
- `cli/package.json` — 0.18.0 → 0.19.0
- Tests: `state-machine.test.ts`, `groundtruth.test.ts`, `teardown.test.ts` (new), `engine.test.ts` (watcher/teardown/report suites), `integration.test.ts` (stubbed-gh e2e + restart mid-watch), `fixtures/fake-agent.mjs` (park + report modes)

## Reusable Code

- `engine.ts:failUnit` / `blockTransitiveDependents` — AC3 failure rail (parameterized for merged-aware report failures)
- `engine.ts:walkSlotToIdle` / `completeUnit` — slot release + `shipped → done` walk (report completion reuses it verbatim)
- `groundtruth.ts:createExecFn` exec-injection pattern — teardown + PR polling follow it (tests stub everything)
- `worktree-pool` CLI `return --path --json` + `status --json` — pool-side self-check is the verification for pool teardown (#453 built it for exactly this)
- `integration.test.ts` stubbed-gh + scratch-repo pattern — extended for the AC6 e2e
- `restart.test.ts` continuous-vs-restarting harness pattern — restart-mid-watch coverage

## Risk Areas

- **Merge-acceptance is deliberately conservative**: PR merged but issue not yet closed (GitHub propagation lag, or a missing `Closes #N`) keeps the unit parked until closed. If the PR body lacks `Closes #N` the watcher waits forever — operator escape is `sched abandon` (acceptable: AC1 is explicit).
- **Two-phase tick window**: teardown runs between two `withLock` passes; a crash there leaves `cleanup=null` → the next tick re-runs teardown (worktree-remove is verify-first idempotent; pool return in that window can mis-report `failed-pool-return` — documented, cosmetic, inspectable via `worktree-pool status`).
- **Report agent vs. closed-issue completion**: the issue closes at merge, so report-phase units must verify completion by the `report done` milestone ONLY — never by `issueClosed` (else every report agent is killed as "externally complete" at spawn).
- **Prompt default changes to detached**: sched-dispatched full-cycle runs now park by default; attached behavior remains available via `dispatch.prompt` override and still completes through the existing rails.
- **`git worktree remove --force`**: safe because the WIP-sync rule pushes everything durable; untracked junk (logs, status files) is discarded by design.
- **Schema migration**: 1.1.0 state files must load and backfill (`pr`, `cleanup`, `last_pr_poll_at` → null) — same migration pattern as 1.0.0 → 1.1.0.

## Test Strategy

- **State machine**: new transitions (incl. `parked` not satisfied — AC4), validation of new fields, 1.1.0 → 1.2.0 migration.
- **Ground truth**: `parsePrViewJson` (merged/conflicting/blocked/unreachable), `parseSetupInfo`, `isParkedMilestone` (requires `pr` key).
- **Teardown** (fake exec): pool return ok/fail, worktree remove ok/fail, verify-first idempotency, missing setup info.
- **Engine** (existing harness + fake `prState`/`setupInfo`/teardown exec): park-on-exit; zero slots while parked (AC5); gating on merge not park (AC4); merged acceptance incl. closed-issue requirement (AC1); conflicted/closed-unmerged/blocked → failed + transitive dependents (AC3); teardown failure → `cleanup=failed-<step>` + report still dispatched; report ladder cap → failed without dependent blocking; PR poll cadence via `last_pr_poll_at`; restart mid-watch (fresh store/deps, same dir).
- **Integration (AC6)**: real spawned fake agents (park mode + report mode), stubbed `gh` executable on PATH (per-PR `pr view` JSON, issue states, setup-milestone comments), scratch git repo with a REAL worktree → REAL `git worktree remove` teardown verified gone; merged / conflicted paths end-to-end; restart mid-watch re-enters from state.json.
- **Repo gates**: `make build` (biome + tsc), `make test` (all workspaces), version bumps (sched 0.3.0, cli 0.19.0).

## Open Questions

(none)

## Visual Review

- [x] Not required (backend/infra only)

## Base Branch

`main` — PRs for this issue target this branch.
