---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "Setup Issue Workflow",
  "version": "1.9.0",
  "status": "Stable",
  "objective": "Create a workflow for GitHub issues that fetches issue details, creates appropriately named branches, optionally sets up git worktrees with environment warmup (or claims from a pre-warmed pool), and generates planning files for structured development",
  "category": [
    "development"
  ],
  "inputs": {
    "optional": [
      {
        "name": "warmup_dossier",
        "description": "Which warm-worktree dossier to run for worktree warmup. Override this to use a project-specific warmup (e.g., imboard-ai/imboard/warm-worktree for pnpm+SSM projects).",
        "type": "string",
        "default": "imboard-ai/git/warm-worktree"
      },
      {
        "name": "base_branch",
        "description": "Target branch to branch from and merge into. Overrides issue body parsing ('merges into `<branch>`'). Use for epic sub-issues or when the target is not main.",
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
  "name": "setup-issue-workflow",
  "checksum": {
    "algorithm": "sha256",
    "hash": "b0cc346c8c062396f17249f2f686836e15e4110141e45d75820f80dc1f5e31b0"
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

## Context to Gather

### 1. Issue Information

Collect the GitHub issue number from user input. Then fetch:
- Issue title
- Issue labels (especially "bug" or "feature")
- Issue body/description
- Issue assignees (optional)

### 2. Worktree Location

**Default pattern**: Create worktrees in a `worktrees/` subdirectory **INSIDE** the repository root.

> **⚠️ CRITICAL**: The `worktrees/` directory must be INSIDE the repository, NOT as a sibling to it. This allows users to find worktrees with a simple `ls worktrees/` from within the repo.

**Correct structure** (worktrees INSIDE repo):
```
/home/user/projects/myrepo/                              <- repo root
/home/user/projects/myrepo/worktrees/                    <- worktrees dir INSIDE repo
/home/user/projects/myrepo/worktrees/feature-42-.../     <- each worktree
/home/user/projects/myrepo/worktrees/bug-99-.../
/home/user/projects/myrepo/src/
/home/user/projects/myrepo/package.json
```

**WRONG structure** (worktrees OUTSIDE repo - DO NOT DO THIS):
```
/home/user/projects/myrepo/                              <- repo root
/home/user/projects/worktrees/                           <- WRONG! Outside repo
/home/user/projects/worktrees/feature-42-.../            <- WRONG! Can't find with ls
```

**Why this pattern:**
- Deterministic - `ls worktrees/` from repo shows all worktrees
- No need to run `git worktree list` to find folders
- Organized - all worktrees in one place inside the repo
- Clean - doesn't clutter parent directory with sibling folders

**Path construction:**
```bash
# Get the repo root first
REPO_ROOT=$(git rev-parse --show-toplevel)

# Worktree path is INSIDE the repo
$REPO_ROOT/worktrees/<type>-<issue-number>-<slugified-title>/
```

**Concrete example:**
If repo is at `/home/user/projects/imboard-monorepo/` and branch is `feature/42-add-user-preferences`:
```
/home/user/projects/imboard-monorepo/worktrees/feature-42-add-user-preferences/
```

**First-time setup:**
If the `worktrees/` directory doesn't exist, create it INSIDE the repo and ensure it's git-ignored:
```bash
# Make sure you're in the repo root
cd $(git rev-parse --show-toplevel)
mkdir -p worktrees
# Add to .gitignore if not already present
grep -q "^worktrees/$" .gitignore 2>/dev/null || echo "worktrees/" >> .gitignore
```

## Actions to Perform

### Step 1: Get Issue Number

Prompt the user for the GitHub issue number if not already provided:
```
? GitHub issue number:
```

### Step 2: Fetch Issue Details

Use the GitHub CLI to fetch issue information:

```bash
gh issue view <ISSUE_NUMBER> --json title,labels,body,assignees
```

Extract:
- `title` - Issue title for branch naming
- `labels` - Check for "bug" or "feature" labels
- `body` - Issue description for PLANNING.md
- `base_branch` - Extract from body (see below)

**Resolve base branch** — determines which branch to branch from and target PRs against:

1. **If `base_branch` input parameter was provided** (and is not `"auto"`): use it directly. Skip issue body parsing.
2. **Otherwise**: extract from the issue body. Look for `merges into \`<branch-name>\`` (case-insensitive):
   ```bash
   # Example: "**Branch**: `migrate/setup` → merges into `epic/migrate-shadcn`"
   # Extract: epic/migrate-shadcn
   BASE_BRANCH=$(gh issue view <ISSUE_NUMBER> --json body --jq '.body' | grep -oiP 'merges into `\K[^`]+' | head -1)
   if [ -z "$BASE_BRANCH" ]; then
     BASE_BRANCH="main"
   fi
   ```
3. **Print**: `Base branch: $BASE_BRANCH`

Store `BASE_BRANCH` for use in Steps 5.1, 5.5, 7, and 8. This value should also be communicated in the output summary (Step 10) so downstream dossiers can use it.

### Step 3: Determine Branch Type

Based on issue labels:

1. **If "bug" label present**: Use `bug/` prefix
2. **If "feature" label present**: Use `feature/` prefix
3. **If both or neither**: Prompt user to choose:
   ```
   ? Issue type:
     1) bug - This is a bug fix
     2) feature - This is a new feature
   Choice (1-2):
   ```

### Step 4: Create Branch Name

Generate the branch name:

1. **Slugify the title**:
   - Convert to lowercase
   - Replace spaces with hyphens
   - Remove special characters
   - Truncate to reasonable length (50 chars max)

2. **Construct branch name**:
   ```
   {type}/{issue-number}-{slugified-title}
   ```

   Examples:
   - `bug/123-fix-login-redirect-issue`
   - `feature/456-add-user-dashboard`

### Step 5: Choose Workflow Mode

Ask the user where they want to work on this issue:

```
? Where do you want to work on this issue?
  1) Create a git worktree (recommended for parallel work)
  2) Repurpose existing worktree (fastest - skips npm install)
  3) Current directory (just create branch and planning file here)
  4) Custom location (specify your own path)
Choice (1-4):
```

If user chooses option 2, show existing worktrees and prompt for selection (see Step 5.5).

If user chooses option 4, prompt for the path:
```
? Enter the path where you want to work:
```

Based on the choice:
- **Option 1 (New Worktree)**: Continue with Step 5.1 (Check Worktree Pool)
- **Option 2 (Repurpose)**: Continue with Step 5.5 (Repurpose Existing Worktree)
- **Option 3 (Current directory)**: Skip to Step 7 (Create Git Branch) with checkout
- **Option 4 (Custom path)**: Skip to Step 7 (Create Git Branch), then create/navigate to custom path

### Step 5.1: Check Worktree Pool (Option 1 Only)

**Skip this step unless user chose option 1.**

Before creating a cold worktree, check if a pre-warmed worktree pool is available. Pool worktrees already have `node_modules`, `.env` files, and build artifacts — claiming one takes ~2 seconds vs ~3-5 minutes for a cold start.

1. **Check if the pool is configured and has warm worktrees**:
   ```bash
   npx worktree-pool status 2>/dev/null
   ```
   If the command fails (pool not installed or not configured), skip to Step 6 (cold worktree creation).

2. **If pool has warm worktrees available** (status shows `Warm: ≥ 1`):
   ```bash
   CLAIMED_PATH=$(npx worktree-pool claim --issue <ISSUE_NUMBER> --branch <branch-name> 2>/dev/null)
   ```
   - If claim succeeds (exit code 0), `CLAIMED_PATH` contains the absolute path to the ready worktree.
   - The worktree is already on the correct branch with `node_modules`, `.env` files, and build artifacts.

   **If `BASE_BRANCH` ≠ `main`** (epic sub-issue): Pool worktrees are pre-warmed from `main`. You must rebase onto the correct base:
   ```bash
   cd "$CLAIMED_PATH"
   git fetch origin "$BASE_BRANCH"
   git rebase "origin/$BASE_BRANCH"
   ```
   If the rebase has conflicts, abort and fall back to cold worktree creation:
   ```bash
   git rebase --abort
   # Continue to Step 6 (cold worktree from BASE_BRANCH)
   ```

   - **Skip Steps 6, 7, 8, and 8.5 entirely** — go directly to Step 9 (Generate Planning File) using `CLAIMED_PATH` as the worktree path.
   - Print: `⚡ Claimed pre-warmed worktree from pool (instant setup)`
   - If rebased: also print `Rebased onto $BASE_BRANCH`

3. **If pool is empty or claim fails**:
   - Print: `Pool empty or unavailable — creating cold worktree...`
   - Continue with Step 6 (normal cold worktree creation).

### Step 5.5: Repurpose Existing Worktree (Option 2 Only)

**Skip this step unless user chose option 2.**

> **⚡ FAST PATH**: This option reuses an existing worktree's node_modules, .env files, and build artifacts. It takes ~10 seconds instead of ~15 minutes.

1. **List existing worktrees**:
   ```bash
   REPO_ROOT=$(git rev-parse --show-toplevel)
   ls -d "$REPO_ROOT/worktrees"/*/ 2>/dev/null | xargs -I {} basename {}
   ```

2. **If no worktrees exist**, inform user and fall back to option 1:
   ```
   No existing worktrees found. Creating a new one instead.
   ```
   Then continue with Step 6.

3. **Prompt user to select a worktree**:
   ```
   ? Select worktree to repurpose:
     1) feature-3-refactor-shared-metadata
     2) bug-42-fix-login
     3) feature-50-add-dashboard
   Choice (1-3):
   ```

4. **Navigate to the selected worktree and switch branch**:
   ```bash
   cd "$REPO_ROOT/worktrees/<selected-worktree>"
   git fetch origin
   git checkout -b <new-branch-name> origin/$BASE_BRANCH
   ```
   > `$BASE_BRANCH` was extracted in Step 2 (defaults to `main`).

5. **Rename the worktree directory**:
   ```bash
   cd "$REPO_ROOT/worktrees"
   mv <old-worktree-name> <new-worktree-name>
   ```

   Where `<new-worktree-name>` follows the pattern: `<type>-<issue-number>-<slugified-title>`

6. **Fix git's internal worktree tracking**:
   ```bash
   git worktree repair
   ```

7. **Clean up stale files** (optional but recommended):
   ```bash
   cd "$REPO_ROOT/worktrees/<new-worktree-name>"
   git status  # Check for uncommitted files from previous work
   # If there are stale files, ask user whether to discard them
   ```

8. **Skip warm-worktree**: Since node_modules, .env files, and build artifacts already exist, skip Step 8.5 entirely.

9. **Continue to Step 9** (Generate Planning File).

**Verification for repurpose mode:**
- [ ] Worktree was successfully switched to new branch
- [ ] Directory was renamed to match new issue
- [ ] `git worktree repair` completed without errors
- [ ] `git worktree list` shows correct path and branch

### Step 6: Setup Worktree Directory (New Worktree Mode Only)

**Skip this step if user chose option 2, 3, or 4, or if a pool worktree was claimed in Step 5.1.**

Create the worktree in the `worktrees/` subdirectory **INSIDE the repository root**.

1. **Get the repository root**:
   ```bash
   REPO_ROOT=$(git rev-parse --show-toplevel)
   ```

2. **Check if `worktrees/` directory exists inside the repo**:
   ```bash
   ls -d "$REPO_ROOT/worktrees" 2>/dev/null
   ```

3. **If it doesn't exist, create it and add to .gitignore**:
   ```bash
   mkdir -p "$REPO_ROOT/worktrees"
   # Add to .gitignore if not already present
   grep -q "^worktrees/$" "$REPO_ROOT/.gitignore" 2>/dev/null || echo "worktrees/" >> "$REPO_ROOT/.gitignore"
   ```

4. **Construct the worktree path (MUST be inside repo)**:
   ```
   $REPO_ROOT/worktrees/<type>-<issue-number>-<slugified-title>
   ```

   Example: If `REPO_ROOT=/home/user/projects/imboard-monorepo`:
   ```
   /home/user/projects/imboard-monorepo/worktrees/feature-42-add-user-preferences
   ```

> **⚠️ WARNING**: Do NOT create the worktree as a sibling to the repo (e.g., `../worktrees/`). It MUST be inside the repo at `$REPO_ROOT/worktrees/`.

### Step 7: Create Git Branch

**Skip this step if user chose option 2 (Repurpose) or if a pool worktree was claimed in Step 5.1.**

**For New Worktree mode (option 1)**:
Create the branch from the base branch without checking it out (the worktree will handle checkout):

```bash
git fetch origin $BASE_BRANCH
git branch <branch-name> origin/$BASE_BRANCH
```

**For Current directory or Custom path mode (options 3 or 4)**:
Create and checkout the branch from the base branch:

```bash
git fetch origin $BASE_BRANCH
git checkout -b <branch-name> origin/$BASE_BRANCH
```

> `$BASE_BRANCH` was extracted in Step 2 (defaults to `main`).

Verify branch was created:
```bash
git branch --list <branch-name>
```

### Step 8: Create Git Worktree (New Worktree Mode Only)

**Skip this step if user chose option 2, 3, or 4, or if a pool worktree was claimed in Step 5.1.**

Create the worktree using the path from Step 6 (**INSIDE the repo**):

```bash
# Use absolute path to ensure worktree is inside repo
git worktree add "$REPO_ROOT/worktrees/<type>-<issue-number>-<slug>" <branch-name>
```

Example (repo at `/home/user/projects/imboard-monorepo`):
```bash
git worktree add /home/user/projects/imboard-monorepo/worktrees/feature-42-add-user-preferences feature/42-add-user-preferences
```

This command checks out the branch in the new worktree directory.

Verify worktree was created **inside the repo**:
```bash
git worktree list
# Should show path like: /home/user/projects/imboard-monorepo/worktrees/feature-42-...
# NOT like: /home/user/projects/worktrees/feature-42-... (WRONG - outside repo!)
```

**For Custom path mode (option 4)**:
If the custom path doesn't exist, create it:
```bash
mkdir -p <custom-path>
```

### Step 8.5: Warm Up Worktree [REQUIRED for New Worktree Mode]

**Skip this step if user chose option 2 (Repurpose), 3 (Current directory), 4 (Custom path), or if a pool worktree was claimed in Step 5.1.**

> **Note**: Option 2 (Repurpose) and pool-claimed worktrees skip this because they already have node_modules, .env files, and build artifacts.

> **⚠️ MANDATORY STEP**: For worktree mode, you MUST run this warmup workflow before proceeding to Step 9. DO NOT skip this step or proceed without completing the warmup. The worktree is NOT ready for development until this step completes.

Run the warm-worktree workflow to prepare the development environment.

Use the `warmup_dossier` parameter if one was provided in context. Otherwise, default to `imboard-ai/git/warm-worktree`.

```bash
ai-dossier run <warmup_dossier>
```

When running the warmup workflow, you must provide:
- **source_worktree**: The repository root (where .env files exist)
- **target_worktree**: The newly created worktree path (e.g., `worktrees/feature-42-...`)

This workflow will:
1. **Copy .env files** from the source worktree (main) to the new worktree
2. **Install dependencies** (npm, pip, etc. - auto-detected)
3. **Run build** to verify it compiles
4. **Run tests** (user choice: skip, smoke, or full)
5. **Verify servers** can start (start, check, stop)

Progress and results are tracked in `<worktree-path>/WARMUP-STATUS.md`.

**Note:** This file is automatically excluded from git commits.

**Completion Criteria:**
- The `WARMUP-STATUS.md` file MUST exist in the worktree
- The file MUST show status as `COMPLETED` or `FAILED` (not `IN_PROGRESS`)
- If `FAILED`, the agent should analyze errors and help the user decide whether to fix, continue anyway, or abort

**On Failure:**
- The status file will contain error details and suggested fixes
- The LLM agent should analyze errors and propose solutions
- User can choose to fix issues, continue anyway, or abort

**DO NOT proceed to Step 9 until this warmup is complete.**

### Step 9: Generate Planning File

Create the planning file using the format `PLANNING-{issue-number}-{slug}.md`:

**Location based on workflow mode:**
- **Worktree mode** (including pool-claimed): Create in worktree root
- **Current directory mode**: Create in current directory
- **Custom path mode**: Create in the custom path specified

```markdown
# Issue #<NUMBER>: <TITLE>

## Type
<bug|feature>

## Problem Statement
<Issue body content here>

## Implementation Checklist
- [ ] Understand the issue and gather context
- [ ] Identify files that need modification
- [ ] Implement the changes
- [ ] Add/update tests
- [ ] Update documentation if needed
- [ ] Self-review the changes
- [ ] Create pull request

## Files to Modify
<!-- List the files you expect to modify -->

## Testing Strategy
<!-- Describe how you will test the changes -->
- [ ] Unit tests
- [ ] Integration tests
- [ ] Manual testing

## Notes
<!-- Additional notes, questions, or considerations -->

## Related Issues/PRs
- Issue: #<NUMBER>
```

### Step 10: Display Results

Show a summary based on the workflow mode chosen:

**For Worktree mode (pool-claimed):**
```
Issue workflow setup complete!

Issue:      #<NUMBER> - <TITLE>
Type:       <bug|feature>
Branch:     <branch-name>
Base:       <BASE_BRANCH>
Worktree:   <worktree-path> (claimed from pool)
Planning:   <worktree-path>/PLANNING-<NUMBER>-<slug>.md

Environment Status:
- Pool claim: ⚡ Instant (~2 seconds)
- node_modules: ✅ Pre-installed
- .env files: ✅ Pre-copied
- Build: ✅ Pre-built

Next steps:
1. Navigate to the worktree:
   cd <worktree-path>

2. Review and update the planning file with your implementation plan

3. Start working on the issue!

4. When done, create a PR:
   gh pr create --title "<title>" --body "Closes #<NUMBER>"
```

**For Worktree mode (cold — no pool):**
```
Issue workflow setup complete!

Issue:      #<NUMBER> - <TITLE>
Type:       <bug|feature>
Branch:     <branch-name>
Base:       <BASE_BRANCH>
Worktree:   worktrees/<type>-<number>-<slug>
Planning:   worktrees/<type>-<number>-<slug>/PLANNING-<NUMBER>-<slug>.md
Warmup:     worktrees/<type>-<number>-<slug>/WARMUP-STATUS.md

Environment Status:
- .env files: ✅ Copied (3 files)
- Dependencies: ✅ Installed
- Build: ✅ Passed
- Tests: ⏸️ Skipped (user choice)
- Servers: ✅ Verified

Next steps:
1. Navigate to the worktree:
   cd worktrees/<type>-<number>-<slug>

2. Review and update the planning file with your implementation plan

3. Start working on the issue!

4. When done, create a PR:
   gh pr create --base <BASE_BRANCH> --title "<title>" --body "Closes #<NUMBER>"
```

**For Current directory mode:**
```
Issue workflow setup complete!

Issue:      #<NUMBER> - <TITLE>
Type:       <bug|feature>
Branch:     <branch-name> (checked out)
Base:       <BASE_BRANCH>
Planning:   ./PLANNING-<NUMBER>-<slug>.md

Next steps:
1. Review and update the planning file with your implementation plan

2. Start working on the issue!

3. When done, create a PR:
   gh pr create --base <BASE_BRANCH> --title "<title>" --body "Closes #<NUMBER>"
```

**For Custom path mode:**
```
Issue workflow setup complete!

Issue:      #<NUMBER> - <TITLE>
Type:       <bug|feature>
Branch:     <branch-name> (checked out)
Base:       <BASE_BRANCH>
Location:   <custom-path>
Planning:   <custom-path>/PLANNING-<NUMBER>-<slug>.md

Next steps:
1. Navigate to your workspace:
   cd <custom-path>

2. Review and update the planning file with your implementation plan

3. Start working on the issue!

4. When done, create a PR:
   gh pr create --base <BASE_BRANCH> --title "<title>" --body "Closes #<NUMBER>"
```

## Validation

**All modes:**
- [ ] Issue details were successfully fetched from GitHub
- [ ] Branch name follows the convention: `{type}/{number}-{slug}`
- [ ] Git branch was created successfully
- [ ] Planning file (PLANNING-{number}-{slug}.md) was created
- [ ] Planning file contains all required sections
- [ ] User was shown clear next steps

**Worktree mode — pool-claimed (ALL required before showing success):**
- [ ] `npx worktree-pool status` was checked
- [ ] `npx worktree-pool claim` succeeded and returned a path
- [ ] Steps 6-8.5 were skipped (pool worktree is pre-warmed)
- [ ] Planning file is in the claimed worktree root

**Worktree mode — cold (ALL required before showing success):**
- [ ] `worktrees/` directory exists and is in `.gitignore`
- [ ] Git worktree was created at `worktrees/<type>-<number>-<slug>`
- [ ] **WARMUP-STATUS.md exists** in the worktree root
- [ ] **Warmup workflow was executed** via `ai-dossier run <warmup_dossier>`
- [ ] WARMUP-STATUS.md shows final status (COMPLETED or FAILED, not IN_PROGRESS)
- [ ] .env files were copied from source to target worktree
- [ ] Dependencies were installed
- [ ] Build was attempted (pass or fail noted)
- [ ] Planning file is in the worktree root
- [ ] Final summary includes Environment Status section with warmup results

**Repurpose worktree mode only:**
- [ ] Existing worktree was listed and user selected one
- [ ] New branch was created from origin/main
- [ ] Worktree directory was renamed to match new issue
- [ ] `git worktree repair` completed successfully
- [ ] Stale files were handled (discarded or user acknowledged)
- [ ] Planning file is in the repurposed worktree
- [ ] Warm-up was skipped (dependencies already present)

**Current directory mode only:**
- [ ] Branch was checked out
- [ ] Planning file is in current directory

**Custom path mode only:**
- [ ] Branch was checked out
- [ ] Custom directory was created (if needed)
- [ ] Planning file is in the custom path

## Troubleshooting

**Issue**: `gh` command not found
**Solution**: Install GitHub CLI: https://cli.github.com/

**Issue**: Not authenticated with GitHub
**Solution**: Run `gh auth login` to authenticate

**Issue**: Issue not found
**Solution**: Verify the issue number and that you have access to the repository

**Issue**: Branch already exists
**Solution**: Either use the existing branch or choose a different name

**Issue**: Worktree path already in use
**Solution**: Check `git worktree list` and choose a different location

**Issue**: `npx worktree-pool` command not found
**Solution**: The worktree pool package is not installed. This is optional — the workflow falls back to cold worktree creation automatically.

**Issue**: Pool claim fails (no warm worktrees)
**Solution**: Run `npx worktree-pool replenish` to pre-warm spares, or let the workflow fall back to cold creation.

## Examples

### Example 1: Worktree Mode (Pool Claim — Instant)

For issue #42 with title "Add user preferences page" and "feature" label, with a pre-warmed pool available:

**Input**:
```
? GitHub issue number: 42
? Where do you want to work on this issue?
  1) Create a git worktree (recommended for parallel work)
  2) Repurpose existing worktree (fastest - skips npm install)
  3) Current directory (just create branch and planning file here)
  4) Custom location (specify your own path)
Choice: 1
```

**Output**:
```
⚡ Claimed pre-warmed worktree from pool (instant setup)

Issue workflow setup complete!

Issue:      #42 - Add user preferences page
Type:       feature
Branch:     feature/42-add-user-preferences-page
Worktree:   worktrees/feature-42-add-user-preferences-page (claimed from pool)
Planning:   worktrees/feature-42-add-user-preferences-page/PLANNING-42-add-user-preferences-page.md

Environment Status:
- Pool claim: ⚡ Instant (~2 seconds)
- node_modules: ✅ Pre-installed
- .env files: ✅ Pre-copied
- Build: ✅ Pre-built

Next steps:
1. Navigate to the worktree:
   cd worktrees/feature-42-add-user-preferences-page

2. Review and update the planning file with your implementation plan

3. Start working on the issue!

4. When done, create a PR:
   gh pr create --title "Add user preferences page" --body "Closes #42"
```

### Example 2: Worktree Mode (Cold — No Pool)

For issue #42 with title "Add user preferences page" and "feature" label, with no pool available:

**Input**:
```
? GitHub issue number: 42
? Where do you want to work on this issue?
  1) Create a git worktree (recommended for parallel work)
Choice: 1
```

**Output**:
```
Pool empty or unavailable — creating cold worktree...

Issue workflow setup complete!

Issue:      #42 - Add user preferences page
Type:       feature
Branch:     feature/42-add-user-preferences-page
Worktree:   worktrees/feature-42-add-user-preferences-page
Planning:   worktrees/feature-42-add-user-preferences-page/PLANNING-42-add-user-preferences-page.md
Warmup:     worktrees/feature-42-add-user-preferences-page/WARMUP-STATUS.md

Environment Status:
- .env files: ✅ Copied (2 files)
- Dependencies: ✅ Installed
- Build: ✅ Passed
- Tests: ⏸️ Skipped (user choice)
- Servers: ✅ Verified

Next steps:
1. Navigate to the worktree:
   cd worktrees/feature-42-add-user-preferences-page

2. Review and update the planning file with your implementation plan

3. Start working on the issue!

4. When done, create a PR:
   gh pr create --title "Add user preferences page" --body "Closes #42"
```

### Example 3: Repurpose Worktree Mode (Fastest)

For issue #99 with title "Fix login button" and "bug" label, repurposing an existing worktree:

**Input**:
```
? GitHub issue number: 99
? Where do you want to work on this issue?
  1) Create a git worktree (recommended for parallel work)
  2) Repurpose existing worktree (fastest - skips npm install)
  3) Current directory (just create branch and planning file here)
  4) Custom location (specify your own path)
Choice: 2

? Select worktree to repurpose:
  1) feature-3-refactor-shared-metadata
  2) feature-50-add-dashboard
Choice: 1
```

**Output**:
```
Issue workflow setup complete!

Issue:      #99 - Fix login button
Type:       bug
Branch:     bug/99-fix-login-button
Worktree:   worktrees/bug-99-fix-login-button (repurposed)
Planning:   worktrees/bug-99-fix-login-button/PLANNING-99-fix-login-button.md

Environment Status:
- Repurposed from: feature-3-refactor-shared-metadata
- node_modules: ✅ Preserved
- .env files: ✅ Preserved
- Warm-up: ⏭️ Skipped (not needed)

Next steps:
1. Navigate to the worktree:
   cd worktrees/bug-99-fix-login-button

2. Review and update the planning file with your implementation plan

3. Start working on the issue!

4. When done, create a PR:
   gh pr create --title "Fix login button" --body "Closes #99"
```

### Example 4: Current Directory Mode

For issue #101 with title "Update readme" and "feature" label:

**Input**:
```
? GitHub issue number: 101
? Where do you want to work on this issue?
  1) Create a git worktree (recommended for parallel work)
  2) Repurpose existing worktree (fastest - skips npm install)
  3) Current directory (just create branch and planning file here)
  4) Custom location (specify your own path)
Choice: 3
```

**Output**:
```
Issue workflow setup complete!

Issue:      #101 - Update readme
Type:       feature
Branch:     feature/101-update-readme (checked out)
Planning:   ./PLANNING-101-update-readme.md

Next steps:
1. Review and update the planning file with your implementation plan

2. Start working on the issue!

3. When done, create a PR:
   gh pr create --title "Update readme" --body "Closes #101"
```

## Notes

- This workflow assumes a GitHub-based repository
- Four workflow modes are available:
  - **New Worktree mode**: Best for working on multiple issues simultaneously. Automatically checks the worktree pool first for instant setup (~2s); falls back to cold worktree creation (~3-5min) if no pool is available.
  - **Repurpose Worktree mode**: Fast option (~10 seconds) - reuses existing worktree's dependencies
  - **Current directory mode**: Simplest option, works in place
  - **Custom path mode**: For users with their own directory structure
- The planning file (PLANNING-{number}-{slug}.md) helps maintain focus and track progress
- To pre-warm pool worktrees: `npx worktree-pool replenish --count N`
- Consider adding this workflow to your `.claude.md` for easy access

## References

- [Git Worktrees Documentation](https://git-scm.com/docs/git-worktree)
- [GitHub CLI Documentation](https://cli.github.com/manual/)
- [Branch Naming Conventions](https://www.conventionalcommits.org/)
