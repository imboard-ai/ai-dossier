import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PoolState } from '../types';
import { createTempRepo, type TempRepo } from './helpers/setup';

/**
 * Partial-failure behaviour of `return` (#453).
 *
 * The bug these cover: a `return` that failed part-way used to destroy the
 * worktree and delete its pool entry, or leave the entry `assigned` with a
 * dirty directory while the caller reported success. The contract now is
 * transactional in outcome — `warm` and verified, or `broken` and non-zero.
 */
describe.sequential('pool return failure modes', () => {
  let repo: TempRepo;
  let poolDir: string;

  const tsxPath = path.resolve(__dirname, '../../../../node_modules/.bin/tsx');
  const cliPath = path.resolve(__dirname, '../cli.ts');

  function runPool(args: string, cwd?: string): string {
    return execSync(`"${tsxPath}" "${cliPath}" ${args}`, {
      cwd: cwd || repo.root,
      encoding: 'utf-8',
      env: { ...process.env, FORCE_COLOR: '0' },
      timeout: 30_000,
    });
  }

  /** Run the CLI expecting failure; return the exit code and combined output. */
  function runPoolExpectingFailure(args: string): { code: number; output: string } {
    try {
      const output = execSync(`"${tsxPath}" "${cliPath}" ${args} 2>&1`, {
        cwd: repo.root,
        encoding: 'utf-8',
        env: { ...process.env, FORCE_COLOR: '0' },
        timeout: 30_000,
      });
      return { code: 0, output };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return {
        code: e.status ?? -1,
        output: `${e.stdout ?? ''}${e.stderr ?? ''}`,
      };
    }
  }

  /** Same as `runPool`, but with stderr folded into the returned output. */
  function runPoolCombined(args: string): string {
    return execSync(`"${tsxPath}" "${cliPath}" ${args} 2>&1`, {
      cwd: repo.root,
      encoding: 'utf-8',
      env: { ...process.env, FORCE_COLOR: '0' },
      timeout: 30_000,
    });
  }

  function readPoolState(): PoolState | null {
    const statePath = path.join(poolDir, '.pool-state.json');
    if (!fs.existsSync(statePath)) return null;
    return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  }

  function writePoolConfig(gitRoot: string, dir: string): void {
    fs.writeFileSync(
      path.join(gitRoot, '.worktree-pool.json'),
      JSON.stringify({ pool_dir: path.relative(gitRoot, dir) })
    );
  }

  /** Commit working-tree changes in the fixture repo and publish to its bare origin. */
  function commitAndPush(message: string): void {
    execSync('git add -A', { cwd: repo.root, stdio: 'pipe' });
    execSync(`git commit -m "${message}"`, { cwd: repo.root, stdio: 'pipe' });
    execSync('git push origin main', { cwd: repo.root, stdio: 'pipe' });
    execSync('git fetch origin', { cwd: repo.root, stdio: 'pipe' });
  }

  beforeEach(() => {
    repo = createTempRepo();
    poolDir = path.join(repo.root, '..', 'worktrees');
    writePoolConfig(repo.root, poolDir);
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('leaves the entry broken (not assigned) when a dirty dir blocks the re-branch', () => {
    // A tracked file that main will move on top of.
    fs.writeFileSync(path.join(repo.root, 'shared.txt'), 'base\n');
    commitAndPush('add shared.txt');

    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 453 --branch bug/453-dirty').trim();

    // Advance main, then leave a conflicting uncommitted edit in the worktree.
    // `git checkout -b <temp> origin/main` now refuses: local changes would be
    // overwritten. `git clean -fd` runs *after* the checkout, so it cannot save it.
    fs.writeFileSync(path.join(repo.root, 'shared.txt'), 'moved-on-main\n');
    commitAndPush('move shared.txt on main');
    fs.writeFileSync(path.join(claimedPath, 'shared.txt'), 'local-uncommitted\n');

    const { code, output } = runPoolExpectingFailure(`return --path "${claimedPath}"`);

    expect(code).not.toBe(0);
    // AC1: the failing step is named.
    expect(output).toContain("return failed at step 'checkout-temp-branch'");

    const state = readPoolState();
    expect(state?.worktrees).toHaveLength(1);
    const entry = state?.worktrees[0];
    // AC1: broken — neither of the two states a caller could mistake for a result.
    expect(entry?.status).toBe('broken');
    expect(entry?.status).not.toBe('assigned');
    expect(entry?.status).not.toBe('warm');
    expect(entry?.broken_step).toBe('checkout-temp-branch');
    expect(entry?.broken_reason).toBeTruthy();

    // The worktree is preserved for inspection, not destroyed.
    expect(fs.existsSync(claimedPath)).toBe(true);
  });

  it('leaves the entry broken when the git admin dir is missing', () => {
    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 453 --branch bug/453-admin').trim();

    // Delete the worktree's admin dir (`.git/worktrees/<id>`) — every git
    // command inside the directory now fails with `fatal: not a git repository`.
    const gitFile = fs.readFileSync(path.join(claimedPath, '.git'), 'utf-8').trim();
    const adminDir = gitFile.replace(/^gitdir:\s*/, '');
    expect(fs.existsSync(adminDir)).toBe(true);
    fs.rmSync(adminDir, { recursive: true, force: true });

    const { code, output } = runPoolExpectingFailure(`return --path "${claimedPath}"`);

    expect(code).not.toBe(0);
    expect(output).toContain('return failed at step');
    expect(output).toContain("marked 'broken'");

    const entry = readPoolState()?.worktrees[0];
    expect(entry?.status).toBe('broken');
    expect(entry?.broken_step).toBeTruthy();
    expect(fs.existsSync(claimedPath)).toBe(true);
  });

  it('a broken entry is never handed out by a later claim', () => {
    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 453 --branch bug/453-inert').trim();
    const adminDir = fs
      .readFileSync(path.join(claimedPath, '.git'), 'utf-8')
      .trim()
      .replace(/^gitdir:\s*/, '');
    fs.rmSync(adminDir, { recursive: true, force: true });
    runPoolExpectingFailure(`return --path "${claimedPath}"`);

    // Only warm entries are claimable, so the pool now reads as empty.
    const { code, output } = runPoolExpectingFailure('claim --issue 454 --branch bug/454-next');
    expect(code).not.toBe(0);
    expect(output).toContain('No warm worktrees available');
  });

  it('prints a self-check on success and really is warm, clean and on a temp branch', () => {
    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 453 --branch bug/453-ok').trim();

    const output = runPoolCombined(`return --path "${claimedPath}"`);

    // AC2: the self-check is printed, not merely performed.
    expect(output).toContain('Self-check:');
    expect(output).toContain('directory clean: yes');
    expect(output).toMatch(/checked out: pool\/spare-/);

    const entry = readPoolState()?.worktrees[0];
    expect(entry?.status).toBe('warm');
    expect(entry?.assigned_to_issue).toBeNull();
    expect(entry?.broken_step).toBeUndefined();

    // And the claims the self-check made are independently true.
    const recycled = path.join(poolDir, entry?.path as string);
    expect(execSync('git status --porcelain', { cwd: recycled, encoding: 'utf-8' }).trim()).toBe(
      ''
    );
    expect(
      execSync('git rev-parse --abbrev-ref HEAD', { cwd: recycled, encoding: 'utf-8' }).trim()
    ).toBe(entry?.temp_branch);
  });

  it('status --json exposes per-entry state so a caller can assert the return happened', () => {
    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 453 --branch bug/453-json').trim();

    // AC3: assigned is visible before the return...
    const assigned = JSON.parse(runPool('status --json'));
    expect(assigned.worktrees).toHaveLength(1);
    expect(assigned.worktrees[0].status).toBe('assigned');
    expect(assigned.worktrees[0].assigned_to_issue).toBe(453);

    runPool(`return --path "${claimedPath}"`);

    // ...and warm after it, which is the assertion a ship tail needs.
    const after = JSON.parse(runPool('status --json'));
    expect(after.worktrees[0].status).toBe('warm');
    expect(after.warm).toBe(1);
    expect(after.assigned).toBe(0);
  });

  it('status --json reports the failed step of a broken entry', () => {
    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 453 --branch bug/453-brokenjson').trim();
    const adminDir = fs
      .readFileSync(path.join(claimedPath, '.git'), 'utf-8')
      .trim()
      .replace(/^gitdir:\s*/, '');
    fs.rmSync(adminDir, { recursive: true, force: true });
    runPoolExpectingFailure(`return --path "${claimedPath}"`);

    const s = JSON.parse(runPool('status --json'));
    expect(s.worktrees[0].status).toBe('broken');
    expect(s.worktrees[0].broken_step).toBeTruthy();
    expect(s.warm).toBe(0);
    expect(s.assigned).toBe(0);
    // Broken entries fall into `other`, so a caller checking `warm` is never misled.
    expect(s.other).toBe(1);
  });
});
