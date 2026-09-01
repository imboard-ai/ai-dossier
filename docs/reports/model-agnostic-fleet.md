# Model-agnostic fleet validation — claude arm vs open-weights arm

**Status: PARTIAL — instrument fixed, retrospective measured, pre-registered live run NOT executed.**
**Run:** `r-528-655b` (generation 1) · issue [#528](https://github.com/imboard-ai/ai-dossier/issues/528) · executing host: `hcc2` · 2026-09-01

## Recommendation

**Nothing measured here contradicts the model-agnostic promise.** Across 14 real `glm-5.3` runs on
this repo the delivery rate was **86%** (12/14), against **86%** (18/21) for `claude-sonnet-5` over
an adjacent window of the same backlog — indistinguishable at this sample size. The one `blocked`
open-weights run was blocked by an **npm publish 404 on a new scope**
([#460](https://github.com/imboard-ai/ai-dossier/issues/460),
`reason=publish-e404-new-scope-package`) — infrastructure, not model competence.

That parity is the claim this report supports. It is **not** a claim that open-weights models are
as good: glm's median run is roughly twice sonnet's, and neither arm was pre-registered.

This is a **retrospective**, not the controlled experiment [#528](https://github.com/imboard-ai/ai-dossier/issues/528)
AC1 asks for: the arms were not pre-registered, not cohort-matched, and not run concurrently. Read
the recommendation below as *provisional and directional*, not as the GO/NO-GO verdict. The
pre-registered run is specified in §5, together with the one owner decision blocking it.

### Acceptance-criteria scorecard

Verdicts from this run's independent (blind) conformance review, not from the author:

| AC | verdict | why |
|---|---|---|
| AC1 — two-arm live cohort, ≥8 issues per arm | **NOT MET** | no live dispatch occurred; only AC1's mode conditional is satisfied (§2.4) |
| AC2 — per-arm metrics (7 named) | **PARTIAL** | delivery rate + wall-clock delivered; evictions legitimately N/A; escalations/issue, conformance-not-met rate, 7-day regressions, and tokens+$ not measured (§6 items 3–4) |
| AC3 — per-model breakdown via `runstate stats` buckets | **PARTIAL** | the buckets now aggregate correctly (§3) — but the AC's per-*class* / per-*tier* axis does not exist in the tool |
| AC4 — tier→model mapping, rescue tier justified by measured escalation frequency | **PARTIAL** | mapping is per project, not per issue class; the rescue-tier justification needs the live run (§4.4) |
| AC5 — open-weights failures not caught by guardrails get their own issue | **PARTIAL** | none found in the retrospective, and the trails support that — but the exercise that would surface them never ran |

`ac_met=0 ac_total=5`. **#528 stays open.** This report and the CLI fix advance it; they do not
close it.

**Provisional tier→model mapping** (§4.4 has the reasoning):

| project | mechanical | mid | strong | rescue |
|---|---|---|---|---|
| `imboard-ai/ai-dossier` | glm | glm | claude sonnet | claude opus |
| `imboard-ai/imboard-monorepo` | glm | claude sonnet | claude opus | claude opus |

## 1. What this report decides

Issue #528's premise: the system's core promise is confidence *independent of model strength* —
guardrails (blind conformance, CI, review, verification-over-trust) are what make weaker models
safe. Batching ([#523](https://github.com/imboard-ai/ai-dossier/issues/523)/[#526](https://github.com/imboard-ai/ai-dossier/issues/526))
shares those guardrails, so it must be shown not to erode the promise on open-weights models.

This document reports three things, in order of how firmly they are established:

1. **A defect in the measurement instrument itself, found and fixed** (§3) — AC3 names
   `runstate stats` `model=` buckets as the mechanism for the whole comparison, and that mechanism
   was aggregating one model into several rows.
2. **The measured retrospective** (§4) — what the trails both arms have *already* produced say,
   now that they aggregate correctly.
3. **The pre-registered protocol for the live two-arm run** (§5), and the single decision blocking it.

## 2. Method

### 2.1 Environment

| Item | Value |
|---|---|
| Execution host | `hcc2` (16 vCPU, 30 GB RAM) — **this run executed on the target host itself** |
| CLI | `@ai-dossier/cli` 0.24.0 → 0.25.0 (this PR) |
| Scheduler | `ai-dossier sched` (`packages/sched` 0.12.0): `max_slots=3`, dispatch `claude -p --output-format json --model {model}`, `tier_models` = haiku/sonnet/opus |
| Per-tier dispatch | `DispatchConfig.tiers` ([#527](https://github.com/imboard-ai/ai-dossier/issues/527)/[#533](https://github.com/imboard-ai/ai-dossier/issues/533)) present — a tier can point at a different agent CLI, which is what the open-weights arm needs |
| Open-weights CLI | `~/.opencode/bin/opencode`, authed for `openrouter`, `zai-coding-plan`, `alibaba-token-plan`, `llmgateway` |
| Data sources | runstate trails on GitHub (both repos); `~/.dossier/runs.jsonl` via `ai-dossier sched stats` ([#524](https://github.com/imboard-ai/ai-dossier/issues/524)) |

**Host-access correction.** Generation 0 of this run blocked at `plan` with
`reason=requires-hcc2-execution-access`, on the claim that the session had no SSH access to
`hcc2`. That claim was **wrong and is retracted**: it came from `ssh hcc` failing to resolve, but
`hcc` is a different host (Hetzner). `hostname` on this session is `hcc2`. The host, the
scheduler, the open-weights CLI, and its credentials were all present the whole time.

### 2.2 Arm definition (retrospective)

The arms were **not** pre-registered. They are the two model populations that the recorded
`model=` key separates on real work already done:

| arm | models | issues |
|---|---|---|
| open-weights | `glm-5.3` (recorded as `glm-5.3` and `llmgateway/glm-5.3`) | ai-dossier #460–#472, #477 (14 runs) |
| claude | `claude-sonnet-5`, `claude-opus-5` | ai-dossier #473, #495–#507, #523–#528, #535–#536 (21 runs) |

Plus the [#471](https://github.com/imboard-ai/ai-dossier/issues/471) parity cohort on
`imboard-ai/imboard-monorepo`, which is the closest thing to a matched pair that exists today:
same repo, same scheduler, same dispatch prompt, same warmup path, workloads W1/W2 on claude and
W3 on open-weights (`docs/reports/sched-parity.md` §2.2 for the workloads, §4.3 for the per-arm
model attribution).

### 2.3 Metric definitions

- **Delivered / delivery rate** — a run whose last milestone is `ship`, `report`, `batch-ship` or
  `batch-report` at `done`. `ship done` counts because it is posted only after merge *and*
  teardown are confirmed; the report tail is routinely a separately dispatched run, so scoring on
  `report` alone would mark the delivering run unfinished (see §6 item 2).
- **Blocked** — a run whose last milestone is `status=blocked`, whatever the phase.
- **Open** — everything else: in flight, parked `awaiting-merge`, `partial`, or fenced.
- **Wall-clock** — first to last milestone `at=` of a run.

### 2.4 Execution mode for the live arms (AC1's conditional)

AC1: *"batch mode if #526 has passed, full-cycle otherwise, stated explicitly."*

**#526 has not passed** — it is OPEN, and its own execution record
(`docs/reports/batch-pilot-2-execution.md`) reports 0 of ≥3 batches executed against its AC1.
One batch defect is open as of this writing:
[#535](https://github.com/imboard-ai/ai-dossier/issues/535) (batches never seal `forming`→`ready`);
[#536](https://github.com/imboard-ai/ai-dossier/issues/536) (batch anchor missing from the enqueue
path) was open during this run and closed at 21:50Z.

**Therefore the live arms run in full-cycle mode, not batch mode.** Stated explicitly, as AC1
requires. The AC2 "evictions (batch mode)" metric is consequently **N/A** for this validation.

## 3. The instrument was broken (AC3)

AC3 asks for the per-model breakdown *via* `runstate stats` `model=` buckets. Measured against
real trails before this PR, those buckets split single models across rows:

| corpus | recorded spellings | what the tool did |
|---|---|---|
| ai-dossier #460–#538 | `glm-5.3` (7 runs) **and** `llmgateway/glm-5.3` (7 runs) | one model, two rows — a 14-run sample halved |
| imboard-monorepo #471 cohort | `z-ai/glm-latest` (2) **and** `~z-ai/glm-latest` (1) | one model, two rows (opencode's `~` gateway-alias marker) |
| imboard-monorepo #471 cohort | `openrouter-kimi-latest` | not comparable with a `moonshotai/kimi-latest` spelling |

Agents record whatever id their CLI was invoked with, and the routing prefix varies with how the
model was reached. Unbucketed, the per-model view — the entire reason the gate records `model=` —
cannot answer "which tiers are safe". **Running a 16-unit two-arm cohort before fixing this would
have produced data the tool then mis-aggregated**, so the instrument was fixed first.

The fix (`cli/src/runstate-stats.ts`):

- `canonicalModel()` lowercases, drops a leading `~`, and peels **known** routing tokens
  (`llmgateway`, `openrouter`, `moonshotai`, `anthropic`, `alibaba`, `google`, `openai`, `z-ai`,
  `zai`) joined by `/` or `-`. It is an allowlist, never a generic "drop the first segment" rule —
  merging two genuinely different models is the one error this table cannot survive.
- Every bucket reports `aliases`, and the renderer prints `folded: …`, so a merge is always
  visible rather than silently reshaping someone's cohort.
- Buckets gained **outcome** columns — `done`, `blocked`, `open`, `rate` — because duration alone
  never answers "which tiers are safe".

## 4. Results

### 4.1 `imboard-ai/ai-dossier`, issues #460–#538

`ai-dossier runstate stats --issues 460..538`, **captured 2026-09-01T22:33Z**. This corpus is
live: runs in flight at capture time land later, so a re-run gives different `unfinished` and
`rate` cells (between two captures 50 minutes apart, sonnet moved 20→21 runs and 80%→86%). The
§4.2 monorepo block below is a closed window and reproduces byte-identically.

```
model            runs  delivered  blocked  unfinished  rate   n     median total              min               max
<unknown>           6          0        0           6    0%   0                -                -                 -
claude-opus-5       1          1        0           0  100%   1    1h 8m (4115s)    1h 8m (4115s)     1h 8m (4115s)
claude-sonnet-5    21         18        0           3   86%  21  44m 55s (2695s)  19m 45s (1185s)   2h 47m (10054s)
glm-5.3            14         12        1           1   86%  14   1h 30m (5419s)   49m 7s (2947s)  20h 56m (75372s)  folded: llmgateway/glm-5.3
```

- **Delivery rate: glm 86% (12/14) and sonnet 86% (18/21) — a dead heat at this sample size.**
  The three sonnet "unfinished" runs were live at capture time, not failures. The comparison is
  directional, not a controlled result.
- **The single open-weights `blocked` is not a model failure.** #460 blocked at `ship` with
  `reason=publish-e404-new-scope-package` — an npm 404 publishing a newly scoped package, after
  `merge_commit=c7580ae` had already landed. The guardrail did exactly its job: it stopped and
  named an infrastructure cause instead of guessing.
- **glm's median run is ~2× sonnet's** (1h 30m vs 43m). The 20h 56m maximum is #471 — the parity
  validation itself, a 17-hour ops workload, not a comparable code issue.
- The `<unknown>` bucket is 6 `classify` verdict records, which carry no `model=` and are not
  full-cycle runs. The tool now says so itself rather than leaving the `0%` to be misread — it
  emits `6 run(s) recorded no model= … not attributable to any model` on the warnings channel.

### 4.2 `imboard-ai/imboard-monorepo`, the #471 parity cohort

`ai-dossier runstate stats --repo imboard-ai/imboard-monorepo --issues 3891,3862,3810,3886,3890,3889,3756,3500,3433,3414,3408,3824`:

```
model            runs  delivered  blocked  unfinished  rate  n     median total              min              max
claude-sonnet-5     8          5        0           3   63%  8    2h 1m (7290s)    1h 5m (3959s)  7h 39m (27551s)
glm-latest          3          2        1           0   67%  3   1h 48m (6539s)   13m 46s (826s)  9h 24m (33898s)  folded: z-ai/glm-latest, ~z-ai/glm-latest
kimi-latest         1          1        0           0  100%  1  8h 47m (31628s)  8h 47m (31628s)  8h 47m (31628s)  folded: openrouter-kimi-latest
```

This is the same-repo, same-scheduler pairing #528 asks for, at 1/4 the cohort size per arm and
without pre-registration. Both arms land in the same band (63% vs 67%/100%); the three sonnet
"open" runs are `ship/awaiting-merge` trails whose report tail was dispatched as a separate run
(§6 item 2). The open-weights `blocked` is #3414 at `plan` — an issue that is *still* labelled
`decision-pending` on the monorepo, i.e. the model stopped where it was supposed to.

### 4.3 Guardrails held on the open-weights arm

The point of the exercise is whether guardrails catch what a weaker model gets wrong. Evidence
from the trails, not from inference:

- **#472 (glm, `llmgateway/glm-5.3`)** ran the **full 7-agent review tier** — `tier=full`,
  `agents_done=1,2,3,4,5,6,7`, `agents_pending=none` — reported `ac_met=6 ac_total=6` and
  `escalated=1`. A weaker model ran the strongest review tier and escalated rather than shipping.
- **#460 (glm)** blocked with a named infrastructure `reason=` instead of self-merging around it.
- The open-weights-specific failures from the earlier anecdotal parity work were all caught and
  filed — permission auto-rejects ([#506](https://github.com/imboard-ai/ai-dossier/issues/506)),
  headless-wait exits ([#497](https://github.com/imboard-ai/ai-dossier/issues/497)), unverified
  exits at the strongest tier ([#505](https://github.com/imboard-ai/ai-dossier/issues/505)).

**No open-weights-specific failure that escaped the guardrails was found in this retrospective**
(AC5). The one defect this exercise did find is in the *measurement* path, and it is fixed in this
PR rather than filed.

### 4.4 Provisional tier→model mapping (AC4)

Justified by §4.1–§4.3, and provisional pending the live run:

- **`ai-dossier`: glm for mechanical and mid; claude sonnet strong; opus rescue.** 14 glm runs on
  this repo delivered 86% with zero model-attributable blocks — the same rate as sonnet's 18/21
  on an adjacent window of the same backlog. On a codebase whose work is CLI/TypeScript with
  dense tests, nothing measured justifies paying for sonnet at the mid tier. The cost of the
  choice is wall-clock, not correctness: glm's median run is ~2× sonnet's, so on a 3-slot
  scheduler this trades slot occupancy for token price, and that trade is the reason to keep it
  provisional until the live run measures both.
- **`imboard-monorepo`: claude sonnet at mid.** The open-weights sample on that repo is 4 runs
  (3 glm + 1 kimi) — too thin to route a production monorepo on, and its median run was long
  enough (1h 48m–8h 47m) that slot cost, not token cost, dominates.
- **Rescue tier = opus, both projects.** #504 is the only opus run in the corpus (1/1 delivered);
  measured escalation frequency is too small a sample to justify anything but keeping the
  strongest model as the rescue rung. AC4 asks for the rescue tier to be *justified by measured
  escalation frequency* — that measurement needs the live run.

## 5. The pre-registered live run (AC1/AC2) — NOT EXECUTED

Specified here so whoever authorizes it executes rather than re-derives:

| item | value |
|---|---|
| Mode | **full-cycle**, not batch (§2.4) |
| Scheduler | `ai-dossier sched enqueue --issues … --mode full --tier mid` then `ai-dossier sched start`, on `hcc2` |
| Claude arm | `tier_models` = `{mid: sonnet, strong: opus}` (current default config — no change needed) |
| Open-weights arm | `dispatch.tiers` = `{mid: {command: [opencode CLI…], model: z-ai/glm-latest}, strong: {…, model: moonshotai/kimi-latest}, rescue: claude opus}` — the `tiers` spec from #527/#533 |
| Cohort | ≥ 8 lowest-risk classifier-routed issues **per arm**, same repo, same class mix, dispatched concurrently |
| Metrics | delivery rate, escalations/issue, conformance not-met, wall-clock — all via `ai-dossier runstate stats` (now correctly bucketed); tokens + $ via `ai-dossier sched stats` |
| Verdict | after a 7-day regression window, in a follow-up issue — the #526→#529 pattern |

**Why it was not executed in this run:** it needs an ≥ 8-issue × 2-arm live dispatch against a
real backlog with real multi-provider billing (the single-arm #471 precedent cost ~$250 in claude
tokens alone — `sched-parity.md` W1 $111.06 + W2 ≥$141.76 — plus glm/kimi spend) and it merges its
cohort's PRs into that repo. That is a spend and blast-radius commitment, not an implementation
detail, and this generation was dispatched by the scheduler — no human has read the escalation.

### 5.1 The decision, with options

**Decision:** authorize the live two-arm run — naming cohort repo, spend ceiling, and sequencing —
or decline it and re-scope #528's AC1.

| option | pros | cons |
|---|---|---|
| **A. `imboard-monorepo`, ~$600 ceiling, run now** *(recommended)* | Both precedents (#471, #526) used it; 118 open issues, so a ≥8-per-arm same-class cohort is actually available; the backlog is where the fleet really runs, so the result generalises | Highest blast radius — 16 agent-authored PRs merge into the production monorepo; ~$600 is ~2.4× the single-arm #471 spend |
| **B. `ai-dossier` as the cohort repo** | Blast radius contained to this repo; glm's 14-run record here is the strongest evidence we have | **Not viable as specified**: only ~10 non-epic, non-blocked open issues remain and most are large (VS Code extension, website, JetBrains plugin) — a ≥8-per-arm low-risk cohort does not exist |
| **C. Defer until #535 → #526 close** | AC1's mode conditional would then resolve to *batch*, matching where the system is heading, and §5's protocol would be written once rather than twice | #535 is open with no owner; #526's verdict is itself gated on a 7-day window in #529 — realistically weeks, and #528's evidence stays anecdotal until then |
| **D. Decline; re-scope AC1 to the retrospective** | Zero spend; this report already shows parity at n=14 vs n=21 | Leaves the core promise resting on a confounded retrospective — exactly the "anecdotal" state #528 was opened to end |

**Why this is escalated rather than defaulted:** every other decision in this run was reversible
(a code change is a revert away). This one spends real third-party money and merges agent-authored
PRs into a production repo — neither is undone by `git revert`. Cost of waiting is low: the
instrument fix in this PR is the prerequisite, and it lands either way.

**Recommendation: option A**, with the ceiling set explicitly and the run stopped at it.

## 6. Limitations

1. **Retrospective, not an experiment.** Arms were not pre-registered, cohort-matched, or run
   concurrently. Confounds: different issue populations, different weeks, different CLI versions,
   and glm ran mostly on `ai-dossier` while claude ran on both repos. §4's rates are directional.
2. **`awaiting-merge` and `ship/done` trails under-count delivery.** `runstate-stats` is pure and
   offline by design — it cannot ask GitHub whether a parked PR merged, and the report tail is
   often a separately dispatched run (compounded by the report-suppression bug
   [#500](https://github.com/imboard-ai/ai-dossier/issues/500)). Delivery rates here are therefore
   floors, not point estimates.
3. **No cost data for the historical arms.** AC2 asks for tokens + $ per completed issue from
   #524's `modelUsage`. That telemetry landed in `e0d62bf` (2026-09-01); `ai-dossier sched stats`
   over `~/.dossier/runs.jsonl` carries cost for exactly one issue (#528, $1.96) and none of the
   historical cohort. **Cost is measurable prospectively only** — the live run will have it, this
   retrospective cannot.
4. **The 7-day regression metric cannot close in-session**, by construction — the same reason
   #526's verdict was split into [#529](https://github.com/imboard-ai/ai-dossier/issues/529).
5. **Sample sizes are small**, especially opus (1 run) and kimi (1 run). Nothing in §4 supports a
   claim about the strong tier.
6. **A run keeps its FIRST generation's `model=`.** `runstate stats` reads `model=` off the gate
   milestone, and a takeover reuses the same `run` id — so this very run, whose generation 1 is
   `claude-opus-5`, is bucketed under generation 0's `claude-sonnet-5`. A mid-run model change is
   invisible to the per-model table, which also makes "#504 is the only opus run" true only of
   what the tool can see.
7. **The per-model table has no class or tier axis.** AC3 and AC4 both ask "which tiers are safe
   for which *classes*"; `runstate stats` buckets by model only. Answering the class question
   needs the classifier's `risk=`/class verdict joined onto the trail — capability that does not
   exist yet, and is not built here.

## 7. Appendix — evidence

- Per-model tables: `ai-dossier runstate stats --issues 460..538` and
  `--repo imboard-ai/imboard-monorepo --issues 3891,3862,3810,3886,3890,3889,3756,3500,3433,3414,3408,3824`
  (reproduce with `@ai-dossier/cli` ≥ 0.25.0 — earlier versions split the buckets).
- Cost: `ai-dossier sched stats` on `hcc2` (`~/.dossier/runs.jsonl`).
- Prior reports: `docs/reports/sched-parity.md` (#471), `docs/reports/batch-pilot-2-execution.md` (#526).
- Trails cited: #460 (`reason=publish-e404-new-scope-package`), #472 (`tier=full`, `escalated=1`,
  `ac_met=6/6`), imboard-monorepo #3414 (`plan`, `decision-pending`).
