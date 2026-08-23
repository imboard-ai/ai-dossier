# @ai-dossier/worktree-pool

[![npm version](https://img.shields.io/npm/v/@ai-dossier/worktree-pool)](https://www.npmjs.com/package/@ai-dossier/worktree-pool)
[![npm downloads](https://img.shields.io/npm/dm/@ai-dossier/worktree-pool)](https://www.npmjs.com/package/@ai-dossier/worktree-pool)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://github.com/imboard-ai/ai-dossier/blob/main/LICENSE)

Pre-warmed git worktree pool for instant issue setup. Eliminates the ~3-5 minute cold start (git worktree add + install + build) by maintaining a pool of ready-to-use worktrees.

Works with pnpm, yarn, bun and npm — the package manager, lockfile and build command are detected from the project, or pinned explicitly in `.worktree-pool.json`.

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
| `worktree-pool gc [--dry-run] [--yes]` | Remove stale/orphaned pool worktrees (never anything else) |
| `worktree-pool init` | Configure pool directory for this project |
| `worktree-pool detect [dir]` | Print the detected package-manager env as JSON |

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

# Clean up stale worktrees (prints the plan first, then asks)
worktree-pool gc --dry-run   # show what would go
worktree-pool gc --yes       # remove it, no prompt (required when stdin is not a TTY)
```

## How It Works

```
replenish          claim               return
    |                 |                   |
    v                 v                   v
 base_ref  ──> [warm worktree] ──> [assigned] ──> [recycled/warm]
                 install             rename to       reset to
                 + build             feature branch  temp branch
```

1. **Replenish** creates worktrees from `base_ref` (default `origin/main`) on temp branches, then runs the warm commands (install + build)
2. **Claim** renames a warm worktree, switches to your feature branch — instant setup (~2s)
3. **Return** recycles the worktree back to pool on a fresh temp branch
4. **GC** removes stale entries (>72h) and reconciles disk state vs pool state — only for worktrees the pool created (see [Sharing the pool directory](#sharing-the-pool-directory))

Claim and return only re-run the warm commands when the project's lockfile changed between the worktree's base commit and `base_ref` — otherwise the existing `node_modules` and build output are reused.

### Pool State

Pool state is stored in `worktrees/.pool-state.json` (automatically gitignored). Each worktree transitions through:

```
creating -> warming -> warm -> assigned -> recycling -> warm
                                       -> destroying
```

Concurrent access is protected by atomic `mkdir`-based file locking.

## Sharing the pool directory

`pool_dir` may be — and usually is — the same directory you keep your own
worktrees in. **The pool never touches a worktree it did not create.**

A worktree in `pool_dir` belongs to the pool only when either:

- its path is recorded in `.pool-state.json`, **or**
- its directory name matches the pool's own `pool-<timestamp>-<pid>` naming
  **and** it has a `pool/spare-*` temp branch checked out.

Everything else — your branch worktrees, plain directories, even a directory
that happens to match the pool's naming but is on a branch of yours — is
*foreign*. Foreign worktrees are listed by `status` and `gc` as
`foreign, skipped` and are never removed, reset, or cleaned by `gc`, `refresh`,
or a failed `return`. Branches are held to the same rule: `gc` only ever deletes
`pool/spare-*` refs.

Because deletions are irreversible for uncommitted work, `gc` also prints the
exact list it is about to remove and then either asks for confirmation (TTY) or
requires `--yes`. Use `--dry-run` to see the plan and exit.

```bash
$ worktree-pool gc --dry-run
Will remove 1 item(s):
  [stale] /repo/../worktrees/pool-1750000000000-4242
      stale past 72h (warmed 2026-08-13T15:13:22.790Z); recorded in .pool-state.json

Foreign, skipped (2) — not created by the pool:
  /repo/../worktrees/2332-budget-composable-dashboard
      not recorded in .pool-state.json and the directory name does not match the pool's own pool-<timestamp>-<pid> naming
  /repo/../worktrees/fix-1173-playwright-start
      not recorded in .pool-state.json and the directory name does not match the pool's own pool-<timestamp>-<pid> naming

Dry run — nothing was removed.
```

If a pool worktree's directory has drifted — the recorded path now holds a
different branch — `gc` drops the stale row from `.pool-state.json` and leaves
the directory on disk rather than guessing.

## Configuration

### Pool sizing — `.pool-state.json`

| Setting | Default | Description |
|---------|---------|-------------|
| `target_spares` | 5 | Number of warm spares to maintain |
| `max_pool_size` | 10 | Maximum total worktrees in pool |
| `stale_after_hours` | 72 | Hours before a warm worktree is considered stale |

### Project layout — `.worktree-pool.json`

Lives at the repo root. Every key is optional; `worktree-pool init` writes `pool_dir` into it without touching the others.

| Key | Default | Description |
|-----|---------|-------------|
| `pool_dir` | `../worktrees` | Directory holding pool worktrees, relative to the repo root |
| `project_subdir` | _(none)_ | Package root relative to the worktree root, for repos whose `package.json` is nested (e.g. `"main"`). Warm commands run here, and the lockfile is looked for here |
| `warm_commands` | _(detected)_ | Explicit warm-up commands as argv arrays. Wins over detection |
| `base_ref` | `origin/main` | Ref that pool worktrees are branched from and reset to. The remote to fetch is taken from its prefix (`upstream/develop` fetches `upstream`) |

```json
{
  "pool_dir": "../worktrees",
  "project_subdir": "main",
  "base_ref": "origin/develop",
  "warm_commands": [
    ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"],
    ["pnpm", "run", "build:libs"]
  ]
}
```

### Package-manager detection

When `warm_commands` is not set, the warm-up is derived from the project directory (`<worktree>/<project_subdir>`):

1. **Package manager** — the `packageManager` field in `package.json` wins; otherwise the first lockfile found, probed in the order `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb` / `bun.lock`, `package-lock.json`; otherwise npm.
2. **Install** — the frozen variant when the lockfile is present, a plain install when it is not (`npm ci`, `pnpm install --frozen-lockfile`, and `yarn install --immutable` all fail without a lockfile).
3. **Build** — `build:libs` if that script exists, else `build`, else no build step.

| Manager | Lockfile | Install (lockfile present) | Install (no lockfile) |
|---------|----------|----------------------------|-----------------------|
| pnpm | `pnpm-lock.yaml` | `pnpm install --frozen-lockfile --prefer-offline` | `pnpm install --prefer-offline` |
| yarn | `yarn.lock` | `yarn install --immutable` | `yarn install` |
| bun | `bun.lockb` / `bun.lock` | `bun install` | `bun install` |
| npm | `package-lock.json` | `npm ci` | `npm install` |

Inspect what would run:

```bash
worktree-pool detect            # this repo's package root
worktree-pool detect ./apps/api # any directory
```

```json
{
  "pm": "pnpm",
  "lockfile": "pnpm-lock.yaml",
  "installCmd": ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"],
  "buildCmd": ["pnpm", "run", "build:libs"]
}
```

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
