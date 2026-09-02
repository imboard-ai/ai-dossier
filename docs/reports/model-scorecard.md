# Model Scorecard

Generated: 2026-09-02T11:19:56.233Z | Window: 2026-08-25 → 2026-09-02

Cost, quality, and speed per LLM, joined from runstate trails (GitHub), `runs.jsonl`
(token/cost telemetry), and `events.jsonl` (dispatch tier, stall/escalation counts).
Regenerate with `npm run scorecard`. See #566.

**`n` is a confidence column, not a metric** — a row with `n=1` is one data point, not
a trend. Read `cost/delivered` and `delivery rate` alongside `n`, never alone.

## Per model × repo × tier

| Model | Repo | Tier | Agent CLI | n | Delivered | Delivery rate | Cost/delivered | Median API-min | Stalls | Escalations | Unverified exits |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `<unknown>` | imboard-ai/ai-dossier | <unknown> | unknown | 8 | 0 | 0% | N/A | N/A | 0 | 0 | 0 |
| `<unknown>` | imboard-ai/imboard-monorepo | <unknown> | unknown | 13 | 1 | 8% | N/A | N/A | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/ai-dossier | <unknown> | unknown | 1 | 1 | 100% | N/A | N/A | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/ai-dossier | strong | claude | 1 | 1 | 100% | N/A | N/A | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/imboard-monorepo | <unknown> | unknown | 25 | 25 | 100% | N/A | N/A | 0 | 0 | 0 |
| `claude-opus-5[1m]` | imboard-ai/imboard-monorepo | <unknown> | unknown | 1 | 1 | 100% | N/A | N/A | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | <unknown> | unknown | 1 | 1 | 100% | N/A | N/A | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | mechanical | claude | 1 | 1 | 100% | $4.793 (n=1) | 20.0 | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | mid | claude | 30 | 27 | 90% | $23.298 (n=5) | 48.0 | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | strong | claude | 7 | 6 | 86% | $25.060 (n=3) | 82.0 | 0 | 7 | 4 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | <unknown> | unknown | 22 | 20 | 91% | N/A | N/A | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | mechanical | claude,opencode | 9 | 8 | 89% | $6.745 (n=3) | 41.0 | 0 | 9 | 0 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | mid | claude | 1 | 0 | 0% | N/A | N/A | 0 | 1 | 0 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | strong | claude | 2 | 0 | 0% | N/A | N/A | 0 | 2 | 1 |
| `glm-5.3` | imboard-ai/ai-dossier | <unknown> | unknown | 16 | 14 | 88% | N/A | N/A | 0 | 0 | 0 |
| `glm-5.3` | imboard-ai/imboard-monorepo | <unknown> | unknown | 26 | 23 | 88% | N/A | N/A | 0 | 0 | 0 |
| `glm-5.3` | imboard-ai/imboard-monorepo | mechanical | opencode | 2 | 2 | 100% | N/A | N/A | 1 | 4 | 0 |
| `glm-5.3` | imboard-ai/imboard-monorepo | strong | opencode | 1 | 0 | 0% | N/A | N/A | 0 | 2 | 0 |
| `gpt-5.6-luna` | imboard-ai/imboard-monorepo | <unknown> | unknown | 5 | 4 | 80% | N/A | N/A | 0 | 0 | 0 |
| `gpt-5.6-terra` | imboard-ai/imboard-monorepo | <unknown> | unknown | 4 | 2 | 50% | N/A | N/A | 0 | 0 | 0 |
| `kimi-k3` | imboard-ai/imboard-monorepo | <unknown> | unknown | 1 | 0 | 0% | N/A | N/A | 0 | 0 | 0 |
| `kimi-k3-fast` | imboard-ai/imboard-monorepo | <unknown> | unknown | 9 | 8 | 89% | N/A | N/A | 0 | 0 | 0 |
| `kimi-latest` | imboard-ai/imboard-monorepo | mechanical | opencode | 1 | 1 | 100% | N/A | N/A | 0 | 0 | 0 |

## Totals per model (all repos/tiers)

One row per model, with the gateways it was served through as `↳` sub-rows whenever
there is more than one — the fold that makes the model row readable would otherwise
hide a gateway costing more or delivering less than the same weights elsewhere.

