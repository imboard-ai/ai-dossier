# Batch pilot attempt 2 — execution record

Execution-only record for [#526](https://github.com/imboard-ai/ai-dossier/issues/526). **No verdict
here** — the GO/NO-GO gate with the 7-day regression window is
[#529](https://github.com/imboard-ai/ai-dossier/issues/529), enqueued 7 days after #526 closes.

Companion to [`batch-pilot.md`](./batch-pilot.md) (attempt 1, NO-GO) and
[`sched-parity.md`](./sched-parity.md) (RFC-0001 Step-1 exit gate). Metric definitions are reused
verbatim from `batch-pilot.md` §2.2 so the three reports compare directly.

## Headline

**Batches executed end-to-end: 0 of ≥3 (AC1 unmet).** One batch was composed, anchored, and
enqueued onto the live imboard scheduler; it could not be dispatched. Two independent blockers,
both new, both root-caused below:

| # | blocker | kind | status |
|---|---|---|---|
| B1 | The eligible imboard backlog yields 3 slot-eligible issues — enough for exactly **1** batch, not 3 | cohort scarcity | measured, 16 issues classified |
| B2 | `@ai-dossier/sched` never transitions a batch `forming → ready`, and never binds its anchor — so an enqueued batch is permanently undispatchable | product bug | root-caused to file/line, reproduced |

Attempt 1's pilot arm was empty because batch units were not executable by the engine (§5.0 → #523).
Attempt 2's pilot arm is empty because the *entry into* that now-implemented execution machine was
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
| 20:17–20:20 | classify wave 1 — 9 issues, 3 `slot` |
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

**16 issues classified; 3 classified `slot` (18.8%).**

| verdict | issues |
|---|---|
| `slot` | #3631, #3820, #3887 |
| `full` | #3839, #3923, #3893, #3632, #3442, #3415, #3403, #3961, #2779, #3858, #3931, #3901 |

Floor rules doing the work on the `full` side: rule 8 (visual/browser review) five times, rules 5/6
(file and diff size) five times, rule 1 (security / infra risk floor) three times.

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
| misclassification rate | not computable (0/11 carried a classify record) | **0 / 16 contradicted** — but every verdict is unfalsified, not confirmed: no classified issue was executed, so a `slot` verdict that would have failed at dispatch cannot be detected. The denominator now exists (16); the numerator is untested. |
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

This number matters for #529: at ~64k tokens per classify and an 18.8% slot hit rate, cohort
generation is not free, and a backlog that yields one batch per 16 classifies changes the
arithmetic of batching's claimed savings.

## 5. What must be true before attempt 3

Carrying forward `batch-pilot.md` §5, with its resolved items dropped and the new ones added.

- [ ] **B2a — `@ai-dossier/sched` seals batches.** Something in production must perform
      `forming → ready`. The natural site is the end of a successful `enqueue` — its own code
      comment already asserts the invariant ("composition is frozen when the batch seals",
      `enqueue.js:307`), which reads as a seal that was designed and then not written. Needs a
      regression test that dispatches a batch **without** hand-sealing it, since the current suite's
      hand-seal is precisely what hid this.
- [ ] **B2b — the anchor reaches the scheduler.** Add `anchor` to the manifest schema documented in
      `imboard-ai/git/batch-issues-preparation` (the CLI already parses it), and have batch-prep
      Step 8 emit the anchor number it created in Step 6.
- [ ] **B2c — engine hosts run a current CLI.** #523 was satisfied in the repo and unsatisfied on
      the machine for six days without any signal. A version check in the tick, or a
      `sched status` warning when the installed `sched` is older than the state's schema, would
      have surfaced this immediately.
- [ ] **B1 — a cohort that supports ≥3 batches exists.** At the measured 18.8% hit rate, ≥3 batches
      of N≥3 needs ~48 classified candidates, and the eligible imboard backlog does not contain
      them today. Either the QA-sheet triage pipeline tops up the slot-eligible backlog first, or
      #529's target is restated in terms of what one batch can evidence.

Note that B1 and B2 are independent: fixing the scheduler still yields one batch, and topping up the
backlog still yields zero executions. Attempt 3 needs both.

## 6. Limitations

- The pilot arm is empty for the second consecutive attempt, so every §H metric that compares
  batched to unbatched execution remains unmeasured. Nothing here supports or refutes batching's
  claimed savings.
- The misclassification denominator (16) exists but the numerator is untestable without execution —
  a `slot` verdict is only falsified by dispatching it.
- The 18.8% hit rate is measured over the *low-risk-reading* subset of the eligible backlog, chosen
  by title/scope inspection. It is a fair estimate of yield under the current bar, not a census of
  all 68 eligible issues.
- Comparison caveat carried from #526's decision comment: the attempt-1 baseline arm ran on
  `ai-dossier`, not `imboard-monorepo`. The imboard-side baseline is `sched-parity.md` §3's fleet
  arm.

## 7. Acceptance criteria

| AC | status |
|---|---|
| AC1 — ≥3 batches executed end-to-end | **not met** — 0 executed; 1 composed and enqueued, blocked by B2 |
| AC2 — batch #490 is batch 1 | **not applicable** — superseded by the owner's 2026-09-01 decision pivoting the cohort source to imboard; #490 (`b-20260829-01`, ai-dossier #487/#488/#489) was never enqueued. Recorded as a deviation, not silently dropped. |
| AC3 — metrics vs the attempt-1 baseline | **partial** — §4. Baseline column complete; pilot column empty for want of executions; cohort-generation cost is new and complete. |
| AC4 — execution-only deliverable | **partial** — this report and the anchor/trail links are delivered; "batches merged + deployed" is not, per AC1. |

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
