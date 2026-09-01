# @ai-dossier/sched

[![npm](https://img.shields.io/npm/v/@ai-dossier/sched.svg)](https://www.npmjs.com/package/@ai-dossier/sched)

Deterministic scheduler core for dossier batch cycles — queue, worker slots, typed state
machines, crash-safe persistence, the **dispatch engine** (#464: spawning agent
processes, verifying their completion against ground truth, mechanizing the
stall/escalation ladder), and since #468 the **PR watcher + tail work** (parked-PR
watching, script-based teardown, cheap-tier report dispatch — retiring the fleet
pattern of re-dispatching a full-cycle run for the tail), and since #472 **batch failure
recovery** (attribution, bisect, one bounded fix, eviction, dissolve). The scheduler itself **never
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

Since #507, `enqueue` additionally reads each candidate issue's live GitHub labels (one
`gh issue view --json labels` call per issue, resolved against the current directory's repo
unless `--repo <owner/name>` is passed) and lands an issue carrying `decision-pending` /
`needs-clarification` / `epic` / `decomposed` as `blocked` (`reason: label:<name>`) instead
of `queued` — without spending a slot on an agent that would only rediscover the same block.
A failed `gh` lookup fails open: the issue enqueues normally, with a warning and a
`label-check-failed` journal event.

## The dispatch engine (#464)

`sched start` runs a tick loop (default 60s, `--interval` or `reconcile_interval_ms`)
where every mechanical supervision decision is code, not remembered prose:

