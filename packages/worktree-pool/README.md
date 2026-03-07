# @ai-dossier/worktree-pool

[![npm version](https://img.shields.io/npm/v/@ai-dossier/worktree-pool)](https://www.npmjs.com/package/@ai-dossier/worktree-pool)
[![npm downloads](https://img.shields.io/npm/dm/@ai-dossier/worktree-pool)](https://www.npmjs.com/package/@ai-dossier/worktree-pool)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://github.com/imboard-ai/ai-dossier/blob/main/LICENSE)

Pre-warmed git worktree pool for instant issue setup. Eliminates the ~3-5 minute cold start (git worktree add + npm install + build) by maintaining a pool of ready-to-use worktrees.

## Install

```bash
npm install -g @ai-dossier/worktree-pool
```

Or use directly with npx:

```bash
npx @ai-dossier/worktree-pool status
```

Requires Node.js >= 20.0.0.

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

```
replenish          claim               return
    |                 |                   |
    v                 v                   v
origin/main ──> [warm worktree] ──> [assigned] ──> [recycled/warm]
                 npm install         rename to       reset to
                 + build             feature branch  temp branch
```

1. **Replenish** creates worktrees from `origin/main` on temp branches, runs `npm install` and builds
2. **Claim** renames a warm worktree, switches to your feature branch — instant setup (~2s)
3. **Return** recycles the worktree back to pool on a fresh temp branch
4. **GC** removes stale entries (>72h) and reconciles disk state vs pool state

### Pool State

Pool state is stored in `worktrees/.pool-state.json` (automatically gitignored). Each worktree transitions through:

```
creating -> warming -> warm -> assigned -> recycling -> warm
                                       -> destroying
```

Concurrent access is protected by atomic `mkdir`-based file locking.

## Configuration

Default pool settings (configurable via `.pool-state.json`):

| Setting | Default | Description |
|---------|---------|-------------|
| `target_spares` | 5 | Number of warm spares to maintain |
| `max_pool_size` | 10 | Maximum total worktrees in pool |
| `stale_after_hours` | 72 | Hours before a warm worktree is considered stale |

## Integration

Works with [ai-dossier](https://github.com/imboard-ai/ai-dossier) workflows:

- `setup-issue-workflow` v1.6.0+ auto-claims from pool when available
- `full-cycle-issue` v2.5.0+ returns worktrees to pool after merge
- `batch-issues.sh --pool` pre-warms before spawning agents

### Batch Example

```bash
# Pre-warm pool, then spawn agents for issues 100-105
./scripts/batch-issues.sh --pool 100..105
```

## Development

Part of the [ai-dossier](https://github.com/imboard-ai/ai-dossier) monorepo.

```bash
npm run build -w packages/worktree-pool    # build
npm run test -w packages/worktree-pool     # test
make build-pool                            # build via Makefile
```

## License

[AGPL-3.0](https://github.com/imboard-ai/ai-dossier/blob/main/LICENSE)
