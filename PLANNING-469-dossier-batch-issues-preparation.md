# Issue #469: dossier: batch-issues-preparation — classify, DAG, compose batches, enqueue

## Problem

RFC-0001 (branch `docs/batch-cycles-rfc`, §C.3/E) calls for the judgment-heavy front door of Batch Cycles: turn a raw issue list/range (potentially hundreds) into classified, dependency-ordered, batched queue entries for the deterministic scheduler. Today nothing produces queue entries — `ai-dossier sched enqueue` exists (#460, CLI 0.18.0) and consumes a `--from-manifest` JSON, the classifier exists (#465), plan artifacts exist (#462), slot-cycle exists (#466) — but no dossier wires them together. This issue delivers that dossier: `imboard-ai/git/batch-issues-preparation`, published to the registry (NOT committed to this repo), plus this repo's PR artifact: the `examples/git/` snapshot refresh.

## Acceptance Criteria

- [ ] AC1 Resolves list/range input; closed/missing issues reported as skipped (fleet-cycle Phase 1 semantics)
- [ ] AC2 Dependency DAG built with fleet-cycle Phase 2 rules verbatim (explicit signals authoritative; serialize-when-unsure); cycles surfaced and stop the run
- [ ] AC3 Runs issue-cycle-classifier (#465) per issue (parallel cheap dispatches); ensures every issue has a plan:v1 artifact (#462), creating a light one where missing
- [ ] AC4 Batch composition per RFC-0001 E.4: hard constraints (same base, external deps satisfied, ≤4 members initially, ≤1200 predicted diff lines, ≤1 eviction group, no two med+ risk members in the same area); ordering = dependency → ascending risk → issue number; batch-level DAG edges derived from member edges
- [ ] AC5 Creates one batch-epic-labeled anchor issue per batch with a task-list body of members; posts the wave/batch plan audit file under ~/.dossier/logs/ (fleet-cycle convention)
- [ ] AC6 Emits the enqueue manifest (documented schema) and invokes `sched enqueue --from-manifest`
- [ ] AC7 `examples/git/` snapshot refreshed; `batch-epic` label created idempotently

## Approach

1. Author the new dossier `batch-issues-preparation` v1.0.0 (Draft, risk medium) — objective per RFC §C.3: resolve the set → build the DAG → classify per issue → ensure plan:v1 artifacts → compose batches per E.4 → create `batch-epic` anchors → write the audit file → emit the manifest + `sched enqueue --from-manifest`. Non-responsibilities: execution/supervision (scheduler's), deep planning (slot/full cycle's); never dispatches cycles, never creates worktrees/branches/PRs.
2. Phase 1/2 semantics copied verbatim from fleet-cycle@1.7.0 (examples/git/fleet-cycle.ds.md:134-154): list/range/mixed parse + dedupe + sort, drop closed/missing with skipped report; explicit dep signals (depends on/blocked by/after, epic links, declared base_branch) authoritative, inferred signals (file-overlap collision, logical ordering, shared migration/config) by judgment, serialize-when-unsure; cycles surfaced → STOP the run. One addition over fleet: issues with an active runstate trail (latest milestone is a cycle phase, or `in-progress` label) are skipped as `in-flight` — a classify record landing on an active run's trail breaks its resume (gate-issue fresh-entry rule). Discovered during planning: #470 is in-progress right now and must never be classified by a prep run.
3. Classification step: dispatch `imboard-ai/git/issue-cycle-classifier` per remaining issue as parallel cheap-tier subagents (fleet 1b model routing); reuse an issue's existing classify record when it is the issue's LATEST milestone; collect verdict fields (mode/risk/est_files/est_diff/areas/test_scope/deps/confidence) via `ai-dossier runstate last --issue <n> --json`.
4. Plan artifacts: `ai-dossier plan get --issue <n>` (exit 1 = missing) → author a light plan (Problem 1-2 sentences from the issue body, Acceptance Criteria verbatim, Predicted Files best-effort from issue text + classifier inspection, Approach 2-4 bullets, Test Scope from the classify record) and post via `ai-dossier plan post`. Full-dossier validate-then-refine stays plan-issue/slot-cycle's job (#477).
5. Batch composition per E.4, deterministic greedy: order slot issues topologically → ascending risk → issue number; fill batches (hard: same base_branch, all external deps in earlier batches or merged, members ≤ 4, Σ est_diff ≤ 1200, ≤ 1 eviction group — overlapping predicted paths form the group, no two med+ risk members sharing an area); prefer file-disjoint members; member order = dependency → ascending risk → issue number; batch-level DAG edge wherever a member edge crosses batches. Batch ids `b-<YYYYMMDD>-<NN>` (full-cycle-issue v3.14.1's slug example), NN bumped against `sched status --json` and open batch-epic anchors. Full-mode issues → manifest entries mode=full (never batched). Issues with an OPEN dep outside the set → classified but NOT enqueued (`deferred-external-dep`) — enqueue.ts leaves out-of-graph deps permanently unsatisfied, so enqueueing them would strand them blocked forever.
6. Anchors + audit: `gh label create batch-epic --force` (idempotent); one anchor per batch titled `Batch <id>: issues #a, #b, …` with a task-list body of members (order, per-member risk/est, eviction group, batch deps, audit-file pointer); audit file `~/.dossier/logs/batch-prep/{project}/BATCH-PLAN-<ts>.md` → gzip → `.md.gz`, retention 20, project slug per fleet convention.
7. Manifest + enqueue: document the schema in the dossier body (envelope `{project, entries[]}`, entry = issue/mode/batch/deps/tier/base_branch — exactly what `parseManifest` (packages/sched/src/enqueue.ts:42) accepts; slot requires batch, full forbids batch); write `~/.dossier/logs/batch-prep/{project}/manifest-<ts>.json`; skip already-queued issues (checked via `sched status --json` — enqueue rejects duplicate active issues); invoke `ai-dossier sched enqueue --from-manifest <path>` from the target repo; verify with `sched status`. `dry_run=true` does everything (classify records, plan artifacts, anchors — the shadow-mode deliverable, RFC §G Step 2) EXCEPT the enqueue, so the manifest and anchors exist as linkable evidence with zero scheduler execution.
8. Publish per `imboard-ai/meta/publish-dossier`: sign with `~/.dossier/imboard-ai.pem` (key id imboard-ai — present on this machine), lint clean, verify passed, `ai-dossier publish --namespace imboard-ai/git`; refresh machines (wls local + ssh hcc/occ pulls). PR artifact: `examples/git/batch-issues-preparation.ds.md` (copy of the published file) + `examples/README.md` family enumeration.

## Reachability Evidence

- State: scheduler-consumable manifest | Trigger: `sched enqueue --from-manifest <path>` | Prod check: consumer code exists and is tested on main — `parseManifest` (packages/sched/src/enqueue.ts:42-91) accepts the `{project, entries}` shape; CLI 0.18.0 `sched enqueue --help` exposes `--from-manifest`; sched test suite covers manifest parsing | Verdict: reachable
- State: classify records consumed downstream | Trigger: slot-cycle Step 0.6 reads `runstate last` for `mode=slot` | Prod check: slot-cycle@1.0.0 (examples/git/slot-cycle.ds.md:115) + gate-issue@1.6.1 classify-record handling both shipped | Verdict: reachable
- N/A for product data — this repo is a CLI tool with no production database; the "reachability" question for a workflow dossier is whether the consumer exists, answered above.

## Files to Modify

- `examples/git/batch-issues-preparation.ds.md` — NEW: snapshot of the published dossier (the PR artifact, per #482/#484 convention)
- `examples/README.md` — add `batch-issues-preparation` to the `git/` family enumeration
- Registry (not repo): `imboard-ai/git/batch-issues-preparation` v1.0.0 published pre-merge

## Reusable Code

- `examples/git/fleet-cycle.ds.md:134-169` — Phase 1 set resolution + Phase 2 DAG rules + FLEET-PLAN audit-file convention (gzip, retention 20, project slug) to mirror
- `examples/git/issue-cycle-classifier.ds.md` — the per-issue dispatch target; its dry_run semantics, label idempotence pattern, runstate classify keys
- `packages/sched/src/enqueue.ts:parseManifest()` — the exact manifest schema to document (the consumer's contract)
- `imboard-ai/meta/publish-dossier` — sign/lint/verify/publish/refresh recipe
- `scripts/test-examples.sh` — snapshot validation (validate + checksum) for AC7

## Risk Areas

- Classify-record pollution of active runs — mitigated by the in-flight skip (Approach bullet 2); #470 is in-progress in this repo right now
- Anchor/batch-id collisions across prep runs — mitigated by `sched status --json` + open-anchor check before assigning `b-<date>-<NN>`
- Enqueue rejections (duplicate active issues, batch not forming) — pre-checked in Step 8; failures reported, run continues for unaffected entries... actually: `sched enqueue` is atomic (throws → nothing saved); on EnqueueError the run reports the manifest path and stops before enqueue, handing the file to the operator
- Dry-run on real issues creates visible state (classify records, plan artifacts, anchors on 8 issues) — intended (shadow-mode deliverable, RFC §G Step 2); anchors carry a `dry-run, not enqueued` note and can be closed
- lint walls: external URLs need external_references + content_scope + network_access risk factor; shell snippets expanding `$(…)` need unquoted heredocs (publish-dossier Step 2)

## Test Strategy

- `ai-dossier lint` + `ai-dossier verify` on the authored dossier (pre-publish), `ai-dossier info imboard-ai/git/batch-issues-preparation` shows 1.0.0 (post-publish)
- `bash scripts/test-examples.sh` — validate + checksum over all snapshots incl. the new one
- `npm run test:scripts` — 65 script tests stay green
- Dry-run on ≥8 real open issues of this repo (`26,28,49,430,468,471,472,473` — none has an active runstate trail or in-progress label): real classify records + light plan artifacts + batch-epic anchors + manifest produced; NO enqueue. Manifest + anchor links quoted/linked in the PR description (the issue's test strategy)

## Open Questions

(none)

## Visual Review

- [x] Not required (dossier authoring + examples snapshot; no FE)

## Base Branch

`main` — PRs for this issue target this branch.
