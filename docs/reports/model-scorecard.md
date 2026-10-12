# Model Scorecard

Generated: 2026-10-12T05:01:04.582Z | Window: 2026-09-12 → 2026-10-12

Cost, quality, and speed per LLM, joined from runstate trails (GitHub), `runs.jsonl`
(token/cost telemetry), and `events.jsonl` (dispatch tier, stall/escalation counts).
Regenerate with `npm run scorecard -- --days 30`. See #566.

**`n` is a confidence column, not a metric** — a row with `n=1` is one data point, not
a trend. Read `cost/delivered` and `delivery rate` alongside `n`, never alone.

## Per model × repo × tier

| Model | Repo | Tier | Agent CLI | n | Delivered | Delivery rate | AC met | Cost/delivered | Median API-min | Median wall-clock-min | Review fixed/issue | Stalls | Escalations | Unverified exits |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `<unknown>` | imboard-ai/ai-dossier | <unknown> | unknown | 23 | 8 | 35% | 98% (n=8) | N/A | N/A | 74.0 | 19.9 (n=10) | 0 | 0 | 0 |
| `<unknown>` | imboard-ai/ai-dossier | mid | unknown | 8 | 0 | 0% | N/A | N/A | N/A | N/A | 0.5 (n=8) | 0 | 0 | 0 |
| `<unknown>` | imboard-ai/imboard-monorepo | <unknown> | unknown | 37 | 1 | 3% | 98% (n=9) | N/A | N/A | 6751.5 | 8.7 (n=14) | 0 | 0 | 0 |
| `<unknown>` | imboard-ai/imboard-monorepo | mechanical | opencode | 1 | 0 | 0% | N/A | N/A | N/A | N/A | 0.0 (n=1) | 0 | 0 | 0 |
| `<unknown>` | imboard-ai/imboard-monorepo | mid | claude,opencode | 3 | 0 | 0% | N/A | N/A | N/A | N/A | 0.3 (n=3) | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/ai-dossier | <unknown> | unknown | 5 | 5 | 100% | 100% (n=5) | $58.724 (n=1) | 69.8 | 57.1 | 32.0 (n=5) | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/ai-dossier | strong | unknown | 1 | 1 | 100% | N/A | $45.562 (n=1) | 198.0 | 196.5 | 21.0 (n=1) | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/imboard-monorepo | <unknown> | unknown | 3 | 0 | 0% | N/A | N/A | N/A | N/A | 10.0 (n=1) | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/imboard-monorepo | mechanical | claude | 4 | 4 | 100% | 100% (n=3) | $30.121 (n=4) | 121.7 | 587.3 | 17.8 (n=4) | 0 | 1 (0.25/issue) | 3 (0.75/issue) |
| `claude-opus-5` | imboard-ai/imboard-monorepo | mid,strong | unknown | 1 | 0 | 0% | 75% (n=1) | N/A | N/A | N/A | 35.0 (n=1) | 0 | 0 | 0 |
| `claude-opus-5-5` | imboard-ai/ai-dossier | <unknown> | unknown | 40 | 38 | 95% | 98% (n=20) | N/A | N/A | 44.6 | 20.0 (n=40) | 0 | 0 | 0 |
| `claude-opus-5-5` | imboard-ai/ai-dossier | mid,strong | unknown | 1 | 1 | 100% | 100% (n=1) | $29.941 (n=1) | 98.0 | 89.0 | 4.0 (n=1) | 0 | 0 | 0 |
| `claude-opus-5-5` | imboard-ai/imboard-monorepo | <unknown> | unknown | 79 | 76 | 96% | 91% (n=48) | N/A | N/A | 107.9 | 13.8 (n=78) | 0 | 0 | 0 |
| `claude-opus-5-5` | imboard-ai/imboard-monorepo | mid | claude | 1 | 1 | 100% | 100% (n=1) | $4.933 (n=1) | 38.6 | 68.3 | 14.0 (n=1) | 0 | 0 | 0 |
| `claude-opus-5[1m]` | imboard-ai/ai-dossier | <unknown> | unknown | 1 | 1 | 100% | 100% (n=1) | N/A | N/A | 45.3 | 31.0 (n=1) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | <unknown> | unknown | 55 | 53 | 96% | 98% (n=47) | $17.500 (n=17) | 26.2 | 48.7 | 10.9 (n=55) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | mid | unknown | 7 | 6 | 86% | 92% (n=6) | $26.639 (n=1) | 71.2 | 69.4 | 13.7 (n=7) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | mid,strong | unknown | 4 | 3 | 75% | 100% (n=4) | $32.640 (n=3) | 112.0 | 108.8 | 25.5 (n=4) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | strong | unknown | 2 | 2 | 100% | 0% (n=2) | $18.483 (n=2) | 227.1 | 82.8 | 27.5 (n=2) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | <unknown> | unknown | 23 | 22 | 96% | 99% (n=17) | N/A | N/A | 171.7 | 10.6 (n=22) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | mid | claude | 1 | 0 | 0% | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | strong | claude | 1 | 0 | 0% | N/A | N/A | N/A | N/A | N/A | 0 | 1 (1.00/issue) | 1 (1.00/issue) |
| `claude-sonnet-5-5` | imboard-ai/ai-dossier | <unknown> | unknown | 9 | 7 | 78% | N/A | N/A | N/A | 14.9 | 8.3 (n=3) | 0 | 0 | 0 |
| `claude-sonnet-5-5` | imboard-ai/imboard-monorepo | <unknown> | unknown | 1 | 1 | 100% | N/A | N/A | N/A | 42.3 | 0.0 (n=1) | 0 | 0 | 0 |
| `fable` | imboard-ai/imboard-monorepo | <unknown> | unknown | 1 | 0 | 0% | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| `glm-5.3` | imboard-ai/ai-dossier | <unknown> | unknown | 16 | 14 | 88% | 100% (n=15) | N/A | N/A | 67.1 | 15.7 (n=16) | 0 | 0 | 0 |
| `glm-5.3` | imboard-ai/imboard-monorepo | <unknown> | unknown | 3 | 3 | 100% | 89% (n=3) | N/A | N/A | 233.5 | 10.0 (n=3) | 0 | 0 | 0 |
| `glm-5.3-flash` | imboard-ai/ai-dossier | <unknown> | unknown | 14 | 13 | 93% | 100% (n=9) | N/A | N/A | 57.6 | 5.0 (n=13) | 0 | 0 | 0 |
| `glm-5.3-flash` | imboard-ai/imboard-monorepo | <unknown> | unknown | 3 | 3 | 100% | 100% (n=3) | N/A | N/A | 105.2 | 5.0 (n=3) | 0 | 0 | 0 |
| `gpt-5.6-luna` | imboard-ai/ai-dossier | <unknown> | unknown | 1 | 0 | 0% | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| `gpt-5.6-luna` | imboard-ai/imboard-monorepo | <unknown> | unknown | 5 | 2 | 40% | 100% (n=2) | N/A | N/A | 2416.4 | 29.0 (n=2) | 0 | 0 | 0 |
| `gpt-5.6-terra` | imboard-ai/ai-dossier | <unknown> | unknown | 21 | 16 | 76% | 99% (n=16) | N/A | N/A | 36.2 | 2.4 (n=17) | 0 | 0 | 0 |
| `gpt-5.6-terra` | imboard-ai/imboard-monorepo | <unknown> | unknown | 16 | 9 | 56% | 100% (n=2) | N/A | N/A | 102.1 | 6.0 (n=10) | 0 | 0 | 0 |
| `gpt-5.6-terra` | imboard-ai/imboard-monorepo | mechanical | opencode | 1 | 1 | 100% | 100% (n=1) | N/A | 78.1 | 886.8 | 2.0 (n=1) | 0 | 0 | 0 |
| `gpt-6-astra` | imboard-ai/imboard-monorepo | <unknown> | unknown | 2 | 2 | 100% | 92% (n=2) | N/A | N/A | 384.4 | 10.0 (n=2) | 0 | 0 | 0 |
| `gpt-6-luna` | imboard-ai/ai-dossier | <unknown> | unknown | 3 | 3 | 100% | 93% (n=3) | N/A | N/A | 176.3 | 2.0 (n=3) | 0 | 0 | 0 |
| `gpt-6-luna` | imboard-ai/imboard-monorepo | <unknown> | unknown | 2 | 1 | 50% | 29% (n=2) | N/A | N/A | 842.8 | 1.0 (n=2) | 0 | 0 | 0 |
| `gpt-6.1-sol` | imboard-ai/ai-dossier | <unknown> | unknown | 40 | 36 | 90% | 100% (n=37) | N/A | N/A | 100.4 | 14.2 (n=37) | 0 | 0 | 0 |
| `gpt-6.1-sol` | imboard-ai/imboard-monorepo | <unknown> | unknown | 1 | 1 | 100% | 75% (n=1) | N/A | N/A | 236.7 | 8.0 (n=1) | 0 | 0 | 0 |
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
| `<unknown>` | direct | claude,opencode | 72 | 9 | 13% | -1pt | 98% (n=17) | N/A | N/A | N/A | 89.2 | 9.1 (n=36) | 0 | 0 | 0 |
| `claude-opus-5` | direct | claude | 14 | 10 | 71% | -6pt | 98% (n=9) | $37.462 (n=6) | 45,552,677 (n=6) | 121.7 | 120.2 | 24.8 (n=12) | 0 | 1 (0.07/issue) | 3 (0.21/issue) |
| `claude-opus-5-5` | direct | claude | 121 | 116 | 96% | -0pt | 94% (n=70) | $17.437 (n=2) | 20,329,788 (n=2) | 68.3 | 79.8 | 15.8 (n=120) | 0 | 0 | 0 |
| `claude-opus-5[1m]` | direct | unknown | 1 | 1 | 100% | — | 100% (n=1) | N/A | N/A | N/A | 45.3 | 31.0 (n=1) | 0 | 0 | 0 |
| `claude-sonnet-5` | direct | claude | 93 | 86 | 92% | +3pt | 95% (n=76) | $19.958 (n=23) | 45,215,763 (n=23) | 48.0 | 69.2 | 12.1 (n=90) | 0 | 1 (0.01/issue) | 1 (0.01/issue) |
| `claude-sonnet-5-5` | direct | unknown | 10 | 8 | 80% | +13pt | N/A | N/A | N/A | N/A | 16.8 | 6.3 (n=4) | 0 | 0 | 0 |
| `fable` | direct | unknown | 1 | 0 | 0% | +0pt | N/A | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| `glm-5.3` | 2 providers ↓ | unknown | 19 | 17 | 89% | +14pt | 98% (n=18) | N/A | N/A | N/A | 103.4 | 14.8 (n=19) | 0 | 0 | 0 |
| ↳ | direct | unknown | 12 | 11 | 92% | — | 97% (n=12) | N/A | N/A | N/A | 104.8 | 16.3 (n=12) | 0 | 0 | 0 |
| ↳ | llmgateway | unknown | 7 | 6 | 86% | — | 100% (n=6) | N/A | N/A | N/A | 81.3 | 12.3 (n=7) | 0 | 0 | 0 |
| `glm-5.3-flash` | 2 providers ↓ | unknown | 17 | 16 | 94% | -2pt | 100% (n=12) | N/A | N/A | N/A | 71.1 | 5.0 (n=16) | 0 | 0 | 0 |
| ↳ | direct | unknown | 12 | 12 | 100% | — | 100% (n=11) | N/A | N/A | N/A | 71.1 | 2.4 (n=12) | 0 | 0 | 0 |
| ↳ | zai-coding-plan | unknown | 5 | 4 | 80% | — | 100% (n=1) | N/A | N/A | N/A | 78.5 | 12.8 (n=4) | 0 | 0 | 0 |
| `gpt-5.6-luna` | 2 providers ↓ | unknown | 6 | 2 | 33% | +0pt | 100% (n=2) | N/A | N/A | N/A | 2416.4 | 29.0 (n=2) | 0 | 0 | 0 |
| ↳ | direct | unknown | 1 | 0 | 0% | — | N/A | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| ↳ | openai | unknown | 5 | 2 | 40% | — | 100% (n=2) | N/A | N/A | N/A | 2416.4 | 29.0 (n=2) | 0 | 0 | 0 |
| `gpt-5.6-terra` | 2 providers ↓ | opencode | 38 | 26 | 68% | +0pt | 99% (n=19) | N/A | 23,354,866 (n=1) | 78.1 | 78.0 | 3.7 (n=28) | 0 | 0 | 0 |
| ↳ | llmgateway | unknown | 1 | 0 | 0% | — | N/A | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| ↳ | openai | opencode | 37 | 26 | 70% | — | 99% (n=19) | N/A | 23,354,866 (n=1) | 78.1 | 78.0 | 3.7 (n=28) | 0 | 0 | 0 |
| `gpt-6-astra` | openai | unknown | 2 | 2 | 100% | +0pt | 92% (n=2) | N/A | N/A | N/A | 384.4 | 10.0 (n=2) | 0 | 0 | 0 |
| `gpt-6-luna` | 2 providers ↓ | unknown | 5 | 4 | 80% | +0pt | 73% (n=5) | N/A | N/A | N/A | 304.8 | 1.6 (n=5) | 0 | 0 | 0 |
| ↳ | direct | unknown | 1 | 0 | 0% | — | 0% (n=1) | N/A | N/A | N/A | N/A | 2.0 (n=1) | 0 | 0 | 0 |
| ↳ | openai | unknown | 4 | 4 | 100% | — | 89% (n=4) | N/A | N/A | N/A | 304.8 | 1.5 (n=4) | 0 | 0 | 0 |
| `gpt-6.1-sol` | openai | unknown | 41 | 37 | 90% | -10pt | 99% (n=38) | N/A | N/A | N/A | 103.8 | 14.0 (n=38) | 0 | 0 | 0 |
| `kimi-k3` | direct | unknown | 1 | 0 | 0% | +0pt | N/A | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| **TOTAL** | — | claude,opencode | 441 | 334 | 76% | — | 96% (n=269) | $23.183 (n=31) | 43,040,408 (n=32) | 58.0 | 76.5 | 12.7 (n=373) | 0 | 2 (0.00/issue) | 4 (0.01/issue) |

