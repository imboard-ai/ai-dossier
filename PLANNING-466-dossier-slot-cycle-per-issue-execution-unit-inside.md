# Issue #466: dossier: slot-cycle — per-issue execution unit inside a batch

## Problem
RFC-0001 §C.4 (branch `docs/batch-cycles-rfc`, `rfcs/0001-batch-cycles.md`) defines the batch-cycles architecture: the expensive lifecycle (setup, full suite, CI, PR, merge, deploy, teardown, aggregate review) is owned once per batch by the scheduler, while each member issue needs a small per-issue execution unit that produces confidence without any of that ceremony. That unit — `slot-cycle` — does not exist yet. It runs in a scheduler-provided worktree on the shared batch branch, deliberately not independently deployable. Dependencies landed: runstate vocabulary `mode=slot`/`batch=` keys + classify/batch phases (CLI 0.14.0, #461), plan:v1 artifact commands `plan post|get|validate` (CLI 0.16.0, #462), classifier dossier (#465/#482), sched core (#460).

## Acceptance Criteria
- [ ] AC1 Preconditions documented and asserted: worktree exists, batch branch checked out, environment warm, plan:v1 artifact + classify record available — no gate/setup/ship/report phases inside
- [ ] AC2 Step 1 plan-validate: `ai-dossier plan validate` (deterministic, #462) + one cheap model sanity pass; refine incrementally, never recreate; misclassification tripwire — floor-area path or >2× estimated scope → stop, post `blocked reason=misclassified`, hand back to scheduler
- [ ] AC3 Step 2 implement: implement-issue discipline scoped to changed files (lint, typecheck, focused tests; `cap run test.focused` used when available with reasoning fallback)
- [ ] AC4 Step 3 per-issue blind conformance: same contract as review-issue Agent 7 (issue + this issue's diff + ACs only; met verdicts require file:line citations), strongest tier
- [ ] AC5 Step 4 exactly one commit `<type>: <title> (#N)` at the issue boundary, pushed (WIP-sync granularity = issue boundary inside batches, per RFC C.4 — stated explicitly in the dossier)
- [ ] AC6 Milestones posted with `--kv mode=slot batch=<id>` on existing phases (#461); hand-off paths defined for `misclassified` and `dependency-discovered`
- [ ] AC7 `examples/git/` snapshot refreshed

## Approach
1. Author `slot-cycle.ds.md` per the classifier-dossier template (same epic, same house style): frontmatter (name, v1.0.0, Draft, inputs `issue_number`/`batch`/`worktree`), Preconditions step asserting the four scheduler-provided invariants (and refusing to run otherwise), Step 1 plan-validate (mint run id; `plan validate`; incremental refine via superseding `plan post`; cheap model sanity pass; floor-area and >2× scope tripwires → `blocked reason=misclassified`), Step 2 implement (changed-file lint/typecheck + focused tests via `cap run` with the four-outcome fallback), Step 3 blind conformance with review-issue Agent 7's contract verbatim (diff scoped to this member's changes since the issue boundary), Step 4 exactly-one-commit `<type>: <title> (#N)` pushed, milestones `plan`/`implement`/`review` with `mode=slot batch=<id>` (+ full required-key sets per `cli/src/runstate.ts` PHASE_SPECS), hand-off paths (`misclassified`, `dependency-discovered`, plus `no-plan-artifact`, `preconditions`, `test-failures`, `spec-not-met`), explicit WIP-sync relaxation statement, non-responsibilities list, troubleshooting table.
2. Dry-run the dossier's commands against a scratch repo (`/tmp`): precondition assertions, `plan validate` valid + risk-floor-info + missing-file variants (plan artifact posted on #466), all milestone commands validated via `runstate post --dry-run` (done + each blocked reason), `cap list`/`cap run test.focused` fallback path, one-commit boundary flow pushed to a local bare remote.
3. Publish via the `imboard-ai/meta/publish-dossier` recipe: sign with `~/.dossier/imboard-ai.pem` (key id `imboard-ai`), lint clean, verify passed, `publish --namespace imboard-ai/git`, then refresh machines (wls/hcc/occ).
4. Snapshot: copy the signed published file to `examples/git/slot-cycle.ds.md` (PR artifact, #431/#441 convention); run `scripts/test-examples.sh` (validate + checksum on every example).

## Reachability Evidence
- N/A — no new user-reachable product state. This is a workflow dossier (orchestration artifact) for a scheduler under active construction in the same epic (#474; sched dispatch is #464, in flight). The mongodb-prod binding applies to imboard app runs, not this repo; there is no deployed data pathway whose occurrence could be counted. The trigger (scheduler dispatching slot members) does not exist until #464 lands — building the dossier ahead of its dispatcher is the epic's planned order (RFC §I: item 11 slot-cycle after item 10 plan artifacts, both before item 14 first-batches pilot).

## Files to Modify
- `examples/git/slot-cycle.ds.md` — NEW: snapshot of the published `imboard-ai/git/slot-cycle@1.0.0` (this repo's only committed artifact; the dossier itself is published to the registry, never committed)
- `/tmp/opencode/slot-cycle/slot-cycle.ds.md` — NEW (scratch, not committed): the authored dossier, signed and published

## Reusable Code
- `examples/git/issue-cycle-classifier.ds.md` — structural template from the same epic (frontmatter shape, step layout, validation checklist, troubleshooting table, prerequisite version pins)
- review-issue@1.11.1 Agent 7 prompt (registry) — blind conformance contract to replicate verbatim (inputs, met/not-met/unverifiable verdicts, file:line requirement, report-only)
- implement-issue@1.7.2 (registry) — implement discipline: minimal-change rules, lint cascade (ci-parity → combined script → toolchain detect), scoped-test rules, 2-attempt cap
- `cli/src/runstate.ts` — PHASE_SPECS/KEY_VALUE_RULES: exact required keys for `plan`/`implement`/`review` done+blocked, `mode`/`batch` grammars, PATH_KEYS absolute-path rule
- `docs/reference/plan-artifact.md` — plan:v1 format, supersede semantics, validate checks/severities (artifact/sections/missing-file/head-distance/risk-floor)
- `docs/reference/capabilities.md` — `cap run` four-outcome semantics (ok/task-failed/automation-broken/capability-unavailable) and the reserved id vocabulary (`test.focused`, `lint.run`, `typecheck.run`)
- `imboard-ai/meta/publish-dossier` — sign → lint → verify → publish → refresh-machines recipe and its walls (shadow CLI copies, key choice)
- `scripts/test-examples.sh` — example snapshot validation (validate + checksum)

## Risk Areas
- Shadow CLI copies: global `ai-dossier` is 0.14.0 (no `plan` group); the repo-local `node_modules/.bin/ai-dossier` is 0.17.0. Sign/lint/verify/publish and all dry-run commands must use the correct binary by absolute path — a known wall (publish-dossier prerequisites; classifier troubleshooting row).
- Milestone vocabulary: `plan` done requires `planning` (absolute path) + `head` + `open_questions` + `visual_review`; `implement` done requires `head files tests_added tests_run ci_parity`; `review` done/partial requires `head fixed escalated agents_done agents_pending`. Blocked always adds `reason`. The dossier's commands must match `PHASE_SPECS` exactly or the CLI rejects them.
- The fetched plan artifact saved into the worktree must never enter the member commit (`.git/info/exclude` + commit only named changed files, never `git add -A` in a batch worktree).
- Lint rules that bite: no external URLs in the body (else external_references + content_scope + risk_factors ceremony); `risk_factors` strict enum; `protocol_version` required; delete checksum/signature before signing.
- Examples drift: the weekly refresh job re-pulls every snapshotted dossier — the new snapshot must be the exact published bytes so the first refresh after merge is a no-op.
- WIP-sync relaxation is a deliberate policy change (RFC C.4) — state it explicitly, do not silently drift from the full-cycle rule.

## Test Strategy
- `ai-dossier verify` on the signed dossier (integrity + authenticity) before publish and on the snapshot copy
- `scripts/test-examples.sh` — every example (including `slot-cycle.ds.md`) passes validate + checksum
- Scripted dry run against a scratch repo, documented in the PR body (classifier PR #482 precedent): precondition assertions pass/fail; `plan validate` → `{valid:true}` with a risk-floor info hit, and a missing-file error variant from a repo lacking the predicted path; `runstate post --dry-run` for all three milestones (done) and every blocked reason; `cap list`/`cap run test.focused` → capability-unavailable fallback; exactly-one-commit flow `<type>: <title> (#N)` pushed to a local bare remote
- Registry check after publish: `ai-dossier info imboard-ai/git/slot-cycle` shows 1.0.0

## Open Questions

## Visual Review
- [x] Not required (backend/infra only — registry dossier + docs snapshot)

## Base Branch
`main` — PRs for this issue target this branch.
