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
ai-dossier sched stats --issues 4..9  # per-issue tokens/cost from ~/.dossier/runs.jsonl (#524)
```

Every subcommand except `stats` takes `--project <slug>` (default: `owner-repo` of the
current directory, falling back to the repo basename — fleet-cycle's convention) and
`--json`. `stats` reads `~/.dossier/runs.jsonl`, a single global file, not the
per-project state — it takes `--json` and `--issues` only; see "runs.jsonl telemetry"
below for the resulting cross-repo caveat (the same issue number in two repos sums
together).

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
   (`claude -p --output-format stream-json --verbose --model <tier model>` by default —
   `json` buffers the whole session into a single write at exit, which left a 0-byte log
   for any dispatch killed before a clean exit (#524); opencode fallback;
   command/prompt/tier-models configurable), prompt on stdin, output appended to
   `runs/<unit>.log`. Each tier may fully override the command/model/prompt independently
   via `dispatch.tiers.<tier>` (#527) — a MIXED agent-CLI ladder, not just a different
   model on the same CLI: a unit can start on `opencode` for `mechanical`/`mid` and be
   rescued on `claude` at `strong`. `dispatch.tiers` is additive over the top-level
   `command`/`tier_models`/`prompt` shorthand — any field a tier leaves unset falls back
   to the shorthand, so an existing config with no `tiers` resolves exactly as before.
   The opencode fallback runs `opencode run --auto …` (#506) — a git
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
   tier stronger (mechanical → mid → strong; the resume rails carry work forward). The
   redispatch reads the NEXT tier's own resolved command (#527) — `resolveDispatch`
   pre-resolves every tier once per tick, so a mixed-CLI ladder rescues on a different
   agent CLI, not just a different `--model` flag on the same one. Cap 2
   escalations — or a stall at the strongest tier — fails the unit and blocks its
   TRANSITIVE dependents (`dep-failed:<issue>`). The timeout is **phase-aware** (#495):
   the `implement` phase alone can run 1-3h on a large monorepo with zero intermediate
   milestone or pushed commit, so it gets a longer built-in default (90 min,
   `DEFAULT_PHASE_STALL_TIMEOUT_MS`) than every other phase's 30-min default — selected by
   the phase now IN FLIGHT (the last milestone's `next=`, not the last completed phase;
   before any milestone posts it falls back to the slot's own phase). A built-in phase
   default is a FLOOR against the global `stall_timeout_ms` — raising the global never
   silently shortens `implement`'s allowance. Override any phase via
   `dispatch.phase_stall_timeout_ms: { "<phase>": <ms> }` in `config.json` (validated
   against the known phase vocabulary — an unrecognized key is a config error, not a
   silent no-op); an explicit override always wins verbatim, even below the built-in
   default. A phase not listed keeps its built-in default (floored by the global) or
   falls back to the global `stall_timeout_ms` outright.
5. **Immediate refill (AC5)** — a slot freed by a terminal state is refilled in the SAME
   tick; a runnable unit never waits while a slot is idle (pinned by a regression test).
   Refill was always synchronous; what previously had no journal trace was the release
   itself — see `slot-released` below (#525).
6. **Journal (AC6)** — every event (assigned, spawned, exit-detected, external-advance,
   progress, stalled, redispatched, fence-written, fence-failed, unit-failed,
   dependents-blocked, slot-released, suspect-dispatch, dispatch-unhealthy,
   run-log-recorded, run-log-no-usage, run-log-skipped, run-log-failed, engine-stale,
   engine-auto-upgrade-attempted, engine-auto-upgrade-failed, …) is
   appended to `events.jsonl`; `sched status` shows the live phase per unit, plus each
   slot's `gen` and `fenced` state (#504).
   `engine-stale`/`engine-auto-upgrade-attempted`/`engine-auto-upgrade-failed`
   (#537) are journaled OUTSIDE the engine — `sched start`'s CLI-side staleness check
   appends them directly, not through `tick()`. The label events
   (`label-blocked`/`label-check-failed`/`label-cleared`) come from BOTH sides: `sched
   enqueue` appends the first two at enqueue time before dispatch (#507), and since #544
   the engine appends all three from its own per-tick label re-check. `slot-released` (#525) marks the exact tick a held
   slot reaches `idle` on a per-issue dispatch terminal path — verified completion,
   external-advance, a direct failure, a blocked dependent's release, or a
   detached-ship park — carrying the freed `slot` id and a closed `reason`
   (`verify-complete` / `external-advance` / `unit-failed` / `report-failed` /
   `dependents-blocked` / `parked`, the exported `SlotReleaseReason` union), journaled
   right after that path's own cause event so an occupancy report reads release time
   directly instead of inferring it from the next `assigned` on that slot. Not yet
   journaled by `sched abandon` or by batch-slot release, which walk a slot to `idle`
   through their own copies of the same edge table (tracked as a follow-up).
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

Config schema moves to 1.4.0 (#527): `dispatch` gains `tiers` — a per-tier
`{ command?, model?, prompt? }` spawn spec. `command`/`tier_models`/`prompt` remain valid
as the shorthand and are the fallback for any field a `tiers` entry leaves unset, so a
1.3.0 config with no `tiers` at all resolves identically to before — there is no on-disk
migration, only resolution-time fallback in `resolveDispatch`.

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

This applies to `issue:<n>` unit dispatch (`dispatchAssignments`). `batch:<id>` units run
through a separate pass with its own claim/reconcile logic — see
[Batch dispatch (#523)](#batch-dispatch-523) below.

### Zombie-run fencing (#504)

The ladder redispatches the SAME run, so a takeover inherits the run id and its milestone
trail. In the #472 race that turned out to be a hole: `enterRecovery` kills the pid it
knows about, but an agent it cannot see or signal — throttled, cwd outside the worktree —
survives, and nothing on the trail tells that agent it was replaced. Both runs implemented
the same issue, and both kept posting milestones on one trail. The doctrine, one step past
"an agent exiting is not proof of merge": **no visible process is not proof of death.**

A **generation** now fences the trail:

- Before the takeover is spawned, the engine calls `ai-dossier runstate fence`, which
  posts a `status=superseded` milestone carrying `gen=<n>` and `takeover=<label>`.
  Written first, on purpose, so it survives the takeover dying too.
- The takeover is told its generation in its prompt and passes `--gen <n>` to every
  `runstate post`. **The CLI refuses any post below the trail's fenced generation**, so
  the superseded agent cannot extend the trail even though it never checks — and an agent
  running an older dossier implicitly sits at generation 0, fenced out the moment
  generation 1 exists.
- `ai-dossier runstate check --issue <n> --run <id> --gen <g>` exits `3` when the caller
  has been superseded: the checkpoint a workflow runs before implement, review, and ship.
- A takeover that posts NOTHING is watched on the **shorter** of
  `fence_takeover_timeout_ms` (default 15 min) and the phase's own stall allowance — the
  fence window can only ever bring recovery forward, never delay it — so a takeover that
  dies at birth re-enters the ladder in minutes and the next fence supersedes it in turn.
  The first progress signal disarms the short window. `ESCALATION_CAP` still bounds the
  whole ladder.
- Report agents ride the same rail: a fenced report slot is told its generation too, or
  its `report done` milestone would be refused and it would recover to the cap on a PR
  that already merged.
- The read side is hardened, because a milestone is an issue comment: only comments from
  an account with **write access** count as a fence, a forged `takeover=` label is dropped
  rather than echoed into an agent's prompt, and the engine refuses to fence a run id that
  does not belong to the issue it is working on (that would journal success while the real
  zombie stayed free to write).

Fencing is defense-in-depth, not a precondition: if the fence cannot be written (no run id
on the trail yet, gh unreachable, no fencer configured) the redispatch proceeds unfenced
and journals `fence-failed`. Stranding a stalled unit forever would be the worse failure —
but the unprotected redispatch is never silent.

## Batch failure recovery (#472)

What happens when a batch's aggregate suite goes red, or its PR will not merge
(RFC-0001 §F.2/F.8/F.9).

**Wired into `sched start` since #523** — the `validating → attributing → fixing/evicting`
rail below is called directly from `batch-dispatch.ts`'s `runValidate`/`evictOffender`
(a red AGGREGATE suite, after every member individually went green). A member that never
went green in the first place (its own gate failed) evicts through a separate, simpler
rail that never touches this module — see
[Batch dispatch (#523)](#batch-dispatch-523). These modules remain independently tested
against real scratch repos.

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

Schema 1.6.0: `SlotEntry` gains `gen` (number — the runstate generation the slot's agent
owns, 0 for a first dispatch) and `fenced_at` (ISO string or null — set when a takeover is
fenced in, cleared by its first progress signal; #504 above). 1.5.0 states migrate on
load: nothing was fenced before fencing existed, so `0`/`null` is the exact backfill, not
a guess. Both reset with the slot on release (`CLEARED_SLOT_FIELDS`).

Schema 1.5.0: `SchedState` gains `consecutive_suspect_dispatches` (number) and
`last_suspect_dispatch_unit` (string or null) — the dispatch-health pause's cross-unit
suspect-dispatch streak (#505 above). The two fields are a single fact and must agree
(`0 ⇔ null`); `validateState` rejects a state where they disagree. 1.4.0 states migrate
on load: no suspect dispatches were ever tracked under them, so `0`/`null` is the exact
backfill, not a guess.

Schema 1.8.0: `SlotEntry` gains `spawned_at` (ISO string or null — when the CURRENTLY
held unit was (re)spawned, distinct from `last_progress_at`, which later progress
signals overwrite) and `log_offset_at_spawn` (number or null — the dispatch log's byte
size at that same instant). Both feed `runs.jsonl` per-dispatch telemetry (#524): the
log is per-UNIT and opened in append mode, so a redispatch's output lands after the
prior dispatch's in the same file — `log_offset_at_spawn` is what lets the engine read
only the current dispatch's own slice rather than concatenating (claude) or
double-counting (opencode) a prior one. 1.6.0 states migrate on load, backfilling both
to `null` — an in-flight dispatch's start time and log position are unknown, not zero —
as do 1.7.0 states (#523 took 1.7.0 for the batch fields; these two landed after it).
Both reset with the slot on release (`CLEARED_SLOT_FIELDS`).

Schema 1.9.0: `SchedState` gains `last_label_poll_at` (ISO string or null — when the
engine last re-read hard-block labels, #544 below). 1.8.0 and earlier states migrate on
load, backfilling `null`: no label re-check ever ran under them, so the first tick after
the upgrade polls immediately rather than waiting out a throttle window it has no
evidence for — the exact backfill, not a guess.

## Batch dispatch (#523)

`batch-dispatch.ts`'s `runBatchTick` — called from `tick()` after the issue-level pass,
only when `batchExec`/`runBatchSuite` are both configured on `EngineDeps` — drives every
`batch:<id>` unit through:

```
ready → executing(member i/N) ⟲ → validating → reviewing → shipping
  → awaiting-merge → merged → deployed → reported → done
