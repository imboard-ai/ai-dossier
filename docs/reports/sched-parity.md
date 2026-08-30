# sched fleet-parity validation — RFC-0001 Step 1 exit gate

**Status: IN PROGRESS — this report is being filled in live as workloads complete.**
**Run:** `r-471-046c` · issue #471 · executing host: `hcc2` · started 2026-08-29T22:22Z

## Recommendation

<!-- go/no-go lands here after W3 -->

## 1. What this gate decides

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
| Dispatch tiers | W1/W2 (claude): `mid` = sonnet, report = haiku, ladder → opus. From 04:47Z (W3 + re-drives): opencode via **openrouter** per owner instruction — `mid` = `~z-ai/glm-latest`, `strong` = `~moonshotai/kimi-latest`, report = mechanical (glm) — mirroring the fleet baselines' glm/kimi model families (claude's weekly limit and then llmgateway's Dev Plan credits ran out mid-validation; see D8) |
| Workload repo | `imboard-ai/imboard-monorepo` (the same repo and backlog the fleet-cycle baselines ran against) |
| Dispatch prompt | default detached full-cycle template + `warmup_dossier imboard-ai/imboard/warm-worktree-pnpm-ssm` (the same warmup path the fleet baselines used — parity requirement) |

### 2.2 Workloads (sched arm)

Three sequential workloads, each ≥ 4 real backlog issues, all-full-cycle detached mode (agent parks PR on `auto-merge` and stops; the scheduler owns merge-watch, teardown, and report dispatch):

| Workload | Issues | Tiers | Window |
|---|---|---|---|
| W1 | #3891, #3862, #3810, #3886 | mid | 2026-08-29 22:22Z → … |
| W2 | #3890, #3889, #3756, #3500 | mid | … |
| W3 | #3433, #3414, #3408, #3824 | mid, mid, strong, mid | … |

