# Issue #461: feat(cli): runstate vocabulary for classify phase, batch phases, and mode/batch keys

## Problem
RFC-0001 Batch Cycles (sections C.2/D.4) introduces three new milestone shapes the
runstate CLI must accept: a `classify` phase (verdict from the issue-cycle-classifier,
#465), five `batch-*` phases (posted on batch anchor issues by the scheduler, #460), and
optional `mode=slot` / `batch=<id>` keys on existing `plan`/`implement`/`review`
milestones. The CLI validates phases/keys strictly, so every one of these is currently
rejected (`Unknown phase 'classify'`). #465 declares "keys per #461" — this issue IS the
vocabulary contract for both siblings.

## Acceptance Criteria
- [ ] AC1 New phase `classify` accepted with keys: `mode=full|slot`, `risk=low|med|high`, `est_files=`, `est_diff=`, `areas=`, `test_scope=focused|broad|unknown`, `deps=`, `confidence=`
- [ ] AC2 New batch phases accepted (posted on batch anchor issues): `batch-setup`, `batch-validate`, `batch-review`, `batch-ship` (done/awaiting-merge), `batch-report`
- [ ] AC3 Optional keys `mode=slot` and `batch=<id>` accepted on existing `plan`/`implement`/`review` phases
- [ ] AC4 `runstate verify` behavior for all existing phases unchanged (regression tests); slot-mode trails do not confuse `resume_from` derivation for full-cycle (evicted issues re-enter fresh — verify emits a distinguishable signal, e.g. `slot_trail=present`)
- [ ] AC5 `runstate last`/`stats` handle the new phases; docs updated
- [ ] AC6 Malformed values for the new keys are rejected with actionable errors (existing validation philosophy)

## Approach
1. `cli/src/runstate.ts` — add `CLASSIFY_PHASE` ('classify', statuses done|blocked; done
   requires mode, risk, est_files, est_diff, areas, test_scope, deps, confidence) and
   `BATCH_PHASES` (batch-setup→batch-validate→batch-review→batch-ship→batch-report;
   statuses: done|blocked except batch-ship awaiting-merge|done|blocked and batch-report
   done only). Keep `PHASES`/`Phase` untouched as the full-cycle linear order — new
   phases join a wider `ALL_PHASE_SPECS` used by `validateMilestone` only.
2. Value grammar table for the new keys (applies wherever the key appears, on any
   phase): `mode`∈full|slot, `risk`∈low|med|high, `test_scope`∈focused|broad|unknown,
   `est_files`/`est_diff` non-negative integers, `confidence` decimal 0–1 (RFC E.2:
   "confidence < 0.6" floor), `areas` comma-separated slugs, `deps` `none` or
   comma-separated positive integers, `batch` slug (`[A-Za-z0-9][A-Za-z0-9._-]*`).
   Actionable one-line errors in the existing style.
3. `defaultNext`: classify done → `done` (standalone pre-cycle record — the cycle mints
   its own run); batch chain walks its own linear order (awaiting-merge stays in
   batch-ship for the second milestone, mirroring ship). `NEXT_VALUES` gains the new
   phases so `--next` can reference them.
4. `computeResume`: a trail whose LAST milestone is a slot-mode full-cycle milestone
   (carries `mode=slot` or `batch=`) → `resume_from=none` + `slot_trail=true` signal
   (evicted issues re-enter fresh). Last milestone `classify` → `resume_from=none` (+
   slot_trail when mode=slot). Last milestone a batch phase → `resume_from=none`, note
   "batch anchor trail". Existing-phase behavior byte-identical (golden table test).
5. `runstate-stats.ts`: `STATS_PHASE_ORDER` = classify, then full-cycle phases with
   merge-wait, then batch phases; `phaseNameFor` relabels batch-ship's second milestone
   (after awaiting-merge) as `merge-wait`, same as ship.
6. Command layer: update `--phase` help text; `verify` prints `slot_trail=present`
   (text) / `slot_trail: true` (JSON) and the notes.
7. Docs: cli/README.md runstate section (phases table + batch subsection, value-grammar
   rules, verify slot_trail). PROTOCOL.md has no runstate section at all (verified —
   zero mentions); the runstate docs live in cli/README.md, so that is "the runstate
   section" the issue scope names.
8. Bump `cli/package.json` 0.13.0 → 0.14.0 (CI version-bump rule) + CHANGELOG entry.

## Reachability Evidence
- N/A — no new user/product data state. This is developer-tooling protocol vocabulary;
  the repo has no production data store. Consumers are in-flight under the accepted RFC:
  #465 (classifier, "keys per #461") and #460 (scheduler, already stubbing
  `--from-manifest`), both children of accepted epic #474.

