# Model Scorecard

Generated: 2026-09-28T05:00:44.132Z | Window: 2026-08-29 → 2026-09-28

Cost, quality, and speed per LLM, joined from runstate trails (GitHub), `runs.jsonl`
(token/cost telemetry), and `events.jsonl` (dispatch tier, stall/escalation counts).
Regenerate with `npm run scorecard -- --days 30`. See #566.

**`n` is a confidence column, not a metric** — a row with `n=1` is one data point, not
a trend. Read `cost/delivered` and `delivery rate` alongside `n`, never alone.

## Per model × repo × tier

| Model | Repo | Tier | Agent CLI | n | Delivered | Delivery rate | AC met | Cost/delivered | Median API-min | Median wall-clock-min | Review fixed/issue | Stalls | Escalations | Unverified exits |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `<unknown>` | imboard-ai/ai-dossier | <unknown> | unknown | 16 | 4 | 25% | 98% (n=4) | N/A | N/A | 106.6 | 25.5 (n=4) | 0 | 0 | 0 |
| `<unknown>` | imboard-ai/ai-dossier | mid | claude | 9 | 0 | 0% | N/A | N/A | N/A | N/A | 0.5 (n=8) | 0 | 0 | 0 |
| `<unknown>` | imboard-ai/imboard-monorepo | <unknown> | unknown | 74 | 6 | 8% | 100% (n=6) | N/A | N/A | 176.5 | 5.0 (n=14) | 0 | 0 | 0 |
| `<unknown>` | imboard-ai/imboard-monorepo | mechanical | opencode | 1 | 0 | 0% | N/A | N/A | N/A | N/A | 0.0 (n=1) | 0 | 0 | 0 |
| `<unknown>` | imboard-ai/imboard-monorepo | mid | claude,opencode | 6 | 0 | 0% | N/A | N/A | N/A | N/A | 1.0 (n=6) | 0 | 0 | 0 |
| `claude-fable-5-1` | imboard-ai/imboard-monorepo | <unknown> | unknown | 7 | 7 | 100% | 100% (n=4) | N/A | N/A | 182.1 | 16.2 (n=6) | 0 | 0 | 0 |
| `claude-haiku-4-5-20251001` | imboard-ai/imboard-monorepo | mechanical | claude | 1 | 1 | 100% | N/A | $1.564 (n=1) | 86.1 | 1075.6 | 1.0 (n=1) | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/ai-dossier | <unknown> | unknown | 4 | 3 | 75% | 100% (n=3) | N/A | N/A | 57.1 | 34.0 (n=3) | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/ai-dossier | strong | claude | 2 | 2 | 100% | 100% (n=1) | $52.143 (n=2) | 133.9 | 132.6 | 26.0 (n=2) | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/imboard-monorepo | <unknown> | unknown | 16 | 12 | 75% | 99% (n=7) | N/A | N/A | 210.4 | 22.2 (n=13) | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/imboard-monorepo | mechanical | claude | 5 | 5 | 100% | 100% (n=4) | $29.145 (n=5) | 154.8 | 646.5 | 18.8 (n=5) | 0 | 2 (0.40/issue) | 4 (0.80/issue) |
| `claude-opus-5` | imboard-ai/imboard-monorepo | strong | claude | 1 | 0 | 0% | 75% (n=1) | N/A | N/A | N/A | 35.0 (n=1) | 0 | 1 (1.00/issue) | 1 (1.00/issue) |
| `claude-opus-5-5` | imboard-ai/ai-dossier | <unknown> | unknown | 21 | 20 | 95% | 97% (n=9) | N/A | N/A | 39.4 | 14.8 (n=21) | 0 | 0 | 0 |
| `claude-opus-5-5` | imboard-ai/ai-dossier | mid,strong | unknown | 1 | 1 | 100% | 100% (n=1) | $29.941 (n=1) | 98.0 | 89.0 | 4.0 (n=1) | 0 | 0 | 0 |
| `claude-opus-5-5` | imboard-ai/imboard-monorepo | <unknown> | unknown | 33 | 33 | 100% | 87% (n=20) | N/A | N/A | 89.8 | 12.6 (n=33) | 0 | 0 | 0 |
| `claude-opus-5-5` | imboard-ai/imboard-monorepo | mid | claude | 1 | 1 | 100% | 100% (n=1) | $4.933 (n=1) | 38.6 | 68.3 | 14.0 (n=1) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | <unknown> | unknown | 23 | 23 | 100% | 97% (n=18) | N/A | N/A | 54.3 | 8.1 (n=23) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | mechanical | claude | 1 | 1 | 100% | 100% (n=1) | $4.793 (n=1) | 20.0 | 19.7 | 2.0 (n=1) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | mid | claude | 34 | 31 | 91% | 97% (n=32) | $18.341 (n=14) | 45.3 | 49.7 | 12.8 (n=34) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | strong | claude | 9 | 8 | 89% | 76% (n=8) | $24.682 (n=8) | 88.0 | 82.8 | 24.7 (n=9) | 0 | 9 (1.00/issue) | 6 (0.67/issue) |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | <unknown> | unknown | 35 | 34 | 97% | 98% (n=26) | N/A | N/A | 171.7 | 8.7 (n=33) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | mechanical | claude,opencode | 20 | 19 | 95% | 97% (n=19) | $30.576 (n=19) | 91.0 | 305.8 | 14.4 (n=20) | 0 | 22 (1.10/issue) | 13 (0.65/issue) |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | mid | claude | 3 | 0 | 0% | 100% (n=1) | N/A | N/A | N/A | 3.0 (n=1) | 0 | 1 (0.33/issue) | 0 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | strong | claude | 5 | 0 | 0% | 100% (n=2) | N/A | N/A | N/A | 9.7 (n=3) | 0 | 5 (1.00/issue) | 4 (0.80/issue) |
| `fable` | imboard-ai/imboard-monorepo | <unknown> | unknown | 1 | 0 | 0% | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| `glm-5.3` | imboard-ai/ai-dossier | <unknown> | unknown | 16 | 14 | 88% | 100% (n=15) | N/A | N/A | 67.1 | 15.7 (n=16) | 0 | 0 | 0 |
| `glm-5.3` | imboard-ai/imboard-monorepo | <unknown> | unknown | 18 | 17 | 94% | 96% (n=17) | N/A | N/A | 233.5 | 10.9 (n=17) | 0 | 0 | 0 |
| `glm-5.3` | imboard-ai/imboard-monorepo | mechanical | opencode | 2 | 2 | 100% | 100% (n=2) | N/A | N/A | 337.0 | 9.5 (n=2) | 1 (0.50/issue) | 4 (2.00/issue) | 0 |
| `glm-5.3` | imboard-ai/imboard-monorepo | strong | opencode | 1 | 0 | 0% | N/A | N/A | N/A | N/A | N/A | 0 | 2 (2.00/issue) | 0 |
| `glm-5.3-flash` | imboard-ai/ai-dossier | <unknown> | unknown | 14 | 13 | 93% | 100% (n=9) | N/A | N/A | 57.6 | 5.0 (n=13) | 0 | 0 | 0 |
| `glm-5.3-flash` | imboard-ai/imboard-monorepo | <unknown> | unknown | 19 | 19 | 100% | 96% (n=18) | N/A | N/A | 208.7 | 9.2 (n=19) | 0 | 0 | 0 |
| `gpt-5.6-luna` | imboard-ai/ai-dossier | <unknown> | unknown | 1 | 0 | 0% | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| `gpt-5.6-luna` | imboard-ai/imboard-monorepo | <unknown> | unknown | 5 | 2 | 40% | 100% (n=2) | N/A | N/A | 2416.4 | 29.0 (n=2) | 0 | 0 | 0 |
| `gpt-5.6-terra` | imboard-ai/ai-dossier | <unknown> | unknown | 12 | 7 | 58% | 98% (n=8) | N/A | N/A | 32.8 | 3.9 (n=8) | 0 | 0 | 0 |
| `gpt-5.6-terra` | imboard-ai/imboard-monorepo | <unknown> | unknown | 18 | 12 | 67% | 100% (n=2) | N/A | N/A | 106.3 | 4.1 (n=12) | 0 | 0 | 0 |
| `gpt-5.6-terra` | imboard-ai/imboard-monorepo | mechanical | opencode | 1 | 1 | 100% | 100% (n=1) | N/A | 78.1 | 886.8 | 2.0 (n=1) | 0 | 0 | 0 |
| `gpt-6-astra` | imboard-ai/imboard-monorepo | <unknown> | unknown | 2 | 2 | 100% | 92% (n=2) | N/A | N/A | 384.4 | 10.0 (n=2) | 0 | 0 | 0 |
| `kimi-k3` | imboard-ai/imboard-monorepo | <unknown> | unknown | 1 | 0 | 0% | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| `kimi-k3-fast` | imboard-ai/imboard-monorepo | <unknown> | unknown | 5 | 5 | 100% | 100% (n=5) | N/A | N/A | 1385.6 | 5.8 (n=5) | 0 | 0 | 0 |
| `kimi-latest` | imboard-ai/imboard-monorepo | mechanical | opencode | 1 | 1 | 100% | 100% (n=1) | N/A | N/A | 527.1 | 15.0 (n=1) | 0 | 0 | 0 |

