import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nextVersion, PUBLISHABLE_PACKAGES, prepareNextRelease } from './prepare-next-release.mjs';

const roots = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prepare-next-release-'));
  roots.push(root);
  const packages = [
    ['packages/core', '@ai-dossier/core', '1.2.3', {}],
    ['packages/worktree-pool', '@ai-dossier/worktree-pool', '0.7.4', {}],
    [
      'packages/sched',
      '@ai-dossier/sched',
      '0.8.0',
      { dependencies: { '@ai-dossier/core': '^1.2.3', '@ai-dossier/worktree-pool': '^0.7.4' } },
    ],
    [
      'cli',
      '@ai-dossier/cli',
      '0.9.0',
      { dependencies: { '@ai-dossier/core': '^1.2.3', '@ai-dossier/sched': '^0.8.0' } },
    ],
    [
      'mcp-server',
      '@ai-dossier/mcp-server',
      '1.3.0',
      { dependencies: { '@ai-dossier/core': '^1.2.3' } },
    ],
  ];

  for (const [dir, name, version, fields] of packages) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(
      join(root, dir, 'package.json'),
      `${JSON.stringify({ name, version, ...fields })}\n`
    );
  }
  return root;
}

function pkg(root, dir) {
  return JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('prepare-next-release', () => {
  it('creates unique next versions from stable package versions', () => {
    expect(nextVersion('1.2.3', 42)).toBe('1.2.3-next.42');
    expect(nextVersion('1.2.3', '42.2')).toBe('1.2.3-next.42.2');
    expect(nextVersion('1.2.3-next.7', '42')).toBe('1.2.3-next.42');
    expect(() => nextVersion('1.2', 42)).toThrow('MAJOR.MINOR.PATCH');
    expect(() => nextVersion('1.2.3', '42-rerun')).toThrow('numeric segments');
  });

  it('pins internal dependencies to the prepared prerelease cohort', () => {
    const root = fixture();
    expect(prepareNextRelease(root, 42)).toEqual({
      '@ai-dossier/core': '1.2.3-next.42',
      '@ai-dossier/worktree-pool': '0.7.4-next.42',
      '@ai-dossier/sched': '0.8.0-next.42',
      '@ai-dossier/cli': '0.9.0-next.42',
      '@ai-dossier/mcp-server': '1.3.0-next.42',
    });
    expect(pkg(root, 'packages/sched')).toMatchObject({
      version: '0.8.0-next.42',
      dependencies: {
        '@ai-dossier/core': '1.2.3-next.42',
        '@ai-dossier/worktree-pool': '0.7.4-next.42',
      },
    });
    expect(pkg(root, 'cli').dependencies).toMatchObject({
      '@ai-dossier/core': '1.2.3-next.42',
      '@ai-dossier/sched': '0.8.0-next.42',
    });
  });

  it('keeps the publishable package list explicit', () => {
    expect(PUBLISHABLE_PACKAGES).toHaveLength(5);
  });
});
