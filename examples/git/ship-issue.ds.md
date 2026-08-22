---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Ship Issue — Commit, PR, Merge, Teardown",
  "version": "1.0.0",
  "status": "Stable",
  "objective": "Commit changes, push, create a PR, wait for CI, merge, and clean up the worktree",
  "category": [
    "development"
  ],
  "tags": [
    "issue",
    "workflow",
    "git",
    "github",
    "ship",
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
  "destructive_operations": [
    "Pushes branch to remote",
    "Creates and merges pull request",
    "Deletes branch after merge"
  ],
  "inputs": {
    "required": [
      {
        "name": "issue_number",
        "description": "GitHub issue number",
        "type": "number"
      }
    ],
    "optional": [
      {
        "name": "base_branch",
        "description": "Target branch for the PR",
        "type": "string",
        "default": "main"
      },
      {
        "name": "review_escalated",
        "description": "List of escalated review findings to create GH issues for",
        "type": "array",
        "default": []
      },
      {
        "name": "worktree_path",
        "description": "Path of the worktree to clean up after merge",
        "type": "string",
        "default": ""
      },
      {
        "name": "original_dir",
        "description": "Directory to return to after teardown",
        "type": "string",
        "default": ""
      },
      {
        "name": "pool_claimed",
        "description": "Whether the worktree was claimed from the pool (affects cleanup)",
        "type": "boolean",
        "default": false
      }
    ]
  },
  "authors": [
    {
      "name": "Yuval Dimnik"
    }
  ],
  "name": "ship-issue",
  "checksum": {
    "algorithm": "sha256",
    "hash": "488cb2574a1bb2e7efd35c340d68f5e0a0651f031e4a88e0bfce8239f18ec929"
  }
}
---

# Ship Issue — Commit, PR, Merge, Teardown

## Objective

Ship the implementation: commit, push, create PR, wait for CI, merge, and clean up.

## Prerequisites

- All code changes are ready (implemented, tested, reviewed)
- You are in the worktree/working directory with uncommitted changes
- GitHub CLI (gh) is installed and authenticated
- You have push access

## Actions to Perform

### Step 1: Commit

1. Stage relevant files (never `.env`, credentials, secrets)
2. Commit with conventional commits format:
   ```
   feat|fix|chore: <description>

   Closes #<issue_number>

   Co-Authored-By: Claude <noreply@anthropic.com>
   ```

### Step 2: Push

```bash
git push -u origin <branch-name>
```

### Step 3: Create PR

Create the PR targeting `base_branch`:

```bash
gh pr create --base <base_branch> --title "<short title>" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>

Closes #<issue_number>

## Test plan
- <how to verify>

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

### Step 4: Create GH Issues for Escalated Findings

After the PR is created, handle any escalated findings from the review phase.

**Consolidation rule**: Group all escalated findings from the same review category (DRY, Security, Supportability, Maintainability, Documentation) into a **single GH issue per category**. This means at most 5 issues total (one per review agent), but typically 0.

Most PRs should have **zero** escalated issues. If there are more than 2, re-evaluate.

For each category with escalated findings:

```bash
gh issue create --title "<Category>: escalated findings from PR #<pr-number>" --label "review" --body "$(cat <<'EOF'
**Source**: PR #<pr-number>, found during <Category> review of <branch>

### Findings

1. **<file>:<lines>** — <description>
   **Why escalated**: <why this needs human judgment>
EOF
)"
```

If zero escalated findings (common case), create no GH issues.

### Step 5: Wait for CI

**Do NOT merge until all checks pass.**

```bash
gh pr checks <pr-number> --watch --fail-fast
```

If the command is not available or times out, poll manually:

```bash
gh pr checks <pr-number>
```

Repeat every 30 seconds until all checks show `pass` or `fail`.

### Step 6: Handle CI Failures (max 2 attempts)

If CI fails:

1. Identify which job failed:
   ```bash
   gh pr checks <pr-number>
   ```
2. Get the failed run ID and view logs:
   ```bash
   gh run view <run-id> --log-failed
   ```
3. Read the failure output, identify root cause, fix the code
4. Run the failing command locally first to confirm the fix
5. Commit and push:
   ```bash
   git add <files> && git commit -m "fix: CI failure — <what was wrong>

   Co-Authored-By: Claude <noreply@anthropic.com>"
   git push
   ```
6. Wait for CI again (go back to Step 5)
7. If CI fails after 2 fix attempts, ask the user — do not merge a red build

### Step 7: Merge

All checks green — merge:

```bash
gh pr merge <pr-number> --squash
```

Do NOT use `--delete-branch` — it fails from worktrees. Branch cleanup happens in Step 8.

Clean up issue labels:

```bash
gh issue edit <issue_number> --remove-label "in-progress"
```

### Step 8: Teardown

**Prerequisite: Step 7 (Merge) must be complete.** Do not tear down before merge.

1. `cd` back to `original_dir` (if provided)
2. **Try to return the worktree to the pool** (if `pool_claimed` is true):
   ```bash
   npx worktree-pool return --path <worktree_path> 2>/dev/null
   ```
   - If succeeds: worktree recycled for reuse. Skip steps 3-5.
   - If fails: continue with manual cleanup.
3. Remove the worktree:
   ```bash
   git worktree remove <worktree_path>
   ```
4. Delete local branch if it still exists:
   ```bash
   git branch -d <branch-name> 2>/dev/null || git branch -D <branch-name>
   ```
5. Clean up remote branch if it still exists:
   ```bash
   git push origin --delete <branch-name> 2>/dev/null || true
   ```

## Output

- `pr_number`: the created PR number
- `pr_url`: the PR URL
- `merge_status`: merged | failed
- `target_branch`: the branch merged into
- `escalated_issues`: list of created GH issue numbers (may be empty)
- `cleanup`: pool_returned | worktree_removed | skipped

## Validation

- [ ] Changes committed with conventional commits format
- [ ] Branch pushed to remote
- [ ] PR created targeting correct base_branch
- [ ] Escalated findings consolidated per review category (typically 0)
- [ ] CI passed (or failures fixed within 2 attempts)
- [ ] PR merged (squash)
- [ ] in-progress label removed
- [ ] Worktree returned to pool or removed
- [ ] Returned to original directory

## Troubleshooting

**CI fails after fixes**: Ask user — may be infrastructure issue

**Merge conflicts**: Ask user — needs human judgment

**`--delete-branch` fails in worktree**: Expected — don't use it. Clean up in Step 8.

**Pool return fails**: Not an error — fall back to manual worktree remove.
