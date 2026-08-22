---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Report Issue — Rich Completion Summary",
  "version": "1.0.0",
  "status": "Stable",
  "objective": "Generate a comprehensive completion report covering what changed, user-facing implications, dev/ops implications, and review results — posted to both conversation and PR comment",
  "category": [
    "development"
  ],
  "tags": [
    "issue",
    "workflow",
    "git",
    "github",
    "report",
    "summary"
  ],
  "risk_level": "low",
  "risk_factors": [
    "network_access"
  ],
  "inputs": {
    "required": [
      {
        "name": "issue_number",
        "description": "GitHub issue number",
        "type": "number"
      },
      {
        "name": "pr_number",
        "description": "PR number that was merged",
        "type": "number"
      }
    ],
    "optional": [
      {
        "name": "base_branch",
        "description": "The branch the PR was merged into",
        "type": "string",
        "default": "main"
      },
      {
        "name": "review_fixed",
        "description": "List of findings fixed in-place during review",
        "type": "array",
        "default": []
      },
      {
        "name": "review_escalated",
        "description": "List of escalated findings with GH issue numbers",
        "type": "array",
        "default": []
      },
      {
        "name": "review_clean",
        "description": "List of review categories with zero findings",
        "type": "array",
        "default": []
      },
      {
        "name": "cleanup_method",
        "description": "How the worktree was cleaned up: pool_returned, worktree_removed, or skipped",
        "type": "string",
        "default": "worktree_removed"
      }
    ]
  },
  "authors": [
    {
      "name": "Yuval Dimnik"
    }
  ],
  "name": "report-issue",
  "checksum": {
    "algorithm": "sha256",
    "hash": "65400a7bb20ea8aefddd2bd656db9dd8b5558b02ea8ea9d300f30ffac8e9eae5"
  }
}
---

# Report Issue — Rich Completion Summary

## Objective

Generate a comprehensive completion report that tells the user:
1. **What was done** — code changes summary
2. **User-facing implications** — new screens, changed behaviors, breaking changes
3. **Dev/ops implications** — new env vars, commands, schemas, dependencies, workflows
4. **Review results** — what was fixed, escalated, clean

The report is posted to BOTH the conversation (full version) and as a PR comment (condensed version).

## Prerequisites

- The PR has been merged
- All review data is available from previous phases
- GitHub CLI (gh) is installed and authenticated

## Actions to Perform

### Step 1: Gather Context

Collect data from previous phases and the PR:

```bash
# Get PR details
gh pr view <pr_number> --json title,body,files,additions,deletions,mergedAt

# Get issue details
gh issue view <issue_number> --json title,labels
```

### Step 2: Analyze Changes for Implications

Based on the files changed in the PR, determine:

**User-Facing Implications** — check for:
- New routes/pages (new files in `pages/`, `routes/`, `app/` directories)
- UI component changes (`.tsx`, `.jsx`, `.vue`, `.svelte` files)
- API endpoint changes (new/modified routes)
- Changed text, labels, or error messages visible to users
- Breaking changes to existing behavior
- New user-accessible features or settings

**Dev/Ops Implications** — check for:
- New environment variables (grep for `process.env.`, `import.meta.env.`, `.env` additions)
- New CLI commands or scripts
- Database schema changes (migrations, model changes)
- New dependencies in package.json, requirements.txt, etc.
- CI/CD pipeline changes (.github/workflows/, Dockerfile, deploy scripts)
- New cron jobs or background tasks
- Infrastructure changes (new services, changed ports, etc.)
- Configuration file changes

### Step 3: Compose Full Report

Print to conversation:

```markdown
## Cycle Complete

**Issue**: #<issue_number> — <title>
**PR**: #<pr_number> (merged into `<base_branch>`)
**Branch**: <branch-name> → `<base_branch>`

### What Changed
<1-3 sentence summary of implementation. Focus on WHAT was built, not HOW.>

### User-Facing Implications
- <New screen accessible at: /path/route>
- <Changed behavior: what users will notice>
- <Breaking changes: none / description>
<!-- If no user-facing changes: "No user-facing changes — backend/infra only." -->

### Dev/Ops Implications
- New env vars: <none / list with descriptions>
- New commands: <none / list>
- Schema changes: <none / description>
- New dependencies: <none / list>
- CI/CD changes: <none / description>
<!-- If no dev/ops changes: "No dev/ops changes." -->

### Review Results
**Fixed** (<N> findings fixed in this PR):
- <file>:<line> — <what was fixed>

**Escalated** (<N> issues created):
- #<issue> — <title>
<!-- Or "None" if zero escalated -->

**Clean categories** (no findings):
- <list categories with zero findings>
<!-- Or if all clean: "All 5 reviews passed clean — no findings." -->

### Cleanup
<Worktree returned to pool for reuse. / Worktree removed.> Back in original directory.
```

**If `base_branch` != main**: Add a note after the Branch line:
```
Note: Merged into `<base_branch>`, not `main`. This is an epic sub-issue — changes reach production when the epic branch is merged.
```

### Step 4: Post Condensed PR Comment

Post a shorter version to the PR for discoverability:

```bash
gh pr comment <pr_number> --body "$(cat <<'EOF'
## Completion Report

### User-Facing Implications
<bulleted list or "No user-facing changes.">

### Dev/Ops Implications
<bulleted list or "No dev/ops changes.">

### Review Summary
- Fixed: <N> findings
- Escalated: <N> issues (<links or "none">)
- Clean: <categories>
EOF
)"
```

### Step 5: Output

```
Report posted to conversation and PR #<pr_number>.
```

## Output

- `report_posted`: true
- `pr_comment_posted`: true
- `user_implications_count`: number of user-facing implications
- `devops_implications_count`: number of dev/ops implications

## Validation

- [ ] PR details were fetched
- [ ] Changed files were analyzed for user-facing implications
- [ ] Changed files were analyzed for dev/ops implications
- [ ] Full report printed to conversation
- [ ] Condensed report posted as PR comment
- [ ] If base_branch != main: epic sub-issue note included
- [ ] Review results accurately reflect what was fixed, escalated, and clean

## Troubleshooting

**PR not found**: Verify pr_number is correct and the PR exists

**Can't determine implications**: Default to "None identified — review the diff manually"

**PR comment fails**: May lack permissions — print report to conversation only
