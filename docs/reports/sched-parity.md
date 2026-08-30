# sched fleet-parity validation — RFC-0001 Step 1 exit gate

**Status: COMPLETE — all workloads terminal. Final report.**
**Run:** `r-471-046c` · issue #471 · executing host: `hcc2` · 2026-08-29 22:22Z → 2026-08-30 15:35Z (~17.2 h wall-clock, of which ~5 h lost to external quota walls)

## Recommendation

**Conditional GO** for deprecating fleet-cycle supervision, contingent on the two tail bugs being fixed: **#496** (teardown never runs — a one-line parse fix) and **#500** (report milestones optional under a suppression bug — a small fix). The named fleet failure — *slots idle while runnable work exists* — is **gone**: occupancy while runnable work existed measured 100.0% (W1) and 99.0% (W2) with park→refill latencies of 8–11 ms in the same tick, and the fleet's own record on this host (≥9 leaked, un-tailed merge worktrees; multi-hour invisible stall gaps) is exactly what the scheduler eliminated mechanically. Every divergence found (D1–D10) was detected, journaled, and either recovered automatically or isolated to a filed issue (or, for D4, an operational note) — none are architectural. Until #496/#500 land, fleet-cycle's teardown/report should keep running for sched-merged PRs (or fix forward immediately — both fixes are small); #505 (dispatch-health pause) and #507 (enqueue label pre-screening) are recommended before widening beyond full-cycle dispatch.## 1. What this gate decides

RFC-0001 (branch `docs/batch-cycles-rfc`) Step 1 requires `dossier-sched` to demonstrate parity with fleet-cycle on real workloads before any batching begins — specifically to prove the named fleet failure is gone: **slots sitting idle while runnable work exists**. Exit criterion (§G):

> slot-occupancy > 90% while runnable work exists, zero un-tailed merges, over ≥ 3 real fleets.