## Totals per model (all repos/tiers)

One row per model, with the gateways it was served through as `↳` sub-rows whenever
there is more than one — the fold that makes the model row readable would otherwise
hide a gateway costing more or delivering less than the same weights elsewhere.

Billable tokens count **uncached input + cache-creation + cache-read + output** — cache
reads are billed and, on this fleet, are the dominant term (issue #540: 262 uncached vs
13.4M cache-read). That is the same total `batch-pilot-2-execution.md` §13 publishes.

| Model | Provider | Agent CLI | n | Delivered | Delivery rate | Δ vs prev | AC met | Cost/delivered | Billable tokens/delivered | Median API-min | Median wall-clock-min | Review fixed/issue | Stalls | Escalations | Unverified exits |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `<unknown>` | direct | claude,opencode | 106 | 10 | 9% | -14pt | 99% (n=10) | N/A | N/A | N/A | 152.2 | 5.5 (n=33) | 0 | 0 | 0 |
| `claude-fable-5-1` | direct | unknown | 7 | 7 | 100% | +0pt | 100% (n=4) | N/A | N/A | N/A | 182.1 | 16.2 (n=6) | 0 | 0 | 0 |
| `claude-haiku-4-5-20251001` | direct | claude | 1 | 1 | 100% | +0pt | N/A | $1.564 (n=1) | 7,602,537 (n=1) | 86.1 | 1075.6 | 1.0 (n=1) | 0 | 0 | 0 |
| `claude-opus-5` | direct | claude | 28 | 22 | 79% | -15pt | 98% (n=16) | $35.716 (n=7) | 45,595,505 (n=7) | 154.8 | 176.5 | 23.8 (n=24) | 0 | 3 (0.11/issue) | 5 (0.18/issue) |
| `claude-opus-5-5` | direct | claude | 56 | 55 | 98% | — | 91% (n=31) | $17.437 (n=2) | 20,329,788 (n=2) | 68.3 | 69.5 | 13.3 (n=56) | 0 | 0 | 0 |
| `claude-sonnet-5` | direct | claude,opencode | 130 | 116 | 89% | +3pt | 96% (n=107) | $24.761 (n=42) | 51,348,820 (n=42) | 56.9 | 84.2 | 11.7 (n=124) | 0 | 37 (0.28/issue) | 23 (0.18/issue) |
| `fable` | direct | unknown | 1 | 0 | 0% | — | N/A | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| `glm-5.3` | 3 providers ↓ | opencode | 37 | 33 | 89% | -0pt | 98% (n=34) | N/A | N/A | N/A | 140.0 | 13.0 (n=35) | 1 (0.03/issue) | 6 (0.16/issue) | 0 |
| ↳ | direct | unknown | 26 | 24 | 92% | — | 97% (n=25) | N/A | N/A | N/A | 166.9 | 13.6 (n=25) | 0 | 0 | 0 |
| ↳ | llmgateway | unknown | 8 | 7 | 88% | — | 100% (n=7) | N/A | N/A | N/A | 103.4 | 12.1 (n=8) | 0 | 0 | 0 |
| ↳ | z-ai | opencode | 3 | 2 | 67% | — | 100% (n=2) | N/A | N/A | N/A | 337.0 | 9.5 (n=2) | 1 (0.33/issue) | 6 (2.00/issue) | 0 |
| `glm-5.3-flash` | 2 providers ↓ | unknown | 33 | 32 | 97% | +0pt | 97% (n=27) | N/A | N/A | N/A | 156.3 | 7.5 (n=32) | 0 | 0 | 0 |
| ↳ | direct | unknown | 23 | 23 | 100% | — | 96% (n=22) | N/A | N/A | N/A | 154.3 | 6.4 (n=23) | 0 | 0 | 0 |
| ↳ | zai-coding-plan | unknown | 10 | 9 | 90% | — | 100% (n=5) | N/A | N/A | N/A | 173.7 | 10.2 (n=9) | 0 | 0 | 0 |
| `gpt-5.6-luna` | 2 providers ↓ | unknown | 6 | 2 | 33% | -33pt | 100% (n=2) | N/A | N/A | N/A | 2416.4 | 29.0 (n=2) | 0 | 0 | 0 |
| ↳ | direct | unknown | 1 | 0 | 0% | — | N/A | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| ↳ | openai | unknown | 5 | 2 | 40% | — | 100% (n=2) | N/A | N/A | N/A | 2416.4 | 29.0 (n=2) | 0 | 0 | 0 |
| `gpt-5.6-terra` | 2 providers ↓ | opencode | 31 | 20 | 65% | +2pt | 98% (n=11) | N/A | 23,354,866 (n=1) | 78.1 | 95.1 | 3.9 (n=21) | 0 | 0 | 0 |
| ↳ | llmgateway | unknown | 3 | 2 | 67% | — | N/A | N/A | N/A | N/A | 119.3 | 0.5 (n=2) | 0 | 0 | 0 |
| ↳ | openai | opencode | 28 | 18 | 64% | — | 98% (n=11) | N/A | 23,354,866 (n=1) | 78.1 | 95.1 | 4.3 (n=19) | 0 | 0 | 0 |
| `gpt-6-astra` | openai | unknown | 2 | 2 | 100% | +50pt | 92% (n=2) | N/A | N/A | N/A | 384.4 | 10.0 (n=2) | 0 | 0 | 0 |
| `kimi-k3` | direct | unknown | 1 | 0 | 0% | +0pt | N/A | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| `kimi-k3-fast` | direct | unknown | 5 | 5 | 100% | +11pt | 100% (n=5) | N/A | N/A | N/A | 1385.6 | 5.8 (n=5) | 0 | 0 | 0 |
| `kimi-latest` | openrouter | opencode | 1 | 1 | 100% | +0pt | 100% (n=1) | N/A | N/A | N/A | 527.1 | 15.0 (n=1) | 0 | 0 | 0 |
| **TOTAL** | — | claude,opencode | 445 | 306 | 69% | — | 97% (n=250) | $25.508 (n=52) | 48,064,830 (n=53) | 67.8 | 100.8 | 11.5 (n=342) | 1 (0.00/issue) | 46 (0.10/issue) | 28 (0.06/issue) |

