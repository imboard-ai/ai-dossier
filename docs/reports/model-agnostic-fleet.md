# Model-agnostic fleet validation — claude arm vs open-weights arm

**Status: PARTIAL — instrument fixed, class axis built, retrospective measured, pre-registered live run NOT executed.**

| part | run | date | what it did |
|---|---|---|---|
| Part I (§1–§7) | `r-528-655b` (gen 1) | 2026-09-01 | fixed the `model=` bucketing defect; wrote the retrospective and the §5 protocol; escalated the live-run decision |
| [Part II](#part-ii--run-r-528-8ccf-2026-09-02-hcc2) (§8–§12) | `r-528-8ccf` (gen 0, slot 1) | 2026-09-02 | built AC3's missing `model × class` axis and AC2's two guardrail metrics; re-read the corpus through them; **re-escalated AC1 — option C's premise did not survive** |

Executing host for both: `hcc2`. Issue: [#528](https://github.com/imboard-ai/ai-dossier/issues/528).

> **Part I's §1–§7 are left as generation 1 wrote them.** Where Part II supersedes a figure or a
> verdict it says so and cites the row; nothing in Part I is edited after the fact, so the two runs
> stay independently auditable. The scorecard immediately below is Part II's, and is the current one.

## Recommendation

> **Part I's recommendation, superseded in two places by Part II §11.1.** Sonnet's delivery
> rate over the widened `460..584` window is **90% (37/41)**, not the 86% (18/21) below; and
> the sharper parity signal is no longer delivery rate at all but **conformance** — `glm-5.3`
> scored 0 of 73 acceptance criteria not-met against `claude-sonnet-5`'s 9 of 159. The
> paragraphs below are left as generation 1 wrote them.

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

**Current, as of Part II (`r-528-8ccf`, 2026-09-02).** Generation 1's scorecard is preserved
verbatim below it, so the movement between the two runs is visible rather than overwritten.

| AC | Part I | Part II | why it moved |
|---|---|---|---|
| AC1 — two-arm live cohort, ≥8 issues per arm | NOT MET | **NOT MET** | still no live dispatch — and the deferral that was supposed to unblock it did not hold (§9) |
| AC2 — per-arm metrics (7 named) | PARTIAL | **PARTIAL** | escalations/issue and conformance-not-met rate are now measured per model and per class (§10, §11); tokens+$ and the 7-day window remain out of the trail |
| AC3 — per-model breakdown, "which tiers are safe for which classes" | PARTIAL | **PARTIAL** | the per-class axis now exists and is populated (§10, §11) — still PARTIAL because the classifier covers only 23% of this corpus, so the axis is real but thin |
| AC4 — tier→model mapping, rescue justified by measured escalation frequency | PARTIAL | **PARTIAL** | the mapping is now per class, not just per project (§11.3); the rescue-tier justification still needs the live run |
| AC5 — open-weights failures not caught by guardrails get their own issue | PARTIAL | **PARTIAL** | unchanged — the exercise that would surface them still has not run |

`ac_met=0 ac_total=5` remains the honest score: every AC has moved, none has closed.
**#528 stays open**, and §12 restates the one decision that closes AC1.

---

Generation 1's scorecard, from that run's independent (blind) conformance review:

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

---

# Part II — run `r-528-8ccf` (2026-09-02, hcc2)

Dispatched by the scheduler as a strong-tier `full` unit on `imboard-ai-ai-dossier` slot 1 at
14:30:12Z, four minutes after its dependency #526 closed — and, as §9 records, seven minutes
before #526 was reopened because that close was premature. Generation 0 of a fresh run id — not a
resume of `r-528-655b`; §8.1 explains why that distinction was the first decision of the run.

**Headline: the class axis AC3 asks for now exists and is populated — and the deferral that was
supposed to unblock AC1 did not survive contact with what #526 actually delivered.**

## 8. Environment and entry

| | |
|---|---|
| host | `hcc2` (16 vCPU / 30 GB) |
| `@ai-dossier/cli` | 0.32.0 at dispatch → 0.33.0 in this PR |
| base | `7cccbb5` (`docs(reports): batch pilot attempt 3 — execution record (#584)`) |
| slot | `imboard-ai-ai-dossier` slot 1, pid 1637242, `claude -p --model opus` |
| model | `claude-opus-5` |

### 8.1 Entry mode — the run did not resume into `report` (trap #582)

`ai-dossier runstate verify --issue 528 --json` returned `resume_from=report`, reusing the finished
`r-528-655b`. Obeying it would have posted a second report milestone for work never done and exited
reporting success. That is `docs/agent-traps.md`'s open row for **#582**, and the same rail that
nearly lost #526's attempt 3 (`batch-pilot-2-execution.md` §18.1) six hours earlier.

The run entered **FRESH** instead — `r-528-8ccf`, `prior_run=r-528-655b`, gen 0 — after
cross-checking the slot's `spawned_at` (14:30:12Z) against the report milestone's `at=`
(2026-09-01T22:55:23Z). #576 already taught the *engine* rail this rule (`isVerifiedComplete`
refuses a `report/done` older than the slot's dispatch); `runstate verify` still disagrees with it.
**Second independent sighting of #582 in one day, on a different issue** — the defect is not
specific to #526's re-enqueue, and the gate rail should be brought in line with the engine rail.

## 9. AC1 — the deferral's premise did not hold

Part I §5.1 escalated one decision. The owner answered it on 2026-09-02T04:42Z:

> **option C — defer the live two-arm run until #526's batch path is proven**, so one experiment
> answers both mode and model. Re-enqueued on hcc2 behind #526 (tier strong). Spend ceiling when it
> runs: the run's own recommended **~$600**, stop-at-ceiling; owner may adjust before dispatch.

Option C's stated pay-off was that AC1's mode conditional would then resolve to **batch**. It does
not, and the reason is that #526 closed on paper rather than in substance:

| what option C assumed | what actually happened |
|---|---|
| #526 closing means the batch path is proven | #526's own execution record (PR #584, merged 14:26Z): *"Both members were then evicted on two different defects and the batch dissolved 21 minutes after it was enqueued. **Zero batches completed. AC1 is still not met.**"* |
| the mode conditional resolves to batch | it resolves to **full-cycle** — #526 has not passed, so AC1's `otherwise` branch applies, exactly as in Part I §2.4 |
| the dependency gate releasing means the condition is met | #526 was auto-closed by its PR merge with `ac_met=0 ac_total=4` — and **reopened at 14:37:57Z**, seven minutes after this run was dispatched off that close, once the premature close was noticed. #529's guard banner already warns about precisely this pattern, and #583 — one of the two defects that evicted the members — is open and in flight |

So the scheduler's dependency released for the wrong reason, and running the ~$600 dispatch on it
would have been substituting **option A** (which the owner declined) for **option C**, spending real
third-party money and merging up to 16 agent-authored PRs into the production monorepo. Both are
outside what a `git revert` undoes. **AC1 is therefore re-escalated (§12), not attempted.**

### 9.1 Cohort availability, measured rather than asserted

Part I's option B was rejected on the claim that this repo has no ≥8-per-arm low-risk cohort. That
claim is now measured, since it is a precondition of any re-decision:

| repo | open | after exclusions¹ | not already `cycle:full` | verdict |
|---|---|---|---|---|
| `imboard-ai/ai-dossier` | 19 | 18 | 13 | **no cohort** — 5 of the 18 are the ops/meta issues driving this work (#526, #528, #529, #582, #583) and the remaining 13 are large product epics (VS Code extension, JetBrains plugin, website, playground, standalone binaries) |
| `imboard-ai/imboard-monorepo` | 112 | 93 | 82 | **cohort available** — option A's ≥8-per-arm requirement is satisfiable |

¹ excluding `epic`, `decomposed`, `needs-clarification`, `decision-pending`, `batch-epic`, `blocked`.

Option B stays non-viable. What option A lacks is authorisation, not issues.

## 10. AC3/AC2 — the missing axis, built

Part I's own scorecard named the gap: *"the AC's per-class / per-tier axis does not exist in the
tool"*. AC3's text is **"which tiers are safe for which classes, not one number"**, and until the
axis exists the live run — whenever it is authorised — produces data the tool cannot answer AC3 or
AC4 with. That is the same failure mode as the broken `model=` bucketing Part I fixed, one axis over.

The data was already being written and read by nothing:

- The **classifier** posts `phase=classify` with `risk=` (`low`/`med`/`high`), `mode=` and `areas=`
  — verified live on #540–#543 here and on #1026/#2687/#3966 in imboard-monorepo.
- **Review** posts `escalated=`, `ac_met=` and `ac_total=` on every run that reaches it — AC2's
  "escalations per issue" and "conformance not-met rate", already on the wire.

This PR joins them into `runstate stats`:

1. **The classifier verdict is an ISSUE attribute, not a run attribute.** The classifier dispatches
   under its own `run=` (`r-540-edcf` classifies what `r-540-…` implements), so a per-run lookup
   finds `risk=` on the classify run and nothing on the cycle run that did the work. The join reads
   it once per trail and attaches it to every run of that issue.
2. **Classify dispatches are excluded from both tables.** A classify run posts one milestone,
   records no `model=` and never ships — counted as a cycle run it became an `<unknown>`-model run
   that "failed to deliver", once per issue the classifier had touched. It stays in the per-run
   evidence table, is flagged `classify_only: true` in `--json`, and the count of excluded runs
   is stated in a warning — so the table's row counts still reconcile against `runs.length`.
3. **New `By model × class` table**, mirroring the model table's bucket contract and reusing the
   same `delivered` predicate, so a class row can never disagree with the model row it sums into.
   Rows sort worst-class-first (`high` → `med` → `low` → `<unclassified>`).
4. **Guardrail columns on the model table** — `esc/run` and `not-met`. Both distinguish "measured
   zero" from "never measured": a model whose runs all blocked before review renders `-`, not
   `0.0`, because it has not demonstrated a zero escalation rate, it has demonstrated nothing.
   Conformance is weighted by criteria rather than by run and carries its denominator into the cell
   (`9/159`), so a rate over four criteria cannot read like one over two hundred.
5. **Coverage is reported, not assumed.** `<unclassified>` is its own visible row, and a *mixed*
   table warns with the share. An all-unclassified table stays quiet — the same rule the
   `<unknown>` model bucket already follows, because otherwise the warning fires on nearly every
   trail predating the classifier and drowns the ones that matter.

## 11. What the corpus says through the new axis

### 11.1 `imboard-ai/ai-dossier`, issues #460–#584

`ai-dossier runstate stats --repo imboard-ai/ai-dossier --issues 460..584`, read at
2026-09-02T15:25Z — 76 runs, of which 10 are classifier dispatches (excluded from both
tables, per §10 item 2) and 66 are cycle runs; #575 dropped on a GitHub 503:

```
By model:
  model            runs  delivered  blocked  unfinished  rate  esc/run  not-met   n     median total             min               max
  <unknown>           7          0        4           3    0%      0.0        -   5    3m 57s (237s)    2m 1s (121s)    34m 6s (2046s)
  claude-opus-5       4          3        0           1   75%      0.0     7/13   4   1h 44m (6290s)  24m 8s (1448s)   2h 58m (10711s)
  claude-sonnet-5    41         37        0           4   90%      0.1    9/159  41  49m 44s (2984s)  13m 56s (836s)   2h 49m (10154s)
  glm-5.3            14         12        1           1   86%      0.1     0/73  14   1h 30m (5419s)  49m 7s (2947s)  20h 56m (75372s)  folded: llmgateway/glm-5.3

By model x class:
  model            class           runs  delivered  blocked  unfinished  rate   esc  not-met
  claude-sonnet-5  med                1          1        0           0  100%   0/1        -
  glm-5.3          med                2          1        0           1   50%   1/2     0/11
  <unknown>        low                5          0        2           3    0%   0/3        -
  claude-sonnet-5  low                7          7        0           0  100%   0/7     0/16
  <unknown>        <unclassified>     2          0        2           0    0%     -        -
  claude-opus-5    <unclassified>     4          3        0           1   75%   0/3     7/13
  claude-sonnet-5  <unclassified>    33         29        0           4   88%  3/32    9/143
  glm-5.3          <unclassified>    12         11        1           0   92%  1/12     0/62
```

Read carefully, because the sample sizes are small and the axis is new:

- **The guardrail columns support the model-agnostic promise more directly than the delivery rate
  did.** `glm-5.3` scored **0 of 73** acceptance criteria not-met, against **9 of 159** for
  `claude-sonnet-5` and **7 of 13** for `claude-opus-5`. Escalation rates for the two comparable arms are
  indistinguishable (0.1/run for both `glm-5.3` and `claude-sonnet-5`; opus's four runs
  escalated nothing). This is *not* "glm is better": opus's 7/13 is dominated by #528's own two runs,
  which were scored against five deliberately un-dischargeable ops criteria — an artefact of what
  opus was pointed at, and precisely the kind of confound the class axis exists to expose and the
  pre-registered run exists to eliminate.
- **The class rows are real but thin.** Only **15 of 66 cycle runs (23%)** carry a classifier verdict, so
  every **classified** class row is n ≤ 7 and none of them is a verdict. The tool says so in its own warning.
- **The one visible class signal is a hypothesis, not a finding:** glm delivers 92% on
  `<unclassified>` (mostly older, self-selected work) but 50% on `med` (n=2, 1 escalation), while
  sonnet is 100% on both `low` (7/7) and `med` (1/1). If it survives the live run at n≥8, it is
  exactly the "safe for low, escalate on med+" boundary AC4 asks for. At n=2 it is noise.
- **`<unknown>` is a data-quality finding.** 7 runs recorded no `model=`, 5 of them classified
  `low`. These are separately-dispatched review/report tail agents that never post a gate milestone,
  so they inherit no `model=`. They score 0% delivered by construction and are not attributable to
  any model. Worth fixing at the source (have tail dispatches record `model=`), not in the reader.

### 11.2 `imboard-ai/imboard-monorepo`, the #471 cohort plus attempt 3's members

`ai-dossier runstate stats --repo imboard-ai/imboard-monorepo --issues
3891,3862,3810,3886,3890,3889,3756,3500,3433,3414,3408,3824,1026,2687,3966,3887` — Part I
§4.2's twelve, plus attempt 3's classifier-routed members (#1026, #2687, #3966) and #3887:

```
By model:
  model            runs  delivered  blocked  unfinished  rate  esc/run  not-met   n     median total              min              max
  <unknown>           2          0        1           1    0%      0.0        -   1    13m 8s (788s)    13m 8s (788s)    13m 8s (788s)
  claude-sonnet-5    12          8        0           4   67%      0.0     1/36  12   1h 58m (7091s)  34m 23s (2063s)  7h 39m (27551s)
  glm-5.3             3          2        1           0   67%      0.0      0/9   3   1h 48m (6539s)   13m 46s (826s)  9h 24m (33898s)  folded: z-ai/glm-latest, ~z-ai/glm-latest
  kimi-latest         1          1        0           0  100%      0.0      0/4   1  8h 47m (31628s)  8h 47m (31628s)  8h 47m (31628s)  folded: openrouter-kimi-latest

By model x class:
  model            class           runs  delivered  blocked  unfinished  rate  esc  not-met
  <unknown>        low                2          0        1           1    0%  0/1        -
  claude-sonnet-5  low                4          3        0           1   75%  0/3     1/11
  claude-sonnet-5  <unclassified>     8          5        0           3   63%  0/8     0/25
  glm-5.3          <unclassified>     3          2        1           0   67%  0/2      0/9
  kimi-latest      <unclassified>     1          1        0           0  100%  0/1      0/4
```

The open-weights arm on this repo has **no classified runs at all** — every glm and kimi run
predates the classifier. The class axis therefore cannot compare arms here yet, which is itself the
argument for pre-registering the live cohort *through* the classifier, as §5's protocol already
specifies.

### 11.3 Tier→model mapping (AC4), now per class

Supersedes Part I §4.4's per-project table. Still provisional — the live run is what would make it
otherwise.

| project | class | recommended | evidence | confidence |
|---|---|---|---|---|
| `ai-dossier` | `low` | glm at mid | 0/73 criteria not-met over 14 runs; 86% delivery | moderate — delivery and conformance both measured, class coverage thin |
| `ai-dossier` | `med` | claude sonnet at mid, glm allowed with opus rescue | glm 1/2 on `med` with 1 escalation vs sonnet 1/1 | **low — n=2.** The live run's job |
| `ai-dossier` | `high` | claude sonnet mid, opus strong | no `high`-class run exists in the corpus | none — no evidence either way |
| `imboard-monorepo` | all | claude sonnet at mid | open-weights sample is 4 runs, none classified | low, unchanged from Part I |
| both | rescue | claude opus | AC4 asks for the rescue tier to be justified by *measured escalation frequency*; measured frequency is 0.1/run and indistinguishable across models, which justifies nothing either way | none — needs the live run |

**The honest summary of AC4 is that the class axis now makes the recommendation falsifiable.**
Before this run it was one number per model per project; it is now a claim per class that the live
run can contradict.

## 12. The decision, restated

Unchanged in shape from Part I §5.1 — changed in that option C has been tried and its premise did
not hold. §5's pre-registered protocol is still the executable spec; nothing about it needs rewriting.

**The decision:** whether to run the pre-registered two-arm cohort now in **full-cycle** mode
(batch is not available and will not be until #583 and #529 close), on which repo, and at what
ceiling.

| option | pros | cons |
|---|---|---|
| **A′. `imboard-monorepo`, full-cycle, ~$600 ceiling, run now** *(recommended)* | The cohort exists and is measured (§9.1: 82 eligible issues). The instrument is now complete — §10's axis means the result can actually answer AC3/AC4 rather than needing a third instrument run. Every hour of delay is another day of the core promise resting on a 23%-classified retrospective | ~$600 of third-party spend and up to 16 agent-authored PRs into the production monorepo — the same blast radius that was escalated the first time, and it has not shrunk |
| **C′. Defer again, until #583 closes and #529's 7-day verdict lands** | Preserves option C's original pay-off — one experiment answering both mode and model | #529 cannot start for 7 days by its own AC1, and #583 is one defect of two. This is a ≥1-week deferral whose end condition has already slipped once, in exactly this way |
| **D. Re-scope AC1 to the retrospective and close #528** | Zero spend. §11's conformance columns are materially stronger evidence than Part I had — 0/73 vs 9/159 criteria not-met is a sharper parity signal than 86% vs 86% | Leaves the core promise resting on a corpus that is 23% classified, with the one class-level signal (glm 50% on `med`) at n=2 and unresolved. That is the "anecdotal" state #528 exists to end |
| **E. Half-cohort pilot on `imboard-monorepo`: 4 issues per arm, ~$150 ceiling** *(new)* | Buys the pre-registered, classifier-routed, concurrent design at a quarter of the spend and blast radius; would settle whether the `med` boundary in §11.1 is real | Underpowered for AC1 as written (≥8 per arm), so it advances AC1 without closing it — a third partial rather than a verdict |

**Why this is escalated rather than defaulted, again:** the run had a live dependency gate that
released and a pre-authorised ceiling, so proceeding was mechanically available. It was declined
because the *substance* of the owner's condition was not met, and because the spend and the merges
are the two things in this workflow that a revert does not undo. Everything else in this run was
reversible and was simply done.

**Recommendation: A′.** The reason option C was chosen — get both answers from one experiment — is
no longer purchasable at the price quoted: batch mode needs #583 fixed and #529's window elapsed,
which is a week away with an end condition that has already slipped once. The model question is
answerable today, the cohort exists today, and as of this PR the instrument can finally answer it
per class. If the ~$600 is the sticking point rather than the timing, **E** buys the pre-registered
design at ~$150 and settles §11.1's `med` hypothesis; it does not close AC1.

Two follow-ups are implied and deliberately **not** filed as issues here, per the one-issue-in rule:
the gate rail's disagreement with the engine rail is already open as **#582** and now has a second
independent sighting (§8.1); and the `<unknown>`-model tail dispatches (§11.1) want `model=` recorded
at the source, which belongs to whoever owns the report/review dispatch path.

## 13. Limitations (Part II)

1. **The class axis is 23% covered on this repo and 0% on the open-weights arm of imboard-monorepo.**
   Every **classified** class row here is n ≤ 7 (the `<unclassified>` rows are large, which is
   the point). The axis is built and correct; it is not yet evidence.
2. **AC2's tokens/$ are still not in this report.** They live in `ai-dossier sched stats`
   (`modelUsage`, #524), not in the runstate trail, and #524 landed on 2026-09-01 — so the cost
   series is prospective, not retrospective. Joining the two sources is a real piece of work and was
   not attempted here rather than half-done.
3. **The 7-day regression window is not measured** and cannot be from within a single run. It
   belongs to a follow-up window issue, the #526→#529 pattern.
4. **`claude-opus-5`'s 7/13 not-met is a confound, not a measurement** (§11.1) — it is #528's own
   ops criteria, scored against runs that were never going to discharge them.
5. **No live dispatch happened**, so AC5 remains untestable: the exercise designed to surface
   open-weights-specific guardrail escapes still has not been run.

## 14. Appendix — evidence (Part II)

- Runstate trail: [#528](https://github.com/imboard-ai/ai-dossier/issues/528) — run `r-528-8ccf`,
  gen 0, `prior_run=r-528-655b`
- Owner decision (option C): [#528 comment, 2026-09-02T04:42Z](https://github.com/imboard-ai/ai-dossier/issues/528#issuecomment-5504488779)
- #526's execution record: `docs/reports/batch-pilot-2-execution.md` Part III (PR
  [#584](https://github.com/imboard-ai/ai-dossier/pull/584), merge `7cccbb5`)
- Trap sighting: `docs/agent-traps.md`, the `resume_from=report` row — issue
  [#582](https://github.com/imboard-ai/ai-dossier/issues/582)
- Numbers in §11 are the verbatim output of `ai-dossier runstate stats` built from this PR