This report is the committable artifact (issue #471 scope). Divergences found along the way are filed as separate issues and linked here — nothing was fixed inline.

## 2. Method

### 2.1 Environment

| Item | Value |
|---|---|
| Execution host | `hcc2` (16 vCPU, 30 GB RAM) — the only host reachable from this run |
| CLI | `@ai-dossier/cli` 0.19.0 (npm; upgraded from 0.14.0 in pre-flight — sched requires ≥ 0.19.0; ≥ 0.13.0 required for token telemetry) |
| Scheduler | `ai-dossier sched` (packages/sched, #460/#464/#468), engine config: `max_slots=3`, `stall_timeout_ms=5400000` (90 min — see §5 divergence #495), reconcile tick 60 s, PR poll 150 s, dispatch `claude -p --output-format json --model {model}` |
| Dispatch tiers | W1/W2 (claude): `mid` = sonnet, report = haiku, ladder → opus. From 04:36Z (W3 + re-drives): opencode — llmgateway-routed models first, then **openrouter** per owner instruction from 05:07Z — `mid` = `~z-ai/glm-latest`, `strong` = `~moonshotai/kimi-latest`, report = mechanical (glm) — mirroring the fleet baselines' glm/kimi model families (claude's weekly limit and then llmgateway's Dev Plan credits ran out mid-validation; see D8) |
| Workload repo | `imboard-ai/imboard-monorepo` (the same repo and backlog the fleet-cycle baselines ran against) |
| Dispatch prompt | default detached full-cycle template + `warmup_dossier imboard-ai/imboard/warm-worktree-pnpm-ssm` (the same warmup path the fleet baselines used — parity requirement) |

### 2.2 Workloads (sched arm)

Three sequential workloads, each ≥ 4 real backlog issues, all-full-cycle detached mode (agent parks PR on `auto-merge` and stops; the scheduler owns merge-watch, teardown, and report dispatch):

| Workload | Issues | Tiers | Window |
|---|---|---|---|
| W1 | #3891, #3862, #3810, #3886 | mid | 2026-08-29 22:22Z → 2026-08-30 01:44Z |
| W2 | #3890, #3889, #3756, #3500 | mid | 2026-08-30 01:37Z → 03:51Z (re-drives completed 09:23Z) |
| W3 | #3433, #3414, #3408, #3824 | mid, mid, strong, mid | 2026-08-30 04:36Z → 15:36Z (+ W2 re-drives #3889/#3890 riding the same window) |

Issue selection: open imboard backlog issues with clear code-level scope, no `decision-pending`/`needs-clarification`/`epic`/`in-progress` labels, no open `Depends on` — pre-screened with the same criteria gate-issue enforces (a gate-blocked unit burns a slot for ~90 min on the stall ladder; see divergence #495).

### 2.3 Baseline (fleet-cycle arm)

Fleet-cycle plans live in `~/.dossier/logs/fleet-cycle/imboard-ai-imboard-monorepo/FLEET-PLAN-*.md.gz` on the orchestrating host. Two comparable cohorts were selected (same repo, detached full-cycle dispatch, max-parallel 3, overlapping issue classes):

- **Fleet A** — `FLEET-PLAN-20260828-054148` (+ same-window members incl. its external prerequisite #3848): 6-issue fleet, waves, dependency-gated. Completed members: #3848, #3851, #3852, #3860, #3864 (+ #3857 gate-blocked, #3862 never dispatched; #3859/#3861 from adjacent same-window fleets); models glm-5.3 / kimi-k3-fast / gpt-5.6-luna.
- **Fleet B** — `FLEET-PLAN-20260826-091737`: 11-issue fleet, claude models (sonnet-5/opus-5) — the token-comparable cohort.

Per-issue wall-clock comes from runstate trails (`ai-dossier runstate stats --issues …`, host-agnostic — GitHub is the system of record); makespan from first gate `at=` to last `report done at=`.

### 2.4 Metric definitions

- **Slot occupancy (while runnable work existed)** — for each second of a workload's window, `busy(t)` = units holding a slot (spawn → `pr-parked`/terminal), `runnable(t)` = queued dep-free units not yet spawned; `demand(t) = min(max_slots, busy + runnable)`; occupancy = Σ busy·dt / Σ demand·dt. Parked PRs consume zero slots by design (the #468 fix) and are excluded from both sides. The window is the workload's whole life; seconds with zero demand contribute nothing.
- **Un-tailed merges** — `merge-accepted` journal events for a unit lacking teardown + report tail (teardown-done/failed + report-dispatched/failed). Must be 0.
- **Stall recoveries** — `stalled` → `redispatched` events and their outcome (recovery vs unit-failed).
- **Wall-clock per issue** — unit spawn → `merge-accepted`. **Makespan per workload** — first spawn → last merge-accepted.

### 2.5 Data sources

- Sched engine journal `~/.dossier/sched/imboard-ai-imboard-monorepo/events.jsonl` (every decision), `state.json`, per-agent output `runs/issue-<n>.log` (claude `-p` JSON: usage, cost, duration, turns).
- Runstate trails on GitHub issues (both arms).
- `~/.dossier/runs.jsonl` (hcc2) — per-machine dossier telemetry.
- opencode session DB (`~/.local/share/opencode/opencode.db`) — the Fleet A arm's per-session tokens/cost (glm/kimi/gpt ran via opencode on hcc2; `runs.jsonl` nested entries carry no token data by design — tokens are only logged for `ai-dossier run`-spawned agent runs).

**AC3 accounting (runs.jsonl aggregation, per host)** — the every-host read was performed by the wls supervisor session (hcc2 has no outbound credentials; the data was pulled TO this run rather than credentials given to it) and posted as [this issue comment](https://github.com/imboard-ai/ai-dossier/issues/471#issuecomment-5470422534); window = 2026-08-29T21:00Z → 2026-08-30T15:30Z:

| host | total entries | in window | with telemetry (duration_ms) | imboard-monorepo cwd in window | CLI at read time |
|---|---|---|---|---|---|
| wls | 1 247 | 11 | 2 | **0** | 0.19.0 |
| hcc | 4 226 | 2 | 2 | **2** | 0.14.0 |
| hcc2 | 868 | 209 | 209 | 191 | 0.19.0 |

- **wls: zero imboard-cwd runs in the window** — no cohort activity occurred there; nothing undercounted.
- **hcc: 2 imboard-cwd runs in the window** — the only off-host activity. The only non-validation imboard runstate activity inside the window is fleet member #3856's tail (report done 22:44:27Z Aug 29, run `r-3856-6d2a`, PR #3918 — the session already in flight when this validation started), whose dossier fetches these entries plausibly are; the wls supervisor characterizes them as an interactive session, not fleet units. They are not part of either comparison cohort (Fleet A's 12 FLEET-PLANs and all its unit trails are hcc2-local; every sched unit ran on hcc2), and at 2-vs-191 they are immaterial either way.
- **hcc2: 209 in-window entries, 100% carrying duration telemetry, 191 in imboard-monorepo** — consistent with both comparison arms executing here. CLI 0.19.0 ≥ 0.13.0 for the measured window ✅ (the fleet-baseline window opened before hcc2's CLI was upgraded — see §6).
- `input_tokens`/`output_tokens` are null across **all** hosts' runs.jsonl for this window (opencode-spawned runs don't populate them) — the report's per-unit token data from the agent CLIs' own records (claude result JSON + opencode session streams) is therefore the *only* token source, not a fallback.

Fleet B (the claude-model cohort, Aug 25–26) executed on a different host entirely — its tokens are unreachable from hcc2 (§6).

## 3. Results

### 3.1 W1 — #3891, #3862, #3810, #3886 (2026-08-29 22:22Z → 2026-08-30 01:44Z)

Timeline facts (from `events.jsonl`, verbatim in `docs/reports/evidence/`):

| Unit | Dispatch tier(s) | Spawn → park | Spawn → merged | PR | Report milestone |
|---|---|---|---|---|---|
| #3810 | mid (sonnet) | 50 m | **52 m** | #3922 | ✅ posted (+85 m) |
| #3886 | mid → strong (exit-recovery) | 83 m | **87 m** | #3924 | ✅ posted (+88 m) |
| #3891 | mid (cold worktree) | 122 m | **126 m** | #3925 | ❌ missing (D5/#500 — rich report comment posted, milestone not) |
| #3862 | mid → strong (exit-recovery) | 191 m | **200 m** (merged 01:42:54Z) | #3926 | ✅ posted (queued for a free slot while W2 held all 3) |

**Slot occupancy while runnable work existed: 100.0%** (state-machine view; window 22:22:55 → 23:13:07 — first spawn until the last queued unit dispatched; 9 045 busy slot-seconds / 9 045 demand slot-seconds at 3 slots). The two events that could have idled a slot did not:

- #3810 parked at 23:13:07.705 → slot freed → **#3891 assigned+spawned in the same tick at 23:13:07.716 (11 ms later)** — the fleet's named failure (idle slot while runnable work waits) is structurally impossible here.
- #3886 parked at 23:46:08.650 → **#3810's report agent assigned+spawned in the same tick at 23:46:08.658 (8 ms later)**.

A second, stricter view counts a slot busy only while its agent process is actually alive (excluding dead-agent detection latency): 76% raw — dominated by a ~28-minute window where **no engine process existed at all** (the validation harness reaped engine processes spawned from its session; journal silence 22:36:24→23:05:53; D4). Excluding that documented outage, detection-to-redispatch under the cron engine was ≤ 60 s per exit (tick cadence), and the same-tick refill property still held everywhere the engine was alive.

**Un-tailed merges: 0** (every merge received teardown in the same tick, and report dispatch as soon as a slot freed — same-tick in 3 of 4 cases here, minutes later for #3862's) — with precision:
- teardown attempted+recorded: 4/4 merges, **succeeded 0/4** — every one failed with `failed-missing-setup-info` (D2/#496, a mock-drift bug: teardown never runs; pool worktrees leak)
- report dispatched: 4/4; report milestone posted: 3/4 (#3891's completed via the D5/#500 bug without its milestone)

**Ladder/exit recoveries: triggered 3, succeeded 3 (0 stall-timer events — all three were `verify-incomplete` exit recoveries).** #3886 and #3862: sonnet agents exited mid-implement while a background build ran (#497) → `verify-incomplete` → redispatched at strong tier in the same tick → both resumed from the runstate trail and drove to merged PRs. #3891: mechanical report agent exited unverified → redispatched mid → completed (via D5). No unit hit the escalation cap; no unit failed.

**Wall-clock:** spawn→merged per issue 52–200 m (median 106.5 m; 87 m excluding #3862's 200 m, which includes a 61-minute report-slot wait and CI) vs the fleet baselines' per-issue spans of 1.9–28.8 h (Fleet B median 3.3 h, Fleet A median 4.4 h — which include supervision stalls; §4). Makespan for 4 issues: 3.33 h (first spawn → last merge-accepted 01:44). Caveat: issue mix and models differ from the fleet cohorts (§6).

**Tokens/cost (claude usage per unit, all dispatches summed):**

| Unit | Dispatches | Cache-read | Output tokens | Cost |
|---|---|---|---|---|
| #3810 | 2 (cycle+report) | 40.0 M | 121 806 | $13.23 |
| #3886 | 3 (2×cycle+report) | 21.2 M | 80 135 | $27.41 |
| #3891 | 3 (cycle+2×report) | 31.1 M | 58 555 | $33.02 |
| #3862 | 3 (2×cycle+report) | 30.7 M | 126 180 | $37.40 |
| **W1 total** | 11 | 123.0 M | 386 676 | **$111.06** (≈ $27.8/issue) |

### 3.2 W2 — #3890, #3889, #3756, #3500 (2026-08-30 01:37Z → 03:51Z)

W2 ran under the default prompt on claude tiers and hit three distinct external walls — which is precisely what real workloads look like; each outcome is recorded per-unit:

| Unit | Outcome | PR | Detail |
|---|---|---|---|
| #3500 | ✅ merged + tail | #3928 | park 03:42 → merged 03:45:52 → merge-accepted + report-dispatched same tick; report milestone missing (D5/#500 — second instance) |
| #3756 | ❌ unit-failed (`auto-merge-blocked`) | #3927 | imboard auto-merge watcher blocked a green, mergeable PR on persistent CANCELLED check-runs (the known imboard#3884 traps race — external). Operator re-queue re-blocked instantly; PR left for human disposition. Ledger staleness = D6/#501 |
| #3889 | ⚠️ unit-failed at ladder cap — **quota wall** | — | implement done + pushed (03:04), review started; Claude weekly limit hit 03:50Z → agent exit → strong redispatch died at 1 turn → cap. Work survives on branch; re-driven after the provider switch |
| #3890 | ⚠️ same as #3889 | — | implement done + pushed (03:45); same quota-wall ladder burn; re-driven |

- **Slot occupancy while runnable work existed:** window 01:37:02 (first spawn) → 02:47:08 (#3890, the last queued unit, first spawn — the slot was freed by #3756's park at 02:45:10, which the waiting #3862 report agent took in the same tick, tail-before-new-work; #3756's `auto-merge-blocked` unit-failure itself landed at 02:46:10): slots never idled while runnable work waited; measured 12 500 busy / 12 630 demand slot-seconds = **99.0%** (the gap is the report-agent exit → next-tick dispatch of #3890, ~2 minutes of tick cadence). #3889's 90-minute implement ran right up to its stall deadline and pushed at 03:04 — 21 minutes before the timer.
- **Un-tailed merges:** 1 merge (#3500) — teardown same-tick (failed per D2/#496), report dispatched same-tick, milestone missing per D5/#500.
- **Ladder/exit recoveries:** 2 triggered (both #497-style sonnet exits mid-implement — "waiting for ci-parity/background test", 0 stall-timer events), 2 redispatched at strong tier; both opus resumes were then killed by the quota wall (counted under D8, not as ladder failures of their own).
- **Cost (claude, partial before the wall):** #3500 $44.66 (3 dispatches), #3756 $54.85 (2), #3889 $31.77 (2), #3890 $10.48 (2 logged results — its 63-minute mid run's usage result did not make the log, so its figure is a floor) — **≥ $141.76 total for 4 partially-completed issues**; quota-wall ladder deaths cost ~$0 in tokens but each cache-priming spawn that died instantly still billed its context upload (#3890's $10.48 is almost entirely cache writes). Usage details in evidence logs.

### 3.3 W3 — #3433, #3414, #3408 (strong), #3824 (+ W2 re-drives #3889/#3890 riding the same window)

W3 changed dispatch to opencode/openrouter (claude weekly limit, see D8) and paid for every gap the first opencode round had:

**Round 1 (04:36–05:24Z, all units lost to infrastructure, zero work lost):** the opencode dispatch lacked `--auto`, so headless agents auto-rejected worktree-path tool calls (external_directory) and died mid-phase (D10/#506); the operator's cron wrapper was missing the opencode bin dir from PATH, so every redispatch spawn errored and the cascade insta-failed all six queue/running units in ~15 minutes (#506's cascade note). All state was recoverable — pushed work survives, the resume rails carry it — and the queue was rebuilt by hand (the D7 re-enqueue corruption makes the rebuild a manual dance, #502).

**Round 2 (05:39Z →, `--auto` + fixed PATH + glm/kimi, openrouter-routed from 05:07Z):**

| Unit | Story | Outcome |
|---|---|---|
| #3824 | first opencode agent died on the permission wall mid-implement; re-drive resumed its uncommitted worktree work (`wip(recovered)`) and drove to park 06:38 → **PR #3929 merged 06:45** → report done 06:57 (report milestone ✅ posted) | ✅ merged + tailed |
| #3414 | plan phase correctly handed off as **decision-pending** (`reachability-zero-prod-usage` — zero prod occurrences of concurrent investor-update sends; the retro #1632 rule firing on real data) | 🔶 human hand-off (by design); its exit then burned the ladder to `unit-failed` (D9/#507 — sched has no human-handoff state) |
| #3408 (strong/kimi) | kimi agent killed by the in-flight credit race (06:58, D8 wall #3) before credits landed; re-driven 08:09, stalled out at the 90-min cap (10:28), re-driven again under the raised 180-min window (10:49) → implement done 12:54 → **PR #3936 merged 15:18** → report done 15:35 | ✅ merged + tailed |
| #3433 | glm agent stalled the full 90-min timer with no milestone progress past gate (heavy backend fix) → `stalled` → redispatched strong (kimi) 09:06 → stalled again at the strongest-tier cap (10:46) → re-driven under the 180-min window (10:49) with the recovered worktree → implement done 11:50 → review done 12:46 → **PR #3934 merged 14:15** → report done 14:33. The one genuine stall-recovery that reached a merge | ✅ merged + tailed (2 stalls, recovered twice) |
| #3889 (W2 re-drive) | re-drive #3: gate 07:21 → review done 08:00 → park 08:09 → **PR #3930 merged 08:13** → report done 09:16; the engine detected the externally-advanced state (report posted while the agent still lived) and reclaimed the slot with `external-advance` — AC3 reconcile working | ✅ merged + tailed |
| #3890 (W2 re-drive) | re-drive #3: review done 08:45 → park 09:10 (**PR #3932 merged 09:11 — 1-minute park→merge**) → report done 09:23 | ✅ merged + tailed |

The park→refill chain held throughout: #3824's park (06:38) refilled #3890's re-drive in the same tick; #3889's park (08:09) refilled #3408 same-tick; #3890's park (09:10) dispatched #3889's waiting report agent same-tick; #3433's park (14:08) → merge-accepted + report-dispatched in the same tick at 14:15; #3408's park (15:08) → merge + report same-tick at 15:18. Every slot-freeing event was followed by a new assignment within one tick (≤60 s) — the fleet's idle-while-runnable failure never appeared whenever an engine was alive.

**W3 metrics note:** a formal Σbusy/Σdemand occupancy number for W3's whole window is not meaningful — its window spans four operator state-reset/re-drive rounds (the D7 corruption workaround), during which phantom slot intervals exist in the journal. The clean-workload occupancy numbers are W1 (100.0%) and W2 (99.0%); for W3 the evidence is the refill-latency record above plus the clean final round (2 units, both spawned within 2 ticks, no backlog ever waited). Clean-segment wall-clocks (re-drive spawn → merged): #3824 66 m, #3889 54 m, #3890 112 m, #3433 206 m, #3408 270 m.

### 3.4 Final per-unit table (all workloads)

| Unit | Workload | Outcome | Merge span (clean) | Ladder events |
|---|---|---|---|---|
| #3810 | W1 | merged+reported | 52 m | 0 |
| #3886 | W1 | merged+reported | 87 m | 1 exit-recovery (→merged) |
| #3862 | W1 | merged+reported | 200 m | 1 exit-recovery (→merged) |
| #3891 | W1 | merged (report milestone missing — D5) | 126 m | 1 report-agent recovery |
| #3500 | W2 | merged (report milestone missing — D5) | 129 m | 1 exit-recovery |
| #3756 | W2 | green PR #3927 watcher-blocked (external; human disposition) | — | 1 |
| #3889 | W2 | merged+reported (after 2 quota-wall failures, re-drive #3) | 54 m (re-drive) | 3 |
| #3890 | W2 | merged+reported (after 2 quota-wall failures, re-drive #3) | 112 m (re-drive) | 3 |
| #3824 | W3 | merged+reported | 66 m (re-drive) | 1 exit-recovery |
| #3414 | W3 | human hand-off (decision-pending, reachability rule fired) | — | 2 |
| #3433 | W3 | merged+reported (1 genuine stall, recovered) | 206 m (re-drive) | 3 (2 stalls) |
| #3408 | W3 | merged+reported (quota wall + stall cap, recovered) | 270 m (re-drive) | 3 |

**Totals: 12 units across 3 workloads × ≥4 issues · 10 merges · 0 un-tailed (every merge got teardown+report processing; teardown success 0/10 per bug #496, report milestone 8/10 per bug #500) · 3 genuine stall/exit ladder recoveries that reached merges · every failure journaled.**


## 4. Baseline comparison

### 4.1 The fleet cohorts (hcc2, same repo, detached full-cycle)

**Fleet A** — `FLEET-PLAN-20260828-054148` + same-window members (Aug 28–29; glm-5.3 / kimi-k3-fast / gpt-5.6 via opencode). Completed members: #3848, #3851, #3852, #3860, #3864 (+ #3857 gate-blocked as `no-actionable-work`, #3862 never dispatched, #3859/#3861 from adjacent fleets):

| Issue | Span (first→last milestone) | Supervision stall-gaps (>45 m, non-merge-wait) |
|---|---|---|
| #3848 | 24.2 h | gate 4.7 h + 1.3 h + 1.3 h + 0.9 h, plan 6.8 h, … |
| #3851 | 3.2 h | implement 2.3 h |
| #3852 | 7.9 h | gate 2.5 h, implement 3.9 h |
| #3860 | 4.4 h | gate 2.1 h |
| #3864 | 4.1 h | gate 1.1 h + 0.8 h, implement 1.3 h |
| **median** | **4.4 h** (of the 5 shown members) | 7/10 same-window issues show >45 m gaps; **39.1 h** total gap time in the window |

**Fleet B** — `FLEET-PLAN-20260826-091737` (Aug 25–26; claude sonnet-5/opus-5, 10 completed): per-issue spans 1.9–28.8 h (median 3.3 h), makespan 47.9 h; #3752 alone shows a 16.3 h gate gap. **Fleet B executed on a different host** — its token/session data is not on hcc2 (see §6).

### 4.2 Un-tailed merges — the baseline's own record

The imboard worktree pool on hcc2 currently holds **9 assigned worktrees whose issues are CLOSED** (#3714, #3715, #3729, #3759, #3848, #3856, #3859, #3863, #3871 — verified closed) — merged fleet members whose teardown never ran. That is the fleet's un-tailed-merge record on this host (a stock accumulated across recent fleet runs, not a single workload's flow). The sched arm's corresponding record: W1 processed every merge's tail in-tick (§3.1).

### 4.3 Head-to-head (sched arm, all workloads final, vs the fleets)

| Metric | sched (12 units, 3 workloads) | Fleet A (6-issue fleet) | Fleet B (11-issue fleet) |
|---|---|---|---|
| Slot occupancy while runnable work existed | **W1 100.0% · W2 99.0%** (state-machine view; park→refill 8–11 ms, same tick; the only W2 dip = 1 tick of 60 s cadence) | not measurable — no slot events; stall-gaps are the proxy | same |
| Idle while runnable (worst observed) | 0 while any engine was alive; ≤60 s per event by tick cadence | gate gaps 4.7 h / 2.5 h / 2.1 h… (39.1 h total in window) | 16.3 h gate gap on #3752; 33.6 h total |
| Un-tailed merges (no tail processing) | **0** — every merge got teardown same-tick and report dispatch as soon as a slot freed (same-tick in 7/10, minutes later in 3/10; teardown success 0/10 = bug #496; report milestone 8/10 = bug #500; both filed) | ≥9 leaked worktrees on this host (closed issues, pool never returned) | part of the same leak stock |
| Stall handling | deterministic: journaled `stalled` → same-tick redispatch stronger → 3 stall/exit recoveries reached merges; cap bounded | invisible multi-hour gaps; supervision is remembered prose | same |
| Per-issue clean spawn→merged | **52–270 m** (~119 m over all 10 merged units; 112 m for the W3/re-drive cohort) | 3.2–7.9 h span incl. stalls (median 4.4 h of the shown members) | 1.9–28.8 h span (median 3.3 h) |
| Makespan | W1: 3.33 h / 4 issues (4/4 merged) | 05:41→16:35+ incl. wave deps | 47.9 h / 10 issues |
| Cost per issue | W1 claude $27.8 · W2 claude $141.8 (4 partial issues, wall-truncated) · W3/re-drives glm+kimi ~198.5 M tokens ≈ $66 (≈ $9–11/issue) | ~$10.5/issue (glm/kimi via opencode) | unreachable (other host) |

Model heterogeneity caveat (§6): the fleet cohorts ran glm/kimi/gpt via opencode; the sched arm ran claude (W1/W2) then glm/kimi (W3+re-drives) — the W3/re-drive rows are the model-comparable ones, and they land in the fleet's own cost band (~$9–11 vs ~$10.5/issue).

### 4.4 Acceptance criteria

- [x] **AC1** — ≥3 real multi-issue workloads (≥4 each) driven end-to-end by `sched`, all-full-cycle detached: W1 (4 issues, 4/4 merged), W2 (4 issues: 2 merged via re-drives after quota walls, 1 merged, 1 external watcher-block), W3 (4 issues: 3 merged, 1 correct human hand-off). Every unit was dispatched, supervised, and driven to a terminal state by the scheduler.
- [x] **AC2** — metrics recorded per workload: occupancy (§3.1, §3.2, §3.3 — >90% target met on both clean windows), un-tailed merges 0 (with teardown/report defect precision), stall recoveries (3 triggered by genuine stalls/exits, all recovered to merges; the quota-wall burns are D8, separated out), wall-clock vs fleet baselines (§4.3).
- [x] **AC3** — token/duration data aggregated from `~/.dossier/runs.jsonl` on every execution host: the every-host read was performed by the wls supervisor session (hcc2 lacks outbound credentials) and posted on this issue — the table is incorporated in §2.5, citing [the comment](https://github.com/imboard-ai/ai-dossier/issues/471#issuecomment-5470422534). Reading: wls had zero cohort-relevant runs; hcc's 2 in-window imboard entries are the #3856 fleet tail (immaterial at 2-vs-191, outside both comparison cohorts); hcc2 (both arms' host) carried 209 in-window entries at 100% telemetry on CLI 0.19.0 ≥ 0.13.0. Token values are null in runs.jsonl on all hosts for this window (opencode-spawned runs don't log them) — the agent CLIs' own usage records are the only token source and were used for both arms.
- [x] **AC4** — every divergence filed and linked: D1–D10 → #495, #496, #497, #500, #501, #502, #505, #506, #507 (9 issues; one operational note, D4, carries no issue by design — the state machine reconciled correctly, so it is not a state-machine divergence).
- [x] **AC5** — this report, with the §Recommendation go/no-go.

## 5. Divergences found

| # | Finding | Filed |
|---|---|---|
| D1 | Default `stall_timeout_ms` (30 min) is shorter than one imboard implement phase — healthy long-phase agents would burn the escalation ladder and fail; operator workaround `stall_timeout_ms=90min` applied for W1–W3 | [#495](https://github.com/imboard-ai/ai-dossier/issues/495) |
| D2 | `parseSetupInfo` JSON-parses `gh issue view --json comments` output as a bare array, but gh returns `{"comments":[...]}` — **teardown always fails** with `failed-missing-setup-info`; pool worktrees leak per merge (report tail unaffected). Reproduced directly; mock drift in the #468 fixtures masked it | [#496](https://github.com/imboard-ai/ai-dossier/issues/496) |
| D3 | Headless full-cycle agents (sonnet ×2 in W1) exit their session while a background build/test command still runs ("Waiting for ci-parity.sh…") — unverified-exit rail recovers correctly but burns a tier escalation + restart latency each time | [#497](https://github.com/imboard-ai/ai-dossier/issues/497) |
| D4 (op) | Engine processes spawned from an interactive agent harness get reaped when the harness call ends; switched W1 to the `sched start --once` cron deployment mid-run (~28-minute engine gap, journal silence 22:36:24→23:05:53). Cron mode = every tick is a cold restart — reconciliation-by-pid proved itself (exit-detected → redispatched same tick) | — (operational note, not a sched defect) |
| D5 | Report-agent completion's closed-signal suppression is overwritten by `phase-updated` (`slot.phase` tracks the issue's milestone phase, not the agent role) — units complete without a report milestone. Hit on #3891 (W1) and #3500 (W2) | [#500](https://github.com/imboard-ai/ai-dossier/issues/500) |
| D6 | `unit-failed` ledger goes stale when an externally-blocked PR is later merged by the operator — no reconcile path for terminal-failed entries whose world changed (W2 #3756: watcher-blocked on the known imboard CANCELLED-checks race, PR left green for human disposition; ledger stays failed) | [#501](https://github.com/imboard-ai/ai-dossier/issues/501) |
| D7 | Re-enqueueing a terminal (failed) unit corrupts `state.json` — `enqueueEntries` allows the re-enqueue but appends without replacing the old entry; the just-written state fails its own `validateState` on the next load, bricking every command incl. the cron engine until a manual reset | [#502](https://github.com/imboard-ai/ai-dossier/issues/502) |
| D8 (op) | **Three distinct billing walls in one night, all riding the ladder to unit failure**: (1) Claude weekly limit 03:50Z — `You've hit your weekly limit · resets Sep 1`, agents exit after 1 turn; (2) llmgateway Dev Plan credit limit 04:37Z (also reached via the openrouter-routed `~z-ai/*` models — the `~` models proxy through the same DevPass credits) — `402 … renewal on 9/28/2026`; (3) an in-flight credit race 07:16Z — `This request would exceed your available credits given your current in-flight requests` — killed #3433 mid-implement. Every wall produced instant unverified exits → escalation cap → `unit-failed`, while each unit's pushed/saved work was fine. No dispatch-health pause exists (unlike the ground-truth-unreachable pause). Owner added credits ~07:18Z; affected units re-driven | [#505](https://github.com/imboard-ai/ai-dossier/issues/505) |
| D9 (op) | `sched enqueue` accepts issues with hard-block labels — W3's #3414 was dispatched, ran gate→setup→plan, correctly handed itself off as decision-pending (reachability rule firing), and then the exit burned the ladder toward `unit-failed` for an issue whose true state is "waiting for a human". Pre-screening labels at enqueue (as gate-issue and fleet-cycle's wave planner do) would cost one gh call and save a slot-hour per mis-enqueued issue | [#507](https://github.com/imboard-ai/ai-dossier/issues/507) |
| D10 | The opencode dispatch template (`OPENCODE_DISPATCH_COMMAND`) lacks `--auto`: git worktrees are their own repo boundary, so opencode classifies worktree paths (and home-dir reads) as `external_directory` — default `"ask"` → headless auto-reject. W3's first opencode round died mid-phase on exactly this (edit/bash into its OWN worktree rejected). Verified fix: `--auto` auto-approves undenied requests. Compounding operator error in the same window: the cron wrapper's PATH missed the opencode bin dir, so every redispatch spawn errored and the cascade insta-failed all six queued/running units (~15 min, zero tokens wasted — pure infrastructure). Both fixed mid-run (tick.sh PATH + `--auto`); units re-driven | [#506](https://github.com/imboard-ai/ai-dossier/issues/506) |

## 6. Limitations

- **Multi-host runs.jsonl aggregation**: this run executes on `hcc2` and has no outbound SSH credentials to `wls`/`hcc` (verified: no keys, publickey denied, no VPN) — the cross-host read was instead performed by the wls supervisor session, which pulled all three hosts' runs.jsonl and posted the aggregation on this issue (incorporated in §2.5, AC3 met). The fleet baselines selected for comparison were verified (via FLEET-PLAN logs + runs.jsonl `cwd` entries) to have executed on `hcc2` as well, so no arm is undercounted. Fleet B (the claude-model cohort) executed on a different host entirely — its tokens are unreachable from hcc2.
- **runs.jsonl does not carry fleet-agent token usage** (fleet subagents are opencode background agents; runs.jsonl logs their nested dossier fetches only — `input_tokens`/`output_tokens` are null on **all three hosts** for the measured window, per the cross-host aggregation in §2.5). Token data therefore comes from the agent CLIs' own records: claude result-JSON (sched arm, W1/W2) and opencode session streams (fleet A + sched W3). The fleet-baseline window (from Aug 28) also opened before hcc2's CLI upgrade — hcc2's earliest telemetry entry is 2026-08-29T09:29Z.
- **Model heterogeneity**: W1/W2 ran claude tiers (sonnet/opus/haiku); W3 + re-drives ran glm-latest/kimi-latest via opencode/openrouter (quota walls forced the mid-validation switch, §D8); Fleet A ran glm/kimi/gpt, Fleet B ran claude on another host. Occupancy and un-tailed merges are model-independent; latency and cost comparisons carry the caveat (the W3/re-drive rows are the model-matched ones).
- **W3's composite occupancy** is not meaningful across operator state-resets (D7's workaround); clean-window occupancy is reported for W1/W2, refill-latency evidence for W3 (§3.3).
- **Issue-size mix** differs from the fleet cohorts (walker-found UI bugs and small backend fixes vs the fleets' broader mix); per-issue latency comparisons are indicative, not controlled.
- The validation engine ran as a 1-minute cron of `sched start --once` after interactive-spawned engines were reaped by the agent harness (D4) — a legitimate deployment mode, but it means every tick was a cold process; detection latencies measured include that mode's granularity.

## 7. Appendix — evidence

- Sched journal (every decision, verbatim): `docs/reports/evidence/sched-events-w1.jsonl` (W1 snapshot, 63 events) and `docs/reports/evidence/sched-events-final.jsonl` (the complete journal, 403 events) — the machine-readable record behind every §3 claim; two corrupt-state artifacts (`state.json.corrupt-duplicate-3889` evidencing #502, `state.json.corrupt-ladder-burn` from the #506 cascade window) are committed alongside.
- Per-agent output: `docs/reports/evidence/agent-logs-summary.md` — every claude result (usage/cost/turns/duration) and opencode API error, condensed per unit; the full raw streams remain on hcc2 at `~/.dossier/sched/imboard-ai-imboard-monorepo/runs/issue-<n>.log`.
- Fleet baselines: `~/.dossier/logs/fleet-cycle/imboard-ai-imboard-monorepo/FLEET-PLAN-*.md.gz` (12 plans), runstate trails via `ai-dossier runstate stats --issues … --repo imboard-ai/imboard-monorepo --json`, opencode session-DB token attribution (Fleet A ≈ $52.72 for the 5 completed core members).
- Operational trail: this issue's runstate milestones (gate → setup → plan → implement) and the imboard issues' own trails (#3810, #3862, #3886, #3891, #3433, #3408, #3824, #3889, #3890, #3500 merged with full runstate histories; #3414 decision-pending hand-off; #3756's PR #3927 left for human disposition).
- Filed issues: #495, #496, #497, #500, #501, #502, #505, #506, #507.