## Files to Modify
- `cli/src/runstate.ts` — classify/batch phase specs, value grammars, defaultNext, NEXT_VALUES, computeResume slot/batch handling
- `cli/src/commands/runstate.ts` — help text, verify slot_trail output
- `cli/src/runstate-stats.ts` — STATS_PHASE_ORDER, batch-ship merge-wait relabel
- `cli/src/__tests__/runstate.test.ts` — spec-table coverage for new phases, value-grammar tests, defaultNext, computeResume slot/batch + golden regression table for existing phases
- `cli/src/__tests__/runstate-stats.test.ts` — ordering + batch merge-wait
- `cli/README.md` — runstate docs
- `cli/package.json` — version bump
- `CHANGELOG.md` — Unreleased entry

## Reusable Code
- `cli/src/runstate.ts:firstKeyProblem()` — hook point for value grammars; keep the
  "first problem per key" and actionable-message style
- `cli/src/runstate.ts:PHASE_SPECS`/`requiredKeys()` — extend via a wider spec map,
  don't fork validation
- `cli/src/runstate-stats.ts:phaseNameFor()` — the ship→merge-wait relabel pattern,
  generalized to batch-ship
- Existing test fixtures (`noopProbe`, `milestone()`, `DOSSIER_SPEC` literal) in
  `runstate.test.ts` — mirror for the new-phase spec table

## Risk Areas
- `PHASES` drives `defaultNext`, `STATS_PHASE_ORDER`, `NEXT_VALUES`, and
  `PHASE_RESUMERS` typing — new phases must NOT join it, or resume semantics change
  (AC4 regression). They get their own lists.
- `computeResume` currently maps unknown phases → `resume_from=none`; once classify and
  batch-* are "known" to validation they must still land at `none` for full-cycle
  verify, with the distinguishable signal.
- `resume_context` merges keys across ALL milestones including slot-mode ones —
  acceptable (read-only context), documented.
- Cross-issue coordination: #460 (scheduler) and #465 (classifier) consume this
  vocabulary. Batch phases deliberately carry NO phase-specific required keys (only
  blocked→reason, which is universal) so the scheduler dossier is not over-constrained;
  documented as a deliberate choice in README.
- Biome lint (`npx biome check`) must pass; build is `tsc` — `PHASE_RESUMERS` typing
  must stay exhaustive over `Phase`.

## Test Strategy
- Extend `runstate.test.ts`:
  - spec-table tests: classify (done happy path with all 8 keys; each missing key
    named; blocked requires reason), each batch phase (accepted statuses; invalid ones
    rejected, e.g. batch-report blocked, batch-review awaiting-merge)
  - value-grammar tests: mode=Slot, risk=medium, test_scope=huge, est_files=-1/abc,
    est_diff=1.5, confidence=high/1.5/-0.1, areas="CLI Docs", deps="12,a",
    batch="b 1" — each rejected with one actionable line; valid boundary values accepted
    (confidence=0.6/1/0, est_files=0, deps=none, areas=cli,docs)
  - defaultNext: classify done→done; batch chain; batch-ship awaiting-merge→batch-ship;
    NEXT_VALUES includes new phases
  - computeResume: golden regression table (every existing phase/status fixture →
    unchanged resume_from); slot-mode last milestone → none + slot_trail; classify →
    none (+slot_trail when mode=slot); batch-* → none + note; batch= key alone on
    implement → none + slot_trail
- Extend `runstate-stats.test.ts`: STATS_PHASE_ORDER placement; batch-ship second
  milestone relabels to merge-wait
- Full suite: `make test` (workspaces + scripts); lint: `npx biome check`

## Open Questions
(none)

## Visual Review
- [x] Not required (backend/infra only)

## Base Branch
`main` — PRs for this issue target this branch.
