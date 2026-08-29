---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "report-issue",
  "title": "Report Issue — Rich Completion Summary",
  "version": "1.7.0",
  "protocol_version": "1.0",
  "status": "Stable",
  "objective": "Generate a comprehensive completion report covering what changed, user-facing implications, dev/ops implications, and review results — posted to both conversation and PR comment; in batch mode (batch_id set): one batch report on the anchor plus one short completion comment per member issue",
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
      },
      {
        "name": "batch_id",
        "description": "Batch id slug. When set, run the BATCH VARIANT: one batch report on the anchor + one short completion comment per member issue. issue_number is the batch ANCHOR; pr_number is the batch PR. Unset = ordinary per-issue report.",
        "type": "string"
      },
      {
        "name": "members",
        "description": "Batch mode only: comma-separated member issue numbers (e.g. 101,102,104). Falls back to the PR body's 'Closes #N' list when omitted.",
        "type": "string"
      }
    ]
  },
  "authors": [
    {
      "name": "Yuval Dimnik"
    }
  ],
  "last_updated": "2026-08-29",
  "checksum": {
    "algorithm": "sha256",
    "hash": "cf9da113143a89b676a1d91e015806fa8d3784f718fd9109b468e000fd9b86ac"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "tA+vl/INAovU+Zg/7ofb+qtV7kfn+h75l/GHvLpK5EqpFRPIH9t63+H9ISW9dufW+s+dpgg7S7ekWz+aoL6vAw==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-08-29T18:04:15.155Z",
    "covers": "frontmatter+body",
    "key_id": "imboard-ai",
    "signed_by": "Yuval Dimnik <yuval.dimnik@gmail.com>"
  }
}
---

# Report Issue — Rich Completion Summary

## Objective

