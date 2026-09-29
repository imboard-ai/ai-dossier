import { describe, expect, it } from 'vitest';
import { assessIssue, inferPackages, workspaceOf } from '../batch-compose';
import {
  discoverWorkspaceLayout,
  packageOfPath,
  parseWorkspaceConfig,
  type WorkspaceFileReader,
  type WorkspaceLayout,
  type WorkspaceRoot,
} from '../workspace-layout';

function reader(files: Record<string, string>, dirs: string[] = []): WorkspaceFileReader {
  return { topLevelDirs: () => dirs, readFile: (p) => files[p] ?? null };
}

const IMBOARD: WorkspaceLayout = {
  roots: [{ prefix: 'main', file: 'pnpm-workspace.yaml', globs: ['packages/*'], excludes: [] }],
};

describe('parseWorkspaceConfig (#801)', () => {
  it('reads pnpm-workspace.yaml packages, with negations', () => {
    expect(
      parseWorkspaceConfig(
        'pnpm-workspace.yaml',
        'packages:\n  - "packages/*"\n  - "!packages/legacy"\nshamefullyHoist: true\n'
      )
    ).toEqual({ globs: ['packages/*'], excludes: ['packages/legacy'] });
  });
  it('reads package.json workspaces in both array and yarn-object shapes', () => {
    expect(parseWorkspaceConfig('package.json', '{"workspaces":["apps/*","./tools/x/"]}')).toEqual({
      globs: ['apps/*', 'tools/x'],
      excludes: [],
    });
    expect(
      parseWorkspaceConfig('package.json', '{"workspaces":{"packages":["libs/*"]}}')?.globs
    ).toEqual(['libs/*']);
  });
  it('reads lerna.json packages', () => {
    expect(parseWorkspaceConfig('lerna.json', '{"packages":["pkgs/*"]}')?.globs).toEqual([
      'pkgs/*',
    ]);
  });
  it('returns null for a package.json without workspaces, invalid text, or empty globs', () => {
    expect(parseWorkspaceConfig('package.json', '{"name":"x"}')).toBeNull();
    expect(parseWorkspaceConfig('package.json', 'not json')).toBeNull();
    expect(parseWorkspaceConfig('pnpm-workspace.yaml', 'packages: []')).toBeNull();
  });
});

describe('discoverWorkspaceLayout', () => {
  it('finds a root-level config', () => {
    const l = discoverWorkspaceLayout(reader({ 'package.json': '{"workspaces":["packages/*"]}' }));
    expect(l?.roots).toEqual([
      { prefix: '', file: 'package.json', globs: ['packages/*'], excludes: [] },
    ]);
  });
  it("finds a nested root (imboard's main/) when the repo root declares nothing", () => {
    const l = discoverWorkspaceLayout(
      reader({ 'main/pnpm-workspace.yaml': 'packages:\n  - packages/*\n' }, [
        'main',
        'docs',
        '.github',
        'scripts',
      ])
    );
    expect(l?.roots.map((r) => r.prefix)).toEqual(['main']);
  });
  it('prefers pnpm-workspace.yaml over package.json in the same directory', () => {
    const l = discoverWorkspaceLayout(
      reader({ 'pnpm-workspace.yaml': 'packages: [a/*]', 'package.json': '{"workspaces":["b/*"]}' })
    );
    expect(l?.roots[0].globs).toEqual(['a/*']);
  });
  it('is null when no config exists anywhere (caller falls back to the heuristic)', () => {
    expect(
      discoverWorkspaceLayout(reader({ 'package.json': '{"name":"x"}' }, ['main']))
    ).toBeNull();
  });
});