failure rails: executing → dissolving (a member self-reports blocked)
               validating → attributing → (fixing | evicting) → validating → dissolving
```

- **One shared worktree/branch per batch**, claimed once by a deterministic (no LLM)
  `batch-setup` step: `git branch`/`push`/`worktree add` off `base_branch`, named
  `batch/<id>-<date>`, plus a fresh `ai-dossier runstate mint` against the anchor issue.
- **Members run serially, one fresh `slot-cycle` agent at a time**, in the shared
  worktree. A member's completion signal is `phase=review status=done mode=slot` on its
  OWN issue (`slot-cycle` posts no phase of its own past `review` — ship is batch-owned);
  its commit range on the batch branch is recomputed (`git log`) after every member and
  kept on `BatchEntry.ranges` for eviction. An incremental gate (`ai-dossier cap run
  typecheck.run` / `test.focused`, when the repo has a manifest) runs after each member
  before advancing — a second, independent check that the member's self-reported "done"
  is real.
- **The batch's single slot is claimed FRESH for each live step** (a member, the tail
  agent, the report agent, a bounded fix agent) — never held across a wait. The aggregate
  suite itself runs with NO slot claimed at all (deterministic engine work, not an LLM
  step).
- **Two failure rails.** A member that never went green evicts directly (nothing to
  attribute — see the #472 section above for what "directly" skips). A red AGGREGATE
  suite (every member individually green, but integration-level conflict) routes through
  the #472 attribution/fix/evict library.
- **The tail**, after the last member: the aggregate suite runs deterministically; green
  spawns ONE bounded strong-tier agent that runs `review-issue` aggregate mode then
  `ship-issue` batch mode (rebase-merge, a `Closes` list) and parks the PR exactly like a
  detached full-cycle run; the engine's own PR watcher (a batch-granularity mirror of the
  per-issue one) accepts the merge and dispatches a cheap mechanical-tier agent for
  `report-issue`'s batch variant.
- **Scope cuts, recorded rather than discovered later:** no `git bisect` stage for an
  ambiguous aggregate failure (an unattributable red suite dissolves instead); no
  worktree-pool integration for batch-setup (cold `git worktree add` only); no per-phase
  stall/escalation ladder for batch sub-agents (a dead-without-verification agent is
  treated as blocked, not redispatched stronger).

Schema 1.7.0: `BatchEntry` gains `worktree` (absolute path of the shared batch worktree,
null until batch-setup lands), `ranges` (`MemberRange[]` — each member's commit range,
recomputed after every member completes) and `pr` (the batch PR parked on auto-merge,
persisted so a restart mid-watch still knows what to poll). 1.6.0 states migrate on load:
no batch was ever dispatched under them, so `null`/`[]`/`null` is the exact backfill, not
a guess. Config schema moves to 1.3.0: `dispatch` gains `member_prompt`,
`batch_tail_prompt` and `batch_report_prompt` (the three new agent prompt templates).

New journal events: `batch-setup-done`, `batch-setup-failed`, `member-advanced`. Member/
tail/report/fix-agent spawn, progress, completion and park events reuse the existing
unit-generic names (`assigned`/`spawned`/`unit-failed`/`external-advance`/`pr-parked`/
`merge-accepted`/`report-dispatched`/`teardown-done`/`teardown-failed`) with
`unit = batch:<id>`.

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
  type TickResult,       // what one tick did (spawned/parked/merge-accepted/stale-reconciled/
                         //   dependents-unblocked/report-dispatched/teardown/completed/
                         //   redispatched/failed/blocked, and since #544
                         //   label-cleared/label-blocked/label-check-failed)
                         //   — since #523 also carries
                         //   `batch:<id>` unit ids (issue numbers for `blocked`)
  type EngineDeps,       // inject everything the engine touches (store/journal/spawn/ground
                         //   truth/clock/repoDir/teardownExec/fencer/batchExec/runBatchSuite/
                         //   runBatchCapability — #523)
  createSpawnDeps,       // real detached-spawn process I/O
  createExecGroundTruth, // runstate/gh/git ground truth via subprocesses (injectable exec);
                         //   since #468 also gh pr view PR state + setup info from comments
  resolveDispatch,       // config → resolved command/prompt/report-prompt/tier-models/timers/
                         //   per-tier spawn specs (tiers — #527)
  buildTierCommand,      // resolved dispatch + tier + issue → argv, using that tier's OWN
                         //   command/model (#527) — what the mixed-CLI ladder spawns with
  resolveTierSpawn,      // resolved dispatch + tier + issue → { cmd, model } together (#527) —
                         //   the single call every spawn site uses so a journal entry can
                         //   never disagree with what was actually spawned
  journalCmdModelFields, // { cmd, model } → spawned/redispatched/fix-dispatched journal fields
  stallTimeoutForPhase,  // the stall allowance for the phase now in flight (#495 per-phase
                         //   map → global, hardened against a prototype-name phase)
  stallTimeoutForSlot,   // #504: that allowance, shortened to fenceTakeoverTimeoutMs while
                         //   a takeover has posted nothing (Math.min — never longer)
  takeoverInstruction,   // the TAKEOVER prompt suffix appended for gen > 0
  SUPERSESSION_CHECKPOINT_INSTRUCTION, // the check-before-implement/review/ship clause
                         //   every dispatch prompt carries
  createExecRunFencer,   // default fencer: shells `ai-dossier runstate fence --json`
  parseFenceGeneration,  // fence stdout → the installed generation (null = unfenced)
  type RunFencer,        // inject the takeover-record writer: (issue, run, phase, takeover)
  type FenceOutcome,     // {ok, gen} | {ok: false, reason} — a failure carries its cause
  FENCE_TIMEOUT_MS,      // fence subprocess timeout (60 s — two gh round trips)
  DEFAULT_PHASE_STALL_TIMEOUT_MS, // built-in per-phase stall allowances (implement: 90 min)
  buildReportPrompt,     // report-agent prompt ({issue}/{pr}/{cleanup}/{gen} substituted)
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
  appendJsonl,           // the shared mkdir+append+swallow JSONL write
  transitionIssue, transitionBatch, transitionSlot,  // typed §D transitions
  TRANSITIONS,           // the transition tables themselves (for previews)
  buildStatusReport,     // machine-readable status incl. blocked/failed sets
  validateState,         // strict persisted-state validation (1.0.0-1.8.0 files migrate)
  IllegalTransitionError, EnqueueError, CorruptStateError, LockTimeoutError,
  SchedNotFoundError,
  EngineTooOldError,     // state schema newer than installed engine — not corruption (#537)
  // #524: per-dispatch runs.jsonl telemetry (see "runs.jsonl telemetry" below)
  buildSchedRunLogEntry, // AgentRunUsage-sourced RunLogEntry for one completed dispatch
  appendSchedRunLog,     // JSONL append to ~/.dossier/runs.jsonl, gated by schedTelemetry (not cli's auditLog)
  readDispatchLog,       // read a unit's dispatch log, optionally from a byte offset
  schedRunsLogPath,      // ~/.dossier/runs.jsonl (re-export of @ai-dossier/core's runsLogPath)
  schedTelemetryEnabled, // false when the operator set schedTelemetry:false in ~/.dossier/config.json
  usageParserFor,        // claude/opencode usage-parser selection by spawned binary
  type SchedRunLogInput, // buildSchedRunLogEntry's input shape
  dispatchLogPath,       // <runsDir>/<unit>.log — shared by spawn (offset) and record (read)
  fileSizeOrZero,        // byte size of the dispatch log at spawn time, or 0
  runBatchTick,          // #523: one batch reconcile+refill pass; called by tick() after
                         //   the issue pass — loads/saves state itself, holds no lock
                         //   across the call
  type BatchDispatchDeps, // inject store/journal/groundTruth/spawnDeps/exec/runSuite/
                         //   runCapability(optional)/fsExists(optional)
  type BatchTickResult,  // spawned/completed/parked/mergeAccepted/failed (batch:<id> ids)
                         //   + blocked (issue numbers, dissolve-requeued)
  type CapOutcome,       // ok | task-failed | automation-broken | capability-unavailable
  buildMemberPrompt, buildBatchTailPrompt, buildBatchReportPrompt, // #523 prompt builders
  DEFAULT_MEMBER_PROMPT_TEMPLATE, DEFAULT_BATCH_TAIL_PROMPT_TEMPLATE,
  DEFAULT_BATCH_REPORT_PROMPT_TEMPLATE,
  isMemberComplete, isMemberBlocked, // member milestone predicates (mode=slot gated)
  isBatchTailParked,     // batch-ship awaiting-merge + pr= — the batch park signal
  isBatchPhaseDone,      // <phase> done on the anchor (batch-review/batch-report)
  batchOfUnit,           // batch:<id> → <id>; null for issue units or malformed ids
} from '@ai-dossier/sched';
```

