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

Design: RFC-0001 *Batch Cycles* ([`rfcs/0001-batch-cycles.md`](../../rfcs/0001-batch-cycles.md))
§B/C.1/D — the §D state machines are frozen verbatim into the types below.
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
ai-dossier sched pause            # prevent every new agent process; live units keep running
ai-dossier sched resume
ai-dossier sched stop --issue 42  # terminate one agent and record it stopped (no recovery)
ai-dossier sched abandon --issue 42 --reason "operator abort"
ai-dossier sched abandon --batch b1   # dissolve; members requeue as full-cycle
ai-dossier sched stats --issues 4..9  # per-issue tokens/cost from ~/.dossier/runs.jsonl (#524)
ai-dossier sched stats --batch b1 --project owner-repo  # batch member/tail/report/fix costs from raw dispatch logs (#564)
```

Every subcommand except `stats` (without `--batch`) takes `--project <slug>` (default:
`owner-repo` of the current directory, falling back to the repo basename — fleet-cycle's
convention) and `--json`. `stats` without `--batch` reads `~/.dossier/runs.jsonl`, a
single global file, not the per-project state — it takes `--json` and `--issues` only;
see "runs.jsonl telemetry" below for the resulting cross-repo caveat (the same issue
number in two repos sums together). `stats --batch <id>` instead takes `--project` like
every other subcommand and reads that project's `~/.dossier/sched/<project>/runs/`
directory directly, reconstructing costs from the raw dispatch logs rather than
`runs.jsonl` (#564) — see "Batch members (#564)" below.

`pause` prevents every new agent process, including escalation and same-tier recovery
takeovers; it does not terminate agents that are already running. `stop --issue <n>` is the
single-command stop path: it PID-start-safely terminates that issue's live agent, releases its
slot, and records a terminal `stopped` outcome that will not recover or escalate. `abandon`
only records failure and releases the slot; it intentionally does not terminate its process.

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
   The intended arrangement (#680) is cheap open-weights for member implementation and a
   stronger model for the judgment steps that actually need it. Worked example —
   opencode/GLM for the implementing tiers, claude/opus kept for `strong`:

   ```json
   {
     "dispatch": {
       "tiers": {
         "mechanical": { "command": ["opencode", "run", "--auto", "--format", "json", "--model", "{model}"], "model": "glm-5.3-flash" },
         "mid":        { "command": ["opencode", "run", "--auto", "--format", "json", "--model", "{model}"], "model": "glm-5.3" },
         "strong":     { "model": "opus" }
       }
     }
   }
   ```

   (`strong` sets only `model`, so its command falls back to the default claude template.)
   What an engine is ACTUALLY running is always visible in two places, added in #680: the
    `Dispatch (default): …` line in `sched status` (and its `--json` `dispatch` field), and the
    `▶ sched dispatch (default): …` banner `sched start` prints once at startup — both show
   `tier=agent/model` resolved exactly as spawns resolve. Note the inverse trap: running
   the batch FROM opencode/GLM does not make it run ON opencode/GLM — without a
   `dispatch.tiers` override every tier dispatches the default claude template regardless
   of which agent CLI drove the prep, so a run intended as an open-weights arm must
   assert its dispatch config before it starts (see #592).
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
   command. The prompt instruction alone was not enough (#591): agents kept arming the
   `Monitor` tool to wait on a background command and ending their turn anyway, which the
   engine can only see as an unverified exit. Every `claude`-family command template
   (top-level `command` and each tier's own `commandTemplate`, #527) gets
   `--disallowedTools Monitor` appended automatically — set `dispatch.disallowed_tools: []`
   in `config.json` to opt out, or list your own tools to deny instead of the default
   `["Monitor"]`. Matched on the binary's basename, so an absolute or wrapper path
   (`/usr/local/bin/claude`) still gets it; never applied to a non-`claude` command or one
   that already carries the flag itself, so an `opencode` tier is unaffected. Since #685
   the same commands also get `--settings` carrying a `PreToolUse` hook that DENIES
   background execution outright: any `Bash`/`Task` call with `run_in_background` set is
   blocked at the tool layer (exit 2, the deny message fed back to the model), so the
   agent runs the command in the foreground instead — the failure mode can no longer
   occur on a `claude`-family dispatch, not merely be discouraged. The guard is
   independent of `disallowed_tools` (the `[]` opt-out removes only the flag), never
   applied to a non-`claude` command, and skipped when the template already carries its
   own `--settings` (an operator's settings file is authoritative). `opencode` tiers have
   no settings surface: there the prompt instruction plus the engine's `announced-wait`
   classification carry the load — a clean exit whose final message announces a wait on
   background work is redispatched at the SAME tier without consuming an escalation rung
   (#685), instead of burning a tier on a known-recoverable condition.
2. **Completion verification (AC2)** — an agent exiting is never proof of completion.
   On exit, the unit completes only when ground truth confirms it: the issue's latest
   runstate milestone is `report done`, or GitHub says the issue is closed — except a
   report-agent slot (`role: 'report'`), whose issue is already closed at merge: the
   closed signal is suppressed and only a `report done` milestone completes it (#500).
   An unverified exit rides the recovery ladder like a stall. A `report done` milestone
   must also postdate the slot's own `spawned_at` (±60s clock-skew tolerance, #575) — a
   re-enqueued issue's PREVIOUS run's report milestone is ignored (journaled
   `stale-milestone-ignored`, at most once per dispatch since #610) rather than instantly
   completing a freshly-spawned agent on
   its first reconcile tick; a legacy slot with no `spawned_at` degrades to the old,
   unfenced check. Batch members get the same fence on their own completion signal
   (`isMemberComplete`, `phase=review status=done` on the member-trail vocabulary — `mode=slot` or `batch=<id>`, #677).
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
   TRANSITIVE dependents (`dep-failed:<issue>`). One exception (#596): before failing
   terminally for an UNVERIFIED EXIT (never a stall — a hung agent never had the chance
   to open anything), the engine asks ground truth whether the slot's branch already
   carries an open PR the milestone trail never recorded
   (`GroundTruth.openPrForBranch` → `gh pr list --head <branch> --state open`). A
   confirmed number parks the unit instead and the watcher owns it from there. It fails
   closed: a report slot (no branch of its own), an unknown branch, an unusable payload
   or an unreachable lookup all take the terminal path — only a confirmed PR the fleet
   itself opened parks. Which of those it was is recorded on the `unit-failed` entry as
   `pr_check=none|unreachable|no-branch`, so "we checked, there was nothing" is
   distinguishable from "`gh` was down and we wrote off a unit whose PR may have been
   mergeable" — the ambiguity that stranded imboard-monorepo#3999. The timeout is **phase-aware** (#495):
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
   dependents-blocked, slot-released, suspect-dispatch, dispatch-unhealthy, dispatch-failure,
   run-log-recorded, run-log-no-usage, run-log-skipped, run-log-failed, engine-stale,
   engine-auto-upgrade-attempted, engine-auto-upgrade-failed, stale-milestone-ignored, …) is
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

   **Confirmed dispatch failures (#629)** are a SEPARATE, deterministic signal alongside
   the timing heuristic above: a dispatch result carrying `api_error_status` or
   `terminal_reason: "api_error"` (`parseDispatchApiError`, `@ai-dossier/core`) is a
   confirmed provider wall — a 429 spend/rate limit, an auth failure the provider itself
   rejected — never an agent that ran, journaled **`dispatch-failure`** with the
   provider's own status/reason/message and reset time (when supplied). Unlike
   `suspect-dispatch`, a repeat from the SAME unit COUNTS toward its own
   `consecutive_dispatch_api_errors` counter — no cross-unit correlation is needed when
   the classification is a parsed field rather than a timing inference, and the incident
   that motivated this (a batch tail respawning nine times in 33 minutes) was the SAME
   unit throughout. At the same `DISPATCH_UNHEALTHY_THRESHOLD` it reuses `setPaused`/
   `dispatch-unhealthy`. The redispatch itself does NOT escalate — same tier,
   `recoveries` unchanged, `ESCALATION_CAP` never consumed, since a spend wall is not the
   issue's fault — so once paused, BOTH the per-issue rail (`enterRecovery`/
   `reconcileRecovering`, held in `recovering` until `sched resume`) and every batch
   respawn wedge in `runBatchTick` (tail, member continuation, fix, report, and the
   `ready` → `claimAndSetup` claim — `runValidate`'s local suite run is unaffected) stop
   respawning into the wall, which previously ignored `paused` entirely. `dispatch-
   health.ts` is its own module (not `engine.ts`) specifically so it is shared by BOTH
   dispatch paths without `engine.ts` and `batch-dispatch.ts` importing each other.
   Batch dispatch logs (per-role, append-mode) are fenced to `log_offset_at_spawn`,
   stamped by each batch spawn function — a later dispatch that dies with NO result event
   at all is never misclassified against a stale `api_error` result left in the same log
   file by an earlier attempt. A verified completion/park resets the streak on the
   per-issue path; a successful member/tail/report resets it on the batch path; `sched
   resume` resets it on both.

Config schema moves to 1.4.0 (#527): `dispatch` gains `tiers` — a per-tier
`{ command?, model?, prompt? }` spawn spec. `command`/`tier_models`/`prompt` remain valid
as the shorthand and are the fallback for any field a `tiers` entry leaves unset, so a
1.3.0 config with no `tiers` at all resolves identically to before — there is no on-disk
migration, only resolution-time fallback in `resolveDispatch`.

Config schema moves to 1.6.0 (#562): `dispatch` gains `suite_command` — an explicit argv
override for the aggregate batch-suite command, the middle tier of the new resolution
 order (active `cap run test.full` manifest → `dispatch.suite_command` → a repo-detected safe
 default that never forwards extra flags through an unrecognized wrapper script). An active
 `test.full.timeout_ms` applies only to the cap run; a timeout is terminal rather than a
 retry through a guessed fallback. Also new:
the `blocked` `BatchStatus` and `batch-blocked` journal event — an unreadable suite report
blocks the batch (worktree and every member commit preserved) instead of dissolving it,
distinct from `dissolving`'s "a red suite named no offender." `blocked` is a new
persisted-field *value*, not a new field, so no `state.json` schema-version bump or
backfill is needed on load — but it is NOT downgrade-safe: an older build's
`BATCH_STATUSES` (derived from its own `BATCH_TRANSITIONS`) will reject a `state.json`
containing a `blocked` batch with "unknown batch status", bricking that project's whole
`SchedStore.load()`. Resume or abandon any blocked batch before downgrading past this
version.

Config schema moves to 1.7.0 (#563): a new top-level `dissolve_policy` key —
`{ fraction, min_evictions_before_dissolve }`, both required when the key is present —
overrides the batch dissolve threshold (default `{ fraction: 1/3,
min_evictions_before_dissolve: 1 }`, RFC-0001 §F.8's ⅓ with no additional floor). An
absent key falls back wholesale to the default; an invalid one degrades the WHOLE config
file to built-in defaults, same as every other config field (`loadConfig`'s
degrade-to-defaults contract). This release also adds the `partial` `dissolveBatch`
strategy and the `batch-preserved` journal event (see Batch failure recovery above) — both
are behavioral, not persisted-shape changes, so they carry no schema-version bump of their
own.

Config schema moves to 1.8.0 (#565): a new top-level `default_batch_priority` key
(integer) — the `BatchEntry.priority` a batch gets when created with no explicit
`batch_priority` (see Unit priority below). Absent → `DEFAULT_BATCH_PRIORITY` (10); an
invalid value degrades the whole config file to built-in defaults, same contract as every
other field.

Config schema moves to 1.9.0 (#707): `dispatch.dispatch_profiles` names complete
dispatch configurations for batch runs. A profile has the same `command`, `tier_models`,
`prompt`, and optional per-tier `tiers` overrides as `dispatch`; the batch records the
profile name at enqueue time, and every member, tail, report, and recovery agent resolves
through that profile. For example:

```json
{
  "dispatch": {
    "dispatch_profiles": {
      "claude": { "command": ["claude", "-p", "--model", "{model}"], "tier_models": { "mechanical": "haiku", "mid": "sonnet", "strong": "opus" } },
      "glm": { "command": ["opencode", "run", "-m", "{model}", "--"], "tier_models": { "mechanical": "glm-flash", "mid": "glm", "strong": "glm-strong" } }
    }
  }
}
```

Use `sched enqueue --mode slot --batch <id> --dispatch glm` to select a profile
explicitly. Without `--dispatch`, a new batch detects Claude Code from `CLAUDECODE` or a
configured agent binary in its parent process chain. Detection is convenience only: if
profiles exist and detection is inconclusive, enqueue fails and names the available
profiles rather than silently choosing the default. `--dispatch` is intentionally rejected
for full-cycle entries; no profiles means legacy dispatch behavior remains unchanged.

Host defaults live at top-level `dispatch_profiles` in `~/.dossier/config.json`.
Scheduler projects inherit those profiles even before their own config exists. A
project's `dispatch.dispatch_profiles` overrides matching names only, leaving other
host profiles available. `sched status` reports every effective profile's source as
`user` or `project`.

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
  `ground-truth-unreachable` — since #632 once per unbroken streak (carrying `since` and
  `ticks_persisted`) rather than once per tick, re-announced every 20 ticks and re-armed
  when truth recovers and fails anew, so an outage across `max_slots` units no longer
  emits one line per unit per reconcile interval. Two sites are deliberately undeduped:
  `failOrAdoptOpenPr`, which is terminal and so fires at most once per dispatch, and
  `runTeardownFor`, which is audited but not yet fixed (#636).
- **A completion milestone is fenced to its own dispatch (#575).** `isVerifiedComplete`
  (issues) and `isMemberComplete` (batch members) both accept the current dispatch's
  `SlotEntry.spawned_at` and reject a `report done` / `review done mode=slot` milestone
  that predates it (±60s clock-skew tolerance) — a re-enqueued issue or a member re-added
  to a fresh batch run must not read as instantly complete against a PREVIOUS run's
  milestone. The rejection is journaled as `stale-milestone-ignored`; `spawned_at=null`
  (a legacy slot) degrades to the old, unfenced check.

  #610: the event is emitted at most ONCE PER DISPATCH, on both rails. The decision is
  stamped on `SlotEntry.stale_milestone_ignored_for` and compared against `spawned_at`
  itself, so a redispatch's new `spawned_at` re-arms it for free — no reset at any spawn
  site. Previously it re-fired every reconcile tick for as long as the stale milestone
  stayed latest (~20 identical lines for a 40-minute unit, each forwarded to Telegram by
  `tick.sh`, burying the events an operator is actually watching for). The entry's `at`
  is the time the ENGINE made the decision and `milestone_at` is the ignored milestone's
  own timestamp — one vocabulary for both emitters (`journalStaleMilestoneIfIgnored` in
  `engine.ts`, `reconcileMemberSlot` in `batch-dispatch.ts`), so nothing reading
  `events.jsonl` has to know which rail produced a line to know what `at` means.

This applies to `issue:<n>` unit dispatch (`dispatchAssignments`). `batch:<id>` units run
through a separate pass with its own claim/reconcile logic — see
[Batch dispatch (#523)](#batch-dispatch-523) below.

### Supervised deployment (#679)

Two supported shapes, one rule: **dispatched agents must outlive the tick or engine that
spawned them.** Agents are spawned detached and unref'd precisely so they survive a sched
crash or restart (restart reconciles by pid) — any supervisor that tears down the process
tree on exit defeats that by construction. The symptom when it happens is cruelly
misleading: agents die with zero usage events, get classified `unverified-exit`, and walk
up the escalation ladder to `unverified-exit-at-strongest-tier` — a failure reason that
reads as a model-capability verdict when the strongest tier was never given a chance to
run.

**Long-running engine** — `Type=simple` user service:

```ini
# ~/.config/systemd/user/dossier-sched-<project>.service
[Unit]
Description=dossier sched engine (<project>)

