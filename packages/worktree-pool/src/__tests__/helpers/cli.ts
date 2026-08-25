import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PoolState } from '../../types';

/**
 * Shared harness for the tests that drive the real CLI against a real git
 * repo. Kept here rather than copied per suite so the `../../..` depth to
 * `tsx` lives in exactly one place.
 */

const TSX = path.resolve(__dirname, '../../../../../node_modules/.bin/tsx');
const CLI = path.resolve(__dirname, '../../cli.ts');

const EXEC_OPTS = {
  encoding: 'utf-8' as const,
  env: { ...process.env, FORCE_COLOR: '0' },
  timeout: 30_000,
};

/** Run the pool CLI in `cwd`. Throws on a non-zero exit. */
export function runPool(cwd: string, args: string, opts: { combined?: boolean } = {}): string {
  return execSync(`"${TSX}" "${CLI}" ${args}${opts.combined ? ' 2>&1' : ''}`, {
    cwd,
    ...EXEC_OPTS,
  });
}

/** Run the pool CLI expecting failure; returns the exit code and combined output. */
export function runPoolExpectingFailure(
  cwd: string,
  args: string
): { code: number; output: string } {
  try {
    return { code: 0, output: runPool(cwd, args, { combined: true }) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** Parsed `.pool-state.json`, or `null` when the pool has never been written. */
export function readPoolState(poolDir: string): PoolState | null {
  const statePath = path.join(poolDir, '.pool-state.json');
  if (!fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
}

/** Write `.worktree-pool.json` pointing at `poolDir`, so the CLI never prompts. */
export function writePoolConfig(
  gitRoot: string,
  poolDir: string,
  extra?: Record<string, unknown>
): void {
  fs.writeFileSync(
    path.join(gitRoot, '.worktree-pool.json'),
    JSON.stringify({ pool_dir: path.relative(gitRoot, poolDir), ...extra })
  );
}

/** Commit working-tree changes in the fixture repo and publish them to its bare origin. */
export function commitAndPush(repoRoot: string, message: string): void {
  execSync('git add -A', { cwd: repoRoot, stdio: 'pipe' });
  execSync(`git commit -m "${message}"`, { cwd: repoRoot, stdio: 'pipe' });
  execSync('git push origin main', { cwd: repoRoot, stdio: 'pipe' });
  execSync('git fetch origin', { cwd: repoRoot, stdio: 'pipe' });
}

/**
 * Delete a linked worktree's `.git/worktrees/<id>` admin dir, so every git
 * command inside it fails with `fatal: not a git repository` (#443). Returns
 * the admin dir path that was removed.
 */
export function breakWorktreeAdminDir(worktreePath: string): string {
  const adminDir = fs
    .readFileSync(path.join(worktreePath, '.git'), 'utf-8')
    .trim()
    .replace(/^gitdir:\s*/, '');
  fs.rmSync(adminDir, { recursive: true, force: true });
  return adminDir;
}
