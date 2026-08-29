# Issue #460: feat(sched): dossier-sched core — queue, slots, persistent state machine

## Problem

Fleet supervision is LLM prose and demonstrably leaks slots (finished subagents not replaced — RFC-0001 §A/Q3, "scheduler idle time… the named bug"). RFC-0001 (on branch `docs/batch-cycles-rfc`, sections B/C.1/D) restructures the top orchestrator as software: a deterministic `dossier-sched`. This issue builds the deterministic core — queue, typed state machines, persistent state, CLI surface — with **zero LLM invocations** and **no dispatching** (dispatch/completion/stall are #464; PR watch #468; batch-prep #469).

## Acceptance Criteria

- [ ] AC1 Queue entries carry issue number, mode (`full|slot`), batch id, dependency edges, model tier — accepted via `sched enqueue` (individual flags and `--from-manifest <json>`)
- [ ] AC2 State persisted transactionally to `~/.dossier/sched/<project>/state.json` (`<project>` = `<owner>-<repo>` slug via `gh repo view`, fallback basename of `git rev-parse --show-toplevel` — fleet-cycle convention); a process crash between writes never corrupts state (atomic rename writes)
- [ ] AC3 Issue/batch/slot state machines per RFC-0001 §D implemented as explicit typed transitions; illegal transitions throw
- [ ] AC4 `sched status` renders queue, slots, batches, blocked/failed sets
- [ ] AC5 `max_slots` config bounds concurrently "running" units; dependency edges gate readiness (a unit with an unsatisfied dependency is never runnable)
- [ ] AC6 Restart test: kill mid-state, restart, state machine resumes identically from state.json (load → validate → identical semantics; serialize round-trip after every transition)
- [ ] AC7 Zero LLM/agent invocations anywhere in this package (no spawn/run machinery imports)

## Approach

1. New workspace package `packages/sched/` (`@ai-dossier/sched@0.1.0`) mirroring `packages/worktree-pool` conventions: standalone tsconfig (ES2024/commonjs/strict), vitest.config.ts, `src/index.ts` single entry, flat feature modules, tests colocated in `src/__tests__/`.
2. **Pure state layer first** (`types.ts` + `state.ts`): discriminated string unions for IssueStatus/BatchStatus/SlotStatus per RFC §D (D.1/D.2/D.3, including failure edges: evicted→requeued, blocked, decision-pending, failed; dissolving; stall→recovering), a `transition*()` API returning new immutable state objects; every non-declared edge throws `IllegalTransitionError` naming from→to.
3. **Persistence** (`persist.ts`): `SchedState` with `schema_version: '1.0.0'` + strict `validateState()` (copy of pool-state.ts pattern); `saveState()` = write `state.json.tmp` → `fsync` → `renameSync` over `state.json` (atomic on POSIX); load = read → validate, treating absent file as fresh state; directory mutex (`.sched-lock`, pool's `acquireLock` pattern) serializes cross-process mutations.
4. **Deterministic scheduler core** (`scheduler.ts` + `enqueue.ts`): `enqueue()` appends validated QueueEntry/queue entries (flags or manifest); `computeAssignments(state, config)` = pure function — runnable = deps satisfied (dep in terminal-success state set, incl. batch-level edges gating on batch `done`/`merged`) AND mode/batch ready AND not paused; assign up to `max_slots`; slot lifecycle transitions typed but no processes spawned (that's #464).
5. **Project slug + config** (`project.ts`): `owner-repo` slug, repo-basename fallback; `config.json` (`{ max_slots: 3 }` default) separate from `state.json` (state is rebuildable hot truth; config is durable intent).
6. **CLI wiring**: `cli/src/commands/sched.ts` (`registerSchedCommand`, runstate.ts pattern: `enqueue|status|pause|resume|abandon`, `--json` on each) + one import/call in `cli/src/cli.ts`; cli gains `"@ai-dossier/sched": "^0.1.0"`; Makefile `build-sched` target wired into `build-all`/`clean`/help.
7. `sched status` renders queue table, slots, batches, blocked/failed sets (`status.ts`, table rendering akin to cli's `table.ts`); `pause`/`resume` toggle a state-level flag (paused ⇒ `computeAssignments` returns none); `abandon` marks entry failed/abandoned per typed transitions.

## Reachability Evidence

- State: scheduler states (queued/dispatched/…) | Trigger: explicit `ai-dossier sched enqueue` CLI invocation by a developer/batch-prep dossier | Prod check: N/A — not a data-reachable product state; this is developer tooling (new package + CLI) whose inputs are direct CLI calls. The problem it solves (fleet slot leaks) is documented in RFC-0001 §A/Q3 and epic #474. | Verdict: N/A (infra/tooling, per plan-issue Step 4b exemption)

## Files to Modify

- `packages/sched/` — NEW package: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/types.ts`, `src/state.ts`, `src/persist.ts`, `src/scheduler.ts`, `src/enqueue.ts`, `src/project.ts`, `src/status.ts`, `src/__tests__/{state-machine,persist,restart,scheduler,enqueue,status}.test.ts`
- `cli/src/commands/sched.ts` — NEW: `registerSchedCommand` + subcommands
- `cli/src/cli.ts` — register sched command
- `cli/package.json` — add `@ai-dossier/sched` dep; version bump (0.13.0 → 0.14.0)
- `Makefile` — `build-sched` target; wire into `build-all`, `clean`, help text

## Reusable Code

- `packages/worktree-pool/src/pool-state.ts` — schema_version + strict `validateState()` + pure immutable transforms: the exact pattern for `sched/src/state.ts`
- `packages/worktree-pool/src/pool-actions.ts:acquireLock/withLock` — directory-mutex cross-process lock, adapted to `.sched-lock`
- `cli/src/config.ts` — `~/.dossier` config-dir + 0o700/0o600 permission conventions
- `cli/src/commands/runstate.ts` — commander sub-subcommand registration pattern (`registerXCommand` + private `register<Sub>Subcommand`)
- `examples/git/fleet-cycle.ds.md:171` — the exact project-slug rule to match: `gh repo view --json owner,name -q '.owner.login + "-" + .name'`, fallback `basename $(git rev-parse --show-toplevel)`

## Risk Areas

- **Atomicity scope**: rename is atomic only within a filesystem — tmp file must live in the same directory as `state.json`.
- **DAG cycles**: enqueue must reject dependency cycles (dep on self / circular) at enqueue time, not at assignment time.
- **No network discipline** (AC7): `gh repo view` for the slug is the single allowed subprocess and only at CLI boundary (fallback path avoids `gh` entirely); package core stays pure.
- **Version-bump CI rule** (AGENTS.md): new package + cli src changes ⇒ bump `packages/sched` (starts 0.1.0) and `cli` (0.14.0) in the same PR.
- **RFC §D drift**: RFC lives on branch `docs/batch-cycles-rfc`, not main — snapshot the §D state lists into the planning/tests now so the package doesn't drift if the RFC branch rebases.

## Test Strategy

- Vitest, colocated `src/__tests__/`, temp dirs (`fs.mkdtempSync`) for all persistence tests — no network, no GitHub (per issue).
- State machine: every legal transition in §D maps to a passing test; a representative illegal edge per machine throws `IllegalTransitionError`.
- Persistence: save→load round-trip equality; corrupted/truncated `state.json` + leftover `.tmp` → load falls back cleanly (fresh or last-good), never throws opaque errors.
- Restart (AC6): perform N transitions, snapshot, reload from disk, continue transitions — final state identical to the never-reloaded run; kill-simulation = interrupted write (tmp exists, state.json stale) resolves to last-good.
- Scheduler: `max_slots` bound honored; dep-gated unit never assigned while dep unsatisfied; batch-level edge gates member batches; paused ⇒ zero assignments.
- Enqueue: flags path and `--from-manifest` path produce identical queue entries; cycle rejection.
- CLI: `createTestProgram()` harness pattern from `cli/src/__tests__/helpers/test-utils.ts`, `$HOME` override to a temp dir.

## Open Questions

(none — RFC §D is explicit; scope boundary to #464/#468 is stated in the issue)

## Visual Review

- [x] Not required (backend/infra only)

## Base Branch

`main` — PRs for this issue target this branch.
