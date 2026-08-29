# Issue #470: dossier: review aggregate mode and ship batch mode (rebase-merge)

## Problem
RFC-0001 section C.5 (`rfcs/0001-batch-cycles.md`, branch `docs/batch-cycles-rfc`) defines the second tranche of Batch Cycles family changes. Batches amortize the expensive lifecycle (full suite, CI, PR, merge, deploy, teardown, review dimensions) across member issues, but two registry dossiers still lack their batch modes: review-issue (aggregate review over the combined diff) and ship-issue (batch PR, rebase-merge strategy). Batch PRs must be rebase-merged — squash would collapse the per-issue commits that eviction/bisect/traceability key on. The external prerequisite (repo settings + watcher rebase support) is tracked as imboard-ai/imboard-monorepo#3902 and is CLOSED (verified: watcher merges `batch-epic`-labeled PRs with `--rebase`; repo `allow_rebase_merge=true`); the dossier changes must document and assert that prerequisite, not assume it.

## Acceptance Criteria
- [ ] AC1 review-issue aggregate mode: input = combined batch diff + per-member AC verdicts (already produced per-issue by slot-cycle); skips Agent 7; tier = max member risk plus a combined-diff risk-floor scan; findings applied serially by the single writer as today; milestone carries `batch=<id>`
- [ ] AC2 ship-issue batch mode: PR body with per-member sections + `Closes #N` per member; rebase-merge strategy for batch PRs (asserts the repo allows it and the watcher supports it — hard abort with a clear reason if not); CI-trigger gate, phantom-green defense, deploy-confirm, and teardown semantics unchanged and applied to the batch PR/worktree
- [ ] AC3 Merge-commit ancestry/`MERGE_COMMIT` handling adjusted for rebase-merge (N commits land; deploy-confirm uses the branch head containment check)
- [ ] AC4 Both published with version bumps; `examples/git/` snapshot refreshed

