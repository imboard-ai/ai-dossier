import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  analyze,
  CheckUnavailableError,
  discoverPackages,
  ESCAPE_LABEL,
  formatReport,
  isReleaseRelevant,
  run,
  versionAtRef,
} from './check-version-bumps.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./check-version-bumps.mjs', import.meta.url));

const PACKAGES = [
  { dir: 'packages/core', name: '@ai-dossier/core', version: '1.4.1' },
  { dir: 'cli', name: '@ai-dossier/cli', version: '0.10.0' },
  { dir: 'mcp-server', name: '@ai-dossier/mcp-server', version: '1.4.1' },
  { dir: 'packages/worktree-pool', name: '@ai-dossier/worktree-pool', version: '0.5.3' },
];

/**
 * Base versions identical to HEAD — i.e. nothing was bumped. Derived from
 * PACKAGES so the two never drift apart when a fixture version is edited.
 */
const UNBUMPED = Object.fromEntries(PACKAGES.map((p) => [p.dir, p.version]));

function check(changedFiles, { baseVersions = UNBUMPED, labels = [], packages = PACKAGES } = {}) {
  return analyze({ changedFiles, packages, baseVersions, labels });
}

describe('isReleaseRelevant', () => {
  it('matches src/ and bin/ files inside the package', () => {
    expect(isReleaseRelevant('cli/src/index.ts', 'cli')).toBe(true);
    expect(isReleaseRelevant('cli/bin/ai-dossier.js', 'cli')).toBe(true);
    expect(isReleaseRelevant('packages/core/src/deep/nested/file.ts', 'packages/core')).toBe(true);
  });

  it('ignores files outside src/ and bin/', () => {
    expect(isReleaseRelevant('cli/README.md', 'cli')).toBe(false);
    expect(isReleaseRelevant('cli/package.json', 'cli')).toBe(false);
    expect(isReleaseRelevant('cli/test/smoke/login.smoke.mjs', 'cli')).toBe(false);
    expect(isReleaseRelevant('cli/tsconfig.json', 'cli')).toBe(false);
  });

  it('ignores test files that live inside src/ (this repo keeps them there)', () => {
    expect(isReleaseRelevant('cli/src/commands/publish.test.ts', 'cli')).toBe(false);
    expect(isReleaseRelevant('packages/core/src/lint.spec.ts', 'packages/core')).toBe(false);
    expect(isReleaseRelevant('cli/src/__tests__/helper.ts', 'cli')).toBe(false);
    expect(isReleaseRelevant('cli/src/__fixtures__/sample.json', 'cli')).toBe(false);
    expect(isReleaseRelevant('cli/src/fixtures/sample.json', 'cli')).toBe(false);
  });

  it('does not let a package match a sibling with a shared prefix', () => {
    // `packages/core` must not swallow a hypothetical `packages/core-utils`.
    expect(isReleaseRelevant('packages/core-utils/src/a.ts', 'packages/core')).toBe(false);
  });
});

describe('analyze — AC1: unbumped src change fails', () => {
  it('flags a package whose src changed while its version stayed equal to base', () => {
    const result = check(['cli/src/commands/run.ts']);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].name).toBe('@ai-dossier/cli');
    expect(result.violations[0].dir).toBe('cli');
  });

  it('treats bin/ changes exactly like src/ changes', () => {
    const result = check(['cli/bin/ai-dossier.js']);
    expect(result.violations.map((v) => v.dir)).toEqual(['cli']);
  });

  it('passes when the version was bumped', () => {
    const result = check(['cli/src/commands/run.ts'], {
      baseVersions: { ...UNBUMPED, cli: '0.9.1' },
    });
    expect(result.violations).toHaveLength(0);
    expect(result.checked.map((c) => c.dir)).toEqual(['cli']);
  });
});

