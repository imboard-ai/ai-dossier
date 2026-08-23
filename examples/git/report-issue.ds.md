---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "report-issue",
  "title": "Report Issue — Rich Completion Summary",
  "version": "1.4.0",
  "protocol_version": "1.0",
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
  "requires_approval": false,
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
      },
      {
        "name": "run_id",
        "description": "Runstate run id minted by gate-issue; pass through unchanged",
        "type": "string"
      }
    ]
  },
  "authors": [
    {
      "name": "Yuval Dimnik"
    }
  ],
  "checksum": {
    "algorithm": "sha256",
    "hash": "bf044b483f2966225b3498e5019c212ab062e30da5dd189a24d0b1c4d513d7ab"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "ffuzmK+wMqb/rGgKd68NgbbiXdihOaYBeRlUlB4Zq/GDFxHghwbLYMDMKGsvoSYouCFC5/gOn/ZEkEBeHyvKCw==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-08-23T14:05:54.575Z",
    "covers": "frontmatter+body",
    "key_id": "imboard-ai",
    "signed_by": "Yuval Dimnik <yuval.dimnik@gmail.com>"
  }
}
---

# Report Issue — Rich Completion Summary

## Objective

Generate a comprehensive completion report that tells the user:
1. **What was done** — code changes summary
2. **User-facing implications** — new screens, changed behaviors, breaking changes
3. **Dev/ops implications** — new env vars, commands, schemas, dependencies, workflows
4. **Review results** — what was fixed and clean (this dossier only runs on a real
   completion, so there is nothing escalated to report — see full-cycle-issue's
   Guiding Principle)

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
**Shipped**: <DEPLOYED — the deployed SHA + run URL, or `NOT DEPLOYED` / `N/A — <reason>`>

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

<!-- No "Escalated" section: this dossier only runs on a real completion. Any review
     escalation already stopped the run earlier with a decision-pending hand-off on
     the issue — see full-cycle-issue's Guiding Principle. -->

**Clean categories** (no findings):
- <list categories with zero findings>
<!-- Or if all clean: "All 5 reviews passed clean — no findings." -->

### Cleanup
<Worktree returned to pool for reuse. / Worktree removed.> Back in original directory.
```

**The `Shipped` line is not decoration — it is the report's honesty gate.**

`MERGE_COMMIT` alone has never meant "users can see it". A merge puts code on the default
branch; a deploy puts it in front of people, and on some repos the merge does NOT trigger
the deploy at all (see ship-issue Step 6c). A report that says "Cycle Complete" over
undeployed code is the most expensive kind of wrong: everything downstream — the issue
close, the PR comment, the human reading it — treats shipped as done.

- deploy confirmed → `**Shipped**: <sha> (<run url>)`
- no deploy step exists for this project → `**Shipped**: N/A — <why>`
- merged but NOT deployed → `**Shipped**: ⚠️ NOT DEPLOYED — <what a human must run>`,
  and say it in the FIRST line of the report, not buried in Dev/Ops implications. A run
  that ends here is not a clean run; ship-issue Step 6c should have already escalated it.

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
- Clean: <categories>
EOF
)"
```

### Step 4b: Trap index write-back (mechanical trigger)

First, check the trigger condition. Fetch the last `phase=ship` and `phase=implement` runstate milestones:

```bash
gh issue view <issue_number> --json comments \
  --jq '[.comments[].body | select(startswith("<!-- runstate:v1 -->"))]'
```

Read `ci_fix_attempts` from the last `phase=ship status=done` milestone, and `ci_parity` from the `phase=implement` milestone.

If the repo has `docs/agent-traps.md` AND (`ci_fix_attempts` ≥ 1 OR `ci_parity=fail-then-fixed`), you MUST append exactly one row: `| <the literal error string a future agent would grep> | <what actually went wrong> | <the fix, as a command or one sentence> | PR #<n> |`. Commit it on a tiny follow-up branch and open a PR (`docs(traps): …`), or if the repo allows, include it before merge. Otherwise `traps_added=0`. If the file does not exist, skip and note it.

### Step 4c: Extract learnings + delete PLANNING file

Per the repo's AGENTS.md rule if present; at minimum delete `PLANNING-<n>-*.md` from the worktree if still present (it never belongs in main).

### Step 5: Output

```
Report posted to conversation and PR #<pr_number>.
```

### Step 6: Runstate Milestone

Post the final phase milestone to the issue. This is the last step of the cycle. Comments are append-only: never edit or delete a prior milestone. Do not skip this in nested or fleet mode — it is the only state that survives the session.

```bash
gh issue comment <issue_number> --body "$(cat <<EOF
<!-- runstate:v1 -->
phase=report status=done run=<run_id> at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
pr=<pr_number>
traps_added=<n>
next=done
EOF
)"
```

`at` is filled in by the template (the heredoc is unquoted so `$(date …)` expands); put no other `$` in values. `traps_added` is the number of rows appended to `docs/agent-traps.md` in Step 4b (0 or 1 normally). Values contain no spaces (use `-` or `,`); paths are absolute.

## Output

- `report_posted`: true
- `pr_comment_posted`: true
- `deployed`: the deployed SHA when a deploy was confirmed; `null` when merged-but-not-deployed; `"n/a"` when the project has no deploy step. NEVER omit — a missing value reads as success.
- `user_implications_count`: number of user-facing implications
- `devops_implications_count`: number of dev/ops implications
- Posts runstate milestone to the issue (`phase=report`)

## Validation

- [ ] `Shipped` line present and accurate — deployed SHA, `N/A — <reason>`, or an explicit `NOT DEPLOYED` warning. Merged is not shipped.
- [ ] PR details were fetched
- [ ] Changed files were analyzed for user-facing implications
- [ ] Changed files were analyzed for dev/ops implications
- [ ] Full report printed to conversation
- [ ] Condensed report posted as PR comment
- [ ] If base_branch != main: epic sub-issue note included
- [ ] Review results accurately reflect what was fixed and clean
- [ ] Trap index write-back checked: if `docs/agent-traps.md` exists and (`ci_fix_attempts` ≥ 1 OR `ci_parity=fail-then-fixed`), exactly one row was appended and shipped via a follow-up PR or pre-merge commit; otherwise `traps_added=0`
- [ ] `PLANNING-<n>-*.md` was deleted from the worktree if still present
- [ ] Runstate milestone comment was posted to the issue

## Troubleshooting

**PR not found**: Verify pr_number is correct and the PR exists

**Can't determine implications**: Default to "None identified — review the diff manually"

**PR comment fails**: May lack permissions — print report to conversation only
