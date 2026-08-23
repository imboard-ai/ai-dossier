---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "gate-issue",
  "title": "Gate Issue — Pre-Flight Safety Check",
  "version": "1.2.0",
  "protocol_version": "1.0",
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
  "risk_factors": [
    "network_access"
  ],
  "requires_approval": false,
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
  "content_scope": "references-external",
  "external_references": [
    {
      "url": "https://cli.github.com/",
      "description": "GitHub CLI documentation",
      "type": "documentation",
      "trust_level": "trusted",
      "required": false
    }
  ],
  "checksum": {
    "algorithm": "sha256",
    "hash": "7543476b119ddc071a4f860d88183c3e2872964599e76cdd350f9009e200dca4"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "ggHHBfpxdHYgC04NvS5Yf68gBcWQjZNLaW0UgmgqLON9HKlmtH6/la2LB3y5nMG0RwB+TakpUFVxOsSdN/wTCw==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-08-23T14:03:49.686Z",
    "covers": "frontmatter+body",
    "key_id": "imboard-ai",
    "signed_by": "Yuval Dimnik <yuval.dimnik@gmail.com>"
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

### Step 1b: Mint Run ID

Mint the runstate `run_id` ONCE here. Every later phase of this issue reuses it unchanged.

```bash
RUN_ID="r-<issue_number>-$(openssl rand -hex 2)"
# fallback if openssl is unavailable:
# RUN_ID="r-<issue_number>-$(date +%s | tail -c 5)"
echo "Run ID: $RUN_ID"
```

Pass `run_id` to every subsequent sub-dossier exactly like `base_branch`.

(On a resumed run, Step 1.5 below reuses the prior `run_id` instead of this fresh mint — continuity of the trail matters more than a new id.)

### Step 1.5: Resume Detection

Check whether this issue already has runstate history before treating it as a fresh run:

```bash
LAST=$(gh issue view <issue_number> --json comments \
  --jq '[.comments[].body | select(startswith("<!-- runstate:v1 -->"))] | last // empty')
```

If `LAST` is empty: `resume_from=none`. Keep the `RUN_ID` minted in Step 1b and continue to Step 2 (Hard Blocks) as today.

Otherwise, parse `phase=`, `status=`, `run=`, and the phase-specific keys from `LAST`. **Reuse that `run=` value as `RUN_ID`** — discard the one minted in Step 1b. Then VERIFY the claim against reality — never trust the comment alone:

| last milestone | verify | if verified → | if not → |
|---|---|---|---|
| `gate` done | nothing to verify | `resume_from=setup` | — |
| `setup` done | `git ls-remote --exit-code origin <branch>` AND `test -d <worktree>` | `resume_from=plan` | `resume_from=setup` |
| `plan` done | setup checks AND `test -f <planning>` | `resume_from=implement` | `resume_from=plan` (or setup if those fail) |
| `implement` done | setup checks AND `git -C <worktree> rev-parse --short HEAD` matches `head` (strip `-dirty`) | `resume_from=review` | `resume_from=implement` |
| `review` done | setup checks | `resume_from=ship` | `resume_from=review` |
| `review` partial | setup checks | `resume_from=review` with `agents_pending` passed through | `resume_from=review` |
| `ship` awaiting-merge | `gh pr view <pr> --json state,mergedAt,mergeable` | merged → `resume_from=ship-teardown`; open+MERGEABLE → `resume_from=ship-wait`; CONFLICTING/closed-unmerged → `resume_from=ship` | `resume_from=ship` |
| `ship` done | — | `resume_from=report` | — |
| `report` done | issue is CLOSED? | print "already complete" and STOP (status pass, `resume_from=done`) | `resume_from=report` |
| any `blocked` | treat as the phase itself: `resume_from=<that phase>` | | |

**Loop cap**: if the last THREE runstate milestones are all `status=blocked` on the same phase, hard block with `reason=resume-loop` — add label `decision-pending`, post the abort comment (Step 2), and stop.

**Hard blocks (Step 2) still apply on resume** — EXCEPT "issue is closed", which is not a block when `resume_from` is `report` or `done` (a merged PR auto-closes the issue before report runs).

Carry `resume_context` forward: the parsed key=value lines of the last milestone, for later phases to consume.

### Step 2: Hard Blocks

If ANY of these are true, abort immediately with a comment on the issue:

- **Issue is closed**: `state == "CLOSED"` (not a block when resuming with `resume_from=report` or `resume_from=done` — see Step 1.5)
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

Then post the blocked runstate milestone (Step 6) with `status=blocked` and `reason=closed|decomposed|needs-clarification|epic|open-dependency-<N>`.

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

### Step 6: Runstate Milestone

Post the phase milestone to the issue. This is the last step of the phase — on a hard block, post it with `status=blocked` and a `reason=` before stopping. Comments are append-only: never edit or delete a prior milestone. Do not skip this in nested or fleet mode — it is the only state that survives the session.

```bash
gh issue comment <issue_number> --body "$(cat <<EOF
<!-- runstate:v1 -->
phase=gate status=done run=<run_id> at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
base_branch=<BASE_BRANCH>
warnings=<n>
resumed_from=<phase|none>
prior_run=<run_id|none>
verified=<comma list of checks passed|none>
next=setup
EOF
)"
```

`at` is filled in by the template (the heredoc is unquoted so `$(date …)` expands); put no other `$` in values. Values contain no spaces (use `-` or `,`); paths are absolute. On a hard block use `status=blocked`, `reason=<short-slug>`, and `next=done`.

## Output

- `status`: pass | fail
- `run_id`: runstate run id — minted fresh in Step 1b, or reused from a prior run on resume (Step 1.5) — pass to every subsequent sub-dossier
- `base_branch`: resolved base branch (default: `main`)
- `warnings`: list of soft warnings (may be empty)
- `failure_reason`: reason for hard block (only if status=fail)
- `resume_from`: phase to resume from, or `none` for a fresh run
- `resume_context`: parsed key=value lines of the last runstate milestone, for later phases to consume
- Posts runstate milestone to the issue (`phase=gate`)

## Validation

- [ ] Issue metadata was fetched
- [ ] Resume detection (Step 1.5) ran before hard blocks, checking for prior runstate history
- [ ] On resume: the prior `run_id` was reused, not re-minted, and the claimed milestone was verified against reality (not trusted blindly)
- [ ] Resume loop cap enforced — 3 consecutive `blocked` on the same phase is a hard block with `reason=resume-loop`
- [ ] A `run_id` was minted (fresh run) or reused (resumed run) and reported
- [ ] All hard blocks were checked (with the resume exception for a closed issue at `resume_from=report`/`done`)
- [ ] Soft warnings were counted
- [ ] Base branch was extracted from issue body
- [ ] On hard block: comment was posted and workflow stopped
- [ ] On pass: output includes status, base_branch, run_id, warnings, resume_from, and resume_context
- [ ] Runstate milestone comment was posted to the issue, including `resumed_from`/`prior_run`/`verified`

## Troubleshooting

**`gh` not found**: Install GitHub CLI: https://cli.github.com/

**Issue not found**: Verify the issue number and repository access

**Dependencies check slow**: Only checks issues explicitly referenced with "Depends on #N"
