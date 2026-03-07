import { type ExecSyncOptions, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import {
  addWorktree,
  claimWorktree as claimFromState,
  createEmptyState,
  findStaleWorktrees,
  getPoolStatus,
  getSparesNeeded,
  removeWorktree,
  updateWorktree,
  validateState,
} from './pool-state';
import { generateId, type PoolState, type PoolWorktree } from './types';

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 200;
const POOL_CONFIG_FILE = '.worktree-pool.json';

interface PoolDirConfig {
  pool_dir: string;
}

// --- Git helpers ---

function findGitRoot(): string {
  return (
    execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
    }) as string
  ).trim();
}

function git(args: string[], opts?: ExecSyncOptions): string {
  return (
    execFileSync('git', args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    }) as string
  ).trim();
}

// --- Pool directory discovery ---

function getConfigPath(gitRoot: string): string {
  return path.join(gitRoot, POOL_CONFIG_FILE);
}

function readPoolDirConfig(gitRoot: string): PoolDirConfig | null {
  const configPath = getConfigPath(gitRoot);
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (raw.pool_dir && typeof raw.pool_dir === 'string') {
      return { pool_dir: path.resolve(gitRoot, raw.pool_dir) };
    }
  } catch {
    // corrupt config — treat as absent
  }
  return null;
}

function writePoolDirConfig(gitRoot: string, poolDir: string): void {
  const configPath = getConfigPath(gitRoot);
  const relPoolDir = path.relative(gitRoot, poolDir);
  fs.writeFileSync(configPath, `${JSON.stringify({ pool_dir: relPoolDir }, null, 2)}\n`);
}

function discoverPoolDirFromWorktrees(gitRoot: string): string | null {
  try {
    const output = git(['worktree', 'list', '--porcelain'], { cwd: gitRoot });
    const worktreePaths: string[] = [];
    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        const wtPath = line.slice('worktree '.length);
        if (path.resolve(wtPath) !== path.resolve(gitRoot)) {
          worktreePaths.push(path.resolve(wtPath));
        }
      }
    }
    if (worktreePaths.length === 0) return null;

    const parents = worktreePaths.map((p) => path.dirname(p));
    const commonParent = parents.reduce((a, b) => {
      const partsA = a.split(path.sep);
      const partsB = b.split(path.sep);
      const common: string[] = [];
      for (let i = 0; i < Math.min(partsA.length, partsB.length); i++) {
        if (partsA[i] === partsB[i]) common.push(partsA[i]);
        else break;
      }
      return common.join(path.sep) || path.sep;
    });

    if (parents.every((p) => p === commonParent)) {
      return commonParent;
    }
    const freq = new Map<string, number>();
    for (const p of parents) {
      freq.set(p, (freq.get(p) || 0) + 1);
    }
    let best = '';
    let bestCount = 0;
    for (const [dir, count] of freq) {
      if (count > bestCount) {
        best = dir;
        bestCount = count;
      }
    }
    return best || null;
  } catch {
    return null;
  }
}

function suggestPoolDir(gitRoot: string): string {
  return path.join(gitRoot, '..', 'worktrees');
}

async function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function resolvePoolDir(
  gitRoot: string,
  opts?: { interactive?: boolean }
): Promise<string> {
  const config = readPoolDirConfig(gitRoot);
  if (config) return config.pool_dir;

  const discovered = discoverPoolDirFromWorktrees(gitRoot);
  const suggested = discovered || suggestPoolDir(gitRoot);

  if (opts?.interactive && process.stdin.isTTY) {
    console.error(`\nPool directory not configured for this project.`);
    console.error(`  Detected git root: ${gitRoot}`);
    if (discovered) {
      console.error(`  Found existing worktrees in: ${discovered}`);
    }
    const answer = await promptUser(`  Where should pool worktrees be stored? [${suggested}]: `);
    const poolDir = answer || suggested;
    const absPoolDir = path.resolve(gitRoot, poolDir);
    writePoolDirConfig(gitRoot, absPoolDir);
    console.error(`  Saved to ${getConfigPath(gitRoot)}`);
    return absPoolDir;
  }

  writePoolDirConfig(gitRoot, suggested);
  return suggested;
}

