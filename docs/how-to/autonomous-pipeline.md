# Operator How-To: The Autonomous Issue Pipeline

How issues move from "queued" to "merged" on hcc2 without a human in the loop for the
common case — the scheduler, the tick cron, the Telegram channel, and the two points
where it deliberately stops and asks a human instead of guessing.

> **The pipeline is currently HALTED** (since 2026-09-03 10:42Z — owner token budget, not a
> fault). Both projects are `PAUSED` and the tick cron is uninstalled, so nothing below runs
> until someone restarts it. Read
> [`docs/reports/batch-cycles-checkpoint.md`](../reports/batch-cycles-checkpoint.md) before
> restarting — it carries the resume recipe, the open findings, and one hazard that bites an
> operator who just runs `sched resume` (see "Restarting after a halt" below).

## Concepts

- **`ai-dossier sched`** (`packages/sched/`) is the deterministic engine: a queue, worker
  slots, and typed state machines (RFC-0001 [`rfcs/0001-batch-cycles.md`](../../rfcs/0001-batch-cycles.md)).
  It never calls an LLM itself — it spawns the agent process the operator configured
  (`claude -p ...` by default) and reconciles the durable record (`ai-dossier runstate`,
  `gh`, `git`) that agent leaves behind. See [`packages/sched/README.md`](../../packages/sched/README.md)
  for the full mechanism (dispatch, verification, stall ladder, batch recovery).
- **A project** is one `~/.dossier/sched/<project>/` directory: its own `config.json`
  (slots, stall timeout, dispatch command/model per tier), `state.json` (live queue and
  slots), and `events.jsonl` (append-only journal). Two projects run on hcc2 today —
  see below.
- **The tick cron** (`~/.dossier/reset-fleet/tick.sh`, every 2 minutes) is the only thing
  that has to be running for the pipeline to make progress. It ticks every project's
  engine once, reports new events to Telegram, and watches a fixed list of tracked
  issues for closure.
- **A batch** (`batch=<id>`) groups several small issues onto one integration branch,
  giving each member its OWN worktree and branch off it (RFC-0001 §J.3, #677: the
  `member-cycle` dossier) and landing each verified member back onto the integration
  branch, paying for the full suite, PR, and review once at the end instead of
  per issue. A `full`-mode issue gets its own worktree, branch, and PR from
  `full-cycle-issue` instead.

## The two projects