Generate a completion report covering: **what was done** (code changes), **user-facing implications** (new screens, changed behaviors, breaking changes), **dev/ops implications** (env vars, commands, schemas, dependencies, workflows), and **review results** — what was fixed and clean (this dossier only runs on a real completion, so nothing is escalated to report — full-cycle-issue's Guiding Principle). Posted BOTH to the conversation (full) and as a PR comment (condensed).

## Prerequisites

- The PR has been merged
- All review data is available from previous phases
- GitHub CLI (gh) is installed and authenticated

This phase may run in a **later session than implement** — a detached ship (ship-issue's `ship_mode`) parks the PR and ends the run, and the tail run finishing it starts fresh at `resume_from=ship-teardown`. Nothing assumes in-memory state: context comes from the runstate milestones and the PR, read in Step 1 and Step 4b.

## Batch Variant (batch_id set)

When the `batch_id` input is set, this dossier runs the **batch variant**: ONE batch report + ONE short completion comment per member issue. `issue_number` is the batch ANCHOR issue; `pr_number` is the batch PR. The per-issue flow below does not run — the batch variant replaces Steps 1–6.

**Batch Step 1: Gather context.** Fetch the batch PR and the member list:

```bash
gh pr view <pr_number> --json title,body,files,additions,deletions,mergedAt,mergeCommit
```

Members come from the `members` input; when omitted, parse the PR body's `Closes #N` / `Fixes #N` lines.

**Batch Step 2: Compose the batch report.** Same skeleton and honesty gates as Step 3 below, adapted:

- **What Changed** — one line per member issue (`#<n> — <one-line summary>`, from the PR's per-issue sections or per-issue commits), plus a 1-2 sentence batch-level summary.
- **User-Facing / Dev-Ops Implications** — analyzed over the COMBINED diff, not per issue; a change shipped by any member is a change the batch ships.
- **Review Results** — the aggregate review's findings (tier, fixed, clean), from the batch trail.
- **`Shipped` line covers the BATCH deploy** — one deploy carries every member (deploy coupling). Deploy confirmed → the deploy SHA + run URL; no deploy step → `N/A — <reason>`; merged but not deployed → the explicit `NOT DEPLOYED` warning, first line, exactly as below.
- **`MERGE_COMMIT` gate unchanged**: an empty merge commit is a FAILED batch report, never a clean one. Batch PRs rebase-merge (per-issue commits land individually in main): record the batch PR's merge head SHA and note that per-issue commits are individually revertable — do not assume a single squash commit.

**Batch Step 3: Post it** — full version to the conversation, condensed version as a comment on the batch PR (Step 4's shape).

**Batch Step 4: One short completion comment per member issue** (traceability — the issue↔PR relation is N:1, so each issue needs its own closing record):

```bash
gh issue comment <member> --body "Shipped in batch <batch_id> — batch PR #<pr_number>, MERGE_COMMIT <sha>, Shipped <deployed SHA + run URL | NOT DEPLOYED — <what a human must run> | N/A — <reason>>. Full batch report: <link to the PR comment>."
```

Short means short — the full analysis lives in the batch report; each member comment carries exactly the honesty gates (merge commit + deployed state) and the pointer. Never post a member's completion comment before the batch's deploy state is determined.

**Batch Step 5: Traps + cleanup.** Step 4b's mechanical trigger applies to the batch trail — read the ship-like milestone that exists (`batch-ship` once ship's batch mode lands; until then, whatever ship evidence the trail carries) and the batch's aggregate CI evidence. Step 4c is N/A: the batch worktree has no per-issue `PLANNING-*` files.

**Batch Step 6: Milestone on the ANCHOR:**

```bash
ai-dossier runstate post --issue <anchor_number> --phase batch-report --status done --run <run_id> \
  --kv batch=<batch_id> \
  --kv pr=<pr_number> \
  --kv merge_commit=<sha> \
  --kv deployed=<sha|not-deployed|n-a> \
  --kv members=<n> \
  --kv traps_added=<n>
```

`<run_id>` is the batch's run id; the CLI stamps `next=done`. `merge_commit` empty is the same failure it is in the report body — a blocked milestone with `reason=no-merge-commit` is the honest posting, not `done`.

## Actions to Perform

### Step 1: Gather Context

```bash
gh pr view <pr_number> --json title,body,files,additions,deletions,mergedAt
gh issue view <issue_number> --json title,labels
```

### Step 2: Analyze Changes for Implications

From the files changed in the PR, determine:

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

**The `Shipped` line is not decoration — it is the report's honesty gate.** A merge puts code on the default branch; a deploy puts it in front of people, and on some repos the merge does NOT trigger the deploy at all (ship-issue Step 6c). "Cycle Complete" over undeployed code is the most expensive kind of wrong.

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

Check the trigger condition — fetch the last `phase=ship` and `phase=implement` milestones:

```bash
gh issue view <issue_number> --json comments \
  --jq '[.comments[].body | select(startswith("<!-- runstate:v1 -->"))]'
```

Read `ci_fix_attempts` from the last `phase=ship status=done` milestone, and `ci_parity` from the `phase=implement` milestone.

If the repo has `docs/agent-traps.md` AND (`ci_fix_attempts` ≥ 1 OR `ci_parity=fail-then-fixed` OR the run surfaced a finding a future agent would grep for — a masked failure mode, a vacuous test pattern, a tool workaround), you MUST append one row per qualifying finding (mechanical triggers guarantee at least one; judgment findings add more — err toward writing the row): `| <the literal error string a future agent would grep> | <what actually went wrong> | <the fix, as a command or one sentence> | PR #<n> |`. Commit it on a tiny follow-up branch and open a PR (`docs(traps): …`), or if the repo allows, include it before merge. Otherwise `traps_added=0`. If the file does not exist, skip and note it.

### Step 4c: Extract learnings + delete PLANNING file

Per the repo's AGENTS.md rule if present; at minimum delete `PLANNING-<n>-*.md` from the worktree if still present — it never belongs in main.

### Step 5: Output

```
Report posted to conversation and PR #<pr_number>.
```

### Step 6: Runstate Milestone

Post the final phase milestone to the issue. This is the last step of the cycle. Comments are append-only: never edit or delete a prior milestone. Do not skip this in nested or fleet mode — it is the only state that survives the session.

```bash
ai-dossier runstate post --issue <issue_number> --phase report --status done --run <run_id> \
  --kv pr=<pr_number> \
  --kv traps_added=<n>
```

Let the CLI stamp `at=` and compute `next=done` — do not pass either; never hand-write the comment. `traps_added` is the number of rows appended to `docs/agent-traps.md` in Step 4b (0 or 1 normally).

## Output

- `report_posted`: true
- `pr_comment_posted`: true
- `deployed`: the deployed SHA when a deploy was confirmed; `null` when merged-but-not-deployed; `"n/a"` when the project has no deploy step. NEVER omit — a missing value reads as success.
- `user_implications_count`: number of user-facing implications
- `devops_implications_count`: number of dev/ops implications
- Posts runstate milestone to the issue (`phase=report`)

## Validation

- [ ] `Shipped` line present and accurate — deployed SHA, `N/A — <reason>`, or an explicit `NOT DEPLOYED` warning. Merged is not shipped.
- [ ] Batch variant (batch_id set): ONE batch report posted (conversation + PR comment) with per-issue What Changed lines, aggregate implications over the combined diff, and the batch-deploy `Shipped` line; ONE short completion comment per member issue carrying merge-commit + deployed state; milestone posted as `phase=batch-report` on the anchor with `batch=`, `pr=`, `merge_commit=`, `deployed=`, `members=`, `traps_added=`; `MERGE_COMMIT`/`DEPLOYED` honesty-gate semantics identical to the per-issue report (rebase-merge: record the batch PR merge head, not an assumed squash commit)
- [ ] PR details were fetched; changed files analyzed for user-facing and dev/ops implications
- [ ] Full report printed to conversation; condensed report posted as PR comment
- [ ] If base_branch != main: epic sub-issue note included
- [ ] Review results accurately reflect what was fixed and clean
- [ ] Trap index write-back checked: if `docs/agent-traps.md` exists and (`ci_fix_attempts` ≥ 1 OR `ci_parity=fail-then-fixed`), a row per qualifying finding (mechanical OR judgment-flagged) was appended and shipped via a follow-up PR or pre-merge commit; otherwise `traps_added=0`
- [ ] `PLANNING-<n>-*.md` was deleted from the worktree if still present
- [ ] Runstate milestone comment was posted to the issue

## Troubleshooting

| Symptom | Fix |
|---|---|
| PR not found | Verify pr_number is correct and the PR exists |
| Can't determine implications | Default to "None identified — review the diff manually" |
| PR comment fails | May lack permissions — print report to conversation only |
