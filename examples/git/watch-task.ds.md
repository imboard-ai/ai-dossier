---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "watch-task",
  "title": "Watch Task — Armed Watchdog on a Long-Running Task",
  "version": "1.0.0",
  "protocol_version": "1.0",
  "status": "Draft",
  "last_updated": "2026-08-26",
  "objective": "Keep an agent attached to a long-running task until a terminal state — every wait is an armed watch (blocking loop, harness monitor, or verified scheduled wakeup), with stall detection and bounded recovery, so no time is lost to waits that nothing ever wakes",
  "category": [
    "development"
  ],
  "tags": [
    "watchdog",
    "supervision",
    "polling",
    "background-agents",
    "orchestration",
    "autonomous",
    "stall-detection"
  ],
  "risk_level": "medium",
  "risk_factors": [
    "network_access"
  ],
  "requires_approval": false,
  "destructive_operations": [
    "May trigger caller-defined recovery actions when a watched task stalls (re-tasking or redispatching a background agent, dispatching a tail run)"
  ],
  "inputs": {
    "required": [
      {
        "name": "task",
        "description": "What is being watched — one line, e.g. 'full-cycle run for issue #42' or 'parked PR #431 until merged'.",
        "type": "string",
        "example": "parked PR #431 until merged"
      },
      {
        "name": "check",
        "description": "A read-only, idempotent command whose output classifies the task as success / failure / still-running, plus the classification rules. E.g. `gh pr view 431 --json state,mergedAt,mergeable` with: mergedAt non-null => success; CONFLICTING or closed-unmerged => failure; else running.",
        "type": "string",
        "example": "gh pr view 431 --json state,mergedAt,mergeable"
      }
    ],
    "optional": [
      {
        "name": "progress_signal",
        "description": "How to tell the task is alive even though not terminal — e.g. a new runstate milestone, a new pushed commit, a growing log file. Default: the check output changing between polls.",
        "type": "string",
        "default": "check output changed since last poll"
      },
      {
        "name": "poll_interval",
        "description": "Seconds between checks. Match how fast the state actually changes — coarse for CI/merge watchers (120-180s), finer only for fast-moving state.",
        "type": "number",
        "default": 120
      },
      {
        "name": "stall_timeout",
        "description": "Minutes without any progress signal before the task is declared stalled and on_stall runs.",
        "type": "number",
        "default": 30
      },
      {
        "name": "deadline",
        "description": "Minutes of total watch time before the task is declared failed regardless of apparent liveness (hung-but-chatty guard). Escalate per the caller's hand-off protocol.",
        "type": "number",
        "default": 90
      },
      {
        "name": "on_stall",
        "description": "Recovery action when stalled: probe first (read the agent's output / logs / trail), then one caller-defined recovery (nudge, re-task, or redispatch stronger). Default: probe and report to the caller.",
        "type": "string",
        "default": "probe, then report to caller"
      },
      {
        "name": "max_recoveries",
        "description": "Recovery attempts before declaring the task failed and running the failure action.",
        "type": "number",
        "default": 2
      }
    ]
  },
  "authors": [
    {
      "name": "Yuval Dimnik"
    }
  ],
  "checksum": {
    "algorithm": "sha256",
    "hash": "2dc194e5fd2c2898f959d8e663a44787a80d44259d00a2d75631cb67e6a6bd35"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "miMtR4IpUIRFLC9UdlW60woQUTEbAFKsxuQDYu3dJkclbRVXUAkufiHKLoEIpK0zldYytioDlfZ6ksbgmS/KBw==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-08-26T06:48:17.264Z",
    "covers": "frontmatter+body",
    "key_id": "imboard-ai",
    "signed_by": "Yuval Dimnik <yuval.dimnik@gmail.com>"
  }
}
---

# Watch Task — Armed Watchdog on a Long-Running Task

## Objective

Keep the supervising agent attached to a long-running task — a background agent, a parked PR, a CI run, a pool warmup — until it reaches a terminal state. This dossier exists to kill one specific, recurring failure: **the unarmed wait**. An orchestrator dispatches work, says "waiting for X", ends its turn — and nothing is scheduled to wake it. The task finishes (or hangs) and nobody ever picks it up. Hours are lost to a wait that no clock was attached to.

## The Iron Rule

**A wait is legitimate only while it is armed.** At every moment between "task dispatched" and "task terminal", exactly one of these must be true:

1. You are **inside a blocking wait** — a monitor/wait tool call or a bounded polling loop running as a single command — that will return control to you when the condition resolves or the timeout fires.
2. The harness will **provably re-invoke you** when the task completes (e.g. background task completion notifications) — AND you have still armed a fallback timer for the hang case, because a hung task never emits a completion event.
3. A **scheduled wakeup exists and you verified it was accepted** (harness scheduler/loop primitive, cron, `at`) that will re-run this watch.

"I'll check on it later", a poll interval written in prose with nothing executing it, or ending the turn right after dispatch — none of these are armed. If none of 1–3 holds, you are not waiting; you have abandoned the task.

## Choose the Wait Mechanism

Work down this ladder; take the first rung the current harness supports. Combine rungs freely (notification for the happy path + timer for the hang path is the strongest pairing).

