# CLAUDE.md — Rules for all AI agents in this repo

## CRITICAL: Never work directly in this directory

**DO NOT run `git checkout -b` or `git switch -c` in this directory.**

This is the `main` worktree. If you switch branches here, you break every other agent working in parallel.

**Always create a git worktree:**
```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
mkdir -p "$REPO_ROOT/worktrees"
git worktree add "$REPO_ROOT/worktrees/<branch-name>" -b <branch-name>
cd "$REPO_ROOT/worktrees/<branch-name>"
```

**Before starting any work, verify:**
```bash
pwd | grep -q "worktree" && echo "OK" || echo "STOP: you are in the main directory, create a worktree first"
```

If you are not in a `worktrees/` subdirectory, STOP. Do not proceed.

## Monorepo structure

```
cli/           — CLI package (@ai-dossier/cli)
packages/core/ — Core library (@ai-dossier/core)
mcp-server/    — MCP server (@ai-dossier/mcp-server)
registry/      — Registry API (Vercel)
```

## Common commands

```bash
make build          # Build all packages
make test           # Run all tests
make test-coverage  # Tests with coverage
npm run lint        # Biome lint check
npm run lint:fix    # Biome auto-fix
```

## Conventions

- Test framework: vitest (cli, core, mcp-server), jest (registry)
- Linter/formatter: biome
- Commits: conventional commits (`feat:`, `fix:`, `chore:`, `docs:`)
- Branches: `feature/<issue>-<slug>`, `fix/<issue>-<slug>`, `bug/<issue>-<slug>`