| Project slug | Repo | Config |
|---|---|---|
| `imboard-ai-ai-dossier` | `imboard-ai/ai-dossier` | `max_slots=3`, `stall_timeout_ms=3600000` (1h), attached ship mode (self-merges; no auto-merge watcher) |
| `imboard-ai-imboard-monorepo` | `imboard-ai/imboard-monorepo` | `max_slots=3`, `stall_timeout_ms=10800000` (3h — larger repo, longer builds), detached ship mode (parks the PR on auto-merge; the engine's PR watcher takes it from there) |

Both configs share the same tier ladder: `mechanical` → `haiku`, `mid` → `sonnet`,
`strong` → `opus`. The engine escalates a unit one tier on a stall and dispatch can
override the command/model/prompt per tier independently (a mixed agent-CLI ladder —
see `dispatch.tiers` in the sched README), though on hcc2 today both projects use the
`claude` CLI at every tier. The dispatch prompt is the operator's own contract with the
agent: it names the workflow to fetch (`imboard-ai/git/full-cycle-issue`), the ship mode,
and repo-specific reminders (e.g. the ai-dossier repo's per-package version-bump rule for
CI). Config lives at `~/.dossier/sched/<project>/config.json` on hcc2; edit it there and
the next tick picks it up — there is no reload command.

## The tick loop

`tick.sh` does three things every 2 minutes:

1. **Engine freshness.** Compares the installed `ai-dossier` CLI version against npm
   latest and, if npm has a newer release, upgrades unconditionally — before ticking
   any project, with no mid-dispatch check. (`ai-dossier sched start --auto-upgrade`
   is the separate, safer in-engine equivalent that *does* gate on no unit being
   mid-dispatch; `tick.sh` does not pass that flag.) Either way, the engine only ever
   runs code from a version an operator has actually npm-published.
2. **Tick every project.** For each slug in `~/.dossier/reset-fleet/projects.txt`, runs
   `ai-dossier sched start --once --project <slug>` (one reconcile+refill pass: spawn
   runnable units, verify completions against ground truth, detect stalls, watch parked
   PRs, tear down merged worktrees, dispatch report agents) and posts any new
   `events.jsonl` lines to the Telegram channel.
3. **Closures.** For each `owner/repo#N` in `~/.dossier/reset-fleet/issues.txt`, checks
   whether GitHub shows it closed and — the first time it sees that — posts the closing
   PR number to Telegram. It also carries a one-shot cron arming step
   (`enqueue-report.sh`) keyed on the pilot's tracked execution issue
   (`imboard-ai/ai-dossier#526`) closing, which enqueues the 7-day regression report
   issue (`#529`) and appends it to `issues.txt`. **That trigger is superseded and must
   not be relied on**: #526 is closed and its successor is
   [`#590`](https://github.com/imboard-ai/ai-dossier/issues/590), which states that #529
   is armed **manually by the supervisor after the first batch PR merges — never on
   issue closure**. No batch PR has merged yet (see
   [`docs/reports/batch-pilot-2-execution.md`](../reports/batch-pilot-2-execution.md)
   Part IV), so #529 stays unarmed; arm it by hand with the command in the
   troubleshooting table below. When every tracked issue is
   closed, it posts a completion summary and removes its own cron line — the pipeline
   stops polling once there is nothing left to watch.

The Telegram channel (`~/.dossier/reset-fleet/telegram.env` holds the bot token and chat
id, sourced by every script here) is the one place an operator watches instead of
tailing logs — but it is a filtered, capped view, not the full journal: `fmt_events.py`
forwards only `spawned`, `stalled`, `redispatched`, `unit-failed`, and `teardown-failed`
events, at most 8 lines per tick. Every event (including `label-blocked`/`label-cleared`,
`pr-parked`, `merge-accepted`, `report-*`) is still recorded in full in each project's
`events.jsonl` — check that file directly for anything not in the whitelist above, plus
tracked-issue closures and the end-of-pipeline summary, both of which Telegram does get.

## Stall detection and escalation

Within a project, `sched start`'s reconcile tick detects a unit with no new runstate
milestone AND no new pushed commit for `stall_timeout_ms` (the per-project default
above), or a phase-specific timeout when one applies. `implement` carries a built-in
90-minute **floor** (#495) — `max(90 min, stall_timeout_ms)`, never a shorter allowance
than the project global — because it can run 1-3h on a large repo with no intermediate
signal: 90 min on `imboard-ai-ai-dossier` (1h global), 3h on `imboard-ai-imboard-monorepo`
(3h global, so the floor doesn't change it there). An explicit
`dispatch.phase_stall_timeout_ms` entry in config overrides both. A stalled unit is
killed and redispatched on the SAME issue, one tier stronger (`mechanical → mid →
strong`), reading that tier's own resolved command/model. Two escalations (or a stall at
`strong`) fails the unit and blocks anything that transitively depends on it — the
operator sees `unit-failed` in the Telegram feed (`dependents-blocked` is recorded in
`events.jsonl` but is not in the Telegram whitelist above), not a silently stuck slot.
An agent exiting is never itself proof of completion — the engine only marks a unit done when the
issue's `runstate` trail shows a terminal milestone or GitHub shows the issue closed —
so a unit that exits early without a real milestone rides the same stall ladder as one
that hangs.

## Resuming after a host reboot

Nothing sched-specific has to happen. The only durable state is:

- `~/.dossier/sched/<project>/state.json` — atomic writes, crash-safe by construction
  (a kill between writes leaves the previous complete state; a restart re-detects
  running slots by pid, including a hybrid pid-identity check so a reused pid post-reboot
  is never mistaken for the agent that used to hold it).
- The crontab entry for `tick.sh` — installed once, persists across reboots as long as
  the system's cron daemon starts on boot (it does, by default, on hcc2).

So the pipeline self-resumes on the next tick after boot. If it doesn't — check
`crontab -l` for the `tick.sh` line first (it self-removes once every tracked issue is
closed, which is correct behavior, not a bug, if that already happened) and confirm
`~/.dossier/reset-fleet/telegram.env` is still present. `tick.sh` runs with `set -u` but
not `set -e`, so a missing env file does not stop it at the `source` line — it keeps
going, ticks the first project, then dies on the first Telegram send (unbound bot
token/chat id variable). That means partial progress, not a clean stop: the first
project in `projects.txt` gets ticked but later projects and the closure/report-arming
checks never run that cycle. Neither `state.json` nor `events.jsonl` needs manual repair
after a clean reboot.

## Restarting after a halt

A **halt** is not a reboot. After a reboot the pipeline self-resumes (above); after a halt
someone paused the projects and removed the tick cron on purpose, and both have to be undone by
hand. This is the canonical procedure — the programme checkpoint links here rather than carrying
its own copy.

**Order matters: reconcile while still paused, and only then un-pause.** `paused` gates the
dispatch half only (`const dispatchable = state.paused ? [] : runnableUnits(state)`,
`packages/sched/src/engine.ts`); the reconcile half — including the dead-pid rail that frees stale
slots — runs either way. So a paused `start --once` does exactly the cleanup you want with no
chance of spawning into the slots it just freed. Un-pausing first re-arms spawning for that same
pass, and the dead-pid branch can route an already-shipped unit into recovery, i.e. redispatch a
fresh agent onto a closed issue.

```bash
# 1. Reconcile FIRST, still paused — frees stale slots, cannot spawn
for p in $(cat ~/.dossier/reset-fleet/projects.txt); do
  ai-dossier sched start --once --project "$p"
done

# 2. Read the result before un-pausing
ai-dossier sched status --project imboard-ai-ai-dossier
ai-dossier sched status --project imboard-ai-imboard-monorepo
tail -20 ~/.dossier/sched/imboard-ai-imboard-monorepo/events.jsonl

# 3. Un-pause
ai-dossier sched resume --project imboard-ai-ai-dossier
ai-dossier sched resume --project imboard-ai-imboard-monorepo

# 4. Refresh the tracked-issue list BEFORE restoring the cron (see below)
$EDITOR ~/.dossier/reset-fleet/issues.txt

# 5. Restore the tick cron — back up, eyeball the saved line, never install it twice
crontab -l > ~/.dossier/reset-fleet/crontab.bak.$(date +%s) 2>/dev/null || true
test -s ~/.dossier/reset-fleet/tick.cron.saved && cat ~/.dossier/reset-fleet/tick.cron.saved
if crontab -l 2>/dev/null | grep -qF 'reset-fleet/tick.sh'; then
  echo "tick already installed — nothing to do"
else
  (crontab -l 2>/dev/null || true; cat ~/.dossier/reset-fleet/tick.cron.saved) | crontab -
fi
crontab -l   # expect EXACTLY one tick line and one scorecard line

# 6. Prove it actually runs — installed is not the same as executing
ls -l ~/.dossier/reset-fleet/tick.sh          # the +x bit must be present
sleep 180 && tail -5 ~/.dossier/reset-fleet/tick.log
```

What each step is guarding against:

- **Step 2 — how you know the reconcile worked.** Expect `exit-detected` then `verify-complete`
  for each stale unit in `events.jsonl`, and its queue row moving `dispatched` → `done`. A slot
  still `running` means the pid is genuinely alive — identify it with
  `ps -p <pid> -o pid,lstart,args` before touching anything. If an entry instead lands in recovery
  (`verify-incomplete` / `unverified-exit`) **stop**: check whether the issue is already closed and
  shipped, and if it is, `ai-dossier sched abandon --issue <n> --project <slug>` rather than
  letting the fleet redispatch it. Never edit `state.json` to clear a slot.
- **Step 4 — the cron uninstalls itself when the tracked list is exhausted.** `tick.sh` pages
  *Pipeline COMPLETE* and runs `crontab -l | grep -v reset-fleet/tick.sh | crontab -` on the first
  tick where every ref in `issues.txt` is CLOSED. As of 2026-09-06 that list is 31 refs of which
  only `imboard-ai/ai-dossier#590` is open — so restoring the cron without refreshing the list
  first can have it vanish two minutes later, presenting exactly like a silently dead cron.
- **Step 5 — `|| true`, not `2>/dev/null`, is what saves the crontab.** Redirecting stderr does
  not change the exit status, so under `set -e` a `crontab -l` on a host with no crontab still
  aborts the subshell and installs an **empty** crontab, dropping every job. See the
  `no crontab for` row in [`docs/agent-traps.md`](../agent-traps.md). The duplicate guard matters
  too: re-running this step is the natural response to a failed attempt, and `tick.sh` has no
  lockfile, so two `*/2` lines means two ticks racing on one `state.json`.
- **Step 6 — `crontab -l` proves installed, not executing.** A rewritten script that lost its `+x`
  bit gives a valid crontab line, no error anywhere, and a log that simply stops growing — a 3.5 h
  outage here, and `tick.log` still ends in its `Permission denied` lines. The exec bit and a
  freshly-growing log are the only proof.

The state a halt left behind — which units failed and why, which fixes are still open, what to do
first — is in [`batch-cycles-checkpoint.md`](../reports/batch-cycles-checkpoint.md), not here. When
the fleet is running again, retire the HALTED banner at the top of this file and flip `State:` at
the top of the checkpoint, in the same commit as the restart.

## The two human checkpoints

The pipeline is designed to stop and hand off rather than guess, in exactly two places:

1. **`decision-pending` hand-offs.** An agent that reaches a point where the correct
   next step genuinely requires a human call (for example: a rule fires that the data
   says shouldn't be automated, or the issue turns out to need a product decision)
   posts `decision-pending` on the issue and stops — this is the agent behaving
   correctly, not failing. `sched enqueue` also pre-screens for issues already labeled
   `decision-pending` / `needs-clarification` / `epic` / `decomposed` and lands them as
   `blocked` instead of spending a slot dispatching an agent that would only rediscover
   the same block. An operator resolves the question and removes the label — the engine
   re-reads hard-block labels every tick (#544) and returns the entry to `queued`
   (`label-cleared`) by itself; no re-enqueue is needed. (Batch members and batch anchors
   are not re-screened this way — see the scope note in the sched README.)
2. **Filing Step-4 widening from a gate report.** The batch-cycles rollout (RFC-0001)
   is staged — Step 4 ("Widen": more issue classes, more concurrent batches) only
   starts once a pilot's regression window has actually elapsed clean. `tick.sh` has a
   close-triggered arming step for the 7-day report issue (`#529`), but per #590 that
   report is armed **manually** after the first batch PR merges; once the pipeline
   finishes, its completion message names the next step explicitly ("file Step-4 widening from #529's verdict"). Filing that
   Step-4 issue, reading the gate report's verdict, is a human action — see
   [`docs/reports/`](../reports/) for the gate reports #529's report will join
   (`batch-pilot.md`, `batch-pilot-2-execution.md`, `sched-parity.md`,
   `model-agnostic-fleet.md`; that directory also holds other non-gate reports).

## Runbook

Run every command from inside the target repo — `--project <slug>` only selects which
`~/.dossier/sched/<project>/` state directory to act on, it does NOT change repo
context: `start` resolves git/`gh` ground truth from the current directory regardless of
`--project`, and `enqueue` needs an explicit `--repo <owner/name>` when `--project`
targets a different repo than the one you're in (`tick.sh` always `cd`s into the target
repo first for exactly this reason). `stats` is the one exception — it has no
`--project` at all, since `~/.dossier/runs.jsonl` is a single global file, not
per-project. Most subcommands also take `--json` for machine-readable output.

| Task | Command |
|---|---|
| Enqueue issues (full-cycle) | `ai-dossier sched enqueue --issues 101,105..109 --deps 100 --tier mid` |
| Enqueue a batch (slot mode) | `ai-dossier sched enqueue --issues 540,542,543 --mode slot --batch b1` |
| Enqueue a batch with a named dispatch profile | `ai-dossier sched enqueue --issues 540,542,543 --mode slot --batch b1 --dispatch glm` |
| Enqueue a batch, more members to follow | `ai-dossier sched enqueue --issues 540,542 --mode slot --batch b1 --more-members-expected` |
| Enqueue from a batch-prep manifest | `ai-dossier sched enqueue --from-manifest batch-prep.json` |
| Check queue/slots/batches/blocked/failed | `ai-dossier sched status` |
| Stop new assignments (live units keep running) | `ai-dossier sched pause` |
| Resume assignments | `ai-dossier sched resume` |
| Fail one issue | `ai-dossier sched abandon --issue 42 --reason "operator abort"` |
| Dissolve a batch (members requeue full-cycle) | `ai-dossier sched abandon --batch b1` |
| Run the engine continuously (a human at a terminal ONLY — never inside an agent tool call) | `ai-dossier sched start` (Ctrl-C stops it; live agents keep running). An agent's bash call must not hold a foreground engine: the process dies with the call's process group the moment the call ends (`nohup` without `&` backgrounds nothing — see the trap row in [`docs/agent-traps.md`](../agent-traps.md)). Agents get engine progress from the tick cron, or run exactly one tick themselves: `ai-dossier sched start --once` |
| Run one reconcile+refill tick (what cron does) | `ai-dossier sched start --once` |
| Run one tick, self-upgrading the CLI first (gated on no mid-dispatch unit) | `ai-dossier sched start --once --auto-upgrade` |
| Per-issue token/cost totals (global, not per-project) | `ai-dossier sched stats --issues 4..9` |
| Restart after a deliberate halt | see [Restarting after a halt](#restarting-after-a-halt) — resume, reconcile, *then* cron |
| Re-arm the tick cron (if it self-removed after all-done) | `(crontab -l 2>/dev/null \|\| true; echo "*/2 * * * * $HOME/.dossier/reset-fleet/tick.sh >> $HOME/.dossier/reset-fleet/tick.log 2>&1") \| crontab -` — the `\|\| true` is what stops a missing crontab from installing an empty one |
| Re-schedule the 7-day report by hand | `ai-dossier sched enqueue --project imboard-ai-ai-dossier --repo imboard-ai/ai-dossier --issues 529 --tier strong` (what `enqueue-report.sh` does. `--repo` is required whenever you are not standing in that repo — `--project` does not change repo context. The close-triggered arming in `tick.sh` is **superseded**: always arm this by hand after the first batch PR merges — see [The tick loop](#the-tick-loop)) |
