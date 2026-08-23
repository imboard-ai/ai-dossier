import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PoolState } from '../types';
import { createTempRepo, type TempRepo } from './helpers/setup';

/**
 * Regression tests for imboard-ai/ai-dossier#438.
 *
 * `pool_dir` is commonly the same directory developers keep their own
 * worktrees in. `gc` used to treat every directory there that was missing from
 * `.pool-state.json` as an orphan and delete it, which destroyed 29 developer
 * worktrees (and their uncommitted work) on imboard-monorepo. Nothing the pool
 * did not create may be removed by any code path.
 */
describe.sequential('foreign worktrees in the pool directory', () => {
  let repo: TempRepo;
  let poolDir: string;

  function runPool(args: string, cwd?: string): string {
    const tsxPath = path.resolve(__dirname, '../../../../node_modules/.bin/tsx');
    const cliPath = path.resolve(__dirname, '../cli.ts');
    return execSync(`"${tsxPath}" "${cliPath}" ${args} 2>&1`, {
      cwd: cwd || repo.root,
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

  function writePoolConfig(dir: string, extra?: Record<string, unknown>): void {
    fs.writeFileSync(
      path.join(repo.root, '.worktree-pool.json'),
      JSON.stringify({ pool_dir: path.relative(repo.root, dir), ...extra })
    );
  }

  /**
   * A worktree a developer made by hand, inside the pool directory, holding
   * uncommitted work. `dirName` defaults to a realistic branch-shaped name.
   */
  function createForeignWorktree(dirName = '2332-budget-composable-dashboard', branch?: string) {
    const wtPath = path.join(poolDir, dirName);
    execSync(`git worktree add "${wtPath}" -b "${branch ?? dirName}"`, {
      cwd: repo.root,
      stdio: 'pipe',
    });
    const precious = path.join(wtPath, 'UNCOMMITTED.txt');
    fs.writeFileSync(precious, 'hours of work\n');
    return { path: wtPath, precious, branch: branch ?? dirName };
  }

  function expectIntact(foreign: { path: string; precious: string }): void {
    expect(fs.existsSync(foreign.path)).toBe(true);
    expect(fs.existsSync(foreign.precious)).toBe(true);
    expect(fs.readFileSync(foreign.precious, 'utf-8')).toBe('hours of work\n');
  }

  /** Age the single pool worktree past the stale cutoff so gc has real work. */
  function makePoolWorktreeStale(): PoolState {
    const state = readPoolState() as PoolState;
    const old = new Date();
    old.setDate(old.getDate() - 10);
    state.worktrees[0].warmed_at = old.toISOString();
    state.config.stale_after_hours = 24;
    fs.writeFileSync(path.join(poolDir, '.pool-state.json'), JSON.stringify(state, null, 2));
    return state;
  }

  beforeEach(() => {
    repo = createTempRepo();
    poolDir = path.join(repo.root, '..', 'worktrees');
    writePoolConfig(poolDir);
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('gc leaves a foreign worktree alone and reports it as skipped', () => {
    const foreign = createForeignWorktree();

    const output = runPool('gc --yes');

    expectIntact(foreign);
    expect(output).toContain('Foreign, skipped');
    expect(output).toContain('2332-budget-composable-dashboard');
    expect(output).toContain('Removed 0 item(s)');

    // git still knows about it
    const list = execSync('git worktree list --porcelain', {
      cwd: repo.root,
      encoding: 'utf-8',
    });
    expect(list).toContain(foreign.path);
  });

  it('gc removes its own stale worktree while leaving a foreign one intact', () => {
    runPool('replenish --count 1');
    const foreign = createForeignWorktree();
    const state = makePoolWorktreeStale();
    const poolPath = path.join(poolDir, state.worktrees[0].path);

    const output = runPool('gc --yes');

    expect(fs.existsSync(poolPath)).toBe(false);
    expect(readPoolState()?.worktrees).toHaveLength(0);
    expectIntact(foreign);
    expect(output).toContain('Foreign, skipped');
  });

  it('gc --dry-run never removes a foreign worktree', () => {
    const foreign = createForeignWorktree();

    const output = runPool('gc --dry-run');

    expect(output).toContain('Dry run');
    expect(output).toContain('Foreign, skipped');
    expectIntact(foreign);
  });

  it('a foreign worktree is never a removal candidate, so gc needs no confirmation', () => {
    const foreign = createForeignWorktree();

    // Only foreign entries exist, so there is nothing to confirm and gc succeeds
    // without --yes even though stdin is not a TTY.
    const output = runPool('gc');

    expect(output).toContain('Nothing to remove.');
    expectIntact(foreign);
  });

  it('a directory matching the pool naming but not on a pool/spare branch is foreign', () => {
    // The dangerous near-miss: right shape, wrong provenance.
    const foreign = createForeignWorktree('pool-1750000000000-4242', 'feature/handmade');

    const output = runPool('gc --yes');

    expectIntact(foreign);
    expect(output).toContain('Foreign, skipped');
    expect(output).toContain('pool-1750000000000-4242');
  });

  it('a plain directory that is not a git worktree is foreign', () => {
    const plain = path.join(poolDir, 'notes-and-scratch');
    fs.mkdirSync(plain, { recursive: true });
    fs.writeFileSync(path.join(plain, 'UNCOMMITTED.txt'), 'hours of work\n');

    runPool('gc --yes');

    expectIntact({ path: plain, precious: path.join(plain, 'UNCOMMITTED.txt') });
  });

  it('refresh leaves a foreign worktree alone', () => {
    runPool('replenish --count 1');
    const foreign = createForeignWorktree();

    // Move upstream so refresh has something to reset to.
    fs.writeFileSync(path.join(repo.root, 'NEW.md'), 'new\n');
    execSync('git add -A && git commit -m "upstream"', { cwd: repo.root, stdio: 'pipe' });
    execSync('git push origin main', { cwd: repo.root, stdio: 'pipe' });

    const output = runPool('refresh');
    expect(output).toContain('Refreshed 1 worktree(s)');
    expectIntact(foreign);

    // The foreign worktree keeps its own branch, un-reset.
    const branch = execSync('git branch --show-current', {
      cwd: foreign.path,
      encoding: 'utf-8',
    }).trim();
    expect(branch).toBe('2332-budget-composable-dashboard');
  });

  it('refresh skips a state entry whose directory is now a foreign worktree', () => {
    runPool('replenish --count 1');
    const state = readPoolState() as PoolState;
    const poolName = state.worktrees[0].path;
    const poolPath = path.join(poolDir, poolName);

    // Simulate drift: the recorded directory is replaced by someone else's
    // worktree carrying the same name.
    execSync(`git worktree remove "${poolPath}" --force`, { cwd: repo.root, stdio: 'pipe' });
    execSync(`git worktree add "${poolPath}" -b handmade/replacement`, {
      cwd: repo.root,
      stdio: 'pipe',
    });
    const precious = path.join(poolPath, 'UNCOMMITTED.txt');
    fs.writeFileSync(precious, 'hours of work\n');

    const output = runPool('refresh');

    expect(output).toContain('Refreshed 0 worktree(s)');
    expect(output).toContain('Foreign, skipped');
    expectIntact({ path: poolPath, precious });
  });

  it('a failed return does not touch a foreign worktree', () => {
    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 999 --branch feature/999-test').trim();
    const foreign = createForeignWorktree();

    // Point the pool at a ref that does not exist so recycling fails.
    writePoolConfig(poolDir, { base_ref: 'origin/does-not-exist' });

    expect(() => runPool(`return --path "${claimedPath}"`)).toThrow();

    expectIntact(foreign);
  });

  it('gc does not delete branches that are not pool temp branches', () => {
    const foreign = createForeignWorktree();

    runPool('gc --yes');

    const branches = execSync('git branch --list', { cwd: repo.root, encoding: 'utf-8' });
    expect(branches).toContain(foreign.branch);
  });

  it('status lists foreign worktrees under Other without counting them as pool worktrees', () => {
    runPool('replenish --count 1');
    const foreign = createForeignWorktree();

    const output = runPool('status');

    expect(output).toContain('Total: 1');
    expect(output).toContain('Other (foreign, never touched by the pool): 1');
    expect(output).toContain('2332-budget-composable-dashboard');
    expectIntact(foreign);
  });
});