[Service]
Type=simple
ExecStart=%h/.local/bin/ai-dossier sched start --project <project>
Restart=on-failure
# Kill ONLY the engine process on stop/restart. The default (control-group)
# kills every dispatched agent with it — the engine's own restart would then
# read those deaths as failed runs and escalate the units (see above).
KillMode=process

[Install]
WantedBy=default.target
```

**One-shot tick** — cron or a `Type=oneshot` unit running `sched start --once` needs the
same rule: the tick exits immediately after dispatching, so under the default
`KillMode=control-group` the control group is torn down while every freshly spawned agent
is still starting — EVERY tick kills EVERY agent it dispatched. `KillMode=process` on the
unit (or spawning each agent into its own transient scope,
`systemd-run --user --scope --collect …`) is required, not cosmetic.

Verify a deployment survives its own ticks: dispatch one unit, let the tick or engine
process that spawned it exit, and confirm the agent process is still alive 60 seconds
later (`ps -p <agent-pid>`), with `run-log-no-usage` absent from the project's
`events.jsonl` for that unit.

Note the engine's own log (redirected stdout) carries one `✓ [ts] …` line per tick even
when a tick does nothing (`nothing to do`) — a log that stops growing while
`systemctl status` still says `active (running)` means the loop died silently, which is
the failure mode #679 fixed: the engine exited cleanly after its first tick because its
inter-tick sleep handles were unref'd.

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

### Fence lifecycle: write → bind → release (#683)

A fence used to outlive its owner. A run killed abnormally (engine kill, #679's cgroup
teardown, reboot, OOM) left its fence standing, and every successor dispatched to that
issue then read the fence, correctly stepped aside to avoid duplicating the owner's work,
and was classified `unverified-exit` — escalating a tier for being polite, until
`unverified-exit-at-strongest-tier`. The fence was doing its job; the only broken part was
that it outlived the run it granted ownership to. Three records on the trail now close
that loop, and a fourth classification keeps the ladder honest:

- **Write** — unchanged (#504): `runstate fence` posts the `status=superseded` milestone
  with `gen=<n>` and `takeover=<label>`. The label comes from one helper
  (`takeoverLabelFor`), is descriptive only, and is **never matched**: ownership is
  decided by run id + generation, because slot labels rotate.
- **Bind** — right after spawning the takeover, the engine calls
  `runstate fence-bind --pid <pid> --pid-start <start>`, posting a `bound=true` record at
  the fence's own generation. The pid + `/proc` start-time pair is what lets every later
  reader (`runstate check`, `post`'s guard) tell a **live owner from a ghost** using the
  same identity rule the engine itself uses (#472: a reused pid is not the old process).
  A fence with no bind still fences — fail-closed, exactly as before #683; the bind is a
  liveness witness, never the fence itself.
- **Release** — when the engine's `exit-detected` hook sees the owning dispatch end
  (abnormally or not), it calls `runstate fence --release --gen <n>`, posting a
  `released=true` record: every fence of that run up to generation n is lifted. Release
  is best-effort (gh down → `fence-release-failed`, and the stale-on-read backstop below
  still unblocks successors). Released generations are never reused — the generation
  arithmetic keeps counting them — so a takeover of a takeover cannot collide with a
  released fence.
- **Stale on read** — the backstop for a release that was missed: an active fence whose
  bound pid is dead is STALE. `runstate check` reports the run as live (exit 0) with a
  stderr note naming the ignored fence, and `post`'s guard passes while saying why. An
  **unbound** fence never reads as stale — with no pid on record, no reader can tell a
  live owner from a ghost, so it keeps fencing.

The fence-driven abort itself is reclassified: an agent whose dispatch log carries its own
supersession-checkpoint verdict (`runstate check`'s `SUPERSEDED` output for the trail's
run id) is journalled **`deferred-to-owner`**, not `unverified-exit` — a deliberate,
correct no-op that counts as a healthy dispatch and redispatches at the **same tier
without consuming an escalation rung** (the #629 unescalated rail). The
`runstate check --comment` abort comment names the owning run, its generation, its
takeover label, its bound pid, and that pid's liveness, so a human reading the issue can
tell a live owner from a ghost. Distinct from #679: those agents died with
`run-log-no-usage` before doing anything, while a deferring agent ran, recorded, and
exited cleanly — and `KillMode=process` fixes neither the stranded fence nor the
misclassification.

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
  evictions > max(ceil(N × fraction), min_evictions_before_dissolve), or a
  revert conflict → dissolving → members requeued (`dissolve_policy`, #563)
  same threshold crossed, but the survivors' re-run suite came back green
                         → reviewing (batch preserved; only the evicted
                           members requeue — strategy=partial, #563)
  suite report unreadable, after the fallback retry when one applied
                         → blocked → validating (nothing requeued/reverted; #562)
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
   reverting merged work. Crossing the dissolve trigger no longer always dissolves (#563):
   if the re-run suite came back green for the survivors — and every evicted member's
   commits were actually found and reverted — the batch is PRESERVED instead: trimmed to
   its survivors and carried straight to `reviewing`, only the evicted members requeue. A
   red or unreadable re-run, or an evicted member whose commits were never found on the
   branch, still dissolves in full. A member already named in `batch.evictions` is never
   recorded twice (#595): `appendEvictions` (the one place either eviction rail —
   `evictMembers` here or `evictMemberDirectly`'s no-commits path in
   [Batch dispatch (#523)](#batch-dispatch-523) — appends to `evictions[]`) is a no-op
   for a repeat issue and journals `eviction-duplicate` instead; the repeat requeue is
   skipped with it, so a second call cannot overwrite the first eviction's
   `failure_evidence` or kill a live re-dispatch of that member. Since #613 the duplicate
   is a no-op for the CALLER too, not just for the append: `evictMemberDirectly` returns
   `{ dissolved, duplicate }` and, on `duplicate: true`, `evictMemberAndContinue` journals
   no `unit-failed` and does not advance the batch — record and journal share one
   lock-protected claim, so they can never disagree about which member the batch advanced
   past. **Read
   `docs/agent-traps.md` before "fixing" the dissolve rule:** the dissolve trigger has
   counted DISTINCT member ids since #572 (`evictedMemberIds`) and was never inflatable
   by a duplicate. What a duplicate did inflate is the raw `evictions[]` array itself —
   any eviction-RATE metric derived from it (RFC-0001 §E.5) and `sched status`'s eviction
   column. `buildStatusReport` de-dups on read as well (`distinctEvictions`), so a
   `state.json` persisted before this fix shows one row per member in both `sched status`
   and `sched status --json`; the stored array is left as written.
4. **Dissolve (AC3)** — `dissolveBatch` marks the batch `dissolved` and requeues every
   UNSHIPPED member: `full` (each as its own full-cycle run), `halved` (one or two fresh
   `forming` half-batches — a single remaining member yields one — entries retagged,
   eviction groups inherited where they survive the split), or `partial` (#563 — never
   marks the batch `dissolved` at all: drops the evicted members from `batch.members` and
   its `eviction_groups`/`ranges`, transitions `validating → reviewing`, and requeues
   nothing itself, since the caller's eviction loop already did; falls through to `full`
   if that would leave zero survivors, so an empty batch never ships). Shipped and
   terminal members keep their outcome; nothing green is discarded, and no git runs — the
   batch branch is simply left behind unmerged, since sched deletes nothing. Every dissolve
   decision — all three strategies — journals its policy inputs (`N=`, `evictions=`,
   `threshold=`), so it is explainable without re-deriving the formula.
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

Thirteen journal events carry the detail: `suite-failed`, `attributed`, `fix-dispatched`,
`fix-resolved`, `member-evicted`, `eviction-duplicate` (#595 — a second eviction call
named a member already in `evictions[]`; the append, the requeue, the caller's own
`unit-failed` and the batch advance are ALL no-ops — since #613 the duplicate claim is the
single gate on all four — and the attempt is journaled rather than dropped), `revert-conflict`, `batch-rebased`,
`batch-dissolved`,
`batch-preserved` (#563 — the dissolve threshold was crossed but the survivors' re-run
suite came back green, so the batch ships them instead of dissolving), `batch-blocked`
(#562 — the suite report was unreadable), `batch-split` and `milestone-post-failed`, plus
`git-failed` for any git command that returned non-zero (the injected `ExecFn` collapses
every git failure into `null`, so the command that produced one is always recorded).

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

Schema 1.10.0 (#565): `QueueEntry` gains `priority` (integer, default 0) and `BatchEntry`
gains `priority` (integer, default `DEFAULT_BATCH_PRIORITY` = 10) — see Unit priority
below. 1.9.0 and earlier states migrate on load, backfilling absent OR explicit `null` to
those same defaults: nothing before this field existed was ever weighted differently, so
the backfill is exact, not a guess.

## Unit priority (#565)

`readiness.ts`'s `runnableUnits` ranks EVERY candidate — issues and batches together — by
`priority` desc, then readiness age (`updated_at`) asc, then a numeric tiebreak (an
issue's own number, or a batch's anchor issue) asc, via the exported `compareByPriority`
comparator and its `entryRank`/`batchRank` helpers. A batch's default priority
(`DEFAULT_BATCH_PRIORITY`, 10, or the configured `default_batch_priority`) outranks a
full-cycle entry's default (0) so a ready batch is offered a free slot before a
same-readiness issue competing for it — closing the gap
`docs/reports/batch-pilot-2-execution.md` §13.4 found (an operator manually deferring
full-cycle entries by hand so a batch could claim its slot).

Applying that ordering to who actually DISPATCHES took more than sorting: `engine.ts`'s
`dispatchAssignments` (the issue-only dispatch pass) now runs `computeAssignments` as a
READ-ONLY dry run over both kinds each tick, discards the returned state, and applies
only the issue winners — reserving a free slot for a higher-priority ready batch instead
of handing it to a same-tick issue. `batch-dispatch.ts`'s own ready-batch claim loop
(which never goes through `computeAssignments`/`runnableUnits` itself) later that same
tick claims the capacity the reservation left free, sorted by the same comparator when
more than one batch is ready. The reservation is gated on the batch pass actually being
configured (`batchExec`/`runBatchSuite`) — without that gate, a `ready` batch with
nothing able to claim it would withdraw capacity from issues forever instead of one tick.

`sched enqueue --priority <n>` sets a full-cycle entry's own priority; with `--mode slot`
it instead sets the BATCH's priority — a batch-level fact like `anchor`/`run_id`,
agreement-checked on a later join (an incremental `--more-members-expected` call, or a
manifest split across `--from-manifest` calls, must never silently re-point it). `sched
reprioritize --issue <n>|--batch <id> --priority <n>` adjusts a queued unit's weight in
place — no abandon/re-enqueue round trip, which would also reset every other field
`enqueueEntries` does not accept as a re-supply — and deliberately does not bump
`updated_at` (the readiness-age tiebreak), journaling a `reprioritized` event with the
previous value instead. `sched status`'s Queue and Batches tables both show a `priority`
column; a slot-mode member's own priority is never read by the scheduler (only the BATCH
row governs assignment), so the Queue table renders `-` for it rather than a number that
looks load-bearing but is not. A batch dissolve (`recovery.ts`'s `dissolveBatch`) carries
the parent batch's priority forward onto both split halves.

## Batch dispatch (#523)

`batch-dispatch.ts`'s `runBatchTick` — called from `tick()` after the issue-level pass,
only when `batchExec`/`runBatchSuite` are both configured on `EngineDeps` — drives every
`batch:<id>` unit through:

```
ready → executing(member i/N) ⟲ → validating → reviewing → shipping
  → awaiting-merge → merged → deployed → reported → done
