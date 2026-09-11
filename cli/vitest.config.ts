import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: ['**/worktrees/**', '**/node_modules/**', '**/dist/**'],
    // The default 5000ms flaked on CI's shared runner: the sched auto-upgrade
    // tests do real tmpdir fs work per run (~1s locally, 38-run distribution
    // 926-1322ms, unimodal, never near the limit) and one publish-packages run
    // (#696) saw the 5s default exceeded on the throttled runner, skipping the
    // release. 30s keeps a genuine hang a fast failure while giving fs latency
    // on shared runners room (packages/worktree-pool uses the same pattern at
    // 60s).
    testTimeout: 30_000,
    setupFiles: ['./src/__tests__/helpers/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['dist/', 'node_modules/', 'src/__tests__/'],
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 65,
        lines: 70,
      },
    },
  },
});
