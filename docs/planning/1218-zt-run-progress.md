# Issue #1218: zero-trust start/resume progress

## Problem
Start and resume are silent during multi-minute work after authorization, leading contributors to interrupt a working command. The issue records a real revision interrupted during verification.

## Acceptance Criteria
- [ ] AC1 Print one timestamped state / reason line for each live start/resume transition, before the command finishes.
- [ ] AC2 Explain that work continues after authorization and phases typically take several minutes (3–6 minutes in the reported run), with variable timing.
- [ ] AC3 Preserve status/metrics JSON, closed parsing, secret-safe output and active signal cleanup from #1217.

## Predicted Files
- `packages/zero-trust/src/controller/wiring.ts` — expose an observational lifecycle callback.
- `packages/zero-trust/scripts/zt-run-bindings.mjs` — pass callback without changing cleanup ownership.
- `packages/zero-trust/scripts/zt-run-lib.mjs` — closed timestamp/state/reason projection and wait guidance for start/resume only.
- `packages/zero-trust/scripts/zt-run.test.mjs` — live deferred progress, dedup, malformed/secret output and JSON regressions.
- `packages/zero-trust/scripts/zt-run-bindings.test.mjs` — callback forwarding regression.
- `packages/zero-trust/README.md` — observer contract.
- `docs/guides/zero-trust-contributions.md` — progress guidance.

## Approach
1. Reuse controller driver notifications after durable persistence; separate the UI observer from mandatory driver synchronization.
2. Pass the callback through the command facade only for start/resume; retain process-wide owner registration and interruption.
3. Render only validated primitive timestamp/state/reason fields, snapshot once, deduplicate identical notifications per invocation. Do not replay old history on resume.
4. Print fixed wait guidance before authorization can begin; keep final status rendering unchanged.
5. Add offline regression tests using deferred work and existing real composition fixtures, then run repository gates.

## Reachability Evidence
N/A — terminal presentation of existing lifecycle transitions, no new data-reachable state. Trigger: start/resume -> RunController persistence -> driver.observeRun; issue evidence confirms existing revision/verification transitions.

## Reusable Code
RunController notify/persistObserved, RunState/ReasonCode enum vocabulary, assertSecretFree, existing CLI injection and composed bindings fixtures.

## Risk Areas
No history replay, provider text, credentials or arbitrary record fields may enter progress. Separate observer driver ensures mandatory drivers execute even if output fails. Preserve #1217 cleanup owner and driver retirement. Traps: ignored PLANNING files use docs/planning; build zero-trust before scripts tests; bounded workers for durable-FS tests; JSON getters must be snapshotted once. Branch contains #1217, #1219 and #1220 merges. Package is private; confirm release gate.

## Test Scope
Deferred CLI output before completion; duplicate notifications; safe projection/getter/invalid timestamp/vocabulary and secret failures; actual production callback forwarding; status/metrics JSON unchanged; existing active signal tests; build, lint and full workspace tests with documented host-load retries.

## Open Questions
None.

## Visual Review
- [x] Not required (CLI only)

## Base Branch
`main`
