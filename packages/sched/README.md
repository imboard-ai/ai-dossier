# @ai-dossier/sched

[![npm](https://img.shields.io/npm/v/@ai-dossier/sched.svg)](https://www.npmjs.com/package/@ai-dossier/sched)

Deterministic scheduler core for dossier batch cycles — queue, worker slots, typed state
machines, crash-safe persistence, and (since #464) the **dispatch engine**: spawning agent
processes, verifying their completion against ground truth, and mechanizing the
stall/escalation ladder. The scheduler itself **never invokes an LLM** — it spawns the
agent process the operator configured and reconciles the durable record
(`ai-dossier runstate` / `gh` / `git`) that the spawned run leaves behind.

Design: RFC-0001 *Batch Cycles* §B/C.1/D (the RFC lives on branch `docs/batch-cycles-rfc`,
not yet merged to `main`; the §D state machines are frozen verbatim into the types below).
This package is the deterministic replacement for fleet-cycle's LLM-prose supervision,
whose named failure — slots sitting idle after a subagent finished — is a scheduling bug
this state machine makes impossible to forget.

## CLI surface

Consumed through the monorepo CLI (`@ai-dossier/cli` ≥ 0.18.0):

```bash
ai-dossier sched enqueue --issues 101,105..109 --deps 100 --tier strong   # flags
ai-dossier sched enqueue --from-manifest batch-prep.json                  # batch-prep output
ai-dossier sched start            # the dispatch engine: spawn, verify, escalate (Ctrl-C stops it)
ai-dossier sched start --once     # a single reconcile+refill tick (cron-style)
ai-dossier sched status           # queue, slots (pid/phase/last-progress), batches, blocked/failed
ai-dossier sched pause            # stop NEW assignments; live units keep running
ai-dossier sched resume
ai-dossier sched abandon --issue 42 --reason "operator abort"
ai-dossier sched abandon --batch b1   # dissolve; members requeue as full-cycle
```

Every subcommand takes `--project <slug>` (default: `owner-repo` of the current directory,
falling back to the repo basename — fleet-cycle's convention) and `--json`.

## The dispatch engine (#464)

`sched start` runs a tick loop (default 60s, `--interval` or `reconcile_interval_ms`)
where every mechanical supervision decision is code, not remembered prose:

1. **Dispatch (AC1)** — a runnable unit is spawned as a detached agent process
   (`claude -p --output-format json --model <tier model>` by default, opencode fallback;
   command/prompt/tier-models configurable), prompt on stdin, output appended to
   `runs/<unit>.log`. pid, phase, and last-progress are persisted in `state.json`.
   Agents are unref'd: they survive a sched crash (restart reconciles by pid).
2. **Completion verification (AC2)** — an agent exiting is never proof of completion.
   On exit, the unit completes only when ground truth confirms it: the issue's latest
   runstate milestone is `report done`, or GitHub says the issue is closed. An unverified
   exit rides the recovery ladder like a stall.
3. **Reconciliation tick (AC3)** — every tick detects externally-advanced state (someone
   finished the work outside sched → complete, kill the leftover agent, reclaim the
   slot), orphaned pids after a restart (dead pid on a running slot → exit rail →
   verify), and progress (a new milestone `at=` or a new pushed commit — the branch from
   the setup milestone watched via `git ls-remote`).
4. **Stall/escalation ladder (AC4)** — no new milestone AND no new pushed commit for
   `stall_timeout_ms` (default 30 min) → kill the agent and redispatch the same unit one
   tier stronger (mechanical → mid → strong; the resume rails carry work forward). Cap 2
   escalations — or a stall at the strongest tier — fails the unit and blocks its
   TRANSITIVE dependents (`dep-failed:<issue>`).
5. **Immediate refill (AC5)** — a slot freed by a terminal state is refilled in the SAME
   tick; a runnable unit never waits while a slot is idle (pinned by a regression test).
6. **Journal (AC6)** — every event (assigned, spawned, exit-detected, external-advance,
   progress, stalled, redispatched, unit-failed, dependents-blocked, …) is appended to
   `events.jsonl`; `sched status` shows the live phase per unit.

Two engine-safety policies were explicit product decisions on #464:

- **Pid identity is hybrid-verified (decision 1, option C).** Every spawn records the
  child's `/proc/<pid>/stat` start-time and persists it in `state.json` (`pid_start`);
  `kill`/`isAlive` refuse a pid whose current start-time no longer matches — a reused
  pid is never signalled, across engine restarts too. Platforms without `/proc`
  (macOS/Windows) and legacy pids without a recorded start-time stay best-effort.
- **Unreachable ground truth pauses decisions (decision 2, option A).** A FAILED
  milestone poll (`undefined`) is distinct from a verifiably-empty trail (`null`):
  while a poll is unreachable (gh auth expired, `ai-dossier` missing from a cron PATH,
  network down), stall and verify-fail decisions pause for that unit — an outage can
  never kill a healthy agent or fail a unit as "unverified". An agent that exits during
  an outage holds in `verifying` until truth returns. Each pause is journaled as
  `ground-truth-unreachable`.

Only `issue:<n>` units are dispatched today — batch member sequencing is a follow-up
(#464 non-goal).

## API surface

```ts
import {
  SchedStore,            // persistence: load/save/withLock per project dir
  enqueueEntries,        // validated queue appends (cycles, dupes, mode/batch rules)
  parseManifest,         // batch-prep JSON → EnqueueInput[]
  computeAssignments,    // pure: fill idle slots with runnable units, bounded by max_slots
  runnableUnits,         // pure: which units may run right now (dep-gated)
  tick,                  // one engine cycle: reconcile + verify + refill + spawn
  runLoop,               // the sched start loop (tick, sleep, repeat)
  type TickResult,       // what one tick did (spawned/completed/redispatched/failed/blocked)
  type EngineDeps,       // inject everything the engine touches (store/journal/spawn/ground truth/clock)
  createSpawnDeps,       // real detached-spawn process I/O
  createExecGroundTruth, // runstate/gh/git ground truth via subprocesses (injectable exec)
  resolveDispatch,       // config → resolved command/prompt/tier-models/timers
  Journal,               // append-only events.jsonl
  transitionIssue, transitionBatch, transitionSlot,  // typed §D transitions
  TRANSITIONS,           // the transition tables themselves (for previews)
  buildStatusReport,     // machine-readable status incl. blocked/failed sets
  validateState,         // strict persisted-state validation (1.0.0 files migrate)
  IllegalTransitionError, EnqueueError, CorruptStateError, LockTimeoutError,
  SchedNotFoundError,
} from '@ai-dossier/sched';
```

All state functions are pure (state in, new state out — the worktree-pool pattern);
`SchedStore` is the only state-I/O boundary and every mutation runs under its lock. The
engine polls ground truth OUTSIDE the lock and mutates state under it, so a slow `gh`
call never blocks other sched commands. All process I/O is injectable — the tests spawn
fake agents and stub ground truth; no LLM calls anywhere.

## State layout

```
~/.dossier/sched/<project>/
├── state.json     # hot operational truth — atomic tmp+fsync+rename writes;
├── config.json    # durable intent: max_slots, stall_timeout_ms, reconcile_interval_ms, dispatch
├── events.jsonl   # append-only event journal (the operator's flight recorder)
├── runs/          # per-unit agent output logs (issue-<n>.log)
└── .sched-lock/   # cross-process directory mutex (pid; stolen from dead holders)
```

- **Crash safety**: a process killed between writes leaves the previous complete state,
  never a partial file; restart resumes identically (proved by `restart.test.ts`) —
  running slots with dead pids are re-detected and verified, slots left `assigned` by a
  crash between assign and spawn are spawned, and a dispatched entry no slot holds is
  requeued.
- **Corrupt state is loud**: `load()` throws `CorruptStateError` naming the file —
  never a silent queue reset. `state.json` is deletable and rebuildable from GitHub,
  which remains the system of record.
- **Schema**: state/config files from #460 (schema 1.0.0) load and migrate to 1.1.0
  automatically (slot `branch`/`last_head` backfill to null).
- **`max_slots`** bounds live units (`assigned | running | recovering`); dependency
  edges gate readiness — an issue with an unmerged dependency, and a batch behind an
  unmerged batch, are never runnable.
- **Pause** stops new assignments only; abandon routes through the typed failure rails
  (`evicted → requeued{full}` for batch members — nothing green is discarded).

## Development

```bash
cd packages/sched
npm run build    # tsc → dist/
npm test         # vitest — state machines, persistence, crash/restart, engine,
                 # and integration tests with real spawned fake agents (no LLM calls)
```

No network, no GitHub in unit tests — persistence tests run on temp directories; the
integration tests spawn fake-agent fixtures against a scratch git repo with stubbed
ground truth.
