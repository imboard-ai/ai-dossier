---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "setup-issue-workflow",
  "title": "Setup Issue Workflow",
  "version": "1.14.1",
  "protocol_version": "1.0",
  "status": "Stable",
  "objective": "Create a workflow for GitHub issues: fetch issue details, create appropriately named branches, set up git worktrees with environment warmup (or claim from a pre-warmed pool), and generate planning files; in batch mode (batch_id) it creates the shared batch branch for the batch anchor instead",
  "category": [
    "development"
  ],
  "risk_level": "low",
  "requires_approval": false,
  "inputs": {
    "optional": [
      {
        "name": "warmup_dossier",
        "description": "Which warm-worktree dossier to run for worktree warmup. Override this to use a project-specific warmup (e.g., imboard-ai/imboard/warm-worktree-pnpm-ssm for pnpm+SSM projects).",
        "type": "string",
        "default": "imboard-ai/git/warm-worktree"
      },
      {
        "name": "base_branch",
        "description": "Target branch to branch from and merge into. Overrides issue body parsing ('merges into `<branch>`'). Use for epic sub-issues or when the target is not main.",
        "type": "string",
        "default": "auto"
      },
      {
        "name": "run_id",
        "description": "Runstate run id minted by gate-issue; pass through unchanged. In batch mode this is the batch's run id (minted against the anchor issue).",
        "type": "string"
      },
      {
        "name": "batch_id",
        "description": "Batch id slug (e.g. b-2026-08-29-01). When set, run in BATCH MODE: one run per batch against the batch ANCHOR issue — creates the shared branch batch/<batch_id>-<date> from base, skips per-issue branch naming and the planning scaffold, and posts phase=batch-setup on the anchor. Unset = ordinary per-issue mode.",
        "type": "string"
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
    },
    {
      "url": "https://git-scm.com/docs/git-worktree",
      "description": "Official git documentation",
      "type": "documentation",
      "trust_level": "trusted",
      "required": false
    },
    {
      "url": "https://cli.github.com/manual/",
      "description": "GitHub CLI documentation",
      "type": "documentation",
      "trust_level": "trusted",
      "required": false
    },
    {
      "url": "https://www.conventionalcommits.org/",
      "description": "External reference: conventionalcommits.org",
      "type": "documentation",
      "trust_level": "trusted",
      "required": false
    }
  ],
  "content_scope": "references-external",
  "risk_factors": [
    "network_access"
  ],
  "last_updated": "2026-08-29",
  "checksum": {
    "algorithm": "sha256",
    "hash": "dcbca3c0060d32aef51cb11a4e5ceab92aeba1492bc45445aec8e50c1d389f21"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "NXJOoOgjivDOoSe7Oxmo+W27fdKOT0oCt1SbMN1n9ajvGrXNmAuCaskYSxCS03EA0vp/iBdpcKikN/+zAUNzDA==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-08-29T18:21:27.636Z",
    "covers": "frontmatter+body",
    "key_id": "imboard-ai",
    "signed_by": "Yuval Dimnik <yuval.dimnik@gmail.com>"
  }
}
---

# Setup Issue Workflow

## Objective

Create a workflow for GitHub issues that fetches issue details, creates appropriately named branches, optionally sets up git worktrees, and generates planning files for structured development.

## Prerequisites

- [ ] Git is installed and configured
- [ ] GitHub CLI (gh) is installed and authenticated
- [ ] You are in a git repository with GitHub as a remote
- [ ] You have push access to create branches

## Actions to Perform

### Step 1: Get Issue Number

Prompt the user if not already provided:

```
? GitHub issue number:
```

### Step 2: Fetch Issue Details

```bash
gh issue view <ISSUE_NUMBER> --json title,labels,body,assignees
```

Extract `title` (branch naming), `labels` (check for "bug" or "feature"), `body` (planning file), `base_branch`.

**Resolve base branch** — determines which branch to branch from and target PRs against:

