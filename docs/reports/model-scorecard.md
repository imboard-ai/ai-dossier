# Model Scorecard

Generated: 2026-09-02T11:05:33.895Z | Window: 2026-08-25 → 2026-09-02

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
| `claude-sonnet-5` | imboard-ai/ai-dossier | mid | claude | 31 | 27 | 87% | $23.298 (n=5) | 48.0 | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | strong | claude | 6 | 6 | 100% | $25.060 (n=3) | 82.0 | 0 | 6 | 3 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | <unknown> | unknown | 22 | 20 | 91% | N/A | N/A | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | mechanical | claude,opencode | 9 | 8 | 89% | $6.745 (n=3) | 41.0 | 0 | 9 | 0 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | mid | claude | 1 | 0 | 0% | N/A | N/A | 0 | 1 | 0 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | strong | claude | 2 | 0 | 0% | N/A | N/A | 0 | 2 | 1 |
| `glm-5.3` | imboard-ai/ai-dossier | <unknown> | unknown | 16 | 14 | 88% | N/A | N/A | 0 | 0 | 0 |
| `glm-5.3` | imboard-ai/imboard-monorepo | <unknown> | unknown | 25 | 22 | 88% | N/A | N/A | 0 | 0 | 0 |
| `glm-latest` | imboard-ai/imboard-monorepo | mechanical | opencode | 2 | 2 | 100% | N/A | N/A | 1 | 4 | 0 |
| `glm-latest` | imboard-ai/imboard-monorepo | strong | opencode | 1 | 0 | 0% | N/A | N/A | 0 | 2 | 0 |
| `gpt-5.6-luna` | imboard-ai/imboard-monorepo | <unknown> | unknown | 5 | 4 | 80% | N/A | N/A | 0 | 0 | 0 |
| `gpt-5.6-terra` | imboard-ai/imboard-monorepo | <unknown> | unknown | 4 | 2 | 50% | N/A | N/A | 0 | 0 | 0 |
| `kimi-k3` | imboard-ai/imboard-monorepo | <unknown> | unknown | 1 | 0 | 0% | N/A | N/A | 0 | 0 | 0 |
| `kimi-k3-fast` | imboard-ai/imboard-monorepo | <unknown> | unknown | 9 | 8 | 89% | N/A | N/A | 0 | 0 | 0 |
| `kimi-latest` | imboard-ai/imboard-monorepo | mechanical | opencode | 1 | 1 | 100% | N/A | N/A | 0 | 0 | 0 |
| `zai-coding-plan/glm-5.3` | imboard-ai/imboard-monorepo | <unknown> | unknown | 1 | 1 | 100% | N/A | N/A | 0 | 0 | 0 |

## Totals per model (all repos/tiers)

| Model | Agent CLI | n | Delivered | Delivery rate | Cost/delivered | Billable tokens/delivered | Median API-min | Stalls | Escalations | Unverified exits |
|---|---|---|---|---|---|---|---|---|---|---|
| `<unknown>` | unknown | 21 | 1 | 5% | N/A | N/A | N/A | 0 | 0 | 0 |
| `claude-opus-5` | claude | 27 | 27 | 100% | N/A | N/A | N/A | 0 | 0 | 0 |
| `claude-opus-5[1m]` | unknown | 1 | 1 | 100% | N/A | N/A | N/A | 0 | 0 | 0 |
| `claude-sonnet-5` | claude,opencode | 73 | 63 | 86% | $18.058 (n=12) | 159,278 | 48.0 | 0 | 18 | 4 |
| `glm-5.3` | unknown | 41 | 36 | 88% | N/A | N/A | N/A | 0 | 0 | 0 |
| `glm-latest` | opencode | 3 | 2 | 67% | N/A | N/A | N/A | 1 | 6 | 0 |
| `gpt-5.6-luna` | unknown | 5 | 4 | 80% | N/A | N/A | N/A | 0 | 0 | 0 |
| `gpt-5.6-terra` | unknown | 4 | 2 | 50% | N/A | N/A | N/A | 0 | 0 | 0 |
| `kimi-k3` | unknown | 1 | 0 | 0% | N/A | N/A | N/A | 0 | 0 | 0 |
| `kimi-k3-fast` | unknown | 9 | 8 | 89% | N/A | N/A | N/A | 0 | 0 | 0 |
| `kimi-latest` | opencode | 1 | 1 | 100% | N/A | N/A | N/A | 0 | 0 | 0 |
| `zai-coding-plan/glm-5.3` | unknown | 1 | 1 | 100% | N/A | N/A | N/A | 0 | 0 | 0 |
| **TOTAL** | claude,opencode | 187 | 146 | 78% | $18.058 (n=12) | 159,278 | 48.0 | 1 | 24 | 4 |

## Reconciliation

First snapshot (#566) spot-checked against `docs/reports/batch-pilot-2-execution.md`
§13.3: issue #540 ($4.173) and #542 ($5.937) — both recovered from the same
`~/.dossier/runs.jsonl` this script reads, via the now-fixed `ai-dossier sched stats`
(#564/#573) — matched to the cent. Delivery rates in this window are broadly in line
with `docs/reports/model-agnostic-fleet.md`'s retrospective figures (glm-5.3 and
claude-sonnet-5 both ~86-88%), though the two reports use different windows and are
not expected to match exactly.

## Limitations

- **A moving version tag (e.g. `glm-latest`) is never folded into a pinned version
  (e.g. `glm-5.3`), even when they are currently the same weights.** Routing-prefix
  and opencode `~`-alias folding both work (see Data warnings below for what *did*
  fold); collapsing a `-latest` tag into a specific pin is a claim about the
  provider's current state that this script has no way to verify and that goes stale
  the moment the provider ships a new version under the same tag — decision-pending,
  see #566.
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
