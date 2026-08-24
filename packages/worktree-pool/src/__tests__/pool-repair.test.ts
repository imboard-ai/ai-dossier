import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PoolState } from '../types';
import { createTempRepo, type TempRepo } from './helpers/setup';

/**
 * Regression tests for imboard-ai/ai-dossier#443.
 *
 * `claim` and `return` move a pool worktree with `fs.renameSync` and then run
 * `git worktree repair`. A *pathless* repair only fixes the worktree->repo
 * back-link; the repo-side `.git/worktrees/<id>/gitdir` forward link keeps
 * pointing at the old location. The next `git worktree prune` — which the pool
 * runs itself after every removal, and which humans and agents run routinely —
 * sees a dangling gitdir and deletes the admin dir, leaving the renamed
 * worktree with a `.git` file pointing at nothing.
 *
 * Every test here prunes from the git root after a rename and then asserts the
 * worktree still works, which is precisely what a pathless repair fails.
 */
describe.sequential('worktree repair after rename (#443)', () => {
  let repo: TempRepo;
  let poolDir: string;

  function runPool(args: string, cwd?: string): string {
    const tsxPath = path.resolve(__dirname, '../../../../node_modules/.bin/tsx');
    const cliPath = path.resolve(__dirname, '../cli.ts');
    return execSync(`"${tsxPath}" "${cliPath}" ${args}`, {
      cwd: cwd || repo.root,
      encoding: 'utf-8',
      env: { ...process.env, FORCE_COLOR: '0' },
      timeout: 30_000,
    });
  }

  /** Same as `runPool`, but with stderr folded into the returned output. */
  function runPoolCombined(args: string, cwd?: string): string {
    const tsxPath = path.resolve(__dirname, '../../../../node_modules/.bin/tsx');
    const cliPath = path.resolve(__dirname, '../cli.ts');
    return execSync(`"${tsxPath}" "${cliPath}" ${args} 2>&1`, {
      cwd: cwd || repo.root,
      encoding: 'utf-8',
      env: { ...process.env, FORCE_COLOR: '0' },
      timeout: 30_000,
    });
  }

  function readPoolState(): PoolState {
    return JSON.parse(fs.readFileSync(path.join(poolDir, '.pool-state.json'), 'utf-8'));
  }

  /** What everyone runs sooner or later, and what used to corrupt the pool. */
  function pruneFromGitRoot(): void {
    execSync('git worktree prune', { cwd: repo.root, stdio: 'pipe' });
  }

  /** A worktree is usable iff git still answers inside it. */
  function expectUsableWorktree(wtPath: string): void {
    expect(fs.existsSync(wtPath)).toBe(true);
    const head = execSync('git rev-parse HEAD', {
      cwd: wtPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    // git also has to still know it: a pruned admin dir drops it from the list.
    const list = execSync('git worktree list --porcelain', {
      cwd: repo.root,
      encoding: 'utf-8',
    });
    expect(list).toContain(fs.realpathSync(wtPath));
  }

  /**
   * Reproduce the corrupted end state through public git operations only:
   * move the directory away so its gitdir link dangles, prune, move it back.
   * The directory is then on disk under the name `.pool-state.json` records,
   * with a `.git` file pointing at an admin dir that no longer exists.
   */
  function corruptWorktree(wtPath: string): void {
    const stashed = `${wtPath}-stashed`;
    fs.renameSync(wtPath, stashed);
    pruneFromGitRoot();
    fs.renameSync(stashed, wtPath);
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(() => execSync('git rev-parse HEAD', { cwd: wtPath, stdio: 'pipe' })).toThrow();
  }

  beforeEach(() => {
    repo = createTempRepo();
    poolDir = path.join(repo.root, '..', 'worktrees');
    fs.writeFileSync(
      path.join(repo.root, '.worktree-pool.json'),
      JSON.stringify({
        pool_dir: path.relative(repo.root, poolDir),
        // Keep warm-up trivial; this suite is about git bookkeeping.
        warm_commands: [['echo', 'warm']],
      })
    );
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('a claimed worktree survives git worktree prune', () => {
    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 443 --branch fix/443-repair').trim();

    pruneFromGitRoot();

    expectUsableWorktree(claimedPath);
    expect(
      execSync('git branch --show-current', { cwd: claimedPath, encoding: 'utf-8' }).trim()
    ).toBe('fix/443-repair');
  });

  it('a recycled worktree survives git worktree prune', () => {
    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 443 --branch fix/443-recycle').trim();
    runPoolCombined(`return --path "${claimedPath}"`);

    const recycledPath = path.join(poolDir, readPoolState().worktrees[0].path);
    expect(recycledPath).not.toBe(claimedPath);

    pruneFromGitRoot();

    expectUsableWorktree(recycledPath);
  });

  it('a claim-return-claim round trip survives a prune at every step', () => {
    runPool('replenish --count 1');

    const first = runPool('claim --issue 1 --branch fix/1-first').trim();
    pruneFromGitRoot();
    expectUsableWorktree(first);

    runPoolCombined(`return --path "${first}"`);
    pruneFromGitRoot();
    const recycled = path.join(poolDir, readPoolState().worktrees[0].path);
    expectUsableWorktree(recycled);

    const second = runPool('claim --issue 2 --branch fix/2-second').trim();
    pruneFromGitRoot();
    expectUsableWorktree(second);
  });

  it('the pool can still be claimed from after a prune, without replenishing again', () => {
    runPool('replenish --count 1');
    pruneFromGitRoot();

    const claimedPath = runPool('claim --issue 443 --branch fix/443-after-prune').trim();
    expectUsableWorktree(claimedPath);
  });

  describe('already-corrupted entries', () => {
    it('status reports a corrupted entry as broken instead of failing', () => {
      runPool('replenish --count 1');
      const brokenPath = path.join(poolDir, readPoolState().worktrees[0].path);
      corruptWorktree(brokenPath);

      const output = runPoolCombined('status');

      expect(output).toContain('Broken (corrupted, skipped by claim): 1');
      expect(output).toContain(path.basename(brokenPath));
      expect(output).toContain('git admin dir is gone');
      // Reported, not fatal, and never mistaken for someone else's worktree.
      expect(output).not.toContain('fatal:');
      expect(output).not.toContain('Other (foreign');
    });

    it('claim skips a corrupted entry and hands out the next warm one', () => {
      runPool('replenish --count 1');
      const brokenId = readPoolState().worktrees[0].id;
      const brokenPath = path.join(poolDir, readPoolState().worktrees[0].path);
      corruptWorktree(brokenPath);

      runPool('replenish --count 1');
      const healthy = readPoolState().worktrees.find((w) => w.id !== brokenId);
      expect(healthy).toBeDefined();

      const output = runPoolCombined('claim --issue 443 --branch fix/443-skip');
      expect(output).toContain('Broken (corrupted, skipped): 1');

      const claimed = readPoolState().worktrees.find((w) => w.assigned_to_issue === 443);
      expect(claimed?.id).toBe(healthy?.id);
      // The corrupted entry is left where it is, still marked warm, never handed out.
      expect(readPoolState().worktrees.find((w) => w.id === brokenId)?.status).toBe('warm');
      expect(fs.existsSync(brokenPath)).toBe(true);

      expectUsableWorktree(path.join(poolDir, claimed?.path as string));
    });

    it('claim falls back cleanly when the only warm entry is corrupted', () => {
      runPool('replenish --count 1');
      corruptWorktree(path.join(poolDir, readPoolState().worktrees[0].path));

      let output = '';
      let failed = false;
      try {
        runPoolCombined('claim --issue 443 --branch fix/443-none');
      } catch (err) {
        failed = true;
        output = String((err as { stdout?: Buffer }).stdout ?? '');
      }

      expect(failed).toBe(true);
      expect(output).toContain('Broken (corrupted, skipped): 1');
      expect(output).toContain('No warm worktrees available');
      expect(output).not.toContain('fatal:');
    });
  });
});
