import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectProjectEnv,
  lockfileChangedInDiff,
  lockfileFor,
  lockfilePathFor,
  resolveProjectDir,
  resolveWarmCommands,
} from '../project-env';
import type { PackageManager } from '../types';

const tempDirs: string[] = [];

interface FixtureOptions {
  lockfile?: string;
  packageJson?: Record<string, unknown> | null;
  /** Extra files, keyed by path relative to the fixture root. */
  files?: Record<string, string>;
}

/** Create a throwaway project directory. No installs, no git — pure fs. */
function fixture(opts: FixtureOptions = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-env-test-'));
  tempDirs.push(dir);

  if (opts.packageJson !== null) {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify(opts.packageJson ?? { name: 'fixture', version: '1.0.0' }, null, 2)
    );
  }
  if (opts.lockfile) {
    fs.writeFileSync(path.join(dir, opts.lockfile), '');
  }
  for (const [rel, contents] of Object.entries(opts.files ?? {})) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('lockfileFor', () => {
  it('returns the canonical lockfile per package manager', () => {
    expect(lockfileFor('pnpm')).toBe('pnpm-lock.yaml');
    expect(lockfileFor('yarn')).toBe('yarn.lock');
    expect(lockfileFor('bun')).toBe('bun.lockb');
    expect(lockfileFor('npm')).toBe('package-lock.json');
  });
});

describe('detectProjectEnv — lockfile detection', () => {
  const cases: Array<{ pm: PackageManager; lockfile: string; installCmd: string[] }> = [
    {
      pm: 'pnpm',
      lockfile: 'pnpm-lock.yaml',
      installCmd: ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline'],
    },
    { pm: 'yarn', lockfile: 'yarn.lock', installCmd: ['yarn', 'install', '--immutable'] },
    { pm: 'bun', lockfile: 'bun.lockb', installCmd: ['bun', 'install'] },
    { pm: 'npm', lockfile: 'package-lock.json', installCmd: ['npm', 'ci'] },
  ];

  for (const { pm, lockfile, installCmd } of cases) {
    it(`detects ${pm} from ${lockfile}`, () => {
      const env = detectProjectEnv(fixture({ lockfile }));
      expect(env.pm).toBe(pm);
      expect(env.lockfile).toBe(lockfile);
      expect(env.installCmd).toEqual(installCmd);
    });
  }

  it('detects bun from the newer text bun.lock', () => {
    const env = detectProjectEnv(fixture({ lockfile: 'bun.lock' }));
    expect(env.pm).toBe('bun');
    expect(env.lockfile).toBe('bun.lock');
  });

  it('falls back to npm with a plain install when no lockfile exists', () => {
    const env = detectProjectEnv(fixture());
    expect(env.pm).toBe('npm');
    expect(env.lockfile).toBe('package-lock.json');
    // `npm ci` hard-fails without a lockfile
    expect(env.installCmd).toEqual(['npm', 'install']);
  });

  it('falls back to npm for a directory with no package.json at all', () => {
    const env = detectProjectEnv(fixture({ packageJson: null }));
    expect(env.pm).toBe('npm');
    expect(env.installCmd).toEqual(['npm', 'install']);
    expect(env.buildCmd).toBeNull();
  });

  it('prefers pnpm over other lockfiles when several are present', () => {
    const dir = fixture({ lockfile: 'pnpm-lock.yaml', files: { 'package-lock.json': '' } });
    expect(detectProjectEnv(dir).pm).toBe('pnpm');
  });

  it('tolerates a corrupt package.json', () => {
    const dir = fixture({ lockfile: 'yarn.lock', files: { 'package.json': '{ not json' } });
    const env = detectProjectEnv(dir);
    expect(env.pm).toBe('yarn');
    expect(env.buildCmd).toBeNull();
  });
});

describe('detectProjectEnv — packageManager precedence', () => {
  it('packageManager field wins over a conflicting lockfile', () => {
    const dir = fixture({
      lockfile: 'package-lock.json',
      packageJson: { name: 'fixture', packageManager: 'pnpm@9.1.0' },
    });
    const env = detectProjectEnv(dir);
    expect(env.pm).toBe('pnpm');
    // No pnpm lockfile on disk, so the frozen variant would fail
    expect(env.lockfile).toBe('pnpm-lock.yaml');
    expect(env.installCmd).toEqual(['pnpm', 'install', '--prefer-offline']);
  });

  it('uses the frozen install when the declared manager also has its lockfile', () => {
    const dir = fixture({
      lockfile: 'pnpm-lock.yaml',
      packageJson: { name: 'fixture', packageManager: 'pnpm@9.1.0' },
    });
    expect(detectProjectEnv(dir).installCmd).toEqual([
      'pnpm',
      'install',
      '--frozen-lockfile',
      '--prefer-offline',
    ]);
  });

  it('accepts a bare packageManager name with no version', () => {
    const dir = fixture({ packageJson: { name: 'fixture', packageManager: 'yarn' } });
    expect(detectProjectEnv(dir).pm).toBe('yarn');
  });

  it('ignores an unknown packageManager value and falls back to lockfile probing', () => {
    const dir = fixture({
      lockfile: 'yarn.lock',
      packageJson: { name: 'fixture', packageManager: 'cargo@1.0.0' },
    });
    expect(detectProjectEnv(dir).pm).toBe('yarn');
  });
});

