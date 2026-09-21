# Model Scorecard

Generated: 2026-09-21T05:00:37.670Z | Window: 2026-08-22 → 2026-09-21

Cost, quality, and speed per LLM, joined from runstate trails (GitHub), `runs.jsonl`
(token/cost telemetry), and `events.jsonl` (dispatch tier, stall/escalation counts).
Regenerate with `npm run scorecard -- --days 30`. See #566.

**`n` is a confidence column, not a metric** — a row with `n=1` is one data point, not
a trend. Read `cost/delivered` and `delivery rate` alongside `n`, never alone.

## Per model × repo × tier

| Model | Repo | Tier | Agent CLI | n | Delivered | Delivery rate | AC met | Cost/delivered | Median API-min | Median wall-clock-min | Review fixed/issue | Stalls | Escalations | Unverified exits |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `<unknown>` | imboard-ai/ai-dossier | <unknown> | unknown | 17 | 6 | 35% | 98% (n=6) | N/A | N/A | 89.2 | 27.0 (n=6) | 0 | 0 | 0 |
| `<unknown>` | imboard-ai/ai-dossier | mid | claude | 9 | 0 | 0% | N/A | N/A | N/A | N/A | 0.5 (n=8) | 0 | 0 | 0 |
| `<unknown>` | imboard-ai/imboard-monorepo | <unknown> | unknown | 75 | 18 | 24% | 99% (n=13) | N/A | N/A | 124.3 | 6.9 (n=22) | 0 | 0 | 0 |
| `<unknown>` | imboard-ai/imboard-monorepo | mechanical | opencode | 1 | 0 | 0% | N/A | N/A | N/A | N/A | 0.0 (n=1) | 0 | 0 | 0 |
| `<unknown>` | imboard-ai/imboard-monorepo | mid | claude,opencode | 7 | 0 | 0% | N/A | N/A | N/A | N/A | 1.0 (n=7) | 0 | 0 | 0 |
| `claude-fable-5` | imboard-ai/imboard-monorepo | <unknown> | unknown | 2 | 2 | 100% | 100% (n=2) | N/A | N/A | 130.7 | 16.5 (n=2) | 0 | 0 | 0 |
| `claude-fable-5-1` | imboard-ai/imboard-monorepo | <unknown> | unknown | 7 | 7 | 100% | 100% (n=4) | N/A | N/A | 182.1 | 16.2 (n=6) | 0 | 0 | 0 |
| `claude-haiku-4-5-20251001` | imboard-ai/imboard-monorepo | mechanical | claude | 1 | 1 | 100% | N/A | $1.564 (n=1) | 86.1 | 1075.6 | 1.0 (n=1) | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/ai-dossier | <unknown> | unknown | 5 | 4 | 80% | 100% (n=4) | N/A | N/A | 52.8 | 32.3 (n=4) | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/ai-dossier | strong | claude | 2 | 2 | 100% | 100% (n=1) | $52.143 (n=2) | 133.9 | 132.6 | 26.0 (n=2) | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/imboard-monorepo | <unknown> | unknown | 40 | 37 | 93% | 99% (n=24) | N/A | N/A | 131.8 | 19.1 (n=37) | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/imboard-monorepo | mechanical | claude | 5 | 5 | 100% | 100% (n=4) | $29.145 (n=5) | 154.8 | 646.5 | 18.8 (n=5) | 0 | 2 (0.40/issue) | 4 (0.80/issue) |
| `claude-opus-5` | imboard-ai/imboard-monorepo | strong | claude | 1 | 0 | 0% | 75% (n=1) | N/A | N/A | N/A | 35.0 (n=1) | 0 | 1 (1.00/issue) | 1 (1.00/issue) |
| `claude-opus-5[1m]` | imboard-ai/ai-dossier | <unknown> | unknown | 1 | 1 | 100% | 100% (n=1) | N/A | N/A | 45.3 | 31.0 (n=1) | 0 | 0 | 0 |
| `claude-opus-5[1m]` | imboard-ai/imboard-monorepo | <unknown> | unknown | 1 | 1 | 100% | N/A | N/A | N/A | 106.3 | 22.0 (n=1) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | <unknown> | unknown | 17 | 17 | 100% | 95% (n=14) | N/A | N/A | 40.0 | 7.4 (n=17) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | mechanical | claude | 1 | 1 | 100% | 100% (n=1) | $4.793 (n=1) | 20.0 | 19.7 | 2.0 (n=1) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | mid | claude | 34 | 31 | 91% | 97% (n=32) | $18.341 (n=14) | 45.3 | 49.7 | 12.8 (n=34) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | strong | claude | 9 | 8 | 89% | 76% (n=8) | $24.682 (n=8) | 88.0 | 82.8 | 24.7 (n=9) | 0 | 9 (1.00/issue) | 6 (0.67/issue) |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | <unknown> | unknown | 54 | 52 | 96% | 98% (n=44) | N/A | N/A | 171.7 | 9.2 (n=52) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | mechanical | claude,opencode | 20 | 19 | 95% | 97% (n=19) | $30.576 (n=19) | 91.0 | 305.8 | 14.4 (n=20) | 0 | 22 (1.10/issue) | 13 (0.65/issue) |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | mid | claude | 3 | 0 | 0% | 100% (n=1) | N/A | N/A | N/A | 3.0 (n=1) | 0 | 1 (0.33/issue) | 0 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | strong | claude | 5 | 0 | 0% | 100% (n=2) | N/A | N/A | N/A | 9.7 (n=3) | 0 | 5 (1.00/issue) | 4 (0.80/issue) |
| `deepseek-v4-pro-0813` | imboard-ai/imboard-monorepo | <unknown> | unknown | 3 | 3 | 100% | 86% (n=2) | N/A | N/A | 139.9 | 0.5 (n=2) | 0 | 0 | 0 |
| `fable` | imboard-ai/imboard-monorepo | <unknown> | unknown | 1 | 0 | 0% | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| `glm-5.3` | imboard-ai/ai-dossier | <unknown> | unknown | 16 | 14 | 88% | 100% (n=15) | N/A | N/A | 67.1 | 15.7 (n=16) | 0 | 0 | 0 |
| `glm-5.3` | imboard-ai/imboard-monorepo | <unknown> | unknown | 28 | 26 | 93% | 97% (n=24) | N/A | N/A | 173.3 | 8.7 (n=26) | 0 | 0 | 0 |
| `glm-5.3` | imboard-ai/imboard-monorepo | mechanical | opencode | 2 | 2 | 100% | 100% (n=2) | N/A | N/A | 337.0 | 9.5 (n=2) | 1 (0.50/issue) | 4 (2.00/issue) | 0 |
| `glm-5.3` | imboard-ai/imboard-monorepo | strong | opencode | 1 | 0 | 0% | N/A | N/A | N/A | N/A | N/A | 0 | 2 (2.00/issue) | 0 |
| `glm-5.3-flash` | imboard-ai/ai-dossier | <unknown> | unknown | 14 | 13 | 93% | 100% (n=9) | N/A | N/A | 57.6 | 5.0 (n=13) | 0 | 0 | 0 |
| `glm-5.3-flash` | imboard-ai/imboard-monorepo | <unknown> | unknown | 19 | 19 | 100% | 96% (n=18) | N/A | N/A | 208.7 | 9.2 (n=19) | 0 | 0 | 0 |
| `gpt-5.6-luna` | imboard-ai/ai-dossier | <unknown> | unknown | 1 | 0 | 0% | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| `gpt-5.6-luna` | imboard-ai/imboard-monorepo | <unknown> | unknown | 6 | 4 | 67% | 100% (n=3) | N/A | N/A | 255.3 | 1.5 (n=4) | 0 | 0 | 0 |
| `gpt-5.6-terra` | imboard-ai/ai-dossier | <unknown> | unknown | 12 | 7 | 58% | 98% (n=8) | N/A | N/A | 32.8 | 3.9 (n=8) | 0 | 0 | 0 |
| `gpt-5.6-terra` | imboard-ai/imboard-monorepo | <unknown> | unknown | 14 | 9 | 64% | 100% (n=2) | N/A | N/A | 102.1 | 1.7 (n=9) | 0 | 0 | 0 |
| `gpt-5.6-terra` | imboard-ai/imboard-monorepo | mechanical | opencode | 1 | 1 | 100% | 100% (n=1) | N/A | 78.1 | 886.8 | 2.0 (n=1) | 0 | 0 | 0 |
| `gpt-6-astra` | imboard-ai/imboard-monorepo | <unknown> | unknown | 2 | 2 | 100% | 92% (n=2) | N/A | N/A | 384.4 | 10.0 (n=2) | 0 | 0 | 0 |
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
| `<unknown>` | direct | claude,opencode | 109 | 24 | 22% | -2pt | 98% (n=19) | N/A | N/A | N/A | 114.8 | 7.4 (n=44) | 0 | 0 | 0 |
| `claude-fable-5` | direct | unknown | 2 | 2 | 100% | +0pt | 100% (n=2) | N/A | N/A | N/A | 130.7 | 16.5 (n=2) | 0 | 0 | 0 |
| `claude-fable-5-1` | direct | unknown | 7 | 7 | 100% | +0pt | 100% (n=4) | N/A | N/A | N/A | 182.1 | 16.2 (n=6) | 0 | 0 | 0 |
| `claude-haiku-4-5-20251001` | direct | claude | 1 | 1 | 100% | +0pt | N/A | $1.564 (n=1) | 7,602,537 (n=1) | 86.1 | 1075.6 | 1.0 (n=1) | 0 | 0 | 0 |
| `claude-opus-5` | direct | claude | 53 | 48 | 91% | -3pt | 99% (n=34) | $35.716 (n=7) | 45,595,505 (n=7) | 154.8 | 132.3 | 20.7 (n=49) | 0 | 3 (0.06/issue) | 5 (0.09/issue) |
| `claude-opus-5[1m]` | direct | unknown | 2 | 2 | 100% | +0pt | 100% (n=1) | N/A | N/A | N/A | 75.8 | 26.5 (n=2) | 0 | 0 | 0 |
| `claude-sonnet-5` | direct | claude,opencode | 143 | 128 | 90% | +3pt | 96% (n=121) | $24.761 (n=42) | 51,348,820 (n=42) | 56.9 | 88.9 | 11.5 (n=137) | 0 | 37 (0.26/issue) | 23 (0.16/issue) |
| `deepseek-v4-pro-0813` | direct | unknown | 3 | 3 | 100% | +0pt | 86% (n=2) | N/A | N/A | N/A | 139.9 | 0.5 (n=2) | 0 | 0 | 0 |
| `fable` | direct | unknown | 1 | 0 | 0% | — | N/A | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| `glm-5.3` | 4 providers ↓ | opencode | 47 | 42 | 89% | +0pt | 98% (n=41) | N/A | N/A | N/A | 139.3 | 11.3 (n=44) | 1 (0.02/issue) | 6 (0.13/issue) | 0 |
| ↳ | direct | unknown | 35 | 32 | 91% | — | 98% (n=32) | N/A | N/A | N/A | 139.7 | 11.5 (n=33) | 0 | 0 | 0 |
| ↳ | llmgateway | unknown | 8 | 7 | 88% | — | 100% (n=7) | N/A | N/A | N/A | 103.4 | 12.1 (n=8) | 0 | 0 | 0 |
| ↳ | z-ai | opencode | 3 | 2 | 67% | — | 100% (n=2) | N/A | N/A | N/A | 337.0 | 9.5 (n=2) | 1 (0.33/issue) | 6 (2.00/issue) | 0 |
| ↳ | zai-coding-plan | unknown | 1 | 1 | 100% | — | N/A | N/A | N/A | N/A | 139.3 | 2.0 (n=1) | 0 | 0 | 0 |
| `glm-5.3-flash` | 2 providers ↓ | unknown | 33 | 32 | 97% | +0pt | 97% (n=27) | N/A | N/A | N/A | 156.3 | 7.5 (n=32) | 0 | 0 | 0 |
| ↳ | direct | unknown | 23 | 23 | 100% | — | 96% (n=22) | N/A | N/A | N/A | 154.3 | 6.4 (n=23) | 0 | 0 | 0 |
| ↳ | zai-coding-plan | unknown | 10 | 9 | 90% | — | 100% (n=5) | N/A | N/A | N/A | 173.7 | 10.2 (n=9) | 0 | 0 | 0 |
| `gpt-5.6-luna` | 2 providers ↓ | unknown | 7 | 4 | 57% | -10pt | 100% (n=3) | N/A | N/A | N/A | 255.3 | 1.5 (n=4) | 0 | 0 | 0 |
| ↳ | direct | unknown | 3 | 2 | 67% | — | 100% (n=2) | N/A | N/A | N/A | 364.6 | 1.0 (n=2) | 0 | 0 | 0 |
| ↳ | openai | unknown | 4 | 2 | 50% | — | 100% (n=1) | N/A | N/A | N/A | 165.0 | 2.0 (n=2) | 0 | 0 | 0 |
| `gpt-5.6-terra` | 2 providers ↓ | opencode | 27 | 17 | 63% | +0pt | 98% (n=11) | N/A | 23,354,866 (n=1) | 78.1 | 69.0 | 2.7 (n=18) | 0 | 0 | 0 |
| ↳ | llmgateway | unknown | 3 | 2 | 67% | — | N/A | N/A | N/A | N/A | 119.3 | 0.5 (n=2) | 0 | 0 | 0 |
| ↳ | openai | opencode | 24 | 15 | 63% | — | 98% (n=11) | N/A | 23,354,866 (n=1) | 78.1 | 69.0 | 2.9 (n=16) | 0 | 0 | 0 |
| `gpt-6-astra` | openai | unknown | 2 | 2 | 100% | +50pt | 92% (n=2) | N/A | N/A | N/A | 384.4 | 10.0 (n=2) | 0 | 0 | 0 |
| `kimi-k3` | direct | unknown | 1 | 0 | 0% | +0pt | N/A | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| `kimi-k3-fast` | direct | unknown | 9 | 8 | 89% | +0pt | 97% (n=9) | N/A | N/A | N/A | 353.7 | 4.8 (n=9) | 0 | 0 | 0 |
| `kimi-latest` | openrouter | opencode | 1 | 1 | 100% | +0pt | 100% (n=1) | N/A | N/A | N/A | 527.1 | 15.0 (n=1) | 0 | 0 | 0 |
| **TOTAL** | — | claude,opencode | 448 | 321 | 72% | — | 97% (n=277) | $25.831 (n=50) | 49,152,478 (n=51) | 67.8 | 116.0 | 11.3 (n=353) | 1 (0.00/issue) | 46 (0.10/issue) | 28 (0.06/issue) |