function resolvePoolDirSync(gitRoot: string): string {
  const config = readPoolDirConfig(gitRoot);
  if (config) return config.pool_dir;

  const discovered = discoverPoolDirFromWorktrees(gitRoot);
  const poolDir = discovered || suggestPoolDir(gitRoot);
  writePoolDirConfig(gitRoot, poolDir);
  return poolDir;
}

// --- Path helpers ---
// Paths stored in state are relative to poolDir (just the directory name).
// Use toAbs() to resolve to absolute for git/fs operations.

function toAbs(poolDir: string, relPath: string): string {
  return path.join(poolDir, relPath);
}

// --- State file paths ---

function getStatePath(poolDir: string): string {
  return path.join(poolDir, '.pool-state.json');
}

function getLockPath(poolDir: string): string {
  return path.join(poolDir, '.pool-lock');
}

// --- Lock ---

function acquireLock(poolDir: string): void {
  const lockPath = getLockPath(poolDir);
  fs.mkdirSync(poolDir, { recursive: true });

  const start = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, 'pid'), String(process.pid));
      return;
    } catch {
      try {
        const pidFile = path.join(lockPath, 'pid');
        if (fs.existsSync(pidFile)) {
          const lockPid = Number.parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
          try {
            process.kill(lockPid, 0);
          } catch {
            fs.rmSync(lockPath, { recursive: true, force: true });
            continue;
          }
        }
      } catch {
        // retry
      }

      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(
          `Timed out waiting for pool lock (${LOCK_TIMEOUT_MS}ms). ` +
            `If no other process is running, remove ${lockPath}`
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
    }
  }
}

function releaseLock(poolDir: string): void {
  fs.rmSync(getLockPath(poolDir), { recursive: true, force: true });
}

// --- State I/O ---

function readState(poolDir: string): PoolState {
  const statePath = getStatePath(poolDir);
  if (!fs.existsSync(statePath)) {
    return createEmptyState();
  }
  const raw = fs.readFileSync(statePath, 'utf-8');
  return validateState(JSON.parse(raw));
}

function writeState(poolDir: string, state: PoolState): void {
  const statePath = getStatePath(poolDir);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function withLock<T>(
  poolDir: string,
  fn: (state: PoolState) => { state: PoolState; result: T }
): T {
  acquireLock(poolDir);
  try {
    const current = readState(poolDir);
    const { state: newState, result } = fn(current);
    writeState(poolDir, newState);
    return result;
  } finally {
    releaseLock(poolDir);
  }
}

// --- .env copy ---

function copyEnvFiles(gitRoot: string, targetDir: string): void {
  const maxDepth = 3;

  function walk(dir: string, depth: number, relBase: string): void {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.join(relBase, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'worktrees')
          continue;
        walk(fullPath, depth + 1, relPath);
      } else if (entry.isFile() && entry.name.startsWith('.env') && entry.name !== '.env.example') {
        const dest = path.join(targetDir, relPath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(fullPath, dest);
      }
    }
  }

  walk(gitRoot, 0, '');
}

// --- Destroy helper ---

function destroyWorktree(gitRoot: string, tempBranch: string, absPath: string): void {
  try {
    git(['worktree', 'remove', absPath, '--force'], { cwd: gitRoot });
  } catch {
    fs.rmSync(absPath, { recursive: true, force: true });
  }
  try {
    git(['branch', '-D', tempBranch], { cwd: gitRoot });
  } catch {
    // branch may not exist
  }
  git(['worktree', 'prune'], { cwd: gitRoot });
}

// --- Public operations ---

