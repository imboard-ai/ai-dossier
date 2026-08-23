---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "full-cycle-issue",
  "title": "Full Cycle Issue Workflow",
  "version": "3.8.0",
  "protocol_version": "1.0",
  "status": "Draft",
  "last_updated": "2026-08-23",
  "objective": "Take a GitHub issue from start to merged PR autonomously — composed from shared sub-dossiers: gate, setup, plan, implement, review, ship, and report",
  "category": [
    "development"
  ],
  "tags": [
    "github",
    "issues",
    "workflow",
    "autonomous",
    "full-cycle",
    "pr",
    "merge"
  ],
  "risk_level": "high",
  "risk_factors": [
    "modifies_files",
    "network_access",
    "creates_pull_request",
    "merges_code"
  ],
  "requires_approval": false,
  "destructive_operations": [
    "Creates new git branch",
    "Creates new git worktree",
    "Pushes branch to remote",
    "Creates pull request and applies the `auto-merge` label (a server-side watcher performs the merge — see Phase 5)",
    "Deletes branch after merge (performed by the auto-merge watcher)"
  ],
  "inputs": {
    "optional": [
      {
        "name": "warmup_dossier",
        "description": "Which warm-worktree dossier to use for worktree warmup. Passed through to setup-issue-workflow. Override for project-specific warmup (e.g., imboard-ai/imboard/warm-worktree-pnpm-ssm for pnpm+SSM).",
        "type": "string",
        "default": "imboard-ai/git/warm-worktree"
      },
      {
        "name": "base_branch",
        "description": "Target branch to branch from and merge into. Overrides issue body parsing. Use for epic sub-issues.",
        "type": "string",
        "default": "auto"
      }
    ]
  },
  "authors": [
    {
      "name": "Yuval Dimnik"
    }
  ],
  "external_references": [
    {
      "url": "https://cli.github.com/",
      "description": "GitHub CLI documentation",
      "type": "documentation",
      "trust_level": "trusted",
      "required": false
    }
  ],
  "content_scope": "references-external",
  "checksum": {
    "algorithm": "sha256",
    "hash": "12c5e97cbf8e22282e2911e1fc257b4b546f9692c0b6930a08cf75d1420cc4b3"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "T1hk8Sc1P6Jw4S2tzZkAWQi9EOqmMi/WeyK+MVuNTJkLoexcts0BfVltpxOjakjZlgPSqCeroYQmzveSuVaFAg==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-08-23T14:03:50.120Z",
    "covers": "frontmatter+body",
    "key_id": "imboard-ai",
    "signed_by": "Yuval Dimnik <yuval.dimnik@gmail.com>"
  }
}
---

# Full Cycle Issue Workflow

## Objective

Take a GitHub issue from start to merged PR autonomously. For small-to-medium issues where requirements are clear. Composed from shared sub-dossiers — each sub-dossier is independently versioned and reusable.

## Guiding Principle

**Do not ask the user interactively, at any phase.** This workflow runs unattended —
there may be no one present to answer. If the run cannot complete autonomously, STOP
and hand the decision back through the issue itself; never wait on a reply in this
conversation.

Stop and hand off when:
- The issue description is too vague to implement
- A business/product/design decision is genuinely ambiguous — including anything the
  review phase escalates (Phase 4) or a CI/merge blocker that needs judgment (Phase 5)
- Tests fail after 2 fix attempts with unclear path forward
- Merge conflicts require human judgment

**How to hand off** (the same procedure every time, regardless of which phase triggers it):
1. Push whatever work exists so nothing is lost; note the branch name in the comment (Step 2 below).
2. `gh label create decision-pending --color "5319E7" --description "Blocked on a human decision" --force`
   then `gh issue edit <number> --add-label "decision-pending" --remove-label "in-progress"`.
3. Post ONE comment on the ORIGINAL issue — never a new issue — stating exactly what
   decision is needed: file/line references, the options, and enough context that a
   human (or a future run) can act on it without re-deriving your reasoning.
4. End the run. Do NOT open a PR if one doesn't exist yet, and do NOT proceed to Ship or Report.

