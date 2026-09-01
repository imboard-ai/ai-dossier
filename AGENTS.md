# AGENTS.md

## CRITICAL: Never checkout branches in this directory

This is the main worktree. Switching branches here breaks all parallel agents.

**Always create a worktree:**
```bash
git worktree add "$(git rev-parse --show-toplevel)/../worktrees/<branch-name>" -b <branch-name>
cd "$(git rev-parse --show-toplevel)/../worktrees/<branch-name>"
```

**Before any work, verify:** `pwd | grep -q "worktree" || echo "STOP: create a worktree first"`

## Before debugging infrastructure

Read `docs/explanation/infrastructure-lessons.md` first. It records failures that
already cost significant time here — silent OIDC trust mismatches, SSM ciphertext
passing as a value, Vercel preview failures that are actually a Neon branch quota,
stale CLI versions producing wrong signatures. Several present with symptoms far from
their cause, and at least three were made worse by reasoning about how something
"should" work instead of printing the actual value.

## Before planning an issue

Read `docs/agent-traps.md` in full and grep it for terms from the issue title and
affected paths — it is a grep-first symptom → trap → fix index of traps already
learned in this repo. Append a row when a run required a CI fix or surfaces a trap a
future agent should search for first.

## Project Quick Reference

| Directory | Purpose |
|-----------|---------|
| `packages/core/` | Shared library — parsing, verification, linting, risk assessment |
| `packages/sched/` | Deterministic scheduler core — queue, slots, persistent state machine |
| `cli/` | CLI tool (`dossier verify`, `dossier search`, etc.) |
| `mcp-server/` | MCP server — tools/resources/prompts for LLM integration |
| `registry/` | Vercel-deployed registry API |
| `packages/worktree-pool/` | Pre-warmed git worktree management |

```bash
make build-all    # build core → mcp-server + cli (skip lint)
make build        # lint then build
make test         # test all workspaces + repo scripts (scripts/*.test.mjs)
make check        # biome format + lint with auto-fix
```

- Node 20+ required (vitest v4 + vite v7 dropped Node 18)
- Linter/formatter: **Biome** (not ESLint/Prettier) — `npx biome check --write .`
- Build order: core first, then sched, then mcp-server and cli (sched, mcp-server and cli all
  depend on core; cli also depends on sched)
- Changing a publishable package's `src/`/`bin/` requires bumping that package's `package.json`
  version — CI's `version-bump` job fails the PR otherwise (label `no-release-needed` opts out)
- MCP integration: see `mcp-server/README.md`

## Publishing dossiers and skills

Dossiers and skills are **not** committed to this repo; the registry is the source of
truth. To change one, run `ai-dossier run imboard-ai/meta/publish-dossier` — it holds the
exact sign → lint → verify → publish → refresh-all-machines recipe and the known walls
(shadow CLI copies, expired login, which key to sign with). Workflow family reference:
`ai-dossier run imboard-ai/git/issue-workflows-guide`.
