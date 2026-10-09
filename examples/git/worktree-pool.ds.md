---
name: 'worktree-pool'
description: 'Manage a pool of pre-warmed git worktrees for instant issue setup — claim a ready worktree in ~2 seconds instead of ~3-5 minutes of cold start'
metadata:
  dossier.dossier_schema_version: '1.0.0'
  dossier.title: 'Worktree Pool'
  dossier.version: '1.0.3'
  dossier.protocol_version: '"1.0"'
  dossier.status: 'Stable'
  dossier.last_updated: '2026-10-09'
  dossier.objective: 'Manage a pool of pre-warmed git worktrees for instant issue setup — claim a ready worktree in ~2 seconds instead of ~3-5 minutes of cold start'
  dossier.category: '["development"]'
  dossier.tags: '["worktree","pool","git","pre-warm","performance"]'
  dossier.risk_level: 'medium'
  dossier.risk_factors: '["modifies_files"]'
  dossier.requires_approval: 'false'
  dossier.destructive_operations: '["Creates and removes git worktrees","Creates and deletes temporary git branches"]'
  dossier.authors: '[{"name":"Yuval Dimnik"}]'
  dossier.checksum: '{"algorithm":"sha256","hash":"25cf4fae3e56e71bb5cdc6682460105f02f32de2e608a648910b3bd49e055900"}'
  dossier.signature: '{"algorithm":"ed25519","covers":"spec-frontmatter+body","key_id":"imboard-ai","public_key":"m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=","signature":"GaR/VbN5p6Mvh4gJL0yCUxYeAR8XQgF2kxiL/Nxf0jtVWbCDSHE46bFzWu7P1zU5+0lTlOXs16M15oEVGn+pBg==","signed_at":"2026-10-09T21:38:03.388Z","signed_by":"Yuval Dimnik <yuval.dimnik@gmail.com>"}'
---
# Worktree Pool

## Objective

Manage a pool of pre-warmed git worktrees with `node_modules` and build artifacts already present. Claiming a worktree takes ~2 seconds instead of the ~3-5 minutes needed for cold setup (git worktree add + npm install + build).

## Prerequisites

- [ ] Node.js >= 20 installed
- [ ] `@ai-dossier/worktree-pool` package available (`npm install -g @ai-dossier/worktree-pool` or via monorepo)
- [ ] You are in a git repository with a remote named `origin`
- [ ] The repository has a `main` branch on `origin`

## Context to Gather

### Pool Directory

The pool stores worktrees in a directory outside the main repo. On first use, the CLI auto-discovers or prompts for the location, saving it to `.worktree-pool.json` at the git root.

Discovery order:
1. Read `.worktree-pool.json` config at git root
2. Infer from existing worktrees via `git worktree list`
3. Default to `../worktrees` (sibling of repo root)
4. If interactive, prompt the user

### Pool State

State is stored in `.pool-state.json` inside the pool directory. It tracks each worktree's status, branch, base commit, and assignment. Concurrent access is protected by an atomic `mkdir`-based lock.

## Actions to Perform

### Initialize the Pool

Run once per project to configure the pool directory:

```bash
npx worktree-pool init
```

This creates `.worktree-pool.json` at the git root and ensures the pool directory exists.

### Replenish (Pre-warm Worktrees)

Create warm worktrees ready to be claimed:

```bash
npx worktree-pool replenish --count 3
```

This creates 3 worktrees, each with:
- A temporary branch based on `origin/main`
- `npm install` completed
- `make build-core build-mcp build-cli` completed
- `.env` files copied from the main repo

Without `--count`, it fills up to the configured `target_spares` (default: 5).

### Claim a Worktree

When starting work on an issue, claim a warm worktree instead of creating one from scratch:

```bash
npx worktree-pool claim --issue 123 --branch feature/123-add-dashboard
```

This:
1. Finds the first warm worktree
2. Checks freshness against `origin/main` (rebuilds if `package-lock.json` changed)
3. Creates the issue branch
4. Renames the directory to match the branch
5. Prints the absolute path to stdout

The output path is ready for `cd` — all dependencies and build artifacts are present.

### Return a Worktree

After a PR is merged, return the worktree to the pool for reuse:

```bash
npx worktree-pool return --path /path/to/worktree
```

This resets to `origin/main`, assigns a new pool ID, and marks it warm again. If the reset fails, the worktree is destroyed and removed from the pool.

### Check Pool Status

```bash
npx worktree-pool status
```

Shows warm/assigned/creating counts, spares needed, and per-worktree details.

### Refresh All Warm Worktrees

Fetch latest `origin/main` and rebuild all warm worktrees:

```bash
npx worktree-pool refresh
```

### Garbage Collection

Remove stale and orphaned worktrees:

```bash
npx worktree-pool gc
```

Stale = warm worktrees older than `stale_after_hours` (default: 72h).
Orphans = state entries without a directory on disk, or directories not tracked in state.

## Validation

- [ ] `npx worktree-pool init` creates `.worktree-pool.json`
- [ ] `npx worktree-pool replenish --count 1` creates a warm worktree with node_modules and build
- [ ] `npx worktree-pool claim --issue 999 --branch feature/999-test` returns a path in under 5 seconds
- [ ] The claimed worktree has the correct branch checked out
- [ ] `npx worktree-pool return --path <path>` recycles the worktree back to warm
- [ ] `npx worktree-pool status` shows correct counts
- [ ] `npx worktree-pool gc` removes stale entries

## Troubleshooting

**Issue**: `claim` says "No warm worktrees available"
**Solution**: Run `npx worktree-pool replenish` first to pre-warm spares.

**Issue**: The pool is "at capacity" but the assigned issues are already merged
**Solution**: Runs exited without returning their slots. Run `ai-dossier run imboard-ai/git/worktree-hygiene`: it returns slots whose issues are closed, merged, clean and unpushed, logs every decision with full timestamps, and is safe to run repeatedly.

**Issue**: Lock timeout error
**Solution**: Check if another process is running. If not, remove the `.pool-lock` directory inside the pool dir.

**Issue**: Worktree claim is slow (rebuilding)
**Solution**: The worktree's `origin/main` is stale and `package-lock.json` changed, triggering `npm install` + rebuild. Run `npx worktree-pool refresh` periodically to keep warm worktrees fresh.

**Issue**: Pool directory not found
**Solution**: Run `npx worktree-pool init` to configure the pool directory.

## Examples

### Batch Issue Processing with Pool

Pre-warm worktrees before spawning agents:

```bash
# Pre-warm 5 worktrees
npx worktree-pool replenish --count 5

# Each agent claims a worktree
WORKTREE=$(npx worktree-pool claim --issue 100 --branch feature/100-foo)
cd "$WORKTREE"
# ... work on the issue ...

# After merge, return it
npx worktree-pool return --path "$WORKTREE"

# Clean up stale worktrees
npx worktree-pool gc
```

### Integration with batch-issues.sh

```bash
scripts/batch-issues.sh --pool 100..105
```

The `--pool` flag automatically replenishes before spawning and runs GC after.

## Notes

- Pool worktrees use temporary branches (`pool/spare-*`) — they never check out `main`
- Paths in state are relative to the pool directory (portable if folder moves)
- Default config: 5 target spares, 10 max pool size, 72h stale threshold
- Config can be adjusted in `.pool-state.json` under the `config` key