Of the 31 delivered issues with a cost figure, 12 were
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
| imboard-ai/ai-dossier | scheduler batches | 1 | 0 (0%) | 1 / 0 / 0 | 3 | 3 | 0 | 1 | **3.00** | 3 min | 34 min | N/A | N/A | N/A |
| imboard-ai/ai-dossier | full-cycle (1 PR per issue) | — | — | — | 247 | 206 | — | 229 | **0.90** | N/A | 126 min | 46.6M (n=26) | N/A | $22.817 (n=26) |
| imboard-ai/imboard-monorepo | scheduler batches | 11 | 2 (20%) | 8 / 1 / 2 | 24 | 21 | 2 | 8 | **2.63** | 15 min | 197 min | 4.6M (n=2) | N/A | $2.528 (n=1) |
| imboard-ai/imboard-monorepo | manual batch-cycle PRs | 1 | 0 (0%) | 1 / 0 / 0 | 6 | 6 | 0 | 1 | **6.00** | 7 min | 1 min | N/A | N/A | N/A |
| imboard-ai/imboard-monorepo | full-cycle (1 PR per issue) | — | — | — | 154 | 123 | — | 128 | **0.96** | N/A | 228 min | 34.1M (n=4) | N/A | $30.121 (n=4) |

### Per batch