describe('packageOfPath', () => {
  it('maps repo-relative and root-relative paths to the declared workspace', () => {
    expect(packageOfPath('main/packages/backend/src/a.ts', IMBOARD)).toBe('packages/backend');
    expect(packageOfPath('packages/backend/src/a.ts', IMBOARD)).toBe('packages/backend');
    expect(packageOfPath('packages/backend/', IMBOARD)).toBe('packages/backend');
  });
  it('paths outside every declared workspace are NOT a pseudo-package', () => {
    expect(packageOfPath('main/scripts/ci-parity.sh', IMBOARD)).toBeNull();
    expect(packageOfPath('scripts/x.sh', IMBOARD)).toBeNull();
    expect(packageOfPath('main/.github/workflows/deploy.yml', IMBOARD)).toBeNull();
    expect(packageOfPath('packages/README.md', IMBOARD)).toBeNull();
  });
  it('honours negated globs, literal globs and a trailing **', () => {
    const l: WorkspaceLayout = {
      roots: [
        {
          prefix: '',
          file: 'package.json',
          globs: ['packages/*', 'tools/cli', 'apps/**'],
          excludes: ['packages/legacy'],
        },
      ],
    };
    expect(packageOfPath('packages/legacy/x.ts', l)).toBeNull();
    expect(packageOfPath('packages/core/x.ts', l)).toBe('packages/core');
    expect(packageOfPath('tools/cli/src/a.ts', l)).toBe('tools/cli');
    expect(packageOfPath('tools/other/a.ts', l)).toBeNull();
    expect(packageOfPath('apps/web/src/a.ts', l)).toBe('apps/web');
  });
  it('multi-root resolution is order-independent and never guesses (#926 review)', () => {
    const apps: WorkspaceRoot = {
      prefix: 'apps',
      file: 'package.json',
      globs: ['*'],
      excludes: [],
    };
    const main: WorkspaceRoot = {
      prefix: 'main',
      file: 'package.json',
      globs: ['packages/*'],
      excludes: [],
    };
    for (const roots of [
      [apps, main],
      [main, apps],
    ]) {
      // The path names `main`'s directory: `main` owns it, not `apps/main` via apps' `*` glob.
      expect(packageOfPath('main/packages/x/a.ts', { roots })).toBe('main/packages/x');
    }
    const a: WorkspaceRoot = {
      prefix: 'a',
      file: 'package.json',
      globs: ['packages/*'],
      excludes: [],
    };
    const b: WorkspaceRoot = {
      prefix: 'b',
      file: 'package.json',
      globs: ['packages/*'],
      excludes: [],
    };
    // Root-relative spelling that two roots could own is unknown, not "the first root".
    expect(packageOfPath('packages/x/a.ts', { roots: [a, b] })).toBeNull();
    expect(packageOfPath('packages/x/a.ts', { roots: [a] })).toBe('packages/x');
  });
  it('prefixes packages with their root when the repo has several roots', () => {
    const l: WorkspaceLayout = {
      roots: [
        { prefix: 'a', file: 'package.json', globs: ['packages/*'], excludes: [] },
        { prefix: 'b', file: 'package.json', globs: ['packages/*'], excludes: [] },
      ],
    };
    expect(packageOfPath('b/packages/x/y.ts', l)).toBe('b/packages/x');
  });
});

describe('inferPackages / assessIssue with a workspace layout (#801)', () => {
  const body =
    'Touches `main/packages/frontend/src/a.tsx`, `main/scripts/ci.sh` and `main/docs/x.md`.';
  it('the heuristic collapses nested layouts into a pseudo-package `main`', () => {
    expect(workspaceOf('main/scripts/ci.sh')).toBe('main');
    expect(inferPackages(body)).toContain('main');
  });
  it('with the declared layout only real workspaces remain', () => {
    expect(inferPackages(body, undefined, IMBOARD)).toEqual(['packages/frontend']);
    expect(
      inferPackages('x', ['main/packages/backend/a.ts', 'main/scripts/b.sh'], IMBOARD)
    ).toEqual(['packages/backend']);
  });
  it('assessIssue threads the layout into AssessedIssue.packages', () => {
    const a = assessIssue(
      { issue: 1, source: 'pick', title: 'fix: x', body, labels: [], state: 'OPEN', assignees: [] },
      'v2',
      IMBOARD
    );
    expect(a.packages).toEqual(['packages/frontend']);
  });
});