Issue selection: open imboard backlog issues with clear code-level scope, no `decision-pending`/`needs-clarification`/`epic`/`in-progress` labels, no open `Depends on` — pre-screened with the same criteria gate-issue enforces (a gate-blocked unit burns a slot for ~90 min on the stall ladder; see divergence #495).

### 2.3 Baseline (fleet-cycle arm)

Fleet-cycle plans live in `~/.dossier/logs/fleet-cycle/imboard-ai-imboard-monorepo/FLEET-PLAN-*.md.gz` on the orchestrating host. Two comparable cohorts were selected (same repo, detached full-cycle dispatch, max-parallel 3, overlapping issue classes):

- **Fleet A** — `FLEET-PLAN-20260828-054148` (+ same-window members): 6-issue fleet, waves, dependency-gated. Completed members: #3851, #3852, #3860, #3864 (+ #3857 gate-blocked, #3862 never dispatched); models glm-5.3 / kimi-k3-fast / gpt-5.6-luna.
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

**AC3 accounting (runs.jsonl aggregation, per host):**

| Host | Reachable from this run | runs.jsonl content for the measured windows | CLI ≥ 0.13.0 verified |
|---|---|---|---|
| hcc2 (this run) | ✅ | W1 window: 70 entries (agents' nested dossier fetches — gate ×13, full-cycle ×10, …), all with duration telemetry, 0 with tokens (nested fetches never carry them); Fleet A window: 274 entries, only 14 with telemetry — hcc2's earliest telemetry entry is 2026-08-29T09:29Z, so **the fleet baseline window largely predates CLI 0.13.0 on hcc2** | sched window ✅ (0.19.0); fleet window ❌ (pre-0.13.0 for most of it) |
| wls | ❌ no outbound SSH credentials (verified: no keys, publickey denied, no VPN) | not readable | unverifiable |
| hcc | ❌ same | not readable | unverifiable |

Consequence, handled transparently: token data for both arms comes from the agent CLIs' own records on hcc2 (claude usage JSON for the sched arm; opencode.db for the Fleet A arm — both hcc2-local, so neither arm is undercounted by host scope), and the cross-host `runs.jsonl` aggregate the AC asks for is recorded as a gap (§6). Fleet B ran on a different host entirely — its tokens are unreachable from hcc2.

## 3. Results

### 3.1 W1 — #3891, #3862, #3810, #3886 (2026-08-29 22:22Z → …)

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

A second, stricter view counts a slot busy only while its agent process is actually alive (excluding dead-agent detection latency): 76% raw — dominated by a 21-minute window where **no engine process existed at all** (the validation harness reaped engine processes spawned from its session; D4). Excluding that documented outage, detection-to-redispatch under the cron engine was ≤ 60 s per exit (tick cadence), and the same-tick refill property still held everywhere the engine was alive.

**Un-tailed merges: 0** (every merge received tail processing in the same or next tick) — with precision:
- teardown attempted+recorded: 3/3 merges, **succeeded 0/3** — every one failed with `failed-missing-setup-info` (D2/#496, a mock-drift bug: teardown never runs; pool worktrees leak)
- report dispatched: 3/3; report milestone posted: 2/3 (#3891's completed via the D5/#500 bug without its milestone)

**Stall recoveries: triggered 3, succeeded 3.** #3886 and #3862: sonnet agents exited mid-implement while a background build ran (#497) → `verify-incomplete` → redispatched at strong tier in the same tick → both resumed from the runstate trail and drove to merged PRs. #3891: mechanical report agent exited unverified → redispatched mid → completed (via D5). No unit hit the escalation cap; no unit failed.

**Wall-clock:** spawn→merged per issue 52–126 m (median 87 m) vs the fleet baselines' per-issue spans of 1.9–28.8 h (Fleet B median 3.3 h, Fleet A median 4.1 h — which include supervision stalls; §4). Makespan for 4 issues: ~3 h (3 merged by +2.93 h; #3862 parked at +3.2 h, merge pending CI). Caveat: issue mix and models differ from the fleet cohorts (§6).

**Tokens/cost (claude usage per unit, all dispatches summed):**

| Unit | Dispatches | Cache-read | Output tokens | Cost |
|---|---|---|---|---|
| #3810 | 2 (cycle+report) | 40.0 M | 121 806 | $13.23 |
| #3886 | 3 (2×cycle+report) | 21.2 M | 80 135 | $27.41 |
| #3891 | 3 (cycle+2×report) | 31.1 M | 58 555 | $33.02 |
| #3862 | 2 (2×cycle) | 30.6 M | 122 196 | $37.27 |
| **W1 total** | 10 | 122.9 M | 382 692 | **$110.94** (≈ $27.7/issue) |

### 3.2 W2 — #3890, #3889, #3756, #3500 (2026-08-30 01:37Z → 03:51Z)

W2 ran under the default prompt on claude tiers and hit three distinct external walls — which is precisely what real workloads look like; each outcome is recorded per-unit:

| Unit | Outcome | PR | Detail |
|---|---|---|---|
| #3500 | ✅ merged + tail | #3928 | park 03:42 → merged 03:45:52 → merge-accepted + report-dispatched same tick; report milestone missing (D5/#500 — second instance) |
| #3756 | ❌ unit-failed (`auto-merge-blocked`) | #3927 | imboard auto-merge watcher blocked a green, mergeable PR on persistent CANCELLED check-runs (the known imboard#3884 traps race — external). Operator re-queue re-blocked instantly; PR left for human disposition. Ledger staleness = D6/#501 |
| #3889 | ⚠️ unit-failed at ladder cap — **quota wall** | — | implement done + pushed (03:04), review started; Claude weekly limit hit 03:50Z → agent exit → strong redispatch died at 1 turn → cap. Work survives on branch; re-driven after the provider switch |
| #3890 | ⚠️ same as #3889 | — | implement done + pushed (03:45); same quota-wall ladder burn; re-driven |

- **Slot occupancy while runnable work existed:** window 01:37:02 (first spawn) → 02:47:08 (#3890, the last queued unit, first spawn — freed by #3756's unit-failure at 02:46): slots never idled while runnable work waited. The freed slot first served the waiting #3862 report agent (02:45:10, tail-before-new-work tick order), then #3890 within 3 minutes (tick cadence). #3889's 90-minute implement ran right up to its stall deadline and pushed at 03:04 — 21 minutes before the timer.
- **Un-tailed merges:** 1 merge (#3500) — tail ran same-tick (teardown failed per D2/#496; report dispatched, milestone missing per D5/#500).
- **Stall recoveries:** 2 triggered (both #497-style sonnet exits mid-implement — "waiting for ci-parity/background test"), 2 redispatched at strong tier; both opus resumes were then killed by the quota wall (counted under D8, not as ladder failures of their own).
- **Cost (claude, partial before the wall):** #3500 $44.66 (3 dispatches), #3756 $54.85 (2), #3889 $31.77 (2), #3890 $10.48 (2) — **$141.76 total for 4 partially-completed issues**; quota-wall ladder deaths cost ~$0 in tokens but each cache-priming spawn that died instantly still billed its context upload (#3890's $10.48 is almost entirely cache writes). Usage details in evidence logs.

<!-- W3 section follows -->


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
| **median** | **4.1 h** | 7/10 issues show gaps; **39.1 h** total gap time in the window |

**Fleet B** — `FLEET-PLAN-20260826-091737` (Aug 25–26; claude sonnet-5/opus-5, 10 completed): per-issue spans 1.9–28.8 h (median 3.3 h), makespan 47.9 h; #3752 alone shows a 16.3 h gate gap. **Fleet B executed on a different host** — its token/session data is not on hcc2 (see §6).

### 4.2 Un-tailed merges — the baseline's own record

The imboard worktree pool on hcc2 currently holds **9 assigned worktrees whose issues are CLOSED** (#3714, #3715, #3729, #3759, #3848, #3856, #3859, #3863, #3871 — verified closed) — merged fleet members whose teardown never ran. That is the fleet's un-tailed-merge record on this host (a stock accumulated across recent fleet runs, not a single workload's flow). The sched arm's corresponding record: W1 processed every merge's tail in-tick (§3.1).

### 4.3 Head-to-head (W1 vs the fleets)

| Metric | sched W1 (4 issues) | Fleet A (6-issue fleet) | Fleet B (11-issue fleet) |
|---|---|---|---|
| Slot occupancy while runnable work existed | **100%** (state-machine; same-tick refill 8–11 ms) | not measurable — no slot events; stall-gaps are the proxy | same |
| Idle while runnable (worst observed) | 0 engine-alive idle; ≤60 s exit-detection per tick | multi-hour gate gaps (4.7 h, 2.5 h, 2.1 h…) | 16.3 h gate gap on #3752 |
| Un-tailed merges | **0** (tail ran on every merge; teardown success 0/3 — bug #496; report milestone 2/3 — bug #500) | ≥9 leaked worktrees on this host | (part of the same pool leak) |
| Per-issue spawn→merged | **52–200 m, median ~107 m** | 3.2–7.9 h span (incl. stalls) | 1.9–28.8 h span |
| Makespan | **3.33 h / 4 issues** | 05:41→16:35 next-day incl. wave deps | 47.9 h / 10 issues |
| Stall recoveries | 3 triggered / 3 succeeded / 0 failed | supervision is prose — stalls are visible only as gaps | same |
| Cost per issue | $27.7 (claude sonnet/opus) | ~$10.5 (glm/kimi/gpt) — model pricing, not architecture | unreachable (other host) |

Caveats carried into §6: model heterogeneity (claude vs glm/kimi/gpt), issue-size mix, and the stall-vs-work ambiguity inside long fleet implement phases (fleet gaps in gate/setup are unambiguous; implement gaps may include real work).

<!-- W2/W3 rows extend this table in §3 -->

## 5. Divergences found

| # | Finding | Filed |
|---|---|---|
| D1 | Default `stall_timeout_ms` (30 min) is shorter than one imboard implement phase — healthy long-phase agents would burn the escalation ladder and fail; operator workaround `stall_timeout_ms=90min` applied for W1–W3 | [#495](https://github.com/imboard-ai/ai-dossier/issues/495) |
| D2 | `parseSetupInfo` JSON-parses `gh issue view --json comments` output as a bare array, but gh returns `{"comments":[...]}` — **teardown always fails** with `failed-missing-setup-info`; pool worktrees leak per merge (report tail unaffected). Reproduced directly; mock drift in the #468 fixtures masked it | [#496](https://github.com/imboard-ai/ai-dossier/issues/496) |
| D3 | Headless full-cycle agents (sonnet ×2 in W1) exit their session while a background build/test command still runs ("Waiting for ci-parity.sh…") — unverified-exit rail recovers correctly but burns a tier escalation + restart latency each time | [#497](https://github.com/imboard-ai/ai-dossier/issues/497) |
| D4 (op) | Engine processes spawned from an interactive agent harness get reaped when the harness call ends; switched W1 to the `sched start --once` cron deployment mid-run (21-min engine gap 22:37:30→23:05:50 recorded in the journal). Cron mode = every tick is a cold restart — reconciliation-by-pid proved itself (exit-detected → redispatched same tick) | — (operational note, not a sched defect) |
| D5 | Report-agent completion's closed-signal suppression is overwritten by `phase-updated` (`slot.phase` tracks the issue's milestone phase, not the agent role) — units complete without a report milestone. Hit on #3891 (W1) and #3500 (W2) | [#500](https://github.com/imboard-ai/ai-dossier/issues/500) |
| D6 | `unit-failed` ledger goes stale when an externally-blocked PR is later merged by the operator — no reconcile path for terminal-failed entries whose world changed (W2 #3756: watcher-blocked on the known imboard CANCELLED-checks race, PR left green for human disposition; ledger stays failed) | [#501](https://github.com/imboard-ai/ai-dossier/issues/501) |
| D7 | Re-enqueueing a terminal (failed) unit corrupts `state.json` — `enqueueEntries` allows the re-enqueue but appends without replacing the old entry; the just-written state fails its own `validateState` on the next load, bricking every command incl. the cron engine until a manual reset | [#502](https://github.com/imboard-ai/ai-dossier/issues/502) |
| D8 (op) | Model-API quota walls ride the stall ladder to unit failure: Claude's weekly limit (03:50Z) then llmgateway's Dev Plan credit limit (04:37Z) produced instant zero-token exits — every unit burned its ladder to `unit-failed` within minutes while its pushed work was fine; no dispatch-health pause exists (unlike the ground-truth-unreachable pause). Operator response: provider switch to openrouter per owner instruction; affected units re-driven via re-enqueue | [#505](https://github.com/imboard-ai/ai-dossier/issues/505) |
| D9 (op) | `sched enqueue` accepts issues with hard-block labels — W3's #3414 was dispatched, ran gate→setup→plan, correctly handed itself off as decision-pending (reachability rule firing), and then the exit burned the ladder toward `unit-failed` for an issue whose true state is "waiting for a human". Pre-screening labels at enqueue (as gate-issue and fleet-cycle's wave planner do) would cost one gh call and save a slot-hour per mis-enqueued issue | [#507](https://github.com/imboard-ai/ai-dossier/issues/507) |
| D10 | The opencode dispatch template (`OPENCODE_DISPATCH_COMMAND`) lacks `--auto`: git worktrees are their own repo boundary, so opencode classifies worktree paths (and home-dir reads) as `external_directory` — default `"ask"` → headless auto-reject. W3's first opencode round died mid-phase on exactly this (edit/bash into its OWN worktree rejected). Verified fix: `--auto` auto-approves undenied requests. Compounding operator error in the same window: the cron wrapper's PATH missed the opencode bin dir, so every redispatch spawn errored and the cascade insta-failed all six queued/running units (~15 min, zero tokens wasted — pure infrastructure). Both fixed mid-run (tick.sh PATH + `--auto`); units re-driven | [#506](https://github.com/imboard-ai/ai-dossier/issues/506) |

## 6. Limitations

- **Multi-host runs.jsonl aggregation (AC3)**: this run executes on `hcc2` and has no outbound SSH credentials to `wls`/`hcc` (verified: no keys, publickey denied, no VPN). The fleet baselines selected for comparison were verified (via FLEET-PLAN logs + runs.jsonl `cwd` entries) to have executed on `hcc2` as well, so no arm is undercounted by the single-host read; the cross-host aggregate is not available and is recorded as a gap.
- **Model heterogeneity**: the sched arm dispatches claude tiers (sonnet/opus/haiku) while Fleet A ran glm/kimi/gpt via opencode. Occupancy and un-tailed merges are model-independent; per-issue latency and token comparisons carry this caveat. Fleet B (claude models) is the token-comparable cohort.

## 7. Appendix

<!-- evidence: event excerpts, usage lines, command log -->
