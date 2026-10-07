# Issue #1097: zero-trust: deterministic scope and test-integrity review before shipping (scenario 15)

## Problem
Add the missing deterministic review API for candidate scope and test integrity. Successful command/discovery reports alone do not establish honest tests or authorize publication. Owner instructions supersede prior scheduling blocks; there is no functional dependency on #1096. No existing plan:v1 artifact was available (`plan_reused=false`).

## Acceptance Criteria
- [ ] AC1 Every finding code has at least one positive and one negative fixture test.
- [ ] AC2 Scenario 15 is a test: the target change is correct, but the patch also deletes an assertion and adds a `.skip`. The verdict is `hand_off` with both findings, even though both discovery summaries report success.
- [ ] AC3 A clean minimal patch (one source file plus one new test file) passes.
- [ ] AC4 Unknown discovery on either side always hands off.
- [ ] AC5 Deterministic: the same inputs give the same findings in the same order.

## Approach
1. Add pure `reviewCandidate` with typed inputs/results, local review limits, immutable validated manifest snapshots and runtime discovery validation. Malformed evidence/limits returns a fixed `invalid_input` finding; unknown discovery returns `discovery_unknown`.
2. Compare all paths in byte order, including executable-mode changes and file/directory replacements. Count changed ordinary files; identify removed/renamed tests by missing original test path.
3. Decode changed blobs strictly as UTF-8, reject generated paths and files above 1 MiB, and compare test assertion counts plus newly added disable/focus markers. Flag build/config paths and added promotional strings outside tests.
4. Use a bounded line-based LCS diff, stripping equal prefix/suffix, with conservative delete-plus-add accounting when the work cap is exceeded. Never underestimate changed lines, even for substitutions, reordering, duplicate lines or terminal-newline changes. No dependency added.
5. Add offline positive/negative fixtures for every code and path/marker family, scenario 15, limits boundaries, malformed evidence, deterministic ordering, no mutation and non-echoing diagnostics. Export the API and document the exact conservative behavior in README.

## Reachability Evidence
N/A — controller-side pure infrastructure API over explicit in-memory manifests and full-suite summaries; no production data-dependent state or UI flow. Real triggers are removed/disabled tests, assertion reductions, changed protected paths and reduced/unknown parsed counts; fixtures directly exercise these inputs. This API is supplementary to existing shipping authorization and does not change lifecycle or upstream writes.

## Predicted Files
- `packages/zero-trust/src/review/integrity.ts` — pure review and types.
- `packages/zero-trust/src/review/integrity.test.ts` — offline fixture matrix and invariant regressions.
- `packages/zero-trust/src/index.ts` — public export.
- `packages/zero-trust/README.md` — public contract and limitations.
- `docs/planning/1097-zero-trust-integrity-review.md` — durable phase plan.

## Reusable Code
- `canonical/export.ts:validateManifest` — bounded deep-frozen canonical validation; no filesystem I/O when invoking this function.
- `canonical/export.ts:comparePaths`, `createManifest`, `parentPaths`, `sha256` — ordering and in-memory fixtures.
- `ecosystem/report.ts:JunitSummary` — credential-free structural summary type.
- `redaction.ts:assertNoSecrets` — prevent secret-shaped paths in findings; content stays internal.
- Existing credential isolation scanner — verify new import chain remains credential-free.

## Risk Areas
- Text scanning is conservative, not semantic proof; comments/string literals may flag. Added-line comparison may flag moved pre-existing markers.
- Bounded diff fallback intentionally over-counts rather than trusting incomplete analysis.
- Validate both manifests before comparison; retain changed directory config/generated scope without counting ordinary directory housekeeping as changed files.
- Trap hits: durable plan belongs under docs/planning (ignored root scaffold); warm pool dist may be stale (#1027); no shared stash; Biome warnings fail; test assertions must remain outside catch-all production boundaries.
- Private package: no version bump or changeset. No credential imports, network tests, receipt edits or publication paths.

## Test Scope
Run focused review and credential isolation tests, package strict build and required package coverage (90% statements/functions/lines, 85% branches). Run full repository auto-fix, read-only lint, build and test gates. Confirm existing PR CI includes zero-trust build/coverage. Retry infrastructure flakes with longer deadlines. All fixtures local/in-memory; no live provider calls.

## Open Questions
None.

## Visual Review
- [x] Not required (backend/infra only)

## Base Branch
`main` — supplied base commit `3a995a7`.
