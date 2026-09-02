import { type ExecSyncOptions, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import {
  addWorktree,
  claimWorktree as claimFromState,
  classifyPoolDirEntry,
  createEmptyState,
  findStaleWorktrees,
  getPoolStatus,
  getSparesNeeded,
  isPoolTempBranch,
  normalizePoolFileConfig,
  type PoolDirClassification,
  remoteForBaseRef,
  removeWorktree,
  updateWorktree,
  validateState,
} from './pool-state';
import {
  detectProjectEnv,
  lockfileChangedInDiff,
  lockfilePathFor,
  resolveProjectDir,
  resolveWarmCommands,
} from './project-env';
import {
  generateId,
  type PoolFileConfig,
  type PoolState,
  type PoolWorktree,
  type ProjectEnv,
  type ReturnStep,
  type WorktreeStatus,
} from './types';

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 200;
/** Per-command budget for a warm-up install/build (#561: also the floor `packages/sched`'s batch-setup warm step should give its own exec). */
export const WARM_COMMAND_TIMEOUT_MS = 300_000;
const POOL_CONFIG_FILE = '.worktree-pool.json';

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

/**
 * Read `.worktree-pool.json` from the repo root. Missing or corrupt files fall
 * back to defaults. `pool_dir`, when set, is resolved to an absolute path.
 */
export function readPoolFileConfig(gitRoot: string): PoolFileConfig {
  const configPath = getConfigPath(gitRoot);
  if (!fs.existsSync(configPath)) return normalizePoolFileConfig({});
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    // corrupt config — treat as absent
    return normalizePoolFileConfig({});
  }
  const cfg = normalizePoolFileConfig(raw);
  if (cfg.pool_dir) {
    cfg.pool_dir = path.resolve(gitRoot, cfg.pool_dir);
  }
  return cfg;
}

function readPoolDirConfig(gitRoot: string): { pool_dir: string } | null {
  const cfg = readPoolFileConfig(gitRoot);
  return cfg.pool_dir ? { pool_dir: cfg.pool_dir } : null;
}

/** Persist `pool_dir` without clobbering other keys in the config file. */
function writePoolDirConfig(gitRoot: string, poolDir: string): void {
  const configPath = getConfigPath(gitRoot);
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // corrupt config — overwrite it
    }
  }
  existing.pool_dir = path.relative(gitRoot, poolDir);
  fs.writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`);
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

// --- Warm-up commands ---

/**
 * Run the project's warm-up commands (install + build) inside a worktree.
 *
 * Commands come from `warm_commands` in `.worktree-pool.json` when set,
 * otherwise from package-manager detection. They run in
 * `<worktree>/<project_subdir>` so nested monorepo package roots work.
 */
function runWarmCommands(worktreeAbsPath: string, cfg: PoolFileConfig): void {
  const projectDir = resolveProjectDir(worktreeAbsPath, cfg.project_subdir);
  for (const cmd of resolveWarmCommands(projectDir, cfg)) {
    const [bin, ...args] = cmd;
    if (!bin) continue;
    execFileSync(bin, args, {
      cwd: projectDir,
      stdio: 'pipe',
      timeout: WARM_COMMAND_TIMEOUT_MS,
    });
  }
}

/**
 * Repo-root-relative lockfile path for a worktree, used to decide whether a
 * range of upstream commits invalidates the installed dependencies.
 */
function lockfilePathForWorktree(worktreeAbsPath: string, cfg: PoolFileConfig): string {
  const projectDir = resolveProjectDir(worktreeAbsPath, cfg.project_subdir);
  return lockfilePathFor(detectProjectEnv(projectDir), cfg.project_subdir);
}

/**
 * Did the project lockfile change between `baseCommit` and the configured base
 * ref? An unreadable diff counts as "changed" — re-warming is cheap, a stale
 * `node_modules` is not.
 */
function lockfileChangedSince(
  gitRoot: string,
  baseCommit: string,
  worktreeAbsPath: string,
  cfg: PoolFileConfig
): boolean {
  try {
    const diff = git(['diff', '--name-only', `${baseCommit}..${cfg.base_ref}`], { cwd: gitRoot });
    return lockfileChangedInDiff(diff, lockfilePathForWorktree(worktreeAbsPath, cfg));
  } catch {
    return true;
  }
}

/** Message of a thrown value, whatever it is. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Make git's error text safe to persist and re-print. `.pool-state.json` is a
 * plain file that `status` echoes back, and git quotes remote URLs verbatim in
 * its errors — including any `https://user:token@host` credentials — so an
 * unfiltered message would write a secret to disk and replay terminal escape
 * sequences from a remote on every later `status`.
 */
function sanitizeReason(text: string): string {
  return (
    text
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1<redacted>@')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes is the point
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .slice(0, 2000)
  );
}

