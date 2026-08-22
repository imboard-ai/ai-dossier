---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Gate Issue — Pre-Flight Safety Check",
  "version": "1.0.0",
  "status": "Stable",
  "objective": "Lightweight safety gate that checks issue metadata for hard blocks and soft warnings before starting any workflow",
  "category": [
    "development"
  ],
  "tags": [
    "issue",
    "workflow",
    "git",
    "github",
    "gate"
  ],
  "risk_level": "low",
  "inputs": {
    "required": [
      {
        "name": "issue_number",
        "description": "GitHub issue number to check",
        "type": "number"
      }
    ],
    "optional": []
  },
  "authors": [
    {
      "name": "Yuval Dimnik"
    }
  ],
  "name": "gate-issue",
  "checksum": {
    "algorithm": "sha256",
    "hash": "250f5086b6ac01e4ab1a3389d321bbf168f519b71c7cd62ecd2f75b56e257dcc"
  }
}
---

# Gate Issue — Pre-Flight Safety Check

## Objective

Lightweight safety gate (~30s) — check issue metadata for blockers before committing to a workflow. No codebase exploration.

## Prerequisites

- GitHub CLI (gh) is installed and authenticated
- You are in a git repository with GitHub as a remote

## Actions to Perform

### Step 1: Fetch Issue Metadata

```bash
gh issue view <issue_number> --json state,labels,body
```

### Step 2: Hard Blocks

If ANY of these are true, abort immediately with a comment on the issue:

- **Issue is closed**: `state == "CLOSED"`
- **Has label `decomposed`**: Issue was already decomposed into sub-issues by triage
- **Has label `needs-clarification`**: Issue was triaged as not ready
- **Has label `epic`**: Issue is an epic, not directly implementable
- **Has open dependency**: Body contains `Depends on #N` (case-insensitive) where issue #N is still open:
  ```bash
  # For each "Depends on #N" found in the body:
  gh issue view <N> --json state --jq '.state'
  ```
  If the referenced issue state is `OPEN`, it is a hard block.

**On hard block**: Post a comment and stop:

```bash
gh issue comment <issue_number> --body "**Workflow aborted**: <reason>. Resolve the blocker and re-run."
```

Do NOT proceed.

### Step 3: Soft Warnings

Count how many of these are true:

- Body is empty or less than 50 characters
- Body contains research keywords: `evaluate`, `research`, `explore`, `investigate`, `compare` (case-insensitive)
- Issue has no labels at all

If **2 or more** soft warnings: log a warning line but continue:

```
⚠ Gate: 2 soft warnings (short body, no labels) — proceeding with caution
```

If 0-1 soft warnings: proceed silently.

### Step 4: Extract Base Branch

Parse the issue body for `merges into \`<branch-name>\`` (case-insensitive):

```bash
BASE_BRANCH=$(gh issue view <issue_number> --json body --jq '.body' | grep -oiP 'merges into `\K[^`]+' | head -1)
if [ -z "$BASE_BRANCH" ]; then
  BASE_BRANCH="main"
fi
echo "Base branch: $BASE_BRANCH"
```

### Step 5: Output

Report results:

```
Gate passed: #<issue_number> — <title>
Base branch: <BASE_BRANCH>
Warnings: <count> (<list or "none">)
```

## Output

- `status`: pass | fail
- `base_branch`: resolved base branch (default: `main`)
- `warnings`: list of soft warnings (may be empty)
- `failure_reason`: reason for hard block (only if status=fail)

## Validation

- [ ] Issue metadata was fetched
- [ ] All hard blocks were checked
- [ ] Soft warnings were counted
- [ ] Base branch was extracted from issue body
- [ ] On hard block: comment was posted and workflow stopped
- [ ] On pass: output includes status, base_branch, and warnings

## Troubleshooting

**`gh` not found**: Install GitHub CLI: https://cli.github.com/

**Issue not found**: Verify the issue number and repository access

**Dependencies check slow**: Only checks issues explicitly referenced with "Depends on #N"
