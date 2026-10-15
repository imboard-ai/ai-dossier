# Worktree Registry

This file tracks active git worktrees for this project.

**Last updated**: 2025-11-07

---

## What Are Git Worktrees?

Git worktrees allow you to have multiple working directories from the same repository, each checked out to different branches.

**Benefits**:
- Work on multiple features in parallel
- No need to stash or switch branches constantly
- Each worktree is isolated (no risk of mixing changes)
- All worktrees share the same git history (saves disk space)

---

## Active Worktrees

| Worktree | Branch | Created | Status | Purpose | References |
|----------|--------|---------|--------|---------|------------|
| main/ | main | 2025-11-07 | Active | Primary development | - |

---

## Worktree Lifecycle

### Creating a New Worktree

```bash
# From the main/ directory
cd main

# Create a worktree for a new feature branch
git worktree add ../feature-name -b feature/name

# Or for an existing branch
git worktree add ../feature-name existing-branch-name

# List all worktrees
git worktree list
```

**After creation, update the table above** with the new worktree information.

---

### Working in a Worktree

```bash
# Navigate to the worktree
cd ../feature-name

# Work normally - edit files, commit, push
git add .
git commit -m "Your changes"
git push origin feature/name
```

---

### Updating This Registry

When you create or remove a worktree, **update the table above**:

1. **Add a row** when creating a worktree
2. **Update status** to "Merged", "Abandoned", or "Paused" when done
3. **Move to Completed section** (create below) after removal

**Example entry**:
```
| feature-auth/ | feature/auth | 2025-11-07 | In Progress | OAuth2 login | #123, JIRA-456 |
```

---

### Deleting a Worktree

```bash
# From main/ directory
cd main

# When feature is merged and you're done with it
git worktree remove ../feature-name

# Delete the remote branch if needed
git push origin --delete feature/name
```

