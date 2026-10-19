# Model Scorecard

Generated: 2026-10-19T05:01:07.460Z | Window: 2026-09-19 → 2026-10-19

Cost, quality, and speed per LLM, joined from runstate trails (GitHub), `runs.jsonl`
(token/cost telemetry), and `events.jsonl` (dispatch tier, stall/escalation counts).
Regenerate with `npm run scorecard -- --days 30`. See #566.

**`n` is a confidence column, not a metric** — a row with `n=1` is one data point, not
a trend. Read `cost/delivered` and `delivery rate` alongside `n`, never alone.

## Per model × repo × tier

| Model | Repo | Tier | Agent CLI | n | Delivered | Delivery rate | AC met | Cost/delivered | Median API-min | Median wall-clock-min | Review fixed/issue | Stalls | Escalations | Unverified exits |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `<unknown>` | imboard-ai/ai-dossier | <unknown> | unknown | 29 | 10 | 34% | 99% (n=9) | N/A | N/A | 104.4 | 18.1 (n=11) | 0 | 0 | 0 |
| `<unknown>` | imboard-ai/ai-dossier | mid | claude | 11 | 0 | 0% | N/A | N/A | N/A | N/A | 0.5 (n=11) | 0 | 0 | 0 |
| `<unknown>` | imboard-ai/ai-dossier | strong | claude,opencode | 2 | 0 | 0% | 100% (n=2) | N/A | N/A | N/A | 17.5 (n=2) | 0 | 0 | 0 |
| `<unknown>` | imboard-ai/imboard-monorepo | <unknown> | unknown | 48 | 4 | 8% | 98% (n=17) | N/A | N/A | 3645.0 | 13.0 (n=26) | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/ai-dossier | <unknown> | unknown | 5 | 5 | 100% | 100% (n=5) | $58.724 (n=1) | 69.8 | 57.1 | 32.0 (n=5) | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/ai-dossier | strong | unknown | 1 | 1 | 100% | N/A | $45.562 (n=1) | 198.0 | 196.5 | 21.0 (n=1) | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/imboard-monorepo | <unknown> | unknown | 1 | 0 | 0% | N/A | N/A | N/A | N/A | 10.0 (n=1) | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/imboard-monorepo | mid,strong | unknown | 1 | 0 | 0% | 75% (n=1) | N/A | N/A | N/A | 35.0 (n=1) | 0 | 0 | 0 |
| `claude-opus-5-5` | imboard-ai/ai-dossier | <unknown> | unknown | 45 | 43 | 96% | 98% (n=23) | N/A | N/A | 45.8 | 19.6 (n=45) | 0 | 0 | 0 |
| `claude-opus-5-5` | imboard-ai/ai-dossier | mid,strong | unknown | 1 | 1 | 100% | 100% (n=1) | $29.941 (n=1) | 98.0 | 89.0 | 4.0 (n=1) | 0 | 0 | 0 |
| `claude-opus-5-5` | imboard-ai/imboard-monorepo | <unknown> | unknown | 95 | 90 | 95% | 92% (n=62) | N/A | N/A | 111.6 | 14.5 (n=94) | 0 | 0 | 0 |
| `claude-opus-5-5` | imboard-ai/imboard-monorepo | mid | unknown | 1 | 1 | 100% | 100% (n=1) | $4.933 (n=1) | 38.6 | 68.3 | 14.0 (n=1) | 0 | 0 | 0 |
| `claude-opus-5[1m]` | imboard-ai/ai-dossier | <unknown> | unknown | 1 | 1 | 100% | 100% (n=1) | N/A | N/A | 45.3 | 31.0 (n=1) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | <unknown> | unknown | 55 | 53 | 96% | 98% (n=47) | $17.500 (n=17) | 26.2 | 48.7 | 10.9 (n=55) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | mid | unknown | 7 | 6 | 86% | 92% (n=6) | $26.639 (n=1) | 71.2 | 69.4 | 13.7 (n=7) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | mid,strong | unknown | 4 | 3 | 75% | 100% (n=4) | $32.640 (n=3) | 112.0 | 108.8 | 25.5 (n=4) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | strong | unknown | 2 | 2 | 100% | 0% (n=2) | $18.483 (n=2) | 227.1 | 82.8 | 27.5 (n=2) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | <unknown> | unknown | 3 | 2 | 67% | 100% (n=3) | N/A | N/A | 703.0 | 4.3 (n=3) | 0 | 0 | 0 |
| `claude-sonnet-5-5` | imboard-ai/ai-dossier | <unknown> | unknown | 9 | 7 | 78% | N/A | N/A | N/A | 14.9 | 8.3 (n=3) | 0 | 0 | 0 |
| `claude-sonnet-5-5` | imboard-ai/imboard-monorepo | <unknown> | unknown | 3 | 2 | 67% | N/A | N/A | N/A | 127.0 | 6.0 (n=2) | 0 | 0 | 0 |
| `glm-5.3` | imboard-ai/ai-dossier | <unknown> | unknown | 16 | 14 | 88% | 100% (n=15) | N/A | N/A | 67.1 | 15.7 (n=16) | 0 | 0 | 0 |
| `glm-5.3` | imboard-ai/imboard-monorepo | <unknown> | unknown | 1 | 1 | 100% | 100% (n=1) | N/A | N/A | 407.2 | 16.0 (n=1) | 0 | 0 | 0 |
| `glm-5.3-flash` | imboard-ai/ai-dossier | <unknown> | unknown | 14 | 13 | 93% | 100% (n=9) | N/A | N/A | 57.6 | 5.0 (n=13) | 0 | 0 | 0 |
| `gpt-5.6-luna` | imboard-ai/ai-dossier | <unknown> | unknown | 1 | 0 | 0% | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| `gpt-5.6-luna` | imboard-ai/imboard-monorepo | <unknown> | unknown | 5 | 2 | 40% | 100% (n=2) | N/A | N/A | 2416.4 | 29.0 (n=2) | 0 | 0 | 0 |
| `gpt-5.6-terra` | imboard-ai/ai-dossier | <unknown> | unknown | 21 | 16 | 76% | 99% (n=16) | N/A | N/A | 36.2 | 2.4 (n=17) | 0 | 0 | 0 |
| `gpt-5.6-terra` | imboard-ai/imboard-monorepo | <unknown> | unknown | 6 | 3 | 50% | 100% (n=1) | N/A | N/A | 1372.7 | 11.8 (n=4) | 0 | 0 | 0 |
| `gpt-6-luna` | imboard-ai/ai-dossier | <unknown> | unknown | 3 | 3 | 100% | 93% (n=3) | N/A | N/A | 176.3 | 2.0 (n=3) | 0 | 0 | 0 |
| `gpt-6-luna` | imboard-ai/imboard-monorepo | <unknown> | unknown | 4 | 2 | 50% | 67% (n=3) | N/A | N/A | 661.3 | 5.7 (n=3) | 0 | 0 | 0 |
| `gpt-6.1-sol` | imboard-ai/ai-dossier | <unknown> | unknown | 54 | 50 | 93% | 100% (n=51) | N/A | N/A | 119.2 | 12.2 (n=51) | 0 | 0 | 0 |
| `gpt-6.1-sol` | imboard-ai/ai-dossier | strong | opencode | 1 | 1 | 100% | 100% (n=1) | N/A | 5.8 | 245.4 | 14.0 (n=1) | 0 | 0 | 0 |
| `gpt-6.1-sol` | imboard-ai/imboard-monorepo | <unknown> | unknown | 7 | 4 | 57% | 90% (n=5) | N/A | N/A | 142.0 | 5.0 (n=5) | 0 | 0 | 0 |
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
| `<unknown>` | direct | claude,opencode | 90 | 14 | 16% | +2pt | 98% (n=28) | N/A | N/A | N/A | 129.3 | 11.5 (n=50) | 0 | 0 | 0 |
| `claude-opus-5` | direct | unknown | 8 | 6 | 75% | -3pt | 97% (n=6) | $52.143 (n=2) | 68,552,015 (n=2) | 133.9 | 62.8 | 28.3 (n=8) | 0 | 0 | 0 |
| `claude-opus-5-5` | direct | unknown | 142 | 135 | 95% | -1pt | 94% (n=87) | $17.437 (n=2) | 20,329,788 (n=2) | 68.3 | 88.7 | 16.1 (n=141) | 0 | 0 | 0 |
| `claude-opus-5[1m]` | direct | unknown | 1 | 1 | 100% | — | 100% (n=1) | N/A | N/A | N/A | 45.3 | 31.0 (n=1) | 0 | 0 | 0 |
| `claude-sonnet-5` | direct | unknown | 71 | 66 | 93% | +3pt | 94% (n=62) | $19.958 (n=23) | 45,215,763 (n=23) | 48.0 | 54.5 | 12.2 (n=71) | 0 | 0 | 0 |
| `claude-sonnet-5-5` | direct | unknown | 12 | 9 | 75% | +8pt | N/A | N/A | N/A | N/A | 18.6 | 7.4 (n=5) | 0 | 0 | 0 |
| `glm-5.3` | 2 providers ↓ | unknown | 17 | 15 | 88% | +13pt | 100% (n=16) | N/A | N/A | N/A | 72.8 | 15.7 (n=17) | 0 | 0 | 0 |
| ↳ | direct | unknown | 10 | 9 | 90% | — | 100% (n=10) | N/A | N/A | N/A | 72.8 | 18.1 (n=10) | 0 | 0 | 0 |
| ↳ | llmgateway | unknown | 7 | 6 | 86% | — | 100% (n=6) | N/A | N/A | N/A | 81.3 | 12.3 (n=7) | 0 | 0 | 0 |
| `glm-5.3-flash` | 2 providers ↓ | unknown | 14 | 13 | 93% | -3pt | 100% (n=9) | N/A | N/A | N/A | 57.6 | 5.0 (n=13) | 0 | 0 | 0 |
| ↳ | direct | unknown | 9 | 9 | 100% | — | 100% (n=8) | N/A | N/A | N/A | 57.6 | 1.6 (n=9) | 0 | 0 | 0 |
| ↳ | zai-coding-plan | unknown | 5 | 4 | 80% | — | 100% (n=1) | N/A | N/A | N/A | 78.5 | 12.8 (n=4) | 0 | 0 | 0 |
| `gpt-5.6-luna` | 2 providers ↓ | unknown | 6 | 2 | 33% | +0pt | 100% (n=2) | N/A | N/A | N/A | 2416.4 | 29.0 (n=2) | 0 | 0 | 0 |
| ↳ | direct | unknown | 1 | 0 | 0% | — | N/A | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| ↳ | openai | unknown | 5 | 2 | 40% | — | 100% (n=2) | N/A | N/A | N/A | 2416.4 | 29.0 (n=2) | 0 | 0 | 0 |
| `gpt-5.6-terra` | 2 providers ↓ | unknown | 27 | 19 | 70% | +2pt | 99% (n=17) | N/A | N/A | N/A | 39.8 | 4.2 (n=21) | 0 | 0 | 0 |
| ↳ | llmgateway | unknown | 1 | 0 | 0% | — | N/A | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| ↳ | openai | unknown | 26 | 19 | 73% | — | 99% (n=17) | N/A | N/A | N/A | 39.8 | 4.2 (n=21) | 0 | 0 | 0 |
| `gpt-6-luna` | 2 providers ↓ | unknown | 7 | 5 | 71% | -9pt | 80% (n=6) | N/A | N/A | N/A | 433.3 | 3.8 (n=6) | 0 | 0 | 0 |
| ↳ | direct | unknown | 2 | 1 | 50% | — | 67% (n=2) | N/A | N/A | N/A | 479.8 | 8.5 (n=2) | 0 | 0 | 0 |
| ↳ | openai | unknown | 5 | 4 | 80% | — | 89% (n=4) | N/A | N/A | N/A | 304.8 | 1.5 (n=4) | 0 | 0 | 0 |
| `gpt-6.1-sol` | openai | opencode | 62 | 55 | 89% | -11pt | 99% (n=57) | N/A | 2,937,958 (n=1) | 5.8 | 122.6 | 11.6 (n=57) | 0 | 0 | 0 |
| `kimi-k3` | direct | unknown | 1 | 0 | 0% | +0pt | N/A | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| **TOTAL** | — | claude,opencode | 458 | 340 | 74% | — | 96% (n=291) | $22.155 (n=27) | 43,595,147 (n=28) | 52.0 | 78.4 | 13.2 (n=392) | 0 | 0 | 0 |

