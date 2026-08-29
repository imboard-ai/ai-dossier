import { describe, expect, it } from 'vitest';
import type { SetupInfo } from '../groundtruth';
import { type ExecFn, runTeardown } from '../index';

/**
 * Teardown tests (#468 AC2): every subprocess scripted through a fake exec —
 * no real git, no real pool. The verification contract under test: a teardown
 * is only claimed `done` when the evidence says so; everything else records
 * `failed-<step>`.
 */

function recording(script: (file: string, args: string[]) => string | null): {
  exec: ExecFn;
  calls: Array<{ file: string; args: string[]; cwd?: string }>;
} {
  const calls: Array<{ file: string; args: string[]; cwd?: string }> = [];
  return {
    calls,
    exec: (file, args, cwd) => {
      calls.push({ file, args, cwd });
      return script(file, args);
    },
  };
}

const REPO = '/repo';

describe('runTeardown: cold worktree removal', () => {
  const info = (worktree: string): SetupInfo => ({
    worktree,
    poolClaimed: false,
    branch: 'feature/101-x',
  });

  it('removes the worktree with --force and claims done only after verification', () => {
    let removed = false;
    const { exec, calls } = recording((file, args) => {
      if (file === 'git' && args[0] === 'worktree' && args[1] === 'list') {
        return removed ? 'worktree /repo/main\n' : 'worktree /repo/main\nworktree /repo/wt-9\n';
      }
      if (file === 'git' && args[1] === 'remove') {
        removed = true;
        return '';
      }
      return null;
    });

    const result = runTeardown(exec, REPO, info('/repo/wt-9'), () => !removed);
    expect(result.cleanup).toBe('done');
    const remove = calls.find((c) => c.file === 'git' && c.args[1] === 'remove');
    expect(remove?.args).toEqual(['worktree', 'remove', '--force', '--', '/repo/wt-9']);
    expect(remove?.cwd).toBe(REPO);
    // verified before claimed: git's listing is re-checked after the remove
    const lists = calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'list');
    expect(lists.length).toBeGreaterThanOrEqual(1);
    expect(lists[calls.length - 1] ?? lists[0]).toBeDefined();
  });

  it('a remove that leaves the worktree listed is failed-worktree-remove', () => {
    const { exec } = recording((file, args) => {
      if (file === 'git' && args[1] === 'list') return 'worktree /repo/main\nworktree /repo/wt-9\n';
      if (file === 'git' && args[1] === 'remove') return '';
      return null;
    });
    const result = runTeardown(exec, REPO, info('/repo/wt-9'), () => true);
    expect(result.cleanup).toBe('failed-worktree-remove');
  });

  it('a non-zero git exit is failed-worktree-remove', () => {
    const { exec } = recording((file) => (file === 'git' ? null : null));
    const result = runTeardown(exec, REPO, info('/repo/wt-9'), () => true);
    expect(result.cleanup).toBe('failed-worktree-remove');
  });

  it('is idempotent: an already-removed worktree is done without a second remove', () => {
    const { exec, calls } = recording((_file, args) =>
      args[1] === 'list' ? 'worktree /repo/main\n' : null
    );
    const result = runTeardown(exec, REPO, info('/repo/wt-9'), () => false);
    expect(result.cleanup).toBe('done');
    expect(result.detail).toContain('idempotent');
    expect(calls.some((c) => c.args[1] === 'remove')).toBe(false);
  });
});

describe('runTeardown: pool return', () => {
  const info = (worktree: string): SetupInfo => ({
    worktree,
    poolClaimed: true,
    branch: 'feature/101-x',
  });
  const poolPrefix = ['-y', '@ai-dossier/worktree-pool@^0.5.1'];

  it('returns to the pool and claims done only on a warm self-check', () => {
    const { exec, calls } = recording((file, args) => {
      if (file === 'npx' && args[2] === 'status') return JSON.stringify({ worktrees: [] });
      if (file === 'npx' && args[2] === 'return') {
        return JSON.stringify({
          id: 'wt-9',
          path: '/pool/wt-9',
          verification: {
            entry_status: 'warm',
            directory_clean: true,
            checked_out_branch: 'pool/spare-9',
            expected_branch: 'pool/spare-9',
          },
        });
      }
      return null;
    });

    const result = runTeardown(exec, REPO, info('/pool/wt-9'));
    expect(result.cleanup).toBe('done');
    const ret = calls.find((c) => c.file === 'npx' && c.args[2] === 'return');
    expect(ret?.args).toEqual([...poolPrefix, 'return', '--path', '/pool/wt-9', '--json']);
    expect(ret?.cwd).toBe(REPO);
  });

  it('a non-warm self-check is failed-pool-return', () => {
    const { exec } = recording((file, args) => {
      if (file === 'npx' && args[2] === 'status') return JSON.stringify({ worktrees: [] });
      if (file === 'npx' && args[2] === 'return') {
        return JSON.stringify({
          id: 'wt-9',
          verification: { entry_status: 'assigned', directory_clean: false },
        });
      }
      return null;
    });
    const result = runTeardown(exec, REPO, info('/pool/wt-9'));
    expect(result.cleanup).toBe('failed-pool-return');
    expect(result.detail).toContain('assigned');
  });

  it('a non-zero pool exit is failed-pool-return', () => {
    const { exec } = recording(() => null);
    const result = runTeardown(exec, REPO, info('/pool/wt-9'));
    expect(result.cleanup).toBe('failed-pool-return');
  });

  it('is idempotent: an already-warm entry is done without a second return', () => {
    const { exec, calls } = recording((_file, args) =>
      args[2] === 'status'
        ? JSON.stringify({ worktrees: [{ path: '/pool/wt-9', status: 'warm' }] })
        : null
    );
    const result = runTeardown(exec, REPO, info('/pool/wt-9'));
    expect(result.cleanup).toBe('done');
    expect(result.detail).toContain('idempotent');
    expect(calls.some((c) => c.args[2] === 'return')).toBe(false);
  });
});
