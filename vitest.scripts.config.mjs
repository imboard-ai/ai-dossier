import { defineConfig } from 'vitest/config';

// Repo-root vitest run, scoped to `scripts/` only.
//
// Each workspace (packages/core, cli, mcp-server, packages/worktree-pool) owns its
// own vitest.config.ts and is run by `npm run test --workspaces`. This config exists
// solely so the repo scripts under `scripts/` — which belong to no workspace — are
// still covered by `make test`. The explicit `include`/`exclude` keeps it from
// re-running (or double-counting) the workspace suites.
export default defineConfig({
  test: {
    include: ['scripts/**/*.test.mjs'],
    exclude: [
      '**/node_modules/**',
      'worktrees/**',
      'packages/**',
      'cli/**',
      'mcp-server/**',
      'registry/**',
    ],
    environment: 'node',
  },
});
