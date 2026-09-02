# Model Scorecard

Generated: 2026-09-02T12:09:54.409Z | Window: 2026-08-25 → 2026-09-02

Cost, quality, and speed per LLM, joined from runstate trails (GitHub), `runs.jsonl`
(token/cost telemetry), and `events.jsonl` (dispatch tier, stall/escalation counts).
Regenerate with `npm run scorecard -- --since 2026-08-25`. See #566.

**`n` is a confidence column, not a metric** — a row with `n=1` is one data point, not
a trend. Read `cost/delivered` and `delivery rate` alongside `n`, never alone.

## Per model × repo × tier

| Model | Repo | Tier | Agent CLI | n | Delivered | Delivery rate | AC met | Cost/delivered | Median API-min | Median wall-clock-min | Review fixed/issue | Stalls | Escalations | Unverified exits |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `<unknown>` | imboard-ai/ai-dossier | <unknown> | unknown | 8 | 0 | 0% | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| `<unknown>` | imboard-ai/imboard-monorepo | <unknown> | unknown | 13 | 1 | 8% | 100% (n=1) | N/A | N/A | 118.2 | 1.0 (n=1) | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/ai-dossier | <unknown> | unknown | 1 | 1 | 100% | 100% (n=1) | N/A | N/A | 48.6 | 27.0 (n=1) | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/ai-dossier | strong | claude | 1 | 1 | 100% | 100% (n=1) | $58.724 (n=1) | 69.8 | 68.6 | 31.0 (n=1) | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/imboard-monorepo | <unknown> | unknown | 25 | 25 | 100% | 100% (n=17) | N/A | N/A | 128.2 | 17.1 (n=25) | 0 | 0 | 0 |
| `claude-opus-5[1m]` | imboard-ai/imboard-monorepo | <unknown> | unknown | 1 | 1 | 100% | N/A | N/A | N/A | 106.3 | 22.0 (n=1) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | <unknown> | unknown | 1 | 1 | 100% | N/A | N/A | N/A | 29.1 | 8.0 (n=1) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | mechanical | claude | 1 | 1 | 100% | 100% (n=1) | $4.793 (n=1) | 20.0 | 19.7 | 2.0 (n=1) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | mid | claude | 30 | 28 | 93% | 97% (n=29) | $17.703 (n=13) | 30.0 | 48.9 | 13.0 (n=30) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | strong | claude | 7 | 6 | 86% | 62% (n=5) | $21.383 (n=6) | 55.9 | 65.9 | 20.5 (n=6) | 0 | 7 (1.00/issue) | 4 (0.57/issue) |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | <unknown> | unknown | 22 | 20 | 91% | 98% (n=21) | N/A | N/A | 188.9 | 9.2 (n=22) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | mechanical | claude,opencode | 9 | 8 | 89% | 94% (n=9) | $17.567 (n=8) | 42.1 | 283.9 | 13.4 (n=9) | 0 | 9 (1.00/issue) | 0 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | mid | claude | 1 | 0 | 0% | 100% (n=1) | N/A | N/A | N/A | 3.0 (n=1) | 0 | 1 (1.00/issue) | 0 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | strong | claude | 2 | 0 | 0% | 100% (n=1) | N/A | N/A | N/A | 12.0 (n=2) | 0 | 2 (1.00/issue) | 1 (0.50/issue) |
| `glm-5.3` | imboard-ai/ai-dossier | <unknown> | unknown | 16 | 14 | 88% | 100% (n=15) | N/A | N/A | 67.1 | 15.7 (n=16) | 0 | 0 | 0 |
| `glm-5.3` | imboard-ai/imboard-monorepo | <unknown> | unknown | 26 | 23 | 88% | 98% (n=22) | N/A | N/A | 152.8 | 8.9 (n=24) | 0 | 0 | 0 |
| `glm-5.3` | imboard-ai/imboard-monorepo | mechanical | opencode | 2 | 2 | 100% | 100% (n=2) | N/A | N/A | 337.0 | 9.5 (n=2) | 1 (0.50/issue) | 4 (2.00/issue) | 0 |
| `glm-5.3` | imboard-ai/imboard-monorepo | strong | opencode | 1 | 0 | 0% | N/A | N/A | N/A | N/A | N/A | 0 | 2 (2.00/issue) | 0 |
| `gpt-5.6-luna` | imboard-ai/imboard-monorepo | <unknown> | unknown | 5 | 4 | 80% | 100% (n=3) | N/A | N/A | 255.3 | 1.5 (n=4) | 0 | 0 | 0 |
| `gpt-5.6-terra` | imboard-ai/imboard-monorepo | <unknown> | unknown | 4 | 2 | 50% | N/A | N/A | N/A | 119.3 | 0.5 (n=2) | 0 | 0 | 0 |
| `kimi-k3` | imboard-ai/imboard-monorepo | <unknown> | unknown | 1 | 0 | 0% | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| `kimi-k3-fast` | imboard-ai/imboard-monorepo | <unknown> | unknown | 9 | 8 | 89% | 97% (n=9) | N/A | N/A | 353.7 | 4.8 (n=9) | 0 | 0 | 0 |
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
| `<unknown>` | direct | unknown | 21 | 1 | 5% | — | 100% (n=1) | N/A | N/A | N/A | 118.2 | 1.0 (n=1) | 0 | 0 | 0 |
| `claude-opus-5` | direct | claude | 27 | 27 | 100% | — | 100% (n=19) | $58.724 (n=1) | 66,579,732 (n=1) | 69.8 | 123.5 | 18.0 (n=27) | 0 | 0 | 0 |
| `claude-opus-5[1m]` | direct | unknown | 1 | 1 | 100% | — | N/A | N/A | N/A | N/A | 106.3 | 22.0 (n=1) | 0 | 0 | 0 |
| `claude-sonnet-5` | direct | claude,opencode | 73 | 64 | 88% | — | 94% (n=67) | $17.992 (n=28) | 32,207,257 (n=28) | 41.8 | 72.6 | 12.1 (n=72) | 0 | 19 (0.26/issue) | 5 (0.07/issue) |
| `glm-5.3` | 4 providers ↓ | opencode | 45 | 39 | 87% | — | 99% (n=39) | N/A | N/A | N/A | 139.3 | 11.5 (n=42) | 1 (0.02/issue) | 6 (0.13/issue) | 0 |
| ↳ | direct | unknown | 33 | 29 | 88% | — | 99% (n=30) | N/A | N/A | N/A | 139.3 | 11.8 (n=31) | 0 | 0 | 0 |
| ↳ | llmgateway | unknown | 8 | 7 | 88% | — | 100% (n=7) | N/A | N/A | N/A | 103.4 | 12.1 (n=8) | 0 | 0 | 0 |
| ↳ | z-ai | opencode | 3 | 2 | 67% | — | 100% (n=2) | N/A | N/A | N/A | 337.0 | 9.5 (n=2) | 1 (0.33/issue) | 6 (2.00/issue) | 0 |
| ↳ | zai-coding-plan | unknown | 1 | 1 | 100% | — | N/A | N/A | N/A | N/A | 139.3 | 2.0 (n=1) | 0 | 0 | 0 |
| `gpt-5.6-luna` | 2 providers ↓ | unknown | 5 | 4 | 80% | — | 100% (n=3) | N/A | N/A | N/A | 255.3 | 1.5 (n=4) | 0 | 0 | 0 |
| ↳ | direct | unknown | 2 | 2 | 100% | — | 100% (n=2) | N/A | N/A | N/A | 364.6 | 1.0 (n=2) | 0 | 0 | 0 |
| ↳ | openai | unknown | 3 | 2 | 67% | — | 100% (n=1) | N/A | N/A | N/A | 165.0 | 2.0 (n=2) | 0 | 0 | 0 |
| `gpt-5.6-terra` | 2 providers ↓ | unknown | 4 | 2 | 50% | — | N/A | N/A | N/A | N/A | 119.3 | 0.5 (n=2) | 0 | 0 | 0 |
| ↳ | llmgateway | unknown | 3 | 2 | 67% | — | N/A | N/A | N/A | N/A | 119.3 | 0.5 (n=2) | 0 | 0 | 0 |
| ↳ | openai | unknown | 1 | 0 | 0% | — | N/A | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| `kimi-k3` | direct | unknown | 1 | 0 | 0% | — | N/A | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| `kimi-k3-fast` | direct | unknown | 9 | 8 | 89% | — | 97% (n=9) | N/A | N/A | N/A | 353.7 | 4.8 (n=9) | 0 | 0 | 0 |
| `kimi-latest` | openrouter | opencode | 1 | 1 | 100% | — | 100% (n=1) | N/A | N/A | N/A | 527.1 | 15.0 (n=1) | 0 | 0 | 0 |
| **TOTAL** | — | claude,opencode | 187 | 147 | 79% | — | 97% (n=139) | $19.396 (n=29) | 33,392,515 (n=29) | 42.6 | 103.6 | 12.1 (n=159) | 1 (0.01/issue) | 25 (0.13/issue) | 5 (0.03/issue) |