1. **If the `base_branch` input parameter was provided** (and is not `"auto"`): use it directly. Skip issue body parsing.
2. **Otherwise**: extract from the issue body. Look for `merges into \`<branch-name>\`` (case-insensitive):
   ```bash
   BASE_BRANCH=$(gh issue view <ISSUE_NUMBER> --json body --jq '.body' | grep -oiP 'merges into `\K[^`]+' | head -1)
   if [ -z "$BASE_BRANCH" ]; then
     BASE_BRANCH="main"
   fi
   ```
3. **Print**: `Base branch: $BASE_BRANCH`

Store `BASE_BRANCH` for Steps 5.1, 5b, 7 and 8, and report it in the Step 10 summary so downstream dossiers can use it.

### Step 2b: Batch Mode (batch_id set)

If the `batch_id` input is set, this run is **batch mode**: it runs ONCE per batch, and `<ISSUE_NUMBER>` is the batch ANCHOR issue (created by batch-issues-preparation, labeled `batch-epic`) — not a member issue. Member issues never run this dossier; their work happens in the batch worktree via slot-cycle.

- **Branch name**: `batch/<batch_id>-<YYYYMMDD>` (UTC date at creation) — e.g. `batch/b1-20260829`. Branch from `BASE_BRANCH`. No type prefix, no issue number, no title slug — those are per-issue concepts.
- **Worktree path**: `$REPO_ROOT/worktrees/batch-<batch_id>-<YYYYMMDD>`.
- **Steps 3 and 4 are SKIPPED** (branch type and title slug do not apply).
- Steps 5.1 (pool claim), 6, 7, 8 and 8.5 run with the batch branch name and the batch worktree path above — substitute `batch-<batch_id>-<YYYYMMDD>` for the per-issue `<type>-<issue-number>-<slug>` template in Steps 6 and 8; the pool claim or cold path is otherwise identical to per-issue mode. The anchor issue number is passed to `worktree-pool claim --issue`.
- **Step 9 (planning scaffold) is SKIPPED** — the batch worktree carries no `PLANNING-*` file. Member issues' plans live on the issues themselves as `plan:v1` artifact comments (produced by batch-prep or plan-issue).
- The Step 11 milestone posts `phase=batch-setup` on the ANCHOR issue (see Step 11).

If `batch_id` is not set, everything below is ordinary per-issue mode — unchanged.

### Step 3: Determine Branch Type

*Per-issue mode only — skipped in batch mode (Step 2b names the branch).*

`bug` label → `bug/` prefix. `feature` label → `feature/` prefix. Both or neither → prompt:

```
? Issue type:
  1) bug - This is a bug fix
  2) feature - This is a new feature
Choice (1-2):
```

### Step 4: Create Branch Name

*Per-issue mode only — skipped in batch mode (Step 2b names the branch).*

Slugify the title: lowercase, spaces → hyphens, remove special characters, truncate to 50 chars max. Construct `{type}/{issue-number}-{slugified-title}` — e.g. `bug/123-fix-login-redirect-issue`, `feature/456-add-user-dashboard`.

### Step 5: Choose Workflow Mode

```
? Where do you want to work on this issue?
  1) Create a git worktree (recommended for parallel work)
  2) Repurpose existing worktree (fastest - skips npm install)
  3) Current directory (just create branch and planning file here)
  4) Custom location (specify your own path)
Choice (1-4):
```

Option 1 → Step 5.1. Options 2, 3, 4 → Step 5b.

### Step 5.1: Check Worktree Pool (Option 1 Only)

> Pool CLI invocation: always `npx -y @ai-dossier/worktree-pool@^0.5.1 <cmd>`. The bare `npx worktree-pool` only resolves where the package is installed locally (it 404s elsewhere), and versions before 0.5.1 have a data-loss bug in `gc`. Never pin an older version.

> **Never run `worktree-pool gc`, `refresh`, or any command described as removing worktrees.** The pool directory is shared with developer worktrees; in `@ai-dossier/worktree-pool` ≤ 0.5.0 `gc` deleted every worktree it did not create (ai-dossier#438). Agents may only use `status`, `claim`, `return`, `replenish`, `detect`. If the pool looks broken (claim fails, orphaned entry, missing `.git` admin dir), **fall back to cold worktree creation (Step 6)** and mention the broken pool in the setup milestone (`pool_claimed=false pool_note=<reason>`); pool maintenance is a human task.

Pool worktrees already have `node_modules`, `.env` files and build artifacts — ~2 seconds vs ~3-5 minutes cold.

1. **Check the pool**:
   ```bash
   npx -y @ai-dossier/worktree-pool@^0.5.1 status 2>/dev/null
   ```
   If the command fails (pool not installed or not configured), skip to Step 6.

2. **If warm worktrees are available** (status shows `Warm: ≥ 1`):
   ```bash
   CLAIMED_PATH=$(npx -y @ai-dossier/worktree-pool@^0.5.1 claim --issue <ISSUE_NUMBER> --branch <branch-name> 2>/dev/null)
   ```
   On exit code 0, `CLAIMED_PATH` is the absolute path to the ready worktree, already on the correct branch.

   **If `BASE_BRANCH` ≠ `main`** (epic sub-issue): pool worktrees are pre-warmed from `main`, so rebase onto the correct base — on conflicts `git rebase --abort` and fall back to Step 6 (cold worktree from `BASE_BRANCH`):
   ```bash
   cd "$CLAIMED_PATH"
   git fetch origin "$BASE_BRANCH"
   git rebase "origin/$BASE_BRANCH"
   ```

   **Push the branch immediately** — origin/<branch> is the durable copy of the work from the moment the branch exists (WIP sync rule — see full-cycle-issue's Runstate Milestones). Run after the rebase, if one happened, so origin gets the final state:
   ```bash
   cd "$CLAIMED_PATH"
   git push -u origin <branch-name>
   ```

   - **Skip Steps 6, 7, 8 and 8.5 entirely** — go to Step 9 using `CLAIMED_PATH` as the worktree path.
   - Print `⚡ Claimed pre-warmed worktree from pool (instant setup)`; if rebased, also print `Rebased onto $BASE_BRANCH`.

3. **If pool is empty or claim fails**: print `Pool empty or unavailable — creating cold worktree...` and continue with Step 6.

### Step 5b: Other Modes (Options 2, 3, 4)

Used by the guided/start flows. All three skip Steps 6, 7, 8 and 8.5 and continue at Step 9. `$BASE_BRANCH` is from Step 2 (defaults to `main`).

**Option 2 — Repurpose existing worktree.** ⚡ Fast path: reuses the worktree's node_modules, .env files and build artifacts, so warmup is skipped entirely (~10s instead of ~15min). Nothing is committed or pushed here.

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
ls -d "$REPO_ROOT/worktrees"/*/ 2>/dev/null | xargs -I {} basename {}
# If none: print "No existing worktrees found. Creating a new one instead." and continue with Step 6.
# Else prompt "? Select worktree to repurpose:" as a numbered list, "Choice (1-N):"
cd "$REPO_ROOT/worktrees/<selected-worktree>"
git fetch origin
git checkout -b <new-branch-name> origin/$BASE_BRANCH
cd "$REPO_ROOT/worktrees"
mv <old-worktree-name> <new-worktree-name>   # <type>-<issue-number>-<slugified-title>
git worktree repair                          # fix git's internal worktree tracking
cd "$REPO_ROOT/worktrees/<new-worktree-name>"
git status  # Check for uncommitted files from previous work — ask the user whether to discard stale files
```

**Options 3 and 4 — Current directory / Custom path.** For option 4, first prompt `? Enter the path where you want to work:` and `mkdir -p <custom-path>` if it does not exist. Both create and checkout the branch in place, then push it (WIP sync rule, as in Step 7):

```bash
git fetch origin $BASE_BRANCH
git checkout -b <branch-name> origin/$BASE_BRANCH
git branch --list <branch-name>
git push -u origin <branch-name>
```

### Step 6: Setup Worktree Directory (New Worktree Mode Only)

Skipped when a pool worktree was claimed in Step 5.1.

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
ls -d "$REPO_ROOT/worktrees" 2>/dev/null   # if it doesn't exist, create it and git-ignore it:
mkdir -p "$REPO_ROOT/worktrees"
grep -q "^worktrees/$" "$REPO_ROOT/.gitignore" 2>/dev/null || echo "worktrees/" >> "$REPO_ROOT/.gitignore"
```

**Construct the worktree path (MUST be inside repo)**: `$REPO_ROOT/worktrees/<type>-<issue-number>-<slugified-title>`

> **⚠️ WARNING**: Do NOT create the worktree as a sibling to the repo (e.g., `../worktrees/`). It MUST be inside the repo at `$REPO_ROOT/worktrees/`. Keeping worktrees inside the repo is what makes `ls worktrees/` find them all.

### Step 7: Create Git Branch (New Worktree Mode Only)

Skipped when a pool worktree was claimed in Step 5.1. Create the branch from the base branch without checking it out (the worktree handles checkout), verify it, and **push it immediately** — publish the branch ref to origin right after creation and before any worktree/warmup work (WIP sync rule — origin/<branch> is the durable copy of the work from the moment the branch exists; see full-cycle-issue's Runstate Milestones):

```bash
git fetch origin $BASE_BRANCH
git branch <branch-name> origin/$BASE_BRANCH
git branch --list <branch-name>
git push -u origin <branch-name>
```

### Step 8: Create Git Worktree (New Worktree Mode Only)

Skipped when a pool worktree was claimed in Step 5.1. Use the absolute path from Step 6 so the worktree lands **INSIDE the repo**; this checks out the branch there:

```bash
git worktree add "$REPO_ROOT/worktrees/<type>-<issue-number>-<slug>" <branch-name>
git worktree list   # verify the path is under the repo root, NOT a sibling of it
```

### Step 8.5: Warm Up Worktree [REQUIRED for New Worktree Mode]

Skipped when a pool worktree was claimed in Step 5.1 (already warm).

> **⚠️ MANDATORY STEP**: For worktree mode, you MUST run this warmup workflow before proceeding to Step 9. DO NOT skip this step or proceed without completing the warmup. The worktree is NOT ready for development until this step completes.

Run the warm-worktree workflow — the `warmup_dossier` parameter if one was provided in context, else `imboard-ai/git/warm-worktree`:

```bash
ai-dossier run <warmup_dossier>
```

Provide **source_worktree** (the repository root, where .env files exist) and **target_worktree** (the newly created worktree path). It copies .env files source → target, installs dependencies (npm, pip, etc. — auto-detected), runs the build, runs tests (user choice: skip, smoke, or full), and verifies servers start. Progress and results land in `<worktree-path>/WARMUP-STATUS.md`, which is automatically excluded from git commits.

**Completion Criteria:**
- The `WARMUP-STATUS.md` file MUST exist in the worktree
- The file MUST show status as `COMPLETED` or `FAILED` (not `IN_PROGRESS`)
- If `FAILED`, analyze the errors and suggested fixes in the status file and help the user decide whether to fix, continue anyway, or abort

**DO NOT proceed to Step 9 until this warmup is complete.**

### Step 9: Generate Planning File

*Per-issue mode only — SKIPPED in batch mode: the batch worktree carries no `PLANNING-*` file (member issues' plans live on the issues as `plan:v1` artifact comments).*

Create a scaffold named `PLANNING-{issue-number}-{slug}.md` — in the worktree root (worktree mode, including pool-claimed and repurposed), the current directory, or the custom path, per the mode chosen. Stub only; **plan-issue owns the full planning template** and rewrites this file, preserving any user-added content.

```markdown
# Issue #<NUMBER>: <TITLE>

## Type
<bug|feature>

## Problem Statement
<Issue body content here>
```

### Step 10: Display Results

One summary; fill the parenthesised slots for the mode taken.

**Batch mode** — print the batch summary instead of the per-issue one:

```
Batch setup complete!

Batch:      <batch_id>
Anchor:     #<NUMBER> - <TITLE>
Branch:     batch/<batch_id>-<date>   (from <BASE_BRANCH>)
Worktree:   <worktree-path>          (+ " (claimed from pool)")
Warmup:     <WARMUP-STATUS.md path>  (cold worktree mode only)
Planning:   none — batch mode skips the per-issue scaffold (member plans live on their issues)

Next steps: the scheduler dispatches slot-cycle members in this worktree, one at a time.
```

**Per-issue mode:**

```
Issue workflow setup complete!

Issue:      #<NUMBER> - <TITLE>
Type:       <bug|feature>
Branch:     <branch-name>          (+ " (checked out)" in current-directory and custom-path modes)
Base:       <BASE_BRANCH>
Worktree:   <worktree-path>        (+ " (claimed from pool)" or " (repurposed)"; custom-path prints "Location:   <custom-path>" instead; current-directory omits the line)
Planning:   <planning-file-path>   (worktrees/<type>-<number>-<slug>/PLANNING-<NUMBER>-<slug>.md, ./PLANNING-<NUMBER>-<slug>.md, or <custom-path>/PLANNING-<NUMBER>-<slug>.md)
Warmup:     worktrees/<type>-<number>-<slug>/WARMUP-STATUS.md   (cold worktree mode only)

Environment Status:                (worktree modes only — one line per fact true for the mode taken)
- Pool claim: ⚡ Instant (~2 seconds)   ·  Repurposed from: <old-worktree-name>
- node_modules: ✅ Pre-installed | ✅ Preserved   ·  Dependencies: ✅ Installed (cold)
- .env files: ✅ Pre-copied | ✅ Preserved | ✅ Copied (N files)
- Build: ✅ Pre-built | ✅ Passed  ·  Tests: ⏸️ Skipped (user choice)  ·  Servers: ✅ Verified
- Warm-up: ⏭️ Skipped (not needed)   (repurposed)

Next steps:
1. Navigate to the worktree:
   cd <worktree-path>              (omit this step in current-directory mode)

2. Review and update the planning file with your implementation plan

3. Start working on the issue!

4. When done, create a PR:
   gh pr create --base <BASE_BRANCH> --title "<title>" --body "Closes #<NUMBER>"
```

### Step 11: Runstate Milestone

Post the phase milestone to the issue. This is the last step of the phase — if setup aborts, post `--status blocked --kv reason=<short-slug>` instead and stop. Comments are append-only: never edit or delete a prior milestone. Do not skip this in nested or fleet mode — it is the only state that survives the session.

**Batch mode** — post on the ANCHOR issue, phase `batch-setup`, carrying the batch id:

```bash
ai-dossier runstate post --issue <ANCHOR_NUMBER> --phase batch-setup --status done --run <run_id> \
  --kv batch=<batch_id> \
  --kv branch=<branch-name> \
  --kv worktree=<absolute worktree path> \
  --kv pool_claimed=true|false \
  --kv base_branch=<BASE_BRANCH> \
  --kv remote=pushed
```

`<run_id>` is the batch's run id (minted against the anchor issue). The same keys, rules, and `blocked` fallback apply as below; the CLI stamps `next=batch-validate`.

**Per-issue mode:**

```bash
ai-dossier runstate post --issue <NUMBER> --phase setup --status done --run <run_id> \
  --kv branch=<branch-name> \
  --kv worktree=<absolute worktree path> \
  --kv pool_claimed=true|false \
  --kv base_branch=<BASE_BRANCH> \
  --kv remote=pushed
```

Let the CLI stamp `at=` and compute `next=plan` — do not pass either; never hand-write the comment. `pool_claimed=true` only when Step 5.1 claimed from the pool. In current-directory mode use the absolute repo root for `worktree`. Values contain no spaces (use `-` or `,`); paths are absolute. `remote=pushed` confirms the branch was pushed to origin (Step 5.1 pool-claim, Step 7 cold, Step 5b current-directory/custom-path) — do NOT commit anything in this phase, only publish the branch ref.

## Validation

**All modes:** issue details fetched · branch name follows `{type}/{number}-{slug}` (per-issue) or `batch/<batch_id>-<date>` (batch) and the branch was created · planning file `PLANNING-{number}-{slug}.md` created in the mode's location with all required sections (per-issue mode only) · user shown clear next steps.

- [ ] Branch was pushed to origin (`git push -u origin <branch-name>`) immediately after creation — pool-claim (5.1), cold (7) and current-directory/custom-path (5b) all push; nothing is committed in this phase
- [ ] Runstate milestone comment was posted to the issue, including `remote=pushed`

**Batch mode (batch_id set):**
- [ ] Branch named `batch/<batch_id>-<YYYYMMDD>` from `BASE_BRANCH` — no type prefix, no issue number, no title slug
- [ ] Steps 3, 4 and 9 skipped (no branch-type prompt, no title slug, no `PLANNING-*` scaffold)
- [ ] Milestone posted as `phase=batch-setup` on the ANCHOR issue carrying `batch=<batch_id>`
- [ ] Pool claim or cold path ran unchanged (5.1 / 6–8.5, warmup REQUIRED on the cold path)

**Worktree mode — pool-claimed (ALL required before showing success):**
- [ ] `npx -y @ai-dossier/worktree-pool@^0.5.1 status` was checked
- [ ] No `worktree-pool gc`/`refresh` was run (agents never run pool maintenance)
- [ ] `npx -y @ai-dossier/worktree-pool@^0.5.1 claim` succeeded and returned a path
- [ ] Steps 6-8.5 were skipped (pool worktree is pre-warmed)

**Worktree mode — cold (ALL required before showing success):**
- [ ] `worktrees/` exists and is in `.gitignore`; worktree created at `worktrees/<type>-<number>-<slug>`
- [ ] **Warmup was executed** via `ai-dossier run <warmup_dossier>`, and **WARMUP-STATUS.md exists** in the worktree root showing a final status (COMPLETED or FAILED, not IN_PROGRESS)
- [ ] .env files copied source → target; dependencies installed; build attempted (pass or fail noted)
- [ ] Final summary includes the Environment Status section with warmup results

**Repurpose worktree mode only:**
- [ ] Existing worktree listed and selected; switched to a new branch created from origin/$BASE_BRANCH
- [ ] Directory renamed to match the new issue; `git worktree repair` completed without errors and `git worktree list` shows the correct path and branch
- [ ] Stale files handled (discarded or user acknowledged); warm-up skipped (dependencies already present)

**Current directory and custom path modes only:** branch checked out · custom directory created if needed.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `gh` command not found | Install GitHub CLI: https://cli.github.com/ |
| Not authenticated with GitHub | Run `gh auth login` |
| Issue not found | Verify the issue number and that you have access to the repository |
| Branch already exists | Use the existing branch or choose a different name |
| Worktree path already in use | Check `git worktree list` and choose a different location |
| `npx -y @ai-dossier/worktree-pool@^0.5.1` not found | Pool package is optional — the workflow falls back to cold worktree creation automatically |
| Pool claim fails (no warm worktrees) | Run `npx -y @ai-dossier/worktree-pool@^0.5.1 replenish` to pre-warm spares, or let it fall back to cold creation |

## Notes

- Assumes a GitHub-based repository.
- Modes: **New Worktree** (parallel work — pool ~2s, cold fallback ~3-5min) · **Repurpose** (~10s, reuses dependencies) · **Current directory** (in place) · **Custom path**.
- To pre-warm pool worktrees: `npx -y @ai-dossier/worktree-pool@^0.5.1 replenish --count N`
- Refs: [git worktree](https://git-scm.com/docs/git-worktree) · [GitHub CLI](https://cli.github.com/manual/) · [Conventional Commits](https://www.conventionalcommits.org/)
