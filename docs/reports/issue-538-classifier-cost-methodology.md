# Issue #538 — classifier cost methodology and partial measurement

Addresses #538 AC3 ("Measured: tokens per classified issue and per `slot` hit before/after on
the same candidate set — attempt-2's 15 as the baseline: ~64k/issue"). A live token
re-measurement requires dispatching real `issue-cycle-classifier` agents against the
imboard-monorepo backlog in production — an ops action in the same category as
[#526](https://github.com/imboard-ai/ai-dossier/issues/526)/[#529](https://github.com/imboard-ai/ai-dossier/issues/529),
not something a single code PR runs. This report documents what a code PR CAN measure —
concrete numbers on the real fixture set, not estimates pulled from first principles — and the
formula a follow-up ops run drops real dispatch numbers into for the final AC3 answer.

## Baseline (measured, pre-#538)

From `docs/reports/batch-pilot-2-execution.md`: §2.2 has the 15-issue classify set (3 `slot`,
12 `full`); §4.1 has the token/tier measurement — one `issue-cycle-classifier` dispatch each, at
mid tier, with full repo exploration for every issue regardless of how obvious its floor rule
was.

- **15 issues classified, 3 `slot` (20.0%)**
- **~64k tokens/dispatch** (mean), **~448k total agent tokens** across the 7-issue wave 2 alone

## What this PR measures (the pre-screen's real hit rate)

`cli/src/__tests__/fixtures/prescreen-regression-issues.json` holds the same 15 issues' real
title/body/labels (read-only `gh` data, `cycle:*` labels stripped since they are the
classifier's own output, not input a pre-screen sees). Running `prescreenIssue` — the actual
shipped code, not a simulation — against all 15:

| | count | tokens |
|---|---|---|
| `verdict: "full"` (pre-screen rejects, no model call) | **7 of 15 (46.7%)** | 0 |
| `verdict: "candidate"` (proceeds to the bounded mechanical-tier pass) | 8 of 15 (53.3%) | see below |

This is the number `cli/src/__tests__/prescreen.test.ts` asserts on every test run (an explicit
aggregate assertion — 7 `full` / 8 `candidate` / 15 total — not just per-fixture checks) — not a
one-time measurement that can drift, a regression-tested fact about the shipped pre-screen
logic. All 3 known `slot` issues correctly come back `candidate` (pre-screen never falsely
rejects a real slot-eligible issue — the safety property AC4 needs); 7 of the 12 known `full`
issues are caught deterministically via a genuinely present title/body/label signal
(terraform, security, deploy, migration, authorization keywords, or a `cicd` label — see the
fixture file and `cli/README.md`'s Classify Pre-Screen section for the exact breakdown).

At baseline cost (§4.1's ~64k mean, applied to these 7), those 7 issues would extrapolate to
~7 × 64k ≈ 448k tokens — coincidentally the same total §4.1 measured for wave 2's 7 dispatches,
but a different set of 7 issues; this is an extrapolation from the §4.1 mean, not a reuse of its
measurement. At pre-screen cost, they cost **two `gh` API calls each (issue metadata + comments,
for the plan:v1 check) plus one more per `Depends on #N` reference, if any — 0 model tokens.**

## What this PR estimates (the bounded mechanical-tier pass, AC2's other half)

For the 8 `candidate` issues, the classifier's Step 4 (bounded inspect) now runs on issue
text alone — no repo exploration — a token floor set by the issue's own size, not by how much
of the repo an agent decides to read.

Measured directly from the same 15-issue fixture (title + body character counts, the actual
input a bounded pass would receive):

- **Average title+body: 2,567 characters ≈ 642 tokens** (4 chars/token, the standard rough
  English-text estimate)
- Add the dossier's own bounded-step instructions (~1–2k tokens, fixed regardless of issue
  size) and generous headroom for the model's own reasoning/output (verdict fields + a short
  rationale, typically a few hundred tokens) — a bounded mechanical-tier dispatch should land
  in the **low thousands of tokens**, comfortably under the **≤10k/issue target**, and nowhere
  near the ~64k baseline that came from unconstrained repo exploration (`git grep`, reading
  full files) rather than issue size.

This is an estimate, not a dispatch measurement — it is not claimed as the final AC3 number.
It is bounded by something real (actual issue text length on the actual candidate set), which
is why it is presented separately from a live re-measurement rather than as a substitute for
one.

## Combined estimate vs. baseline

| | before (#538) | after (estimated) |
|---|---|---|
| Total tokens, 15 issues | ~960k (15 × §4.1's ~64k mean, extrapolated — the mean itself was measured over 7 dispatches, not 15) | ~7 × 0 + 8 × (≤10k budget) ≈ **≤80k, likely far less** |
| Mean tokens/issue | ~64k | **≤~5.3k** (well under the ≤10k target) |
| `slot` hit rate | 20.0% (3/15) | unchanged — pre-screen never rejects a real `slot` issue (regression-tested), and the bounded/escalated pass preserves the same E.2/E.3 logic, just cheaper to run |

## Follow-up: closing the estimate to a measurement

The next live pilot run (successor to #526/#529, once #529's GO/NO-GO gate is reached) should
re-classify the same 15-issue set — or the current eligible backlog — with the updated
`issue-cycle-classifier` dossier and record real per-dispatch token counts via
`ai-dossier sched stats` (per-issue token telemetry, #524). Drop those numbers into the table
above in place of the estimate row to close AC3 with a live-measured number.
