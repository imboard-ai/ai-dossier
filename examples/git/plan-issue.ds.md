---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Plan Issue — Rich Planning Document",
  "version": "1.3.0",
  "protocol_version": "1.0",
  "status": "Stable",
  "objective": "Read a GitHub issue and its comments, explore relevant codebase areas, confirm any new state/flow is actually reachable, and write a rich planning document for structured implementation",
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
  "requires_approval": false,
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
      },
      {
        "name": "prod_data_access",
        "description": "How to query this project's production data to confirm a new state/flow actually occurs (used by the reachability check). Bind this per-project to a concrete method — e.g. a read-only database MCP server, a read replica, or an analytics warehouse. If unset, the reachability check uses the generic default below and degrades to escalate-when-unverifiable.",
        "type": "string",
        "default": "If your environment exposes a read-only production data store (a database MCP server, read replica, or analytics warehouse), use it to run a read-only count of the triggering condition. If no such access exists, treat reachability as unverifiable and escalate rather than assuming the state occurs."
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
  "name": "plan-issue",
  "checksum": {
    "algorithm": "sha256",
    "hash": "d0c73545effd4fa495dded8c2bdc60863258414c42be3520e0234ac544e4b53f"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "hiC4BqTb6metwjCICbr/FDBA4k1yyzWy5KKnsyn39cQL7vGmPH+QnCCj4kGglFzHmf9COZ/CRGarjuibmEOfAw==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-08-23T14:03:50.547Z",
    "covers": "frontmatter+body",
    "key_id": "imboard-ai",
    "signed_by": "Yuval Dimnik <yuval.dimnik@gmail.com>"
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
5. If `docs/agent-traps.md` exists, read it in full (it is small by design) and grep it for terms from the issue title and the affected paths. Mention any hit under Risk Areas.

### Step 4b: Reachability Check (REQUIRED before planning any new state/flow)

If the issue introduces a NEW state, branch, flow, or user-reachable condition, establish that real input can actually reach it **before** planning the build. Building unreachable states is a top source of wasted work — code that gets shipped and then ripped out once it turns out nothing ever triggers it.

For each new state/flow the change would introduce:

1. **What real input reaches this state?** Trace the concrete trigger — which user action, API payload, data-record shape, or config produces it.
2. **Does production data confirm it happens?** Do not reason from first principles — query real data. Use the access method described by the `prod_data_access` parameter to run a **read-only** count of the triggering condition.
3. **Record the evidence** (the query and the result count) in the planning document's "Reachability Evidence" section.

Decision rule:

- **0 occurrences in prod** → the state is currently unreachable. Do NOT plan the build. Add to Open Questions: _"Reachability unconfirmed — prod shows 0 occurrences of `<trigger>`. Confirm whether this state is real or imminent before building."_ and treat it as an escalation.
- **>0 occurrences** → reachable; proceed, and cite the count as justification in the plan.
- **No prod access, or not a data-reachable state** (pure UI, infra, refactor, copy change) → state explicitly why a data check is N/A and proceed.

Skip this step only for issues that add no new reachable state (refactors, copy changes, dependency bumps, pure infra).

### Step 5: Write Planning Document

Create (or overwrite) `PLANNING-<issue_number>-<slug>.md` in the worktree_path with this structure:

```markdown
# Issue #<N>: <title>

## Problem
<What's wrong or what's needed. Synthesized from issue body + comments.
Include any clarifications or updated requirements from comments.>

## Acceptance Criteria
<One line per criterion, verbatim from the issue where it states them; otherwise derive the minimal testable set. Each must be checkable by reading code/tests.>
- [ ] AC1 <criterion>
- [ ] AC2 <criterion>

## Approach
<Proposed solution, 3-7 bullets. Each bullet should be actionable.>
1. <First change — what and why>
2. <Second change — what and why>
3. ...

## Reachability Evidence
<For each NEW state/flow the approach introduces: the trigger, the prod query run, and the result count.
State "N/A — no new reachable state" for refactors / infra / copy changes.>
- State: <name> | Trigger: <what produces it> | Prod check: <query> → <N occurrences> | Verdict: reachable / UNREACHABLE (escalated) / N/A

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
Acceptance criteria: <count>
Files: <count> files identified
Open questions: <count> (or "none")
Visual review: required / not required
```

### Step 7: Runstate Milestone

Post the phase milestone to the issue. This is the last step of the phase — if planning aborts, post `status=blocked` with `reason=<short-slug>` instead and stop. Comments are append-only: never edit or delete a prior milestone. Do not skip this in nested or fleet mode — it is the only state that survives the session.

```bash
gh issue comment <issue_number> --body "$(cat <<EOF
<!-- runstate:v1 -->
phase=plan status=done run=<run_id> at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
planning=<abs path to planning file>
head=<short sha of base at plan time>
open_questions=<n>
visual_review=true|false
ac_count=<n>
AC1=<criterion, verbatim>
AC2=<criterion, verbatim>
next=implement
EOF
)"
```

`at` is filled in by the template (the heredoc is unquoted so `$(date …)` expands); put no other `$` in values. Values contain no spaces (use `-` or `,`); paths are absolute — **except the `AC<n>=` lines, which are the one exception to the no-spaces rule: write each criterion verbatim, spaces included.** Emit one `AC<n>=` line per criterion (not exactly two — the template shows two for illustration).

## Output

- `planning_file`: path to the created planning file
- `approach_summary`: 1-sentence summary
- `files_count`: number of files to modify
- `open_questions_count`: number of open questions
- `visual_review_required`: true/false
- `ac_count`: number of acceptance criteria written
- Posts runstate milestone to the issue (`phase=plan`, including `ac_count` and one `AC<n>=` line per criterion)

## Validation

- [ ] Issue body and ALL comments were read
- [ ] Relevant code was explored on the correct base branch
- [ ] `docs/agent-traps.md`, if present, was read in full and grepped for terms from the issue title and affected paths; any hit is under Risk Areas
- [ ] Reachability check performed for every new state/flow (prod data cited, or N/A justified); unreachable states escalated, not built
- [ ] Planning file follows the `PLANNING-{number}-{slug}.md` naming convention
- [ ] Acceptance Criteria section is populated — verbatim from the issue where stated, else the minimal testable set, each checkable by reading code/tests
- [ ] All sections are populated (Problem, Acceptance Criteria, Approach, Files, Risk, Tests)
- [ ] Existing utilities and patterns were identified in "Reusable Code" section
- [ ] Open Questions section only contains genuinely ambiguous items
- [ ] Visual Review checkbox reflects whether FE files are expected to change
- [ ] Runstate milestone comment was posted to the issue

## Troubleshooting

**No comments on issue**: This is fine — the body alone may be sufficient. Note it but proceed.
**Can't determine affected files**: Read the issue more carefully. If truly unclear, add to Open Questions.
**Base branch doesn't exist locally**: Run `git fetch origin <base_branch>` first.
