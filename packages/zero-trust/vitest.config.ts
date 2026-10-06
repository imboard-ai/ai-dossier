import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['../../test-support/isolated-home.mjs'],
    environment: 'node',
    exclude: ['**/worktrees/**', '**/node_modules/**', '**/dist/**', 'fixtures/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
});
