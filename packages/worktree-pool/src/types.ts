export type WorktreeStatus =
  | 'creating'
  | 'warming'
  | 'warm'
  | 'assigned'
  | 'recycling'
  | 'destroying';

/** Supported JavaScript package managers. */
export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

/** Package-manager-specific facts about a project directory. */
export interface ProjectEnv {
  /** Detected package manager. */
  pm: PackageManager;
  /** Lockfile name (the one found on disk, or the canonical one for `pm`). */
  lockfile: string;
  /** Install command, as argv. */
  installCmd: string[];
  /** Build command as argv, or `null` when the project defines no build script. */
  buildCmd: string[] | null;
}

/**
 * Contents of `.worktree-pool.json` at the repo root. All fields are optional
 * in the file; `base_ref` is defaulted on read.
 */
export interface PoolFileConfig {
  /** Absolute path to the directory holding pool worktrees. */
  pool_dir?: string;
  /** Package root relative to the worktree root, for nested monorepos. */
  project_subdir?: string;
  /** Explicit warm-up commands (argv arrays). Wins over auto-detection. */
  warm_commands?: string[][];
  /** Git ref that pool worktrees are created from and reset to. */
  base_ref: string;
}

export interface PoolConfig {
  target_spares: number;
  max_pool_size: number;
  stale_after_hours: number;
}

export interface PoolWorktree {
  id: string;
  path: string;
  status: WorktreeStatus;
  temp_branch: string;
  base_commit: string;
  warmed_at: string;
  assigned_to_issue: number | null;
  assigned_branch: string | null;
}

export interface PoolState {
  schema_version: '1.0.0';
  config: PoolConfig;
  worktrees: PoolWorktree[];
}

export const DEFAULT_CONFIG: PoolConfig = {
  target_spares: 5,
  max_pool_size: 10,
  stale_after_hours: 72,
};

export const DEFAULT_BASE_REF = 'origin/main';

export const SCHEMA_VERSION = '1.0.0' as const;

export function generateId(): string {
  return `pool-${Date.now()}-${process.pid}`;
}
