# Model Scorecard

Generated: 2026-11-23T05:01:05.748Z | Window: 2026-10-24 → 2026-11-23

Cost, quality, and speed per LLM, joined from runstate trails (GitHub), `runs.jsonl`
(token/cost telemetry), and `events.jsonl` (dispatch tier, stall/escalation counts).
Regenerate with `npm run scorecard -- --days 30`. See #566.

**`n` is a confidence column, not a metric** — a row with `n=1` is one data point, not
a trend. Read `cost/delivered` and `delivery rate` alongside `n`, never alone.

## Per model × repo × tier

| Model | Repo | Tier | Agent CLI | n | Delivered | Delivery rate | AC met | Cost/delivered | Median API-min | Median wall-clock-min | Review fixed/issue | Stalls | Escalations | Unverified exits |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `<unknown>` | imboard-ai/imboard-monorepo | <unknown> | unknown | 30 | 13 | 43% | 96% (n=15) | N/A | N/A | 270.1 | 15.8 (n=25) | 0 | 0 | 0 |
| `<unknown>` | imboard-ai/imboard-monorepo | mechanical | claude | 1 | 0 | 0% | N/A | N/A | N/A | N/A | 2.0 (n=1) | 0 | 0 | 0 |
| `<unknown>` | imboard-ai/imboard-monorepo | mid | claude | 4 | 0 | 0% | N/A | N/A | N/A | N/A | 0.0 (n=4) | 0 | 0 | 0 |
| `<unknown>` | imboard-ai/imboard-monorepo | strong | claude | 6 | 0 | 0% | 89% (n=6) | N/A | N/A | N/A | 17.2 (n=6) | 0 | 0 | 0 |
| `claude-opus-5-5` | imboard-ai/ai-dossier | <unknown> | unknown | 2 | 2 | 100% | N/A | N/A | N/A | 99.0 | 3.0 (n=1) | 0 | 0 | 0 |
| `claude-opus-5-5` | imboard-ai/imboard-monorepo | <unknown> | unknown | 50 | 45 | 90% | 98% (n=32) | N/A | N/A | 145.8 | 16.0 (n=49) | 0 | 0 | 0 |
| `claude-opus-5-5` | imboard-ai/imboard-monorepo | mechanical | claude | 4 | 4 | 100% | 88% (n=3) | $37.323 (n=4) | 173.3 | 148.2 | 16.5 (n=4) | 0 | 0 | 0 |
| `claude-sonnet-5-5` | imboard-ai/imboard-monorepo | <unknown> | unknown | 1 | 0 | 0% | N/A | N/A | N/A | N/A | 2.0 (n=1) | 0 | 0 | 0 |
| `gpt-5.6-terra` | imboard-ai/ai-dossier | <unknown> | unknown | 1 | 1 | 100% | 100% (n=1) | N/A | N/A | 17.1 | 2.0 (n=1) | 0 | 0 | 0 |
| `gpt-6-luna` | imboard-ai/imboard-monorepo | <unknown> | unknown | 1 | 0 | 0% | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| `gpt-6.1-sol` | imboard-ai/imboard-monorepo | <unknown> | unknown | 11 | 9 | 82% | 100% (n=8) | N/A | N/A | 474.9 | 10.3 (n=10) | 0 | 0 | 0 |
| `gpt-6.2-sol` | imboard-ai/imboard-monorepo | <unknown> | unknown | 6 | 6 | 100% | 94% (n=5) | N/A | N/A | 327.2 | 10.2 (n=6) | 0 | 0 | 0 |
| `kimi-k3` | imboard-ai/imboard-monorepo | <unknown> | unknown | 1 | 0 | 0% | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |

## Totals per model (all repos/tiers)

One row per model, with the gateways it was served through as `↳` sub-rows whenever
there is more than one — the fold that makes the model row readable would otherwise
hide a gateway costing more or delivering less than the same weights elsewhere.