**Never open a new GitHub issue as a substitute for this.** One issue in, at most that
same issue updated — with the decision recorded in its comments — never fanned out
into follow-up issues.

Do NOT ask about (just proceed): file names, branch names, commit messages, PR
descriptions, whether to proceed, or any other mechanical decision.

## Runstate Milestones

Every phase ends by appending ONE comment to the GitHub issue. This is the only run state that survives the session — a nested or fleet-dispatched run must post them too.

```bash
gh issue comment <issue_number> --body "$(cat <<EOF
<!-- runstate:v1 -->
phase=<phase> status=<done|partial|blocked|awaiting-merge> run=<run_id> at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
<phase-specific key=value lines, one per line>
next=<next phase name or "done">
EOF
)"
```

Rules:

- `run_id` is minted ONCE by gate-issue (`r-<issue_number>-$(openssl rand -hex 2)`) and passed to every later sub-dossier exactly like `base_branch`.
- `at` is filled in by the template (the heredoc is unquoted so `$(date …)` expands); put no other `$` in values.
- Append-only. Readers take the LAST `<!-- runstate:v1 -->` comment. Never edit or delete a prior milestone.
- Values contain no spaces (use `-` or `,`); paths are absolute.
- Posting the milestone is the last step of the phase. If a phase aborts, post `status=blocked` with `reason=<short-slug>` before stopping.

Per-phase keys:

| phase | status | keys |
|---|---|---|
| gate | done / blocked | `base_branch=` `warnings=<n>` (blocked: `reason=closed\|decomposed\|needs-clarification\|epic\|open-dependency-<N>`) |
| setup | done / blocked | `branch=` `worktree=<abs path>` `pool_claimed=true\|false` `base_branch=` |
| plan | done / blocked | `planning=<abs path>` `head=<short sha of base at plan time>` `open_questions=<n>` `visual_review=true\|false` |
| implement | done / blocked | `head=<short sha>` `files=<n>` `tests_added=<n>` `tests_run=<n>` `ci_parity=pass\|fail-then-fixed\|skipped` |
| review | done / partial / blocked | `head=` `fixed=<n>` `escalated=<n>` `agents_done=<comma list>` `agents_pending=<comma list or none>` |
| ship (1st, BEFORE the CI/merge wait) | awaiting-merge | `pr=<n>` `head=<pushed sha>` `ci_fix_attempts=0` |
| ship (2nd, after merge + teardown) | done / blocked | `pr=` `merge_commit=` `ci_fix_attempts=<n>` `cleanup=pool_returned\|worktree_removed\|skipped` |
| report | done | `pr=` `traps_added=<n>` |

`next=` is the following phase: gate → setup → plan → implement → review → ship → report → done.

**Milestone gate (orchestrator duty).** Before starting each phase, confirm the previous phase's milestone exists — sub-dossiers sometimes skip it when run inline:

```bash
gh issue view <issue_number> --json comments \
  --jq '[.comments[].body | select(startswith("<!-- runstate:v1 -->"))] | last'
```

If the last milestone is not `phase=<phase that just finished>`, post it yourself from the outputs you have before continuing. A run with missing milestones cannot be resumed.

## Resuming

Phase order: gate → setup → plan → implement → review → ship → report.

Skip every phase that precedes `resume_from`. When skipping setup, take `branch`, `worktree`, `pool_claimed`, `base_branch` from `resume_context` and `cd` into the worktree (hard gate `pwd | grep -q worktree` still applies). When skipping plan, take `planning` from `resume_context`. Review with `agents_pending` → run only those agents. `ship-wait` → enter ship at Step 5 (CI wait) with `pr` from context; `ship-teardown` → enter ship at Step 7 post-merge cleanup.

## Prerequisites

- [ ] Git is installed and configured
- [ ] GitHub CLI (gh) is installed and authenticated
- [ ] You are in a git repository with GitHub as a remote
- [ ] You have push access

## Sub-Dossiers Used

This workflow composes the following sub-dossiers in sequence:

