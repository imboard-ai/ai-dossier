# @ai-dossier/worktree-pool

Pre-warmed git worktree pool for instant issue setup. Eliminates the ~3-5 minute cold start (git worktree add + npm install + build) by maintaining a pool of ready-to-use worktrees.

## Install

```bash
npm install -g @ai-dossier/worktree-pool
```

Or use directly with npx:

```bash
npx @ai-dossier/worktree-pool status
```

## Commands

| Command | Description |
|---------|-------------|
| `worktree-pool status` | Show pool inventory (warm/assigned/stale counts) |
| `worktree-pool replenish [--count N]` | Pre-warm spares up to target count |
| `worktree-pool claim --issue N --branch B` | Claim a warm worktree, print path |
| `worktree-pool return --path P` | Return worktree to pool for reuse |
| `worktree-pool refresh` | Fetch origin + rebuild in all warm worktrees |
| `worktree-pool gc` | Remove stale/orphaned/excess worktrees |
| `worktree-pool init` | Configure pool directory for this project |

## Quick Start

```bash
# Initialize pool in your repo
worktree-pool init

# Pre-warm 3 worktrees
worktree-pool replenish --count 3

# Check pool status
worktree-pool status

# Claim a worktree for an issue (~2 seconds)
WORKTREE_PATH=$(worktree-pool claim --issue 42 --branch feature/42-add-dashboard)
cd "$WORKTREE_PATH"

# Return worktree to pool when done
worktree-pool return --path "$WORKTREE_PATH"

# Clean up stale worktrees
worktree-pool gc
```

## How It Works

1. **Replenish** creates worktrees from `origin/main` on temp branches, runs `npm install` and builds
2. **Claim** renames a warm worktree, switches to your feature branch — instant setup
3. **Return** recycles the worktree back to pool on a fresh temp branch
4. **GC** removes stale entries (>72h) and reconciles disk state vs pool state

## Integration

Works with [ai-dossier](https://github.com/imboard-ai/ai-dossier) workflows:

- `setup-issue-workflow` v1.6.0+ auto-claims from pool when available
- `full-cycle-issue` v2.5.0+ returns worktrees to pool after merge
- `batch-issues.sh --pool` pre-warms before spawning agents

## License

AGPL-3.0-only
