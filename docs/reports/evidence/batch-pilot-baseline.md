# Batch pilot — baseline arm, raw evidence

Supporting data for [`../batch-pilot.md`](../batch-pilot.md). Every number quoted in that report is
derived here, from the sources named in §2.3 of it. Nothing in this file is estimated.

- **Cohort**: 11 full-cycle issues — #495, #496, #497, #499, #500, #501, #502, #503, #505, #506,
  #507 — dispatched by `ai-dossier sched` on host `hcc2`. (#504 was assigned on the same engine at
  14:22:04Z but was still in flight at snapshot time and is excluded; #498 is a PR number, not an
  issue.)
- **Window**: 2026-09-01 04:02:01Z (first `assigned`) → 14:16:23Z (last merge, PR #520)
- **Engine config**: `max_slots=3`, project `imboard-ai-ai-dossier`
- **Journal snapshot**: [`batch-pilot-sched-events.jsonl`](./batch-pilot-sched-events.jsonl)
  (197 events, copied from `~/.dossier/sched/imboard-ai-ai-dossier/events.jsonl`)

## Per-issue table

Token columns use the result record's `modelUsage` map (see "Tokens and cost" below for why).

| issue | PR | merge | slot wall-clock | agent runtime | turns | billable in | output | cost USD | CI runs | CI SHAs |
|---|---|---|---|---|---|---|---|---|---|---|
| #495 | #519 | `2e1d9fc` | 50.0 min | — | — | — | — | — | 3 | 1 |
| #496 | #509 | `b5fc2a9` | 30.0 min | — | — | — | — | — | 2 | 1 |
| #497 | #514 | `ea62831` | — | — | — | — | — | — | 2 | 1 |
| #499 | #516 | `fa52c35` | 205.5 min | — | — | — | — | — | 3 | 1 |
| #500 | #510 | `3e5a394` | 52.0 min | 23.4 min | 149 | 92,433,060 | 252,309 | $29.62 | 5 | 2 |
| #501 | #518 | `7a034f0` | 62.0 min | — | — | — | — | — | 3 | 1 |
| #502 | #515 | `7ec8b81` | 35.5 min | 14.3 min | 56 | 26,512,276 | 100,217 | $7.94 | 2 | 1 |
| #503 | #520 | `9c8ccb7` | 36.0 min | 15.5 min | 67 | 38,315,103 | 126,388 | $12.52 | 2 | 1 |
| #505 | #512 | `e61d24b` | 60.0 min | — | — | — | — | — | 3 | 1 |
| #506 | #517 | `35f7d37` | 22.0 min | 10.1 min | 41 | 16,767,843 | 61,090 | $6.24 | 2 | 1 |
| #507 | #513 | `e67c1bf` | 67.2 min | 24.5 min | 100 | 61,500,382 | 265,407 | $23.68 | 3 | 1 |

`—` = the source carries no record, not a zero. See coverage notes below. `turns` is the main
thread's `num_turns` and does not include subagent turns.

## Derivations

### Slot wall-clock (n = 10 of 11)

From the journal: `assigned` → the first subsequent `verify-complete` or `exit-detected` for the
same issue, else the next `assigned` on the same slot (slot handoff is the observable release).

| statistic | all (n=10) | excluding #499 (n=9) |
|---|---|---|
| median | 51.0 min | 50.0 min |
| mean | 62.0 min | 46.1 min |
| min | 22.0 min (#506) | 22.0 min |
| max | 205.5 min (#499) | 67.2 min (#507) |

The n=10 median is the mean of the 5th and 6th of the sorted values
(22.0, 30.0, 35.5, 36.0, **50.0, 52.0**, 60.0, 62.0, 67.2, 205.5) = 51.0.

#497 has an `assigned` on slot 3 with no terminating event in the snapshot — its slot was never
handed off inside the window, so no span is derivable. #499's 205.5 min is not a runtime: it is a
leaked slot (see "Failure and recovery events" below).

### Makespan, throughput, and why both are floors

- First cohort assignment 04:02:01Z → last cohort merge 14:16:23Z = **10.24 h**
- 11 issues / 10.24 h = **1.07 issues/h** at `max_slots = 3`

Two facts from the journal mean this is a floor rather than a three-slot rate:

- **First assignment per slot**: slot 1 at 04:02:01Z (#496), slot 2 at 10:56:37Z (#499), slot 3 at
  10:56:37Z (#497). The first 6.9 h ran effectively single-slot.
- **One engine gap > 30 min**: `verify-complete #507` 07:31:17Z → `assigned #502` 10:56:37Z =
  **205.3 min** with zero journal events — 33% of the makespan, no slots occupied.

### Tokens and cost (n = 5 of 11)

Source: the scheduler's per-agent logs `~/.dossier/sched/imboard-ai-ai-dossier/runs/issue-<n>.log`
— the claude `-p --output-format json` `type: "result"` record.

**Which accounting.** The record carries two. The top-level `usage` block covers the **main thread
only**; the `modelUsage` map covers every model call the run made, subagents included. Only
`modelUsage` reconciles with `total_cost_usd` — verified to the cent on all five issues. Because
full-cycle's review phase is a multi-agent fan-out, the difference is large:

| accounting | billable input | output | reconciles with cost |
|---|---|---|---|
| top-level `usage` | 134,335,521 | 214,221 | no |
| `modelUsage` | **235,528,664** | **805,411** | **yes (all 5)** |

`billable input` = `inputTokens + cacheCreationInputTokens + cacheReadInputTokens`, summed across
the `modelUsage` map.

| statistic | total | mean per issue |
|---|---|---|
| billable input tokens | 235,528,664 | 47,105,733 |
| — of which cache-read | 232,077,741 (98.5%) | 46,415,548 |
| — fresh input (uncached) | 3,450,923 | 690,185 |
| output tokens | 805,411 | 161,082 |
| cost | $80.01 | **$16.00** |
| main-thread turns | 413 | 82.6 |
| agent runtime | — | 17.6 min |

The $80.01 total is the sum of the unrounded per-issue costs; the per-issue column as displayed
(rounded to cents) sums to $80.00.

**Coverage: 5 of 11.** The logs for #495, #496, #497, #499, #501 and #505 are 0 bytes. The five
with data (#500, #502, #503, #506, #507) are the arm; no value is extrapolated to the other six.
All five ran the `claude-sonnet-5` → `claude-opus-5[1m]` escalation ladder.

**98.5% of billable input is cache-read.** Any token-reduction claim for batching has to be stated
against this split: the lever batching pulls is re-reading shared context once per batch instead of
once per issue, which is a cache-read lever, not a fresh-input lever.

### Full CI executions (n = 11 of 11)

Source: `gh run list --repo imboard-ai/ai-dossier --branch <head> --json name,event,conclusion,headSha`,
counting `event == "pull_request"` runs only.

- **30** `pull_request` runs across 11 issues → **2.73 per issue**
- **12** distinct head SHAs carried a CI run → **1.09 per issue**
- Workflows firing per PR: `CI`, `Neon Branch Cleanup`, and `Test Examples` when `examples/` changed
- **1 failure**: #500 / PR #510 — one failed `CI` run, fixed by a second push (its 2 SHAs)

The 2.73-vs-1.09 gap is workflow count, not retries: each PR fires 2–3 distinct workflows on one
SHA. For comparing against a batch arm, **distinct SHAs (1.09)** is the CI-cycles-per-issue figure;
2.73 is CI-workflow-executions-per-issue.

### Human interventions (n = 11 of 11)

Source: the runstate trail on each issue.

| issue | milestones | phases | blocked | `decision-pending` now |
|---|---|---|---|---|
| #495 | 7 | gate→setup→plan→implement→review→ship(awaiting-merge)→ship(done) | 0 | no |
| #496 | 7 | same | 0 | no |
| #497 | 7 | same | 0 | no |
| #499 | 5 | gate→setup→plan→implement→review | 0 | no |
| #500 | 8 | full incl. report | 0 | no |
| #501 | 8 | full incl. report | 0 | no |
| #502 | 8 | full incl. report | 0 | no |
| #503 | 8 | full incl. report | 0 | no |
| #505 | 8 | full minus report (review posted twice) | 0 | no |
| #506 | 8 | full incl. report | 0 | no |
| #507 | 8 | full incl. report | 0 | no |

- **0 blocked milestones, 0 issues left carrying `decision-pending`, 11/11 closed.** Human
  interventions in the cohort: **0**.
- Tail completeness: **6 of 11** posted a `report done`. #495, #496, #497, #499 and #505 did not;
  #499 stopped after `review`. The PRs merged regardless. This is the #496/#500 tail-bug class the
  Step-1 report flagged as its conditional-GO contingency.

### Misclassification rate (no denominator)

**0 of 11** cohort issues carry a `phase=classify` runstate record. They were enqueued directly as
`mode=full` via manifest/flags, bypassing `issue-cycle-classifier`. Misclassification rate is
therefore **not computable** for this cohort — there are no classifier verdicts to score.

The only classifier verdict in evidence is #473's own (2026-08-29, `mode=full`, floor rule 9 —
unresolved dependencies), and it was correct at the time it was made.

### Regressions (7-day window)

- `git log origin/main --since=2026-09-01` → **0 commits after the cohort merged**
- `git log origin/main -i --grep=revert --grep=hotfix` over full history → **0 reverts, 0 hotfixes**
  touching the cohort. The same grep restricted to `--since=2026-08-25` returns nothing at all; over
  full history it returns two unrelated commits (`f7bba0b`, 2026-05-13; `f2668b5`, 2026-03-06),
  both long predating the window.
- Cohort regressions observed: **0**
- **Window elapsed: 0 of 7 days.** The cohort merged 2026-09-01 04:26Z–14:16Z; the report was
  written the same day. A 0-day observation cannot establish "regressions ≤ baseline".

### Failure and recovery events in the window

Three. Two recovered automatically; one did not.

1. **#500 / PR #510 — CI failure. Recovered.** One `CI` run failed on the first head SHA. The run
   pushed a fix; the second SHA went green and merged (`3e5a394`). Recovery path: the agent's own
   CI-fix loop (ship-issue Step 5), 1 attempt, no escalation.
2. **#473 — `verify-incomplete` → tier escalation. Recovered.** Journal, 2026-09-01T14:26:06Z:
   `{"event":"verify-incomplete","issue":473,"detail":"unverified-exit","observed":"milestone
   gate/blocked; closed=false"}` immediately followed by
   `{"event":"redispatched","issue":473,"tier":"strong","slot":2}`. The first #473 agent
   (`claude-sonnet-5`) exited after 4.0 min having posted `phase=gate status=blocked
   reason=scope-exceeds-autonomous-cycle`. The scheduler detected the unverified exit and
   redispatched one tier stronger. Recovery path: the stall/escalation ladder, automatic, 1
   recovery. **This is the run that produced this report.**
3. **#499 — leaked slot, 2 h 44 m. Not recovered automatically.** The full slot-2 event chain:

   ```
   10:56:37.058Z  assigned          slot 2  #499
   10:56:37.061Z  spawned           slot 2  #499
   10:58:07.341Z  progress          slot 2  milestone gate/done
   11:02:07.810Z  phase-updated     slot 2  milestone setup/done
   11:18:08.827Z  progress          slot 2  milestone implement/done
   11:28:08.711Z  progress          slot 2  milestone review/done
   11:38:06.401Z  external-advance  slot 2  issue closed
   14:22:04.780Z  assigned          slot 2  #473        <- 2 h 44 m later
   ```

   The scheduler observed `issue closed` at 11:38:06Z and did not release slot 2 for reuse; it was
   claimed only by the next dispatch at 14:22:04Z. Meanwhile slot 1 serially ran #506 (11:32Z),
   #501 (11:54Z), #495 (12:56Z) and #503 (13:46Z) — runnable work existed the entire time.
   Recovery path: **none automatic.** This accounts for the whole 205.5 min #499 wall-clock figure,
   and it is the *slots idle while runnable work exists* failure class RFC-0001 Step 1 targeted.

## Reproducing this file

```bash
# queue/slot/batch state
ai-dossier sched status --project imboard-ai-ai-dossier

# wall-clock, engine gaps, and recovery events (from the committed snapshot)
jq -c 'select(.event=="assigned" or .event=="verify-complete" or .event=="exit-detected" or .event=="external-advance")' \
  docs/reports/evidence/batch-pilot-sched-events.jsonl

# CI executions per issue
gh run list --repo imboard-ai/ai-dossier --branch <pr-head> --json name,event,conclusion,headSha

# interventions / tail completeness
gh issue view <n> --repo imboard-ai/ai-dossier --json comments   # runstate trail

# tokens and cost (machine-local, not committed — see note below)
jq 'select(.type=="result") | {model, num_turns, duration_ms, total_cost_usd, modelUsage}' \
  ~/.dossier/sched/imboard-ai-ai-dossier/runs/issue-<n>.log
```

Wall-clock and token figures come from the committed journal snapshot plus the per-agent logs,
which are machine-local (`~/.dossier/sched/imboard-ai-ai-dossier/runs/`) and not committed — they
contain full agent transcripts. The journal snapshot alone reproduces every wall-clock, makespan,
engine-gap and recovery figure above.