Of the 52 delivered issues with a cost figure, 17 were
recovered from the dispatch's own agent log because `runs.jsonl` recorded none — see
Limitations.

## Batch amortization

Batching exists to pay the CI gate **once for N issues** (#770), so the headline is
**issues shipped per gate run**. A gate run is one CI gate on one PR: `1 + ci_fix_attempts`
for a merged PR (batch or full-cycle alike), 0 for a batch that never merged. Shipped
members are the merged batch PR's closing references — a batch blocked at `batch-validate`
and recovered by hand never posts `batch-ship`, so its trail alone reads it as unshipped.

| Repo | Kind | Batches | Single-member | Shipped / dissolved / blocked | Enqueued | Shipped issues | Evictions | Gate runs | **Issues/gate run** | Median gate wall-clock | Wall-clock/shipped issue | Billable tokens/shipped issue | Cost/shipped issue |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| imboard-ai/ai-dossier | scheduler batches | 9 | 0 (0%) | 4 / 4 / 0 | 23 | 9 | 14 | 4 | **2.25** | 4 min | 70 min | 31.4M (n=4) | $17.415 (n=4) |
| imboard-ai/ai-dossier | full-cycle (1 PR per issue) | — | — | — | 137 | 117 | — | 129 | **0.91** | N/A | 80 min | 57.8M (n=20) | $28.622 (n=20) |
| imboard-ai/imboard-monorepo | scheduler batches | 16 | 3 (20%) | 8 / 6 / 2 | 34 | 18 | 15 | 8 | **2.25** | 12 min | 220 min | 19.8M (n=4) | $11.352 (n=3) |
| imboard-ai/imboard-monorepo | manual batch-cycle PRs | 4 | 0 (0%) | 4 / 0 / 0 | 20 | 20 | 0 | 4 | **5.00** | 33 min | 35 min | N/A | N/A |
| imboard-ai/imboard-monorepo | full-cycle (1 PR per issue) | — | — | — | 224 | 166 | — | 190 | **0.87** | N/A | 336 min | 47.9M (n=17) | $26.290 (n=17) |

### Per batch

| Batch | Repo | Kind | Anchor | Outcome | Enqueued | Shipped | Evictions | Gate runs | PR | Gate wall-clock | Tokens by model |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `b-20260829-01` | imboard-ai/ai-dossier | sched | #490 | dissolved (eviction-threshold) | 3 | 0 | 3 | 0 | — | N/A | `claude-sonnet-5` 859k |
| `b-20260901-02` | imboard-ai/ai-dossier | sched | #549 | dissolved (unattributable-suite-failure) | 3 | 0 | 3 | 0 | — | N/A | `claude-sonnet-5,claude-opus-5[1m]` 12.9M, `claude-sonnet-5` 6.1M |
| `b-20260906-01` | imboard-ai/ai-dossier | sched | #600 | dissolved (eviction-threshold) | 2 | 0 | 2 | 0 | — | N/A | `claude-sonnet-5` 967k |
| `b-20260906-02` | imboard-ai/ai-dossier | sched | #604 | open | 2 | 0 | 1 | 0 | — | N/A | `claude-sonnet-5,claude-opus-5[1m]` 10.5M, `claude-sonnet-5` 5.1M |
| `b-20260906-03` | imboard-ai/ai-dossier | sched | #608 | shipped | 2 | 2 | 0 | 1 | #612 | 4 min | `claude-sonnet-5,claude-opus-5[1m]` 28.2M, `claude-opus-5` 26.5M, `claude-haiku-4-5-20251001` 520k |
| `b-20260906-04` | imboard-ai/ai-dossier | sched | #614 | shipped | 4 | 2 | 2 | 1 | #619 | 3 min | `claude-sonnet-5,claude-opus-5[1m]` 39.6M, `claude-opus-5` 30.1M, `claude-sonnet-5` 1.2M, `claude-haiku-4-5-20251001` 558k |
| `b-20260906-05` | imboard-ai/ai-dossier | sched | #621 | shipped | 3 | 3 | 1 | 1 | #624 | 5 min | `claude-sonnet-5,claude-opus-5[1m]` 52.0M, `claude-opus-5` 37.5M, `claude-haiku-4-5-20251001` 784k |
| `b-20260906-07` | imboard-ai/ai-dossier | sched | #631 | dissolved (eviction-threshold) | 2 | 0 | 2 | 0 | — | N/A | `claude-sonnet-5,claude-opus-5[1m]` 17.1M, `claude-sonnet-5` 7.2M |
| `b-20260906-08` | imboard-ai/ai-dossier | sched | #633 | shipped | 2 | 2 | 0 | 1 | #639 | 129 min | `claude-sonnet-5,claude-opus-5[1m]` 40.5M, `claude-opus-5` 24.9M, `claude-haiku-4-5-20251001` 318k |
| `b-20260901-01` | imboard-ai/imboard-monorepo | sched | #3963 | dissolved (eviction-threshold) | 3 | 0 | 3 | 0 | — | N/A | `claude-sonnet-5,claude-opus-5[1m]` 7.8M, `claude-sonnet-5` 5.2M |
| `b-20260902-01` | imboard-ai/imboard-monorepo | sched | #3976 | dissolved (eviction-threshold) | 2 | 0 | 2 | 0 | — | N/A | `claude-sonnet-5,claude-opus-5[1m]` 10.8M, `claude-sonnet-5` 826k |
| `b-20260903-01` | imboard-ai/imboard-monorepo | sched | #3993 | dissolved (eviction-threshold) | 4 | 0 | 4 | 0 | — | N/A | `claude-sonnet-5,claude-opus-5[1m]` 10.6M, `claude-sonnet-5` 7.9M |
| `b-20260903-02` | imboard-ai/imboard-monorepo | sched | #3994 | dissolved (eviction-threshold) | 2 | 0 | 2 | 0 | — | N/A | `claude-sonnet-5,claude-opus-5[1m]` 26.8M |
| `b-20260903-03` | imboard-ai/imboard-monorepo | sched | #3995 | dissolved (eviction-threshold) | 1 | 0 | 1 | 0 | — | N/A | `claude-sonnet-5,claude-opus-5[1m]` 18.1M |
| `b-20260906-06` | imboard-ai/imboard-monorepo | sched | #4063 | shipped | 2 | 2 | 0 | 1 | #4069 | 9 min | `claude-opus-5` 34.9M, `claude-sonnet-5,claude-opus-5[1m]` 26.2M, `claude-sonnet-5,claude-haiku-4-5-20251001,claude-opus-5[1m]` 25.5M, `claude-haiku-4-5-20251001` 590k |
| `b-20260909-01` | imboard-ai/imboard-monorepo | sched | #4170 | shipped | 2 | 1 | 1 | 1 | #4173 | 15 min | `claude-sonnet-5,claude-opus-5[1m]` 48.0M, `claude-haiku-4-5-20251001` 220k |
| `b-20260912-01` | imboard-ai/imboard-monorepo | sched | #4221 | shipped | 2 | 2 | 0 | 1 | #4228 | 12 min | `openai/gpt-5.6-luna` 15.4M |
| `b-20260912-02` | imboard-ai/imboard-monorepo | sched | #4244 | blocked (suite-unreadable) | 2 | 0 | 1 | 0 | — | N/A | `zai-coding-plan/glm-5.3-flash` 23.7M |
| `b-20260913-01` | imboard-ai/imboard-monorepo | sched | #4253 | shipped | 1 | 1 | 0 | 1 | #4255 | 7 min | N/A (not on this host) |
| `b-20260915-01` | imboard-ai/imboard-monorepo | sched | #4281 | shipped | 3 | 3 | 0 | 1 | #4321 | 12 min | `claude-haiku-4-5-20251001,claude-opus-5` 7.8M |
| `b-20260920-01` | imboard-ai/imboard-monorepo | sched | #4362 | shipped | 3 | 3 | 0 | 1 | #4364 | 12 min | N/A (not on this host) |
| `b-20260924-01` | imboard-ai/imboard-monorepo | sched | #4399 | shipped | 2 | 2 | 0 | 1 | #4406 | 30 min | N/A (not on this host) |
| `b-20260924-02` | imboard-ai/imboard-monorepo | sched | #4410 | dissolved (eviction-threshold) | 1 | 0 | 1 | 0 | — | N/A | N/A (not on this host) |
| `b-20260924-03` | imboard-ai/imboard-monorepo | sched | #4411 | shipped | 4 | 4 | 0 | 1 | #4415 | 19 min | N/A (not on this host) |
| `b-20260924-04` | imboard-ai/imboard-monorepo | sched | #4418 | blocked (members-mismatch) | — | 0 | 0 | 0 | — | N/A | N/A (not on this host) |
| `m2` | imboard-ai/imboard-monorepo | manual | — | shipped | 5 | 5 | 0 | 1 | #4125 | 13 min | N/A (not on this host) |
| `m3` | imboard-ai/imboard-monorepo | manual | — | shipped | 6 | 6 | 0 | 1 | #4140 | 622 min | N/A (not on this host) |
| `proof` | imboard-ai/imboard-monorepo | manual | — | shipped | 3 | 3 | 0 | 1 | #4113 | 53 min | N/A (not on this host) |
| `qa-round-10` | imboard-ai/imboard-monorepo | manual | — | shipped | 6 | 6 | 0 | 1 | #4275 | 7 min | N/A (not on this host) |

- **Prep tokens are not in these figures.** `batch-issues-preparation` (the classifier
  agents that pick members) runs in the operator session, not a scheduler dispatch, and
  nothing ties its tokens to a batch id yet — so cost/tokens per shipped issue here is
  member + tail/report dispatches only and understates a batch by its prep spend (#796).
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
| batch-validate | 23 | 64.2m |
| batch-review | 8 | 50.2m |
| implement | 335 | 21.1m |
| gate | 60 | 20.9m |
| review | 337 | 18.9m |
| merge-wait | 249 | 12.7m |
| batch-report | 6 | 10.1m |
| plan | 336 | 5.9m |
| batch-ship | 5 | 3.0m |
| ship | 312 | 2.9m |
| setup | 334 | 1.9m |
| report | 275 | 53s |
| classify | 1 | 11s |

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

- imboard-ai/ai-dossier: 32 run(s) recorded no model= — their row is bucketed as <unknown>, and its outcome columns are not attributable to any model
- imboard-ai/ai-dossier: 26 of 201 run(s) are classifier dispatches (classify milestones only) — excluded from the by-model and by-class tables, since they record no model= and never ship
- imboard-ai/ai-dossier: 146 of 175 run(s) (83%) carry no classifier risk= verdict — they are bucketed as <unclassified>, so the class rows describe only the classified remainder
- imboard-ai/imboard-monorepo: 55 run(s) recorded no model= — their row is bucketed as <unknown>, and its outcome columns are not attributable to any model
- imboard-ai/imboard-monorepo: 'kimi-latest' is a moving version tag with no declared pin — its 1 run(s) sit in their own row, apart from whatever pinned version the tag resolves to; add it to MODEL_ALIASES to fold them
- imboard-ai/imboard-monorepo: 105 of 363 run(s) are classifier dispatches (classify milestones only) — excluded from the by-model and by-class tables, since they record no model= and never ship
- imboard-ai/imboard-monorepo: 188 of 258 run(s) (73%) carry no classifier risk= verdict — they are bucketed as <unclassified>, so the class rows describe only the classified remainder