1. **Completion notification + fallback timer.** If the harness re-invokes you when a background task exits (Claude Code background agents/commands do), rely on it for completion — but a hang never exits, so ALSO arm a timer at `stall_timeout` via rung 2, 3, or 4. The notification alone is NOT an armed watch.
2. **Blocking monitor/wait tool.** If the harness has a wait-until-condition tool (e.g. a Monitor tool taking a check command and timeout), use it with `check` and `stall_timeout`. When it returns, run the loop body below and re-arm.
3. **Bounded blocking poll loop, one command.** Run the whole wait as a SINGLE foreground command that only returns on resolution or timeout:
   ```bash
   timeout <stall_timeout_secs> bash -c \
     'while :; do out=$(<check>); <classify: success => exit 0; failure => exit 2>; sleep <poll_interval>; done'
   # exit 0 = success, 2 = failure, 124 = timeout => run the stall path
   ```
   If the harness blocks sleeping/long-running foreground commands, chunk it (e.g. 5-minute bounded loops back-to-back, never ending the turn between chunks) or fall back to rung 2 or 4.
4. **Scheduled wakeup.** For waits too long to hold a session open (multi-hour CI, external humans), schedule a wakeup that re-runs this watch — a harness loop/schedule primitive, or `cron`/`at` invoking the CLI. **Verify the schedule was actually created** (list it back) before ending the turn; an unverified schedule is an unarmed wait.

## The Watch Loop

Each time the watch wakes (poll tick, monitor return, notification, scheduled wakeup):

1. Run `check` and classify: **success**, **failure**, or **running**.
2. **Success** → perform the caller's success action (e.g. dispatch the tail run, advance the wave), report, and end the watch.
3. **Failure** → perform the caller's failure action (e.g. mark failed, block dependents, hand off), report, and end the watch.
4. **Running, with a fresh `progress_signal`** → reset the stall clock, re-arm (ladder above), continue.
5. **Running, no progress for ≥ `stall_timeout`** → the task is **stalled**:
   a. **Probe** — read what the task actually did last: agent output, runstate trail, pushed commits, logs. Distinguish "slow but alive" (reset clock, widen `poll_interval`, continue) from "wedged".
   b. **Recover** — if wedged, run `on_stall` (nudge the agent, re-task it, or redispatch per the caller's escalation ladder). Count it. Reset the stall clock and re-arm.
   c. **Cap** — after `max_recoveries` recoveries, stop recovering: declare the task **failed**, run the failure action, and escalate per the caller's hand-off protocol with everything the probes found.
6. **`deadline` exceeded** → treat as failed regardless of liveness signals; escalate as in 5c. A task that is "making progress" for 90 minutes on a 10-minute job is a hang with a heartbeat.

**Never trust the task's own "done" signal as the terminal state.** An agent exiting, going idle, or saying "done" is a reason to run `check` NOW — it is not itself success. Only the caller-defined check classifies (fleet rule: verify `mergedAt` non-null yourself, never believe the agent).

## Ending the Watch

The watch ends in exactly one of three states, and always reports which: **success** (check confirmed), **failure** (check confirmed, or recovery cap / deadline hit — with the last probe's findings), or **handed off** (a scheduled wakeup now owns the watch — named explicitly, with proof it exists). Ending any other way — silence, "still waiting" with nothing armed — is the bug this dossier exists to prevent.

## Pitfalls

| Pitfall | Rule |
|---|---|
| The unarmed wait — "monitoring" written in prose, nothing executing it | The Iron Rule. If no blocking call, notification+timer, or verified schedule is live, you are not monitoring anything. |
| Trusting agent exit / idle / "done" as success | It only triggers a check. The check output is the sole classifier. |
| Completion notification treated as sufficient | It covers completion, not hangs. Always pair with a timer. |
| Scheduled wakeup assumed created | Verify by listing it back before ending the turn. |
| Poll interval mismatched to the state's rate of change | ~8-min CI deserves one ~2-3 min cadence, not 10s hammering (API rate limits) — and not 30 min (lost time on a 2-min state change). |
| Stall clock measured from dispatch instead of last progress | A long healthy task would false-trip; a task that died right after a burst would trip late. Clock from the last `progress_signal`. |
| Check command with side effects | The check runs dozens of times; it must be read-only and idempotent. Recovery actions are separate and counted. |
| Recovering forever | `max_recoveries`, then fail + escalate. A watchdog that endlessly re-kicks a wedged task is its own kind of lost time. |
| Babysitting an owned wait | If a server-side watcher owns the merge, watch the terminal condition (mergedAt) at a coarse interval — do not re-implement its job by polling CI checks. |

## Validation

- [ ] At no point between dispatch and terminal state was the watch unarmed (Iron Rule 1–3 held continuously)
- [ ] Check command read-only and idempotent; classification rules stated before the watch began
- [ ] Completion notifications, where used, were paired with a fallback timer
- [ ] Scheduled wakeups, where used, were verified to exist before the turn ended
- [ ] Stall clock ran on progress signals, not on elapsed-since-dispatch
- [ ] Stalls probed before recovering; recoveries counted and capped at `max_recoveries`
- [ ] `deadline` enforced even on an apparently-live task
- [ ] Watch ended in an explicit reported state: success, failure, or handed-off-with-proof

## Relationship to Other Dossiers

- **Used by**: `imboard-ai/git/fleet-cycle` (supervising dispatched runs and parked PRs), `imboard-ai/git/full-cycle-issue` (confirming the watcher's merge, Phase 5).
- **Generic by design**: nothing here is git-specific — any long-running task with a read-only check fits (deploys, CI, pool warmup, external queues).
