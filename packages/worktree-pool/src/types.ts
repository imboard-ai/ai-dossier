export type WorktreeStatus =
  | 'creating'
  | 'warming'
  | 'warm'
  | 'assigned'
  | 'recycling'
  | 'destroying'
  /**
   * A recycle (`return`) failed part-way. The entry is deliberately left
   * behind rather than deleted (#453) so the failure is visible to `status`,
   * and it is never handed out again — `claim` only ever selects `warm`.
   * `gc` collects it immediately (not after `stale_after_hours`), under the
   * same ownership rules as everything else.
   *
   * Distinct from `PoolDirClassification.broken`, which is the *disk-level*
   * #443 sense: a directory whose git admin dir is gone. An entry can be one,
   * the other, or both.
   */
  | 'broken';

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
  /**
   * Which step of `return` failed, when `status` is `broken` (#453). Named so
   * a caller reading `status --json` learns what went wrong without having to
   * re-derive it from the directory.
   */
  broken_step?: ReturnStep;
  /** The underlying error message for `broken_step`, credential-redacted. */
  broken_reason?: string;
  /**
   * Branch observed in the directory at the moment of failure. Diagnostic
   * only — deliberately NOT written to `temp_branch`, which must stay a
   * pool-owned ref so the ownership check that protects developer worktrees
   * (#438) cannot be satisfied by whatever happens to be checked out.
   */
  broken_branch?: string | null;
}

/**
 * Named steps of `returnWorktree`, in execution order. Every failure is
 * attributed to exactly one of these; the name is printed and, for every step
 * after `lookup`, recorded on the broken entry (#453). `lookup` fails before
 * there is an entry to mark, and `unknown` is the fallback for a throw that
 * escaped the step wrappers.
 */
export type ReturnStep =
  | 'lookup'
  | 'fetch'
  | 'checkout-temp-branch'
  | 'clean'
  | 'rename'
  | 'repair'
  | 'read-base-commit'
  | 'warm-commands'
  | 'commit-state'
  | 'verify'
  | 'unknown';

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