describe('analyze — AC2: benign changes pass, multi-package changes need multi bumps', () => {
  it('passes a version-only change', () => {
    const result = check(['cli/package.json'], {
      baseVersions: { ...UNBUMPED, cli: '0.9.1' },
    });
    expect(result.violations).toHaveLength(0);
    expect(result.checked).toHaveLength(0);
  });

  it('passes docs-only changes', () => {
    const result = check(['README.md', 'docs/guide.md', 'cli/README.md']);
    expect(result.violations).toHaveLength(0);
  });

  it('passes test-only changes even though tests live under src/', () => {
    const result = check([
      'cli/src/commands/run.test.ts',
      'packages/core/src/verify.test.ts',
      'cli/test/smoke/login.smoke.mjs',
    ]);
    expect(result.violations).toHaveLength(0);
    expect(result.checked).toHaveLength(0);
  });

  it('requires two bumps when two packages change src', () => {
    const result = check(['cli/src/a.ts', 'packages/core/src/b.ts']);
    expect(result.violations.map((v) => v.dir).sort()).toEqual(['cli', 'packages/core']);
  });

  it('flags only the unbumped package when one of the two was bumped', () => {
    const result = check(['cli/src/a.ts', 'packages/core/src/b.ts'], {
      baseVersions: { ...UNBUMPED, 'packages/core': '1.4.0' },
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].dir).toBe('cli');
  });

  it('ignores private workspaces such as registry', () => {
    // `registry` is `private: true`, so discoverPackages never yields it and a
    // src change there can never be a violation.
    const result = check(['registry/src/app/api/route.ts']);
    expect(result.violations).toHaveLength(0);
  });

  it('exempts a package that does not exist on the base ref', () => {
    const result = check(['packages/brand-new/src/index.ts'], {
      packages: [
        ...PACKAGES,
        { dir: 'packages/brand-new', name: '@ai-dossier/new', version: '0.1.0' },
      ],
      baseVersions: { ...UNBUMPED, 'packages/brand-new': null },
    });
    expect(result.violations).toHaveLength(0);
    expect(result.checked.map((c) => c.dir)).toEqual(['packages/brand-new']);
  });
});

describe('formatReport — AC3: message names the package and the exact fix', () => {
  it('names the package and prints "bump <pkg> version"', () => {
    const report = formatReport(check(['cli/src/commands/run.ts']));
    expect(report).toContain('@ai-dossier/cli');
    expect(report).toContain('Fix: bump @ai-dossier/cli version');
    expect(report).toContain('Version-bump check FAILED.');
  });

  it('lists every unbumped package when several are in violation', () => {
    const report = formatReport(check(['cli/src/a.ts', 'mcp-server/src/b.ts']));
    expect(report).toContain('Fix: bump @ai-dossier/cli version');
    expect(report).toContain('Fix: bump @ai-dossier/mcp-server version');
  });

  it('truncates a long changed-file list instead of dumping every path', () => {
    const many = Array.from({ length: 12 }, (_, i) => `cli/src/f${i}.ts`);
    const changedLine = formatReport(check(many))
      .split('\n')
      .find((l) => l.startsWith('  Changed:'));

    expect(changedLine).toMatch(/, \.\.\.$/);
    expect(changedLine.match(/cli\/src\/f\d+\.ts/g)).toHaveLength(5);
  });

  it('does not truncate when the list is short enough to show in full', () => {
    const changedLine = formatReport(check(['cli/src/a.ts', 'cli/src/b.ts']))
      .split('\n')
      .find((l) => l.startsWith('  Changed:'));

    expect(changedLine).not.toMatch(/\.\.\./);
  });

  it('reports a clean pass without a fix hint', () => {
    const report = formatReport(check(['README.md']));
    expect(report).toContain('passed');
    expect(report).not.toContain('Fix:');
  });
});

describe('formatReport — AC4: escape label', () => {
  it('skips the check and says so', () => {
    const result = check(['cli/src/commands/run.ts'], { labels: [ESCAPE_LABEL] });
    expect(result.skipped).toBe(true);
    expect(result.violations).toHaveLength(0);

    const report = formatReport(result);
    expect(report).toContain('SKIPPED');
    expect(report).toContain(ESCAPE_LABEL);
  });

  it('still runs when other labels are present', () => {
    const result = check(['cli/src/commands/run.ts'], { labels: ['bug', 'ci-cd'] });
    expect(result.skipped).toBe(false);
    expect(result.violations).toHaveLength(1);
  });

  it('mentions the escape label in the failure message so authors can find it', () => {
    expect(formatReport(check(['cli/src/a.ts']))).toContain(ESCAPE_LABEL);
  });
});