/**
 * The value to record as an entry's `path`. State paths are contractually bare
 * directory names directly inside the pool directory (`classifyPath` matches on
 * `basename`), so anything that escapes — from a hand-edited or corrupted state
 * file — keeps the previously recorded name rather than being written back.
 */
function relativePoolPath(poolDir: string, onDiskPath: string, fallback: string): string {
  const rel = path.relative(poolDir, onDiskPath);
  const isBareSegment =
    rel.length > 0 &&
    !path.isAbsolute(rel) &&
    !rel.startsWith('..') &&
    !rel.includes(path.sep) &&
    rel !== '.';
  return isBareSegment ? rel : fallback;
}

// --- Ownership / provenance ---
//
// The pool directory is routinely shared with worktrees a developer made by
// hand (imboard-ai/ai-dossier#438). Every path that deletes a directory or a
// branch goes through this layer first; nothing is removed on the strength of
// its location alone.

/** Resolve symlinks so paths from git and from config compare equal. */
function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Absolute path of the git admin dir a linked worktree points at, or `null`
 * when the directory carries no readable `.git` link. A directory holding a
 * real `.git` directory (a whole repo, not a linked worktree) reports itself.
 */
function resolveWorktreeAdminDir(absPath: string): string | null {
  const dotGit = path.join(absPath, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;
  let raw: string;
  try {
    raw = fs.readFileSync(dotGit, 'utf-8');
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(raw);
  if (!match) return null;
  const target = match[1].trim();
  if (target.length === 0) return null;
  return path.isAbsolute(target) ? target : path.resolve(absPath, target);
}

/**
 * True when a directory that is on disk has lost the git admin dir behind it.
 *
 * This is the #443 corruption: a rename repaired without its new path leaves a
 * dangling `gitdir` forward link, and the next `git worktree prune` deletes
 * `.git/worktrees/<id>`. The directory survives with a `.git` file pointing at
 * nothing, so every git command inside it fails with
 * `fatal: not a git repository`.
 */
function isWorktreeAdminDirMissing(absPath: string): boolean {
  if (!fs.existsSync(absPath)) return false;
  const adminDir = resolveWorktreeAdminDir(absPath);
  return adminDir === null || !fs.existsSync(adminDir);
}

/**
 * Absolute worktree path -> checked-out branch, from `git worktree list`.
 * A registered worktree with a detached HEAD maps to `null`.
 */
function listWorktreeBranches(gitRoot: string): Map<string, string | null> {
  const map = new Map<string, string | null>();
  let output: string;
  try {
    output = git(['worktree', 'list', '--porcelain'], { cwd: gitRoot });
  } catch {
    return map;
  }
  let current: string | null = null;
  for (const raw of output.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('worktree ')) {
      current = realpathOrSelf(line.slice('worktree '.length));
      map.set(current, null);
    } else if (current !== null && line.startsWith('branch ')) {
      map.set(current, line.slice('branch '.length).replace(/^refs\/heads\//, ''));
    } else if (line === '') {
      current = null;
    }
  }
  return map;
}

/** Everything the provenance check needs, gathered once per command. */
interface OwnershipContext {
  gitRoot: string;
  poolDir: string;
  state: PoolState;
  branches: Map<string, string | null>;
}

function buildOwnershipContext(
  gitRoot: string,
  poolDir: string,
  state?: PoolState
): OwnershipContext {
  return {
    gitRoot,
    poolDir,
    state: state ?? readState(poolDir),
    branches: listWorktreeBranches(gitRoot),
  };
}

export interface PoolDirEntryReport extends PoolDirClassification {
  /** Directory name inside the pool directory. */
  name: string;
  /** Absolute path on disk. */
  path: string;
  /** Branch checked out there, or `null`. */
  branch: string | null;
}

/** Classify one absolute path against the pool's provenance rules. */
function classifyPath(ctx: OwnershipContext, absPath: string): PoolDirEntryReport {
  const resolved = realpathOrSelf(absPath);
  const name = path.basename(resolved);
  const poolDirReal = realpathOrSelf(ctx.poolDir);

  if (path.dirname(resolved) !== poolDirReal) {
    return {
      name,
      path: resolved,
      branch: ctx.branches.get(resolved) ?? null,
      provenance: 'foreign',
      owned: false,
      broken: false,
      reason: `outside the pool directory (${poolDirReal})`,
    };
  }

  const registered = ctx.branches.has(resolved);
  const classification = classifyPoolDirEntry({
    name,
    branch: ctx.branches.get(resolved) ?? null,
    registered,
    existsOnDisk: fs.existsSync(resolved),
    stateEntry: ctx.state.worktrees.find((w) => w.path === name) ?? null,
    adminDirMissing: registered ? false : isWorktreeAdminDirMissing(resolved),
  });

  return {
    name,
    path: resolved,
    branch: ctx.branches.get(resolved) ?? null,
    ...classification,
  };
}

/** Every directory inside the pool directory, classified. */
function scanPoolDir(ctx: OwnershipContext): PoolDirEntryReport[] {
  if (!fs.existsSync(ctx.poolDir)) return [];
  const reports: PoolDirEntryReport[] = [];
  for (const entry of fs.readdirSync(ctx.poolDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }
    reports.push(classifyPath(ctx, path.join(ctx.poolDir, entry.name)));
  }
  return reports;
}

/**
 * Split the pool directory into the two things worth reporting: worktrees the
 * pool did not create, and entries corrupted on disk (#443).
 *
 * A corrupted entry is listed only under `broken` — reporting it as foreign as
 * well would read as two separate problems with one directory.
 */
function reportPoolDirEntries(
  gitRoot: string,
  poolDir: string,
  state?: PoolState
): { foreign: PoolDirEntryReport[]; broken: PoolDirEntryReport[] } {
  const entries = scanPoolDir(buildOwnershipContext(gitRoot, poolDir, state));
  const broken = entries.filter((e) => e.broken);
  const brokenPaths = new Set(broken.map((e) => e.path));
  return {
    foreign: entries.filter((e) => !e.owned && !brokenPaths.has(e.path)),
    broken,
  };
}

/**
 * Corrupted pool directories: still on disk, but git has no admin dir for them
 * (#443). Reported so a broken pool is visible rather than surfacing as a raw
 * `fatal: not a git repository` from whichever command touched it first.
 */
export function findBrokenEntries(): PoolDirEntryReport[] {
  const gitRoot = findGitRoot();
  const poolDir = resolvePoolDirSync(gitRoot);
  return reportPoolDirEntries(gitRoot, poolDir).broken;
}

// --- Destroy helper ---

/**
 * Remove a worktree the pool created. Refuses anything it cannot prove is the
 * pool's own — the caller is expected to report the refusal, not swallow it.
 */
function destroyWorktree(ctx: OwnershipContext, tempBranch: string | null, absPath: string): void {
  const classification = classifyPath(ctx, absPath);
  if (!classification.owned) {
    throw new Error(
      `Refusing to remove ${absPath}: ${classification.reason}. ` +
        'The worktree pool only removes worktrees it created.'
    );
  }

  try {
    git(['worktree', 'remove', absPath, '--force'], { cwd: ctx.gitRoot });
  } catch {
    fs.rmSync(absPath, { recursive: true, force: true });
  }
  deletePoolTempBranch(ctx.gitRoot, tempBranch);
  git(['worktree', 'prune'], { cwd: ctx.gitRoot });
}

/**
 * Delete a `pool/spare-*` branch. Any other ref is left alone — a corrupt or
 * hand-edited `.pool-state.json` must not be able to delete a real branch.
 */
function deletePoolTempBranch(gitRoot: string, branch: string | null | undefined): void {
  if (!isPoolTempBranch(branch)) return;
  try {
    git(['branch', '-D', branch as string], { cwd: gitRoot });
  } catch {
    // branch may not exist
  }
}

// --- Public operations ---

export async function replenish(
  count?: number,
  _parallel = false
): Promise<{ created: number; errors: string[] }> {
  const gitRoot = findGitRoot();
  const cfg = readPoolFileConfig(gitRoot);
  const poolDir = await resolvePoolDir(gitRoot, { interactive: true });
  fs.mkdirSync(poolDir, { recursive: true });

  git(['fetch', remoteForBaseRef(cfg.base_ref)], { cwd: gitRoot });

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
      const sha = git(['rev-parse', cfg.base_ref], { cwd: gitRoot });
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
      git(['branch', tempBranch, cfg.base_ref], { cwd: gitRoot });
      git(['worktree', 'add', absWorktreePath, tempBranch], {
        cwd: gitRoot,
      });

      withLock(poolDir, (state) => ({
        state: updateWorktree(state, id, { status: 'warming' }),
        result: undefined,
      }));

      copyEnvFiles(gitRoot, absWorktreePath);

      runWarmCommands(absWorktreePath, cfg);

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
        destroyWorktree(buildOwnershipContext(gitRoot, poolDir), tempBranch, absWorktreePath);
      } catch (cleanupErr) {
        // A refusal here means the path is not provably ours — say so rather
        // than deleting it anyway.
        errors.push(
          `Could not clean up ${id}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
        );
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

export interface ClaimResult {
  /** Absolute path of the claimed worktree. */
  path: string;
  /**
   * Warm entries passed over because they are corrupted on disk (#443). The
   * claim still succeeds; these are reported so the pool can be repaired.
   */
  broken: PoolDirEntryReport[];
}

export function claim(issue: number, branch: string): ClaimResult | null {
  const gitRoot = findGitRoot();
  const cfg = readPoolFileConfig(gitRoot);
  const poolDir = resolvePoolDirSync(gitRoot);

  // A warm entry whose directory lost its git admin dir would fail every git
  // command with a raw `fatal: not a git repository`. Skip it and take the
  // next warm spare instead, reporting what was passed over.
  const brokenSkipped: PoolDirEntryReport[] = [];
  const result = withLock(poolDir, (state) => {
    const ctx = buildOwnershipContext(gitRoot, poolDir, state);
    const claimed = claimFromState(state, issue, branch, (candidate) => {
      const report = classifyPath(ctx, toAbs(poolDir, candidate.path));
      if (!report.broken) return true;
      brokenSkipped.push(report);
      return false;
    });
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
    const currentBase = git(['rev-parse', cfg.base_ref], { cwd: gitRoot });
    if (worktree.base_commit !== currentBase) {
      const lockChanged = lockfileChangedSince(gitRoot, worktree.base_commit, absPath, cfg);

      git(['fetch', remoteForBaseRef(cfg.base_ref)], { cwd: absPath });
      git(['reset', '--hard', cfg.base_ref], { cwd: absPath });

      if (lockChanged) {
        runWarmCommands(absPath, cfg);
      }
    }

    // Create issue branch
    git(['checkout', '-b', branch], { cwd: absPath });

    // Rename directory.
    // `git worktree repair` must be given the *new* path: a pathless repair
    // only fixes the worktree->repo back-link, leaving the repo-side
    // `.git/worktrees/<id>/gitdir` forward link pointing at the old location.
    // The next `git worktree prune` then sees a dangling gitdir, deletes the
    // admin dir, and the renamed worktree is corrupted (#443).
    if (absPath !== newAbsPath && !fs.existsSync(newAbsPath)) {
      fs.renameSync(absPath, newAbsPath);
      git(['worktree', 'repair', newAbsPath], { cwd: gitRoot });
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

    return { path: newAbsPath, broken: brokenSkipped };
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

/**
 * What a successful `return` verified before exiting (#453 AC2). Every field
 * is checked against reality after the state write, not assumed from the fact
 * that no step threw.
 */
export interface ReturnVerification {
  /** Entry status re-read from `.pool-state.json` — must be `warm`. */
  entry_status: WorktreeStatus | 'missing';
  /**
   * No *tracked* file in the recycled directory is modified. Untracked files
   * are deliberately not counted: `git clean -fd` runs before the warm
   * commands, so anything untracked at this point is warm-command output, and
   * `replenish` marks exactly that state `warm` without complaint. Failing
   * here on it would make `return` stricter than the path that created the
   * spare in the first place.
   */
  directory_clean: boolean;
  /** Offending `git status --porcelain` entries when `directory_clean` is false. */
  dirty_entries: string[];
  /** Branch actually checked out — must be the new `pool/spare-*` temp branch. */
  checked_out_branch: string | null;
  /** The temp branch the recycle intended to leave behind. */
  expected_branch: string;
}

/** Outcome of a successful `returnWorktree`. */
export interface ReturnResult {
  /** New pool entry id after recycling. */
  id: string;
  /** Absolute path the recycled worktree now lives at. */
  path: string;
  /** The self-check that ran before this result was returned. */
  verification: ReturnVerification;
}

/**
 * A `return` that failed, tagged with the step that failed (#453 AC1). The
 * pool entry has been left in `status: 'broken'` — not `assigned`, not `warm`
 * — and the worktree directory is deliberately NOT destroyed, so the failure
 * is inspectable and `gc` can clear it deliberately.
 *
 * `markError` is the one case where that promise could not be kept: the
 * broken-marking write itself failed. Callers must report it rather than
 * assume the entry is marked, or they reproduce the very bug #453 is about.
 */
export class ReturnFailure extends Error {
  readonly step: ReturnStep;
  readonly entryId: string | null;
  readonly worktreePath: string;
  /** Why the entry could NOT be marked broken, or `null` when it was marked. */
  readonly markError: string | null;

  constructor(
    step: ReturnStep,
    worktreePath: string,
    entryId: string | null,
    cause: unknown,
    markError: string | null = null
  ) {
    super(`return failed at step '${step}': ${messageOf(cause)}`, { cause });
    this.name = 'ReturnFailure';
    this.step = step;
    this.entryId = entryId;
    this.worktreePath = worktreePath;
    this.markError = markError;
  }
}

/** Run `fn`, tagging any throw with the step it happened in. */
function step<T>(name: ReturnStep, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    // Kept so that if a step is ever nested inside another, the innermost
    // attribution wins rather than being overwritten by its caller.
    if (err instanceof StepError) throw err;
    throw new StepError(name, err);
  }
}

/** Internal carrier so `step` can attribute a failure without unwinding twice. */
class StepError extends Error {
  readonly step: ReturnStep;
  constructor(stepName: ReturnStep, cause: unknown) {
    super(messageOf(cause), { cause });
    this.name = 'StepError';
    this.step = stepName;
  }
}

/** Branch checked out at `absPath`, or `null` when it cannot be determined. */
function currentBranchOf(absPath: string): string | null {
  try {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: absPath });
    return branch === 'HEAD' ? null : branch;
  } catch {
    return null;
  }
}

/**
 * Tracked-file cleanliness of `absPath`. A git failure is reported as an error
 * rather than as "dirty" — telling an operator to look for uncommitted changes
 * that do not exist is the wrong place to send them.
 */
function inspectWorktreeCleanliness(absPath: string): { clean: boolean; entries: string[] } {
  let output: string;
  try {
    output = git(['status', '--porcelain', '--untracked-files=no'], { cwd: absPath });
  } catch (err) {
    return { clean: false, entries: [`git status failed: ${messageOf(err)}`] };
  }
  const entries = output.length === 0 ? [] : output.split('\n');
  return { clean: entries.length === 0, entries };
}

/**
 * Verify a finished recycle against reality (#453 AC2). Separate from
 * `returnWorktree` so the rules are readable and testable on their own.
 */
function verifyRecycled(
  poolDir: string,
  newId: string,
  newAbsPath: string,
  newTempBranch: string
): ReturnVerification {
  const committed = readState(poolDir).worktrees.find((w) => w.id === newId);
  const cleanliness = inspectWorktreeCleanliness(newAbsPath);
  const result: ReturnVerification = {
    entry_status: committed?.status ?? 'missing',
    directory_clean: cleanliness.clean,
    dirty_entries: cleanliness.entries,
    checked_out_branch: currentBranchOf(newAbsPath),
    expected_branch: newTempBranch,
  };

  const problems: string[] = [];
  if (result.entry_status !== 'warm') {
    problems.push(`entry status is '${result.entry_status}', expected 'warm'`);
  }
  if (!result.directory_clean) {
    problems.push(
      `directory ${newAbsPath} is not clean: ${result.dirty_entries.slice(0, 5).join(', ')}`
    );
  }
  if (result.checked_out_branch !== newTempBranch) {
    problems.push(
      `checked-out branch is '${result.checked_out_branch ?? 'detached HEAD'}', ` +
        `expected '${newTempBranch}'`
    );
  }
  if (problems.length > 0) {
    throw new Error(`post-return self-check failed: ${problems.join('; ')}`);
  }
  return result;
}

/**
 * Mark a pool entry `broken` after a failed recycle. Returns `null` on
 * success, or the reason the mark itself failed — never throws, because the
 * caller is already reporting a failure and must not lose it, but never
 * silently either: an unmarked entry is the #453 bug.
 */
function markEntryBroken(
  poolDir: string,
  entryId: string,
  updates: Partial<PoolWorktree>
): string | null {
  try {
    withLock(poolDir, (state) => ({
      state: updateWorktree(state, entryId, updates),
      result: undefined,
    }));
    return null;
  } catch (err) {
    return messageOf(err);
  }
}

/**
 * Recycle an assigned worktree back to `warm`.
 *
 * Transactional in outcome (#453): it either finishes and returns a verified
 * `warm` entry, or it leaves the entry `broken` and throws a `ReturnFailure`
 * naming the step. It never leaves the entry `assigned`, never reports success
 * over an unverified pool, and — unlike the pre-#453 behaviour — never
 * destroys the worktree on failure. A broken entry keeps its provenance
 * (recorded id, actual on-disk path, a pool-owned temp branch) so `status`
 * shows it and `gc` can remove it.
 */
export function returnWorktree(worktreePath: string): ReturnResult {
  const gitRoot = findGitRoot();
  const cfg = readPoolFileConfig(gitRoot);
  const poolDir = resolvePoolDirSync(gitRoot);
  const absPath = path.resolve(worktreePath);

  const newId = generateId();
  const newTempBranch = `pool/spare-${newId}`;
  const newAbsPath = toAbs(poolDir, newId);

  // Look up the entry and mark it `recycling`, atomically. This is the one
  // failure with no entry to mark broken — there is no entry — but it still
  // speaks the ReturnFailure contract so the CLI and library callers get the
  // step name rather than a bare internal error.
  let entry: PoolWorktree;
  try {
    entry = withLock(poolDir, (state) => {
      const found = state.worktrees.find((w) => toAbs(poolDir, w.path) === absPath);
      if (!found) {
        throw new Error(
          `Worktree not found in pool state: ${worktreePath} (resolved to ${absPath}); ` +
            `pool dir ${poolDir} tracks ${state.worktrees.length} entries`
        );
      }
      return {
        state: updateWorktree(state, found.id, { status: 'recycling' }),
        result: { ...found },
      };
    });
  } catch (err) {
    throw new ReturnFailure('lookup', absPath, null, err);
  }

  // Where the directory, its branch and its state row actually are right now.
  // Updated as the steps progress so a failure after a partial rename — or
  // after `commit-state` has already renamed the entry id — records the truth
  // rather than the values we started from.
  let livePath = absPath;
  let liveTempBranch = entry.temp_branch;
  let liveId = entry.id;

  try {
    step('fetch', () => git(['fetch', remoteForBaseRef(cfg.base_ref)], { cwd: livePath }));

    step('checkout-temp-branch', () =>
      git(['checkout', '-b', newTempBranch, cfg.base_ref], { cwd: livePath })
    );
    liveTempBranch = newTempBranch;

    step('clean', () => git(['clean', '-fd'], { cwd: livePath }));

    const assignedBranch = entry.assigned_branch;
    if (assignedBranch) {
      // Best-effort: the branch may already be gone. Anything else is worth
      // saying out loud — a surviving branch collides on the next claim.
      try {
        git(['branch', '-D', assignedBranch], { cwd: livePath });
      } catch (err) {
        const msg = messageOf(err);
        if (!/not found|no branch named/i.test(msg)) {
          console.error(`Warning: could not delete assigned branch '${assignedBranch}': ${msg}`);
        }
      }
    }

    if (livePath !== newAbsPath) {
      step('rename', () => {
        if (fs.existsSync(newAbsPath)) {
          throw new Error(`Recycle target already exists: ${newAbsPath}`);
        }
        fs.renameSync(livePath, newAbsPath);
      });
      livePath = newAbsPath;
      // Repair the moved worktree by its new path — see the note in `claim`;
      // a pathless repair leaves a dangling gitdir for `prune` to delete (#443).
      step('repair', () => git(['worktree', 'repair', newAbsPath], { cwd: gitRoot }));
    }

    const currentBase = step('read-base-commit', () =>
      git(['rev-parse', cfg.base_ref], { cwd: gitRoot })
    );

    step('warm-commands', () => {
      if (lockfileChangedSince(gitRoot, entry.base_commit, newAbsPath, cfg)) {
        runWarmCommands(newAbsPath, cfg);
      }
    });

    step('commit-state', () =>
      withLock(poolDir, (state) => ({
        state: updateWorktree(state, liveId, {
          id: newId,
          path: newId,
          status: 'warm',
          temp_branch: newTempBranch,
          base_commit: currentBase,
          warmed_at: new Date().toISOString(),
          assigned_to_issue: null,
          assigned_branch: null,
          broken_step: undefined,
          broken_reason: undefined,
          broken_branch: undefined,
        }),
        result: undefined,
      }))
    );
    // `commit-state` renamed the row. Anything that fails from here on must
    // mark THIS id, or the entry silently stays `warm` and claimable (#453).
    liveId = newId;

    // AC2: verify against reality before claiming success. A pool that only
    // *says* it is warm is what #453 is about.
    return {
      id: newId,
      path: newAbsPath,
      verification: step('verify', () => verifyRecycled(poolDir, newId, newAbsPath, newTempBranch)),
    };
  } catch (err) {
    const failedStep: ReturnStep = err instanceof StepError ? err.step : 'unknown';
    const cause = err instanceof StepError ? (err.cause ?? err) : err;
    const reason = sanitizeReason(messageOf(cause));

    // Mark broken instead of destroying (#453). The directory stays on disk so
    // the failure can be inspected; the entry points at where the directory
    // actually is so `classifyPoolDirEntry` still calls it ours and `gc` can
    // clear it.
    const onDiskPath = fs.existsSync(livePath) ? livePath : absPath;
    const observedBranch = currentBranchOf(onDiskPath);
    const markError = markEntryBroken(poolDir, liveId, {
      status: 'broken',
      path: relativePoolPath(poolDir, onDiskPath, entry.path),
      // NEVER widen provenance from what happens to be checked out: recording
      // a developer's branch here would make `classifyPoolDirEntry`'s ownership
      // test tautological and hand `gc` a directory it must refuse (#438).
      temp_branch: isPoolTempBranch(observedBranch) ? (observedBranch as string) : liveTempBranch,
      broken_step: failedStep,
      broken_reason: reason,
      broken_branch: observedBranch,
    });

    throw new ReturnFailure(failedStep, onDiskPath, liveId, cause, markError);
  }
}

export interface RefreshResult {
  refreshed: number;
  /** Worktrees left untouched because provenance could not be confirmed. */
  skipped: PoolDirEntryReport[];
  errors: string[];
}

export function refresh(): RefreshResult {
  const gitRoot = findGitRoot();
  const cfg = readPoolFileConfig(gitRoot);
  const poolDir = resolvePoolDirSync(gitRoot);
  git(['fetch', remoteForBaseRef(cfg.base_ref)], { cwd: gitRoot });

  const state = readState(poolDir);
  const ctx = buildOwnershipContext(gitRoot, poolDir, state);
  const warmWorktrees = state.worktrees.filter((w) => w.status === 'warm');
  let refreshed = 0;
  const skipped: PoolDirEntryReport[] = [];
  const errors: string[] = [];

  for (const wt of warmWorktrees) {
    const absPath = toAbs(poolDir, wt.path);
    // `git reset --hard` destroys uncommitted work, so it is only ever pointed
    // at a directory that still looks like the pool worktree state describes.
    const classification = classifyPath(ctx, absPath);
    if (!classification.owned) {
      skipped.push(classification);
      continue;
    }
    try {
      git(['fetch', remoteForBaseRef(cfg.base_ref)], { cwd: absPath });
      git(['reset', '--hard', cfg.base_ref], { cwd: absPath });
      runWarmCommands(absPath, cfg);

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

  return { refreshed, skipped, errors };
}

export interface GcOptions {
  /** Report what would be removed and exit without touching anything. */
  dryRun?: boolean;
  /** Approve the removal list without prompting. */
  yes?: boolean;
  /** Override TTY detection for the confirmation prompt. */
  interactive?: boolean;
}

export type GcCandidateKind =
  /** Pool worktree past `stale_after_hours` — removed from disk and state. */
  | 'stale'
  /** State row with nothing (of ours) on disk — the row is dropped, disk untouched. */
  | 'orphan-state'
  /** Pool-created directory missing from state — removed from disk. */
  | 'orphan-disk'
  /** Entry a `return` left broken (#453) — removed from disk and state. */
  | 'broken';

export interface GcCandidate {
  kind: GcCandidateKind;
  /** Pool worktree id, or the directory name for a disk-only orphan. */
  id: string;
  /** Absolute path, or `null` when only a state row is dropped. */
  path: string | null;
  /** Branch to delete along with it, when it is one of ours. */
  tempBranch: string | null;
  reason: string;
}

export interface GcResult {
  removed: number;
  staleIds: string[];
  orphanIds: string[];
  /** Entries removed because a `return` had left them broken (#453). */
  brokenIds: string[];
  /** Everything in the pool directory the pool refuses to touch. */
  foreign: PoolDirEntryReport[];
  /** The exact removal list, whether or not it was executed. */
  candidates: GcCandidate[];
  dryRun: boolean;
  /** `true` when confirmation was missing and nothing was removed. */
  aborted: boolean;
  errors: string[];
}

function describeGcPlan(candidates: GcCandidate[], foreign: PoolDirEntryReport[]): void {
  if (candidates.length === 0) {
    console.error('Nothing to remove.');
  } else {
    console.error(`Will remove ${candidates.length} item(s):`);
    for (const c of candidates) {
      const target = c.path ?? '(state entry only)';
      console.error(`  [${c.kind}] ${target}`);
      console.error(`      ${c.reason}`);
    }
  }
  if (foreign.length > 0) {
    console.error(`\nForeign, skipped (${foreign.length}) — not created by the pool:`);
    for (const f of foreign) {
      console.error(`  ${f.path}`);
      console.error(`      ${f.reason}`);
    }
  }
}

export async function gc(opts: GcOptions = {}): Promise<GcResult> {
  const gitRoot = findGitRoot();
  const poolDir = resolvePoolDirSync(gitRoot);
  const errors: string[] = [];
  const staleIds: string[] = [];
  const orphanIds: string[] = [];
  const brokenIds: string[] = [];
  let removed = 0;

  const state = readState(poolDir);
  const ctx = buildOwnershipContext(gitRoot, poolDir, state);
  const onDisk = scanPoolDir(ctx);
  const foreign = onDisk.filter((e) => !e.owned);
  const ownedNames = new Set(onDisk.filter((e) => e.owned).map((e) => e.name));

  const candidates: GcCandidate[] = [];
  const claimed = new Set<string>();

  // Entries a `return` left broken (#453). Collected immediately rather than
  // after `stale_after_hours`: they are unusable from the moment they are
  // marked, they occupy `max_pool_size` capacity until removed, and the CLI
  // tells the operator to clear them with `gc`. Still routed through
  // `classifyPath`, the removal plan, and the --yes/TTY confirmation.
  for (const wt of state.worktrees) {
    if (wt.status !== 'broken') continue;
    claimed.add(wt.id);
    const classification = classifyPath(ctx, toAbs(poolDir, wt.path));
    const why =
      `return failed at '${wt.broken_step ?? 'unknown'}': ` +
      `${(wt.broken_reason ?? 'unknown').split('\n')[0]}`;
    candidates.push({
      kind: classification.owned ? 'broken' : 'orphan-state',
      id: wt.id,
      path: classification.owned ? toAbs(poolDir, wt.path) : null,
      tempBranch: wt.temp_branch,
      reason: classification.owned
        ? `${why}; ${classification.reason}`
        : `${why}; directory is ${classification.reason} — directory left on disk`,
    });
  }

  // Stale pool worktrees.
  for (const wt of findStaleWorktrees(state)) {
    if (claimed.has(wt.id)) continue;
    claimed.add(wt.id);
    const classification = classifyPath(ctx, toAbs(poolDir, wt.path));
    if (classification.owned) {
      candidates.push({
        kind: 'stale',
        id: wt.id,
        path: toAbs(poolDir, wt.path),
        tempBranch: wt.temp_branch,
        reason: `stale past ${state.config.stale_after_hours}h (warmed ${wt.warmed_at}); ${classification.reason}`,
      });
    } else {
      // The directory this row points at is no longer ours. Drop the row so the
      // pool is not wedged, but leave the directory alone.
      candidates.push({
        kind: 'orphan-state',
        id: wt.id,
        path: null,
        tempBranch: wt.temp_branch,
        reason: `stale state entry for ${wt.path}, which is ${classification.reason} — directory left on disk`,
      });
    }
  }

  // State rows whose directory is gone (or was never ours).
  for (const wt of state.worktrees) {
    if (claimed.has(wt.id)) continue;
    if (ownedNames.has(wt.path)) continue;
    claimed.add(wt.id);
    const classification = classifyPath(ctx, toAbs(poolDir, wt.path));
    candidates.push({
      kind: 'orphan-state',
      id: wt.id,
      path: null,
      tempBranch: wt.temp_branch,
      reason: `state entry for ${wt.path}: ${classification.reason}`,
    });
  }

  // Pool-created directories with no state row.
  const stateNames = new Set(state.worktrees.map((w) => w.path));
  for (const entry of onDisk) {
    if (!entry.owned || stateNames.has(entry.name)) continue;
    candidates.push({
      kind: 'orphan-disk',
      id: entry.name,
      path: entry.path,
      tempBranch: entry.branch,
      reason: entry.reason,
    });
  }

  describeGcPlan(candidates, foreign);

  const base = { staleIds, orphanIds, brokenIds, foreign, candidates, errors };

  if (opts.dryRun) {
    console.error('\nDry run — nothing was removed.');
    return { ...base, removed: 0, dryRun: true, aborted: false };
  }

  if (candidates.length > 0 && !opts.yes) {
    const interactive = opts.interactive ?? Boolean(process.stdin.isTTY);
    if (!interactive) {
      console.error('\nRefusing to remove without confirmation. Re-run with --yes (or --dry-run).');
      return { ...base, removed: 0, dryRun: false, aborted: true };
    }
    const answer = await promptUser(`\nRemove ${candidates.length} item(s)? [y/N]: `);
    if (!/^y(es)?$/i.test(answer)) {
      console.error('Aborted — nothing was removed.');
      return { ...base, removed: 0, dryRun: false, aborted: true };
    }
  }

  for (const c of candidates) {
    try {
      if (c.path !== null) {
        destroyWorktree(ctx, c.tempBranch, c.path);
      } else {
        deletePoolTempBranch(gitRoot, c.tempBranch);
      }
      if (c.kind !== 'orphan-disk') {
        withLock(poolDir, (s) => ({
          state: removeWorktree(s, c.id),
          result: undefined,
        }));
      }
      if (c.kind === 'stale') staleIds.push(c.id);
      else if (c.kind === 'broken') brokenIds.push(c.id);
      else orphanIds.push(c.id);
      removed++;
    } catch (err) {
      errors.push(
        `Failed to remove ${c.path ?? c.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  git(['worktree', 'prune'], { cwd: gitRoot });

  return { ...base, removed, dryRun: false, aborted: false };
}

export function status(): ReturnType<typeof getPoolStatus> & {
  pool_dir: string;
  /** Worktrees sharing the pool directory that the pool did not create. */
  foreign: PoolDirEntryReport[];
  /** Directories on disk that git no longer has an admin dir for (#443). */
  broken: PoolDirEntryReport[];
} {
  const gitRoot = findGitRoot();
  const poolDir = resolvePoolDirSync(gitRoot);
  const state = readState(poolDir);
  const { foreign, broken } = reportPoolDirEntries(gitRoot, poolDir, state);
  return {
    ...getPoolStatus(state),
    pool_dir: poolDir,
    foreign,
    broken,
  };
}

/**
 * Detect the project environment for `dir`, or — when omitted — for this
 * repo's package root (git root plus `project_subdir` from the pool config).
 */
export function detect(dir?: string): ProjectEnv {
  if (dir) {
    return detectProjectEnv(path.resolve(dir));
  }
  let gitRoot: string;
  try {
    gitRoot = findGitRoot();
  } catch {
    return detectProjectEnv(process.cwd());
  }
  const cfg = readPoolFileConfig(gitRoot);
  return detectProjectEnv(resolveProjectDir(gitRoot, cfg.project_subdir));
}

export async function init(): Promise<{ pool_dir: string }> {
  const gitRoot = findGitRoot();
  const poolDir = await resolvePoolDir(gitRoot, { interactive: true });
  fs.mkdirSync(poolDir, { recursive: true });
  return { pool_dir: poolDir };
}
