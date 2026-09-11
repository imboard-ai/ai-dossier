# Model Scorecard

Generated: 2026-09-07T05:00:37.840Z | Window: 2026-08-08 → 2026-09-07

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
| `<unknown>` | imboard-ai/imboard-monorepo | <unknown> | unknown | 56 | 14 | 25% | 99% (n=13) | N/A | N/A | 117.1 | 8.8 (n=15) | 0 | 0 | 0 |
| `<unknown>` | imboard-ai/imboard-monorepo | mid | claude | 2 | 0 | 0% | N/A | N/A | N/A | N/A | 2.0 (n=2) | 0 | 0 | 0 |
| `claude-fable-5` | imboard-ai/imboard-monorepo | <unknown> | unknown | 2 | 2 | 100% | 100% (n=2) | N/A | N/A | 130.7 | 16.5 (n=2) | 0 | 0 | 0 |
| `claude-fable-5-1` | imboard-ai/imboard-monorepo | <unknown> | unknown | 1 | 0 | 0% | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/ai-dossier | <unknown> | unknown | 3 | 2 | 67% | 100% (n=2) | N/A | N/A | 52.8 | 28.5 (n=2) | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/ai-dossier | strong | claude | 2 | 2 | 100% | 100% (n=1) | $52.143 (n=2) | 133.9 | 132.6 | 26.0 (n=2) | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/imboard-monorepo | <unknown> | unknown | 28 | 28 | 100% | 99% (n=19) | N/A | N/A | 128.2 | 17.5 (n=28) | 0 | 0 | 0 |
| `claude-opus-5` | imboard-ai/imboard-monorepo | strong | claude | 1 | 0 | 0% | 75% (n=1) | N/A | N/A | N/A | 35.0 (n=1) | 0 | 1 (1.00/issue) | 1 (1.00/issue) |
| `claude-opus-5[1m]` | imboard-ai/ai-dossier | <unknown> | unknown | 1 | 1 | 100% | 100% (n=1) | N/A | N/A | 45.3 | 31.0 (n=1) | 0 | 0 | 0 |
| `claude-opus-5[1m]` | imboard-ai/imboard-monorepo | <unknown> | unknown | 1 | 1 | 100% | N/A | N/A | N/A | 106.3 | 22.0 (n=1) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | <unknown> | unknown | 1 | 1 | 100% | N/A | N/A | N/A | 29.1 | 8.0 (n=1) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | mechanical | claude | 1 | 1 | 100% | 100% (n=1) | $4.793 (n=1) | 20.0 | 19.7 | 2.0 (n=1) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | mid | claude | 34 | 31 | 91% | 97% (n=32) | $18.341 (n=14) | 45.3 | 49.7 | 12.8 (n=34) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/ai-dossier | strong | claude | 9 | 8 | 89% | 76% (n=8) | $24.682 (n=8) | 88.0 | 82.8 | 24.7 (n=9) | 0 | 9 (1.00/issue) | 6 (0.67/issue) |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | <unknown> | unknown | 30 | 28 | 93% | 97% (n=28) | N/A | N/A | 198.3 | 8.2 (n=30) | 0 | 0 | 0 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | mechanical | claude,opencode | 17 | 16 | 94% | 97% (n=16) | $28.442 (n=16) | 67.1 | 285.4 | 14.5 (n=17) | 0 | 16 (0.94/issue) | 7 (0.41/issue) |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | mid | claude | 2 | 0 | 0% | 100% (n=1) | N/A | N/A | N/A | 3.0 (n=1) | 0 | 1 (0.50/issue) | 0 |
| `claude-sonnet-5` | imboard-ai/imboard-monorepo | strong | claude | 4 | 0 | 0% | 100% (n=2) | N/A | N/A | N/A | 9.7 (n=3) | 0 | 4 (1.00/issue) | 3 (0.75/issue) |
| `deepseek-v4-pro-0813` | imboard-ai/imboard-monorepo | <unknown> | unknown | 3 | 3 | 100% | 86% (n=2) | N/A | N/A | 139.9 | 0.5 (n=2) | 0 | 0 | 0 |
| `glm-5.3` | imboard-ai/ai-dossier | <unknown> | unknown | 16 | 14 | 88% | 100% (n=15) | N/A | N/A | 67.1 | 15.7 (n=16) | 0 | 0 | 0 |
| `glm-5.3` | imboard-ai/imboard-monorepo | <unknown> | unknown | 26 | 24 | 92% | 98% (n=22) | N/A | N/A | 173.3 | 8.9 (n=24) | 0 | 0 | 0 |
| `glm-5.3` | imboard-ai/imboard-monorepo | mechanical | opencode | 2 | 2 | 100% | 100% (n=2) | N/A | N/A | 337.0 | 9.5 (n=2) | 1 (0.50/issue) | 4 (2.00/issue) | 0 |
| `glm-5.3` | imboard-ai/imboard-monorepo | strong | opencode | 1 | 0 | 0% | N/A | N/A | N/A | N/A | N/A | 0 | 2 (2.00/issue) | 0 |
| `glm-5.3-flash` | imboard-ai/imboard-monorepo | <unknown> | unknown | 13 | 12 | 92% | 98% (n=11) | N/A | N/A | 235.4 | 11.0 (n=12) | 0 | 0 | 0 |
| `gpt-5.6-luna` | imboard-ai/imboard-monorepo | <unknown> | unknown | 5 | 4 | 80% | 100% (n=3) | N/A | N/A | 255.3 | 1.5 (n=4) | 0 | 0 | 0 |
| `gpt-5.6-terra` | imboard-ai/imboard-monorepo | <unknown> | unknown | 4 | 3 | 75% | 100% (n=1) | N/A | N/A | 110.5 | 0.7 (n=3) | 0 | 0 | 0 |
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
| `<unknown>` | direct | claude | 84 | 20 | 24% | +20pt | 98% (n=19) | N/A | N/A | N/A | 112.5 | 9.7 (n=31) | 0 | 0 | 0 |
| `claude-fable-5` | direct | unknown | 2 | 2 | 100% | — | 100% (n=2) | N/A | N/A | N/A | 130.7 | 16.5 (n=2) | 0 | 0 | 0 |
| `claude-fable-5-1` | direct | unknown | 1 | 0 | 0% | — | N/A | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| `claude-opus-5` | direct | claude | 34 | 32 | 94% | -6pt | 98% (n=23) | $52.143 (n=2) | 68,552,015 (n=2) | 133.9 | 125.8 | 19.2 (n=33) | 0 | 1 (0.03/issue) | 1 (0.03/issue) |
| `claude-opus-5[1m]` | direct | unknown | 2 | 2 | 100% | +0pt | 100% (n=1) | N/A | N/A | N/A | 75.8 | 26.5 (n=2) | 0 | 0 | 0 |
| `claude-sonnet-5` | direct | claude,opencode | 98 | 85 | 87% | +0pt | 95% (n=88) | $23.438 (n=39) | 46,567,840 (n=39) | 51.2 | 84.7 | 12.4 (n=96) | 0 | 30 (0.31/issue) | 16 (0.16/issue) |
| `deepseek-v4-pro-0813` | direct | unknown | 3 | 3 | 100% | — | 86% (n=2) | N/A | N/A | N/A | 139.9 | 0.5 (n=2) | 0 | 0 | 0 |
| `glm-5.3` | 4 providers ↓ | opencode | 45 | 40 | 89% | +2pt | 99% (n=39) | N/A | N/A | N/A | 139.3 | 11.5 (n=42) | 1 (0.02/issue) | 6 (0.13/issue) | 0 |
| ↳ | direct | unknown | 33 | 30 | 91% | — | 99% (n=30) | N/A | N/A | N/A | 139.7 | 11.8 (n=31) | 0 | 0 | 0 |
| ↳ | llmgateway | unknown | 8 | 7 | 88% | — | 100% (n=7) | N/A | N/A | N/A | 103.4 | 12.1 (n=8) | 0 | 0 | 0 |
| ↳ | z-ai | opencode | 3 | 2 | 67% | — | 100% (n=2) | N/A | N/A | N/A | 337.0 | 9.5 (n=2) | 1 (0.33/issue) | 6 (2.00/issue) | 0 |
| ↳ | zai-coding-plan | unknown | 1 | 1 | 100% | — | N/A | N/A | N/A | N/A | 139.3 | 2.0 (n=1) | 0 | 0 | 0 |
| `glm-5.3-flash` | 2 providers ↓ | unknown | 13 | 12 | 92% | — | 98% (n=11) | N/A | N/A | N/A | 235.4 | 11.0 (n=12) | 0 | 0 | 0 |
| ↳ | direct | unknown | 9 | 8 | 89% | — | 98% (n=8) | N/A | N/A | N/A | 264.9 | 12.6 (n=8) | 0 | 0 | 0 |
| ↳ | zai-coding-plan | unknown | 4 | 4 | 100% | — | 100% (n=3) | N/A | N/A | N/A | 225.8 | 7.8 (n=4) | 0 | 0 | 0 |
| `gpt-5.6-luna` | 2 providers ↓ | unknown | 5 | 4 | 80% | +0pt | 100% (n=3) | N/A | N/A | N/A | 255.3 | 1.5 (n=4) | 0 | 0 | 0 |
| ↳ | direct | unknown | 2 | 2 | 100% | — | 100% (n=2) | N/A | N/A | N/A | 364.6 | 1.0 (n=2) | 0 | 0 | 0 |
| ↳ | openai | unknown | 3 | 2 | 67% | — | 100% (n=1) | N/A | N/A | N/A | 165.0 | 2.0 (n=2) | 0 | 0 | 0 |
| `gpt-5.6-terra` | 2 providers ↓ | unknown | 4 | 3 | 75% | +25pt | 100% (n=1) | N/A | N/A | N/A | 110.5 | 0.7 (n=3) | 0 | 0 | 0 |
| ↳ | llmgateway | unknown | 3 | 2 | 67% | — | N/A | N/A | N/A | N/A | 119.3 | 0.5 (n=2) | 0 | 0 | 0 |
| ↳ | openai | unknown | 1 | 1 | 100% | — | 100% (n=1) | N/A | N/A | N/A | 110.5 | 1.0 (n=1) | 0 | 0 | 0 |
| `kimi-k3` | direct | unknown | 1 | 0 | 0% | +0pt | N/A | N/A | N/A | N/A | N/A | N/A | 0 | 0 | 0 |
| `kimi-k3-fast` | direct | unknown | 9 | 8 | 89% | +0pt | 97% (n=9) | N/A | N/A | N/A | 353.7 | 4.8 (n=9) | 0 | 0 | 0 |
| `kimi-latest` | openrouter | opencode | 1 | 1 | 100% | +0pt | 100% (n=1) | N/A | N/A | N/A | 527.1 | 15.0 (n=1) | 0 | 0 | 0 |
| **TOTAL** | — | claude,opencode | 302 | 212 | 70% | — | 97% (n=199) | $24.839 (n=41) | 47,640,239 (n=41) | 56.0 | 114.8 | 12.2 (n=237) | 1 (0.00/issue) | 37 (0.12/issue) | 17 (0.06/issue) |

