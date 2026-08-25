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
| `worktree-pool status [--json]` | Show pool inventory (warm/assigned/broken counts); `--json` prints the whole inventory, including per-entry `status`, for callers |
| `worktree-pool replenish [--count N]` | Pre-warm spares up to target count |
| `worktree-pool claim --issue N --branch B` | Claim a warm worktree, print path |
| `worktree-pool return --path P [--json]` | Return worktree to pool for reuse; self-checks on success, and on failure marks the entry `broken` and exits non-zero naming the step |
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
3. **Return** recycles the worktree back to pool on a fresh temp branch, then verifies the result against reality — the entry really reads `warm`, no tracked file is dirty, and the new `pool/spare-*` branch is really checked out — before reporting success. A failure at any step leaves the entry `broken` (never `assigned`, never a falsely-`warm` spare), leaves the directory on disk, and exits non-zero naming the step
4. **GC** removes broken entries and stale entries (>72h) and reconciles disk state vs pool state — only for worktrees the pool created (see [Sharing the pool directory](#sharing-the-pool-directory))

Claim and return only re-run the warm commands when the project's lockfile changed between the worktree's base commit and `base_ref` — otherwise the existing `node_modules` and build output are reused.

### Pool State

Pool state is stored in `worktrees/.pool-state.json` (automatically gitignored). Each worktree transitions through:

```
creating -> warming -> warm -> assigned -> recycling -> warm
                                       -> destroying
                                          recycling -> broken   (a failed return)
```

A `broken` entry is never handed out — `claim` only ever selects `warm`.

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
`foreign, skipped` and are never removed, reset, or cleaned by `gc` or
`refresh`. A failed `return` removes nothing at all — not even its own worktree
(see [Broken entries](#broken-entries-a-failed-return)). Branches are held to
the same rule: `gc` only ever deletes
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

### Corrupted directories

A pool directory that is still on disk but that git no longer has an admin dir
for (`.git/worktrees/<id>`) is **corrupted**: every git command inside it fails
with `fatal: not a git repository`. `status` lists these separately, and
`claim` skips them and hands out the next warm spare instead of failing:

```bash
$ worktree-pool status
...
Corrupted directories (no git admin dir, skipped by claim): 1
  pool-1787468026330-1079658  recorded in .pool-state.json as pool-1787468026330-1079658, no longer a registered worktree — its git admin dir is gone (a `git worktree prune` after an unrepaired rename), so every git command inside it fails
Run 'worktree-pool gc --yes' to clear corrupted pool directories.
```

Corrupted directories are reported, never removed silently — `gc` clears them
under the same ownership rules as everything else.

### Broken entries (a failed `return`)

Distinct from a corrupted *directory* above: a **broken entry** is a pool entry
whose `return` failed part-way. Rather than being destroyed, it is left behind
with `status: "broken"`, recording which step failed and why, so the failure is
visible instead of silent:

```bash
$ worktree-pool return --path ../worktrees/bug-453-x
Error: return failed at step 'rename': Recycle target already exists: /repo/../worktrees/pool-...
Pool entry pool-1787468026330-1079658 is now marked 'broken' and was NOT destroyed.
  Worktree left at: /repo/../worktrees/bug-453-x
  Inspect with 'worktree-pool status --json'; clear with 'worktree-pool gc'.
```

`status` counts them in their own column and names the failed step:

```
Warm: 2  Assigned: 1  Creating: 0  Broken: 1  Other: 0  Total: 4

Worktrees:
  pool-1787468026330-1079658  [broken]  bug-453-x -> issue #453 (bug/453-x) failed at 'rename': Recycle target already exists
```

`claim` never hands one out. The directory is deliberately left on disk so the
failure can be inspected; `gc` collects broken entries immediately — they are
unusable from the moment they are marked and occupy `max_pool_size` capacity
until removed — under the same ownership rules as everything else.

## Checking the pool from a script

`status --json` prints the whole inventory on stdout, so a caller can assert
that a `return` actually landed instead of trusting the exit code of whoever
claimed it did:

```bash
worktree-pool status --json | jq '.worktrees[] | select(.status == "broken")'
```

Note the two distinct fields, matching the two sections above: the top-level
`broken[]` array lists *corrupted directories* (#443), while an entry with
`"status": "broken"` in `worktrees[]` is a *failed return* (#453). The
`broken_entries` count covers the latter.

`return --path P --json` prints the same self-check as a JSON object:

```json
{
  "id": "pool-1787468026330-1079658",
  "path": "/repo/../worktrees/pool-1787468026330-1079658",
  "verification": {
    "entry_status": "warm",
    "directory_clean": true,
    "dirty_entries": [],
    "checked_out_branch": "pool/spare-pool-1787468026330-1079658",
    "expected_branch": "pool/spare-pool-1787468026330-1079658"
  }
}
```

### Programmatic use

```ts
import { returnWorktree, ReturnFailure } from '@ai-dossier/worktree-pool';

try {
  const result = returnWorktree(worktreePath);
  // result.id, result.path, result.verification
} catch (err) {
  if (err instanceof ReturnFailure) {
    // err.step (a ReturnStep), err.entryId, err.worktreePath
    // The entry is 'broken' and the directory was NOT destroyed — unless
    // err.markError is non-null, which means the marking write itself failed
    // and pool state should be re-checked before the next claim.
  }
}
```

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
