# Batch pilot attempts 2-4 — execution record

Execution-only record for [#526](https://github.com/imboard-ai/ai-dossier/issues/526) (attempts 1-3)
and its successor [#590](https://github.com/imboard-ai/ai-dossier/issues/590) (attempt 4). **No verdict
here** — the GO/NO-GO gate with the 7-day regression window is
[#529](https://github.com/imboard-ai/ai-dossier/issues/529), armed manually by the supervisor after the
first batch PR merges.

This file covers **all four pilot runs** — three under #526 (attempt 2) and one under #590 (attempt 4). Part I is run `r-526-1248` (blocked before any batch
could dispatch); [Part II](#part-ii--run-r-526-9313-2026-09-01-2257--2026-09-02-hcc2) is run
`r-526-9313`, which dispatched three batches and is where the bulk of the execution data lives;
[Part III](#part-iii--run-r-526-eba7-2026-09-02-1214z-hcc2) is run `r-526-eba7`, the first run whose
batch actually reached execution — a warm worktree in under a second and both members' agents run —
before both members were evicted, one by a `plan validate` gap (#579, fixed mid-run by PR #581) and
one by the incremental member gate (#583, fixed by #585).

[Part IV](#part-iv--run-r-590-84e0-2026-09-03-05000700z-hcc2) is attempt 4, run `r-590-84e0` under
the fresh issue #590 — the first run to dispatch **three** batches at once, all warmed in the same
second, and the run that root-causes why no batch has ever completed: the incremental member gate is a
constant function in this environment (#594, imboard-monorepo#3996).

Companion to [`batch-pilot.md`](./batch-pilot.md) (attempt 1, NO-GO) and
[`sched-parity.md`](./sched-parity.md) (RFC-0001 Step-1 exit gate). Metric definitions are reused
verbatim from `batch-pilot.md` §2.2 so all four parts compare directly.

# Part I — run `r-526-1248`

## Headline

*Run 1 only — Part II supersedes every dispatch number below.*

**Batches executed end-to-end in run 1: 0 of ≥3.** One batch was composed, anchored, and
enqueued onto the live imboard scheduler; it could not be dispatched. Two independent blockers,
both new, both root-caused below:

| # | blocker | kind | status |
|---|---|---|---|
| B1 | The eligible imboard backlog yields 3 slot-eligible issues — enough for exactly **1** batch, not 3 | cohort scarcity | measured, 15 issues classified |
| B2 | `@ai-dossier/sched` never transitions a batch `forming → ready`, and never binds its anchor — so an enqueued batch is permanently undispatchable | product bug | root-caused to file/line, reproduced |

Attempt 1's pilot arm was empty because batch units were not executable by the engine (§5.0 → #523).
Run 1's pilot arm is empty because the *entry into* that now-implemented execution machine was
never wired up. The fix landed one link short of the chain.

## 1. Environment

| | |
|---|---|
| host | hcc2 |
| repo under test | `imboard-ai/imboard-monorepo` (cohort source, per the owner's 2026-09-01 decision on #526) |
| report home | `imboard-ai/ai-dossier` |
| scheduler | `imboard-ai-imboard-monorepo`, `max_slots=3`, cron tick every 2 min via `~/.dossier/reset-fleet/tick.sh` |
| CLI at run start | `@ai-dossier/cli@0.19.1` / `@ai-dossier/sched@0.4.0` |
| CLI after upgrade | `@ai-dossier/cli@0.24.0` / `@ai-dossier/sched@0.12.0` |
| window | 2026-09-01 20:06Z → 21:00Z |
| model tier | members enqueued at `tier=mid`, matching the attempt-1 baseline arm so the token comparison isolates batching rather than the model |

## 2. What ran

### 2.1 Timeline

| time (UTC) | event |
|---|---|
| 20:06 | run `r-526-1248` gate; setup; plan (prior session) |
| 20:17–20:20 | classify wave 1 — 9 candidates, 8 classified (#3415 held pending the escalation), 3 `slot` |
| 20:23 | run blocked, `reason=backlog-scarcity-ac1`; decision escalated on #526 |
| 20:30–20:38 | classify wave 2 — 7 issues, **0 `slot`** (the bounded top-up the wave-1 escalation pre-declared) |
| 20:41 | `plan:v1` artifacts posted on #3631, #3820, #3887; anchor imboard-monorepo#3963 created; audit + manifest written |
| 20:42 | `sched enqueue --from-manifest` → 3 entries, batch `b-20260901-01` created, status `forming` |
| 20:42–20:50 | 12 polls over 8 min: 3 idle slots, `Runnable units: none`, batch never leaves `forming` |
| 20:52 | global CLI upgraded 0.19.1 → 0.24.0 (sched 0.4.0 → 0.12.0) after finding 0.4.0 predates batch execution entirely |
| 20:55 | forced tick under 0.24.0 → `tick: nothing to do`, **0 journal events**, batch still `forming`, `anchor=null` |

### 2.2 Cohort generation (§5.3 — routed through the classifier, so misclassification has a denominator)

Eligible backlog: the 68 open imboard issues remaining after excluding
`epic|decision-pending|needs-clarification|in-progress|research|parked|security|batch-epic|decomposed`.
Every issue in that backlog whose scope reads as a low-risk candidate was classified — one
`issue-cycle-classifier` dispatch each, no hand-enqueueing.

**15 issues classified; 3 classified `slot` (20.0%).**

| verdict | issues |
|---|---|
| `slot` | #3631, #3820, #3887 |
| `full` | #3839, #3923, #3893, #3632, #3442, #3415, #3403, #3961, #2779, #3858, #3931, #3901 |

Floor rules doing the work across the 12 `full` verdicts (a verdict may hit several): rule 8
(visual/browser review) 6 times — #3839, #3893, #3632, #3442, #3858, #3931; rules 5/6 (file and diff
size) on 4 issues — #3923, #3442, #3858, #3901; rule 1 (security / infra risk floor) 3 times —
#3415, #3403, #2779; plus rule 4 (deploy pipeline, #3403) and rules 9/10 (open dependency and
sub-floor confidence, #3961).

Skipped without classifying, with reasons: #3867 (latest runstate milestone is
`gate/blocked reason=needs-clarification`); #3549 (deliberately excluded — it modifies
`auto-merge-watcher`, the merge path this pilot's own batches ship through, and changing it
mid-pilot would confound the measurement); #3857 and #1591 (automated contract-gap reports, 0 new
gaps, not implementable units); #3376 and #2644 (heartbeat/reminder trackers); #3126 (broad
nightly-failure umbrella).

**Wave 2 returned 0 slot out of 7.** That is the measurement behind B1: the remaining eligible
backlog is dominated by large `enhancement` features (cap table, e-signature, AI meeting
extraction, the 4-PR investor-hook series) and infra/security work. Classifying deeper into it
reproduces the same hit rate at real dispatch cost.

Composing 1–2 member "batches" to reach a count of three was available and was **rejected**: it
defeats the pilot's purpose (measuring shared-worktree and shared-context savings across N>1) and
would feed #529 a misleading GO/NO-GO input rather than an incomplete one.

### 2.3 The batch that was prepared

`b-20260901-01` — anchor [imboard-monorepo#3963](https://github.com/imboard-ai/imboard-monorepo/issues/3963)

| member | risk | est_files | est_diff | areas |
|---|---|---|---|---|
| #3631 | low | 2 | 40 | testing, registry |
| #3820 | low | 3 | 77 | frontend, qa |
| #3887 | low | 1 | 75 | testing |

Eviction group `{#3631, #3887}` — both dispose entries in
`main/packages/frontend/scripts/quarantine-registry.ts`. Co-batched deliberately per E.4 constraint
5: the shared worktree lets #3887 see #3631's dispositions, which is exactly the cross-PR merge
conflict batching exists to remove. All six E.4 hard constraints hold (same base `main`; no
unsatisfied external deps; 3 ≤ 4 members; Σ est_diff 192 ≤ 1200; one eviction group; no two med+
risk members in one area).

Audit: `~/.dossier/logs/batch-prep/imboard-ai-imboard-monorepo/BATCH-PLAN-20260901-204500.md.gz`.
Manifest: `manifest-20260901-204500.json` in the same directory.

## 3. B2 — why the batch could not dispatch

Two distinct defects, found in sequence.

### 3.1 The engine host ran a CLI that predates batch execution

The imboard engine ticks `ai-dossier sched start --once` off `PATH`. That resolved to
`@ai-dossier/cli@0.19.1`, bundling `@ai-dossier/sched@0.4.0` — which has **no `batch-dispatch`
module at all**; its scheduler dispatches `['issue']` kinds only. #523 (PR #530) shipped batch
execution to the repo and to npm, but nothing installed it on the host, so §5.0 read as satisfied
from the repo's side while the machine that had to execute batches could not.

Upgrading to `@ai-dossier/cli@0.24.0` / `sched@0.12.0` fixed that and left the pre-existing state
readable (`sched status` renders the queue, slots, and batches without migration error). Scheduler
state for both projects was backed up first as `state.json.pre-0.24-upgrade-20260901`.

### 3.2 Nothing ever seals a batch `forming → ready`

With the current engine installed, the batch still does not dispatch. The chain:

- `enqueue` creates a batch via `createBatch`, whose single construction site hard-codes
  `status: 'forming'` (`sched/dist/state.js:169`).
- `runnableUnits` skips any batch whose `status !== 'ready'` (`readiness.js:94`), so a `forming`
  batch is never offered to the placer.
- `beginBatchSetup` additionally requires a non-null anchor:
  `batch.status !== 'ready' || batch.anchor === null` (`batch-dispatch.js:381`).
- `forming → ready` is a *legal* transition (`state.js:87`: `forming: ['ready', 'dissolving']`)
  — but **no production code path performs it.** Every `transitionBatch(..., 'ready', ...)` call in
  the package is in `__tests__/state-machine.test.ts` and `__tests__/scheduler.test.ts`, which
  hand-seal the batch before exercising dispatch. That is why the gap survived #523's test suite:
  the tests construct the state the missing production step was supposed to produce.
- No CLI surface exposes the seal either — `ai-dossier sched` has no `batch` subcommand, and
  `sched enqueue --help` offers no `--ready`/`--seal` flag.

Secondary defect on the same path: `enqueue` **does** accept an `anchor` field on manifest entries
(`enqueue.js:117` parses it, `:326` binds it), but the manifest schema documented in the
`imboard-ai/git/batch-issues-preparation` dossier omits `anchor` entirely. So even once a batch can
be sealed, an anchor created by batch-prep never reaches the scheduler, and `beginBatchSetup`'s
`anchor === null` guard blocks it a second time.

**Reproduction** (engine 0.24.0, three idle slots, batch present):

```
$ ai-dossier sched start --once
✓ [imboard-ai-imboard-monorepo] tick: nothing to do
# 0 new journal events
# batch: {'id': 'b-20260901-01', 'status': 'forming', 'anchor': None,
#         'worktree': None, 'members': [3631, 3820, 3887], 'executing_member': 0}
```

The batch is left enqueued and `forming` on purpose — it is the live reproduction, and it consumes
no capacity (it is never offered to the placer).

## 4. Metrics

Against `batch-pilot.md` §2.2 definitions. The pilot-arm column is empty for the same reason as
attempt 1: no batch executed. What *is* measurable is the cohort-generation cost, which attempt 1
could not measure at all (it had no classifier denominator).

| metric | baseline arm (attempt 1, full-cycle, n as noted) | pilot arm (this attempt) |
|---|---|---|
| batches executed | N/A — no batches | **0** |
| billable input tokens / issue | 47,105,733 (98.5% cache-read), n=5 | not measurable |
| output tokens / issue | 161,082, n=5 | not measurable |
| cost / issue | $16.00, n=5 | not measurable |
| CI workflow executions / issue | 2.73, n=11 | not measurable |
| CI cycles (distinct head SHAs) / issue | 1.09, n=11 | not measurable |
| slot wall-clock / issue | median 51.0 min, n=10 | not measurable |
| makespan | 10.24 h / 11 issues = 1.07 issues/h (a floor — §3.4) | not measurable |
| eviction / dissolve rate | N/A | **0** — no batch reached `executing`, so no member could be evicted |
| misclassification rate | not computable (0/11 carried a classify record) | **0 / 15 contradicted** — but every verdict is unfalsified, not confirmed: no classified issue was executed, so a `slot` verdict that would have failed at dispatch cannot be detected. The denominator now exists (15); the numerator is untested. |
| human interventions | 0, n=11 | **2** — one `status=blocked` milestone (`backlog-scarcity-ac1`, wave 1) plus this hand-off |
| regressions | 0 (0-day window) | N/A — nothing merged |

### 4.1 Cohort-generation cost (new — attempt 1 had no classifier arm)

Wave 2, 7 `issue-cycle-classifier` dispatches at mid tier, run ≤8 concurrent:

| | |
|---|---|
| total agent tokens | ~448,000 |
| mean per classify | ~64,000 tokens |
| mean duration | 311 s (5.2 min) |
| wall-clock for the wave | ~8 min (parallel) |
| yield | 0 slot-eligible from 7 |

Wave 1's per-dispatch cost was not captured in its session and is not reconstructible from
`~/.dossier/runs.jsonl` (the null-token gap documented in `batch-pilot.md` §2.3).

This number matters for #529: at ~64k tokens per classify and a 20.0% slot hit rate, cohort
generation is not free, and a backlog that yields one batch per 15 classifies changes the
arithmetic of batching's claimed savings.

## 5. What must be true before the next run (as recorded by run 1)

Carrying forward `batch-pilot.md` §5, with its resolved items dropped and the new ones added.

- [x] **B2a — `@ai-dossier/sched` seals batches.** *Done — [#545](https://github.com/imboard-ai/ai-dossier/pull/545): `sealCompletedBatches` seals `forming → ready` inside the enqueue transaction (`cli@0.25.0`, `sched@0.12.1`).* Something in production must perform
      `forming → ready`. The natural site is the end of a successful `enqueue` — its own code
      comment already asserts the invariant ("composition is frozen when the batch seals",
      `enqueue.js:307`), which reads as a seal that was designed and then not written. Needs a
      regression test that dispatches a batch **without** hand-sealing it, since the current suite's
      hand-seal is precisely what hid this.
- [x] **B2b — the anchor reaches the scheduler.** *Done — [#539](https://github.com/imboard-ai/ai-dossier/pull/539): batch-prep Step 8 emits `anchor` on every slot member.* Add `anchor` to the manifest schema documented in
      `imboard-ai/git/batch-issues-preparation` (the CLI already parses it), and have batch-prep
      Step 8 emit the anchor number it created in Step 6.
- [x] **B2c — engine hosts run a current CLI.** #523 was satisfied in the repo and unsatisfied on
      the machine for six days without any signal. A version check in the tick, or a
      `sched status` warning when the installed `sched` is older than the state's schema, would
      have surfaced this immediately. Fixed in #537: `sched start` compares the installed
      `@ai-dossier/sched` against npm registry latest every tick (journaled `engine-stale` once
      per version), and `sched status` surfaces the cached result; a state schema newer than the
      installed engine now throws the specific `EngineTooOldError` instead of a generic
      corrupt-state error.
- [ ] **B1 — a cohort that supports ≥3 batches exists.** At the measured 20.0% hit rate, ≥3 batches
      of N≥3 needs ~45 classified candidates, and the eligible imboard backlog does not contain
      them today. Either the QA-sheet triage pipeline tops up the slot-eligible backlog first, or
      #529's target is restated in terms of what one batch can evidence.

Note that B1 and B2 are independent: fixing the scheduler still yields one batch, and topping up the
backlog still yields zero executions. Attempt 3 needs both.

## 6. Limitations

- The pilot arm is empty for the second consecutive attempt, so every §H metric that compares
  batched to unbatched execution remains unmeasured. Nothing here supports or refutes batching's
  claimed savings.
- The misclassification denominator (15) exists but the numerator is untestable without execution —
  a `slot` verdict is only falsified by dispatching it.
- The 20.0% hit rate is measured over the *low-risk-reading* subset of the eligible backlog, chosen
  by title/scope inspection. It is a fair estimate of yield under the current bar, not a census of
  all 68 eligible issues.
- Comparison caveat carried from #526's decision comment: the attempt-1 baseline arm ran on
  `ai-dossier`, not `imboard-monorepo`. The imboard-side baseline is `sched-parity.md` §4.1's fleet
  arm.

## 7. Acceptance criteria (run 1)

Superseded by [§23](#23-acceptance-criteria-attempt-2-overall-after-run-3), which scores attempt 2 as a
whole across all three runs. Run 1 alone met none of AC1–AC3 and delivered Part I of this report.

## 8. Appendix — evidence

- Batch anchor: [imboard-monorepo#3963](https://github.com/imboard-ai/imboard-monorepo/issues/3963)
- Classify records (runstate `phase=classify` on each issue): #3631, #3820, #3887, #3839, #3923,
  #3893, #3632, #3442, #3415, #3403, #3961, #2779, #3858, #3931, #3901
- `plan:v1` artifacts: [#3631](https://github.com/imboard-ai/imboard-monorepo/issues/3631#issuecomment-5500137594),
  [#3887](https://github.com/imboard-ai/imboard-monorepo/issues/3887#issuecomment-5500138003),
  [#3820](https://github.com/imboard-ai/imboard-monorepo/issues/3820#issuecomment-5500138405)
- Runstate trail for this run: `r-526-1248` on [#526](https://github.com/imboard-ai/ai-dossier/issues/526)
- Batch-prep audit + manifest: `~/.dossier/logs/batch-prep/imboard-ai-imboard-monorepo/` (hcc2, machine-local)
- Scheduler journal: `~/.dossier/sched/imboard-ai-imboard-monorepo/events.jsonl` (hcc2, machine-local)
- Scheduler state backups taken before the CLI upgrade: `state.json.pre-0.24-upgrade-20260901` in
  both project directories

---

# Part II — run `r-526-9313` (2026-09-01 22:57 → 2026-09-02, hcc2)

Part I above records run `r-526-1248`, which ended before any batch could dispatch. Both blockers
it root-caused were then fixed and released — B2a → [#545](https://github.com/imboard-ai/ai-dossier/pull/545)
(`sched` seals `forming → ready` at enqueue; `cli@0.25.0`, `sched@0.12.1`) and B2b →
[#539](https://github.com/imboard-ai/ai-dossier/pull/539) (batch-prep emits the anchor on every slot
member). Run `r-526-9313` re-entered #526 to execute the batches the owner authorised in the
[2026-09-02 decision comment](https://github.com/imboard-ai/ai-dossier/issues/526#issuecomment-5500898597)
— its **option A** (the imboard batch `b-20260901-01`) plus **option D** (two ai-dossier batches:
#490's `b-20260829-01`, and a new one composed from #540-#543).

**Batches dispatched: 3. Batches completed end-to-end: 0. Batch members that completed their full
slot-cycle: 3 of 9.** For the first time in this project's history batches actually ran — long
enough to expose four further defects, three of them downstream of anything attempt 1 or Part I
could have seen. Three are root-caused to file and line below; B3d is characterised by symptom only — no root
cause was established for it in this run. Two of the four are proven experimentally rather than by
reading.

| # | defect | kind | evidence |
|---|---|---|---|
| B3a | `batch-setup` creates the batch worktree but never warms it — no `node_modules`, so every member hard-blocks `env-cold` before doing any work | product bug | 2/2 members bailed in <1.2 min; **proven** by a warm workaround that made 3/3 members succeed |
| B3b | The aggregate-suite runner shells `npm test -- --reporter=json`; in a repo whose `test` script delegates to `make`, `make` aborts on the unknown option, so the suite is read as red with 0 parseable failures → `unattributable-suite-failure` dissolves a fully-green batch | product bug | **reproduced by hand**, deterministic — **fixed by #562** (§12) |
| B3c | `DISSOLVE_EVICTION_FRACTION = 1/3` dissolves a 3- or 4-member batch on its **second** eviction — one member failure is the entire tolerance | design parameter | **fixed by #563** — threshold is now `max(ceil(N × fraction), min_evictions_before_dissolve)` (configurable `dissolve_policy`), and a green-survivor batch is preserved rather than dissolved (`packages/sched/src/types.ts:723-734`, `packages/sched/src/recovery.ts:880-900`) |
| B3d | Per-issue token/cost telemetry (#524, precondition `batch-pilot.md` §5.4) writes null usage for scheduler-dispatched agents; the data exists in the dispatch logs but never reaches the source of record | product bug | `sched stats` returns empty for every issue in this run |

## 9. Environment (run 2)

| | |
|---|---|
| host | hcc2 (this box) |
| engine | `@ai-dossier/cli` 0.25.0, `@ai-dossier/sched` 0.12.1 — both carry #545 and #539 |
| tick | `~/.dossier/reset-fleet/tick.sh`, cron every 2 min, `sched start --once` per project |
| projects | `imboard-ai-ai-dossier` (`max_slots=3`), `imboard-ai-imboard-monorepo` (`max_slots=3`) |
| model tiers | both projects mapped to claude tiers (`mechanical`→haiku, `mid`→sonnet, `strong`→opus) — model parity with the attempt-1 baseline holds, no openrouter arm |
| slot budget | this run itself occupied one ai-dossier slot for its whole duration, leaving 2 |

## 10. What ran

### 10.1 Unsticking the stranded imboard batch

`b-20260901-01` (members #3631/#3820/#3887) was still sitting at `status=forming`, `anchor=null` —
enqueued by the pre-#545 CLI, so it had never sealed, and #539 postdated it. It could not simply be
re-enqueued: the issue-level guard rejects an issue that is already an **active** queue entry. But a
`forming` batch still accepts joins, and terminal entries may be re-enqueued, so:

1. `sched abandon --issue 3631|3820|3887` — `abandonIssue` marks each entry `failed` and touches
   nothing on the batch.
2. Re-enqueue the three from a manifest carrying `anchor: 3963`. On the join path
   (`packages/sched/src/enqueue.ts:424`) `existing.anchor = existing.anchor ?? input.anchor ?? null;` binds
   the anchor because it was `null`; the members are already present so nothing is duplicated; and
   `sealCompletedBatches` transitions the batch `forming → ready` in the same transaction.

Result: `b-20260901-01  ready  #3631,#3820,#3887  anchor #3963` — runnable for the first time. The
next tick claimed it 2 minutes later. Rejected alternative: `sched abandon --batch`, which dissolves
the batch and requeues its members as full-cycle — it would have destroyed the arm being measured.

### 10.2 Cohort generation for the ai-dossier arm (`batch-pilot.md` §5.3)

Seven issues submitted (#487, #488, #489, #540, #541, #542, #543). #487/#488/#489 reused their
2026-08-29 classify records; #540–#543 were classified fresh by one **mechanical-tier** agent each
(4 dispatches, ~38k tokens and ~2.5 min mean — a 40% token reduction against Part I §4.1's ~64k
mid-tier classifies, and the first evidence that #538's "mechanical is safe as the default" holds).

| issue | verdict | note |
|---|---|---|
| #487, #488, #489 | slot / low | reused records |
| #540 | slot / low | 2 files, 80 diff, docs |
| #541 | **full** / low | floor rule 5 — 10 predicted files > 8 |
| #542 | slot / low | 2 files, 80 diff, docs |
| #543 | slot / low | 1 file, 180 diff, docs |

**#541 is the pilot's first real misclassification datum.** It carried a hand-applied `cycle:slot`
label from the supervisor session that created it; the classifier overrode it to `cycle:full`. On
the 4 freshly classified issues the hand label and the classifier disagreed once — 1/4 (25%). The
classifier was right: #541 ships seven new scripts, a README and a test.

Batches composed: `b-20260829-01` (anchor #490 **reused** via batch-prep's idempotent-anchor match —
AC2's batch 1) and `b-20260901-02` (anchor [#549](https://github.com/imboard-ai/ai-dossier/issues/549),
minted). All members enqueued at `mid` tier rather than the E.4 heuristic's `mechanical`, per the
owner's model-parity requirement.

### 10.3 Timeline

| UTC | event |
|---|---|
| 23:05 | `b-20260901-01` re-enqueued from a manifest carrying `anchor: 3963` (its original enqueue was run 1's, 2026-09-01 20:42) |
| 23:06 | `b-20260901-01` sealed `forming → ready`, anchor #3963 bound |
| 23:08:12 | imboard batch claimed; `batch-setup-done`; member 1/3 (#3631) spawned |
| 23:20 | ai-dossier `b-20260829-01` (anchor #490, reused) enqueued and sealed |
| 23:22:08 | ai-dossier `b-20260829-01` claimed; member 1/3 (#487) spawned |
| 23:24:09 | #487 hands back **`env-cold`** after 1.1 min |
| 23:24:11 | #3631 review done → the incremental gate runs `test.focused` |
| 23:26:06 | #3631 evicted — `incremental-gate-failed:test.focused` |
| 23:26:07 | `b-20260829-01` **dissolved** — #488 also `env-cold`; 2 evictions > 3 × 1/3 |
| 23:34:06 | warm workaround armed (see §11) |
| 23:36:14 | `b-20260901-01` **dissolved** — #3820 `agent-exited-unverified`; 2 evictions |
| 23:35 | `b-20260901-02` (anchor #549, minted) enqueued and sealed |
| 23:46:09 | `b-20260901-02` claimed; member 1/3 (#540) spawned |
| 23:46:13 | workaround hardlinks `node_modules`/`dist` into the batch worktree (4 s after setup) |
| 23:58:08 | #540 slot-cycle complete (review done, 0 escalations); member 2/3 (#542) spawned |
| 00:10:10 | #542 complete; member 3/3 (#543) spawned |
| 00:20:13 | #543 complete — **all 3 members green, 0 evictions** — then aggregate validate reports `0 failing` and the batch is **dissolved** as `unattributable-suite-failure` |
| 00:20:21 | batch worktree torn down; #540/#542/#543 requeued as full-cycle |

## 11. B3a — the batch worktree is never warmed

`claimAndSetup` fetches, creates the branch, pushes it and runs `git worktree add`
(`packages/sched/src/batch-dispatch.ts:358-368`) — and then spawns member 1. It never runs the
warmup that `setup-issue-workflow`'s cold path makes mandatory ("**Warmup was executed** … and
**WARMUP-STATUS.md exists**"). The batch worktree therefore has no `node_modules` anywhere, and the
slot-cycle member's environment precondition fires before Step 1. Member #487, in its own words:

> the batch worktree … has no `node_modules` anywhere (root or any of `packages/*`, `mcp-server`,
> `cli`, `registry`), so the environment was never warmed despite the scheduler's dispatch contract
> promising it. … This is a scheduler-side contract failure, not a member failure.

Two members bailed this way in 1.1 and 0.8 minutes, which is 2 evictions on a 3-member batch — over
the dissolve threshold. The batch died 4 minutes after it started, having done no work at all.

**Proof by workaround.** A watcher polling for `worktrees/batch-*` hardlinked (`cp -al`, ~1 s) the
already-warm `node_modules` and `dist` trees from this run's own worktree into any new batch
worktree. It fired 4 seconds after `batch-setup-done` for `b-20260901-02`. That batch's three
members then ran 12.0, 12.0 and 10.1 **wall-clock** minutes and **all completed their slot-cycles
with zero evictions** — against 1.1 and 0.8 **API**-minutes to failure without it (a 2.0-minute wall
gap each in the §10.3 timeline). The variable changed was the
presence of `node_modules`, and nothing else. This is an operator intervention and is counted as one
in §13.

## 12. B3b — a green batch is dissolved by a suite command that cannot run

> **Fixed by #562** (`@ai-dossier/sched` 0.15.0 / `@ai-dossier/cli` 0.29.0). The suite runner
> named below moved to `cli/src/batch-suite-runner.ts` with a 3-tier command resolution order
> (`cap run test.full` → `dispatch.suite_command` → repo-detected safe default) and a new
> `SuiteResult.readable` field so an unreadable report blocks the batch (`blocked` status)
> instead of being read as an attributable red suite. See `docs/agent-traps.md`.

With B3a worked around, `b-20260901-02` reached aggregate validate for the first time. All three
members had completed and committed:

```
8928bb8 docs: operator how-to for the autonomous issue pipeline (sched + tick + telegram) (#543)
3a8b18f docs: RFC-0001 status → Accepted (in rollout) + docs/reports index (#542)
1495448 docs: create docs/agent-traps.md and seed it with this repo's learned traps (#540)
```

The journal then reads:

```
00:20:13 external-advance issue=543   member review done
00:20:13 suite-failed                 0 failing — nothing to attribute (the suite report may be empty or unparseable)
00:20:13 attributed                   method=none offenders=none ambiguous=0 unattributed=0 bisect=not-needed
00:20:13 batch-dissolved              unattributable-suite-failure strategy=full requeued=540,542,543 preserved=none
```

The cause is `createBatchSuiteRunner` (`cli/src/commands/sched.ts:87-115`):

```ts
const result = spawnSync('npm', ['test', '--', '--reporter=json'], { cwd: worktree, ... });
```

This repo's root `test` script is `make test`. `npm test -- --reporter=json` therefore executes
`make test --reporter=json`, and make aborts:

```
$ npm test -- --reporter=json
> make test --reporter=json
make: unrecognized option '--reporter=json'
```

Non-zero exit, no vitest JSON on stdout → `{ ok: false, failing: [] }` → `beginAttribution` finds
nothing to attribute → `runValidate` (`packages/sched/src/batch-dispatch.ts:833`) dissolves the
batch. The runner's own comment anticipates exactly this hazard for the *timeout* case — "a timeout
must never look identical to a genuinely empty/green suite report" — but the same collapse happens
whenever the report is unparseable for any other reason, and `ok: false, failing: []` is not
distinguished from it.

**Consequence: in this repository the batch path can never succeed while the root `test` script
delegates to `make` (`package.json:17`), which it does today.** Every batch that survives its
members dies at aggregate validate, deterministically, regardless of whether the code is green. And
the dissolve is not lossless: `strategy=full … preserved=none` requeues all three members as
independent full-cycle runs, so three completed slot-cycles are discarded and paid for again. The
commits survive only because the branch was pushed — `origin/batch/b-20260901-02-20260901` still
holds all three.

## 13. Metrics (run 2)

Same definitions as `batch-pilot.md` §2.2. **Token and cost figures were recovered by parsing
`modelUsage` out of the raw dispatch logs under `~/.dossier/sched/<project>/runs/`, because
`ai-dossier sched stats` reports empty for every issue in this run (B3d).**

### 13.1 Per-dispatch cost

| dispatch | arm | billable input | output | cost | API min |
|---|---|---|---|---|---|
| #540 as batch member | pilot | 6,214,824 | 47,071 | $2.518 | 11.5 |
| #542 as batch member | pilot | 6,573,453 | 49,888 | $2.606 | 2.9 |
| #543 as batch member | pilot | 6,073,627 | 33,061 | $2.091 | 10.2 |
| **pilot mean (n=3)** | | **6,287,301** | **43,340** | **$2.405** | |
| #487 batch member (env-cold bail) | — | 453,688 | 3,452 | $0.270 | 1.1 |
| #488 batch member (env-cold bail) | — | 399,179 | 2,842 | $0.245 | 0.8 |
| #3631 batch member (evicted at gate) | — | 7,770,338 | 42,651 | $3.384 | 7.9 |
| #3820 batch member (agent-exited) | — | 5,210,921 | 17,316 | $1.569 | 8.1 |
| #544 full-cycle, same window | baseline | 3,387,593 | 17,637 | $1.189 | 6.0 |
| #3631 full-cycle (re-run after eviction) | baseline | 7,178,646 | 36,133 | $2.443 | 13.3 |
| #3887 full-cycle (re-run after dissolve) | baseline | 18,800,822 | 82,948 | $6.689 | 34.3 |

The pilot mean covers only the three members that completed. The four members that bailed or were
evicted (#487, #488, #3631, #3820) cost a further **$5.468** of pilot-arm spend on work that was
thrown away, and they are attributed to neither arm's per-issue figure above.

### 13.2 Against the attempt-1 baseline

| metric | baseline arm (attempt 1, n as noted) | pilot arm (run 2, n=3) |
|---|---|---|
| batches executed end-to-end | N/A | **0 of 3 dispatched** |
| batch members completing their slot-cycle | N/A | **3 of 9** — all three in `b-20260901-02`. Of the other six: 4 were evicted (#487/#488 `env-cold` before doing any work; #3631 at the incremental gate and #3820 on an `agent-exited-unverified` fence, both after reaching `review done`), and #489/#3887 were never spawned because their batches dissolved first. |
| billable input / issue | 47,105,733 | **6,287,301** (−87%) |
| output / issue | 161,082 | **43,340** (−73%) |
| cost / issue | $16.00 | **$2.41** (−85%) |
| eviction rate | N/A | 4 evictions / 9 members = **44%** |
| dissolve rate | N/A | **3 of 3 batches (100%)** |
| misclassification | not computable | **1 of 4** hand labels contradicted (25%). Of the 6 ai-dossier `slot` verdicts, only 3 ever executed and **0 of those 3** were falsified; the other 3 never ran, so they are unfalsified rather than confirmed. Part I's 3 imboard `slot` verdicts are excluded here — #3631 was evicted on `incremental-gate-failed:test.focused`, which is arguably a falsification. |
| human interventions | 0 (n=11) | **6** — see below |
| CI executions / issue | 2.73 | **0** — no batch reached ship, so no PR and no CI ran |
| makespan | 1.07 issues/h | `b-20260901-02`: 3 members in 34 min = **5.3 issues/h** inside the batch |
| regressions | 0 | N/A — nothing merged |

**The −85% cost figure is the most important number in this report, and it is not a like-for-like
comparison.** The attempt-1 baseline is 5 sched/CLI *code* issues at mid/strong tier; the pilot's
three are *docs* issues at mid tier. Docs issues are cheaper however they are executed. The
contemporaneous same-repo full-cycle control in §13.1 (#544, a code issue, $1.19) shows the spread
within full-cycle is itself wider than the gap being claimed. **The only clean comparison available
is the same three issues re-run as full-cycle after the dissolve** — #540/#542/#543 were requeued,
ran, and merged; §13.3 records that controlled result (**−49%**, with a stated ceiling). Treat the
−85% headline as uncontrolled and the −49% as the defensible figure. #529 owns the verdict.

### 13.3 The controlled comparison — the same issues, both ways

Because `unattributable-suite-failure` requeues members as full-cycle, #540, #542 and #543 each ran
**twice**: once as a batch member in the shared worktree, once as an independent full-cycle run.
Same issues, same repo, same model tier, same day. This is the cleanest batch-vs-full-cycle
measurement the pilot has produced, and it exists only because the batch was thrown away.

| issue | as a **batch member** (`b-20260901-02`) | as a **full-cycle run** (after the dissolve) |
|---|---|---|
| #540 | $2.518 · 6,214,824 in · 47,071 out · 11.5 API-min | $4.173 · 13,624,069 in · 48,049 out · 10.0 API-min → PR [#552](https://github.com/imboard-ai/ai-dossier/pull/552) merged `eeaf070` |
| #542 | $2.606 · 6,573,453 in · 49,888 out · 2.9 API-min | $5.937 · 10,863,226 in · 83,468 out · 22.1 API-min → PR [#555](https://github.com/imboard-ai/ai-dossier/pull/555) merged `02bd7c6` |
| #543 | $2.091 · 6,073,627 in · 33,061 out · 10.2 API-min | cost unrecoverable — the dispatch log holds only its header (B3d again) → PR [#554](https://github.com/imboard-ai/ai-dossier/pull/554) merged `6ed7366` |
| **mean (n=2 with both sides)** | **$2.562 · 6,394,139 in** | **$5.055 · 12,243,648 in** |

On the two issues where both sides are recoverable, the batch member cost **49% less** and consumed
**48% fewer billable input tokens** than the same issue executed as its own full-cycle run. Serial
wall-clock: the three members took **34 minutes** inside the batch; the three full-cycle re-runs took
**86 minutes** (17 + 44 + 25).

**Read this table with its ceiling stated.** The batch-member column is *not* the cost of finishing
the issue. A batch member stops at `review done` and hands back to the batch; the batch's shared
tail — aggregate validate, batch review, one PR for all three members, CI, merge, deploy, report —
never ran, because B3b dissolved the batch before it started. The full-cycle column *includes* all of
that. So the comparison is "member work" against "member work + ship tail", and it therefore
**overstates** batching's advantage by exactly the tail it omits.

The batching thesis is precisely that the omitted tail is shared — one PR and one CI run for three
issues instead of three of each — so the true figure could land either side of the 49%. Nothing in
this run measures it. `#542`'s full-cycle column also carries one `agent-exited-unverified` fence
and an automatic promotion to opus at generation 1 (the per-tier escalation ladder, #533 — not a
human intervention), which inflates its $5.937 above a clean run.

That failure mode is worth separating from batching: `agent-exited-unverified` killed imboard batch
member #3820 **and** the #542 full-cycle run. It is a general dispatch failure mode, not a batch
defect, and it should not be scored against the batch arm.

### 13.4 Human interventions (6)

| # | intervention | why it was needed |
|---|---|---|
| 1 | Abandon + re-enqueue #3631/#3820/#3887 to bind the anchor and seal the batch | pre-#545 batch stranded in `forming` with `anchor=null`; no supported command re-seals it |
| 2 | Defer #541 out of the queue | it would have taken the last free slot ahead of batch 1 (AC2 ordering) |
| 3–4 | Defer #488 and #489 | same, ahead of batch 2 |
| 5 | Warm-worktree watcher | B3a — otherwise no batch can run at all |
| 6 | This hand-off | AC1 unreachable without engine fixes that #526 excludes |

Attempt 1's baseline arm needed 0 interventions across 11 issues. The batch path needed 6 across 3
batches: **3 of them (1, 5, 6) to work around defects**, and 3 (2, 3-4) to force the AC2 batch
ordering by hand — the scheduler has no way to prioritise a batch over a competing full-cycle entry,
so even those are a missing-feature workaround rather than a product judgement.

## 14. Limitations (run 2)

- **Cross-repo.** The ai-dossier batches compare against attempt 1's baseline (same repo, different
  issue class). The imboard batch's comparator is `sched-parity.md` §4.1's fleet arm. Neither
  comparison is like-for-like on issue class; §13.2 says so explicitly rather than burying it.
- **n=3 for the pilot cost figure**, all docs issues, one batch.
- **No batch reached ship**, so every ship-side metric (CI executions per issue, PR count, review
  findings per issue, regression window) is structurally unmeasurable in this attempt — as in
  attempt 1, but for a different reason.
- **B3d means the source-of-record telemetry is not the source of these numbers.**  They were parsed
  out of raw dispatch logs. They are accurate for what they cover, but #524's precondition (`batch-pilot.md` §5.4,
  "per-issue token source of record works on both arms") is **not** satisfied — even though #524's
  fix (#531, `sched@0.11.0`) is present in this run's `sched@0.12.1`. That makes B3d a post-fix
  regression or an uncovered path, not an unlanded fix, and #529 should not assume the precondition holds.
- The warm-worktree workaround is machine-local and was removed at the end of this run. Any retry
  needs B3a fixed or the workaround re-armed.

## 15. Acceptance criteria (attempt 2 overall)

*Superseded by [§23](#23-acceptance-criteria-attempt-2-overall-after-run-3), which re-scores attempt 2
after run 3. AC2 and AC3 changed.*

| AC | status |
|---|---|
| AC1 — the authorised batches execute end-to-end (merged + deployed) | **not met** — 3 batches dispatched, 3 dissolved, 0 merged, 0 deployed. `b-20260829-01` died on B3a; `b-20260901-01` on two independent member failures against a 1-failure tolerance (B3c); `b-20260901-02` completed every member and was then discarded by B3b. |
| AC2 — batch #490 is batch 1 | **met for the ai-dossier arm** — batch-prep's idempotent-anchor match reused the open `batch-epic` #490 for `b-20260829-01`, the first ai-dossier batch enqueued (23:20) and claimed (23:22:08). Not first across the pilot: `b-20260901-01` was enqueued in run 1 and, after being re-sealed at 23:06, was claimed 14 minutes earlier (23:08:12). So #490 is batch 1 within its repo, not across the attempt. It did not survive B3a. |
| AC3 — metrics vs the attempt-1 baseline | **partial** — §13 carries per-dispatch tokens/cost, evictions, dissolve rate, misclassification, interventions and in-batch makespan for a real pilot arm. Not carried: CI executions per issue and the regression window (no batch reached ship), and the headline cost delta is uncontrolled (§13.2). §13.3 supplies the one controlled comparison. |
| AC4 — execution-only deliverable | **partial** — this report and the anchors/trails in §16 are delivered. "Batches merged + deployed" did not happen (AC1). #526 stays open; the links are in the hand-off comment rather than a closing comment. |

## 16. Appendix — evidence (run 2)

- Batch anchors: [#490](https://github.com/imboard-ai/ai-dossier/issues/490) (`b-20260829-01`),
  [#549](https://github.com/imboard-ai/ai-dossier/issues/549) (`b-20260901-02`),
  [imboard-monorepo#3963](https://github.com/imboard-ai/imboard-monorepo/issues/3963) (`b-20260901-01`)
- Surviving batch branches (member work is **not** lost despite the dissolves):
  `origin/batch/b-20260901-02-20260901` @ `8928bb8` (all three members' commits),
  `origin/batch/b-20260829-01-20260901` @ `7f2edab` (no member commits — #487 and #488 both bailed
  `env-cold` before doing any work; #489 never spawned)
- Runstate trail for this run: `r-526-9313` on [#526](https://github.com/imboard-ai/ai-dossier/issues/526)
- Member slot-cycle trails: `r-540-44bc`, `r-542-db4a`, `r-543-c70e` (batch members, `mode=slot
  batch=b-20260901-02`); `r-540-429c` and successors (full-cycle re-runs after the dissolve)
- Classify records: #540, #541, #542, #543 (fresh, mechanical tier); #487, #488, #489 (reused)
- `plan:v1` artifacts posted by this run: #540, #541, #542, #543
- Batch-prep audit + manifests: `~/.dossier/logs/batch-prep/imboard-ai-ai-dossier/` and
  `.../imboard-ai-imboard-monorepo/` (hcc2, machine-local)
- Scheduler journals: `~/.dossier/sched/<project>/events.jsonl`; raw dispatch logs with the
  `modelUsage` this report's numbers were parsed from: `~/.dossier/sched/<project>/runs/*.log`

---

# Part III — run `r-526-eba7` (2026-09-02 12:14Z, hcc2)

The third run of attempt 2 — called "attempt 3" in #526's comments and in this branch's name.
Dispatched by the scheduler as a strong-tier `full` unit on
`imboard-ai-ai-dossier` slot 1 after its blockers (#561, #562, #563, #564, #565, #575) merged.

**Headline: the batch pipeline reached execution for the first time, and died at a new gate.**
`b-20260902-01` sealed `ready` with a bound anchor, was claimed by the engine, got a **warm worktree in
under a second**, and ran both of its members' agents — every failure mode that stopped runs 1 and 2 is
gone. Both members were then evicted on two *different* defects and the batch dissolved 21 minutes
after it was enqueued. **Zero batches completed. AC1 is still not met.**

The two defects are #579 — filed independently in the same window, sighted here, and **fixed mid-run by
PR #581** — and #583, new from this run and still open (filed twice in minutes; #580 was the duplicate,
closed into it). A third, #582, was found in the gate rail on the
way in. All three carry reproductions and acceptance criteria.

## 17. Environment (run 3)

| | |
|---|---|
| host | hcc2 (this box) |
| `@ai-dossier/cli` | 0.30.0 (npm latest at dispatch) |
| `@ai-dossier/sched` | 0.19.0 (npm latest; the tick's step-0b nested-dependency upgrade had already run) |
| pilot project | `imboard-ai-imboard-monorepo`, `max_slots=3`, `stall_timeout_ms=10800000` |
| tier models | `mechanical→haiku`, `mid→sonnet`, `strong→opus` |
| engine tick | `~/.dossier/reset-fleet/tick.sh`, cron `*/2` |

**Model parity was already satisfied.** The 2026-09-01 owner note required switching the imboard sched
project off the parity-W3 openrouter glm/kimi mapping back to claude tiers before the pilot. The config
read at dispatch already carried the claude mapping above, so no change was needed and the token
comparison isolates batching rather than the model.

## 18. What ran

### 18.1 Getting in — the gate rail (defect #582)

#526's trail ended with attempt 2's `phase=report status=done run=r-526-9313 at=2026-09-02T01:56:46Z`.
`ai-dossier runstate verify --issue 526 --json` returned `resume_from=report`, reusing the finished
run's id: obeying it would have posted a second report milestone for work never done and exited, and
attempt 3 would silently not have happened.

The engine no longer believes that milestone — #576 made `isVerifiedComplete` refuse a `report/done`
older than the slot's dispatch time, which is why this agent survived its first reconcile tick instead
of being killed two minutes in as the 08:32Z dispatch was (#575). But `runstate verify` — the thing
`gate-issue` Step 1.5 instructs every run to trust — never got the equivalent rule
(`cli/src/runstate.ts:898`: `report/done` + issue OPEN → `report`, unconditionally). The two rails
disagree. The run entered FRESH by operator override, minting `r-526-eba7` and carrying
`prior_run=r-526-9313`. Filed as **#582**.

### 18.2 Cohort generation (§5.3 — routed through the classifier)

The submitted set was three issues, and its narrowness is a finding rather than a shortcut. The
ai-dossier backlog is exhausted of batchable work — every open issue is an epic, a batch anchor, an ops
issue, `decision-pending`, or already labelled `cycle:full` — matching the independent 2026-09-02
candidate review on #526 ("0 additional batchable batches exist; 2 net-new imboard slot hits"). On the
imboard side, 115 open issues filtered by the §5.3 exclusion set leave a backlog dominated by
already-`cycle:full` work; submitting those would have enqueued eleven concurrent full-cycle runs and
destroyed the makespan measurement. #3968 and #3549 were excluded before submission (see the audit
file: #3968 needs an unlanded helper plus an unanswered baseline decision; #3549 modifies the very
`auto-merge-watcher` the pilot needs to merge its own PR). **#3887, the third member named in #526's
attempt-3 cohort, was already shipped by run 2's full-cycle fallback (§11) and is closed** — so the
batch is two members, not three, which is why §22 records the thin-batch limitation.

`ai-dossier classify prescreen --submitted-set 1026,2687,3966` returned `candidate` for all three with
zero floor reasons. Three mechanical-tier (haiku) `issue-cycle-classifier` dispatches then ran
concurrently:

| issue | mode | risk | est_files | est_diff | areas | confidence | record |
|---|---|---|---|---|---|---|---|
| #1026 | slot | low | 1 | 80 | documentation | 0.95 | `r-1026-a195` |
| #2687 | slot | low | 3 | 95 | frontend,monitor | 0.80 | `r-2687-42fb` |
| #3966 | **full** | low | 2 | 80 | frontend | 0.85 | `r-3966-2b7f` |

#3966's `full` is floor rule 8 (visual/browser review required — its ACs demand re-measuring four route
layout findings in a browser against a live backend). The floor is correct; this is a real
classification, not a miss.

**Cohort-generation cost, against §4.1 above (Part I) — attempt 2's wave-2 figures:**

| | attempt 2 wave 2 (mid tier) | attempt 3 (mechanical tier) |
|---|---|---|
| dispatches | 7 | 3 |
| total agent tokens | ~448,000 | **96,449** |
| mean per classify | ~64,000 | **32,150** |
| mean duration | 311 s | **99.5 s** |
| wall-clock (parallel) | ~8 min | **~2 min** |
| slot yield | 0 / 7 | **2 / 3** |

#538's move of the classifier to mechanical tier halved the per-classify token cost and cut its
duration to a third. The 2/3 yield is not comparable to attempt 2's 0/7 — this set was hand-narrowed to
likely candidates first, so it measures the classifier's agreement with a human pre-filter, not a
backlog hit rate.

### 18.3 The batch

`b-20260902-01`, anchor [imboard-monorepo#3976](https://github.com/imboard-ai/imboard-monorepo/issues/3976),
base `main`, members in order **#1026 → #2687** (no deps, both `risk=low`, so issue number decides).
Eviction groups: **none** — predicted paths are disjoint. Σ `est_diff` = 175.

Both members were enqueued at `tier=mid`. Step 8's tier rule maps `documentation` + `risk=low` to
`mechanical`, which would have put #1026 on haiku; the owner's model-parity clause requires the pilot
arm to run at the baseline's sonnet mid tier so the comparison isolates batching. Overriding it is
counted as a human intervention (§21).

`#3966` was enqueued as an independent `full` entry rather than deferred. `sched` gives batches
dispatch priority (#565) and `max_slots=3`, so it could not delay the batch, and it supplies the
contemporaneous same-repo, same-window, same-tier full-cycle control that §13.2 records as missing from
every prior attempt.

### 18.4 Timeline (UTC, 2026-09-02)

| time | event |
|---|---|
| 12:18 | prescreen: 3/3 `candidate` |
| 12:19–12:20 | 3 classify dispatches complete (parallel) |
| 12:23:27 | audit file + manifest written |
| 12:23:35 | `sched enqueue --from-manifest` → **`b-20260902-01` sealed `ready`, `anchor=3976`** |
| 12:24:10 | engine tick assigns the batch; **`batch-setup-done` in the same second — a claim from the pre-warmed worktree pool (`@ai-dossier/worktree-pool`), `pool_claimed=true`**; member 1/2 (#1026) spawned; #3966 spawned in parallel |
| 12:28:11 | member #1026 hands back blocked → evicted `git-unavailable`; requeued full-cycle |
| 12:28:11 | member 2/2 (#2687) spawned |
| 12:44:14 | #2687 posts `review done` (4/4 ACs met, 17 tests run, 3 added, commit `4c505523c` pushed) |
| 12:44:14 | incremental gate `cap run test.focused` → `task-failed` → evicted `incremental-gate-failed:test.focused` |
| 12:44:14 | `batch-dissolved eviction-threshold strategy=full N=2 evictions=2 threshold=1 requeued=1026,2687 preserved=none` |
| 12:46:15 | `teardown-done` — batch worktree returned to the pool as a warm spare |
| 12:54:36 | control #3966 merged — PR [imboard#3978](https://github.com/imboard-ai/imboard-monorepo/pull/3978) `b33684f43` |
| 13:01:06 | #1026 full-cycle re-run merged — PR [imboard#3979](https://github.com/imboard-ai/imboard-monorepo/pull/3979) `5bfa183f5` |
| 13:26:21 | #2687 full-cycle re-run exits unverified → fenced `gen=0`, redispatched `gen=1` (opus) |
| 13:50:24 | #2687 `gen=1` also exits unverified → **`unit-failed unverified-exit-at-strongest-tier`**. The issue's work is now unshipped on both arms |

**Enqueue to dissolve: 21 minutes.**

## 19. What is now fixed — verified by execution, not by reading

Every blocker runs 1 and 2 root-caused held up — the six below span both runs. This is run 3's most
durable result and it should not be lost behind the dissolve:

| blocker | fix | evidence from this run |
|---|---|---|
| #545 — batches never seal `forming → ready` | seal at enqueue | batch was `status=ready` immediately after `sched enqueue` |
| #536 / #539 — anchor never bound (`anchor: null`) | anchor on every manifest member | `anchor: 3976` on the batch record; the engine dispatched it |
| **#561 — batch worktree never warmed (`env-cold`)** | pool-claim-first in `runBatchSetup` | `batch-setup-done` in the **same second** as `assigned`, `pool_claimed=true`. **Zero `env-cold` hand-backs.** Attempt 2 lost two members and a whole batch to this in ~4 minutes |
| #565 — batches do not outrank full-cycle entries | unit priority | batch dispatched at `priority=10` against the `#3966` entry's `0`; §13.4's interventions 2–4 (hand-deferring competitors) were **not needed** |
| #564 — `sched stats` empty for batch members | direct log reads | `sched stats --batch b-20260902-01` returned real per-member figures; §13's hand-parsing of `runs/*.log` was not needed **for the batch members** (§21.1 notes the one place it still was) |
| #575 — re-enqueued issue completes on its previous run's milestone | dispatch-time check in `isVerifiedComplete` (#576) | this agent survived its first reconcile tick; the 08:32Z dispatch had been killed 2 minutes in |

#562's aggregate-suite fix is **untested by this run** — the batch never reached `validating`.

## 20. B4 — the two new defects

### 20.1 B4a — `plan validate` cannot express a file that is new by design (#579)

Member #1026's whole deliverable is one new file. Its `plan:v1` artifact's Predicted Files therefore
names a path that does not exist at HEAD — correctly, and matching the issue's own AC1 verbatim
(*"A runbook exists at `main/docs/runbooks/investor-intelligence-hook-quarterly-review.md`"*).

`ai-dossier plan validate --issue 1026` runs its predicted-file existence check as
`git show HEAD:<path>`, which exits 128 for a missing path. That is reported as a git-probe failure
rather than "path absent", so the member's slot-cycle blocked at Step 1 with `reason=git-unavailable`
and was evicted having implemented nothing. The member verified it was not transient (re-run from two
directories) and correctly declined to paper over it.

**Any issue whose deliverable is a new file was unrunnable as a batch member for the duration of this
run.** Filed as **#579** at 12:39Z off this eviction.

> **Fixed by PR #581 (`c4a4740`, merged 13:47Z) while this run was still in flight** — `plan validate`
> now distinguishes exit 128 (path absent at HEAD) from a genuine git-probe failure. No batch has
> exercised the fix; #1026 had already been requeued and shipped as full-cycle by then.

### 20.2 B4b — the incremental member gate reads INCONCLUSIVE as a member failure (#583)

This is the one that matters, because it is deterministic and it kills every imboard batch.

#2687 completed its slot-cycle cleanly: 4/4 acceptance criteria met with file:line citations, 17 tests
run and 3 added, commit `4c505523c` pushed to `batch/b-20260902-01-20260902` — **the commit is still on
origin.** The engine then ran its independent re-check (`batch-dispatch.ts` ~L1399, the #523 AC2
incremental gate) and evicted the member.

Reproduced by checking `4c505523c` into a fresh linked worktree and running the gate's own command:

```
$ ai-dossier cap run test.focused
cap-test-focused: testing scope = merge-base 31b2a52adbac304e2efcb4ad2f980fdcd1a71757
No projects matched the filters in ".../worktrees/tmp-2687-gate-repro/main"

cap-test-focused: pnpm's git-diff filter matched nothing despite a real
main/packages/** diff — known pnpm-in-linked-worktree limitation (see
scripts/ci-parity.sh's header). Treating as inconclusive, not a pass.

{"capability":"test.focused","outcome":"task-failed","exit_code":1,...}
```

**The suite never ran.** The script says so in words, and its own header explains why it must still
exit non-zero:

> the engine's outcome classification is purely exit-code-mechanical, so a script cannot itself request
> "automation-broken"; non-zero is the signal that matters

The engine's gate then evicts on any `task-failed`, with a comment stating the intended contract
sitting immediately below it (`batch-dispatch.ts:1423`) — *"`ok` / `automation-broken` / `capability-unavailable`
all proceed — only a definite task failure blocks a member here."* The contract is right; **"inconclusive" simply has no channel to reach
it**, because `CapOutcome` is derived from the exit code alone.

A batch worktree is by construction a **linked git worktree** — that is the design. pnpm's
`--filter "...[<ref>]"` selector matching nothing inside a linked worktree is a documented bug in this
exact repo shape (`imboard-monorepo:scripts/ci-parity.sh` header — that file and
`imboard-monorepo:scripts/cap-test-focused.sh` live in the pilot repo, not in this one). So `cap run test.focused` returns `task-failed` for
**every** imboard batch member regardless of its diff or its quality. Every member is evicted; every
batch dissolves. Two for two across two attempts (#3631 in attempt 2, #2687 here), and deterministic.

This is #562's defect class on the gate #562 did not cover: #562 gave the **aggregate** validate gate
`SuiteResult.readable` to separate "ran, zero failures" from "never got a readable report", and made the
latter block rather than dissolve. The **incremental per-member** gate never got that distinction.
The `make: unrecognized option '--reporter=json'` and `unattributable-suite-failure` rows of
`docs/agent-traps.md` describe the aggregate half. Filed twice independently within minutes, from this
same eviction: **#580** and **#583**. #583 is the surviving issue — it is broader (it also requires
`cap run` to capture output so a genuine failure stays attributable, and adds a `min_duration_ms`
sanity floor) and it accounts for the script-side half, imboard-monorepo#3982. #580 was closed into it
with its reproduction carried over.

### 20.3 The dissolve was correct given its inputs, and still lost the work

`threshold=1` for `N=2` — `max(ceil(N × fraction), min_evictions_before_dissolve)` clamped to `N−1`, so
a 2-member batch structurally tolerates exactly one eviction whatever #563's floor is set to. The first
eviction was survived; the second dissolved the batch.

`strategy=full`, `preserved=none`: #563's partial-preserve had nothing to preserve, because the only
member that produced work was the one the gate had just (wrongly) declared failed. So #2687's completed
change was requeued to be written again from scratch — **$3.54 of member work discarded**, even though
the commit itself still sits on `origin/batch/b-20260902-01-20260902`. Nothing is wrong with the
dissolve logic here; it is downstream of B4b and inherits its false input.

## 21. Metrics (run 3)

Same definitions as `batch-pilot.md` §2.2. Figures from `ai-dossier sched stats` (#564), **except** the
per-generation split of #2687's full-cycle re-runs: `sched stats` aggregates those to the issue, so
separating them still required reading `runs/*.log` by hand — a residual #564 gap, narrower than §13's.

### 21.1 Per-dispatch cost

| dispatch | arm | billable in | out | cache-read | cost |
|---|---|---|---|---|---|
| #1026 as batch member (evicted at plan, `git-unavailable`) | pilot | 24 | 8,268 | 760,281 | **$0.464** |
| #2687 as batch member (reached `review done`, evicted at gate) | pilot | 170 | 45,382 | 10,526,314 | **$3.540** |
| **batch total (`sched stats --batch b-20260902-01`)** | | 194 | 53,650 | 11,286,595 | **$4.003** |

(The batch total is `sched stats`'s own unrounded sum, $4.0033; the two member rows shown to three
decimals add to $4.004.)

| #3966 full-cycle control (merged, same repo/window/tier) | baseline | 318 | 73,379 | 18,961,097 | **$6.533** |
| #1026 all dispatches (classify + evicted member + a fenced full-cycle `gen=0` + the `gen=1` re-run that shipped + report agent; 5 runs, merged) | baseline | 462 | 104,590 | 27,419,027 | **$10.939** |
| #2687 all dispatches (evicted member + 2 failed full-cycle generations; 3 runs) | mixed | 696 | 249,228 | 37,322,892 | **$23.603** |

The per-issue rows aggregate every dispatch `sched stats` attributes to that issue; the re-runs' own
shares are not separable from the totals without hand-parsing, which #564 exists to avoid. From the raw
dispatch log, #2687's two full-cycle generations cost **$2.839** (sonnet, `gen=0`) and **$17.224**
(opus, `gen=1`) — **$20.06 for two runs that shipped nothing**, against **$3.54** for the batch-member
run that produced a complete, reviewed change.

### 21.1a #2687 ran on both arms — the one same-issue comparison this run produced

#2687 ran three times on 2026-09-02: once as a batch member, twice as a full-cycle unit.

| | as a **batch member** | as **full-cycle** `gen=0` (sonnet) | as **full-cycle** `gen=1` (opus) |
|---|---|---|---|
| outcome | **`review done`, 4/4 ACs met, 17 tests run (3 added), commit `4c505523c` pushed** | `agent-exited-unverified` → fenced | `agent-exited-unverified` → **`unverified-exit-at-strongest-tier`** |
| cost | **$3.540** | $2.839 | $17.224 |
| what survives | the commit, on `origin/batch/b-20260902-01-20260902` | nothing shipped | review fixes pushed at `237a70375`, never shipped |

**The batch member is the only one of the three that finished its work**, and it was the one the
scheduler discarded. The two full-cycle runs both died the same way, and the raw logs show why: each
ended its turn *waiting* on an armed watcher —

> gen 0: *"The ci-parity Monitor is still armed and will notify when the run finishes. Nothing more to
> do until then."*
> gen 1: *"The authoritative gate is now running once on the final tree, with a completion waiter armed."*

— rather than blocking on it. That is precisely the failure `full-cycle-issue` Phase 5 item 6 names as
"the run's known lost-time failure", and the imboard dispatch prompt warns about in capitals. It is a
**general dispatch failure mode, not a batch defect** (§13.3 reached the same conclusion about #3820
and #542), and it must not be scored against either arm — but it does mean the cleanest comparison
available this run is "the batched attempt worked and the unbatched ones did not", on n=1.

### 21.2 Against the attempt-1 baseline

| metric | baseline arm (attempt 1, n as noted) | pilot arm (run 3) |
|---|---|---|
| batches executed end-to-end | N/A | **0 of 1 dispatched** |
| batch members completing their slot-cycle | N/A | **1 of 2** (#2687 reached `review done`; #1026 blocked at plan) |
| batch members surviving the gates | N/A | **0 of 2** |
| billable input / issue | 47,105,733 | **10,526,314** for #2687, the only member that produced work. Measured, but not a like-for-like ratio: no member delivered a shipped unit of work |
| slot wall-clock / issue | median 51.0 min, n=10 | #1026 **4.0 min** (blocked at plan, no work); #2687 **16.1 min** to `review done`. n=2, and neither shipped, so this measures member work only — not a comparable unit |
| cost / issue | $16.00 | **$2.00** mean across the 2 dispatched members, but 1 of the 2 did no work — the only member that produced a change cost **$3.54** |
| eviction rate | N/A | **2 / 2 members = 100%** |
| dissolve rate | N/A | **1 of 1 batch (100%)** |
| CI executions / issue | 2.73 | **0** on the pilot arm — the batch never opened a PR. The control #3966 took **8** workflow runs on its head sha; the #1026 re-run took **9**. Both counts include `pull_request_target` and `dynamic` events, so they are not directly comparable to attempt 1's 2.73 |
| makespan | 1.07 issues/h | not measurable — no batch completed |
| batch setup time | N/A | **< 1 s** (pool claim). Attempt 2: fatal `env-cold` |
| enqueue → dissolve | N/A | **21 min** |
| misclassification | not computable | **0 of 3 contradicted.** #1026 and #2687 both classified `slot` and both behaved like slot work — neither eviction was a classification error (one is a validator gap, one a gate gap). #3966's `full` was confirmed by execution: it merged as a full-cycle run |
| human interventions | 0 (n=11) | **3** — see §21.3 |
| regressions | 0 | N/A on the pilot arm; the two merged control/re-run PRs are inside #529's 7-day window |

**No cost claim is made from this run.** The pilot arm produced one member's work and then threw it
away; there is no batch tail (shared PR, shared CI, shared merge) to measure, so the §13.3 ceiling
caveat applies here even more strongly. §13.3's **−49% on member work, with the shared tail unmeasured**
remains the defensible figure the pilot has produced. #529 owns the verdict.

### 21.3 Human interventions (3)

| # | intervention | why it was needed |
|---|---|---|
| 1 | Entered FRESH over `runstate verify`'s `resume_from=report` | #582 — obeying `verify` would have made attempt 3 a no-op that reported success |
| 2 | Added `dispatch.suite_command = ["ai-dossier","cap","run","test.focused"]` to the imboard sched config | imboard's `test.full` capability is confirmed slower than the runner's 10-minute `BATCH_SUITE_TIMEOUT_MS`, so the aggregate gate would have timed out into `suite-unreadable` and blocked the batch — a state with no CLI resume verb. **Never exercised: the batch died before `validating`.** |
| 3 | Overrode #1026's tier `mechanical → mid` | the owner's model-parity clause; dispatching one member on haiku would have measured the model, not the batch |

Down from 6 in run 2. The three that run 2 spent forcing batch ordering by hand (§13.4 interventions
2–4) were made unnecessary by #565.

## 22. Limitations (run 3)

- **Two members is a thin batch.** The 2-member size is what the backlog allowed, and it makes the
  dissolve threshold structurally 1 (`N−1` clamp) — a larger batch would have tolerated the first
  eviction with more headroom. The eviction *causes* are size-independent, but the dissolve timing is not.
- **#562's aggregate-suite fix is still unexercised.** No batch has reached `validating` in any attempt.
  Intervention 2 was pre-emptive and remains unvalidated.
- **The cross-repo caveat stands.** The pilot arm ran in imboard; attempt 1's baseline ran in
  ai-dossier. The imboard-side baseline is `sched-parity.md` §4.1's fleet arm. #3966 is the first
  same-repo, same-window, same-tier full-cycle control the pilot has, and it is n=1.
- **The reproduction of B4b was run with hardlinked `node_modules`** (`cp -al` from a warm pool spare)
  rather than a fresh `pnpm install`. That affects nothing in the finding — pnpm's filter matched zero
  projects before any test could run — but it is not a pristine environment.
- **#2687 never shipped on either arm**, so §21.1a's comparison is "which attempt finished its work",
  not §13.3's cost-per-shipped-issue. Both full-cycle generations died on `agent-exited-unverified`
  (the same mode that hit #3820 and #542 in run 2), which is a general dispatch failure, not a batch
  defect — so neither the batch arm's win nor its cost figure should be read as a controlled result at
  n=1. The issue is left `failed` in the queue; both artefacts are preserved on `origin` (the member
  commit at `4c505523c` on `batch/b-20260902-01-20260902`, the full-cycle review fixes at `237a70375`).
  Whether to recover either or re-run from scratch is a call for #529 and #2687, not for this record.

## 23. Acceptance criteria (attempt 2 overall, after run 3)

| AC | status |
|---|---|
| **AC1** — ≥ 1 batch executed end-to-end | **NOT MET.** `b-20260902-01` prepared, sealed, anchored, dispatched, warmed and executed both members' agents — then dissolved on #579 and #583. Zero batches have completed across three runs. |
| **AC2** — "Batch #490 is batch 1" | **NOT ACHIEVABLE**, revising §15. §15 scored this *met for the ai-dossier arm* on the narrow reading (#490 was reused as `b-20260829-01`'s anchor and was that repo's first batch). On the substantive reading — #490 **executes** as batch 1 — it is unachievable: `b-20260829-01` dissolved on B3a and #487/#488/#489 shipped through the full-cycle fallback. Recorded rather than dropped. |
| **AC3** — metrics vs the attempt-1 baseline | **PARTIAL** — §21. Tokens/cost, CI executions, eviction/dissolve rate, misclassification and interventions are all measured; wall-clock is measured but at n=2 with neither issue shipped; makespan is not measurable at all, because no batch completed. |
| **AC4** — execution only: batches merged + deployed, anchors and trails linked, record in this file | **PARTIALLY MET.** This record and the anchor/trail links exist (§24); no batch merged, so nothing was deployed from the pilot arm. As in run 2, #526 stays open, so the links land in the run's comments rather than in a closing comment — that clause defers with the issue. |

**0 met, 2 partial, 1 not met, 1 not achievable.** The counts moved from run 2 (§15: 1 met, 2 partial,
1 not met) and so did the substance: run 2 could not warm a worktree, and run 3 executed members. The
remaining blocker is **#583** (with its script-side half, imboard-monorepo#3982) — #579
was fixed mid-run by PR #581, #580 was closed as a duplicate of #583, and #582 was fixed by a
later full-cycle run (PR #586). #583 carries a reproduction and acceptance criteria and is
full-cycle ready.

## 24. Appendix — evidence (run 3)

- Batch anchor: [imboard-monorepo#3976](https://github.com/imboard-ai/imboard-monorepo/issues/3976) —
  `b-20260902-01`, run id `r-3976-ba75`
- Surviving member work: `origin/batch/b-20260902-01-20260902` @ `4c505523c` (#2687's complete change,
  discarded by the dissolve but never deleted)
- Merged this run: PR [imboard#3978](https://github.com/imboard-ai/imboard-monorepo/pull/3978) `b33684f43`
  (#3966, the full-cycle control) · PR [imboard#3979](https://github.com/imboard-ai/imboard-monorepo/pull/3979)
  `5bfa183f5` (#1026, the re-run after eviction)
- Runstate trail for this run: `r-526-eba7` on [#526](https://github.com/imboard-ai/ai-dossier/issues/526)
  (`prior_run=r-526-9313`)
- Slot-cycle member trails: `r-1026-47ce` (#1026, `plan/blocked reason=git-unavailable`) and the
  #2687 member run recorded in `batch-b-20260902-01-m2-2687.log`
- Full-cycle re-runs after the dissolve: `r-1026-95f7` (#1026, gate→report, merged) and, for #2687,
  `r-2687-2724` (fenced `gen=0`) then `r-2687-df2f` (the `gen=1` opus takeover, also unverified)
- Classify records: `r-1026-a195`, `r-2687-42fb`, `r-3966-2b7f` (all fresh, mechanical tier)
- `plan:v1` artifacts posted by this run: imboard #1026, #2687, #3966
- Batch-prep audit + manifest: `~/.dossier/logs/batch-prep/imboard-ai-imboard-monorepo/BATCH-PLAN-20260902-122327.md.gz`
  and `manifest-20260902-122327.json` (hcc2, machine-local)
- Raw dispatch logs: `~/.dossier/sched/imboard-ai-imboard-monorepo/runs/batch-b-20260902-01-m1-1026.log`,
  `...-m2-2687.log`; journal `~/.dossier/sched/imboard-ai-imboard-monorepo/events.jsonl`
- Blockers from this run: [#583](https://github.com/imboard-ai/ai-dossier/issues/583) — incremental gate
  reads an inconclusive `cap run` as a member failure (open; [#580](https://github.com/imboard-ai/ai-dossier/issues/580)
  was the duplicate filed minutes apart and closed into it; script-side half
  [imboard-monorepo#3982](https://github.com/imboard-ai/imboard-monorepo/issues/3982)) ·
  [#582](https://github.com/imboard-ai/ai-dossier/issues/582) — `runstate verify` resumes into `report`
  on a completed prior run (**fixed**, PR #586) · [#579](https://github.com/imboard-ai/ai-dossier/issues/579) —
  `plan validate` misread exit 128 as a git failure (**fixed mid-run**, PR #581 `c4a4740`).


# Part IV — run `r-590-84e0` (2026-09-03 05:00→07:00Z, hcc2)

Attempt 4, run under a **fresh issue** — [#590](https://github.com/imboard-ai/ai-dossier/issues/590)
supersedes the closed #526, whose trail was three completed runs deep and whose every re-enqueue
resumed or closed out a previous run's trail (#575, #582, #586 fixed those rails).

**Headline: the batch pipeline is no longer the bottleneck — the per-member gate is, and it is a
constant function.** All three batches sealed `ready` with bound anchors, were assigned within 16
seconds, and claimed warm worktrees before their slot assignment was even journalled. Then the
incremental member gate returned `task-failed` for **every member it evaluated** — three different
diffs, in three different batches, producing three 765-byte gate logs that differ only in the batch id
inside one path and contain **no test output at all**. All three batches dissolved; the first two 32
minutes after enqueue, the third at 06:46Z. **Zero batches completed. AC1 is not met for the fourth
time — but for the first time the reason is a single, fully root-caused, two-line defect rather than a
chain of unknowns.**

Three issues carry it: [#594](https://github.com/imboard-ai/ai-dossier/issues/594) (the gate has no
"the suite produced no output" signal), [imboard-monorepo#3996](https://github.com/imboard-ai/imboard-monorepo/issues/3996)
(the script-side root cause) and [#595](https://github.com/imboard-ai/ai-dossier/issues/595) (eviction
bookkeeping that cannot be reconciled with the spawn sequence and that dissolved a batch early).

## 25. Environment (run 4)

| | |
|---|---|
| host | hcc2 (this box) |
| `@ai-dossier/cli` | 0.33.0 (npm latest at dispatch) |
| `@ai-dossier/sched` | 0.21.0 (npm latest) |
| pilot project | `imboard-ai-imboard-monorepo`, `max_slots=3`, `stall_timeout_ms=10800000` |
| tier models | `mechanical→haiku`, `mid→sonnet`, `strong→opus` |
| dispatch argv | `claude -p --output-format json --model {model} --disallowedTools Monitor` |
| engine tick | `~/.dossier/reset-fleet/tick.sh`, cron `*/2` |
| this run's unit | `issue:590` on `imboard-ai-ai-dossier` slot 1, tier strong (opus) |

**Model parity needed no intervention this time.** The imboard sched config already carried the claude
tier mapping above, so the token comparison isolates batching rather than the model — unlike attempt 3,
where the mapping had to be checked against a parity-W3 openrouter override.

**`--disallowedTools Monitor` is live** (#591/#593) and **no batch member exited unverified**, across
7 member dispatches. The mode is not extinct, though: it recurred **once, on a full-cycle fallback** —
`issue:3985` at `06:40:16.780Z` journalled `verify-incomplete detail=unverified-exit`, was fenced
`gen=1` (`r-3985-53f6`, `takeover=slot-1-r1`) and re-dispatched at **strong**. That is the strong
re-dispatch §26.3 records at 06:04→. `--disallowedTools Monitor` was present on that dispatch, so an
armed `Monitor` is not the residual cause; check the entry's `last_tool` (#591) before assuming
otherwise. Attempt 3 lost both #2687 generations and $20.06 to this mode; one fenced-and-recovered
occurrence is a large improvement, not a clean sheet.

## 26. What ran

### 26.1 Cohort generation — the first full backlog sweep

Attempt 3 recorded a limitation it could not fix: its three-issue cohort was **hand-narrowed before
the classifier saw it**, so its 2/3 slot yield measured the classifier's agreement with a human
pre-filter, not a backlog hit rate. This run removed the pre-filter. Every open imboard issue that
survives the label exclusion set went through the deterministic prescreen, and every prescreen
candidate got a classifier dispatch.

| stage | in | out | method |
|---|---|---|---|
| open issues | — | **111** | `gh issue list --state open` |
| label exclusions | 111 | **68** | the `batch-issues-preparation` Step 1 exclusion set (`epic`, `batch-epic`, `decomposed`, `needs-clarification`, `decision-pending`, `in-progress`, `parked`, `blocked`, `research`/`spike`, `cycle:full`/`ready:full-cycle`, `triaged`, `nightly-failure`, `heartbeat-tracker`, `reminder`, `upstream:*`), plus the two standing exclusions #3968 and #3549 carried from attempt 3 |
| deterministic prescreen | 68 | **33 `candidate`** (35 `full`) | `ai-dossier classify prescreen --issue <n> --submitted-set <33>`, no model calls |
| `issue-cycle-classifier` | 33 | **7 `slot`**, 26 `full` | one mechanical-tier (haiku) dispatch per candidate |

**True slot yield: 7/111 = 6.3% of the open backlog, 7/33 = 21% of prescreen candidates.** This is the
denominator §3.5 and `batch-pilot.md` §5.3 have wanted since attempt 1, measured without a human
pre-filter for the first time.

The seven `slot` verdicts:

| issue | risk | est_files | est_diff | areas | confidence | record |
|---|---|---|---|---|---|---|
| #3985 | low | 3 | 60 | frontend,shared-types | 0.95 | `r-3985-f11e` |
| #47 | low | 2 | 100 | marketing,docs | 0.85 | `r-47-bec2` |
| #826 | low | 2 | 200 | cli,docs | 0.75 | `r-826-8de4` |
| #340 | med | 7 | 220 | frontend,integrations,config | 0.85 | `r-340-f37a` |
| #1512 | med | 5 | 300 | monitor,agents | 0.75 | `r-1512-7be9` |
| #3416 | med | 6 | 300 | backend,api | 0.72 | `r-3416-43e1` |
| #3393 | med | 4 | 380 | backend,api,campaigns | 0.68 | `r-3393-2efe` |

The 26 `full` verdicts were classified and labelled but **not enqueued** — 26 concurrent full-cycle
entries would have destroyed the makespan measurement, the same reasoning attempt 3 recorded for its
eleven. No full-mode control was enqueued either, so that all three slots stayed available for the
batches and for the full-cycle fallbacks the evictions would produce.

**A prediction was registered before enqueue**, on #590, so this run measures classifier quality
prospectively instead of rationalising the outcome afterwards
([comment](https://github.com/imboard-ai/ai-dossier/issues/590#issuecomment-5520939662), posted
05:25:06Z, ahead of the 05:25:5x enqueue). Reading the seven bodies after classification, **six carried
a readiness blocker that E.2 has no floor rule for**:

| member | predicted blocker | what actually happened |
|---|---|---|
| #3985 | **none** — exact file:line, three checkable ACs, an existing guard test | implemented correctly (5 files, both sides of the deliberate pin-test updated), then **evicted by the gate defect** |
| #47 | marketing copy for the product *website*; names no repository path | **`misclassified`** — the slot-cycle tripwire caught it, exactly as predicted |
| #1512 | gated on an operator review; deliverable `spawn-monitor-agent.sh` is **not in this repo** | **`unrefinable-plan`** — as predicted |
| #3393 | scope item 2 left open by the PRD ("decide which before this PR starts") | **`spec-not-met`** — as predicted |
| #826 | body is an explicit "Research Directive", six investigation areas, no deliverable | **evicted by the gate defect** before readiness was ever tested |
| #3416 | body states outright "fixing it needs a product decision, not just an endpoint" | **evicted by the gate defect** before readiness was ever tested |
| #340 | needs a provisioned Gleap project + paid API key | spawned as member 3/4 at 05:50:09Z; its outcome is unattributable — see §27.2 |

**The prediction was directionally right, and the part it got wrong is the finding.** Three of the six
unready members (#47, #1512, #3393) *were* caught by exactly the tripwires designed for them — that is
the readiness rail working. But the gate defect fired first on #826 and #3416, so their readiness was
never actually tested, and it also killed #3985, the one member with no readiness problem at all.
**Cohort readiness is a real second-order problem; it is not this run's blocker.**

### 26.2 The three batches

Composed by `imboard-ai/git/batch-issues-preparation` v1.2.0, deterministic first-fit over E.4's six
hard constraints, walked in ascending issue number (no dependency edges survived — #1512's `deps=1511`
resolved to a CLOSED issue and was dropped).

| batch | anchor | members (execution order) | Σ est_diff | eviction group |
|---|---|---|---|---|
| `b-20260903-01` | [#3993](https://github.com/imboard-ai/imboard-monorepo/issues/3993) | #47 → #826 → #340 → #1512 | 820 | none |
| `b-20260903-02` | [#3994](https://github.com/imboard-ai/imboard-monorepo/issues/3994) | #3985 → #3393 | 440 | none |
| `b-20260903-03` | [#3995](https://github.com/imboard-ai/imboard-monorepo/issues/3995) | #3416 | 300 | none |

`b-20260903-03` is a single-member batch and that is first-fit output, not hand-tuning: `b-01` was
already at the 4-member cap when the walk reached #3416, and E.4 constraint 6 (no two `risk=med`+
members touching the same area) forbids co-batching it with #3393 — both are `backend,api`.

**#590's fallback clause was not needed and is now void.** The issue says to run the ai-dossier
docs/chore batch (#490 cohort) as a third batch if imboard yields fewer than three. Three imboard
batches were formed, so it did not apply — but the fallback is also **exhausted**: #490 is closed and
its members #487/#488/#489 have all shipped. A future attempt cannot reach for it.

### 26.3 Timeline (UTC, 2026-09-03)

Timestamps are from `events.jsonl` unless marked, because two clocks are in play — see §27.2.

| time | event |
|---|---|
| 05:0x–05:23 | prescreen ×68, then 33 classifier dispatches (throttled to ≤4 concurrent — see §30) |
| 05:23 | 7 `plan:v1` artifacts posted (none existed) |
| 05:25 | anchors #3993/#3994/#3995 created; audit file + manifest written; readiness prediction posted (05:25:06Z) |
| 05:25:5x | `sched enqueue --from-manifest` → **all three batches sealed `ready` with bound anchors** |
| 05:26:07.532 | **`batch-setup-done` for all three** — warm pool claims, zero `env-cold`; members 1/N spawned |
| 05:26:07.538 / :15.630 / :22.930 | b-01 / b-02 / b-03 `assigned` (setup is stamped at pool claim, *ahead* of two of the three assignments) |
| 05:30:08.775 | #47 `unit-failed misclassified` → requeued; #826 spawned as member 2/4 |
| 05:40:08 | #3985 `external-advance — member review done` (work complete, `af527d743` pushed) |
| 05:41:53.403 | #3985 evicted `incremental-gate-failed:test.focused`; #3393 spawned as member 2/2 |
| 05:50:09.352 | b-01 advances: #340 spawned as member 3/4 (an eviction is recorded against **#826** at this instant — §27.2) |
| 05:52:11.467 | b-01 advances: #1512 spawned as member 4/4 (a **second** eviction recorded against #826) |
| 05:53:28 / 05:54:28 | two `unit-failed #826 incremental-gate-failed:test.focused` entries, one minute apart |
| 05:58:09.027 | **`b-20260903-01` dissolved** — `eviction-threshold strategy=full N=4 evictions=3 threshold=2 requeued=47,826,340,1512 preserved=none` |
| 05:58:09.027 | **`b-20260903-03` dissolved** — `N=1 evictions=1 threshold=0 requeued=3416 preserved=none` |
| 05:58:10 | #1512 `unit-failed unrefinable-plan` |
| 06:00:07 | #3416 `unit-failed incremental-gate-failed:test.focused` (journalled after its batch's dissolve — §27.2) |
| 06:04→ | requeued members run as full-cycle: #3985, #340, #826, #1512, #3416 |
| 06:40:16.780 | full-cycle `issue:3985` `verify-incomplete unverified-exit` → fenced `gen=1`, re-dispatched at **strong** (§25) |
| 06:46:14.760 | **`b-20260903-02` dissolved** — `N=2 evictions=2 threshold=1 requeued=3985,3393 preserved=none` |
| 06:46:15.927 | #3393 `unit-failed spec-not-met` |

**Enqueue → first two dissolves: 32 minutes. Enqueue → all three: 80 minutes.**

## 27. B5 — the incremental member gate is a constant function

### 27.1 Three members, three diffs, three interchangeable gate logs

| batch | member | gate log | bytes | test output |
|---|---|---|---|---|
| `b-20260903-01` | #826 | `batch-b-20260903-01-gate-test.focused-826.log` | **765** | none |
| `b-20260903-02` | #3985 | `batch-b-20260903-02-gate-test.focused-3985.log` | **765** | none |
| `b-20260903-03` | #3416 | `batch-b-20260903-03-gate-test.focused-3416.log` | **765** | none |

The three are identical apart from the batch id inside one `cwd` path — same 765 bytes, the **same
merge-base `b572910d2` across three different batches**, the same absence of any test output. (Their
md5s differ for exactly that one substring; do not expect `md5sum` to match.) Each contains only the
script's own framing plus the line that explains everything:

```
cap-test-focused: testing scope = merge-base b572910d27115d821465f68dbbd53f7d2eaae952
cap-test-focused: running: pnpm --filter "...[b572910d2]" ... run test (cwd: .../batch-b-20260903-02-20260903/main)
tee: /dev/stderr: No such device or address
cap-test-focused: pnpm --filter "...[b572910d2]" ... run test exited 1 — real test failure.
```

**Root cause** (imboard-monorepo#3996). Read the script from the remote, not the repo root — there is a
stale shorter copy at the imboard-monorepo repo root, outside `main/`, in which none of these lines
resolve and `run_pnpm_capture` does not exist at all (the shadow-copy wall `AGENTS.md` warns about):
`git show origin/main:scripts/cap-test-focused.sh`, L97-98:

```sh
run_pnpm_capture() {
  (cd "$MAIN_DIR" && pnpm "$@") 2>&1 | tee /dev/stderr
}
```

Under `sched` dispatch, stderr is a redirected log file, not a device `tee` can reopen, so
`tee /dev/stderr` fails. With `set -uo pipefail` (L47) this has **two** fatal effects:

1. **The exit code is fabricated.** The comment above the function (L92) asserts that pipefail
   *"makes the pipeline's `$?` pnpm's own exit code, not tee's"*. That is wrong — `pipefail` returns
   the rightmost **non-zero** status of any element, so a failing `tee` turns a green pnpm run
   non-zero.
2. **The captured buffer is empty**, so the `grep -q "No projects matched the filters"` guard at L136 —
   the entire point of #3982 — never matches, `retry_with_name_filter` never runs, and the script falls
   through to `"real test failure"`. Note `classify_test_exit` fires at L132-134, *before* that guard,
   so fixing only the capture is insufficient: the fabricated status short-circuits the retry even when
   the buffer survives. That ordering is called out on #3996.

**Hand-run proof**, same batch worktree, same command, normal stderr:

```
$ pnpm --filter "...[b572910d27115d821465f68dbbd53f7d2eaae952]" \
    --changed-files-ignore-pattern "*.md" ... run test
No projects matched the filters in ".../worktrees/batch-b-20260903-02-20260903/main"
$ echo $?
0
```

pnpm exits **0**, and the suite never ran — the original #3982 symptom, still present in a linked
worktree. The `1` the gate acted on came from `tee`. **#3982's retry is correct and unreachable**,
disabled by the same failure that fabricates the exit code it was meant to catch.

**The sched-side half (#594).** #585 fixed #583 for the case where the capability *reports*
inconclusive — and that fix works: for the first time the `unit-failed` journal entry carries the
gate's actual output, which is how this was root-caused in minutes rather than by opening a
transcript. But it has no defence against a capability reporting a **definite failure it did not
earn**. The gate had a second, independent signal available and ignored it: a `task-failed` whose
result body contains **zero test output** is not a red suite, it is a broken capability, and it should
take #585's block-the-batch path rather than the eviction path.

Counting attempt 2's #3631 and attempt 3's #2687, that is **five members for five**. Until #3996 and
#594 land, every imboard batch member is evicted deterministically and **no batch can ever complete**.
This is the single blocking defect for RFC-0001 Step 3, and it sits upstream of every cohort-quality
question.

### 27.2 Eviction bookkeeping that cannot be reconciled (#595)

`b-20260903-01`'s eviction list, from `state.json` → `batches["b-20260903-01"].evictions[]` (this is the
eviction record's own `at`; the matching `unit-failed` journal entries are ~3 minutes later, because the
record is stamped at member hand-back and the journal at gate completion):

```json
[{"issue":47,  "reason":"misclassified",                        "at":"05:30:07.677Z"},
 {"issue":826, "reason":"incremental-gate-failed:test.focused", "at":"05:50:09.352Z"},
 {"issue":826, "reason":"incremental-gate-failed:test.focused", "at":"05:52:11.467Z"},
 {"issue":1512,"reason":"unrefinable-plan",                     "at":"05:58:09.027Z"}]
```

Two things are wrong with it, and the second is only visible against the spawn sequence:

1. **#826 appears twice**, and the journal carries two matching `unit-failed #826` entries (05:53:28,
   05:54:28) and two `member-advanced #826` entries.
2. **#340 has no eviction record at all, yet it ran.** The journal shows `spawned #340 member 3/4` at
   **05:50:09.352Z** and `spawned #1512 member 4/4` at **05:52:11.467Z** — the exact instants of the two
   #826 eviction records. A batch advances to member N+1 when member N is evicted, so the second record
   is the eviction that ended **#340**, mis-attributed to the previous member.

The dissolve decision counts entries from this list: `N=4 evictions=3 threshold=2`. Whether the true
count is 3 or 2 depends on which reading is right, and **that is the point** — the bookkeeping cannot
be reconciled with the spawn sequence, so the eviction rate the pilot reports, and the threshold that
decides whether a batch lives, both rest on a list that double-counts one member and loses another.
It also corrupts the eviction-rate measurement RFC-0001 §E.5 uses to decide whether the 4-member cap
can be raised.

Note that the `batch-dissolved` event's own `requeued=47,826,340,1512` is already de-duplicated to four
distinct issues, so **the repeat is invisible in the event you would naturally grep**. It lives only in
`state.json`:

```sh
jq '.batches["b-20260903-01"].evictions | group_by(.issue) | map({issue: .[0].issue, n: length})' \
  ~/.dossier/sched/imboard-ai-imboard-monorepo/state.json
```

The same clock split explains why #3416's `unit-failed` (06:00:07) is journalled two minutes *after*
its batch's dissolve (05:58:09) — the batch dissolved on the eviction record; the journal entry for the
already-evicted member followed.

## 28. What is now fixed — verified by execution, not by reading

Every blocker attempts 1–3 root-caused is gone, and this run is the evidence:

| blocker | evidence from this run |
|---|---|
| #545 — batches never seal `forming → ready` | all three `status=ready` immediately after `sched enqueue` |
| #536 / #539 — anchor never bound | `anchor: 3993 / 3994 / 3995` on all three; the engine dispatched all three |
| #561 — batch worktree never warmed (`env-cold`) | all three `batch-setup-done` at `05:26:07.532Z` — within 16 s of the last `assigned` and *ahead* of two of them, because setup is stamped at pool claim. **Zero `env-cold` hand-backs.** Attempt 2 lost two members and a whole batch to this in ~4 minutes |
| #565 — batches do not outrank full-cycle entries | all three dispatched at `priority=10` within 16 s of assignment, filling all three slots |
| #564 — `sched stats` empty for batch members | `sched stats --batch <id> --project imboard-ai-imboard-monorepo` returned real per-member cost for all three batches (§29.1) — no hand-parsing of `runs/*.log` |
| #579 / #581 — `plan validate` misreads a by-design-new file as `git-unavailable` | **zero `git-unavailable` evictions**, across 7 members whose plan artifacts predict 6 files that do not exist at HEAD. Attempt 3 lost #1026 to exactly this |
| #583 / #585 — the gate's output was not captured | the `unit-failed` detail now carries the gate's actual stdout — the entire root cause in §27.1 came from that field |
| #591 / #593 — `agent-exited-unverified` | `--disallowedTools Monitor` present on every dispatch; **zero unverified exits among the 7 batch members**, one on a full-cycle fallback that was fenced and recovered (§25). Attempt 3 lost both #2687 generations and $20.06 to this |
| #575 / #582 / #586 — stale `report/done` resumes | #590 is a fresh issue with a clean trail; `runstate verify` returned `resume_from=none` and the run entered fresh with no operator override. Attempt 3 needed one |

## 29. Metrics (run 4)

### 29.1 Per-dispatch cost — batch members

From `ai-dossier sched stats --batch <id> --project imboard-ai-imboard-monorepo` (`modelUsage`, per
`batch-pilot.md` §5.4c — not the top-level `usage` block). **The `--project` flag is required**: without
it the command resolves the project from the working directory and reports `No dispatch logs found for
batch …`, which reads like data loss.

| batch | issue | in | out | cache-w | cache-r | cost | model |
|---|---|---|---|---|---|---|---|
| `b-01` | #47 | 32 | 8,058 | 56,353 | 1,068,860 | **$0.5198** | sonnet |
| `b-01` | #340 | 106 | 29,434 | 109,815 | 4,982,406 | **$1.7303** | sonnet |
| `b-01` | #826 | 176 | 71,359 | 203,694 | 10,306,978 | **$3.8314** | opus[1m], sonnet |
| `b-01` | #1512 | 44 | 13,731 | 63,577 | 1,544,845 | **$0.7007** | sonnet |
| | **b-01 total** | 358 | 122,582 | 433,439 | 17,903,089 | **$6.7822** | |
| `b-02` | #3985 | 156 | 32,048 | 162,318 | 7,498,379 | **$2.6886** | opus[1m], sonnet |
| `b-02` | #3393 | 252 | 71,759 | 319,444 | 18,671,064 | **$6.0752** | opus[1m], sonnet |
| | **b-02 total** | 408 | 103,807 | 481,762 | 26,169,443 | **$8.7639** | |
| `b-03` | #3416 | 266 | 71,676 | 330,530 | 17,652,202 | **$5.7960** | opus[1m], sonnet |

**$21.34 across 7 member dispatches, zero merged.** Cost per merged member: undefined — the denominator
is zero for the fourth attempt running. This excludes the five full-cycle fallback runs the dissolves
requeued, which were still in flight when this record was written.

Note the `opus[1m]` entries: members dispatched at `mid`/sonnet still show opus usage, because the
slot-cycle's own internal sub-dispatches (review agents) run at their own tier. The `tier` column is
empty for batch members — a reporting gap worth closing before the arm-vs-arm comparison in #528/#592.

### 29.2 Cohort-generation cost

| | attempt 3 (mechanical tier) | attempt 4 (mechanical tier, full sweep) |
|---|---|---|
| prescreens (deterministic, no model) | 3 | **68** |
| classify dispatches | 3 | **36** (33 issues + 3 re-dispatched, §29.4) |
| total agent tokens | 96,449 | **≈1,526,000** |
| mean per classify | 32,150 | **≈42,400** |
| mean duration | 99.5 s | **≈139 s** |
| wall-clock | ~2 min | **≈2 h 05** (throttle-bound, not model-bound — §30) |
| slot yield | 2/3 (hand-narrowed set) | **7/33 candidates; 7/111 open backlog** |

The per-classify cost rose ~32% against attempt 3 because this sweep hit far more large greenfield
features, which cost more to reject than a pre-narrowed set costs to confirm. That is the price of a
real denominator and it is worth paying once; the 35 issues the *deterministic* prescreen rejected cost
zero tokens, which is #538 doing its job at scale for the first time.

### 29.3 Against the attempt-1 baseline

| metric | baseline (attempt 1, full-cycle) | attempt 4 (batched) |
|---|---|---|
| batches completed | n/a | **0 of 3** |
| members merged | n/a | **0 of 7** |
| eviction rate | n/a | **7 of 7 members requeued (100%)**; 3 by the single infra defect of §27.1, 3 by readiness tripwires, 1 unattributable (§27.2) |
| dissolve rate | n/a | **3 of 3 batches dissolved** — two within 32 min, the third at 80 min |
| makespan | measurable | **not measurable** — no batch completed |
| CI executions saved | — | **0** — no batch PR was opened |

Makespan and CI-execution savings remain unmeasurable for the fourth consecutive attempt, and will stay
so until #3996 and #594 land. Every other pipeline metric is now green.

### 29.4 Human interventions (2)

1. **Tier override for #47 and #826.** Step 8's rule maps docs-only areas + `risk=low` to `mechanical`.
   The pilot's model-parity clause requires the batched arm to run at the baseline's `mid`/sonnet tier
   so the token comparison isolates batching rather than the model, so both were enqueued at `mid` —
   the same override attempt 3 counted for #1026.
2. **Three classifier re-dispatches.** The harness permission classifier interrupted three agents
   between their analysis and their `runstate post` (#1021, #1009, #340), so each was re-dispatched. No
   verdict was authored by hand; all 33 records on the issues are the classifier's own.

Down from attempt 3's 3 and attempt 2's 6. No intervention touched a batch, a member, or a gate —
attempt 3's §21.3 interventions 2–4 (hand-deferring competitors) were not needed again.

## 30. Limitations (run 4)

- **Classifier fan-out was throttle-bound, not cost-bound.** `batch-issues-preparation` Step 3 allows 8
  concurrent classify dispatches; this session's harness permission classifier allowed at most 4 live
  and denied roughly half of all launch attempts, stretching a ~10-minute fan-out to ~2 hours. That is
  an artefact of this execution environment, not of the pipeline, and it inflates §29.2's wall-clock row
  only.
- **`--output-format json` in the imboard dispatch config.** #524 made
  `--output-format stream-json --verbose` the default precisely so a log is never near-empty for a unit
  that ran; this project's config overrides it back to `json`. **All three members that reached the gate
  (#3985, #826, #3416) journalled `run-log-no-usage … bytes:244`** — every one of them, not an isolated
  case — before `sched stats` later resolved their usage correctly. Systematic, and worth reverting to
  the default before the two-arm comparison in #592.
- **Six of seven slot members carried a readiness blocker** (§26.1). Three were caught by their intended
  tripwire; for the other three the gate defect pre-empted the test, so **misclassification rate is
  measured but not cleanly attributable this run** — the infra defect is confounded with cohort quality.
  A re-run with #3996 in will separate them.
- **One member's outcome is unattributable** (#340, §27.2). It was spawned as member 3/4 and the batch
  advanced past it, but no eviction record names it.
- **The #490 fallback cohort is exhausted** (§26.2). #590's "run the ai-dossier docs/chore batch as the
  third" escape hatch no longer exists; a future attempt short of three imboard batches has no fallback.
- **The 7-day regression window (§5.5) is untouched** — nothing merged, so there is nothing to observe.
  #529 stays unarmed.
- **The five full-cycle fallback runs were still in flight** when this record was written, so their
  outcomes and cost are not included in §29.1. They are ordinary full-cycle runs and their results
  belong to their own issues, not to the batched arm.

## 31. Acceptance criteria (attempt 4)

| AC | status |
|---|---|
| **AC1** — ≥3 imboard batches run to completion (sealed → executed → gate → single batch PR → merged) | **NOT MET.** All three sealed, anchored, dispatched, warmed and executed members. All three dissolved — two within 32 minutes, the third at 80. Zero batch PRs opened. Four attempts, zero completed batches — but the cause is now one defect (#3996 + #594), not a chain of unknowns. |
| **AC2** — per-member cost/time recorded against the full-cycle baseline | **MET.** §29.1 records per-member tokens and cost for all 7 members from `sched stats --batch` (`modelUsage`); §29.2 the cohort-generation arm; §29.3 the baseline comparison. Makespan and CI-savings rows are recorded as unmeasurable, with the reason. |
| **AC3** — cohort generated through the classifier, never hand-enqueued | **MET, and better than any prior attempt.** 111 → 68 → 68 prescreens → 33 classifier dispatches → 7 slot. The first sweep with **no human pre-filter**, which retires attempt 3's stated limitation and finally gives misclassification a real denominator (§26.1). |
| **AC4** — every eviction/dissolve/block root-caused and narrated; infra defects filed, not hand-fixed | **MET.** All three dissolves and every eviction are accounted for in §26.1, §26.3 and §27 — including the one (#340) whose bookkeeping does not reconcile, which is itself filed as #595 rather than glossed. Three defects filed with reproductions and acceptance criteria — #594, #595, imboard-monorepo#3996. No member was hand-fixed and no gate was bypassed; all seven members requeued to full-cycle as designed. |

**3 met, 1 not met.** The counts moved decisively from attempt 3's 0 met / 2 partial / 1 not met / 1 not
achievable. AC1 remains the only unmet criterion and, for the first time, the exact code change that
unblocks it is written down.

**#590 stays open and this record's PR carries no `Closes #590` trailer**, per the issue's own rule:
AC1 is not met. **#529 stays unarmed** — it is armed manually by the supervisor after the first batch PR
merges, never on issue closure.

## 32. Appendix — evidence (run 4)

- Runstate trail: `r-590-84e0` on [#590](https://github.com/imboard-ai/ai-dossier/issues/590)
  (fresh entry, `resumed_from=none prior_run=none`)
- Batch anchors: [imboard-monorepo#3993](https://github.com/imboard-ai/imboard-monorepo/issues/3993)
  (`b-20260903-01`) · [#3994](https://github.com/imboard-ai/imboard-monorepo/issues/3994)
  (`b-20260903-02`) · [#3995](https://github.com/imboard-ai/imboard-monorepo/issues/3995)
  (`b-20260903-03`)
- Surviving member work, preserved though the batches dissolved:
  `origin/batch/b-20260903-02-20260903` @ `af527d743` (#3985's complete change — `seed-kpis.ts`,
  `portfolio-jobs.ts`, `portfolio-jobs.test.ts`, `economic-impact-export.test.ts`,
  `board-monitor-summary.types.ts`). **Do not delete this branch — it is #3996's proof.**
- Classify records (33, all mechanical tier): `r-3985-f11e`, `r-3416-43e1`, `r-3393-2efe`,
  `r-1512-7be9`, `r-826-8de4`, `r-340-f37a`, `r-47-bec2` (slot) and 26 `full` records `r-<issue>-*` on
  their issues
- `plan:v1` artifacts posted by this run: imboard #3985, #3393, #3416, #1512, #340, #826, #47
- Pre-registered readiness prediction (before enqueue):
  [#590 comment](https://github.com/imboard-ai/ai-dossier/issues/590#issuecomment-5520939662)
- Batch-prep audit + manifest (hcc2, machine-local):
  `~/.dossier/logs/batch-prep/imboard-ai-imboard-monorepo/BATCH-PLAN-20260903-052500.md.gz` and
  `manifest-20260903-052500.json`
- Gate logs — the core evidence, three 765-byte files differing only in one path segment:
  `~/.dossier/sched/imboard-ai-imboard-monorepo/runs/batch-b-20260903-01-gate-test.focused-826.log`,
  `...-02-gate-test.focused-3985.log`, `...-03-gate-test.focused-3416.log`
- Member dispatch logs: `~/.dossier/sched/imboard-ai-imboard-monorepo/runs/batch-b-20260903-*-m*.log`;
  journal `~/.dossier/sched/imboard-ai-imboard-monorepo/events.jsonl`; eviction records
  `~/.dossier/sched/imboard-ai-imboard-monorepo/state.json`
- Blockers from this run: [#594](https://github.com/imboard-ai/ai-dossier/issues/594) — the incremental
  member gate has no "the suite produced no output" signal, so a suite that never ran still evicts the
  member (open) · [#595](https://github.com/imboard-ai/ai-dossier/issues/595) — eviction bookkeeping
  double-counts one member and loses another, and the dissolve threshold reads from it (open) ·
  [imboard-monorepo#3996](https://github.com/imboard-ai/imboard-monorepo/issues/3996) — `tee /dev/stderr`
  under `pipefail` fabricates exit 1 from a green run and empties the buffer #3982's retry greps (open)

### 32.1 Before the next attempt

**Is the blocker fixed?** Two checks, both cheap. Until BOTH pass, a re-run reproduces §27.1 exactly and
is not worth the ~$21:

```sh
# 1. the capture no longer depends on /dev/stderr being reopenable
git -C <imboard> show origin/main:scripts/cap-test-focused.sh | sed -n '95,100p'   # no `tee /dev/stderr`
# 2. the gate is green on a green tree, inside a LINKED worktree, with stderr redirected
cd <any linked worktree> && bash scripts/cap-test-focused.sh 2>/tmp/gate.log; echo $?
#    expect exit 0 AND /tmp/gate.log containing actual test output (not 765 bytes of framing)
```

**Re-run recipe.** `ai-dossier run imboard-ai/git/batch-issues-preparation` (v1.2.0) to regenerate the
cohort — it re-uses existing `classify` records and `plan:v1` artifacts, so the §29.2 cost is not paid
again — then `ai-dossier sched enqueue --from-manifest <manifest>`. #590's #490 fallback clause is void
(§26.2).

**State left behind.** Check `ai-dossier sched status --project imboard-ai-imboard-monorepo` before
enqueuing a new cohort: all seven members were requeued as full-cycle entries and will contend for the
three slots. `git worktree prune` in the imboard repo before reaching for the pool — a dissolved batch
can leave an unregistered `worktrees/batch-*` directory behind that `git worktree remove` cannot clear.