| Model | Provider | Agent CLI | n | Delivered | Delivery rate | Cost/delivered | Billable tokens/delivered | Median API-min | Stalls | Escalations | Unverified exits |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `<unknown>` | direct | unknown | 21 | 1 | 5% | N/A | N/A | N/A | 0 | 0 | 0 |
| `claude-opus-5` | direct | claude | 27 | 27 | 100% | N/A | N/A | N/A | 0 | 0 | 0 |
| `claude-opus-5[1m]` | direct | unknown | 1 | 1 | 100% | N/A | N/A | N/A | 0 | 0 | 0 |
| `claude-sonnet-5` | direct | claude,opencode | 73 | 63 | 86% | $18.058 (n=12) | 159,278 | 48.0 | 0 | 19 | 5 |
| `glm-5.3` | 4 providers ↓ | opencode | 45 | 39 | 87% | N/A | N/A | N/A | 1 | 6 | 0 |
| ↳ | direct | unknown | 33 | 29 | 88% | N/A | N/A | N/A | 0 | 0 | 0 |
| ↳ | llmgateway | unknown | 8 | 7 | 88% | N/A | N/A | N/A | 0 | 0 | 0 |
| ↳ | z-ai | opencode | 3 | 2 | 67% | N/A | N/A | N/A | 1 | 6 | 0 |
| ↳ | zai-coding-plan | unknown | 1 | 1 | 100% | N/A | N/A | N/A | 0 | 0 | 0 |
| `gpt-5.6-luna` | 2 providers ↓ | unknown | 5 | 4 | 80% | N/A | N/A | N/A | 0 | 0 | 0 |
| ↳ | direct | unknown | 2 | 2 | 100% | N/A | N/A | N/A | 0 | 0 | 0 |
| ↳ | openai | unknown | 3 | 2 | 67% | N/A | N/A | N/A | 0 | 0 | 0 |
| `gpt-5.6-terra` | 2 providers ↓ | unknown | 4 | 2 | 50% | N/A | N/A | N/A | 0 | 0 | 0 |
| ↳ | llmgateway | unknown | 3 | 2 | 67% | N/A | N/A | N/A | 0 | 0 | 0 |
| ↳ | openai | unknown | 1 | 0 | 0% | N/A | N/A | N/A | 0 | 0 | 0 |
| `kimi-k3` | direct | unknown | 1 | 0 | 0% | N/A | N/A | N/A | 0 | 0 | 0 |
| `kimi-k3-fast` | direct | unknown | 9 | 8 | 89% | N/A | N/A | N/A | 0 | 0 | 0 |
| `kimi-latest` | openrouter | opencode | 1 | 1 | 100% | N/A | N/A | N/A | 0 | 0 | 0 |
| **TOTAL** | — | claude,opencode | 187 | 146 | 78% | $18.058 (n=12) | 159,278 | 48.0 | 1 | 25 | 5 |

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
- **Cost per phase is not separable.** A dispatch is usually one continuous agent
  session covering several phases, so `runs.jsonl` records cost per issue, not per
  phase. Wall-clock per phase exists (via `ai-dossier runstate stats`) but is not
  joined here to keep this table to one row per bucket; run that command directly
  for a phase breakdown.
- **Stall/escalation/unverified-exit counts are a per-host gap.** They come from
  `~/.dossier/sched/<project>/events.jsonl`, which only exists on the machine that
  ran the dispatch. A run dispatched from another host reports 0 for these columns
  here even if it really stalled — `fleet-cli-audit.sh` documents which hosts exist;
  this script does not collect across them.
- **`Cost/delivered` averages only delivered issues.** Work that was dispatched and
  then blocked, evicted, or abandoned is not in the denominator or the numerator —
  see the `n` vs `Delivered` columns for how much of a bucket that excludes.

## Data warnings

- imboard-ai/ai-dossier: 23 run(s) recorded no model= — their row is bucketed as <unknown>, and its outcome columns are not attributable to any model
- imboard-ai/imboard-monorepo: 19 run(s) recorded no model= — their row is bucketed as <unknown>, and its outcome columns are not attributable to any model
- imboard-ai/imboard-monorepo: 'kimi-latest' is a moving version tag with no declared pin — its 1 run(s) sit in their own row, apart from whatever pinned version the tag resolves to; add it to MODEL_ALIASES to fold them
