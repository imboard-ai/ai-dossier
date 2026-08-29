# Issue #464: feat(sched): dispatch, completion verification, and stall/escalation ladder

## Problem
RFC-0001 §C.1/D.3 (`rfcs/0001-batch-cycles.md`, lives on branch `docs/batch-cycles-rfc`). The sched core (#460, merged as PR #479) provides the queue, slots, typed state machines, and crash-safe persistence — but nothing executes: assignments computed by `computeAssignments` are never spawned, so a runnable unit never becomes a running agent. This issue adds the three missing mechanical organs that replace fleet-cycle's LLM supervision: the **dispatcher** (spawn agent processes with `--model` per tier), **completion verification** (an agent exiting is never proof of completion — reconcile against `runstate`/GitHub ground truth), and the **stall/escalation ladder** (no progress for 30 min → redispatch one tier stronger, cap 2, then failed + dependents blocked).

Non-goals (explicit, from the issue): PR watching and tail work (follow-up); batch member sequencing; classification (#465).

## Acceptance Criteria
- [ ] AC1 A runnable queue unit is dispatched as a spawned agent process (full-cycle run for mode=full) with `--model` per its tier; pid + phase + last-progress timestamp tracked in state.json
- [ ] AC2 On child exit, the unit is NOT marked complete until reconciliation verifies the claimed state against ground truth (`ai-dossier runstate last` / `gh pr view` as applicable) — an agent exiting is never proof of completion
- [ ] AC3 Reconciliation tick (~60s) also detects externally-advanced state and orphaned pids after a sched restart
- [ ] AC4 Stall detection: no new milestone AND no new pushed commit for 30 min → redispatch the same unit one tier stronger (resume rails carry work forward); cap 2 escalations, then unit=failed and transitive dependents=blocked
- [ ] AC5 Slot refill is immediate and automatic when a unit reaches a terminal state — at no point does a runnable unit wait while a slot is idle (regression test)
- [ ] AC6 All events journaled; `sched status` shows live phase per unit

## Approach
1. **New `packages/sched/src/dispatch.ts`** — dispatch machinery: tier→model resolution (configurable `tier_models`, defaults haiku/sonnet/opus), a command template with `{model}`/`{issue}` placeholders (default `claude -p --output-format json --model {model}` for headless full-cycle runs; CLI layer resolves `auto`→claude/opencode via the existing `detectLlm` machinery), a prompt template, and a `SpawnFn` (injectable; the real one spawns detached `child_process.spawn` processes whose stdout/stderr append to `<sched-dir>/runs/<unit>.log`, unref'd so agents survive a sched crash — RFC F.10).
2. **New `packages/sched/src/groundtruth.ts`** — the `GroundTruth` interface (`latestMilestone(issue)`, `issueClosed(issue)`, `branchHead(branch)`) with a default implementation built on injectable `ExecFn` subprocess calls (`ai-dossier runstate last --issue N --json`, `gh issue view`, `git ls-remote`), following project.ts's injectable-exec pattern. The package stays dependency-free and no LLM is ever invoked by sched itself.
3. **New `packages/sched/src/engine.ts`** — `tick()`: one reconcile+refill cycle, all I/O injected. Per slot: pid aliveness (orphan detection after restart) → exited→verifying; ground-truth poll → phase/progress update, external-advance completion (milestone `report done` or issue closed), verify-uncomplete → recovery rail; stall check (no new milestone `at=` AND no new branch head for 30 min) → recovery rail; then `computeAssignments` refill + spawn (slot idle→assigned→running, issue queued→classified→dispatched, pid recorded). Failure rail: recoveries ≥ 2 → entry `failed`, slot failed→idle, **transitive dependents → `blocked`** (BFS over deps edges).
4. **Slot machine extension** — add `verifying → recovering` to the transition table: RFC §D.3's frozen diagram has no verify-fail edge, but AC2 mandates a redispatch rail from an unverified exit (verify-fail ≈ stall). Documented as a deliberate extension; `state-machine.test.ts` updated.
5. **State/config schema 1.1.0** — `SlotEntry` gains `branch` (captured from the setup milestone's `branch=` key) and `last_head` (last seen remote branch sha — the "new pushed commit" stall signal); `validateState` accepts 1.0.0 files (new fields backfilled null) and writes 1.1.0. `config.json` schema 1.1.0 (accepts 1.0.0): optional `stall_timeout_ms` (default 1 800 000), `reconcile_interval_ms` (default 60 000), `dispatch` ({command?, prompt?, tier_models?}).
6. **New `packages/sched/src/journal.ts`** — append-only `events.jsonl` in the sched dir (AC6): assigned/spawned/exit/verify-complete/verify-incomplete/redispatch/stalled/failed/blocked-refill events with ts/unit/slot/pid/tier.
7. **CLI `sched start`** — long-running loop (RFC C.1): `--interval <sec>` (default 60), `--once` (single tick, cron-style drain), `--json`; wires real GroundTruth + spawn + agent auto-detection. `sched status` slot table gains pid and last-progress columns (live phase column already exists).
8. **Tests** — unit tests per module with fully injected deps (fake spawn/kill/isAlive, scripted ground truth); plus an integration test spawning real fake-agent processes (node fixture scripts that post fake milestones to files / sleep / die) against real state files with file-backed ground truth — scratch git repo only where `branchHead` is exercised; no LLM calls anywhere.

## Reachability Evidence
- State: dispatch/verify/stall states | Trigger: an operator runs `ai-dossier sched start` against a queue (RFC-0001 migration Step 1, already accepted) | Prod check: N/A | Verdict: N/A — pure developer-tooling infrastructure; the new states are scheduler-internal machine states, not user-data-reachable conditions, and this project has no production data store (CLI + registry only).

## Files to Modify
- `packages/sched/src/types.ts` — SlotEntry.branch/last_head; SCHEMA_VERSION 1.1.0; DispatchConfig/EngineConfig types; TierLadder constant; journal event types
- `packages/sched/src/state.ts` — 1.0.0→1.1.0 migration on load; `verifying → recovering` edge; validate new slot fields
- `packages/sched/src/persist.ts` — config schema 1.1.0 (dispatch, stall_timeout_ms, reconcile_interval_ms; accepts 1.0.0)
- `packages/sched/src/dispatch.ts` — NEW: command/prompt building, tier ladder, SpawnFn + default detached spawn
- `packages/sched/src/groundtruth.ts` — NEW: GroundTruth interface + subprocess default impl
- `packages/sched/src/engine.ts` — NEW: tick() reconcile/refill/stall/verify; transitive dependents blocking
- `packages/sched/src/journal.ts` — NEW: events.jsonl append-only journal
- `packages/sched/src/index.ts` — export the new surface
- `packages/sched/src/__tests__/` — dispatch/engine/reconcile/journal unit tests + fake-agent integration test; state-machine.test.ts update
- `cli/src/commands/sched.ts` — `sched start` subcommand; status slot table pid/last-progress columns
- `packages/sched/README.md`, `cli/README.md` — dispatch/verification/stall docs
- `packages/sched/package.json` (0.1.0 → 0.2.0), `cli/package.json` (0.17.0 → 0.18.0), `CHANGELOG.md` — version bumps + entry (CI version-bump job requires it)

## Reusable Code
- `packages/sched/src/scheduler.ts:computeAssignments` — refill already exists as a pure function; the engine calls it and adds the spawn step
- `packages/sched/src/persist.ts:SchedStore.withLock` — every engine mutation goes through it (load→mutate→save under the directory mutex)
- `packages/sched/src/project.ts:ExecFn` — injectable subprocess pattern to copy for GroundTruth/SpawnFn
- `cli/src/helpers.ts:detectLlm` + `buildLlmCommand` — the run-spawn machinery (#459): the CLI layer's `sched start` resolves agent auto-detection the same way before handing a concrete command template to the engine
- `cli/src/run-log.ts:RunLogEntry` shape (spawned_command/model/exit_code — #458) — informs the journal event shape
- `packages/worktree-pool/src/pool-state.ts` immutable-spread + strict-validate pattern — follow for schema migration

## Risk Areas
- **Killing a live agent on wrongful stall** is the most dangerous action the engine takes. Mitigations: both progress signals (milestone `at=` + branch head sha), 30-min default with config override, kill only on confirmed stall, journal every decision.
- **pid reuse after restart**: state.json's pid may belong to an unrelated process; best-effort aliveness polling (record started_at + command in the journal for postmortems) — same tradeoff the RFC's F.10 accepts.
- **Spawned agents must outlive sched** (crash of the supervisor must not kill agents): detached spawn + unref, logs to files.
- **Schema migration**: old 1.0.0 state.json/config.json files must keep loading (backfill nulls; never reset a queue).
- **Do not regress #460's invariants**: pure state functions, lock discipline, zero LLM calls in the package, loud `CorruptStateError`.
- **Blocking dependents is irreversible-ish** (blocked→queued is the operator's manual rail) — keep the reason string naming the failed dep.

## Test Strategy
- Unit (injected fakes): dispatch builds per-tier commands and records pid (AC1); exit→verify→complete vs redispatch (AC2); external advance + orphan pid (AC3); stall ladder tier+1, cap 2, failed + transitive dependents blocked (AC4); immediate refill regression — max_slots=1, second unit must be running at the end of the same tick that completed the first (AC5); journal events + phase in status (AC6).
- Integration: real spawned fake-agent processes (fixture node scripts: `post-milestone.js`, `sleep.js`, `die.js`) against real state files in a temp dir; file-backed GroundTruth standing in for `ai-dossier runstate last`/`gh`/`git ls-remote`; a scratch git repo for the branch-head path. No network, no LLM.
- Existing: `make test` (all 189+65 current tests must stay green; state-machine.test.ts updated for the new verifying edge).

## Open Questions
(none)

## Visual Review
- [x] Not required (backend/infra only)

## Base Branch
`main` — PRs for this issue target this branch.