All state functions are pure (state in, new state out — the worktree-pool pattern);
`SchedStore` is the only state-I/O boundary and every mutation runs under its lock. The
engine polls ground truth OUTSIDE the lock and mutates state under it, so a slow `gh`
call never blocks other sched commands. Almost all process I/O is injectable — the
tests spawn fake agents and stub ground truth; no LLM calls anywhere. The one exception
is `runs.jsonl` telemetry (#524): `appendSchedRunLog`/`readDispatchLog` read/write the
real filesystem directly rather than going through an injected dependency, with only
`EngineDeps.homeDir` (a path override, test-only) as a seam — see "runs.jsonl
telemetry" below.

## State layout

```
~/.dossier/sched/<project>/
├── state.json     # hot operational truth — atomic tmp+fsync+rename writes;
├── config.json    # durable intent: max_slots, stall_timeout_ms, reconcile_interval_ms,
│                  # pr_poll_interval_ms, dispatch (incl. report_prompt,
│                  # phase_stall_timeout_ms, fence_takeover_timeout_ms, tiers — #527),
│                  # auto_upgrade — #537
├── events.jsonl   # append-only event journal (the operator's flight recorder)
├── runs/          # per-unit agent output logs (issue-<n>.log)
└── .sched-lock/   # cross-process directory mutex (pid; stolen from dead holders)
```

Sched also writes OUTSIDE this per-project tree: one `runs.jsonl` entry per completed
dispatch goes to `~/.dossier/runs.jsonl` (#524) — the same global, cross-project file
`cli`'s `ai-dossier run` already appends to, read by `ai-dossier sched stats` and
`ai-dossier history` alike. See "runs.jsonl telemetry" below.

### runs.jsonl telemetry (#524)

`packages/sched/src/run-log.ts` closes a gap where scheduler-dispatched agents never
appeared in `~/.dossier/runs.jsonl` — per-issue cost could not be baselined. One entry
is appended per completed dispatch (`recordDispatchRunLog` in `engine.ts`, called from
every place a dispatch's exit is first detected: the dead-pid rail, the
external-advance rail, a stall-timeout kill, and a dependents-blocked kill), sourced
from the agent's `modelUsage` map — never blended with the top-level `usage` block,
the fix for a ~43% fabricated-saving discrepancy the two blocks were found to produce.

The dispatch log (`runs/<unit>.log`) is per-UNIT and opened in append mode
(`createSpawnDeps`), so a redispatched unit's second agent writes its output AFTER the
first's, in the SAME file — `SlotEntry.log_offset_at_spawn` (schema 1.8.0, stamped
right before every spawn) is what lets `recordDispatchRunLog` read only the current
dispatch's own slice, so a redispatch's entry is never corrupted by concatenation
(claude) or double-counted (opencode) against a prior dispatch's output.

Every dispatch log opens with a `{"type":"sched-dispatch","ts":…,"cmd":[…]}` preamble
line written at spawn, followed by a `{"type":"sched-dispatch","event":"spawned","pid":…}`
marker once the child exists — so a log is never 0 bytes for a unit that ran, each
dispatch's slice is self-describing, and a slice can be joined to its `events.jsonl`
record by pid rather than by timestamp alone. Every `@ai-dossier/core` usage parser
skips that `type`.

**Why the default dispatch command streams.** `--output-format json` buffers the entire
session and writes ONE object at process exit. The batch pilot's six 0-byte logs are
exactly the six units advanced by ground truth (`external-advance`) and killed while
still alive — the one-shot write never happened. `--output-format stream-json --verbose`
fills the log per turn, and `parseAgentUsage` sums per-turn `assistant` usage when a
dispatch was killed before its final `result` event, so an interrupted run still reports
real tokens instead of null.

**Opt-out.** Writing is gated by `schedTelemetry` in `~/.dossier/config.json` (default
**on**), read directly here because `sched` cannot depend on `cli`. This is deliberately
NOT the CLI's `auditLog`, which scopes `ai-dossier run`'s own entries: honouring it would
silently leave an opted-out operator with zero scheduler cost visibility, and ignoring it
would just as silently widen a flag whose documented scope is the audit log. A skipped
write is journaled `run-log-skipped reason=telemetry-disabled`, so a missing entry is
never indistinguishable from a lost one.

**Reading the journal when a row is blank.** An entry whose token fields are all null is
journaled `run-log-no-usage` with a `reason` — `log-unreadable`, `log-empty`, or
`no-usage-events` — so a row of dashes in `sched stats` can be explained without
re-deriving it. A successful append is journaled `run-log-recorded`; a failed one,
`run-log-failed` with the target file. Dispatches ended by `sched abandon` release the
slot without recording, so they are not costed.

- **Crash safety**: a process killed between writes leaves the previous complete state,
  never a partial file; restart resumes identically (proved by `restart.test.ts`) —
  running slots with dead pids are re-detected and verified, slots left `assigned` by a
  crash between assign and spawn are spawned, and a dispatched entry no slot holds is
  requeued.
- **Corrupt state is loud**: `load()` throws `CorruptStateError` naming the file —
  never a silent queue reset. `state.json` is deletable and rebuildable from GitHub,
  which remains the system of record. Exception: a `state.json` written by a newer
  schema than the installed engine is not corruption — `load()` throws the more specific
  `EngineTooOldError` (#537), pointing at an engine upgrade rather than at deleting real
  queue data.
- **Schema**: state/config files from #460 (schema 1.0.0), #464 (1.1.0), #468 (1.2.0),
  #472 (1.3.0), #500 (1.4.0), #505 (1.5.0), #504 (1.6.0), #523 (1.7.0) and #524 (1.8.0)
  load and migrate to 1.9.0 automatically (slot `branch`/`last_head`/`pid_start`, slot `role` (inferred from the
  unit's queue entry, with the persisted `phase` as a fallback — #500), entry
  `pr`/`cleanup`/`failure_evidence`, batch `anchor`/`branch`/`run_id`/`eviction_groups`/
  `evictions`/`fix_attempts`/`rebase_attempts`, state-level `last_pr_poll_at` backfill to
  null, state-level `consecutive_suspect_dispatches`/`last_suspect_dispatch_unit`
  backfill to `0`/`null` — #505, slot `gen`/`fenced_at` backfill to `0`/`null` — #504, and
  slot `spawned_at`/`log_offset_at_spawn` backfill to `null`/`null` — #524, and
  state-level `last_label_poll_at` backfill to `null` — #544).
- **`max_slots`** bounds live units (`assigned | running | recovering`); dependency
  edges gate readiness — an issue with an unmerged dependency, and a batch behind an
  unmerged batch, are never runnable.
- **Pause** stops new assignments only (including report-agent dispatch — #505); abandon
  routes through the typed failure rails (`evicted → requeued{full}` for batch members —
  nothing green is discarded). A pause can be manual (`sched pause`) or automatic
  (dispatch-health, #505 above); `sched resume` clears both the flag and the
  dispatch-health streak.

## Hard-block labels are re-read every tick (#544)

#507's enqueue pre-screen resolves an issue's GitHub labels in the CLI and lands the
entry as `blocked reason=label:<name>`. That screen runs once, at enqueue time — so
before #544 a decision the human resolved never reached the queue: the entry stayed
blocked forever and `sched status` kept printing a stale reason. The engine now re-reads
the labels itself, on both sides of the same check:

- A `label:<name>`-blocked entry whose label is gone returns to `queued` (`label-cleared`),
  and normal dependency gating takes it from there — a free slot can pick it up in the
  same tick.
- A **dispatchable** entry that GAINED a hard-block label moves to `blocked`
  (`label-blocked`) before the dispatch pass, so a fresh human hand-off is never
  dispatched over. An already-`dispatched` unit is left alone: a late label must not
  abandon a live agent's work.
- A blocked entry whose label CHANGED gets its reason refreshed in place.
- An unreachable read (`gh` down, auth expired) journals `label-check-failed` and decides
  NOTHING. `issueLabels` returns `undefined` for a failed read and `[]` for a verifiably
  unlabelled issue — flattening the two would dispatch over a live hand-off whenever
  GitHub is flaky.

The watch set is every label-blocked entry plus the runnable issue units a dispatch
could actually place this tick — the latter capped at `max_slots`, so the per-tick `gh`
cost tracks the SLOT count rather than the backlog, and skipped entirely while the
scheduler is paused. A tick with work re-reads every tick; a tick with nothing else to
do (no live slot, nothing runnable) re-reads at most every `label_poll_interval_ms`
(default 10 min), from the persisted `last_label_poll_at` — so an idle fleet parked on
human decisions stays cheap. The timestamp advances only when a read actually returned
something, so `sched status` never claims a check that a `gh` outage prevented.
`HARD_BLOCK_LABELS` lives in `labels.ts` and is re-exported by
`cli/src/hard-block-labels.ts`, so the enqueue screen (#507), the classify screen (#538)
and this one cannot drift apart.

The `max_slots` cap is exact while nothing is blocked (`freeCapacity <= max_slots`, and
blocking nothing preserves candidate order, so every unit dispatched below was read). On
a tick that DID block something, units outside the read window are deferred for one tick
rather than dispatched on information nobody gathered — which costs nothing in the common
case, so #525 AC5's same-tick refill is untouched whenever no label moved.

**Scope note.** Per-issue dispatch only. Batch members (`mode: 'slot'`) and batch anchors
are not re-screened — `runnableUnits` filters to `mode: 'full'`, and `runBatchTick` has
its own claim path — so a hard-block label landing on a batch member mid-wave is not
caught here; `enqueue` still refuses to enqueue an already-labelled issue as a batch
member. Nor does the screen cover a unit that becomes dispatchable INSIDE the tick's lock
(its dependency shipped this very tick, or `requeueOrphanedDispatches` returned it to the
queue) and is dispatched before the next snapshot reads it: closing that would mean
deferring every in-lock arrival by a tick, which is exactly the guarantee #525 exists to
provide. Both are narrower than the gap this section closes — before #544 nothing was
re-screened at all — but neither is closed by it.

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
   on the same cadence — no second poll pass, though each watched entry still
   costs its own `gh pr view`/`gh issue view` — for up to 7 days after the
   failure (`STALE_RECONCILE_WINDOW_MS`); past that an abandoned failure is
   left alone rather than polled forever. Once the PR shows `MERGED` with
   `mergedAt` set and the issue closed (the same three-part gate as AC1
   above), the entry flips `failed → shipped`, re-enters the normal
   teardown → report-dispatch path (items 5–6 above), and unblocks whatever
   dependents `blockTransitiveDependents` wedged on the original (now
   reversed) failure — `sched status` stops listing it under `failed`, and
   both the reconcile and the unblock are journaled as
   `stale-failure-reconciled`. A merged PR is accepted ahead of any failure
   check even while it still carries a stale `auto-merge-blocked` label
   (GitHub does not clear labels on merge) — checking the label first would
   fail, then immediately un-fail, a unit that never actually failed.

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
