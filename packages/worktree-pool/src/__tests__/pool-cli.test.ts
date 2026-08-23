import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PoolState } from '../types';
import { createTempRepo, type TempRepo } from './helpers/setup';

// These tests create real git repos and worktrees.
// They use a minimal repo (no npm install / make build overhead).
describe.sequential('pool-cli integration', () => {
  let repo: TempRepo;
  let poolDir: string;

  function runPool(args: string, cwd?: string): string {
    const tsxPath = path.resolve(__dirname, '../../../../node_modules/.bin/tsx');
    const cliPath = path.resolve(__dirname, '../cli.ts');
    return execSync(`"${tsxPath}" "${cliPath}" ${args}`, {
      cwd: cwd || repo.root,
      encoding: 'utf-8',
      env: {
        ...process.env,
        // Force non-interactive for tests
        FORCE_COLOR: '0',
      },
      timeout: 30_000,
    });
  }

  function readPoolState(): PoolState | null {
    const statePath = path.join(poolDir, '.pool-state.json');
    if (!fs.existsSync(statePath)) return null;
    return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  }

  function writePoolConfig(gitRoot: string, dir: string, extra?: Record<string, unknown>): void {
    const relDir = path.relative(gitRoot, dir);
    fs.writeFileSync(
      path.join(gitRoot, '.worktree-pool.json'),
      JSON.stringify({ pool_dir: relDir, ...extra })
    );
  }

  /** Commit working-tree changes and publish them to the fixture's bare origin. */
  function commitAndPush(message: string): void {
    execSync('git add -A', { cwd: repo.root, stdio: 'pipe' });
    execSync(`git commit -m "${message}"`, { cwd: repo.root, stdio: 'pipe' });
    execSync('git push origin main', { cwd: repo.root, stdio: 'pipe' });
    execSync('git fetch origin', { cwd: repo.root, stdio: 'pipe' });
  }

  beforeEach(() => {
    repo = createTempRepo();
    poolDir = path.join(repo.root, '..', 'worktrees');
    // Pre-configure pool dir so it doesn't prompt
    writePoolConfig(repo.root, poolDir);
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('status shows empty pool', () => {
    const output = runPool('status');
    expect(output).toContain('Warm: 0');
    expect(output).toContain('Total: 0');
  });

  it('replenish creates warm worktrees', () => {
    const output = runPool('replenish --count 1');
    const result = JSON.parse(output);
    expect(result.created).toBe(1);
    expect(result.errors).toHaveLength(0);

    const state = readPoolState();
    expect(state).not.toBeNull();
    expect(state?.worktrees).toHaveLength(1);
    expect(state?.worktrees[0].status).toBe('warm');

    // Path in state is relative to poolDir (just the directory name)
    expect(path.isAbsolute(state?.worktrees[0].path)).toBe(false);
    // Verify worktree directory exists on disk
    expect(fs.existsSync(path.join(poolDir, state?.worktrees[0].path))).toBe(true);
  });

  it('claim returns worktree path and renames directory', () => {
    // First replenish
    runPool('replenish --count 1');

    // Then claim
    const claimedPath = runPool('claim --issue 999 --branch feature/999-test').trim();
    expect(claimedPath).toContain('feature-999-test');
    expect(fs.existsSync(claimedPath)).toBe(true);

    // State should show assigned with relative path
    const state = readPoolState();
    expect(state?.worktrees[0].status).toBe('assigned');
    expect(state?.worktrees[0].assigned_to_issue).toBe(999);
    expect(state?.worktrees[0].assigned_branch).toBe('feature/999-test');
    expect(state?.worktrees[0].path).toBe('feature-999-test');

    // Verify the worktree has the right branch
    const branch = execSync('git branch --show-current', {
      cwd: claimedPath,
      encoding: 'utf-8',
    }).trim();
    expect(branch).toBe('feature/999-test');
  });

  it('claim accepts --issue 0 (issue zero is not a missing argument)', () => {
    runPool('replenish --count 1');

    const claimedPath = runPool('claim --issue 0 --branch feature/0-test').trim();
    expect(claimedPath).toContain('feature-0-test');
    expect(fs.existsSync(claimedPath)).toBe(true);

    const state = readPoolState();
    expect(state?.worktrees[0].assigned_to_issue).toBe(0);

    // A missing or non-numeric --issue must still be rejected.
    expect(() => runPool('claim --branch feature/0-test')).toThrow();
    expect(() => runPool('claim --issue abc --branch feature/0-test')).toThrow();
  });

  it('claim returns exit 1 when pool is empty', () => {
    expect(() => runPool('claim --issue 999 --branch feature/999-test')).toThrow();
  });

  it('return recycles worktree back to warm', () => {
    runPool('replenish --count 1');
    const claimedPath = runPool('claim --issue 999 --branch feature/999-test').trim();

    // Return it
    runPool(`return --path "${claimedPath}"`);

    const state = readPoolState();
    expect(state?.worktrees).toHaveLength(1);
    expect(state?.worktrees[0].status).toBe('warm');
    expect(state?.worktrees[0].assigned_to_issue).toBeNull();
    // ID should have changed (new pool ID)
    expect(state?.worktrees[0].id).not.toContain('feature');
  });

  it('gc removes stale entries', () => {
    // Replenish and manually age the worktree
    runPool('replenish --count 1');

    const state = readPoolState() as NonNullable<ReturnType<typeof readPoolState>>;
    const old = new Date();
    old.setDate(old.getDate() - 10); // 10 days ago
    state.worktrees[0].warmed_at = old.toISOString();
    state.config.stale_after_hours = 24;
    fs.writeFileSync(path.join(poolDir, '.pool-state.json'), JSON.stringify(state, null, 2));

    runPool('gc');

    const newState = readPoolState();
    expect(newState?.worktrees).toHaveLength(0);
  });

  it('status shows correct counts after operations', () => {
    runPool('replenish --count 2');
    let output = runPool('status');
    expect(output).toContain('Warm: 2');
    expect(output).toContain('Total: 2');

    runPool('claim --issue 100 --branch feature/100-foo');
    output = runPool('status');
    expect(output).toContain('Warm: 1');
    expect(output).toContain('Assigned: 1');
    expect(output).toContain('Total: 2');
  });

  it('detect prints the project env as JSON', () => {
    const env = JSON.parse(runPool('detect'));
    // Fixture repo is npm with no lockfile and a `build` script
    expect(env.pm).toBe('npm');
    expect(env.lockfile).toBe('package-lock.json');
    expect(env.installCmd).toEqual(['npm', 'install']);
    expect(env.buildCmd).toEqual(['npm', 'run', 'build']);
  });

  it('detect accepts an explicit directory', () => {
    const pnpmDir = path.join(repo.root, 'pnpm-project');
    fs.mkdirSync(pnpmDir);
    fs.writeFileSync(
      path.join(pnpmDir, 'package.json'),
      JSON.stringify({ name: 'p', scripts: { 'build:libs': 'tsc -b' } })
    );
    fs.writeFileSync(path.join(pnpmDir, 'pnpm-lock.yaml'), '');

    const env = JSON.parse(runPool(`detect "${pnpmDir}"`));
    expect(env.pm).toBe('pnpm');
    expect(env.installCmd).toEqual(['pnpm', 'install', '--frozen-lockfile', '--prefer-offline']);
    expect(env.buildCmd).toEqual(['pnpm', 'run', 'build:libs']);
  });

  it('detect resolves project_subdir from the pool config', () => {
    const appDir = path.join(repo.root, 'app');
    fs.mkdirSync(appDir);
    fs.writeFileSync(
      path.join(appDir, 'package.json'),
      JSON.stringify({ name: 'app', packageManager: 'yarn@4.1.0' })
    );
    writePoolConfig(repo.root, poolDir, { project_subdir: 'app' });

    const env = JSON.parse(runPool('detect'));
    expect(env.pm).toBe('yarn');
  });

  it('replenish runs configured warm_commands inside project_subdir', () => {
    const appDir = path.join(repo.root, 'app');
    fs.mkdirSync(appDir);
    fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'app' }));
    commitAndPush('add app subdir');

    writePoolConfig(repo.root, poolDir, {
      project_subdir: 'app',
      warm_commands: [
        ['node', '-e', 'require("fs").writeFileSync("warm-marker.txt", process.cwd())'],
      ],
    });

    runPool('replenish --count 1');

    const state = readPoolState();
    const wtPath = path.join(poolDir, String(state?.worktrees[0].path));
    const marker = path.join(wtPath, 'app', 'warm-marker.txt');
    expect(fs.existsSync(marker)).toBe(true);
    // Warm commands must run in <worktree>/<project_subdir>
    expect(fs.realpathSync(fs.readFileSync(marker, 'utf-8').trim())).toBe(
      fs.realpathSync(path.join(wtPath, 'app'))
    );
  });

  it('replenish honours a non-default base_ref', () => {
    execSync('git checkout -b develop', { cwd: repo.root, stdio: 'pipe' });
    fs.writeFileSync(path.join(repo.root, 'DEVELOP.md'), 'develop only\n');
    execSync('git add -A', { cwd: repo.root, stdio: 'pipe' });
    execSync('git commit -m "develop commit"', { cwd: repo.root, stdio: 'pipe' });
    execSync('git push origin develop', { cwd: repo.root, stdio: 'pipe' });
    execSync('git checkout main', { cwd: repo.root, stdio: 'pipe' });
    execSync('git fetch origin', { cwd: repo.root, stdio: 'pipe' });

    writePoolConfig(repo.root, poolDir, { base_ref: 'origin/develop' });
    runPool('replenish --count 1');

    const state = readPoolState();
    const wtPath = path.join(poolDir, String(state?.worktrees[0].path));
    expect(fs.existsSync(path.join(wtPath, 'DEVELOP.md'))).toBe(true);

    const developSha = execSync('git rev-parse origin/develop', {
      cwd: repo.root,
      encoding: 'utf-8',
    }).trim();
    expect(state?.worktrees[0].base_commit).toBe(developSha);
  });

  it('init preserves other keys in an existing pool config', () => {
    fs.writeFileSync(
      path.join(repo.root, '.worktree-pool.json'),
      JSON.stringify({ warm_commands: [['echo', 'hi']], base_ref: 'origin/develop' })
    );

    runPool('init');

    const cfg = JSON.parse(fs.readFileSync(path.join(repo.root, '.worktree-pool.json'), 'utf-8'));
    expect(cfg.warm_commands).toEqual([['echo', 'hi']]);
    expect(cfg.base_ref).toBe('origin/develop');
    expect(typeof cfg.pool_dir).toBe('string');
  });

  it('init configures pool directory', () => {
    // Remove existing config
    fs.unlinkSync(path.join(repo.root, '.worktree-pool.json'));

    const output = runPool('init');
    expect(output).toContain('Pool directory:');

    // Config file should exist now
    expect(fs.existsSync(path.join(repo.root, '.worktree-pool.json'))).toBe(true);
  });
});