| Phase | Sub-Dossier | Purpose |
|-------|-------------|---------|
| 0 | `imboard-ai/git/gate-issue` | Safety check — hard blocks and soft warnings |
| 1 | `imboard-ai/git/setup-issue-workflow` | Branch + worktree + warmup + claim issue |
| 2 | `imboard-ai/git/plan-issue` | Read issue + explore code + write planning doc |
| 3 | `imboard-ai/git/implement-issue` | Implement + test + lint |
| 4 | `imboard-ai/git/review-issue` | 6 parallel review agents + fix findings |
| 5 | `imboard-ai/git/ship-issue` | Commit + push + PR + apply `auto-merge` label + confirm merge + teardown |
| 6 | `imboard-ai/git/report-issue` | Rich completion report |

## Actions to Perform

### Phase 0: Gate

Always runs — this phase determines `resume_from` in the first place, so there is nothing to skip it against.

1. Extract the issue number from user input
2. Run: `ai-dossier run imboard-ai/git/gate-issue`
3. Provide the issue number
4. If the gate fails, stop — do NOT proceed
5. Note the `base_branch` from the gate output
6. If a `base_branch` parameter was provided in context (and is not `"auto"`), use that instead
7. Note `run_id` from the gate output; pass it to every subsequent sub-dossier
8. Note `resume_from`, `run_id`, and `resume_context` from the gate output — see "## Resuming" above for how each later phase uses them

### Phase 1: Setup

**Skip if `resume_from` is later than this phase.**

1. **Pre-flight: clean stale worktrees.** Previous runs may have left zombie worktrees:
   ```bash
   git worktree list
   ```
   For each stale worktree (checking out `main` but is not repo root, or branch was merged/deleted): remove with `git worktree remove <path> --force` and `git worktree prune`.

2. **Claim the issue** — make it visible that work is in progress:
   ```bash
   gh label create "in-progress" --color "FBCA04" --description "Actively being worked on" --force
   gh issue edit <number> --add-label "in-progress" --add-assignee "@me"
   gh issue comment <number> --body "**Agent pickup** — work started (full-cycle-issue v3.0)"
   ```

3. **Record the original working directory** — you will return here after merge

4. Run: `ai-dossier run imboard-ai/git/setup-issue-workflow`
   - Pass through `warmup_dossier`, `base_branch`, and `run_id` parameters
   - When asked where to work, always choose option 1 (new git worktree)

5. Note the worktree path and branch name
6. Note whether the worktree was claimed from the pool
7. `cd` into the worktree directory

8. **Verify you are in a worktree** — hard gate:
   ```bash
   pwd | grep -q "worktree" && echo "OK: in worktree" || echo "FAIL: not in worktree"
   ```
   If FAIL: abort, comment on issue, remove in-progress label. Do NOT work in current directory.

9. Update the issue comment with the branch name

### Phase 2: Plan

**Skip if `resume_from` is later than this phase.**

