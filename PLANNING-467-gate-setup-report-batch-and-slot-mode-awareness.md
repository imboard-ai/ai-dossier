# Issue #467: dossier: gate/setup/report batch and slot-mode awareness

## Problem

RFC-0001 (Batch Cycles, `rfcs/0001-batch-cycles.md` on `docs/batch-cycles-rfc`) redesigns multi-issue execution around a deterministic scheduler + batched slot execution. Section C.5 mandates batch/slot awareness in the existing issue-workflow family. The CLI vocabulary landed first (#461, merged: `phase=classify`, `batch-*` phases, `mode=`/`batch=` milestone keys, `slot_trail` in `runstate verify`), but the three dossiers that consume it — gate-issue, setup-issue-workflow, report-issue — still describe only the single-issue trail. Without them: an evicted slot member's resume maps into a nonexistent batch, batch branches get per-issue names, and batches get no report. (Review/ship batch modes are the second tranche — issue #470, non-goal here.)

## Acceptance Criteria

- [ ] AC1 gate-issue: an issue carrying `mode=slot` milestones from an evicted batch run enters full-cycle FRESH (no resume into a nonexistent batch) with a context pointer to the prior trail; existing resume behavior regression-checked against the documented decision table
- [ ] AC2 setup-issue-workflow: batch mode — branch `batch/<id>-<date>` from base, pool claim or cold path unchanged, no per-issue planning scaffold, milestone carries `batch=<id>`
- [ ] AC3 report-issue: batch variant — one batch report on the anchor + one short completion comment per member issue (traceability), `Shipped` line covers the batch deploy; honesty-gate semantics (`MERGE_COMMIT`/`DEPLOYED`) unchanged
- [ ] AC4 All three published with version bumps; `examples/git/` snapshot refreshed

## Approach

1. **gate-issue 1.5.2 → 1.6.0** — Step 1.5 gains a "fresh-entry trails" subsection + decision-table rows: `classify` record → FRESH; last milestone carrying `mode=slot`/`batch=<id>` (incl. `status=blocked`) → FRESH with `slot_trail=true` (the posting state machine isn't the one resuming; slot trails have no full-cycle phases to resume into — batch worktree is machine-local, evicted members requeue from scratch); last milestone a `batch-*` phase → batch ANCHOR → hard block `reason=batch-anchor` (also add the `batch-epic` label to the hard-block label list). On slot_trail: keep the Step 1b minted `run_id` (do NOT reuse `.run` — it is the slot run's), and the gate milestone carries the context pointer: `slot_trail=true`, `prior_run=<slot run id>`, `batch=<id>` (when the trail carries one). Plan phase pointed at the prior trail (plan artifact + failure evidence per RFC-0001 F.2 requeue-with-context).
2. **setup-issue-workflow 1.13.1 → 1.14.0** — new optional input `batch_id` activates batch mode (runs ONCE per batch, against the ANCHOR issue): branch `batch/<batch_id>-<YYYYMMDD>` from base (no type prefix / issue number / title slug); worktree dir `worktrees/batch-<batch_id>-<date>`; pool claim or cold path + warmup unchanged; Step 9 planning scaffold skipped (plan artifacts live on member issues as `plan:v1` comments); Step 11 posts `phase=batch-setup status=done` on the anchor with `batch=<id>` + the usual branch/worktree/pool_claimed/base_branch/remote keys.
3. **report-issue 1.6.1 → 1.7.0** — new optional inputs `batch_id` + `members` activate the batch variant: ONE batch report (conversation + PR comment) with per-issue what-changed lines, aggregate implications over the combined diff, `Shipped` line covering the BATCH deploy, and unchanged honesty gates (`MERGE_COMMIT` empty = failed run; rebase-merge note: per-issue commits land individually — record the batch PR's merge head); ONE SHORT completion comment per member issue (traceability, carrying merge-commit + deployed state compactly); milestone posts `phase=batch-report status=done` on the anchor with `batch=`, `pr=`, `merge_commit=`, `deployed=`, `members=`, `traps_added=`. Traps trigger degrades gracefully (reads whichever ship-like milestone exists — ship batch mode is tranche 2).
4. **Publish + snapshot** — per `imboard-ai/meta/publish-dossier`: edit working copies in the worktree root (git-excluded; dossiers are never committed), sign → lint → verify → publish all three in one coordinated pass (`--namespace imboard-ai/git`, minor bumps, one-line changelogs), then `node scripts/refresh-examples-snapshot.mjs` and include the refreshed `examples/git/` in the PR. **Known blocker**: `~/.dossier/imboard-ai.pem` (team signing key) is absent on wls and siblings are unreachable; login IS working (human restored it 16:39 today after #477's handoff). If the key is still missing at publish time: complete + push all edits, then hand off `decision-pending` with the exact sign/publish commands (same shape as #477) — do NOT sign with another key and do NOT publish unsigned (all 12 family dossiers are signed; the recipe forbids other keys).

## Reachability Evidence

- State: slot-mode member trail (evicted → requeued full) | Trigger: slot-cycle milestones (`mode=slot batch=<id>`) + scheduler eviction/requeue (RFC-0001 D.1/F.2) | Prod check: N/A — registry-content infrastructure, not a data-reachable product state; evidence is sibling-component reality: #461's vocabulary is MERGED on main (verified: `cli/src/runstate.ts` `freshEntry()`/`slot_trail`, batch phases, `KEY_VALUE_RULES`; 9-test `#461` suite in `cli/src/__tests__/runstate.test.ts`), scheduler requeue exists on #464's branch (`packages/sched/src/scheduler.ts` `abandonBatch`), slot-cycle dossier #466 in flight. The RFC epic (#474) is the reviewed plan that mandates these states. | Verdict: reachable-by-construction (coordinated epic tranche; the consumer vocabulary these dossiers read is already live in the CLI this repo ships)
- State: batch anchor + batch-setup/report milestones | Trigger: scheduler + setup batch mode + report batch variant (this issue IS the producer) | Prod check: N/A — the `batch-*` phase line this issue's dossiers write is the same line #461 already shipped in the CLI | Verdict: same as above

## Files to Modify

- `gate-issue.ds.md` (worktree root, git-excluded) — registry edit per AC1, publish as imboard-ai/git/gate-issue@1.6.0
- `setup-issue-workflow.ds.md` (worktree root, git-excluded) — registry edit per AC2, publish as imboard-ai/git/setup-issue-workflow@1.14.0
- `report-issue.ds.md` (worktree root, git-excluded) — registry edit per AC3, publish as imboard-ai/git/report-issue@1.7.0
- `examples/git/gate-issue.ds.md`, `examples/git/setup-issue-workflow.ds.md`, `examples/git/report-issue.ds.md` (+ any other drifted snapshots the refresh script picks up) — via `scripts/refresh-examples-snapshot.mjs` AFTER publish

## Reusable Code

- `imboard-ai/meta/publish-dossier@1.0.0` — the exact pull → edit → sign → lint → verify → publish → refresh-machines recipe and its known walls
- `scripts/refresh-examples-snapshot.mjs` — snapshot refresh (pulls every published dossier snapshotted in examples/git; aborts rather than silently skipping)
- `cli/src/runstate.ts` `computeResume`/`freshEntry` — the behavior the gate-issue decision table documents; `cli/src/__tests__/runstate.test.ts` (`#461` describe blocks) is its regression harness
- `ai-dossier runstate post --phase batch-setup|batch-report` — CLI already accepts the batch line (no phase-specific required keys; the dossier prose owns what its milestones carry)

## Risk Areas

- **Signing key blocker** (see Approach item 4): `~/.dossier/imboard-ai.pem` missing on wls; AWS role here is read-only (no KMS); no SSH identity to hcc/occ. Contingency: hand off at publish with decision-pending (precedent: #477 blocked `publish-credentials` today; its login half is now fixed). Never sign with another key; never publish unsigned.
- **Interlock with in-flight tranches**: slot-cycle (#466) and scheduler (#464) are unmerged; their exact milestone phrasing could drift. Mitigation: these dossiers consume only what #461 already froze in the CLI (mode/batch keys, slot_trail, batch phases) and cite RFC-0001 sections, not sibling dossier text.
- **rebase-merge honesty gates**: report-issue batch variant must not assume squash-merge semantics (per-issue commits land individually); keep `MERGE_COMMIT` required and record the batch PR merge head.
- **Dossier lint walls**: external URLs need frontmatter declarations (avoid adding URLs); `risk_factors` is a strict enum; delete `checksum`+`signature` objects before re-signing; unquoted heredocs for `$(date …)` expansion.
- **Coordinated publish**: all three must publish in one pass (protocol never half-present per publish-dossier Step 6).

## Test Strategy

- `make test` (full suite; must stay green) + focused `npx vitest run cli/src/__tests__/runstate.test.ts` — the #461 suite is AC1's regression check: verify's decision table in the edited gate-issue must mirror `computeResume`/`freshEntry` behavior (classify/slot/batch-anchor verdicts, blocked-slot precedence, loop-cap precedence)
- `ai-dossier lint` per edited dossier — must print no issues
- `ai-dossier verify` per signed dossier — must pass (requires the team key; blocked without it)
- Structural self-check: every `--kv` key named in the edited dossiers passes `runstate post` grammar (lower_snake_case, no spaces, batch id slug regex)
- Dry-run the milestone shapes against the CLI's batch-phase specs (`batch-setup`: done/blocked; `batch-report`: done only)

## Open Questions

- Team signing key availability on wls (blocked publish; contingency defined in Risk Areas — hand off, do not work around)

## Visual Review

- [x] Not required (backend/infra only — registry dossier content + snapshot refresh)

## Base Branch

`main` — PRs for this issue target this branch.
