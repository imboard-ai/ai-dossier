# @ai-dossier/sched

[![npm](https://img.shields.io/npm/v/@ai-dossier/sched.svg)](https://www.npmjs.com/package/@ai-dossier/sched)

Deterministic scheduler core for dossier batch cycles — queue, worker slots, typed state
machines, crash-safe persistence, the **dispatch engine** (#464: spawning agent
processes, verifying their completion against ground truth, mechanizing the
stall/escalation ladder), and since #468 the **PR watcher + tail work** (parked-PR
watching, script-based teardown, cheap-tier report dispatch — retiring the fleet
pattern of re-dispatching a full-cycle run for the tail). The scheduler itself **never
invokes an LLM** — it spawns the agent process the operator configured and reconciles
the durable record (`ai-dossier runstate` / `gh` / `git`) that the spawned run leaves
behind.

Design: RFC-0001 *Batch Cycles* §B/C.1/D (the RFC lives on branch `docs/batch-cycles-rfc`,
not yet merged to `main`; the §D state machines are frozen verbatim into the types below).
This package is the deterministic replacement for fleet-cycle's LLM-prose supervision,
whose named failure — slots sitting idle after a subagent finished — is a scheduling bug
this state machine makes impossible to forget.

## CLI surface

Consumed through the monorepo CLI (`@ai-dossier/cli` ≥ 0.19.0):

```bash
ai-dossier sched enqueue --issues 101,105..109 --deps 100 --tier strong   # flags
ai-dossier sched enqueue --from-manifest batch-prep.json                  # batch-prep output
ai-dossier sched start            # the dispatch engine: spawn, verify, escalate, watch parked PRs (Ctrl-C stops it)
ai-dossier sched start --once     # a single reconcile+refill tick (cron-style)
ai-dossier sched status           # queue (+pr/cleanup), parked PRs, slots, batches, blocked/failed
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
  tick,                  // one engine cycle: reconcile + verify + refill + spawn,
                         //   and since #468: park-watch, teardown, report dispatch
  runLoop,               // the sched start loop (tick, sleep, repeat)
  type TickResult,       // what one tick did (spawned/parked/merge-accepted/report-dispatched/
                         //   teardown/completed/redispatched/failed/blocked)
  type EngineDeps,       // inject everything the engine touches (store/journal/spawn/ground
                         //   truth/clock/repoDir/teardownExec)
  createSpawnDeps,       // real detached-spawn process I/O
  createExecGroundTruth, // runstate/gh/git ground truth via subprocesses (injectable exec);
                         //   since #468 also gh pr view PR state + setup info from comments
  resolveDispatch,       // config → resolved command/prompt/report-prompt/tier-models/timers
  buildReportPrompt,     // report-agent prompt ({issue}/{pr}/{cleanup} substituted)
  reportTierFor,         // report (re)dispatch tier after N escalations
  isParkedMilestone,     // ship-phase awaiting-merge + pr= → the park signal
  prOfMilestone,         // a milestone's pr= key as a positive integer
  parsePrViewJson,       // gh pr view --json → PR truth (mergedAt/mergeable/blocked label)
  parseSetupInfo,        // gh issue view --json comments → teardown inputs
  runTeardown,           // #468 script teardown for a merged unit (pool return / worktree remove)
  isSafeWorktree,        // worktree-path containment check (CWE-22)
  TEARDOWN_TIMEOUT_MS,   // teardown subprocess timeout (120 s)
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
├── config.json    # durable intent: max_slots, stall_timeout_ms, reconcile_interval_ms,
│                  # pr_poll_interval_ms, dispatch (incl. report_prompt)
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
- **Schema**: state/config files from #460 (schema 1.0.0) and #464 (1.1.0) load and
  migrate to 1.2.0 automatically (slot `branch`/`last_head`, entry `pr`/`cleanup`,
  and state-level `last_pr_poll_at` backfill to null).
- **`max_slots`** bounds live units (`assigned | running | recovering`); dependency
  edges gate readiness — an issue with an unmerged dependency, and a batch behind an
  unmerged batch, are never runnable.
- **Pause** stops new assignments only; abandon routes through the typed failure rails
  (`evicted → requeued{full}` for batch members — nothing green is discarded).

## The PR watcher + tail work (#468)

Dispatched runs park their PR on `auto-merge` (detached ship mode — the default
prompt instructs it) and exit. The engine owns everything after the park:

1. **Park detection (AC1)** — an agent exit whose latest milestone is the ship
   phase's `awaiting-merge` (with `pr=`) is a VERIFIED park, not an unverified
   exit: the entry moves to `parked`, the slot is released (a waiting unit
   consumes zero slots), and the watcher takes over.
2. **PR watching (AC1)** — parked PRs are polled every `pr_poll_interval_ms`
   (default 150 s — "every 2–3 min", persisted `last_pr_poll_at` so a restart
   honors the cadence; checked on each reconcile tick when due, so a
   `reconcile_interval_ms` longer than the interval slows the effective cadence)
   via `gh pr view --json state,mergedAt,mergeable,labels`.
   A merge is accepted only when state is MERGED **and** `mergedAt` is non-null
   **and** the issue is closed — never inferred from an agent exit. An
   unreachable poll pauses the watcher (decision 2, option A).
3. **Failure states (AC3)** — `CONFLICTING`, closed-unmerged, or the
   `auto-merge-blocked` label fail the unit with the reason and block its
   TRANSITIVE dependents. The engine never merges anything itself.
4. **Gating on MERGE, not park (AC4)** — `parked` is not a satisfied status:
   dependents stay blocked until the merge lands (`parked → shipped`).
5. **Teardown as a script (AC2)** — on merge, the run's setup milestone
   (recovered once from the issue's comments — collaborator-authored only, and
   the worktree path must pass a containment check before any destructive
   subprocess) chooses the script: pool-claimed worktrees run
   `worktree-pool return --path <wt> --json` (the pool's own self-check is the
   verification); cold worktrees run
   `git worktree remove --force <wt>` with a path-gone check. Both are
   verify-first idempotent; a failed step records `cleanup=failed-<step>` on
   the entry and in the journal — degradation, never unit failure.
6. **Report dispatch (AC2)** — once teardown is recorded (when a slot is
   free — a waiting report consumes zero slots), a **mechanical-tier** report
   agent is spawned with the report-phase prompt (`dispatch.report_prompt`;
   `{issue}`/`{pr}`/`{cleanup}` substituted — the cleanup status rides into
   the report). It completes like any agent; a report that stalls climbs the
   same ladder (mechanical → mid → strong, cap 2), and at the cap the unit
   completes (`done`, reason `report-escalation-cap`) with a `report-failed`
   journal event — the work is merged, so dependents are never re-blocked.
   The full-cycle tail-run pattern (re-dispatching a whole run for
   teardown+report) is retired.

`sched status` shows parked PRs (zero slots, with the last poll's age), a
`pr` column and a `cleanup` column on the queue; every watcher decision lands
in `events.jsonl` (`pr-parked`, `merge-accepted`, `pr-watch-failed`,
`pr-watch-waiting`, `teardown-done`/`teardown-failed`, `report-dispatched`,
`report-failed`, `ground-truth-unreachable`).

## Development

```bash
cd packages/sched
npm run build    # tsc → dist/
npm test         # vitest — state machines, persistence, crash/restart, engine,
                 # and integration tests with real spawned fake agents (no LLM calls)
```

No network, no GitHub in unit tests — persistence tests run on temp directories; the
integration tests spawn fake-agent fixtures against a scratch git repo with stubbed
ground truth. The #468 integration tests run the full detached-ship tail
(park → watch → merge → REAL worktree removal → report) end-to-end, including a
sched restart mid-watch.
