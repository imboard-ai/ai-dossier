# Batch pilot attempt 2 — execution record

Execution-only record for [#526](https://github.com/imboard-ai/ai-dossier/issues/526). **No verdict
here** — the GO/NO-GO gate with the 7-day regression window is
[#529](https://github.com/imboard-ai/ai-dossier/issues/529), enqueued 7 days after #526 closes.

This file covers **both runs of attempt 2**: Part I is run `r-526-1248` (blocked before any batch
could dispatch); [Part II](#part-ii--run-r-526-9313-2026-09-01-2257--2026-09-02-hcc2) is run
`r-526-9313`, which dispatched three batches and is where the execution data lives.

Companion to [`batch-pilot.md`](./batch-pilot.md) (attempt 1, NO-GO) and
[`sched-parity.md`](./sched-parity.md) (RFC-0001 Step-1 exit gate). Metric definitions are reused
verbatim from `batch-pilot.md` §2.2 so the three reports compare directly.

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

Superseded by [§15](#15-acceptance-criteria-attempt-2-overall), which scores attempt 2 as a
whole across both runs. Run 1 alone met none of AC1–AC3 and delivered Part I of this report.

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
| B3c | `DISSOLVE_EVICTION_FRACTION = 1/3` dissolves a 3- or 4-member batch on its **second** eviction — one member failure is the entire tolerance | design parameter | `packages/sched/src/types.ts:663` (applied at `packages/sched/src/recovery.ts:851`) |
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
