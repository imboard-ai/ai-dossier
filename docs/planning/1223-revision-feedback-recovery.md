# Issue #1223: revision feedback recovery — blocked reachability assessment

## Problem

The live acceptance record reports a split typed scope vote for a named-constant
request, followed by a permanent revision handoff. Investigated against updated
`origin/main` at `da352b1`, including the merged #1217, #1219 and #1220 fixes.
No existing plan artifact was present. Actual executor: `openai/gpt-6.1-sol`.

Two independent guards explain the report:

- `packages/zero-trust/src/controller/steps.ts:669-695` retains
  `feedback_decision` by session ID. A rejected verdict returns `hand_off` on
  every later implementation entry in that session without reading new feedback.
- `packages/zero-trust/src/controller/controller.ts:469-471` rejects explicit
  revision before recovery when the run is not in a tracker phase. The feedback
  handoff has already put the run in `paused_user`.
- Ordinary resume uses `leaveUserPause()` at `controller.ts:571-591` to return
  to revising, where the retained rejected decision still applies.
- `packages/zero-trust/src/github/track.ts:1467-1489` begins revisions only from
  tracking states and retains its selected feedback before journaling admission.
  Merely deleting the cached verdict would not safely refresh this selection.

The issue permits several alternatives. The conservative proposal is its third
alternative: allow explicit revision recovery for genuinely new maintainer
feedback, while preserving disagreement as a refusal for the original input.
This proposal does not require an admission override, majority voting, or removing
the approved plan from scope. The approved specification still requires ambiguous
feedback to hand off; the acceptance record at
`docs/features/zero-trust-full-cycle/decisions/acceptance-demo.md:115-119`
identifies removing the plan as a separate product decision.

## Acceptance Criteria

Proposed criteria for the new-feedback alternative, contingent on the reachability
decision below:

- [ ] A later `resume --revise` can re-judge new maintainer feedback with a new
  review ID from a feedback-handoff `paused_user` run on its own published PR.
- [ ] The unchanged rejected input is not retried or automatically admitted;
  disagreement remains fail-closed, without revision VM allocation or push.
- [ ] Recovery preserves the original verdict and session spend, and retains
  current reviewer authority, policy freshness, checkpoint, stop, and CAS guards.

## Predicted Files

- `packages/zero-trust/src/controller/controller.ts` — narrowly scoped explicit
  recovery entry and budget/session coordination.
- `packages/zero-trust/src/controller/steps.ts` — bind admission to the exact
  refreshed feedback rather than clearing a rejected session cache blindly.
- `packages/zero-trust/src/github/track.ts` — durable selection/supersession of
  new feedback for a paused, unimplemented revision.
- `packages/zero-trust/src/controller/__tests__/e2e-fakes.test.ts` — composed
  recovery, unchanged-input refusal, restart and stop/freshness regressions.
- `packages/zero-trust/src/github/__tests__/track.test.ts` — tracker persistence
  and fresh-feedback identity controls.
- `packages/zero-trust/scripts/zt-run-bindings.mjs` — accurate permitted action
  after feedback handoff.
- `packages/zero-trust/README.md` — revised recovery contract.
- `docs/guides/zero-trust-contributions.md` — contributor recovery instructions.

## Approach

1. Resolve the required production-occurrence reachability check before building
   this new recovery flow. This document is a blocked investigation, not an
   implement-ready plan.
2. Restrict recovery to a published, feedback-refused, unimplemented revision;
   distinguish it from checkpoints, ordinary user pauses and pending pushes.
3. Observe fresh maintainer feedback through the real tracker, retain the old
   evidence, and bind the new selection to durable feedback identity and the
   selected finite budget session.
4. Require the existing typed decision to accept the new input before executing
   work; preserve all current publication and credential admission guards.
5. Exercise reopening and interrupted durable prefixes through composed offline
   tests, and document the resulting action accurately.

## Reachability Evidence

- New flow: feedback-handoff `paused_user` → explicit revision recovery with a
  later new maintainer review ID on the same open PR.
- Trigger: a rejected typed verdict at `steps.ts:694-695`, followed by a later
  maintainer review and contributor `resume --revise`. The current entry guard
  at `controller.ts:470-471` refuses this command.
- Existing handoff evidence: issue #1223 and the acceptance record document one
  split vote on PR #9. They establish the existing refusal, not an occurrence
  count of a later new review ID awaiting recovery.
- Production check: **not run**. This invocation supplied no `prod_data_access`
  method, no explicit `none`, and exposes no read-only production run store.
  Public issue/PR text cannot establish the retained controller pause, feedback
  selection and session identities for this triggering condition.
- Verdict: **UNVERIFIABLE — escalated** under `plan-issue@1.9.0` Step 4b case D.
  This is not zero occurrences and not N/A. Offline fixtures cannot substitute
  for the required production count. No new recovery implementation was built.

## Reusable Code

- `assessRevisionFeedback()` — existing typed refusal and confidence contract.
- `PrTracker.beginRevision()` — current feedback authority and freshness checks.
- `leaveUserPause()` — existing lifecycle continuation, not fresh admission.
- `ensureRevisionSession()` — retained-spend revision session allocation.
- Existing composed revision tests — real durable stores and fake network edges.

## Risk Areas

- Never turn repeated disagreement into permission or a silent paid retry.
- Keep original/updated feedback and candidate/push state coherent across crashes.
- Distinguish a feedback handoff from all other user pauses and open checkpoints.
- Trap index read in full; relevant hits: integer-only StepArtifacts verdict
  storage (#1111), revision-session time accounting (#1111), durable checkpoint
  barriers (#1100), and legacy paused intent reconciliation (#1019).
- No publishable package bump is needed for the private zero-trust workspace.

## Test Scope

After reachability is resolved, test rejected verdict → new review → explicit
resume → confident decision → verified same-PR CAS; unchanged review refusal;
non-maintainer or unrelated feedback refusal; reopen after durable prefixes;
cancel/pause/checkpoint and freshness refusal with zero unintended allocation or
push. Run package build, composed revision/tracker/CLI suites, coverage and the
repository CI-equivalent gate. No tests were run for this investigation-only stop.

## Open Questions

- Reachability unverifiable — could not count feedback-handoff pauses with a
  later new maintainer review ID (no production run-store access method supplied).
  Confirm this state is real with read-only evidence and a count, supply the
  access method, or rerun with `prod_data_access=none` if this project deliberately
  grants no production access. Do not infer that policy from missing tools.

## Visual Review

- [x] Not required (controller/tracker/CLI recovery only).

## Base Branch

`main` — issue branch `bug/1223-revision-feedback-recovery`; run `r-1223-54fb`.
