# Issue #1223: zero-trust: one split vote on revision feedback ends the revision for good

## Problem

No `plan:v1` artifact was present, so this is a fresh plan. It supersedes the run's earlier
blocked investigation on this branch. The owner decision of 2026-10-15 (comment on #1223, and
the "Issue workflows" bullet in `AGENTS.md`) binds `prod_data_access=none`, so the reachability
check below follows plan-issue Step 4b case B.

In the #1002 post-fix live re-run, the typed revision-feedback screen split on an in-scope
maintainer review (`hand_off`, confidence 0.5, reason `disagreement`). The run went
`revising → paused_user` and could not recover:

- `packages/zero-trust/src/controller/steps.ts` (`implement`) caches `feedback_decision` per
  budget session. Every later entry in that session replays the refusal without looking at the
  feedback it judged.
- `packages/zero-trust/src/github/track.ts` `beginRevision()` selects revision feedback only from
  the tracking states (`submitted`, `awaiting_review`, `accepted`). A paused, refused revision
  never reads the PR again, so a later maintainer review is never seen.
- Ordinary resume (`controller.ts` `leaveUserPause()`) re-enters `revising`, where the cached
  refusal hands off again.

A red test pins the observable failure. It covers a refused revision, then a NEW maintainer
review (new id), then explicit `resume --revise`. The run still ends `paused_user` with nothing
implemented. The `revision_unavailable` refusal named in the earlier diagnosis does not fire for
this run: `isTrackerPhase()` is true once a `revision_requested` transition exists. The blocker
is the cached decision plus the missing re-read.

