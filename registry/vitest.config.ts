import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['../test-support/isolated-home.mjs'],
    globals: true,
    environment: 'node',
    // Many tests do `await import('../lib/x')` inside the test body, so the first
    // test of a file pays the cold TS transform of that module graph. On an idle
    // machine that is ~100 ms; under CPU contention (a batch member's gate
    // running beside another suite, #893/#919) it blew the 5 s default. Timeouts
    // are only a ceiling for load, not an assertion, so raising them keeps every
    // check intact.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    exclude: ['**/worktrees/**', '**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      thresholds: {
        statements: 60,
        functions: 60,
        lines: 60,
        branches: 50,
      },
    },
  },
});
