import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // #829: `@ai-dossier/sched` is a workspace dependency whose `main`
      // (`dist/index.js`) is a compiled CommonJS bundle — without this,
      // importing it from a CLI test file loads that `dist/` output via
      // native `require`. `vi.mock('node:child_process')` set in a CLI test
      // then never intercepts `execFileSync` calls made from *inside*
      // sched's own code (`resolveProjectRepo`, `issueCloseTruth`, etc.):
      // Vite's SSR module runner does not rewrite `require()` calls made
      // *inside* an already-required CJS file — "Vite plugins, aliases,
      // transforms, and module mocks do not apply to required files"
      // (vitest's own common-errors guide) — so the real subprocess runs
      // instead, silently, with no thrown error to flag the gap (see
      // docs/agent-traps.md).
      //
      // `test.server.deps.inline: ['@ai-dossier/sched']` (the config this
      // issue originally proposed) does NOT fix this for the same reason:
      // it only changes whether Vite transforms the package's entry file,
      // not what its *own* `require()` calls resolve through — inlining
      // the compiled CJS `dist/index.js` was verified empirically to leave
      // `vi.mock('node:child_process')` just as unreachable (a CLI test
      // asserting on `execFileSync.mock.calls` after an inlined-but-CJS
      // sched call still saw zero calls recorded).
      //
      // Aliasing the specifier straight to sched's TypeScript **source**
      // instead sidesteps the CJS boundary entirely: `src/index.ts` uses
      // real ESM `import`, which Vite transforms and resolves through its
      // own module graph — including every module sched itself imports —
      // so a mocked `node:child_process` reaches every exec call in the
      // package, not just the ones the CLI itself makes.
      '@ai-dossier/sched': path.resolve(__dirname, '../packages/sched/src/index.ts'),
    },
  },
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