Owner-endorsed route (the issue's third alternative): re-judge genuinely NEW maintainer feedback
instead of replaying the cached split. Keep disagreement fail-closed for the SAME feedback. Keep
the issue/approved-plan scope. Removing the approved plan from the question stays out of scope:
it is a separate product decision (`docs/features/zero-trust-full-cycle/decisions/acceptance-demo.md`).

## Acceptance Criteria

- [ ] AC1 After a revision handed off because its feedback was not admitted, an explicit `resume --revise` reads the PR again and re-judges maintainer feedback that is new (a new review/comment id, or an item edited since), and an admitted verdict continues the same revision to a verified CAS push on the same PR.
- [ ] AC2 The refused feedback itself is never re-judged or admitted: with no new maintainer feedback, `resume --revise` (and plain `resume`) makes no model call, allocates no VM and pushes nothing, and a refused item stays excluded from later revisions unless edited.
- [ ] AC3 The original refused verdict is retained, the recovery stays in the same revision budget session with prior spend intact, and the existing freshness/authority guards (policy/issue, contributor, fork binding, reviewer allow-list, head checks) apply to the re-read.
- [ ] AC4 Status and docs state the recovery path accurately: after a feedback hand-off, the next permitted action names `resume --revise` once a maintainer posts new feedback.

## Approach

1. **Tracker** (`track.ts`): add `refreshRefusedRevision(refused)`. It is valid only while a
   revision has no candidate, the run is `paused_user`, and no action is pending. It reads the PR
   and applies the same merged/closed/head checks as `duringRevision`. It selects actionable
   feedback minus the refused refs, refreshes freshness, writes the feedback ahead, and journals
   `revision_refreshed { refused, feedback }`. The reducer moves the refused refs into a durable
   `refused` map and replaces `revision.feedback`. `actionableFeedback()` excludes refused items
   (same id + `updatedAt`), mirroring `addressed`. Nothing new → `nothing_to_revise`, with nothing
   recorded.
2. **Decision cache** (`steps.ts`): key `feedback_decision` by the identity of the feedback it
   judged (ids + `updatedAt`) as well as the session. Fresh feedback is assessed again. The same
   feedback replays the refusal.
3. **Wiring** (`wiring.ts`): a recovery hook `refreshRefusedRevision(c)`. It acts only when the
   current session's `feedback_decision` is a refusal of exactly the tracker's current revision
   feedback. It retains the refused decision in `feedback_refusals` (append-only), calls the
   tracker, and syncs it.
4. **Controller** (`controller.ts`): on `resume --revise` from a `paused_user` revision (no open
   checkpoint), call the hook after credential recovery and before `leaveUserPause()`. Adopt a
   blocked run and stop. Otherwise continue the ordinary resume, which re-enters `revising` in the
   same session.
5. **Status/docs**: update the `FEEDBACK_NOT_ADMITTED` next action (`scripts/zt-run-bindings.mjs`),
   `packages/zero-trust/README.md` and `docs/guides/zero-trust-contributions.md`.

## Reachability Evidence

- State: refreshed revision feedback (`revision_refreshed`) after a feedback hand-off |
  Trigger: typed screen refusal in `steps.ts` `implement` (`!result.admitted → hand_off`, run
  `revising → paused_user` via `UserPaused`), then a later maintainer review on the same PR and a
  contributor `zt-run resume --revise`. Live instance of the first half:
  `ztc-4cc2feace7c94368-run-1` (#1223 evidence). | Prod check: skipped (`prod_data_access=none`) |
  Verdict: N/A — no production access by policy.

## Predicted Files

- `packages/zero-trust/src/github/track.ts` — `refreshRefusedRevision`, `revision_refreshed` event, `refused` map, `actionableFeedback` exclusion.
- `packages/zero-trust/src/controller/steps.ts` — decision cache keyed by feedback identity.
- `packages/zero-trust/src/controller/wiring.ts` — recovery hook that retains the refusal and refreshes the tracker.
- `packages/zero-trust/src/controller/controller.ts` — call the hook on explicit `--revise` from a paused revision.
- `packages/zero-trust/src/controller/__tests__/e2e-fakes.test.ts` — composed red/green regression and rig helpers.
- `packages/zero-trust/src/github/__tests__/track.test.ts` — tracker replay and selection unit tests.
- `packages/zero-trust/scripts/zt-run-bindings.mjs` — next permitted action after a feedback hand-off.
- `packages/zero-trust/README.md` — revision recovery contract.
- `docs/guides/zero-trust-contributions.md` — contributor recovery instructions.

## Reusable Code

- `actionableFeedback()` / `addressed` map — the identity rule (id + `updatedAt`) reused for `refused`.
- `PrTracker.fresh()`, `unexpectedHead()`, `closedDuringRevision()`, `block()` — the same guards as `beginRevision`/`duringRevision`.
- `retainRevisionFeedback` dep — write-ahead feedback artifact before the journal event.
- `leaveUserPause()` — the existing `ResumeRevising` re-entry; no new lifecycle edge is needed.
- e2e rig `published()`, `feedback()`, `revisionAmbiguous` — the composed fixture for the live failure.

## Risk Areas

- A refusal must never turn into a silent paid retry of the same input. The cache key and the
  `refused` exclusion both enforce this.
- Crash safety: write the feedback artifact ahead, then journal the tracker event. A crash between
  the two leaves the old revision. Re-running `--revise` refreshes again (idempotent).
- Hand-offs other than feedback refusal (checkpoints, user pause, review refusal) must not refresh.
  The hook requires a matching refusal in the current session and no open checkpoint.
- Trap index (`docs/agent-traps.md`): integer-only StepArtifacts verdict storage (#1111),
  revision-session accounting (#1111), durable checkpoint barriers (#1100).
- `packages/zero-trust` is `"private": true`, so `scripts/check-version-bumps.mjs` skips it and no
  version bump applies.

## Test Scope

- Red-before-green: the e2e test `re-judges a new maintainer review after a split feedback vote,
  never the refused input (#1223)` failed before the fix (`paused_user` instead of `submitted`).
- Tracker unit tests: replay of `revision_refreshed`. Refused items are excluded until edited.
  Nothing new → `nothing_to_revise` with no event. The method is refused outside a candidate-less
  paused revision.
- Existing suites: `e2e-fakes`, `track.test`, `steps.test`, `controller.test`, the
  `zt-run-bindings` script tests, `make build-zero-trust`, the package test suite, `make lint`.

## Open Questions

(none)

## Visual Review

- [x] Not required (controller/tracker/CLI only)

## Base Branch

`main` — PRs for this issue target this branch.