export async function replenish(
  count?: number,
  _parallel = false
): Promise<{ created: number; errors: string[] }> {
  const gitRoot = findGitRoot();
  const poolDir = await resolvePoolDir(gitRoot, { interactive: true });
  fs.mkdirSync(poolDir, { recursive: true });

  git(['fetch', 'origin'], { cwd: gitRoot });

  let toCreate: number;
  if (count !== undefined) {
    toCreate = count;
  } else {
    const state = readState(poolDir);
    toCreate = getSparesNeeded(state);
  }

  if (toCreate <= 0) {
    return { created: 0, errors: [] };
  }

  const errors: string[] = [];
  let created = 0;

  const createOne = (): void => {
    const id = generateId();
    const absWorktreePath = toAbs(poolDir, id);
    const tempBranch = `pool/spare-${id}`;

    const baseCommit = withLock(poolDir, (state) => {
      const sha = git(['rev-parse', 'origin/main'], { cwd: gitRoot });
      const wt: PoolWorktree = {
        id,
        path: id,
        status: 'creating',
        temp_branch: tempBranch,
        base_commit: sha,
        warmed_at: new Date().toISOString(),
        assigned_to_issue: null,
        assigned_branch: null,
      };
      return { state: addWorktree(state, wt), result: sha };
    });

    try {
      git(['branch', tempBranch, 'origin/main'], { cwd: gitRoot });
      git(['worktree', 'add', absWorktreePath, tempBranch], {
        cwd: gitRoot,
      });

      withLock(poolDir, (state) => ({
        state: updateWorktree(state, id, { status: 'warming' }),
        result: undefined,
      }));

      copyEnvFiles(gitRoot, absWorktreePath);

      execFileSync('npm', ['install'], {
        cwd: absWorktreePath,
        stdio: 'pipe',
        timeout: 300_000,
      });
      execFileSync('make', ['build-core', 'build-mcp', 'build-cli'], {
        cwd: absWorktreePath,
        stdio: 'pipe',
        timeout: 300_000,
      });

      withLock(poolDir, (state) => ({
        state: updateWorktree(state, id, {
          status: 'warm',
          warmed_at: new Date().toISOString(),
          base_commit: baseCommit,
        }),
        result: undefined,
      }));

      created++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to create ${id}: ${msg}`);
      try {
        destroyWorktree(gitRoot, tempBranch, absWorktreePath);
      } catch {
        // best effort
      }
      withLock(poolDir, (state) => ({
        state: removeWorktree(state, id),
        result: undefined,
      }));
    }
  };

  // Note: createOne uses execFileSync so parallelism is not possible in a single
  // process. The --parallel flag is reserved for future async implementation.
  for (let i = 0; i < toCreate; i++) {
    createOne();
  }

  return { created, errors };
}

export function claim(issue: number, branch: string): { path: string } | null {
  const gitRoot = findGitRoot();
  const poolDir = resolvePoolDirSync(gitRoot);

  const result = withLock(poolDir, (state) => {
    const claimed = claimFromState(state, issue, branch);
    if (!claimed) return { state, result: null };
    return { state: claimed.state, result: claimed.worktree };
  });

  if (!result) return null;

  const worktree = result;
  const absPath = toAbs(poolDir, worktree.path);
  const branchDir = branch.replace(/\//g, '-');
  const newAbsPath = toAbs(poolDir, branchDir);

  try {
    // Check freshness
    const currentMain = git(['rev-parse', 'origin/main'], { cwd: gitRoot });
    if (worktree.base_commit !== currentMain) {
      let lockChanged = false;
      try {
        const diff = git(['diff', '--name-only', `${worktree.base_commit}..origin/main`], {
          cwd: gitRoot,
        });
        lockChanged = diff.includes('package-lock.json');
      } catch {
        lockChanged = true;
      }

      git(['fetch', 'origin'], { cwd: absPath });
      git(['reset', '--hard', 'origin/main'], { cwd: absPath });

      if (lockChanged) {
        execFileSync('npm', ['install'], {
          cwd: absPath,
          stdio: 'pipe',
          timeout: 300_000,
        });
        execFileSync('make', ['build-core', 'build-mcp', 'build-cli'], {
          cwd: absPath,
          stdio: 'pipe',
          timeout: 300_000,
        });
      }
    }

    // Create issue branch
    git(['checkout', '-b', branch], { cwd: absPath });

    // Rename directory
    if (absPath !== newAbsPath && !fs.existsSync(newAbsPath)) {
      fs.renameSync(absPath, newAbsPath);
      git(['worktree', 'repair'], { cwd: gitRoot });
    }

    // Delete temp branch
    try {
      git(['branch', '-d', worktree.temp_branch], { cwd: gitRoot });
    } catch {
      // may already be deleted
    }

    // Update state with new relative path
    withLock(poolDir, (state) => ({
      state: updateWorktree(state, worktree.id, {
        path: branchDir,
        assigned_branch: branch,
        assigned_to_issue: issue,
      }),
      result: undefined,
    }));

    return { path: newAbsPath };
  } catch (err) {
    // Revert claim on failure
    withLock(poolDir, (state) => ({
      state: updateWorktree(state, worktree.id, {
        status: 'warm',
        assigned_to_issue: null,
        assigned_branch: null,
      }),
      result: undefined,
    }));
    throw err;
  }
}

export function returnWorktree(worktreePath: string): void {
  const gitRoot = findGitRoot();
  const poolDir = resolvePoolDirSync(gitRoot);
  const absPath = path.resolve(worktreePath);

  const newId = generateId();
  const newTempBranch = `pool/spare-${newId}`;
  const newAbsPath = toAbs(poolDir, newId);

  // Look up entry and mark as recycling atomically under lock
  const entry = withLock(poolDir, (state) => {
    const found = state.worktrees.find((w) => toAbs(poolDir, w.path) === absPath);
    if (!found) {
      throw new Error(`Worktree not found in pool state: ${worktreePath}`);
    }
    return {
      state: updateWorktree(state, found.id, { status: 'recycling' }),
      result: { ...found },
    };
  });

  try {
    git(['fetch', 'origin'], { cwd: absPath });
    git(['checkout', '-b', newTempBranch, 'origin/main'], { cwd: absPath });
    git(['clean', '-fd'], { cwd: absPath });

    if (entry.assigned_branch) {
      try {
        git(['branch', '-D', entry.assigned_branch], { cwd: absPath });
      } catch {
        // may not exist
      }
    }

    if (absPath !== newAbsPath) {
      fs.renameSync(absPath, newAbsPath);
      git(['worktree', 'repair'], { cwd: gitRoot });
    }

    const currentMain = git(['rev-parse', 'origin/main'], { cwd: gitRoot });
    let lockChanged = false;
    try {
      const diff = git(['diff', '--name-only', `${entry.base_commit}..origin/main`], {
        cwd: gitRoot,
      });
      lockChanged = diff.includes('package-lock.json');
    } catch {
      lockChanged = true;
    }

    if (lockChanged) {
      execFileSync('npm', ['install'], {
        cwd: newAbsPath,
        stdio: 'pipe',
        timeout: 300_000,
      });
      execFileSync('make', ['build-core', 'build-mcp', 'build-cli'], {
        cwd: newAbsPath,
        stdio: 'pipe',
        timeout: 300_000,
      });
    }

    withLock(poolDir, (state) => ({
      state: updateWorktree(state, entry.id, {
        id: newId,
        path: newId,
        status: 'warm',
        temp_branch: newTempBranch,
        base_commit: currentMain,
        warmed_at: new Date().toISOString(),
        assigned_to_issue: null,
        assigned_branch: null,
      }),
      result: undefined,
    }));
  } catch (err) {
    try {
      destroyWorktree(gitRoot, entry.temp_branch, absPath);
    } catch {
      // best effort
    }
    try {
      destroyWorktree(gitRoot, newTempBranch, newAbsPath);
    } catch {
      // best effort
    }
    withLock(poolDir, (state) => ({
      state: removeWorktree(state, entry.id),
      result: undefined,
    }));
    throw new Error(
      `Recycle failed (destroyed worktree): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function refresh(): { refreshed: number; errors: string[] } {
  const gitRoot = findGitRoot();
  const poolDir = resolvePoolDirSync(gitRoot);
  git(['fetch', 'origin'], { cwd: gitRoot });

  const state = readState(poolDir);
  const warmWorktrees = state.worktrees.filter((w) => w.status === 'warm');
  let refreshed = 0;
  const errors: string[] = [];

  for (const wt of warmWorktrees) {
    const absPath = toAbs(poolDir, wt.path);
    try {
      git(['fetch', 'origin'], { cwd: absPath });
      git(['reset', '--hard', 'origin/main'], { cwd: absPath });
      execFileSync('npm', ['install'], {
        cwd: absPath,
        stdio: 'pipe',
        timeout: 300_000,
      });
      execFileSync('make', ['build-core', 'build-mcp', 'build-cli'], {
        cwd: absPath,
        stdio: 'pipe',
        timeout: 300_000,
      });

      const newSha = git(['rev-parse', 'HEAD'], { cwd: absPath });
      withLock(poolDir, (state) => ({
        state: updateWorktree(state, wt.id, {
          base_commit: newSha,
          warmed_at: new Date().toISOString(),
        }),
        result: undefined,
      }));
      refreshed++;
    } catch (err) {
      errors.push(
        `Failed to refresh ${wt.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return { refreshed, errors };
}

export function gc(): {
  removed: number;
  staleIds: string[];
  orphanIds: string[];
  errors: string[];
} {
  const gitRoot = findGitRoot();
  const poolDir = resolvePoolDirSync(gitRoot);
  const errors: string[] = [];
  const staleIds: string[] = [];
  const orphanIds: string[] = [];
  let removed = 0;

  // Get disk state — directory names inside poolDir
  const existingNames = new Set<string>();
  if (fs.existsSync(poolDir)) {
    for (const entry of fs.readdirSync(poolDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        existingNames.add(entry.name);
      }
    }
  }

  const state = readState(poolDir);

  // Remove stale worktrees
  const stale = findStaleWorktrees(state);
  for (const wt of stale) {
    try {
      destroyWorktree(gitRoot, wt.temp_branch, toAbs(poolDir, wt.path));
      withLock(poolDir, (s) => ({
        state: removeWorktree(s, wt.id),
        result: undefined,
      }));
      staleIds.push(wt.id);
      removed++;
    } catch (err) {
      errors.push(
        `Failed to remove stale ${wt.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Reconcile orphans — compare relative path names
  const stateNames = new Set(state.worktrees.map((w) => w.path));
  const inStateNotOnDisk = state.worktrees.filter((w) => !existingNames.has(w.path));
  const onDiskNotInState = [...existingNames].filter((name) => !stateNames.has(name));

  for (const wt of inStateNotOnDisk) {
    try {
      withLock(poolDir, (s) => ({
        state: removeWorktree(s, wt.id),
        result: undefined,
      }));
      try {
        git(['branch', '-D', wt.temp_branch], { cwd: gitRoot });
      } catch {
        // branch may not exist
      }
      orphanIds.push(wt.id);
      removed++;
    } catch (err) {
      errors.push(
        `Failed to clean orphan state ${wt.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  for (const dirName of onDiskNotInState) {
    try {
      const absPath = toAbs(poolDir, dirName);
      try {
        git(['worktree', 'remove', absPath, '--force'], { cwd: gitRoot });
      } catch {
        fs.rmSync(absPath, { recursive: true, force: true });
      }
      orphanIds.push(dirName);
      removed++;
    } catch (err) {
      errors.push(
        `Failed to clean orphan disk ${dirName}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  git(['worktree', 'prune'], { cwd: gitRoot });

  return { removed, staleIds, orphanIds, errors };
}

export function status(): ReturnType<typeof getPoolStatus> & { pool_dir: string } {
  const gitRoot = findGitRoot();
  const poolDir = resolvePoolDirSync(gitRoot);
  const state = readState(poolDir);
  return { ...getPoolStatus(state), pool_dir: poolDir };
}

export async function init(): Promise<{ pool_dir: string }> {
  const gitRoot = findGitRoot();
  const poolDir = await resolvePoolDir(gitRoot, { interactive: true });
  fs.mkdirSync(poolDir, { recursive: true });
  return { pool_dir: poolDir };
}
