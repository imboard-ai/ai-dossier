# Model Scorecard

Generated: 2026-09-02T10:10:44.874Z | Window: 2026-08-25 → 2026-09-02

Cost, quality, and speed per LLM, joined from runstate trails (GitHub), `runs.jsonl`
(token/cost telemetry), and `events.jsonl` (dispatch tier, stall/escalation counts).
Regenerate with `npm run scorecard`. See #566.

**`n` is a confidence column, not a metric** — a row with `n=1` is one data point, not
a trend. Read `cost/delivered` and `delivery rate` alongside `n`, never alone.

## Per model × repo × tier

| Model | Repo | Tier | n | Delivered | Delivery rate | Cost/delivered | Median API-min | Stalls | Escalations | Unverified exits |
|---|---|---|---|---|---|---|---|---|---|---|
| `<unknown>` | imboard-ai/ai-dossier | <unknown> | 8 | 0 | 0% | N/A | N/A | 0 | 0 | 0 |
| `<unknown>` | imboard-ai/imboard-monorepo | <unknown> | 13 | 1 | 8% | N/A | N/A | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/ai-dossier | <unknown> | 1 | 1 | 100% | N/A | N/A | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/ai-dossier | strong | 1 | 1 | 100% | N/A | N/A | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/imboard-monorepo | <unknown> | 25 | 25 | 100% | N/A | N/A | 0 | 0 | 0 |
| `claude-opus-5[1m]` | imboard-ai/imboard-monorepo | <unknown> | 1 | 1 | 100% | N/A | N/A | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | <unknown> | 1 | 1 | 100% | N/A | N/A | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | mechanical | 1 | 1 | 100% | $4.793 (n=1) | 20.0 | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | mid | 30 | 26 | 87% | $23.298 (n=5) | 45.3 | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | strong | 6 | 6 | 100% | $25.060 (n=3) | 82.0 | 0 | 6 | 3 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | <unknown> | 22 | 20 | 91% | N/A | N/A | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | mechanical | 9 | 8 | 89% | $6.745 (n=3) | 41.0 | 0 | 9 | 0 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | mid | 1 | 0 | 0% | N/A | N/A | 0 | 1 | 0 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | strong | 2 | 0 | 0% | N/A | N/A | 0 | 2 | 1 |
| `glm-5.3` | imboard-ai/ai-dossier | <unknown> | 16 | 14 | 88% | N/A | N/A | 0 | 0 | 0 |
| `glm-5.3` | imboard-ai/imboard-monorepo | <unknown> | 25 | 22 | 88% | N/A | N/A | 0 | 0 | 0 |
| `glm-latest` | imboard-ai/imboard-monorepo | mechanical | 2 | 2 | 100% | N/A | N/A | 1 | 4 | 0 |
| `glm-latest` | imboard-ai/imboard-monorepo | strong | 1 | 0 | 0% | N/A | N/A | 0 | 2 | 0 |
| `gpt-5.6-luna` | imboard-ai/imboard-monorepo | <unknown> | 5 | 4 | 80% | N/A | N/A | 0 | 0 | 0 |
| `gpt-5.6-terra` | imboard-ai/imboard-monorepo | <unknown> | 3 | 2 | 67% | N/A | N/A | 0 | 0 | 0 |
| `kimi-k3` | imboard-ai/imboard-monorepo | <unknown> | 1 | 0 | 0% | N/A | N/A | 0 | 0 | 0 |
| `kimi-k3-fast` | imboard-ai/imboard-monorepo | <unknown> | 9 | 8 | 89% | N/A | N/A | 0 | 0 | 0 |
| `kimi-latest` | imboard-ai/imboard-monorepo | mechanical | 1 | 1 | 100% | N/A | N/A | 0 | 0 | 0 |
| `zai-coding-plan/glm-5.3` | imboard-ai/imboard-monorepo | <unknown> | 1 | 1 | 100% | N/A | N/A | 0 | 0 | 0 |

## Totals per model (all repos/tiers)

| Model | n | Delivered | Delivery rate | Cost/delivered | Billable tokens/delivered | Median API-min | Stalls | Escalations | Unverified exits |
|---|---|---|---|---|---|---|---|---|---|
| `<unknown>` | 21 | 1 | 5% | N/A | N/A | N/A | 0 | 0 | 0 |
| `claude-opus-5` | 27 | 27 | 100% | N/A | N/A | N/A | 0 | 0 | 0 |
| `claude-opus-5[1m]` | 1 | 1 | 100% | N/A | N/A | N/A | 0 | 0 | 0 |
| `claude-sonnet-5` | 72 | 62 | 86% | $18.058 (n=12) | 159,278 | 47.9 | 0 | 18 | 4 |
| `glm-5.3` | 41 | 36 | 88% | N/A | N/A | N/A | 0 | 0 | 0 |
| `glm-latest` | 3 | 2 | 67% | N/A | N/A | N/A | 1 | 6 | 0 |
| `gpt-5.6-luna` | 5 | 4 | 80% | N/A | N/A | N/A | 0 | 0 | 0 |
| `gpt-5.6-terra` | 3 | 2 | 67% | N/A | N/A | N/A | 0 | 0 | 0 |
| `kimi-k3` | 1 | 0 | 0% | N/A | N/A | N/A | 0 | 0 | 0 |
| `kimi-k3-fast` | 9 | 8 | 89% | N/A | N/A | N/A | 0 | 0 | 0 |
| `kimi-latest` | 1 | 1 | 100% | N/A | N/A | N/A | 0 | 0 | 0 |
| `zai-coding-plan/glm-5.3` | 1 | 1 | 100% | N/A | N/A | N/A | 0 | 0 | 0 |
| **TOTAL** | 185 | 145 | 78% | $18.058 (n=12) | 159,278 | 47.9 | 1 | 24 | 4 |

## Reconciliation

First snapshot (#566) spot-checked against `docs/reports/batch-pilot-2-execution.md`
§13.1: issue #540 ($4.173) and #542 ($5.937) — both recovered from the same
`~/.dossier/runs.jsonl` this script reads, via the now-fixed `ai-dossier sched stats`
(#564/#573) — matched to the cent.

## Limitations

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
- imboard-ai/imboard-monorepo: 'zai-coding-plan/glm-5.3' and 'glm-5.3' may be the same model split across buckets — add its routing prefix to MODEL_ROUTING_PREFIXES to fold them