Of the 29 delivered issues with a cost figure, 17 were
recovered from the dispatch's own agent log because `runs.jsonl` recorded none — see
Limitations.

## Wall-clock per phase (all models)

Median seconds between a phase's milestone and the previous one, from the trails' own
`at=` stamps. Wall-clock is the only per-phase measure available: cost AND API-minutes
both come from one agent session that usually spans several phases, so neither can be
attributed to a phase (see Limitations).

| Phase | n | Median |
|---|---|---|
| gate | 54 | 32.5m |
| batch-validate | 3 | 28.0m |
| review | 160 | 24.4m |
| implement | 159 | 20.3m |
| merge-wait | 114 | 13.7m |
| plan | 165 | 5.7m |
| setup | 164 | 2.7m |
| ship | 157 | 2.5m |
| report | 130 | 53s |

## Reconciliation

First snapshot (#566) spot-checked against `docs/reports/batch-pilot-2-execution.md`
§13.3: issue #540 ($4.173) and #542 ($5.937) — both recovered from the same
`~/.dossier/runs.jsonl` this script reads, via the now-fixed `ai-dossier sched stats`
(#564/#573) — matched to the cent, and #540's 13,624,069 input / 48,049 output tokens
matched exactly once cache-creation and cache-read were counted as billable (they are
~99.98% of that input figure). Delivery rates in this window are broadly in line
with `docs/reports/model-agnostic-fleet.md`'s retrospective figures (glm-5.3 and
claude-sonnet-5 both ~86-88%), though the two reports use different windows and are
not expected to match exactly.

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

- imboard-ai/ai-dossier: 23 run(s) recorded no model= — their row is bucketed as <unknown>, and its outcome columns are not attributable to any model
- imboard-ai/imboard-monorepo: 19 run(s) recorded no model= — their row is bucketed as <unknown>, and its outcome columns are not attributable to any model
- imboard-ai/imboard-monorepo: 'kimi-latest' is a moving version tag with no declared pin — its 1 run(s) sit in their own row, apart from whatever pinned version the tag resolves to; add it to MODEL_ALIASES to fold them