1. **Dispatch (AC1)** — a runnable unit is spawned as a detached agent process
   (`claude -p --output-format json --model <tier model>` by default, opencode fallback;
   command/prompt/tier-models configurable), prompt on stdin, output appended to
   `runs/<unit>.log`. The opencode fallback runs `opencode run --auto …` (#506) — a git
   worktree is an `external_directory` to opencode, whose default `"ask"` policy a headless
   session can only auto-reject, killing the agent mid-phase; `--auto` approves any request
   not explicitly denied. pid, phase, role, and last-progress are persisted in `state.json`.
   Agents are unref'd: they survive a sched crash (restart reconciles by pid). The default
   full-cycle and fix prompts (`DEFAULT_PROMPT_TEMPLATE`, `DEFAULT_FIX_PROMPT_TEMPLATE`)
   append `NO_BACKGROUND_EXIT_INSTRUCTION` (#497) — a headless session ends the instant the
   model stops responding, so an agent that starts a long build/test command and reports
   "waiting for it to finish" abandons the run with the subprocess still going; the
   instruction tells it to run such commands in the foreground and wait, or poll until
   they finish. `DEFAULT_REPORT_PROMPT_TEMPLATE` is excluded — it never spawns a long
   command.
2. **Completion verification (AC2)** — an agent exiting is never proof of completion.
   On exit, the unit completes only when ground truth confirms it: the issue's latest
   runstate milestone is `report done`, or GitHub says the issue is closed — except a
   report-agent slot (`role: 'report'`), whose issue is already closed at merge: the
   closed signal is suppressed and only a `report done` milestone completes it (#500).
   An unverified exit rides the recovery ladder like a stall.
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
   progress, stalled, redispatched, unit-failed, dependents-blocked, suspect-dispatch,
   dispatch-unhealthy, …) is appended to `events.jsonl`; `sched status` shows the live
   phase per unit. `label-blocked`/`label-check-failed` (#507) are the one pair journaled
   OUTSIDE the engine — `sched enqueue` appends them at enqueue time, before dispatch.
7. **Dispatch-health pause (#505)** — an unverified exit within `SUSPECT_DISPATCH_WINDOW_MS`
   (60s) of a slot's last progress is `suspect-dispatch`: real work rarely produces zero
   milestones that fast, but an operator-billing quota/auth wall (a Claude Code weekly
   limit, a provider credit cap, …) that rejects the agent's very first request does,
   every time. `DISPATCH_UNHEALTHY_THRESHOLD` (2) consecutive suspect-dispatches from
   DIFFERENT units — the cross-unit correlation that tells a wall apart from one unit's
   own flakiness — auto-pauses new assignments (`state.paused = true`, journaled
   `dispatch-unhealthy`) exactly like `sched pause`: already-live slots keep running, only
   new assignments stop, including report-agent dispatch. The per-unit stall/escalation
   ladder above is unchanged — this only stops MORE units from being dispatched into a
   known-bad wall. A healthy dispatch outcome (verified completion or park) resets the
   streak; the pause itself clears only via `sched resume` (never automatically — an
   operator's explicit "I've addressed this," not a heuristic that could re-dispatch into
   a wall that hasn't actually cleared), which also clears the streak so `sched status`'s
   warning doesn't linger against a wall the operator already acted on.

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

## Batch failure recovery (#472)

What happens when a batch's aggregate suite goes red, or its PR will not merge
(RFC-0001 §F.2/F.8/F.9).

**Not yet wired into `sched start`** — `tick()` still dispatches only `issue:<n>` units
(the batch execution loop is a follow-up, see above). These modules are the library
surface that loop will call, and they are tested standalone against real scratch repos.

```
validating → attributing → fixing (ONE bounded attempt) → validating
                         → evicting (revert the member's commits) → validating
  > ⅓ of members evicted, or a revert conflict → dissolving → members requeued
awaiting-merge (CONFLICTING | auto-merge-blocked)
                         → rebasing → re-validating → shipping
                         → (2nd occurrence) dissolving into two half-batches
```

1. **Attribution (AC1)** — `attributeByOverlap` maps each failing test to a member by
   focused-test match, then by changed-path overlap. Exactly one candidate attributes;
   more than one is AMBIGUOUS and none is UNATTRIBUTED — neither is ever guessed. When
   the caller supplies a `BisectSpec`, both go to `runAttributionBisect`: a real
   `git bisect run` over the branch's `good..bad` range executing ONLY the failing tests,
   whose first-bad commit is mapped to a member through the `(#N)` subject trailer on the
   branch's issue-boundary commits (every unresolved test is then attributed to that
   member). A first-bad commit with no trailer, or an abbreviated sha matching two
   commits, reports `unattributable` rather than blaming a neighbour. The bisect refuses
   to run at all unless the test command actually discriminates — it must fail at `bad`
   AND pass at `good`, so a missing runner cannot silently convict the earliest member —
   and it always resets the checkout to where it found it. Without a `BisectSpec`,
   overlap is the whole verdict and unresolved tests stay unattributed.
2. **One bounded fix attempt (AC2)** — `beginFixAttempt` returns the mid-tier command and
   prompt for the CALLER to spawn (sched never invokes an LLM) and records the attempt.
   A second call for the same member returns `null`: the next step is eviction, so a
   batch cannot burn its budget on one broken member.
3. **Eviction (AC2)** — `evictMembers` reverts the member's commits newest-first across
   members (an eviction group reverts together), requeues it as full-cycle with
   `failure_evidence` attached (batch, reason, failing tests, attribution method, reverted
   commits), re-runs the suite and checks the dissolve trigger. A conflicting revert is
   aborted so the worktree is clean and the batch dissolves — the reverts that already
   landed ride along on the abandoned branch, which is why it is abandoned rather than
   reused. An eviction group that reaches an already-shipped member dissolves instead of
   reverting merged work.
4. **Dissolve (AC3)** — `dissolveBatch` marks the batch `dissolved` and requeues every
   UNSHIPPED member: `full` (each as its own full-cycle run) or `halved` (one or two fresh
   `forming` half-batches — a single remaining member yields one — entries retagged,
   eviction groups inherited where they survive the split). Shipped and terminal members
   keep their outcome; nothing green is discarded, and no git runs — the batch branch is
   simply left behind unmerged, since sched deletes nothing.
5. **PR conflict (AC4)** — `handlePrConflict` rebases the batch branch, re-runs the suite
   and re-ships ONCE. A second occurrence, a conflicting rebase, a failed fetch, an
   unusable `base_branch`, a checkout that is not on the batch branch, or a red suite
   after a clean rebase dissolves into two half-batches.
6. **Milestones (AC5)** — every eviction and dissolve posts a `batch-validate` /
   `batch-ship` milestone to the batch ANCHOR issue via `ai-dossier runstate post`, with
   the reason, the evicted/requeued/preserved members and the attribution method (a
   successful re-ship posts `batch-ship awaiting-merge`); each per-member outcome is
   journaled and kept in the batch's `evictions` (the classifier feedback signal). A batch
   with no `anchor` or no `run_id` cannot post — the CLI requires both — so the milestone
   it could not post is journaled in full instead of vanishing.

Ten journal events carry the detail: `suite-failed`, `attributed`, `fix-dispatched`,
`fix-resolved`, `member-evicted`, `revert-conflict`, `batch-rebased`, `batch-dissolved`,
`batch-split` and `milestone-post-failed`, plus `git-failed` for any git command that
returned non-zero (the injected `ExecFn` collapses every git failure into `null`, so the
command that produced one is always recorded).

Schema 1.3.0 carries the new state: `BatchEntry` gains `anchor`, `branch`, `run_id`,
`eviction_groups`, `evictions`, `fix_attempts` and `rebase_attempts`; `QueueEntry` gains
`failure_evidence`. 1.2.0 states migrate on load.

Schema 1.4.0: `SlotEntry` gains `role` (`'cycle' | 'report'`) — set when the slot is
assigned and never resynced from polled milestones the way `phase` is, so a report
agent's completion-suppression signal survives `phase` drifting back to the issue's
pre-report milestone mid-run (#500). 1.3.0 states migrate on load: `role` is inferred
from the unit's queue entry (`shipped` + `pr` + `cleanup` — the same guard that assigns
a report slot in the first place) with the persisted `phase` as a fallback when no
matching entry exists. A backfilled role is a best-effort inference, not a guarantee —
see `validateState` in `state.ts` for the exact rule.

Schema 1.5.0: `SchedState` gains `consecutive_suspect_dispatches` (number) and
`last_suspect_dispatch_unit` (string or null) — the dispatch-health pause's cross-unit
suspect-dispatch streak (#505 above). The two fields are a single fact and must agree
(`0 ⇔ null`); `validateState` rejects a state where they disagree. 1.4.0 states migrate
on load: no suspect dispatches were ever tracked under them, so `0`/`null` is the exact
backfill, not a guess.

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
  attributeByOverlap,    // #472 pure stage-1 attribution: failing tests → members
  parseVitestJson,       // vitest --reporter=json → failing tests
  parseBoundaryCommits,  // git log → issue-boundary commits via the (#N) trailer
  memberRanges,          // boundary commits → each member's commit list
  runAttributionBisect,  // stage-2: real git bisect over the failing tests only
  beginAttribution,      // validating → attributing (overlap, then bisect if needed)
  beginFixAttempt,       // the ONE bounded mid-tier fix dispatch instruction
  resolveFixAttempt,     // record its outcome, back to validating
  evictMembers,          // revert + requeue with evidence + suite re-run + dissolve check
  checkDissolveTrigger,  // pure: > ⅓ of members evicted
  dissolveBatch,         // full or halved dissolve; preserves everything green
  handlePrConflict,      // rebase + re-ship once, then dissolve into halves
  createExecMilestonePoster, // batch milestones via `ai-dossier runstate post`
  expandEvictionGroups,  // members that must revert together (§E.4 eviction groups)
  requeueMember,         // the one requeue path abandon/evict/dissolve all take
  isPreservedMember,     // the single definition of "already green"
  createBatch,           // the single BatchEntry constructor
  type RecoveryDeps,     // inject exec/repoDir/journal/milestone-poster/suite-runner/clock
  type SuiteRunner,      // re-runs the aggregate suite after a revert or rebase
  type BatchMilestonePoster, // batch-milestone sink (createExecMilestonePoster is default)
  Journal,               // append-only events.jsonl
  transitionIssue, transitionBatch, transitionSlot,  // typed §D transitions
  TRANSITIONS,           // the transition tables themselves (for previews)
  buildStatusReport,     // machine-readable status incl. blocked/failed sets
  validateState,         // strict persisted-state validation (1.0.0-1.4.0 files migrate)
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
- **Schema**: state/config files from #460 (schema 1.0.0), #464 (1.1.0), #468 (1.2.0),
  #472 (1.3.0) and #500 (1.4.0) load and migrate to 1.5.0 automatically (slot
  `branch`/`last_head`/`pid_start`, slot `role` (inferred from the unit's queue entry,
  with the persisted `phase` as a fallback — #500), entry `pr`/`cleanup`/
  `failure_evidence`, batch `anchor`/`branch`/`run_id`/`eviction_groups`/`evictions`/
  `fix_attempts`/`rebase_attempts`, state-level `last_pr_poll_at` backfill to null, and
  state-level `consecutive_suspect_dispatches`/`last_suspect_dispatch_unit` backfill to
  `0`/`null` — #505).
- **`max_slots`** bounds live units (`assigned | running | recovering`); dependency
  edges gate readiness — an issue with an unmerged dependency, and a batch behind an
  unmerged batch, are never runnable.
- **Pause** stops new assignments only (including report-agent dispatch — #505); abandon
  routes through the typed failure rails (`evicted → requeued{full}` for batch members —
  nothing green is discarded). A pause can be manual (`sched pause`) or automatic
  (dispatch-health, #505 above); `sched resume` clears both the flag and the
  dispatch-health streak.

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
   the report). The slot records `role: 'report'` at assignment, fixed for the
   assignment and never resynced by `phase-updated` (#500) — the issue is already
   closed at merge, so for a report-role slot the closed signal is suppressed and
   only a `report done` milestone completes the unit. A report that stalls climbs the
   same ladder (mechanical → mid → strong, cap 2), and at the cap the unit
   completes (`done`, reason `report-escalation-cap`) with a `report-failed`
   journal event — the work is merged, so dependents are never re-blocked.
   The full-cycle tail-run pattern (re-dispatching a whole run for
   teardown+report) is retired.
7. **Stale-failure reconcile (#501)** — a `failed reason=auto-merge-blocked`
   entry stops being watched the instant it leaves `parked`, but an operator
   can manually clear the watcher's block and re-queue the same PR outside
   the engine entirely. `pollParkedPrs` also polls these stale-failed entries
   (same cadence, no extra GH calls), and once the PR shows `MERGED` with the
   issue closed, the entry flips `failed → shipped` and re-enters the normal
   report-dispatch path (AC2 above) — `sched status` and dependents'
   readiness reflect that the work actually shipped. This does NOT
   retroactively unblock dependents that were already blocked when the unit
   first failed; that stays a manual follow-up.

`sched status` shows parked PRs (zero slots, with the last poll's age), a
`pr` column and a `cleanup` column on the queue; every watcher decision lands
in `events.jsonl` (`pr-parked`, `merge-accepted`, `pr-watch-failed`,
`pr-watch-waiting`, `teardown-done`/`teardown-failed`, `report-dispatched`,
`report-failed`, `ground-truth-unreachable`, `stale-failure-reconciled`).

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