describe('discoverPackages + run — end to end against a real git repo', () => {
  let repo;

  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

  const writePkg = (dir, name, version, extra = {}) => {
    mkdirSync(join(repo, dir, 'src'), { recursive: true });
    writeFileSync(
      join(repo, dir, 'package.json'),
      `${JSON.stringify({ name, version, ...extra }, null, 2)}\n`
    );
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'version-bump-guard-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');

    writeFileSync(
      join(repo, 'package.json'),
      `${JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*', 'cli'] }, null, 2)}\n`
    );
    writePkg('cli', '@fixture/cli', '1.0.0');
    writePkg('packages/lib', '@fixture/lib', '2.0.0');
    writePkg('packages/internal', '@fixture/internal', '0.0.1', { private: true });
    writeFileSync(join(repo, 'cli/src/index.js'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'packages/lib/src/index.js'), 'export const b = 1;\n');
    writeFileSync(join(repo, 'packages/internal/src/index.js'), 'export const c = 1;\n');

    git('add', '-A');
    git('commit', '-qm', 'base');
    git('branch', 'base-ref');
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('discovers only non-private workspace packages', () => {
    const found = discoverPackages(repo).map((p) => p.name);
    expect(found).toContain('@fixture/cli');
    expect(found).toContain('@fixture/lib');
    expect(found).not.toContain('@fixture/internal');
    expect(found).not.toContain('root');
  });

  it('exits 1 and reports the fix when src changed without a bump', () => {
    writeFileSync(join(repo, 'cli/src/index.js'), 'export const a = 2;\n');
    git('add', '-A');
    git('commit', '-qm', 'change cli src');

    const out = [];
    const code = run(['--repo-root', repo, '--base', 'base-ref'], {
      log: (m) => out.push(m),
      error: (m) => out.push(m),
    });

    expect(code).toBe(1);
    expect(out.join('\n')).toContain('Fix: bump @fixture/cli version');
  });

  it('exits 0 once the version is bumped', () => {
    writePkg('cli', '@fixture/cli', '1.0.1');
    git('add', '-A');
    git('commit', '-qm', 'bump cli');

    const out = [];
    const code = run(['--repo-root', repo, '--base', 'base-ref'], {
      log: (m) => out.push(m),
      error: (m) => out.push(m),
    });

    expect(code).toBe(0);
    expect(out.join('\n')).toContain('1.0.0 -> 1.0.1');
  });

  it('exits 0 with a skip notice when the escape label is present', () => {
    writeFileSync(join(repo, 'packages/lib/src/index.js'), 'export const b = 2;\n');
    git('add', '-A');
    git('commit', '-qm', 'change lib src without bump');

    const withoutLabel = [];
    expect(
      run(['--repo-root', repo, '--base', 'base-ref'], {
        log: (m) => withoutLabel.push(m),
        error: (m) => withoutLabel.push(m),
      })
    ).toBe(1);

    const out = [];
    const code = run(
      ['--repo-root', repo, '--base', 'base-ref', '--labels', `bug,${ESCAPE_LABEL}`],
      {
        log: (m) => out.push(m),
        error: (m) => out.push(m),
      }
    );

    expect(code).toBe(0);
    expect(out.join('\n')).toContain('SKIPPED');
  });

  it('exits 2 rather than passing when the base ref is unreachable', () => {
    const out = [];
    const code = run(['--repo-root', repo, '--base', 'origin/does-not-exist'], {
      log: (m) => out.push(m),
      error: (m) => out.push(m),
    });

    expect(code).toBe(2);
    expect(out.join('\n')).toContain('fetch-depth: 0');
  });

  it('runs as a real subprocess and exits non-zero on a violation', () => {
    // Guards the CLI wiring (arg parsing + process.exit), which the in-process
    // `run()` tests above bypass.
    writeFileSync(join(repo, 'packages/lib/src/index.js'), 'export const b = 3;\n');
    git('add', '-A');
    git('commit', '-qm', 'another lib change');

    let status = 0;
    let stderr = '';
    try {
      execFileSync('node', [SCRIPT_PATH, '--repo-root', repo, '--base', 'base-ref'], {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      status = err.status;
      stderr = err.stderr ?? '';
    }

    expect(status).toBe(1);
    expect(stderr).toContain('bump @fixture/lib version');
  });
});

describe('unsupported workspaces patterns fail loudly rather than silently passing', () => {
  let root;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'version-bump-globs-'));
    mkdirSync(join(root, 'packages/lib/src'), { recursive: true });
    writeFileSync(
      join(root, 'packages/lib/package.json'),
      `${JSON.stringify({ name: '@fixture/lib', version: '1.0.0' }, null, 2)}\n`
    );
    // A real repo with a resolvable merge base, so the exit-2 assertions below
    // can only be caused by the workspaces problem under test — not by the
    // earlier "cannot compute a merge base" guard.
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(root, 'packages/lib/src/index.js'), 'export const b = 1;\n');
    writeFileSync(join(root, 'package.json'), '{}\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const writeRootPkg = (workspaces) =>
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ name: 'root', private: true, workspaces }, null, 2)}\n`
    );

  it('still expands the supported trailing-/* form', () => {
    writeRootPkg(['packages/*']);
    expect(discoverPackages(root).map((p) => p.dir)).toEqual(['packages/lib']);
  });

  it('throws on a glob shape it cannot expand instead of yielding zero packages', () => {
    // A silent empty expansion is the dangerous outcome: every package would be
    // unguarded while the check still reported green.
    writeRootPkg(['packages/**']);
    expect(() => discoverPackages(root)).toThrow(CheckUnavailableError);
    // Pinned to the glob-specific wording on purpose: the generic "no publishable
    // package was discovered" error also names the pattern, so a looser matcher
    // would still pass if the glob guard were deleted.
    expect(() => discoverPackages(root)).toThrow(/glob shape this guard cannot expand/);
  });

  it('throws on an unexpandable glob even when other entries do yield packages', () => {
    // The dangerous partial case: `cli` resolves, so the package list is non-empty
    // and the "discovered nothing" backstop never fires — yet `packages/**`
    // contributed zero packages and left packages/lib silently unguarded.
    mkdirSync(join(root, 'cli/src'), { recursive: true });
    writeFileSync(
      join(root, 'cli/package.json'),
      `${JSON.stringify({ name: '@fixture/cli', version: '1.0.0' }, null, 2)}\n`
    );
    writeRootPkg(['packages/**', 'cli']);
    expect(() => discoverPackages(root)).toThrow(/glob shape this guard cannot expand/);
    rmSync(join(root, 'cli'), { recursive: true, force: true });
  });

  it('rejects a non-string workspaces entry rather than crashing on it later', () => {
    writeRootPkg(['packages/*', 42]);
    expect(() => discoverPackages(root)).toThrow(CheckUnavailableError);
    expect(() => discoverPackages(root)).toThrow(/non-string entry/);
  });

  it('reaches the check at all — a supported workspaces list exits 0 here', () => {
    // Baseline for the two exit-2 cases below: same repo, same args, only the
    // workspaces field differs.
    writeRootPkg(['packages/*']);
    const out = [];
    const code = run(['--repo-root', root, '--base', 'HEAD', '--head', 'HEAD'], {
      log: (m) => out.push(m),
      error: (m) => out.push(m),
    });
    expect(code).toBe(0);
  });

  it('surfaces the failure as exit code 2, never 0', () => {
    writeRootPkg(['packages/**']);
    const out = [];
    const code = run(['--repo-root', root, '--base', 'HEAD', '--head', 'HEAD'], {
      log: (m) => out.push(m),
      error: (m) => out.push(m),
    });
    expect(code).toBe(2);
    expect(out.join('\n')).toContain('could not run');
  });

  it('reports a malformed root package.json as could-not-run, not as a pass', () => {
    writeFileSync(join(root, 'package.json'), '{ not json');
    const out = [];
    const code = run(['--repo-root', root, '--base', 'HEAD', '--head', 'HEAD'], {
      log: (m) => out.push(m),
      error: (m) => out.push(m),
    });
    expect(code).toBe(2);
    expect(out.join('\n')).toContain('could not run');
  });
});

describe('formatReport — CI log states what was compared', () => {
  const context = {
    base: 'origin/main',
    head: 'HEAD',
    mergeBase: '0123456789abcdef0123456789abcdef01234567',
    changedFileCount: 7,
    packageCount: 4,
  };

  it('leads every report with the base ref, merge base and counts', () => {
    for (const result of [
      check(['README.md']),
      check(['cli/src/a.ts']),
      check(['cli/src/a.ts'], { baseVersions: { ...UNBUMPED, cli: '0.9.1' } }),
      check(['cli/src/a.ts'], { labels: [ESCAPE_LABEL] }),
    ]) {
      const report = formatReport({ ...result, context });
      expect(report.split('\n')[0]).toContain("base 'origin/main'");
      expect(report.split('\n')[0]).toContain('merge base 0123456789ab');
      expect(report.split('\n')[0]).toContain('7 changed file(s)');
      expect(report.split('\n')[0]).toContain('4 publishable package(s)');
    }
  });
});

describe('formatReport — escape label names what it waived', () => {
  it('lists the packages the label let through', () => {
    const report = formatReport(check(['cli/src/a.ts'], { labels: [ESCAPE_LABEL] }));
    expect(report).toContain('SKIPPED');
    expect(report).toContain('@ai-dossier/cli');
    expect(report).toContain('version 0.10.0 unchanged');
  });

  it('says plainly that nothing was waived when nothing would have failed', () => {
    const report = formatReport(check(['README.md'], { labels: [ESCAPE_LABEL] }));
    expect(report).toContain('No publishable package needs a version bump');
    expect(report).not.toContain('unchanged.');
  });
});

describe('never fails open — a check that cannot run exits 2, not 0', () => {
  const repos = [];

  const makeRepo = (rootPkg, files = {}) => {
    const repo = mkdtempSync(join(tmpdir(), 'version-bump-guard-open-'));
    repos.push(repo);
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(repo, 'package.json'), `${JSON.stringify(rootPkg, null, 2)}\n`);
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(repo, rel, '..'), { recursive: true });
      writeFileSync(join(repo, rel), body);
    }
    git('add', '-A');
    git('commit', '-qm', 'base');
    git('branch', 'base-ref');
    mkdirSync(join(repo, 'cli/src'), { recursive: true });
    writeFileSync(join(repo, 'cli/src/index.js'), 'export const a = 2;\n');
    git('add', '-A');
    git('commit', '-qm', 'change cli src');
    return repo;
  };

  const runIn = (repo, argv = []) => {
    const out = [];
    const code = run(['--repo-root', repo, '--base', 'base-ref', ...argv], {
      log: (m) => out.push(m),
      error: (m) => out.push(m),
    });
    return { code, out: out.join('\n') };
  };

  afterAll(() => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true });
  });

  it('exits 2 when the root package.json has no workspaces field', () => {
    const repo = makeRepo(
      { name: 'root', private: true },
      {
        'cli/package.json': '{"name":"@fixture/cli","version":"1.0.0"}\n',
        'cli/src/index.js': 'export const a = 1;\n',
      }
    );
    const { code, out } = runIn(repo);
    expect(code).toBe(2);
    expect(out).toContain('`workspaces`');
    expect(out).toContain('checking nothing');
  });

  it('exits 2 when every workspace is private, so nothing is discoverable', () => {
    const repo = makeRepo(
      { name: 'root', private: true, workspaces: ['cli'] },
      {
        'cli/package.json': '{"name":"@fixture/cli","version":"1.0.0","private":true}\n',
        'cli/src/index.js': 'export const a = 1;\n',
      }
    );
    const { code, out } = runIn(repo);
    expect(code).toBe(2);
    expect(out).toContain('no publishable package was discovered');
    expect(out).toContain('cli (private)');
  });

  it('exits 2 rather than silently skipping a workspace with unparseable package.json', () => {
    const repo = makeRepo(
      { name: 'root', private: true, workspaces: ['cli', 'lib'] },
      {
        'cli/package.json': '{"name":"@fixture/cli", "version": OOPS}\n',
        'cli/src/index.js': 'export const a = 1;\n',
        'lib/package.json': '{"name":"@fixture/lib","version":"1.0.0"}\n',
      }
    );
    const { code, out } = runIn(repo);
    expect(code).toBe(2);
    expect(out).toContain('cli/package.json');
    expect(out).toContain('would silently exempt it');
  });

  it('exits 2 when the root package.json itself is unparseable', () => {
    const repo = mkdtempSync(join(tmpdir(), 'version-bump-guard-open-'));
    repos.push(repo);
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(repo, 'package.json'), '{ not json\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    git('branch', 'base-ref');

    const { code, out } = runIn(repo);
    expect(code).toBe(2);
    expect(out).toContain('not valid JSON');
  });

  it('exits 2 on a missing or malformed argument instead of guessing', () => {
    expect(run(['--base'], { log: () => {}, error: () => {} })).toBe(2);
    expect(
      run(['--repo-root', '.', '--base', '--labels', 'x'], { log: () => {}, error: () => {} })
    ).toBe(2);
    expect(run(['--totally-unknown'], { log: () => {}, error: () => {} })).toBe(2);

    const out = [];
    run(['--base', 'origin/'], { log: (m) => out.push(m), error: (m) => out.push(m) });
    expect(out.join('\n')).toContain('pull_request');
  });

  it('versionAtRef distinguishes "absent on base" from "cannot read"', () => {
    const repo = makeRepo(
      { name: 'root', private: true, workspaces: ['cli'] },
      {
        'cli/package.json': '{"name":"@fixture/cli","version":"1.0.0"}\n',
        'cli/src/index.js': 'export const a = 1;\n',
      }
    );
    expect(versionAtRef(repo, 'base-ref', 'cli')).toBe('1.0.0');
    expect(versionAtRef(repo, 'base-ref', 'packages/never-existed')).toBe(null);
    expect(() => versionAtRef(repo, 'no-such-ref', 'cli')).toThrow(CheckUnavailableError);
  });
});