Billable tokens count **uncached input + cache-creation + cache-read + output** — cache
reads are billed and, on this fleet, are the dominant term (issue #540: 262 uncached vs
13.4M cache-read). That is the same total `batch-pilot-2-execution.md` §13 publishes.

| Model | Provider | Agent CLI | n | Delivered | Delivery rate | Δ vs prev | AC met | Cost/delivered | Billable tokens/delivered | Median API-min | Median wall-clock-min | Review fixed/issue | Stalls | Escalations | Unverified exits |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `<unknown>` | direct | claude | 41 | 13 | 32% | +18pt | 95% (n=21) | N/A | N/A | N/A | 270.1 | 13.9 (n=36) | 0 | 0 | 0 |
| `claude-opus-5-5` | direct | claude | 56 | 51 | 91% | -5pt | 97% (n=35) | $37.323 (n=4) | 251,872,342 (n=4) | 173.3 | 133.6 | 15.8 (n=54) | 0 | 0 | 0 |
| `claude-sonnet-5-5` | direct | unknown | 1 | 0 | 0% | -67pt | N/A | N/A | N/A | N/A | N/A | 2.0 (n=1) | 0 | 0 | 0 |
| `gpt-5.6-terra` | openai | unknown | 1 | 1 | 100% | +32pt | 100% (n=1) | N/A | N/A | N/A | 17.1 | 2.0 (n=1) | 0 | 0 | 0 |
| `gpt-6-luna` | openai | unknown | 1 | 0 | 0% | -80pt | N/A | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| `gpt-6.1-sol` | openai | unknown | 11 | 9 | 82% | -18pt | 100% (n=8) | N/A | N/A | N/A | 474.9 | 10.3 (n=10) | 0 | 0 | 0 |
| `gpt-6.2-sol` | 2 providers ↓ | unknown | 6 | 6 | 100% | — | 94% (n=5) | N/A | N/A | N/A | 327.2 | 10.2 (n=6) | 0 | 0 | 0 |
| ↳ | direct | unknown | 1 | 1 | 100% | — | 100% (n=1) | N/A | N/A | N/A | 322.1 | 15.0 (n=1) | 0 | 0 | 0 |
| ↳ | openai | unknown | 5 | 5 | 100% | — | 93% (n=4) | N/A | N/A | N/A | 332.2 | 9.2 (n=5) | 0 | 0 | 0 |
| `kimi-k3` | direct | unknown | 1 | 0 | 0% | +0pt | N/A | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| **TOTAL** | — | claude | 118 | 80 | 68% | — | 97% (n=70) | $37.323 (n=4) | 251,872,342 (n=4) | 173.3 | 173.6 | 14.1 (n=108) | 0 | 0 | 0 |

## Batch amortization