`git worktree remove` already deletes the worktree's metadata, so no prune is
needed. **Never run a bare `git worktree prune`**: it also deletes the metadata
of any worktree that was moved or renamed without `git worktree repair
<new-path>`, and that folder then fails every git command
(`fatal: not a git repository`). To clear leftover metadata safely, see
[Safe prune](#safe-prune) below.

**After removal, update the registry** - mark as completed or remove the row.

---

## Common Worktree Commands

```bash
# List all worktrees (shows path, branch, commit)
git worktree list

# Create a new worktree
git worktree add <path> <branch>

# Create worktree with new branch
git worktree add <path> -b <new-branch>

# Remove a worktree
git worktree remove <path>

# Remove a worktree (force, even if dirty)
git worktree remove --force <path>

# Repair a worktree you moved or renamed (always pass the NEW path)
git worktree repair <new-path>

# Lock a worktree (prevent automatic removal)
git worktree lock <path>

# Unlock a worktree
git worktree unlock <path>
```

---

## Team Collaboration

### Important: Worktrees are Local

**Key concept**: Worktrees are a local organizational tool. They are **NOT** shared via git.

**What IS shared**:
- ✅ Branches (via `git push`/`git pull`)
- ✅ Commits
- ✅ This registry file (`WORKTREES.md`)

**What is NOT shared**:
- ❌ Worktree directories (local paths)
- ❌ Which worktrees you have locally

### Team Workflow

**Developer A creates a worktree and shares the branch**:
```bash
cd ~/projects/foo/main
git worktree add ../feature-x -b feature/x
cd ../feature-x
# ... work, commit ...
git push -u origin feature/x

# Update WORKTREES.md (so team knows)
# Commit and push the registry
```

**Developer B pulls the branch (in their own worktree)**:
```bash
cd ~/dev/foo/main  # Different local path, same repo
git fetch origin
git worktree add ../feature-x feature/x  # Creates their own worktree
cd ../feature-x
# ... collaborate on same branch ...
```

**Both developers**:
- Work on the same **branch** (shared via git)
- Have different **worktree directories** (local paths)
- Push/pull to collaborate (standard git workflow)

---

## Troubleshooting

### "fatal: 'branch' is already checked out"

**Problem**: You're trying to checkout a branch that's already checked out in another worktree.

**Solution**:
- Use a different branch name, OR
- Remove the existing worktree first: `git worktree remove <path>`, OR
- Work in the existing worktree

**Why**: Git prevents the same branch from being checked out in multiple worktrees to avoid conflicts.

---

### "Cannot remove working tree"

**Problem**: Worktree has uncommitted changes.

**Solution**:
```bash
# Option 1: Commit the changes
cd <worktree-path>
git add .
git commit -m "Save work in progress"
cd ../main
git worktree remove <worktree-path>

# Option 2: Force remove (⚠️ DATA LOSS - uncommitted changes deleted)
git worktree remove --force <worktree-path>
```

---

### "Worktree is locked"

**Problem**: Worktree is locked and can't be removed.

**Solution**:
```bash
git worktree unlock <path>
git worktree remove <path>
```

---

### Safe prune

`git worktree prune` deletes the metadata (`.git/worktrees/<id>/`) of every
worktree whose recorded folder is gone — including one that was only moved or
renamed. Repair moved worktrees first, then prune what is truly gone:

```bash
# From the main worktree. POOL_DIR: the pool directory `worktree-pool status` prints, if the repo uses one.
COMMON=$(git rev-parse --path-format=absolute --git-common-dir)
LC_ALL=C git worktree prune --dry-run -v 2>&1 | sed -n 's|^Removing worktrees/\([^:]*\):.*|\1|p' | while read -r id; do
  ADMIN=$(realpath "$COMMON/worktrees/$id")
  OLD_PARENT=$(dirname "$(dirname "$(cat "$ADMIN/gitdir")")")   # a rename usually stays in the same parent
  MATCHES=$(for d in "$OLD_PARENT"/*/ "$(git rev-parse --show-toplevel)"/worktrees/*/ ${POOL_DIR:+"$POOL_DIR"/*/}; do
    [ -f "$d.git" ] || continue
    t=$(sed -n 's/^gitdir: //p' "$d.git")
    [ "$(cd "$d" && realpath -m "$t")" = "$ADMIN" ] && realpath "$d"
  done | sort -u)
  case $(printf '%s' "$MATCHES" | grep -c .) in
    0) echo "gone: $id (no folder links to it)" ;;
    1) git worktree repair "$MATCHES" >/dev/null 2>&1 && echo "repaired: $id -> $MATCHES" || echo "FAILED to repair $MATCHES — do not prune" ;;
    *) echo "SKIP: $id is claimed by several folders (a copy?) — resolve by hand:"; echo "$MATCHES" ;;
  esac
done
LC_ALL=C git worktree prune --dry-run -v   # re-check: prune only if every id still listed printed "gone:"
```

Then run `git worktree prune` only if every id the re-check still lists printed
`gone:`. A `SKIP:` line means two folders claim one worktree (one is a copy):
remove the copy, then re-run. A moved worktree living outside the searched
directories needs `git worktree repair <that-folder>` by hand first. When in
doubt, skip the prune — leftover metadata is harmless; a pruned admin dir is not.
`realpath -m` is GNU coreutils (Linux; `brew install coreutils` on macOS).

### Can't find my code after restructuring

**Problem**: After running this dossier, code is in `main/` subdirectory.

**Solution**:
```bash
# Your code is now here
cd main

# Update IDE workspace/project to point to main/ directory
# Update any scripts with hardcoded paths
```

---

## Additional Resources

- **[Git Worktree Documentation](https://git-scm.com/docs/git-worktree)** - Official git docs
- **[Git Worktree Tutorial](https://www.gitkraken.com/learn/git/git-worktree)** - Visual guide

---

*This registry is version-controlled. Update it whenever you create or remove worktrees to keep the team informed.*
