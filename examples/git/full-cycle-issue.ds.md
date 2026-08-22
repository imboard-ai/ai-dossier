---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Full Cycle Issue Workflow",
  "version": "3.0.0",
  "status": "Draft",
  "last_updated": "2026-03-26",
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
  "risk_level": "medium",
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
    "Creates and merges pull request",
    "Deletes branch after merge"
  ],
  "inputs": {
    "optional": [
      {
        "name": "warmup_dossier",
        "description": "Which warm-worktree dossier to use for worktree warmup. Passed through to setup-issue-workflow. Override for project-specific warmup (e.g., imboard-ai/imboard/warm-worktree for pnpm+SSM).",
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
  "name": "full-cycle-issue",
  "checksum": {
    "algorithm": "sha256",
    "hash": "87eba74f79b622cc03a3086df94276a3dd6332cb131429698bb0fb87a3361ecd"
  }
}
---

# Full Cycle Issue Workflow

## Objective

Take a GitHub issue from start to merged PR autonomously. For small-to-medium issues where requirements are clear. Composed from shared sub-dossiers — each sub-dossier is independently versioned and reusable.

## Guiding Principle

**Do not stop to ask yes/no questions.** Only pause when:
- The issue description is too vague to implement
- A business/product/design decision is genuinely ambiguous
- Tests fail after 2 fix attempts with unclear path forward
- Merge conflicts require human judgment

Do NOT ask about: file names, branch names, commit messages, PR descriptions, whether to proceed, or any mechanical decision.

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
| 4 | `imboard-ai/git/review-issue` | 5 parallel review agents + fix findings |
| 5 | `imboard-ai/git/ship-issue` | Commit + push + PR + CI + merge + teardown |
| 6 | `imboard-ai/git/report-issue` | Rich completion report |

## Actions to Perform

### Phase 0: Gate

1. Extract the issue number from user input
2. Run: `ai-dossier run imboard-ai/git/gate-issue`
3. Provide the issue number
4. If the gate fails, stop — do NOT proceed
5. Note the `base_branch` from the gate output
6. If a `base_branch` parameter was provided in context (and is not `"auto"`), use that instead

### Phase 1: Setup

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
   - Pass through `warmup_dossier` and `base_branch` parameters
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

1. Run: `ai-dossier run imboard-ai/git/plan-issue`
2. Pass through the issue number, base_branch, and worktree path
3. **In full-cycle mode: proceed immediately.** Do not checkpoint with the user. If the issue is genuinely ambiguous, ask ONE focused question then proceed.

### Phase 3: Implement

1. Run: `ai-dossier run imboard-ai/git/implement-issue`
2. Pass through the planning file path and base_branch

### Phase 4: Review

1. Run: `ai-dossier run imboard-ai/git/review-issue`
2. Collect the review results: `review_fixed`, `review_escalated`, `review_clean`

### Phase 5: Ship

1. Run: `ai-dossier run imboard-ai/git/ship-issue`
2. Pass through: issue number, base_branch, review_escalated, worktree_path, original_dir, pool_claimed

### Phase 6: Report

1. Run: `ai-dossier run imboard-ai/git/report-issue`
2. Pass through: issue number, pr_number, base_branch, review_fixed, review_escalated, review_clean, cleanup_method

## Validation

- [ ] Phase 0 gate passed (no hard blocks)
- [ ] Issue claimed with in-progress label
- [ ] Branch and worktree created (via pool claim or cold creation)
- [ ] Verified in worktree before proceeding
- [ ] Planning doc created
- [ ] Implementation addresses requirements
- [ ] Tests exist and all pass
- [ ] 5 parallel reviews completed
- [ ] Review fixes applied in-place
- [ ] Tests re-run after review fixes
- [ ] Committed with conventional commit message
- [ ] PR created targeting correct base_branch
- [ ] Escalated findings consolidated per review category (typically 0)
- [ ] CI passed and PR merged
- [ ] Worktree returned to pool or removed
- [ ] Rich report posted to conversation and PR comment
- [ ] Returned to original working directory

## Troubleshooting

**`gh` not found**: Install GitHub CLI: https://cli.github.com/
**CI fails after fixes**: Ask user — may be infrastructure issue
**Merge conflicts**: Ask user — needs human judgment
**Vague issue**: Ask ONE clarifying question, then proceed
**No test framework detected**: Default to vitest (Node.js) or pytest (Python)
**Pre-existing test failures**: Run tests on the base branch to confirm
**Review fix breaks tests**: Revert the fix and reclassify as Escalate
**Pool return fails**: Fall back to manual `git worktree remove`