Of the 27 delivered issues with a cost figure, 12 were
recovered from the dispatch's own agent log because `runs.jsonl` recorded none — see
Limitations.

## Batch amortization

Batching exists to pay the CI gate **once for N issues** (#770), so the headline is
**issues shipped per gate run**. A gate run is one CI gate on one PR: `1 + ci_fix_attempts`
for a merged PR (batch or full-cycle alike), 0 for a batch that never merged. Shipped
members are the merged batch PR's closing references — a batch blocked at `batch-validate`
and recovered by hand never posts `batch-ship`, so its trail alone reads it as unshipped.

| Repo | Kind | Batches | Single-member | Shipped / dissolved / blocked | Enqueued | Shipped issues | Evictions | Gate runs | **Issues/gate run** | Median gate wall-clock | Wall-clock/shipped issue | Billable tokens/shipped issue (excl. prep) | Prep tokens/shipped issue (separate) | Cost/shipped issue |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| imboard-ai/ai-dossier | scheduler batches | 4 | 0 (0%) | 3 / 0 / 1 | 11 | 8 | 0 | 3 | **2.67** | 42 min | 53 min | 13.7M (n=2) | 3.6M (n=1) | $9.728 (n=1) |
| imboard-ai/ai-dossier | full-cycle (1 PR per issue) | — | — | — | 270 | 225 | — | 249 | **0.90** | N/A | 136 min | 46.6M (n=26) | N/A | $22.817 (n=26) |
| imboard-ai/imboard-monorepo | scheduler batches | 10 | 1 (11%) | 8 / 1 / 1 | 27 | 26 | 1 | 8 | **3.25** | 18 min | 93 min | N/A | N/A | N/A |
| imboard-ai/imboard-monorepo | full-cycle (1 PR per issue) | — | — | — | 141 | 107 | — | 110 | **0.97** | N/A | 239 min | 5.8M (n=1) | N/A | $4.933 (n=1) |

### Per batch

| Batch | Repo | Kind | Anchor | Outcome | Enqueued | Shipped | Evictions | Gate runs | PR | Gate wall-clock | Tokens by model | Prep tokens (separate) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `b-20260929-01` | imboard-ai/ai-dossier | sched | #876 | shipped | 3 | 3 | 0 | 1 | #892 | 3 min | N/A (not on this host) | N/A |
| `b-20261015-01` | imboard-ai/ai-dossier | sched | #1242 | blocked (agent-unkillable) | 2 | 0 | 0 | 0 | — | N/A | `claude-opus-5-5` 1.9M | 10.7M |
| `b-20261015-02` | imboard-ai/ai-dossier | sched | #1242 | shipped | 4 | 4 | 0 | 1 | #1247 | 77 min | `claude-opus-5-5` 60.4M, `claude-haiku-5-5` 910k | 14.6M |
| `b-20261016-01` | imboard-ai/ai-dossier | sched | #1250 | shipped | 2 | 1 | 0 | 1 | #1251 | 42 min | `openai/gpt-6-astra` 6.3M, `openai/gpt-5.6-luna` 855k | N/A |
| `b-20260920-01` | imboard-ai/imboard-monorepo | sched | #4362 | shipped | 3 | 3 | 0 | 1 | #4364 | 12 min | N/A (not on this host) | N/A |
| `b-20260924-01` | imboard-ai/imboard-monorepo | sched | #4399 | shipped | 2 | 2 | 0 | 1 | #4406 | 30 min | N/A (not on this host) | N/A |
| `b-20260924-02` | imboard-ai/imboard-monorepo | sched | #4410 | dissolved (eviction-threshold) | 1 | 0 | 1 | 0 | — | N/A | N/A (not on this host) | N/A |
| `b-20260924-03` | imboard-ai/imboard-monorepo | sched | #4411 | shipped | 4 | 4 | 0 | 1 | #4415 | 19 min | N/A (not on this host) | N/A |
| `b-20260924-04` | imboard-ai/imboard-monorepo | sched | #4418 | blocked (members-mismatch) | — | 0 | 0 | 0 | — | N/A | N/A (not on this host) | N/A |
| `b-20260929-01` | imboard-ai/imboard-monorepo | sched | #4494 | shipped | 3 | 3 | 0 | 1 | #4496 | 18 min | N/A (not on this host) | N/A |
| `b-20260929-02` | imboard-ai/imboard-monorepo | sched | #4519 | shipped | 3 | 3 | 0 | 1 | #4537 | 18 min | N/A (not on this host) | N/A |
| `b-20261015-01` | imboard-ai/imboard-monorepo | sched | #4651 | shipped | 2 | 2 | 0 | 1 | #4664 | 15 min | N/A (not on this host) | N/A |
| `b-20261016-01` | imboard-ai/imboard-monorepo | sched | #4708 | shipped | 5 | 5 | 0 | 1 | #4715 | 20 min | N/A (not on this host) | N/A |
| `b-20261017-01` | imboard-ai/imboard-monorepo | sched | #4717 | shipped | 4 | 4 | 0 | 1 | #4726 | 18 min | N/A (not on this host) | N/A |

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
| batch-validate | 21 | 70.2m |
| batch-report | 10 | 49.1m |
| batch-review | 9 | 31.7m |
| gate | 44 | 26.7m |
| review | 384 | 17.6m |
| implement | 359 | 17.4m |
| merge-wait | 316 | 12.3m |
| plan | 359 | 4.1m |
| batch-ship | 7 | 3.0m |
| ship | 343 | 2.4m |
| setup | 359 | 1.6m |
| report | 302 | 32s |

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

- imboard-ai/ai-dossier: 50 run(s) recorded no model= — their row is bucketed as <unknown>, and its outcome columns are not attributable to any model
- imboard-ai/ai-dossier: 41 of 336 run(s) are classifier dispatches (classify milestones only) — excluded from the by-model and by-class tables, since they record no model= and never ship
- imboard-ai/ai-dossier: 252 of 295 run(s) (85%) carry no classifier risk= verdict — they are bucketed as <unclassified>, so the class rows describe only the classified remainder
- imboard-ai/imboard-monorepo: 43 run(s) recorded no model= — their row is bucketed as <unknown>, and its outcome columns are not attributable to any model
- imboard-ai/imboard-monorepo: 59 of 231 run(s) are classifier dispatches (classify milestones only) — excluded from the by-model and by-class tables, since they record no model= and never ship
- imboard-ai/imboard-monorepo: 129 of 172 run(s) (75%) carry no classifier risk= verdict — they are bucketed as <unclassified>, so the class rows describe only the classified remainder
