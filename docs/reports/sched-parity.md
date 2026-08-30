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
| Dispatch tiers | full-cycle units: `mid` (sonnet); security-class issue: `strong` (opus); report agents: mechanical (haiku), ladder per #468 |
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

## 3. Results

### 3.1 W1 — #3891, #3862, #3810, #3886 (2026-08-29 22:22Z → …)

Timeline facts (from `events.jsonl`, verbatim in `docs/reports/evidence/`):

| Unit | Dispatch tier(s) | Spawn → park | Spawn → merged | PR | Report milestone |
|---|---|---|---|---|---|
| #3810 | mid (sonnet) | 50 m | **52 m** | #3922 | ✅ posted (+85 m) |
| #3886 | mid → strong (exit-recovery) | 83 m | **87 m** | #3924 | ✅ posted (+88 m) |
| #3891 | mid (cold worktree) | 122 m | **126 m** | #3925 | ❌ missing (D5/#500 — rich report comment posted, milestone not) |
| #3862 | mid → strong (exit-recovery) | 191 m | pending merge | #3926 | pending |

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

<!-- W2, W3 sections follow -->


## 4. Baseline comparison

<!-- wall-clock + tokens vs Fleet A/B -->

## 5. Divergences found

| # | Finding | Filed |
|---|---|---|
| D1 | Default `stall_timeout_ms` (30 min) is shorter than one imboard implement phase — healthy long-phase agents would burn the escalation ladder and fail; operator workaround `stall_timeout_ms=90min` applied for W1–W3 | [#495](https://github.com/imboard-ai/ai-dossier/issues/495) |
| D2 | `parseSetupInfo` JSON-parses `gh issue view --json comments` output as a bare array, but gh returns `{"comments":[...]}` — **teardown always fails** with `failed-missing-setup-info`; pool worktrees leak per merge (report tail unaffected). Reproduced directly; mock drift in the #468 fixtures masked it | [#496](https://github.com/imboard-ai/ai-dossier/issues/496) |
| D3 | Headless full-cycle agents (sonnet ×2 in W1) exit their session while a background build/test command still runs ("Waiting for ci-parity.sh…") — unverified-exit rail recovers correctly but burns a tier escalation + restart latency each time | [#497](https://github.com/imboard-ai/ai-dossier/issues/497) |
| D4 (op) | Engine processes spawned from an interactive agent harness get reaped when the harness call ends; switched W1 to the `sched start --once` cron deployment mid-run (21-min engine gap 22:37:30→23:05:50 recorded in the journal). Cron mode = every tick is a cold restart — reconciliation-by-pid proved itself (exit-detected → redispatched same tick) | — (operational note, not a sched defect) |

## 6. Limitations

- **Multi-host runs.jsonl aggregation (AC3)**: this run executes on `hcc2` and has no outbound SSH credentials to `wls`/`hcc` (verified: no keys, publickey denied, no VPN). The fleet baselines selected for comparison were verified (via FLEET-PLAN logs + runs.jsonl `cwd` entries) to have executed on `hcc2` as well, so no arm is undercounted by the single-host read; the cross-host aggregate is not available and is recorded as a gap.
- **Model heterogeneity**: the sched arm dispatches claude tiers (sonnet/opus/haiku) while Fleet A ran glm/kimi/gpt via opencode. Occupancy and un-tailed merges are model-independent; per-issue latency and token comparisons carry this caveat. Fleet B (claude models) is the token-comparable cohort.

## 7. Appendix

<!-- evidence: event excerpts, usage lines, command log -->
