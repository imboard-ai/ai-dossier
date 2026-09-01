# Batch pilot — RFC-0001 Step 3 gate

**Status: BLOCKED — the pilot did not execute. Baseline arm complete, pilot arm empty.**
**Run:** `r-473-8b0e` · issue #473 · executing host: `hcc2` · 2026-09-01

## Recommendation

**NO-GO on widening.** Not because batching underperformed — because **zero batches have ever been
executed**, so there is no pilot arm to measure. `ai-dossier sched status` for this project reports
`== Batches == (no batches)`; the scheduler journal contains 0 batch events; the one batch that
exists (anchor #490, `b-20260829-01`) was produced by a *dry run* and explicitly never enqueued.

Nothing in this report is evidence against the batch design. It is evidence that the Step-3 gate
was attempted before three preconditions were in place, and it records what those are (§5) so the
next attempt does not rediscover them.

What this report does deliver is **a complete baseline arm** (§3) — 11 real full-cycle issues with
per-issue tokens, cost, CI executions, wall-clock, makespan and interventions. Note what it is
*not*: this is a `sched`-dispatched full-cycle cohort on *this* repo, not the RFC's original Step-0
fleet baseline, which ran against a different repo (§6). It is the right comparison for a batch arm
run on the same scheduler and repo, and it did not exist before this run.

Two of the five acceptance criteria ship **unmet** (AC1, AC3) and two ship **partial** (AC2, AC4).
They are called out here rather than buried so this is not filed as a passed gate.

## 1. What this gate decides

RFC-0001 (`rfcs/0001-batch-cycles.md`, on branch `docs/batch-cycles-rfc` — it is not on `main`)
Migration Step 3 + §H. Step 3 asks for the first real batches on the lowest-risk classes
(docs/chore/config/test-only), N ≤ 4 members, `max_slots = 3`, one batch at a time, and a
committable report carrying the go/no-go for widening.

Issue #473's AC5 states the bar this report is judged against, restating §H:

> ≥ 40% token reduction on the cohort; **regressions ≤ baseline is a hard gate**.

**One qualification on that restatement.** §H frames the −40% figure in a column headed *"Target
after Step 4"* — i.e. after widening — not as the Step-3 entry gate. #473 applies it as the Step-3
cohort gate. This report evaluates it as #473 asks, but the distinction matters for how a
near-miss should be read at Step 3. The regressions-≤-baseline hard gate is unqualified in §H and
applies here as written.

Widening eligibility, concurrent batches and fleet-cycle deprecation are all gated on this report
(#473 non-goals; epic #474 Step 4).

### 1.1 Verdict against every §H metric

§H specifies eight metrics, not two. All eight, with what this run could establish:

| §H metric | §H target (after Step 4) | baseline measured here | pilot | verdict |
|---|---|---|---|---|
| Tokens per completed issue | **−40% or better** | $16.00 / 47.1 M billable in / 161 k out (n=5) | — | **not computable** |
| Wall-clock per issue & makespan | makespan −30%+; per-issue latency +≤25% | median 51.0 min; makespan 10.24 h (heavily qualified — §3.4) | — | **not computable** |
| Slot occupancy while runnable work exists | > 90% | **not measured** — outside this report's scope; measured for the scheduler in `sched-parity.md` | — | not evaluated |
| Full CI executions per issue | ≈ −60%+ | 2.73 workflow runs / 1.09 CI cycles | — | **not computable** |
| Eviction / dissolve rate | < 10% / < 2% | N/A — no batches | — | **not computable** |
| Misclassification (slot→full) | < 10%, trending down | **no denominator** — 0/11 classified (§3.5) | — | **not computable** |
| Human interventions per issue | ≤ baseline | **0** | — | **not computable** |
| Regressions within 7 days | **≤ baseline — hard gate** | 0, over a **0-day** window (§3.6) | — | **not evaluable** |

A hard gate that cannot be evaluated is not a passed gate. Hence NO-GO.

## 2. Method

### 2.1 Environment

| Item | Value |
|---|---|
| Execution host | `hcc2` — the only host reachable from this run (see §4.3) |
| CLI | `@ai-dossier/cli` 0.19.1 |
| Scheduler | `ai-dossier sched` (`packages/sched`), project `imboard-ai-ai-dossier`, `max_slots = 3` |
| Repo under measurement | `imboard-ai/ai-dossier` (this repo) |
| Baseline cohort | 11 issues — #495, #496, #497, #499, #500, #501, #502, #503, #505, #506, #507 — sched-dispatched full-cycle, 2026-09-01 04:02Z → 14:16Z |
| Excluded from the cohort | #504 (assigned on the same engine at 14:22:04Z, still in flight at snapshot time); #498 is a PR number, not an issue |
| Pilot cohort | **empty** |

### 2.2 Metric definitions

Carried from the Step-1 exit-gate report (`sched-parity.md` §2.4) so the two gate reports compare
directly.

- **Wall-clock per issue** — `assigned` → the first subsequent `verify-complete`/`exit-detected`
  for that issue, else the next `assigned` on the same slot (slot handoff is the observable
  release). Distinct from *agent runtime*, which is the agent process's own `duration_ms` and
  excludes the PR/merge watch.
- **Makespan** — first cohort `assigned` → last cohort merge.
- **Tokens per completed issue** — from the agent's own result record, summed over its
  `modelUsage` map: `inputTokens + cacheCreationInputTokens + cacheReadInputTokens` (billable
  input) and `outputTokens`. `modelUsage` is used rather than the record's top-level `usage`
  block because only `modelUsage` reconciles with `total_cost_usd` — see §3.2. Reported with the
  cache-read split, because that split is where batching's claimed lever actually is.
- **Full CI executions per issue** — GitHub Actions runs with `event == "pull_request"` on the PR's
  head branch. Reported two ways: *workflow executions* (every workflow, every SHA) and *distinct
  head SHAs* (CI cycles). The second is the batch-comparable one.
- **Eviction rate** — evicted members ÷ batch members. **Misclassification rate** — classifier
  verdicts contradicted by the run's outcome ÷ classified issues.
- **Human interventions** — `status=blocked` runstate milestones + issues left carrying
  `decision-pending`.
- **Regressions** — reverts or hotfixes touching a cohort merge within 7 days of it landing.

### 2.3 Data sources

| source | what it gave | completeness |
|---|---|---|
| `~/.dossier/sched/imboard-ai-ai-dossier/events.jsonl` (197 events) | slot timing, dispatch, recovery events | 11/11 issues; snapshot committed as [`evidence/batch-pilot-sched-events.jsonl`](./evidence/batch-pilot-sched-events.jsonl) |
| `~/.dossier/sched/.../runs/issue-<n>.log` | tokens, cost, turns, agent runtime | **5/11** — six logs are 0 bytes |
| `gh run list --event pull_request` | CI executions per PR | 11/11 |
| runstate trails on GitHub issues | phases, blocked milestones, tail completeness | 11/11 |
| `git log origin/main` | reverts/hotfixes | full history |
| `~/.dossier/runs.jsonl` (hcc2, 1111 rows at read time) | **no token data** — see below | — |

**The AC's named token source carries no tokens.** AC3 specifies `~/.dossier/runs.jsonl` as the
token/duration source. On this host it carries `input_tokens`, `output_tokens` and
`total_cost_usd` as **null in 622 of the 623** rows that have those keys at all — the single
populated row is a synthetic `opencode` probe from #459. `duration_ms` is present on all 623 rows
but measures the `ai-dossier run` CLI invocation (median 0.8 s, max 12 s), not an agent run.

`sched-parity.md` §2.5 reports the same nulls across all three hosts **for its own window
(2026-08-29 → 08-30)**, and attributes them to a scoped cause: *"opencode-spawned runs don't
populate them"* / *"tokens are only logged for `ai-dossier run`-spawned agent runs"*. **This
host's 2026-09-01 data does not support that cause.** The cohort here was claude-spawned, not
opencode-spawned, and its rows are null too; the one populated row is itself an opencode probe.
The gap is therefore broader than #471 diagnosed — `runs.jsonl` does not receive token data from
sched-dispatched agents at all, regardless of agent CLI.

The usable per-issue token source is the scheduler's own per-agent logs, used here.

## 3. Results — baseline arm

Full per-issue table and every derivation: [`evidence/batch-pilot-baseline.md`](./evidence/batch-pilot-baseline.md).

### 3.1 Headline

| metric | baseline (full-cycle, `max_slots=3`, hcc2) | n |
|---|---|---|
| billable input tokens / issue | **47,105,733** (98.5% cache-read) | 5 |
| fresh (uncached) input / issue | 690,185 | 5 |
| output tokens / issue | **161,082** | 5 |
| cost / issue | **$16.00** | 5 |
| agent turns / issue (main thread) | 82.6 | 5 |
| CI workflow executions / issue | **2.73** | 11 |
| CI cycles (distinct head SHAs) / issue | **1.09** | 11 |
| slot wall-clock / issue | median **51.0 min**, mean 46.1 min excl. #499 | 10 |
| agent runtime / issue | 17.6 min | 5 |
| makespan | 10.24 h for 11 issues = 1.07 issues/h — **a floor, not a 3-slot rate** (§3.4) | 11 |
| human interventions | **0** | 11 |
| regressions | **0** (0-day window — see §3.6) | 11 |
| eviction rate | N/A — no batches | — |
| misclassification rate | **not computable** — 0/11 carry a classify record (§3.5) | — |

### 3.2 Tokens — which number, and where the lever is

The agent result record carries two token accountings, and they disagree by 1.75× on input and
3.76× on output. Only one of them reconciles with the cost actually billed:

| accounting | billable input | output | reconciles with `total_cost_usd`? |
|---|---|---|---|
| top-level `usage` block | 134,335,521 | 214,221 | **no** |
| `modelUsage` map (used here) | **235,528,664** | **805,411** | **yes — to the cent, all 5 issues** |

The top-level block counts the main thread only; the review phase's parallel agents and every
other subagent are absent from it. Since full-cycle's review phase is explicitly a multi-agent
fan-out, the top-level figure understates a full-cycle issue's real token cost by roughly 43%.
**Any future "≥40% token reduction" comparison must use `modelUsage` on both arms** — comparing a
`modelUsage` batch arm against a top-level baseline would manufacture most of the target out of an
accounting mismatch.

On the `modelUsage` basis: 232,077,741 of 235,528,664 billable input tokens (**98.5%**) are cache
reads; fresh input is 3,450,923 total. Cost per issue is $16.00, ranging $6.24 (#506, 41 main-thread
turns) to $29.62 (#500, 149 turns) — cost tracks turn count closely.

This matters for how the −40% target should be read. Batching's structural claim is that N issues
share one worktree, one warm-up and one context, so shared context is read once per *batch* rather
than once per *issue*. That is a claim about the 98.5%, and it is testable against this baseline as
soon as a batch runs. It is **not** a claim about fresh input, which is dominated by per-issue work
that batching does not remove.

### 3.3 CI executions

30 `pull_request` workflow runs across 11 issues (2.73/issue) on 12 distinct head SHAs
(1.09/issue). The gap is workflow count, not retries — each PR fires `CI`, `Neon Branch Cleanup`,
and `Test Examples` when `examples/` changed. Only #500 needed a second SHA (one failed `CI` run,
fixed by one push).

**1.09 CI cycles/issue is already close to the floor of one.** A 4-member batch merging as one PR
would take this to ~0.25 cycles/issue *if the batch PR needs only one CI cycle* — arithmetically
the largest single lever identified, and against §H's ≈−60% CI target the one most likely to clear.
That is a projection from the batch structure, not a measurement: no batch PR has run, and a batch
that needs a second CI cycle spends it on behalf of all four members.

### 3.4 Wall-clock and makespan — read this one carefully

Median slot wall-clock 51.0 min over n=10 (22.0 min min, 205.5 min max); mean 46.1 min excluding
#499's 205.5 min, which is not really a runtime at all but a leaked slot (§3.7, event 3).

Makespan is 10.24 h for 11 issues = 1.07 issues/h, and **that number should not be quoted as a
three-slot throughput rate**. The committed journal shows the window was nowhere near saturated:

- **Slots 2 and 3 were never assigned before 10:56:37Z.** The first 6.9 h of the window ran
  effectively single-slot (slot 1 from 04:02:01Z; slots 2 and 3 first occupied simultaneously at
  10:56:37Z).
- **A 3.42 h stretch of total engine silence** sits inside the makespan: `verify-complete #507` at
  07:31:17Z → `assigned #502` at 10:56:37Z, with zero journal events and zero slots occupied — a
  third of the whole window.

1.07 issues/h is therefore a **floor**. A saturated three-slot window would be materially faster,
and §H's "makespan −30%+" target cannot be honestly measured against an unsaturated baseline.

### 3.5 Interventions, tails, and the missing classifier denominator

**0 blocked milestones, 0 issues left `decision-pending`, 11/11 closed — zero human
interventions.** That is a strong result for the scheduler arm and the number a batch arm has to
match (§H: interventions ≤ baseline).

Two caveats the batch arm inherits:

- **Tail completeness 6/11.** #495, #496, #497, #499 and #505 never posted a `report done`; #499
  stopped after `review`. Their PRs merged anyway. This is the tail-bug class `sched-parity.md`
  named as its conditional-GO contingency (#496/#500) — still visible in this cohort.
- **Misclassification rate has no denominator.** None of the 11 issues carry a `phase=classify`
  record; they were enqueued directly as `mode=full`. To measure misclassification at all, the
  pilot cohort must be routed through `issue-cycle-classifier` rather than enqueued by hand.

### 3.6 Regressions — the hard gate cannot be read yet

0 commits on `main` after the cohort merged; 0 reverts, 0 hotfixes. Observed regressions: **0**.

But the cohort merged 2026-09-01 04:26Z–14:16Z and this report is dated 2026-09-01. **0 of the 7
days have elapsed.** "Regressions ≤ baseline" is §H's hard gate, and a 0-day observation window
establishes neither side of it. Any go/no-go issued today would be asserting a hard gate it did not
measure.

### 3.7 Failure and recovery narration (AC4)

No evictions or dissolves occurred — there were no batches to evict from. Three real
failure/recovery events sit in the window; two auto-recovered, one did not.

1. **#500 / PR #510 — CI failure. Recovered.** One failed `CI` run on the first head SHA; the run
   pushed a fix, the second SHA merged (`3e5a394`). Recovery path: the agent's own CI-fix loop,
   1 attempt, no escalation.
2. **#473 — unverified exit → tier escalation. Recovered.** At 14:26:06Z the journal records
   `verify-incomplete` (`detail: unverified-exit`, `observed: milestone gate/blocked; closed=false`)
   immediately followed by `redispatched` at `tier: strong`. The first #473 agent
   (`claude-sonnet-5`) had exited after 4.0 min having posted `phase=gate status=blocked
   reason=scope-exceeds-autonomous-cycle`. The scheduler caught the unverified exit and redispatched
   one tier up. **That redispatch is the run that produced this report** — the escalation ladder is
   working, and it converted a second hand-off into a delivered artifact.
3. **#499 — leaked slot, 2 h 44 m. NOT recovered automatically.** The scheduler itself observed the
   work was finished: `{"ts":"2026-09-01T11:38:06.401Z","event":"external-advance","issue":499,
   "slot":2,"detail":"issue closed"}`. Slot 2 was nonetheless **not reassigned until
   `assigned issue:473` at 14:22:04.780Z** — 2 h 44 m later — while slot 1 serially cycled #506
   (11:32Z), #501 (11:54Z), #495 (12:56Z) and #503 (13:46Z) with work available the whole time.
   This leak *is* the entire 205.5 min #499 "outlier" in §3.4. Recovery path: **none automatic** —
   the slot was freed only when the next dispatch happened to claim it. This is the same failure
   class (*slots idle while runnable work exists*) that RFC-0001 Step 1 set out to eliminate and
   that `sched-parity.md` measured at 99–100% occupancy; it is visible again here and is worth a
   filed issue against `packages/sched` release-on-`external-advance`.

## 4. Why the pilot arm is empty

Three independent blockers. Each alone is sufficient; all three are live.

### 4.1 Zero batches exist, and the eligible backlog is not known to hold three

- `ai-dossier sched status` → `== Batches == (no batches)`. The journal's 197 events contain no
  batch event of any kind.
- The only batch artifact is **anchor #490** (`b-20260829-01`, members #487/#488/#489). Its body
  states: *"this anchor was created by a batch-issues-preparation **dry-run** — members are NOT
  enqueued."* It has no runstate trail.
- **Only three open issues are classified slot-eligible.** #487, #488 and #489 carry `cycle:slot`
  — three docs issues, exactly one ≤ 4-member batch. Of the remaining open issues, six are
  labelled `cycle:full` (#20, #21, #26, #28, #49, #430) and **seven carry no cycle label at all**
  (#9, #14, #15, #18, #23, #24, #25). None is `cycle:slot`.
- **The honest form of this claim**: the seven unlabelled issues have never been through
  `issue-cycle-classifier`, so the true slot-eligible count is *unknown*, not proven to be three.
  By title they are large feature/tooling items (VS Code extension, JetBrains plugin, CLI UX,
  web playground, signing UI, pre-commit hooks, case studies) and none reads as
  docs/chore/config/test-only — but AC1 needs ~9–12 eligible issues for three batches, and
  asserting the count either way requires classifying the backlog first (§5.3).
- The issue itself predicted the shortfall: *"partially operational — needs a real backlog (imboard
  monorepo or this repo)."*

### 4.2 Batch execution was not permitted from this session

`ai-dossier sched enqueue --issues 487,488,489 --mode slot --batch b-20260829-01 --tier mechanical`
was **denied by the executing environment's permission classifier**. The denial was not worked
around. A run that cannot enqueue cannot pilot.

### 4.3 Multi-host aggregation is unreachable, and points at an empty source anyway

AC3 requires baseline *and* pilot data aggregated across wls, hcc and hcc2.

- This host is **`hcc2`** (`hostname` = `hcc2`). The AC's "wls" is a different box.
- `ssh hcc` → DNS resolution failure. Direct-IP attempts at the two other hosts → *Permission
  denied (publickey)*. No outbound credentials exist here.
- `sched-parity.md` §2.5 documents the workaround used for the Step-1 gate: a **wls supervisor
  session** read the other hosts and posted the per-host table as an issue comment, pulling the
  data *to* the run rather than giving the run credentials. No such comment exists for this window.
- **AC3's token half cannot be satisfied on any host** — the source it names carries no token data
  anywhere (§2.3). Its duration/aggregation half *is* satisfiable, via the same wls-supervisor read
  used for the Step-1 gate; it simply was not performed for this window. `sched-parity.md` §4.4
  marks its equivalent AC met under the identical null-token condition by substituting the agent
  CLIs' own usage records — the same substitution this report makes (§2.2).

## 5. Exit criteria — what must be true before Step 3 is re-attempted

Ordered by what blocks what. §5.1–§5.3 gate any pilot at all; §5.4–§5.5 gate a *valid* go/no-go.

**5.1 — An eligible backlog of ≥ 9 lowest-risk issues**, or explicit authorization to run the pilot
against the imboard monorepo's backlog (which has the volume), with the report still landing here.
Three batches cannot be composed from three known-eligible issues.

**5.2 — A session permitted to run `ai-dossier sched enqueue`.** The pilot is an ops action with
real merges; the executing session must be authorized for it up front, not discover the denial
mid-run.

**5.3 — Classify the backlog, and route the pilot cohort through `issue-cycle-classifier`** rather
than enqueueing by hand. This does double duty: it establishes the real slot-eligible count (§4.1)
*and* gives misclassification rate a denominator (§3.5). Without it, AC2 ships incomplete again.

**5.4 — A working per-issue token source, measured the same way on both arms.** Two parts:
(a) file a follow-up against the #458 telemetry — #458 is closed and shipped, but `runs.jsonl` is
not populating tokens for sched-dispatched agents (§2.3), so it needs a new issue, not a reopen —
or amend AC3 to name the scheduler's per-agent logs as the source of record; (b) fix whatever left
6 of 11 agent logs at 0 bytes in this window; and (c) pin **`modelUsage`**, not the top-level
`usage` block, as the token accounting on both arms (§3.2) — mixing them fabricates a ~43% "saving".

**5.5 — ≥ 7 days between the pilot cohort's last merge and the report.** §H's hard gate is a 7-day
revert/hotfix window; it cannot be compressed into the same sitting as the batches. Structure the
next attempt as *run the batches → wait → write the report*, and expect the report to be a separate
run from the execution.

Recommended sequencing: close §5.2 and §5.4 first (both small, and both unblock measurement), then
§5.1 and §5.3 together at batch-prep time, run the batches, and schedule the report ≥ 7 days out.
Separately worth filing before the retry: the §3.7 event-3 slot leak, which would distort any
makespan comparison it appeared in.

## 6. Limitations

- **Single host.** Everything measured here is `hcc2`. Cross-host aggregation was not possible
  (§4.3).
- **Arm size is below §H's own method.** §H specifies **≥ 20 issues per arm** for the A/B. This
  baseline is 11 issues, and its token arm is n=5. It is the best available comparison set, not a
  §H-conformant one.
- **Token arm is 5 of 11 issues.** Six agent logs are 0 bytes. No figure is extrapolated to the
  missing six; the means in §3.1 are over n=5 and labelled as such.
- **Baseline cohort is `sched`-dispatched full-cycle, not fleet-cycle.** It is the correct
  comparison for a batch arm on the same scheduler, but it is not the RFC's original Step-0
  fleet baseline — that one lives in `sched-parity.md` §2.3 and ran against a different repo.
- **The baseline window was not slot-saturated.** Slots 2 and 3 were unused for the first 6.9 h and
  a 3.42 h engine gap sits inside the makespan (§3.4), so makespan and throughput are floors.
- **One-day window, one repo, one issue class mix.** The 11 issues are mostly `packages/sched` bug
  fixes; a docs-only batch cohort would not be like-for-like on token or CI cost even once it runs.
- **Wall-clock for #497 is underivable** (its slot was never handed off inside the snapshot), and
  #499's 205.5 min is reported but excluded from the mean as a stated leaked slot (§3.7).
- **Slot occupancy is not measured here.** §H lists it; `sched-parity.md` measured it for the
  scheduler arm and this report does not re-derive it.

## 7. Acceptance criteria

| AC | status | where |
|---|---|---|
| AC1 — ≥ 3 batches executed end-to-end, lowest-risk classes, `max_slots=3`, one at a time | ❌ **UNMET** — 0 batches executed | §4 |
| AC2 — metrics vs the Step-0 baseline (tokens, CI, wall-clock + makespan, eviction, misclassification, regressions, interventions) | ⚠️ **PARTIAL** — baseline arm delivered for every metric that has a source; pilot arm empty; misclassification has no denominator; regression window 0/7 days; slot occupancy not re-derived | §3, §1.1 |
| AC3 — token/duration aggregated across wls, hcc, hcc2 `runs.jsonl`, each on CLI ≥ 0.13.0 | ❌ **UNMET** — other hosts unreachable, and the named source carries no token data on any host | §4.3, §2.3 |
| AC4 — every eviction/dissolve/failure narrated with its recovery path | ⚠️ **PARTIAL** — 0 evictions/dissolves (no batches); all three real failure events narrated, but one (#499's leaked slot) has **no recovery path** to narrate and needs a fix, not a description | §3.7 |
| AC5 — report committed at `docs/reports/batch-pilot.md` with go/no-go against §H | ✅ **MET** — this document; verdict **NO-GO** | §Recommendation, §1.1 |

## 8. Appendix — evidence

- [`evidence/batch-pilot-baseline.md`](./evidence/batch-pilot-baseline.md) — per-issue table and
  every derivation
- [`evidence/batch-pilot-sched-events.jsonl`](./evidence/batch-pilot-sched-events.jsonl) — 197-event
  scheduler journal snapshot covering the baseline window
- [`sched-parity.md`](./sched-parity.md) — RFC-0001 Step 1 exit gate, the preceding report in this
  series
- Batch anchor #490 (dry run) · epic #474 · cohort PRs #509, #510, #512–#520
