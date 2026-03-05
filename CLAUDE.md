# CLAUDE.md

## CRITICAL: Never checkout branches in this directory

This is the main worktree. Switching branches here breaks all parallel agents.

**Always create a worktree:**
```bash
git worktree add "$(git rev-parse --show-toplevel)/worktrees/<branch-name>" -b <branch-name>
cd "$(git rev-parse --show-toplevel)/worktrees/<branch-name>"
```

**Before any work, verify:** `pwd | grep -q "worktree" || echo "STOP: create a worktree first"`
