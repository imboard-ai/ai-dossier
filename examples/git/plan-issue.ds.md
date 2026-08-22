---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Plan Issue — Rich Planning Document",
  "version": "1.0.0",
  "status": "Stable",
  "objective": "Read a GitHub issue and its comments, explore relevant codebase areas, and write a rich planning document for structured implementation",
  "category": [
    "development"
  ],
  "tags": [
    "issue",
    "workflow",
    "git",
    "github",
    "plan",
    "planning"
  ],
  "risk_level": "low",
  "risk_factors": [
    "modifies_files"
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
        "description": "Target branch for this issue. Used to explore code on the correct branch.",
        "type": "string",
        "default": "main"
      },
      {
        "name": "worktree_path",
        "description": "Path to the worktree where the planning file should be created. Defaults to current directory.",
        "type": "string",
        "default": "."
      }
    ]
  },
  "authors": [
    {
      "name": "Yuval Dimnik"
    }
  ],
  "name": "plan-issue",
  "checksum": {
    "algorithm": "sha256",
    "hash": "bb766ae70597ac965da41cf0acc5926e45e0ef9adad66e72fa4f19535013292a"
  }
}
---

# Plan Issue — Rich Planning Document

## Objective

Read a GitHub issue (body + all comments), explore the relevant codebase, and produce a rich `PLANNING-{number}-{slug}.md` document that serves as the implementation blueprint.

## Prerequisites

- GitHub CLI (gh) is installed and authenticated
- You are in a git repository with GitHub as a remote
- The working directory is the worktree or project root where the planning file should be created

## Actions to Perform

### Step 1: Fetch Full Issue Context

```bash
gh issue view <issue_number> --json title,labels,body,assignees,comments
```

Read the issue body AND all comments — comments often contain clarifications, updated requirements, or design decisions added after the issue was filed. Treat them as additional context with the same weight as the body.

### Step 2: Determine Issue Slug

Slugify the issue title:
- Convert to lowercase
- Replace spaces with hyphens
- Remove special characters
- Truncate to 50 chars max

### Step 3: Check for Existing Planning File

Look for an existing `PLANNING-<issue_number>-*.md` in the worktree_path. If setup-issue-workflow already created a scaffold, read it and preserve any user-added content.

### Step 4: Explore Relevant Code

Based on the issue description and comments:
1. Identify files, modules, or areas of the codebase likely affected
2. Read key files to understand current implementation
3. Check for existing patterns, utilities, or abstractions that should be reused
4. If `base_branch` is not `main`, ensure you are exploring code on `base_branch` (it may have changes not yet on main)

### Step 5: Write Planning Document

Create (or overwrite) `PLANNING-<issue_number>-<slug>.md` in the worktree_path with this structure:

```markdown
# Issue #<N>: <title>

## Problem
<What's wrong or what's needed. Synthesized from issue body + comments.
Include any clarifications or updated requirements from comments.>

## Approach
<Proposed solution, 3-7 bullets. Each bullet should be actionable.>
1. <First change — what and why>
2. <Second change — what and why>
3. ...

## Files to Modify
- `path/to/file.ts` — <what changes and why>
- `path/to/other.ts` — <what changes and why>

## Reusable Code
<Existing functions, utilities, or patterns found during exploration that should be reused.
Prevents re-implementation of existing logic.>
- `path/to/util.ts:functionName()` — <what it does, how to use it>

## Risk Areas
- <Edge case or concern>
- <Dependency or coordination needed>
- <Performance consideration>

## Test Strategy
- <What to test and how>
- <Existing tests to run>
- <New tests to create>

## Open Questions
- <Anything genuinely ambiguous that needs human input>
(Leave empty if everything is clear)

## Visual Review
- [ ] Required (FE changes expected)
<!-- OR -->
- [x] Not required (backend/infra only)

## Base Branch
`<BASE_BRANCH>` — PRs for this issue target this branch.
```

### Step 6: Output

Print the planning file path and a brief summary:
```
Planning complete: <worktree_path>/PLANNING-<number>-<slug>.md
Approach: <1-sentence summary>
Files: <count> files identified
Open questions: <count> (or "none")
Visual review: required / not required
```

## Output

- `planning_file`: path to the created planning file
- `approach_summary`: 1-sentence summary
- `files_count`: number of files to modify
- `open_questions_count`: number of open questions
- `visual_review_required`: true/false

## Validation

- [ ] Issue body and ALL comments were read
- [ ] Relevant code was explored on the correct base branch
- [ ] Planning file follows the `PLANNING-{number}-{slug}.md` naming convention
- [ ] All sections are populated (Problem, Approach, Files, Risk, Tests)
- [ ] Existing utilities and patterns were identified in "Reusable Code" section
- [ ] Open Questions section only contains genuinely ambiguous items
- [ ] Visual Review checkbox reflects whether FE files are expected to change

## Troubleshooting

**No comments on issue**: This is fine — the body alone may be sufficient. Note it but proceed.
**Can't determine affected files**: Read the issue more carefully. If truly unclear, add to Open Questions.
**Base branch doesn't exist locally**: Run `git fetch origin <base_branch>` first.