| Batch | Repo | Kind | Anchor | Outcome | Enqueued | Shipped | Evictions | Gate runs | PR | Gate wall-clock | Tokens by model | Prep tokens (separate) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `b-20260929-01` | imboard-ai/ai-dossier | sched | #876 | shipped | 3 | 3 | 0 | 1 | #892 | 3 min | N/A (not on this host) | N/A |
| `b-20260912-01` | imboard-ai/imboard-monorepo | sched | #4221 | shipped | 2 | 2 | 0 | 1 | #4228 | 12 min | `openai/gpt-5.6-luna` 15.4M | N/A |
| `b-20260912-02` | imboard-ai/imboard-monorepo | sched | #4244 | blocked (suite-unreadable) | 2 | 0 | 1 | 0 | — | N/A | `zai-coding-plan/glm-5.3-flash` 23.7M | N/A |
| `b-20260913-01` | imboard-ai/imboard-monorepo | sched | #4253 | shipped | 1 | 1 | 0 | 1 | #4255 | 7 min | N/A (not on this host) | N/A |
| `b-20260915-01` | imboard-ai/imboard-monorepo | sched | #4281 | shipped | 3 | 3 | 0 | 1 | #4321 | 12 min | `claude-haiku-4-5-20251001,claude-opus-5` 7.8M | N/A |
| `b-20260920-01` | imboard-ai/imboard-monorepo | sched | #4362 | shipped | 3 | 3 | 0 | 1 | #4364 | 12 min | N/A (not on this host) | N/A |
| `b-20260924-01` | imboard-ai/imboard-monorepo | sched | #4399 | shipped | 2 | 2 | 0 | 1 | #4406 | 30 min | N/A (not on this host) | N/A |
| `b-20260924-02` | imboard-ai/imboard-monorepo | sched | #4410 | dissolved (eviction-threshold) | 1 | 0 | 1 | 0 | — | N/A | N/A (not on this host) | N/A |
| `b-20260924-03` | imboard-ai/imboard-monorepo | sched | #4411 | shipped | 4 | 4 | 0 | 1 | #4415 | 19 min | N/A (not on this host) | N/A |
| `b-20260924-04` | imboard-ai/imboard-monorepo | sched | #4418 | blocked (members-mismatch) | — | 0 | 0 | 0 | — | N/A | N/A (not on this host) | N/A |
| `b-20260929-01` | imboard-ai/imboard-monorepo | sched | #4494 | shipped | 3 | 3 | 0 | 1 | #4496 | 18 min | N/A (not on this host) | N/A |
| `b-20260929-02` | imboard-ai/imboard-monorepo | sched | #4519 | shipped | 3 | 3 | 0 | 1 | #4537 | 18 min | N/A (not on this host) | N/A |
| `qa-round-10` | imboard-ai/imboard-monorepo | manual | — | shipped | 6 | 6 | 0 | 1 | #4275 | 7 min | N/A (not on this host) | N/A |

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
| batch-validate | 19 | 70.2m |
| batch-review | 6 | 29.8m |
| gate | 42 | 19.0m |
| implement | 359 | 18.0m |
| review | 367 | 17.3m |
| merge-wait | 306 | 11.8m |
| batch-report | 5 | 7.5m |
| plan | 360 | 4.3m |
| batch-ship | 4 | 3.0m |
| ship | 341 | 2.6m |
| setup | 360 | 1.8m |
| report | 299 | 33s |

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

- imboard-ai/ai-dossier: 39 run(s) recorded no model= — their row is bucketed as <unknown>, and its outcome columns are not attributable to any model
- imboard-ai/ai-dossier: 29 of 293 run(s) are classifier dispatches (classify milestones only) — excluded from the by-model and by-class tables, since they record no model= and never ship
- imboard-ai/ai-dossier: 232 of 264 run(s) (88%) carry no classifier risk= verdict — they are bucketed as <unclassified>, so the class rows describe only the classified remainder
- imboard-ai/imboard-monorepo: 38 run(s) recorded no model= — their row is bucketed as <unknown>, and its outcome columns are not attributable to any model
- imboard-ai/imboard-monorepo: 61 of 251 run(s) are classifier dispatches (classify milestones only) — excluded from the by-model and by-class tables, since they record no model= and never ship
- imboard-ai/imboard-monorepo: 147 of 190 run(s) (77%) carry no classifier risk= verdict — they are bucketed as <unclassified>, so the class rows describe only the classified remainder