## Approach
1. Export `imboard-ai/git/review-issue@1.11.1` and `imboard-ai/git/ship-issue@1.11.1` from the registry; edit the exported files (never clone/commit the registry files themselves), then publish with version bumps — the same export/pull + publish flow PR #485 used.
2. **review-issue 1.12.0 — aggregate mode** (`batch_id` input set → run against the batch ANCHOR issue): inputs add `batch_id`, `members` (comma list, default from scheduler), `member_verdicts` (per-member per-AC verdict lists from slot-cycles), `member_risks` (optional override; default = derive each member's `risk=` from its `phase=classify` comment, uncertainty → high). Combined diff = `git diff origin/<base>...HEAD` on the batch branch. Tier = combined-diff risk-floor scan (Stage 1 unchanged) then Stage 2 relevance, RAISED to max member risk (high→full, med→at least small, low→no raise). Agent 7 NEVER runs (conformance stays per-issue — the trust anchor). Findings deduped + applied serially by the single writer (unchanged); batch-level fix commit is ONE clean conventional commit without `[skip ci]` (rebase-merge replays it to main verbatim). Milestone: `phase=batch-review status=done` on the ANCHOR with `batch=`, `head=`, `fixed=`, `escalated=`, `tier=`, `agents_done=`, `agents_pending=none`, `members=`, `ac_met=`, `ac_total=` (CLI stamps `next=batch-ship`).
3. **ship-issue 1.12.0 — batch mode** (`batch_id` input set → batch PR from the batch branch): Step B0 asserts the rebase prerequisites — (a) `gh api repos/{owner}/{repo} --jq .allow_rebase_merge` is true; (b) the repo's auto-merge watcher supports batch-epic rebase (fetch `scripts/auto-merge-watcher.sh` from the target repo, grep for `batch-epic` + `--rebase`; absent/lacking → hard abort). Abort = `phase=batch-ship status=blocked reason=rebase-unsupported|rebase-not-allowed` + comment on the anchor naming imboard-monorepo#3902 and the exact remediation. PR body: Summary + one section per member (`#N — <one line from its boundary commit>` + its AC verdict checkboxes) + `Closes #N` per member; PR carries the `batch-epic` label (create if missing) — the watcher's rebase trigger. CI-trigger gate (Step 2.5), phantom-green defense (Step 4 two-consecutive-clean), deploy-confirm, teardown all unchanged and applied to the batch PR/batch worktree; teardown returns the batch worktree (pool or remove) and deletes the batch branch. Milestones on the ANCHOR: `phase=batch-ship status=awaiting-merge` (with `--next batch-ship`) then `phase=batch-ship status=done` with `batch=`, `pr=`, `merge_commit=`, `ci_fix_attempts=`, `deploy=`, `cleanup=`, `test_env=`, `members=`, `strategy=rebase`.
4. **AC3 rebase-merge MERGE_COMMIT semantics**: rebase-merge lands N commits (per-issue commits land individually, individually revertable); `MERGE_COMMIT` = the PR's `mergeCommit.oid` (the merge head on main — consistent with report-issue 1.7.1's "record the batch PR's merge head SHA"); deploy-confirm keeps the containment check `git merge-base --is-ancestor <MERGE_COMMIT> <deployed_sha>` — a linear rebase range means any deploy containing the merge head ships every member. Document that member commit SHAs differ post-rebase (replayed onto main) — traceability is the `(#N)` trailer, not the sha.
5. **Publish both** (`ai-dossier checksum --update` → `ai-dossier lint` → `ai-dossier verify` → `ai-dossier publish --changelog ... -y`), then refresh `examples/git/` via `node scripts/refresh-examples-snapshot.mjs` (pulls all current published versions — drifted family members ride along, the #485 pattern).

## Reachability Evidence
N/A — no new data-reachable product state; this change is dossier content (workflow prose). The invoking machinery exists and is verified live: slot-cycle@1.0.0 published (produces the per-member AC verdicts aggregate review consumes), CLI 0.14+ ships the `batch-review`/`batch-ship` phases + `batch=`/`mode=` keys (ai-dossier#461, CLOSED), watcher rebase support landed (imboard-monorepo#3902, CLOSED — verified `scripts/auto-merge-watcher.sh` rebase-merges `batch-epic` PRs and repo settings `allow_rebase_merge=true`), report-issue@1.7.1 + setup-issue-workflow@1.14.1 already speak the batch line.

## Files to Modify
- Registry `imboard-ai/git/review-issue` (export/publish, not committed) — aggregate mode, 1.11.1 → 1.12.0
- Registry `imboard-ai/git/ship-issue` (export/publish, not committed) — batch mode + rebase-merge, 1.11.1 → 1.12.0
- `examples/git/review-issue.ds.md`, `examples/git/ship-issue.ds.md` (+ any drifted family members the snapshot script pulls) — this repo's PR artifact

## Reusable Code
- `scripts/refresh-examples-snapshot.mjs` — snapshot refresh, re-run after publishing
- `ai-dossier checksum --update` / `lint` / `verify` / `publish --changelog` — the publish pipeline (key `imboard-ai` present at `~/.dossier/imboard-ai.pem`)
- Watcher contract: `batch-epic` label = rebase trigger (imboard-monorepo#3902); label description "Batch cycle PR — watcher rebase-merges (keeps one commit per member issue)"
- report-issue@1.7.1 batch variant — the naming/key conventions to stay consistent with (`batch=`, `pr=`, `merge_commit=`, `members=`, rebase-aware MERGE_COMMIT)

## Risk Areas
- **Rebase-merge lands branch commits verbatim on main**: batch-level commits must never carry `[skip ci]` (a marker landing as main's push head would suppress deploys/publishes — the exact #two-stalled-npm-releases failure). Aggregate review's fix commit is specified clean; ship's Step 2.5 gate stays as backstop; intermediate marker commits are cosmetic-only (GitHub evaluates the head commit), but the spec drives them to zero.
- **Publishing is live and versioned**: verify + lint BEFORE publish; a bad publish needs a patch bump to fix (issue-workflows-guide ended at 1.5.3 this way).
- **Snapshot refresh may pull drifted family members** (e.g. #469's batch-issues-preparation if published mid-run) — accepted, the #485 pattern; review the pulled diff before committing.
- **Anchor vs member milestones**: batch milestones go on the ANCHOR issue only; members' slot trails stay untouched (gate-issue 1.6.1 hard-blocks anchors from full-cycle — my milestones must not break that).
- **Member risk derivation** reads `phase=classify` comments that are buried under slot milestones after first dispatch — derive via full comment scan (`gh issue view --json comments` filter), not `runstate last`; unreadable risk → high (uncertainty raises the tier).

## Test Strategy
- `ai-dossier lint` clean + `ai-dossier verify` passes on both edited files before publish; re-verify the PUBLISHED versions after (byte-identical to snapshots).
- Milestone shapes validate against the CLI grammar: `batch-review done/blocked`, `batch-ship awaiting-merge/done/blocked` with the specified keys (run `cli`'s runstate tests: `npm test` in `cli/` or `make test` — the #461 suite already covers batch-phase grammar; no CLI code changes here).
- Ship batch-mode dry-run against a scratch repo with a fake watcher label flow (per the issue's test strategy): assert the three prerequisite-abort paths (rebase disallowed in settings, watcher missing rebase support, both) abort cleanly with `reason=`, and the happy path produces the per-member PR body + `batch-epic` label; document the dry-run in the PR body.

## Open Questions

## Visual Review
- [x] Not required (backend/infra only)

## Base Branch
`main` — PRs for this issue target this branch.
