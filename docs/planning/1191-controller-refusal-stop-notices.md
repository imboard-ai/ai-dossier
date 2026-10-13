# Issue #1191: Controller refusal stop notices

## Problem
Controller.step refuses further work on active-time exhaustion, budget-session exhaustion or unresolved recovered reservations without retaining an explanation. Status then displays a generic action. No existing plan artifact was present.

## Acceptance Criteria
- [ ] AC1 Controller refusals retain a stop notice naming active_time_exhausted, budget_exhausted or hold_unsettled, with the next permitted action.
- [ ] AC2 The composed controller durably records the notice in the existing run artifact store, bound to the actual stopped state/history.
- [ ] AC3 Refusals admit no phase work; cleanup and observation-only tracking retain existing behavior, and successful continuation retires obsolete refusal notices.

## Approach
1. Add a closed controller-refusal reason type and fixed action text to the existing stop-notice module; support every existing run state for same-state waits.
2. Add an optional narrow ControllerDependencies callback to record or retire the controller's notice through its PhaseContext.
3. Split the existing refusal predicate while preserving its ordering and tracking exemption; predict the same pause transition apply already performs.
4. Wire the callback to existing StepArtifacts through recordStopNotice/clearStopNotice without restructuring composition.
5. Exercise real durable artifacts and reopen behavior in controller and composition tests.

## Reachability Evidence
N/A — no new reachable lifecycle state. These are existing admission branches, observed in #1115 run 4 and the unresolved holds reported by #1186, now given diagnostic persistence.

## Predicted Files
- `packages/zero-trust/src/controller/controller.ts` — callback and refusal branches.
- `packages/zero-trust/src/controller/stop-notice.ts` — closed reasons and action text.
- `packages/zero-trust/src/controller/wiring.ts` — narrow artifact callback.
- `packages/zero-trust/src/controller/controller.test.ts` — durable refusal and continuation assertions.
- `packages/zero-trust/src/controller/__tests__/e2e-fakes.test.ts` — composed persistence/status proof.

## Reusable Code
recordStopNotice, clearStopNotice, stopNoticeAction, StepArtifacts, ScriptedSteps, and existing composition fixtures.

## Risk Areas
- Preserve observation-only tracking's exhaustion exemption and cleanup accounting; do not settle unknown holds artificially.
- A non-gating hand-off pauses with one extra history entry; gating and stopped-state waits do not transition.
- Retire only a controller refusal notice when admission succeeds, avoiding deletion of a different producer's notice.
- #1181 owns export evidence wiring and zt-run bindings; #1182 owns broker grant cleanup. Keep the composition edit additive and check latest main before merge. #1194 proxy/provisioning notices are outside this scope.
- Trap index read in full: pool dist can be stale; fsync-heavy tests may require longer deadlines and fewer workers. Use published absolute CLI for milestones.

## Test Scope
Controller tests for each reason, gate and pause binding, unknown hold recovery, successful retirement, callback failure propagation, and tracking exemption. Composition test reads retained stop_notice after reopening the store. Run package coverage, build, root lint and CI parity.

## Open Questions
None.

## Visual Review
- [x] Not required (backend only).

## Base Branch
`main`