Batching exists to pay the CI gate **once for N issues** (#770), so the headline is
**issues shipped per gate run**. A gate run is one CI gate on one PR: `1 + ci_fix_attempts`
for a merged PR (batch or full-cycle alike), 0 for a batch that never merged. Shipped
members are the merged batch PR's closing references — a batch blocked at `batch-validate`
and recovered by hand never posts `batch-ship`, so its trail alone reads it as unshipped.

| Repo | Kind | Batches | Single-member | Shipped / dissolved / blocked | Enqueued | Shipped issues | Evictions | Gate runs | **Issues/gate run** | Median gate wall-clock | Wall-clock/shipped issue | Billable tokens/shipped issue (excl. prep) | Prep tokens/shipped issue (separate) | Cost/shipped issue |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| imboard-ai/ai-dossier | full-cycle (1 PR per issue) | — | — | — | 3 | 3 | — | 3 | **1.00** | N/A | 72 min | N/A | N/A | N/A |
| imboard-ai/imboard-monorepo | scheduler batches | 13 | 0 (0%) | 9 / 0 / 0 | 49 | 25 | 2 | 10 | **2.50** | 20 min | 120 min | 222.2M (n=5) | 4.9M (n=5) | $18.139 (n=5) |
| imboard-ai/imboard-monorepo | manual batch-cycle PRs | 5 | 0 (0%) | 5 / 0 / 0 | 24 | 24 | 0 | 5 | **4.80** | 21 min | 9 min | N/A | N/A | N/A |
| imboard-ai/imboard-monorepo | full-cycle (1 PR per issue) | — | — | — | 76 | 62 | — | 74 | **0.84** | N/A | 1006 min | 10.3M (n=2) | N/A | $5.110 (n=2) |

### Per batch

| Batch | Repo | Kind | Anchor | Outcome | Enqueued | Shipped | Evictions | Gate runs | PR | Gate wall-clock | Tokens by model | Prep tokens (separate) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `5102-polar-blockers` | imboard-ai/imboard-monorepo | manual | — | shipped | 3 | 3 | 0 | 1 | #5202 | 58 min | N/A (not on this host) | N/A |
| `5102-polar-high` | imboard-ai/imboard-monorepo | manual | — | shipped | 7 | 7 | 0 | 1 | #5209 | 112 min | N/A (not on this host) | N/A |
| `5102-review2-round1` | imboard-ai/imboard-monorepo | manual | — | shipped | 7 | 7 | 0 | 1 | #5227 | 19 min | N/A (not on this host) | N/A |
| `5102-review2-round2` | imboard-ai/imboard-monorepo | manual | — | shipped | 5 | 5 | 0 | 1 | #5231 | 21 min | N/A (not on this host) | N/A |
| `5102-review3-round1` | imboard-ai/imboard-monorepo | manual | — | shipped | 2 | 2 | 0 | 1 | #5243 | 15 min | N/A (not on this host) | N/A |
| `b-20261113-01` | imboard-ai/imboard-monorepo | sched | #4953 | shipped | 3 | 3 | 0 | 1 | #4956 | 20 min | N/A (not on this host) | N/A |
| `b-20261115-01` | imboard-ai/imboard-monorepo | sched | #4969 | shipped | 2 | 2 | 0 | 1 | #4989 | 13 min | `claude-opus-5-5` 309.3M, `claude-haiku-5-5` 1.2M | 7.5M |
| `b-20261115-02` | imboard-ai/imboard-monorepo | sched | #4991 | shipped | 2 | 2 | 0 | 1 | #5000 | 31 min | `claude-opus-5-5` 395.2M, `claude-haiku-5-5` 1.2M | 24.5M |
| `b-20261115-03` | imboard-ai/imboard-monorepo | sched | #5002 | shipped | 2 | 1 | 1 | 1 | #5017 | 13 min | `claude-opus-5-5` 734.0M, `claude-haiku-5-5` 401k | 4.2M |
| `b-20261117-01` | imboard-ai/imboard-monorepo | sched | #5042 | shipped | 2 | 1 | 1 | 1 | #5046 | 11 min | `claude-opus-5-5` 503.5M, `claude-haiku-5-5` 476k | 4.3M |
| `b-20261118-01` | imboard-ai/imboard-monorepo | sched | #5063 | shipped | 7 | 7 | 0 | 2 | #5090 | 296 min | N/A (not on this host) | N/A |
| `b-20261118-02` | imboard-ai/imboard-monorepo | sched | #5078 | shipped | 3 | 3 | 0 | 1 | #5124 | 31 min | N/A (not on this host) | N/A |
| `b-20261118-03` | imboard-ai/imboard-monorepo | sched | #5113 | shipped | 3 | 3 | 0 | 1 | #5121 | 83 min | N/A (not on this host) | N/A |
| `b-20261118-04` | imboard-ai/imboard-monorepo | sched | #5119 | shipped | 3 | 3 | 0 | 1 | #5129 | 16 min | `claude-opus-5-5` 40.9M, `claude-haiku-5-5,claude-opus-5-5` 11.8M, `claude-haiku-5-5` 1.6M | 3.9M |
| `b-5102-review2-r1` | imboard-ai/imboard-monorepo | sched | #5224 | open | 7 | 0 | 0 | 0 | #5227 | N/A | N/A (not on this host) | N/A |
| `b-5102-review2-r2` | imboard-ai/imboard-monorepo | sched | #5228 | open | 5 | 0 | 0 | 0 | #5231 | N/A | N/A (not on this host) | N/A |
| `polar-blockers` | imboard-ai/imboard-monorepo | sched | #5200 | open | 3 | 0 | 0 | 0 | #5202 | N/A | N/A (not on this host) | N/A |
| `polar-high` | imboard-ai/imboard-monorepo | sched | #5208 | open | 7 | 0 | 0 | 0 | #5209 | N/A | N/A (not on this host) | N/A |

- **Tokens per shipped issue EXCLUDES prep; prep is disclosed in its own column** (#796).
  `batch-issues-preparation` (the classifier agents that pick members) runs in the operator
  session, not a scheduler dispatch. `sched enqueue` records the calling session id
  (`CLAUDE_CODE_SESSION_ID`) per batch in `<sched-dir>/batch-prep.jsonl`, and the usage ledger
  attributes that session's tokens (subagents included) from the previous enqueue of the same
  session (max 6h back) to this one. It is an upper bound: unrelated operator work in that
  window counts too. `N/A` = no prep session recorded on this host (batches formed before
  #796 cannot be backfilled; a batch prepared on another host reads N/A).
- **A dissolved batch counts every requeued member as evicted** — the dissolve requeues
  all unshipped members as full-cycle runs, so none of them shipped with the batch.
- **A hand-recovered batch PR records no `ci_fix_attempts`** and counts as one gate run.
- **`Wall-clock/shipped issue` is amortized throughput for batches, latency for full-cycle.**
  A batch row is Σ batch wall-clock ÷ Σ shipped issues (a 300-min 3-member batch reads 100
  min); the full-cycle row is the mean per-issue span. Batch token/cost figures include
  evicted members' dispatch spend, while full-cycle averages delivered issues only.
- **Tokens by model are per-host.** They come from `~/.dossier/sched/<slug>/runs/`
  (`ai-dossier sched stats --batch <id>` reads the same logs); a batch run elsewhere
  reads `N/A (not on this host)`, and a subscription-plan model is tokens without cost.
- **Full-cycle `Wall-clock/shipped issue` is the milestone span; batch is batch-setup →
  PR merge.** Gate wall-clock is PR open → merge, which includes CI and review waits.

## Wall-clock per phase (all models)

Median seconds between a phase's milestone and the previous one, from the trails' own
`at=` stamps. Wall-clock is the only per-phase measure available: cost AND API-minutes
both come from one agent session that usually spans several phases, so neither can be
attributed to a phase (see Limitations).

| Phase | n | Median |
|---|---|---|
| gate | 12 | 206.7m |
| batch-validate | 9 | 121.2m |
| batch-review | 12 | 120.4m |
| ship | 73 | 48.6m |
| implement | 73 | 42.8m |
| batch-report | 11 | 37.1m |
| merge-wait | 67 | 27.4m |
| batch-merge-wait | 10 | 12.7m |
| review | 96 | 12.0m |
| plan | 73 | 3.8m |
| batch-ship | 11 | 2.9m |
| setup | 74 | 1.6m |
| report | 65 | 17s |

## Reconciliation

This is a regenerated snapshot, not the first one — see git history for
`docs/reports/model-scorecard.md` for prior windows. The first-snapshot
reconciliation against `batch-pilot-2-execution.md` §13.3 and
`model-agnostic-fleet.md` ran once, at #566.

## Limitations

- **A moving version tag folds onto its pin only where someone declared the mapping.**
  `glm-latest → glm-5.3` is declared (`MODEL_ALIASES` in `cli/src/runstate-stats.ts`,
  the mapping #566 states) and folds, along with every routed spelling of it. Which
  pin a `-latest` tag points at is a fact about the provider's state, not about the
  string, so it cannot be derived here and it goes stale the moment the provider ships
  a new version under the same tag — when that happens, update the value in
  `MODEL_ALIASES` rather than reading the row as one version. Undeclared tags
  (`kimi-latest`, which has both `kimi-k3` and `kimi-k3-fast` as plausible pins) keep
  their own row and are named in Data warnings — a guessed alias misattributes cost
  and quality silently, a missing one only splits a row.
- **A context-window variant keeps its own row.** `claude-opus-5[1m]` does not fold
  into `claude-opus-5`: the milestone protocol says the suffix should never have been
  written (`gate` records the bare model id), but 1M-context is billed differently, so
  folding it would blend two cost profiles to fix a formatting slip. Read the two rows
  together when judging quality, separately when judging cost.
- **Cost comes from two sources, and the column says which.** `~/.dossier/runs.jsonl`
  is authoritative; where a dispatch predates the telemetry fix (#564) and left it null,
  the figure is recovered from that dispatch's own agent log under
  `~/.dossier/sched/<slug>/runs/`. Both are on-host only — a dispatch run from another
  machine has neither, and its row reads `N/A` because the data is elsewhere, not
  because it was free.
- **`Δ vs prev` is snapshot-over-snapshot, not a strict 7-day delta.** It compares this
  run against whatever sidecar is on the base branch — two overlapping 30-day windows
  when the weekly cron produced both, and a longer gap whenever a weekly PR went
  unmerged. A baseline older than the window raises its own data warning naming the age,
  so the column is never silently stale; read it as "since the last published snapshot".
- **The window selects ISSUES by last update, not runs by date.** The trail read is
  `gh issue list --search "updated:>=<start>"`, and a matched issue contributes its
  whole dispatch history — so an old run on an issue merely touched inside the window
  counts in full. Read the window as "every run on an issue active in the last N days",
  not "every run started in the last N days".
- **A `<unknown>` tier is usually an artifact of that mismatch, not an untiered
  dispatch.** Tier and agent CLI come from `events.jsonl` events *inside* the window,
  while the trail data behind the same row is not time-filtered — so a run whose
  dispatch event predates the window keeps its outcome columns and loses its tier. The
  per-model totals fold tiers away and are unaffected; only the per-tier rows split.
- **Cost and API-minutes per phase are not separable.** A dispatch is usually one
  continuous agent session covering several phases, so both are recorded per issue, not
  per phase — the per-phase section above reports wall-clock only, which the milestone
  `at=` stamps do carry. For a per-phase breakdown of a single run rather than a median
  across many, run `ai-dossier runstate stats` directly.
- **Stall/escalation/unverified-exit counts are a per-host gap.** They come from
  `~/.dossier/sched/<project>/events.jsonl`, which only exists on the machine that
  ran the dispatch. A run dispatched from another host reports 0 for these columns
  here even if it really stalled — `fleet-cli-audit.sh` documents which hosts exist;
  this script does not collect across them.
- **`Cost/delivered` averages only delivered issues.** Work that was dispatched and
  then blocked, evicted, or abandoned is not in the denominator or the numerator —
  see the `n` vs `Delivered` columns for how much of a bucket that excludes.

## Data warnings

- imboard-ai/imboard-monorepo: 48 run(s) recorded no model= — their row is bucketed as <unknown>, and its outcome columns are not attributable to any model
- imboard-ai/imboard-monorepo: 45 of 171 run(s) are classifier dispatches (classify milestones only) — excluded from the by-model and by-class tables, since they record no model= and never ship
- imboard-ai/imboard-monorepo: 82 of 126 run(s) (65%) carry no classifier risk= verdict — they are bucketed as <unclassified>, so the class rows describe only the classified remainder
- week-over-week baseline is the 2026-10-05 snapshot (49 days old, window is 30) — the previous scorecard PR may not have merged; read the Δ column and the drop line accordingly.
