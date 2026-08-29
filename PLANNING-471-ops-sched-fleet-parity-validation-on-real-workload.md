# Issue #471: ops: sched fleet-parity validation on real workloads (Step 1 exit gate)

## Problem

RFC-0001 Migration Step 1 exit gate (`rfcs/0001-batch-cycles.md`, on branch `docs/batch-cycles-rfc` §G): before any batching, `dossier-sched` must demonstrate parity with fleet-cycle on real workloads — proving the named fleet failure (slots sitting idle while runnable work exists) is gone. The scheduler core (#460), dispatch engine (#464), and PR-watch/tail-work (#468) are merged and unit/integration-tested, but `~/.dossier/sched/` has never driven a real workload — the system is "partially operational". This issue runs the live validation and commits the report as the Step 1 exit-gate artifact.

**Why the prior plan:v1 artifact was rejected (fresh planning path):** `ai-dossier plan validate` reported an error-severity reason — its predicted file `docs/ops/sched-fleet-parity-report.md` does not exist at HEAD — plus 4 commits of head-distance (the artifact predates #468's merge). It also conflicts with the issue body on the artifact path (`docs/reports/sched-parity.md` per the issue Scope) and omits the multi-host runs.jsonl and divergence-filing ACs. Issue body is canonical.

**Environment facts established during planning (hcc2):**
- This host is `hcc2` (hostname), one of the three execution hosts (wls, hcc, hcc2). No outbound SSH keys exist on hcc2 → wls/hcc `runs.jsonl` files are NOT reachable from this run; only hcc2's `~/.dossier/runs.jsonl` is readable (see Risk Areas).
- Global `ai-dossier` is 0.14.0 (no `sched`/`plan` commands). `@ai-dossier/cli@0.19.0` is published on npm and carries `sched`; upgrading the global CLI is a prerequisite.
- `claude` CLI 2.1.251 is installed, authenticated, and verified working headlessly (`claude -p` with Bash tool access via `~/.claude/settings.json` permissions).
- The imboard monorepo is at `~/projects/imboard/imboard-monorepo` (sched workloads run there; project slug `imboard-ai-imboard-monorepo`). Its worktree pool has 1 warm spare, 9 stale assigned worktrees, max 10.
- A fleet-cycle member (#3856) is currently in-flight on imboard (resumed review ~21:42Z); workloads must not select it.
- Fleet baseline data available: 12 FLEET-PLAN logs in `~/.dossier/logs/fleet-cycle/imboard-ai-imboard-monorepo/` (Aug 26–29), incl. FLEET-PLAN-20260828-054148 (6 issues, detached full-cycle, max-parallel 3) with per-issue runstate trails (`runstate stats`).

## Acceptance Criteria

- [ ] AC1 ≥3 real multi-issue workloads (≥4 issues each) driven end-to-end by `sched` in all-full-cycle detached mode
- [ ] AC2 Metrics recorded per workload: slot occupancy while runnable work existed (target >90%), un-tailed merges (must be 0), stall recoveries triggered/succeeded, wall-clock vs a comparable fleet-cycle baseline
- [ ] AC3 Token/duration data aggregated from `~/.dossier/runs.jsonl` on EVERY execution host (wls, hcc, hcc2) — runs.jsonl is per-machine; a single-host read undercounts the baseline. Verify each host ran CLI >= 0.13.0 for the measured window (older versions log no tokens)
- [ ] AC4 Every divergence from expected state-machine behavior filed as an issue and linked in the report
- [ ] AC5 Report committed at `docs/reports/sched-parity.md` with a go/no-go recommendation for deprecating fleet-cycle supervision

## Approach

1. **Pre-flight (hcc2)**: upgrade global CLI to `@ai-dossier/cli@0.19.0` (published; carries `sched` + `plan`); verify `ai-dossier sched --help`; verify `claude -p` headless (done); confirm imboard-monorepo on latest `main`.
2. **Baseline (fleet-cycle, comparable cohort)**: inventory the 12 FLEET-PLAN logs; select comparable fleets (detached full-cycle, ≥4 dispatched issues, recent — primary: FLEET-PLAN-20260828-054148, 6 issues); compute per-issue wall-clock and fleet makespan from runstate trails (`runstate stats --issues ...`) and PR merge timestamps; aggregate hcc2 `runs.jsonl` (durations/tokens where present); document that wls/hcc are unreachable from this host and file the gap as a divergence/limitation.
3. **Workloads (sched arm)**: three sequential workloads in project `imboard-ai-imboard-monorepo`, each 4 real imboard backlog issues (12 total, listed under Predicted Files → selection), enqueued with per-risk tier (`--tier mid` default; `--tier strong` for the security fix #3408), default engine config (max_slots=3, stall 30 min, tick 60 s, PR poll 150 s) with one override: `dispatch.prompt` names `imboard-ai/imboard/warm-worktree-pnpm-ssm` as the warmup dossier (the fleet baseline used it; parity requires the same warmup path). Run `sched start` under `nohup` from the imboard-monorepo root; poll `sched status`/`events.jsonl`; per workload capture: enqueue→first-spawn, park/merge/teardown/report events, per-unit claude usage from `~/.dossier/sched/imboard-ai-imboard-monorepo/runs/*.log`, and un-tailed merges (merge-accepted without teardown-done+report-dispatched).
4. **Metrics computation**: slot occupancy = Σ busy-slot-seconds / Σ min(max_slots, runnable+busy)-seconds over each workload's "runnable work exists" window (first spawn → last dispatch of queued work; parked units consume zero slots by design); un-tailed merges = merge-accepted events lacking teardown-done/report-dispatched for that unit; stall recoveries from stalled/redispatched events and their outcomes; wall-clock per issue (gate→merged) and per workload (first spawn→last merge), compared to the fleet cohort.
5. **Divergence handling**: any state-machine divergence (unexpected transition, ground-truth pause, teardown failure, engine bug) is recorded with evidence and filed as a GitHub issue in imboard-ai/ai-dossier — never fixed inline (issue scope).
6. **Report**: write `docs/reports/sched-parity.md` — method, environment, per-workload metric tables, baseline comparison, divergence list with issue links, limitations (multi-host runs.jsonl gap, model heterogeneity sched=claude tiers vs fleet=glm/kimi/gpt), go/no-go recommendation for deprecating fleet-cycle supervision.

## Reachability Evidence

- N/A — no new user-reachable product state. This is operational validation of an already-built state machine (`packages/sched`), not a feature; the "state" exercised is sched's own queue/slot lifecycle, which exists and is unit-tested. The prod-data check (mongodb-prod) does not apply to the ai-dossier toolchain.

## Predicted Files

- `docs/reports/sched-parity.md` — (new) the Step 1 exit-gate report: method, per-workload metrics (occupancy, un-tailed merges, stalls, wall-clock, tokens), fleet baseline comparison, divergence links, go/no-go. The only committable artifact (issue Scope; bug fixes found along the way are filed as separate issues, not fixed inline).

## Reusable Code

- `ai-dossier sched enqueue|start|status|abandon` (cli ≥ 0.19.0) — the system under test; state/journal under `~/.dossier/sched/imboard-ai-imboard-monorepo/` (`state.json`, `events.jsonl`, `runs/*.log`).
- `ai-dossier runstate stats --issues <list> --repo imboard-ai/imboard-monorepo` — per-phase durations from runstate trails; the fleet-baseline wall-clock source (host-agnostic, reads GitHub).
- `~/.dossier/logs/fleet-cycle/imboard-ai-imboard-monorepo/FLEET-PLAN-*.md.gz` — fleet-cycle's own wave plans; the baseline cohort inventory.
- `npx -y @ai-dossier/worktree-pool@^0.5.1 status|claim|return` — pool introspection only (never gc/refresh); dispatched agents claim their own worktrees.
- `packages/sched/README.md` + RFC-0001 §G/H (branch `docs/batch-cycles-rfc`) — the exit-gate criteria and metric definitions being validated.

## Risk Areas

- **Multi-host runs.jsonl aggregation (AC3) is partially unreachable**: hcc2 has no outbound SSH credentials for wls/hcc (verified: no keys in `~/.ssh`, publickey denied on hcc/occ, no tailscale). Mitigation: aggregate hcc2's runs.jsonl (the host executing both the sched arm and — verified via FLEET-PLAN logs + runs.jsonl cwd entries — the comparable fleet baselines), scope the token/duration comparison to same-host cohorts so no arm is undercounted, verify hcc2's CLI version for the window (0.19.0 ≥ 0.13.0), and record the cross-host gap as a limitation + filed divergence issue.
- **runs.jsonl does not carry fleet-agent token usage** (fleet subagents are opencode background agents; runs.jsonl only logs their nested dossier fetches — verified: today's fleet window has 31 nested entries, none with tokens). Sched-arm tokens come from `runs/*.log` (claude `-p` JSON usage); fleet-arm token recovery is best-effort (session storage) and may be reported as unavailable — duration/wall-clock comparison (runstate-based) is the solid baseline axis.
- **Model heterogeneity**: sched dispatches claude tiers (haiku/sonnet/opus defaults) while the fleet baseline ran glm-5.3/kimi/gpt-5.6 via opencode — per-issue latency and token comparisons carry this caveat (occupancy and un-tailed merges are model-independent).
- **Concurrent activity**: fleet member #3856 is in-flight on imboard; workloads exclude it and all in-progress/decision-pending/needs-clarification issues. Pool has 1 warm spare — most sched units take the cold worktree path (slower setup, does not affect occupancy).
- **Long wall-clock**: 12 real full-cycle runs ≈ 6–15 h total; merge waits depend on imboard CI and the auto-merge watcher. Stall ladder (30 min) may escalate/fail units — failures are recorded as outcomes, not hidden.
- **`plan` command group was missing from the global CLI** (0.14.0) — resolved by the 0.19.0 upgrade in pre-flight; worktree-local build already used for planning.
- **agent-traps.md**: does not exist in this repo (checked) — no trap hits applicable. (The imboard repo has its own traps doc; dispatched agents read it via their own workflows.)

## Test Scope

- This IS the test — operational validation with recorded evidence (issue Test strategy). No unit tests to add; `make test` on the branch stays green (docs-only diff). Evidence artifacts: `events.jsonl` excerpts, `runs/*.log` usage lines, runstate trails, FLEET-PLAN baselines, PR links — quoted into the report.

## Open Questions

- (none blocking — the multi-host gap is handled per Risk Areas: same-host cohorts + filed limitation)

## Visual Review

- [x] Not required (backend/infra only — a docs report)

## Base Branch

`main` — PRs for this issue target this branch.