describe('detectProjectEnv — build command', () => {
  it('prefers build:libs over build', () => {
    const dir = fixture({
      lockfile: 'pnpm-lock.yaml',
      packageJson: {
        name: 'fixture',
        scripts: { build: 'tsc -b', 'build:libs': 'turbo run build --filter=./libs/*' },
      },
    });
    expect(detectProjectEnv(dir).buildCmd).toEqual(['pnpm', 'run', 'build:libs']);
  });

  it('falls back to build', () => {
    const dir = fixture({
      lockfile: 'package-lock.json',
      packageJson: { name: 'fixture', scripts: { build: 'tsc' } },
    });
    expect(detectProjectEnv(dir).buildCmd).toEqual(['npm', 'run', 'build']);
  });

  it('is null when neither script exists', () => {
    const dir = fixture({
      lockfile: 'package-lock.json',
      packageJson: { name: 'fixture', scripts: { test: 'vitest' } },
    });
    expect(detectProjectEnv(dir).buildCmd).toBeNull();
  });
});

describe('resolveProjectDir', () => {
  it('returns the worktree root when no subdir is configured', () => {
    expect(resolveProjectDir('/repos/wt')).toBe('/repos/wt');
    expect(resolveProjectDir('/repos/wt', undefined)).toBe('/repos/wt');
  });

  it('joins the configured subdir', () => {
    expect(resolveProjectDir('/repos/wt', 'main')).toBe(path.resolve('/repos/wt', 'main'));
    expect(resolveProjectDir('/repos/wt', 'apps/web')).toBe(path.resolve('/repos/wt', 'apps/web'));
  });

  it('detects the env of a nested package root, not the worktree root', () => {
    const root = fixture({
      packageJson: null,
      files: {
        'main/package.json': JSON.stringify({
          name: 'nested',
          packageManager: 'pnpm@9.0.0',
          scripts: { build: 'tsc' },
        }),
        'main/pnpm-lock.yaml': '',
      },
    });
    // Worktree root itself looks like a bare npm project
    expect(detectProjectEnv(root).pm).toBe('npm');

    const env = detectProjectEnv(resolveProjectDir(root, 'main'));
    expect(env.pm).toBe('pnpm');
    expect(env.buildCmd).toEqual(['pnpm', 'run', 'build']);
  });
});

describe('resolveWarmCommands', () => {
  it('uses install + build from detection', () => {
    const dir = fixture({
      lockfile: 'pnpm-lock.yaml',
      packageJson: { name: 'fixture', scripts: { build: 'tsc' } },
    });
    expect(resolveWarmCommands(dir)).toEqual([
      ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline'],
      ['pnpm', 'run', 'build'],
    ]);
  });

  it('omits the build step when the project has no build script', () => {
    const dir = fixture({ lockfile: 'yarn.lock', packageJson: { name: 'fixture' } });
    expect(resolveWarmCommands(dir)).toEqual([['yarn', 'install', '--immutable']]);
  });

  it('explicit warm_commands win over detection', () => {
    const dir = fixture({
      lockfile: 'pnpm-lock.yaml',
      packageJson: { name: 'fixture', scripts: { build: 'tsc' } },
    });
    const warm = [
      ['npm', 'ci'],
      ['make', 'build-core', 'build-mcp', 'build-cli'],
    ];
    expect(resolveWarmCommands(dir, { warm_commands: warm })).toEqual(warm);
  });

  it('falls back to detection for an empty warm_commands array', () => {
    const dir = fixture({ lockfile: 'package-lock.json', packageJson: { name: 'fixture' } });
    expect(resolveWarmCommands(dir, { warm_commands: [] })).toEqual([['npm', 'ci']]);
  });
});

describe('lockfile-change detection', () => {
  it('builds the repo-relative lockfile path per package manager', () => {
    expect(lockfilePathFor(detectProjectEnv(fixture({ lockfile: 'pnpm-lock.yaml' })))).toBe(
      'pnpm-lock.yaml'
    );
    expect(lockfilePathFor(detectProjectEnv(fixture({ lockfile: 'yarn.lock' })), 'main')).toBe(
      'main/yarn.lock'
    );
    expect(lockfilePathFor(detectProjectEnv(fixture({ lockfile: 'bun.lockb' })), 'apps/api')).toBe(
      'apps/api/bun.lockb'
    );
    expect(lockfilePathFor(detectProjectEnv(fixture({ lockfile: 'package-lock.json' })), '.')).toBe(
      'package-lock.json'
    );
  });

  it('fires for each package manager on its own lockfile', () => {
    for (const lockfile of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'package-lock.json']) {
      const env = detectProjectEnv(fixture({ lockfile }));
      const diff = `README.md\n${lockfile}\nsrc/index.ts`;
      expect(lockfileChangedInDiff(diff, lockfilePathFor(env))).toBe(true);
    }
  });

  it('does not fire on a different package manager lockfile', () => {
    const env = detectProjectEnv(fixture({ lockfile: 'pnpm-lock.yaml' }));
    expect(lockfileChangedInDiff('package-lock.json\nsrc/a.ts', lockfilePathFor(env))).toBe(false);
  });

  it('respects project_subdir when matching diff paths', () => {
    const env = detectProjectEnv(fixture({ lockfile: 'pnpm-lock.yaml' }));
    const target = lockfilePathFor(env, 'main');
    expect(lockfileChangedInDiff('main/pnpm-lock.yaml', target)).toBe(true);
    // Root lockfile of a different package root must not count
    expect(lockfileChangedInDiff('pnpm-lock.yaml', target)).toBe(false);
  });

  it('does not fire on a nested workspace lockfile when the root one is expected', () => {
    const env = detectProjectEnv(fixture({ lockfile: 'package-lock.json' }));
    expect(lockfileChangedInDiff('packages/foo/package-lock.json', lockfilePathFor(env))).toBe(
      false
    );
  });

  it('returns false for empty diff output', () => {
    const env = detectProjectEnv(fixture({ lockfile: 'package-lock.json' }));
    expect(lockfileChangedInDiff('', lockfilePathFor(env))).toBe(false);
  });
});