Of the 50 delivered issues with a cost figure, 17 were
recovered from the dispatch's own agent log because `runs.jsonl` recorded none — see
Limitations.

## Wall-clock per phase (all models)

Median seconds between a phase's milestone and the previous one, from the trails' own
`at=` stamps. Wall-clock is the only per-phase measure available: cost AND API-minutes
both come from one agent session that usually spans several phases, so neither can be
attributed to a phase (see Limitations).

| Phase | n | Median |
|---|---|---|
| batch-review | 6 | 50.2m |
| batch-validate | 19 | 39.6m |
| gate | 83 | 24.9m |
| implement | 348 | 23.8m |
| review | 348 | 20.9m |
| merge-wait | 246 | 20.2m |
| batch-report | 5 | 7.5m |
| plan | 352 | 5.7m |
| batch-ship | 5 | 3.0m |
| ship | 329 | 3.0m |
| setup | 349 | 2.1m |
| report | 294 | 1.1m |
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

- imboard-ai/ai-dossier: 33 run(s) recorded no model= — their row is bucketed as <unknown>, and its outcome columns are not attributable to any model
- imboard-ai/ai-dossier: 26 of 176 run(s) are classifier dispatches (classify milestones only) — excluded from the by-model and by-class tables, since they record no model= and never ship
- imboard-ai/ai-dossier: 121 of 150 run(s) (81%) carry no classifier risk= verdict — they are bucketed as <unclassified>, so the class rows describe only the classified remainder
- imboard-ai/imboard-monorepo: issue imboard-ai/imboard-monorepo#3684 run r-3684-a0cf: gate milestone has an unusable at= value ('$(date') — skipped, and the next phase's duration is reported as unknown
- imboard-ai/imboard-monorepo: 59 run(s) recorded no model= — their row is bucketed as <unknown>, and its outcome columns are not attributable to any model
- imboard-ai/imboard-monorepo: 'kimi-latest' is a moving version tag with no declared pin — its 1 run(s) sit in their own row, apart from whatever pinned version the tag resolves to; add it to MODEL_ALIASES to fold them
- imboard-ai/imboard-monorepo: 85 of 373 run(s) are classifier dispatches (classify milestones only) — excluded from the by-model and by-class tables, since they record no model= and never ship
- imboard-ai/imboard-monorepo: 231 of 288 run(s) (80%) carry no classifier risk= verdict — they are bucketed as <unclassified>, so the class rows describe only the classified remainder