Of the 41 delivered issues with a cost figure, 17 were
recovered from the dispatch's own agent log because `runs.jsonl` recorded none — see
Limitations.

## Wall-clock per phase (all models)

Median seconds between a phase's milestone and the previous one, from the trails' own
`at=` stamps. Wall-clock is the only per-phase measure available: cost AND API-minutes
both come from one agent session that usually spans several phases, so neither can be
attributed to a phase (see Limitations).

| Phase | n | Median |
|---|---|---|
| batch-validate | 14 | 34.9m |
| batch-review | 5 | 31.7m |
| gate | 66 | 28.8m |
| review | 231 | 22.6m |
| implement | 229 | 21.2m |
| merge-wait | 162 | 20.2m |
| batch-report | 5 | 7.5m |
| plan | 229 | 5.8m |
| batch-ship | 5 | 3.0m |
| ship | 219 | 2.6m |
| setup | 227 | 2.6m |
| report | 187 | 55s |
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
- imboard-ai/ai-dossier: 26 of 131 run(s) are classifier dispatches (classify milestones only) — excluded from the by-model and by-class tables, since they record no model= and never ship
- imboard-ai/ai-dossier: 76 of 105 run(s) (72%) carry no classifier risk= verdict — they are bucketed as <unclassified>, so the class rows describe only the classified remainder
- imboard-ai/imboard-monorepo: issue imboard-ai/imboard-monorepo#3684 run r-3684-a0cf: gate milestone has an unusable at= value ('$(date') — skipped, and the next phase's duration is reported as unknown
- imboard-ai/imboard-monorepo: 35 run(s) recorded no model= — their row is bucketed as <unknown>, and its outcome columns are not attributable to any model
- imboard-ai/imboard-monorepo: 'kimi-latest' is a moving version tag with no declared pin — its 1 run(s) sit in their own row, apart from whatever pinned version the tag resolves to; add it to MODEL_ALIASES to fold them
- imboard-ai/imboard-monorepo: 53 of 239 run(s) are classifier dispatches (classify milestones only) — excluded from the by-model and by-class tables, since they record no model= and never ship
- imboard-ai/imboard-monorepo: 156 of 186 run(s) (84%) carry no classifier risk= verdict — they are bucketed as <unclassified>, so the class rows describe only the classified remainder