failure rails: executing → dissolving (a member self-reports blocked)
               validating → attributing → (fixing | evicting) → validating → dissolving
               validating → blocked (suite report unreadable, #562) → validating
               executing → blocked (gate-inconclusive:<cap>, #583) → executing
                 (`sched resume --batch <id>` re-runs the gate; nothing requeued/reverted)
```

- **One shared worktree/branch per batch**, claimed once by a deterministic (no LLM)
  `batch-setup` step, named `batch/<id>-<date>`, plus a fresh `ai-dossier runstate mint`
  against the anchor issue. Tries a pool claim first (`npx worktree-pool claim` —
  already warm by construction, `BatchEntry.pool_claimed`); on the cold `git branch`/
  `push`/`worktree add` path, batch-setup warms the worktree itself before returning
  (#561) — `cap run worktree.prepare` when the repo's manifest declares it, else
  package-manager-detected install/build (`@ai-dossier/worktree-pool`'s command
  resolution — respects the repo's `.worktree-pool.json` `project_subdir`/
  `warm_commands` even in repos that never use the pool for anything else).
  This shared tree is the batch's INTEGRATION branch: members branch off it, and
  the tail work (aggregate suite, review, ship) runs in it (#677).
- **Members run `member-cycle` serially, one fresh agent at a time — each in its OWN
  worktree** on its OWN branch `batch/<id>-m<n>-<issue>` (#677, RFC-0001 §J.3), cut off
  the integration branch, warmed, and pushed before the agent spawns; the agent never
  creates either. When the member's incremental gate passes, the scheduler LANDS the
  member's branch onto the integration branch (`git merge --ff-only` + push) and tears
  the member worktree down (pool-return or remove) before the next member prep. A
  member's completion signal is `phase=review status=done` carrying the member-trail
  vocabulary — `mode=slot` or `batch=<id>` — on its OWN issue (the member workflow
  posts no phase of its own past `review` — ship is batch-owned); its commit range on
  the integration branch is recomputed (`git log`) after every landing and kept on
  `BatchEntry.ranges` for eviction. An incremental gate (`ai-dossier cap run
  typecheck.run` / `test.focused`, when the repo has a manifest) runs after each member
  IN ITS MEMBER WORKTREE before landing — a second, independent check that the
  member's self-reported "done" is real (`resume --batch` rechecks run there too).
  Four-way outcome policy (#583, split further by #594): a `task-failed` whose
  `output_tail` carries recognizable evidence that the capability EARNED it — failing-test
  output for a `test.*` capability, compiler/build errors for the others
  (`hasEarnedFailureEvidence`) — evicts the member (same rail as a self-reported block;
  its commits never landed, so there is nothing to revert); a `task-failed` with an
  empty or framing-only capture proves nothing and joins
  `automation-broken`/`capability-unavailable` — the gate itself couldn't reach a verdict
  — on the block-the-batch path instead of silently proceeding (`gate-inconclusive:<cap>`,
  `member_gates`/`blocked_reason` on `BatchEntry`, surfaced in `sched status`; the journal
  detail names WHICH of the two branches fired). `sched resume --batch <id>` re-runs the
  gate later to resolve the block once the capability is fixed, and applies the same
  evidence bar on the recheck — a still-unevidenced `task-failed` stays blocked rather
  than evicting on a resume.
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
  per-phase stall/escalation ladder for batch sub-agents (a dead-without-verification
  agent is treated as blocked, not redispatched stronger).

Schema 1.7.0: `BatchEntry` gains `worktree` (absolute path of the shared batch worktree,
null until batch-setup lands), `ranges` (`MemberRange[]` — each member's commit range,
recomputed after every member completes) and `pr` (the batch PR parked on auto-merge,
persisted so a restart mid-watch still knows what to poll). 1.6.0 states migrate on load:
no batch was ever dispatched under them, so `null`/`[]`/`null` is the exact backfill, not
a guess. `BatchEntry` also gains `pool_claimed` (#561) — pre-#561 states carry no such
key at all, and backfill it to `false` on load (no batch was ever pool-claimed before
batch-setup had pool integration). Config schema moves to 1.3.0: `dispatch` gains
`member_prompt`, `batch_tail_prompt` and `batch_report_prompt` (the three new agent
prompt templates).

Schema 1.11.0 (#583): `BatchEntry` gains `member_gates` (most recent incremental-gate
result per member, keyed by issue number as a string — `{capability, outcome,
output_tail, at}`) and `blocked_reason` (why the batch is `blocked` — persisted so
`sched status` can show it; previously `blockBatch` only journaled/posted the reason,
never stored it on the entry, so this also retroactively covers the #562 case). 1.10.0
states migrate on load: no gate has ever produced a non-`ok` verdict, and no batch has
ever been blocked, under them, so `{}`/`null` is the exact backfill, not a guess.

Schema 1.12.0 (#610): `SlotEntry` gains `stale_milestone_ignored_for` (ISO string or
null — the `spawned_at` already covered by a `stale-milestone-ignored` journal entry, so
the event fires once per dispatch rather than once per reconcile tick). Held as the
timestamp rather than a boolean: a fresh dispatch stamps a NEW `spawned_at`, so the
marker goes stale automatically and needs no explicit reset at any spawn site. 1.11.0
states migrate on load, backfilling `null` — nothing was ever recorded per-dispatch
under the old once-per-tick behavior, so null is exact, not a guess. Resets with the
slot on release (`CLEARED_SLOT_FIELDS`).

Schema 1.13.0 (#630): `BatchEntry` gains `pr_watch_failed_reason` (the reason already
journalled for the batch's current `pr-watch-failed` streak, null when the watch is
healthy), `pr_watch_failed_since` (ISO, when the streak began) and
`pr_watch_failed_ticks` (ticks the streak has persisted, silent ones included) — so
`pr-watch-failed` fires once per distinct condition rather than once per reconcile tick,
re-announcing every `JOURNAL_DEDUP_REANNOUNCE_TICKS` (20) ticks. 1.12.0 states migrate on
load, backfilling `null`/`null`/`0` — no dedup marker was ever recorded under the old
once-per-tick behavior, so it is exact, not a guess. Cleared whenever the batch leaves
`awaiting-merge` (`CLEARED_PR_WATCH_FIELDS`), since the marker is scoped to one
awaiting-merge stretch and a batch can return to that status on the same id via
rebase-and-reship.

Schema 1.14.0 (#632): `QueueEntry` gains `ground_truth_unreachable_since`/`_ticks` and
`pr_watch_waiting_since`/`_ticks` — the same dedup scoped to the issue rather than the
batch, because these sites span slot-held, parked and stale-failed units alike and
`QueueEntry` is the one record every unit has either way. 1.13.0 and earlier states
migrate on load, backfilling `null`/`0` — exact, not a guess. Reset on every requeue
(`CLEARED_ENTRY_DEDUP_MARKERS`, applied by `requeueMember`,
`requeueOrphanedDispatches` and the label-cleared path): a requeue is a fresh attempt,
and a streak from the previous run must not silence this one's first occurrence. Written
with `touchUpdatedAt: false` — `QueueEntry.updated_at` is load-bearing for
`isStaleFailedPark`'s 7-day window, `status.ts`'s "parked since" and `readiness.ts`'s
tiebreak, and a silent dedup tick must not reset them. `patchBatch` takes the same flag
for the same reason on the batch rail.
Schema 1.13.0 (#629): `SchedState` gains `consecutive_dispatch_api_errors` (number) and
`dispatch_pause_reset_at` (string or null) — the confirmed-dispatch-failure streak and
the provider's own reset time. Unlike the #505 suspect-dispatch pair these are NOT a
single fact: a provider that reports no reset time leaves `dispatch_pause_reset_at`
null while the counter is nonzero (`validateState` only enforces the reverse — a reset
time can never outlive a streak that has already cleared to zero). 1.12.0 states
migrate on load, backfilling `0`/`null` — no confirmed dispatch failures were ever
tracked under them, so those values are exact, not a guess.
Schema 1.16.0 (#682): `SlotEntry` gains `progress_milestone_for` (the milestone key
`` `${run}:${phase}/${status}` `` already covered by a milestone-driven `progress`
entry), `progress_milestone_since` (ISO, when the streak began) and
`progress_milestone_ticks` (ticks the streak has persisted, silent ones included) —
the #630/#632 dedup idiom scoped to the slot rail. A milestone-driven `progress`
entry journals once per distinct milestone: a NEW milestone — different
phase/status, or the same one re-reached under a NEW run id (a resumed or
redispatched run legitimately re-reaching `setup/done`) — always journals, while an
unchanged one stays silent and re-announces only every
`JOURNAL_DEDUP_REANNOUNCE_TICKS` (20) ticks, carrying `since` + `ticks_persisted` so
"still at implement/done after 40 min" is legible from one line. The same fix
attributes the entry to its real trigger: a push-driven signal now reads
`detail: "new pushed commit"` with the head sha — previously it was labelled with
the unchanged milestone whenever one existed, which is how ~29% of all `progress`
entries came to read as repeats of a milestone that had not moved. 1.15.0 states
migrate on load, backfilling `null`/`null`/`0` — no progress streak was ever
recorded under the old behavior, so those values are exact, not a guess. Cleared
with the slot on release (`CLEARED_SLOT_FIELDS`), so the next unit assigned there
journals its first milestone fresh.

Schema 1.18.0 (#677): `BatchEntry` gains `member_branch` and `member_worktree` (the
CURRENT member's own branch `batch/<id>-m<n>-<issue>` off the integration branch and
the worktree holding it — the `{worktree}`/`{integration_branch}` inputs the member
prompt carries, and where the incremental gate runs pre-landing) and
`member_pool_claimed` (teardown reads it to decide pool-return vs remove, mirroring
`pool_claimed` at member granularity). 1.17.0 states migrate on load, backfilling
`null`/`null`/`false` — pre-#677 members ran in the shared batch worktree, so those
values are exact, not a guess. Persisted (not re-derived) so a takeover redispatch or
a `sched resume --batch` recheck after an engine restart lands in the SAME
worktree/branch.

New journal events: `batch-setup-done`, `batch-setup-failed`, `member-advanced`,
`member-worktree-reused` (#677 — an on-disk member worktree reused by a takeover
redispatch or a crash-window re-prep; a spawn-time event, never per-tick),
`member-landed` (#677 — the member's verified branch fast-forward-landed onto the
integration branch), `landing-failed` (#677 — the mechanical landing failed; BLOCKS
the batch for an operator, like `batch-blocked`), `member-worktree-torn-down` (#677 —
the member's own worktree/branch cleaned up after it resolved) and
`stale-member-worktree` (#677 — persisted member context that does not belong to the
current member was discarded for a fresh prep),
`batch-warmup-done`, `batch-warmup-failed` (#561 — the cold-path warm step only; a pool
claim emits neither). `gate-inconclusive` (#583 — the incremental gate came back
`automation-broken`/`capability-unavailable` rather than a definite `ok`/`task-failed`;
sits alongside `batch-blocked` as the per-member analogue of the aggregate suite's
"block, don't dissolve" precedent; #594 routes an unevidenced `task-failed` here too).
`eviction-duplicate` (#595 — `evictMemberDirectly` and `evictMembers` both emit it when
asked to evict a member already in `evictions[]`; since #613 it also suppresses the caller's
`unit-failed`/`member-advanced` pair and the member advance, so the pair is emitted exactly
once per member and names the member the batch is advancing FROM) and
`member-advance-skipped` (#613 — a resolution that lost the one-shot claim on
`executing_member` and so advanced nothing; journaled rather than dropped, so a batch that
stops advancing never does so silently). Member/tail/report/fix-agent spawn, progress,
completion and park events reuse the existing unit-generic names (`assigned`/`spawned`/`unit-failed`/
`external-advance`/`pr-parked`/`merge-accepted`/`report-dispatched`/`teardown-done`/
`teardown-failed`) with `unit = batch:<id>`; the member `spawned` event also carries
`worktree` (#677) naming the member worktree the prompt was built with.

## API surface

```ts
import {
  SchedStore,            // persistence: load/save/withLock per project dir
  enqueueEntries,        // validated queue appends (cycles, dupes, mode/batch rules)
  parseManifest,         // batch-prep JSON → EnqueueInput[]
  computeAssignments,    // pure: fill idle slots with runnable units, bounded by max_slots
  runnableUnits,         // pure: which units may run right now (dep-gated), in assignment
                         //   order — priority desc → readiness age → issue/anchor (#565)
  compareByPriority,     // the priority/age/tiebreak comparator runnableUnits sorts with —
                         //   also used directly by batch-dispatch.ts's ready-batch claim loop
  entryRank, batchRank,  // PriorityRank of a QueueEntry / BatchEntry (#565)
  reprioritizeIssue,     // sched reprioritize --issue: adjust priority in place, no
  reprioritizeBatch,     //   abandon/re-enqueue round trip; refuses a terminal unit
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
  parseOpenPrListJson,   // gh pr list --head <b> --state open → the open PR we opened (#596)
  parseSetupInfo,        // gh issue view --json comments → teardown inputs
  runTeardown,           // #468 script teardown for a merged unit (pool return / worktree remove)
  isSafeWorktree,        // worktree-path containment check (CWE-22)
  TEARDOWN_TIMEOUT_MS,   // teardown subprocess timeout (120 s)
  attributeByOverlap,    // #472 pure stage-1 attribution: failing tests → members
  parseVitestJson,       // vitest --reporter=json → failing tests
  isReadableVitestReport, // #562: a parseable { testResults: [...] } document exists —
                          //   distinct from "zero failures"
  hasFailingTestEvidence, // #594: an output_tail that PROVES a suite ran and went red —
                          //   an empty/framing-only capture, or a green report, is not
                          //   a real task-failed
  hasEarnedFailureEvidence, // #594: the same bar per capability — test.* is held to
                          //   failing-test output, others may prove it with compiler errors
  parseBoundaryCommits,  // git log → issue-boundary commits via the (#N) trailer
  memberRanges,          // boundary commits → each member's commit list
  runAttributionBisect,  // stage-2: real git bisect over the failing tests only
  beginAttribution,      // validating → attributing (overlap, then bisect if needed)
  beginFixAttempt,       // the ONE bounded mid-tier fix dispatch instruction
  resolveFixAttempt,     // record its outcome, back to validating
  evictMembers,          // revert + requeue with evidence + suite re-run + dissolve check
  checkDissolveTrigger,  // pure: evicted > max(ceil(N × fraction), min floor) — dissolve_policy, #563
  dissolveBatch,         // full | halved | partial (#563); preserves everything green
  blockBatch,            // #562: unreadable suite report → blocked; no requeue, no revert
  type BlockOptions,     // { reason, milestonePhase? } for blockBatch
  handlePrConflict,      // rebase + re-ship once, then dissolve into halves
  createExecMilestonePoster, // batch milestones via `ai-dossier runstate post`
  expandEvictionGroups,  // members that must revert together (§E.4 eviction groups)
  requeueMember,         // the one requeue path abandon/evict/dissolve all take
  appendEvictions,       // #595: the one evictions[] append — skips an issue already
                         //   recorded, returns the duplicates so the caller can journal
  distinctEvictions,     // #595 read side: one record per member for a legacy state.json
  duplicateEvictionDetail, // the one eviction-duplicate wording, shared by both rails
  isPreservedMember,     // the single definition of "already green"
  createBatch,           // the single BatchEntry constructor
  type RecoveryDeps,     // inject exec/repoDir/journal/milestone-poster/suite-runner/clock
  type SuiteRunner,      // re-runs the aggregate suite after a revert or rebase
  type BatchMilestonePoster, // batch-milestone sink (createExecMilestonePoster is default)
  Journal,               // append-only events.jsonl
  appendJsonl,           // the shared mkdir+append+swallow JSONL write
  transitionIssue, transitionBatch, transitionSlot,  // typed §D transitions
  patchSlot, patchBatch, // §D.3 METADATA patches without a status change — `id`/`status`
                         //   excluded (and stripped at runtime): status goes through the
                         //   typed rails above. patchSlot moved out of engine.ts in #610
                         //   so batch-dispatch.ts can share it.
  TRANSITIONS,           // the transition tables themselves (for previews)
  buildStatusReport,     // machine-readable status incl. blocked/failed sets
  validateState,         // strict persisted-state validation (1.0.0-1.13.0 files migrate)
  DEFAULT_ISSUE_PRIORITY, DEFAULT_BATCH_PRIORITY, // priority defaults (0 / 10, #565)
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
  // #564: reconstruct a batch's dispatch costs from raw per-unit logs on
  // disk, for batches with no runs.jsonl coverage (pre-#564, or torn down)
  listBatchDispatchLogs,   // every raw dispatch log found for a batch id, parsed from its filename
  buildBatchRunLogEntries, // ...to RunLogEntry rows, same shape a live dispatch produces
  type BatchLogEntry,      // one parsed log entry (member/tail/report/fix)
  runBatchTick,          // #523: one batch reconcile+refill pass; called by tick() after
                         //   the issue pass — loads/saves state itself, holds no lock
                         //   across the call
  type BatchDispatchDeps, // inject store/journal/groundTruth/spawnDeps/exec/runSuite/
                         //   runCapability(optional, returns CapabilityGateResult)/fsExists(optional)
  type BatchTickResult,  // spawned/completed/parked/mergeAccepted/failed (batch:<id> ids)
                         //   + blocked (issue numbers, dissolve-requeued)
  type CapOutcome,       // ok | task-failed | automation-broken | capability-unavailable
  type CapabilityGateResult, // {outcome: CapOutcome, outputTail?, reason?} — runCapability's return shape (#583)
  resumeBlockedGate,     // #583: sched resume --batch <id> — re-run the gate that blocked a batch
  buildMemberPrompt, buildBatchTailPrompt, buildBatchReportPrompt, // #523 prompt builders (#677: member carries {issue}/{batch}/{worktree}/{integration_branch})
  memberBranchFor, // #677: the member branch name, `batch/<id>-m<n>-<issue>` — one definition, every recovery surface derives from it
  DEFAULT_MEMBER_PROMPT_TEMPLATE, DEFAULT_BATCH_TAIL_PROMPT_TEMPLATE,
  DEFAULT_BATCH_REPORT_PROMPT_TEMPLATE,
  isMemberComplete, isMemberBlocked, // member milestone predicates (member-trail gated: mode=slot or batch=<id>, #677)
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
│                  # phase_stall_timeout_ms, fence_takeover_timeout_ms, tiers — #527,
│                  # suite_command — #562, disallowed_tools — #591), auto_upgrade — #537,
│                  # dissolve_policy — #563
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
`recordDispatchRunLog`/`recordMemberRunLog` also return the last tool the dispatch called
(`parseLastToolUse`, `@ai-dossier/core`, #591), when the log yielded one — the exit itself
attributes to a concrete cause (e.g. `Monitor`) without opening the transcript. It rides the
non-terminal `verify-incomplete` event on every unverified exit and, once the escalation
ladder is exhausted, the terminal `unit-failed` (`agent-exited-unverified` /
`unverified-exit-at-strongest-tier`) as `last_tool`; a stall-timeout kill carries it too. Only
the dead-pid detection rail and the stall kill RECORD a fresh log slice (a `runs.jsonl`
entry) in the same tick — `recordDispatchRunLog` is once-per-dispatch and refuses to
append a second entry over the same slice. Since #620 a slot already `exited`/`verifying`
when reconciled again still ATTRIBUTES one: `readDispatchSignalsForSlot` re-parses the
same static slice (since #629, for the last-tool-call AND API-error-classification
signals together — see the dispatch-health section above), writing nothing, so it
carries no exactly-once constraint. That matters because the verify decision lands on a LATER tick than the
dead-pid detection whenever ground truth was unreachable in between — previously the
tool name was simply lost on exactly the runs hardest to diagnose. The read is deferred
behind a thunk so only the tick that reaches the unverified-exit decision pays for it,
never the ticks that return early on an outage.

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
slot without recording, so they are not costed. (`finalizeRunLogEntry` in `run-log.ts`
is the single implementation of this journal-then-append tail, shared by
`recordDispatchRunLog` here and batch dispatch's `recordMemberRunLog` below — #564.)

**Batch members (#564).** `batch-dispatch.ts` spawns members/tail/report/fix agents
directly (`deps.spawnDeps.spawn()`), bypassing `recordDispatchRunLog` above entirely —
`runs.jsonl` had zero coverage for batches even after #524/#531 shipped the per-issue
capture. `recordMemberRunLog` (`batch-dispatch.ts`) closes that gap for MEMBER
dispatches, attributed to the same `issue:<n>` unit scheme ordinary dispatches use, so a
member's cost shows up in the default `sched stats` view with no new read-side logic.
Tail/report/fix agents still never write to `runs.jsonl` (wiring that in needs each of
their spawn functions to stamp `SlotEntry.spawned_at` first, same as the original
member bug); `sched stats --batch <id>` (`packages/sched/src/batch-stats.ts`) instead
recovers their cost — and any historical batch's, predating #564 or already torn down —
by reading the raw dispatch logs on disk directly, the same recovery a human previously
 did by hand (`docs/reports/batch-pilot-2-execution.md` §13). Claude-shaped and recognizable
 OpenCode logs reproduce tokens, reasoning, steps, provider, and cost availability; a
 token-consuming all-zero OpenCode cost is `unpriced`. `Duration`/`Tier` are always `-` for a `--batch`-reconstructed row (a raw log
carries neither the dispatch's spawn time nor its tier) — a structural limit of
after-the-fact recovery, not a missing-data bug.

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
  load and migrate to 1.14.0 automatically (slot `branch`/`last_head`/`pid_start`, slot `role` (inferred from the
  load and migrate to 1.13.0 automatically (slot `branch`/`last_head`/`pid_start`, slot `role` (inferred from the
  unit's queue entry, with the persisted `phase` as a fallback — #500), entry
  `pr`/`cleanup`/`failure_evidence`, batch `anchor`/`branch`/`run_id`/`eviction_groups`/
  `evictions`/`fix_attempts`/`rebase_attempts`, state-level `last_pr_poll_at` backfill to
  null, state-level `consecutive_suspect_dispatches`/`last_suspect_dispatch_unit`
  backfill to `0`/`null` — #505, slot `gen`/`fenced_at` backfill to `0`/`null` — #504, and
  slot `spawned_at`/`log_offset_at_spawn` backfill to `null`/`null` — #524,
  state-level `last_label_poll_at` backfill to `null` — #544, entry `priority` and batch
  `member_gates`/`blocked_reason` — #565/#583, slot
  `stale_milestone_ignored_for` backfill to `null` — #610, and state-level
  `consecutive_dispatch_api_errors`/`dispatch_pause_reset_at` backfill to `0`/`null` —
  #629).
- **`max_slots`** bounds live units (`assigned | running | recovering`); dependency
  edges gate readiness — an issue with an unmerged dependency, and a batch behind an
  unmerged batch, are never runnable.
- **Pause** stops new assignments only (including report-agent dispatch — #505) and,
  since #629, every batch respawn wedge in `runBatchTick` — tail, member continuation,
  fix, report, and the `ready` → `claimAndSetup` claim, which previously ignored `paused`
  entirely (`runValidate` is excepted: a local suite run, not a dispatch) — and an
  unescalated per-issue redispatch (`enterRecovery`/`reconcileRecovering`, held in
  `recovering` until resumed). Abandon routes through the typed failure rails
  (`evicted → requeued{full}` for batch members — nothing green is discarded). A pause
  can be manual (`sched pause`) or automatic (dispatch-health, #505/#629 above); `sched
  resume` clears the flag and both dispatch-health streaks.

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
1b. **Recovery-adopted park (#596)** — a unit about to fail TERMINALLY for an
   unverified exit, whose branch ground truth reports an open PR, parks on
   that PR instead of dying as `unverified-exit-at-strongest-tier`. The
   `pr-parked` event carries `detail: "unverified-exit-recovered-open-pr"`
   and the `branch` the PR was found on, so a milestone-verified park (no
   `detail`) and a recovery-adopted one are distinguishable in
   `events.jsonl` without cross-referencing the ladder. Report slots are
   excluded — a report agent has no branch of its own.
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
in `events.jsonl` (`pr-parked` — two paths, see 1 and 1b above,
`merge-accepted`, `pr-watch-failed`,
`pr-watch-waiting`, `teardown-done`/`teardown-failed`, `report-dispatched`,
`report-failed`, `ground-truth-unreachable`, `stale-failure-reconciled`).

Since #610/#630/#632, `pr-watch-failed`, `pr-watch-waiting` and
`ground-truth-unreachable` are emitted **once per unbroken streak** of the condition, not
once per tick, re-announcing every `JOURNAL_DEDUP_REANNOUNCE_TICKS` (20) ticks. Each
entry carries `at` (the engine's decision clock), `since` (the streak's onset) and
`ticks_persisted` (ticks the streak has run, silent ones included). Read `since`, not the
tick count, for duration: 20 ticks is ~20 min on the per-reconcile sites
(`reconcile_interval_ms`, default 60 s) and ~50 min on the sites gated on the parked-PR
poll (`pr_poll_interval_ms`, default 150 s), and both are operator-tunable. A count of
these events is therefore a count of streaks and re-announcements, not of ticks.

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
