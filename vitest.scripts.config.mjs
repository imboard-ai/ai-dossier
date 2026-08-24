import { defineConfig } from 'vitest/config';

// Repo-root vitest run, scoped to `scripts/` only.
//
// Each workspace (packages/core, cli, mcp-server, packages/worktree-pool) owns its
// own vitest.config.ts and is run by `npm run test --workspaces`. This config exists
// solely so the repo scripts under `scripts/` — which belong to no workspace — are
// still covered by `make test`. `include` is rooted at `scripts/`, which is what
// keeps the workspace suites from being re-run (or double-counted) here; listing
// the workspace directories again in `exclude` would just be a fourth copy of a
// package list that already lives in the root `workspaces` field.
export default defineConfig({
  test: {
    include: ['scripts/**/*.test.mjs'],
    exclude: ['**/node_modules/**'],
    environment: 'node',
  },
});