1. Run: `ai-dossier run imboard-ai/git/plan-issue`
2. Pass through the issue number, base_branch, worktree path, and `run_id`. Also pass `prod_data_access` = "Use the `mongodb-prod` MCP (read-only `count`/`find`/`aggregate`) against the production cluster to confirm a new state/flow actually occurs before building it; 0 occurrences ⇒ don't build, escalate (retro #1632)" — this drives plan-issue's reachability check.
3. **In full-cycle mode: proceed immediately.** Do not checkpoint with the user. If the issue is genuinely ambiguous, apply the Guiding Principle hand-off (stop, don't ask) rather than guessing. **Exception path is the same, not different:** if the reachability check escalated (a new state shows 0 prod occurrences), that is also a hand-off case — stop and record the decision needed before building; do not build an unreachable state.

### Phase 3: Implement

**Skip if `resume_from` is later than this phase.**

1. Run: `ai-dossier run imboard-ai/git/implement-issue`
2. Pass through the planning file path, base_branch, and `run_id`

### Phase 4: Review

**Skip if `resume_from` is later than this phase.**

1. Run: `ai-dossier run imboard-ai/git/review-issue`
2. Pass through the issue number and `run_id`
3. Collect the review results: `review_fixed`, `review_escalated`, `review_clean`, `ac_results` (the per-acceptance-criterion checklist — pass it through to Ship for the PR body)
4. **If `review_escalated` is non-empty: apply the Guiding Principle hand-off and STOP —
   do not proceed to Phase 5.** review-issue already restricts escalation to findings
   that genuinely need a product/business decision (typically 0, rarely more than 2), so
   reaching this step means a real decision is needed, not a fan-out of side issues. The
   comment posted to the issue should list each escalated finding (file/lines,
   description, why it needs a human call), grouped by review category if there is more
   than one.

### Phase 5: Ship

**Skip if `resume_from` is later than this phase.** `resume_from=ship-wait` enters at
Step 5 (CI wait) with `pr` from `resume_context`; `resume_from=ship-teardown` enters at
Step 7 (post-merge cleanup).

**Only reached when `review_escalated` was empty at the end of Phase 4** — ship-issue's
own prerequisites assume this and do not create GitHub issues for anything.

1. Run: `ai-dossier run imboard-ai/git/ship-issue`
2. Pass through: issue number, base_branch, worktree_path, original_dir, pool_claimed, `run_id`, `ac_results` (from Phase 4 — used to build the PR body's Acceptance Criteria section)
3. **Opening a PR is NOT completion, and neither is merging it. You are done
   when the merge has REACHED PRODUCTION** (or you have a hard blocker you
   escalated). A PR left green-but-unmerged is a FAILED run; a PR merged but
   never deployed is code live to nobody — see ship-issue Step 6c.
4. **The two ship runstate milestones still get posted** even on the watcher path:
   `status=awaiting-merge` right after the PR is opened (ship-issue Step 3b), and the
   final `status=done` once the merge is confirmed and teardown is complete
   (ship-issue Step 8). If the watcher blocks or the PR is still unmerged at hand-off,
   the final one is `status=blocked` with a `reason=`.
5. **Hand off the merge to the auto-merge watcher — do NOT babysit CI and do
   NOT merge the PR yourself.** The repo runs an `auto-merge-watcher` GitHub
   Action (every 5 min) that squash-merges green, clean PRs server-side and
   deletes the branch. Your terminal action for the merge is:
   1. Open the PR (ship-issue does the commit + push + `gh pr create`).
   2. Apply the `auto-merge` label: `gh pr edit <pr_number> --add-label "auto-merge"`
      (create it first if missing: `gh label create auto-merge --color 0E8A16 --force`).
   3. **Confirm the label is applied** — re-read the PR labels and verify
      `auto-merge` is present. If the apply failed, retry once; if it still
      fails, that is a hard blocker to escalate (do NOT fall back to
      self-merging / CI polling).
   4. Exit the polling loop. Do NOT re-run `gh pr checks` / `statusCheckRollup`
      in a loop, do NOT `gh pr merge` yourself, do NOT background a CI monitor.
6. **Confirm the merge before reporting done** (passive, not CI babysitting):
   poll `gh pr view <pr_number> --json mergedAt` at a coarse interval (every
   ~3–5 min, up to ~25 min) until `mergedAt` is non-null. This is confirming
   the watcher did its job, NOT polling CI statuses. ship-issue Step 6b
   (`mergedAt` non-null) must pass before this phase is considered complete.
   Then ship-issue Step 6c must ALSO pass: confirm a successful deploy carries
   `MERGE_COMMIT`, dispatching the deploy yourself if nothing does. On repos
   where a bot token performs the merge, GitHub does not fire `on: push`, so the
   deploy NEVER runs by itself — merged code then sits until an unrelated human
   push carries it out. Do not confuse "merged" with "shipped".
7. **If the watcher blocks the merge** — the watcher leaves an
   `auto-merge-blocked` label + a comment with the reason (failing checks,
   conflict, branch-update failure) and removes `auto-merge` — **or the PR is
   still unmerged after ~25 min**: apply the Guiding Principle hand-off (the PR
   already exists, so skip the "push work" step — just label and comment). Do
   NOT silently exit on an unmerged PR. Capture the blocker in the report with
   `MERGE_COMMIT` empty.

### Phase 6: Report

**Skip if `resume_from` is later than this phase** (i.e. `resume_from=done` — see the
Runstate Milestones table's `report done` row).

**Only reached on a real completion** — if Phase 4 or Phase 5 stopped via the Guiding
Principle hand-off, the run already ended there; do not run this phase.

1. Run: `ai-dossier run imboard-ai/git/report-issue`
2. Pass through: issue number, pr_number, base_branch, review_fixed, review_clean, cleanup_method, `run_id`
3. **The structured report MUST include a `MERGE_COMMIT` field** set to the
   squash-merge commit SHA (`gh pr view <pr_number> --json mergeCommit --jq '.mergeCommit.oid'`).
   An empty / `N/A` / missing `MERGE_COMMIT` is a **FAILURE**, not a success —
   it means the PR was not merged. If you are reporting with `MERGE_COMMIT`
   empty, you must also be reporting a hard blocker you escalated (Phase 5.7);
   a clean exit with an unmerged PR is a failed run.
4. **The report MUST also carry `DEPLOYED`** (report-issue's `Shipped` line):
   the deployed SHA + run URL, `N/A — <reason>` when the project genuinely has
   no deploy step, or an explicit `NOT DEPLOYED` warning naming what a human must
   run. `MERGE_COMMIT` present + `DEPLOYED` absent is the failure this field
   exists to catch: it reads as a clean run while the change is live to nobody.

## Validation

- [ ] Phase 0 gate passed (no hard blocks)
- [ ] Issue claimed with in-progress label
- [ ] Branch and worktree created (via pool claim or cold creation)
- [ ] Verified in worktree before proceeding
- [ ] Planning doc created
- [ ] Implementation addresses requirements
- [ ] Tests exist and all pass
- [ ] 6 parallel reviews completed
- [ ] Review fixes applied in-place
- [ ] Tests re-run after review fixes
- [ ] Committed with conventional commit message
- [ ] PR created targeting correct base_branch
- [ ] Zero escalated findings reached Ship — any escalation stopped the run at Phase 4 with a decision-pending hand-off on the issue (see Guiding Principle), not a new GH issue
- [ ] `auto-merge` label applied to PR and confirmed present
- [ ] PR merged by the watcher — `MERGE_COMMIT` captured (merge confirmed via `mergedAt` non-null, ship-issue Step 6b). Empty `MERGE_COMMIT` = FAILED run (unless a hard blocker was escalated)
- [ ] Merge REACHED PRODUCTION — a successful deploy carries `MERGE_COMMIT`, and `DEPLOYED` is in the report (ship-issue Step 6c). Merged ≠ shipped; `N/A` is valid only when the project has no deploy step
- [ ] Worktree returned to pool or removed
- [ ] Rich report posted to conversation and PR comment
- [ ] Returned to original working directory
- [ ] A runstate milestone comment was posted after every phase (ship posted two)
- [ ] On resume, no phase before `resume_from` was re-run

## Troubleshooting

**`gh` not found**: Install GitHub CLI: https://cli.github.com/
**CI fails after fixes**: Apply the Guiding Principle hand-off — may be an infrastructure issue rather than a code issue; say so in the comment.
**Merge conflicts**: Apply the Guiding Principle hand-off — needs human judgment, do not guess at a resolution.
**Vague issue**: Apply the Guiding Principle hand-off rather than guessing at intent.
**No test framework detected**: Default to vitest (Node.js) or pytest (Python)
**Pre-existing test failures**: Run tests on the base branch to confirm
**Review fix breaks tests**: Revert the fix and reclassify as Escalate (this feeds the Phase 4 hand-off, not a new issue)
**Pool return fails**: Fall back to manual `git worktree remove`
**`auto-merge-blocked` label appeared**: The watcher did not merge — read its comment for the reason (failing check, conflict, branch-update failure). Fix the root cause, then re-apply `gh pr edit <pr_number> --add-label "auto-merge"` to re-queue. Do NOT self-merge as a workaround.
**PR still unmerged after ~25 min**: Apply the Guiding Principle hand-off (Phase 5 item 6) — the watcher may be down or the PR may be stuck BEHIND. Do NOT silently exit.
