import {
  DEFAULT_BASE_REF,
  DEFAULT_CONFIG,
  type PoolConfig,
  type PoolFileConfig,
  type PoolState,
  type PoolWorktree,
  SCHEMA_VERSION,
} from './types';

/**
 * Normalize raw `.worktree-pool.json` contents into a `PoolFileConfig`.
 *
 * Lenient by design — a malformed optional key is dropped rather than thrown,
 * so a hand-edited config can never wedge the pool. `pool_dir` is returned as
 * written (callers resolve it against the git root).
 */
export function normalizePoolFileConfig(raw: unknown): PoolFileConfig {
  const cfg: PoolFileConfig = { base_ref: DEFAULT_BASE_REF };
  if (!raw || typeof raw !== 'object') return cfg;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.pool_dir === 'string' && obj.pool_dir.length > 0) {
    cfg.pool_dir = obj.pool_dir;
  }

  if (typeof obj.project_subdir === 'string') {
    const trimmed = obj.project_subdir
      .trim()
      .replace(/^\.\/+/, '')
      .replace(/[/\\]+$/, '');
    if (trimmed.length > 0 && trimmed !== '.') {
      cfg.project_subdir = trimmed;
    }
  }

  if (Array.isArray(obj.warm_commands)) {
    const commands = obj.warm_commands.filter(
      (cmd): cmd is string[] =>
        Array.isArray(cmd) && cmd.length > 0 && cmd.every((part) => typeof part === 'string')
    );
    if (commands.length > 0) {
      cfg.warm_commands = commands.map((cmd) => [...cmd]);
    }
  }

  if (typeof obj.base_ref === 'string' && obj.base_ref.trim().length > 0) {
    cfg.base_ref = obj.base_ref.trim();
  }

  return cfg;
}

/**
 * Remote name implied by a base ref (`origin/main` -> `origin`). Refs without a
 * remote prefix (`main`) fall back to `origin`.
 */
export function remoteForBaseRef(baseRef: string): string {
  const slash = baseRef.indexOf('/');
  if (slash <= 0) return 'origin';
  return baseRef.slice(0, slash);
}

export function createEmptyState(configOverrides?: Partial<PoolConfig>): PoolState {
  return {
    schema_version: SCHEMA_VERSION,
    config: { ...DEFAULT_CONFIG, ...configOverrides },
    worktrees: [],
  };
}

export function validateState(data: unknown): PoolState {
  if (!data || typeof data !== 'object') {
    throw new Error('Pool state must be an object');
  }
  const obj = data as Record<string, unknown>;
  if (obj.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `Unsupported schema version: ${obj.schema_version} (expected ${SCHEMA_VERSION})`
    );
  }
  if (!obj.config || typeof obj.config !== 'object') {
    throw new Error('Pool state must have a config object');
  }
  const config = obj.config as Record<string, unknown>;
  if (
    typeof config.target_spares !== 'number' ||
    config.target_spares < 1 ||
    config.target_spares > 50
  ) {
    throw new Error('config.target_spares must be a number between 1 and 50');
  }
  if (
    typeof config.max_pool_size !== 'number' ||
    config.max_pool_size < 1 ||
    config.max_pool_size > 100
  ) {
    throw new Error('config.max_pool_size must be a number between 1 and 100');
  }
  if (typeof config.stale_after_hours !== 'number' || config.stale_after_hours < 1) {
    throw new Error('config.stale_after_hours must be a positive number');
  }
  if (!Array.isArray(obj.worktrees)) {
    throw new Error('Pool state must have a worktrees array');
  }
  return data as PoolState;
}

export function addWorktree(state: PoolState, worktree: PoolWorktree): PoolState {
  if (state.worktrees.length >= state.config.max_pool_size) {
    throw new Error(`Pool is at max capacity (${state.config.max_pool_size})`);
  }
  return {
    ...state,
    worktrees: [...state.worktrees, worktree],
  };
}

export function updateWorktree(
  state: PoolState,
  id: string,
  updates: Partial<PoolWorktree>
): PoolState {
  const idx = state.worktrees.findIndex((w) => w.id === id);
  if (idx === -1) {
    throw new Error(`Worktree not found: ${id}`);
  }
  const worktrees = [...state.worktrees];
  worktrees[idx] = { ...worktrees[idx], ...updates };
  return { ...state, worktrees };
}

export function removeWorktree(state: PoolState, id: string): PoolState {
  return {
    ...state,
    worktrees: state.worktrees.filter((w) => w.id !== id),
  };
}

/**
 * Claim the first warm worktree, optionally skipping ones the caller cannot
 * use. `isUsable` exists so a corrupted entry (directory on disk, git admin
 * dir pruned away — imboard-ai/ai-dossier#443) is passed over in favour of the
 * next warm spare instead of being handed out and failing with a raw
 * `fatal: not a git repository`.
 */
export function claimWorktree(
  state: PoolState,
  issue: number,
  branch: string,
  isUsable?: (worktree: PoolWorktree) => boolean
): { state: PoolState; worktree: PoolWorktree } | null {
  const warm = state.worktrees.find(
    (w) => w.status === 'warm' && (isUsable === undefined || isUsable(w))
  );
  if (!warm) return null;

  const updated: PoolWorktree = {
    ...warm,
    status: 'assigned',
    assigned_to_issue: issue,
    assigned_branch: branch,
  };

  return {
    state: updateWorktree(state, warm.id, updated),
    worktree: updated,
  };
}

export function getWarmCount(state: PoolState): number {
  return state.worktrees.filter((w) => w.status === 'warm').length;
}

export function getAssignedCount(state: PoolState): number {
  return state.worktrees.filter((w) => w.status === 'assigned').length;
}

/** Entries a `return` left broken (#453) — unusable, and never claimed. */
export function getBrokenCount(state: PoolState): number {
  return state.worktrees.filter((w) => w.status === 'broken').length;
}

export function getSparesNeeded(state: PoolState): number {
  const warmCount = getWarmCount(state);
  const totalCount = state.worktrees.length;
  const capacityLeft = state.config.max_pool_size - totalCount;
  const sparesNeeded = state.config.target_spares - warmCount;
  return Math.max(0, Math.min(sparesNeeded, capacityLeft));
}

export function findStaleWorktrees(state: PoolState, now: Date = new Date()): PoolWorktree[] {
  const cutoff = now.getTime() - state.config.stale_after_hours * 60 * 60 * 1000;
  return state.worktrees.filter((w) => {
    if (w.status === 'assigned') return false;
    const warmedAt = new Date(w.warmed_at).getTime();
    return warmedAt < cutoff;
  });
}

export function findOrphans(
  state: PoolState,
  existingPaths: Set<string>
): {
  inStateNotOnDisk: PoolWorktree[];
  onDiskNotInState: string[];
} {
  const inStateNotOnDisk = state.worktrees.filter((w) => !existingPaths.has(w.path));
  const statePaths = new Set(state.worktrees.map((w) => w.path));
  const onDiskNotInState = [...existingPaths].filter((p) => !statePaths.has(p));
  return { inStateNotOnDisk, onDiskNotInState };
}

export interface PoolStatus {
  warm: number;
  assigned: number;
  creating: number;
  /**
   * Entries a `return` left broken (#453). Counted separately from `other` so
   * a caller doing the obvious health check on `status --json` cannot read a
   * pool with a failed return as healthy.
   */
  broken_entries: number;
  other: number;
  total: number;
  spares_needed: number;
  config: PoolConfig;
  worktrees: PoolWorktree[];
}

export function getPoolStatus(state: PoolState): PoolStatus {
  const warm = getWarmCount(state);
  const assigned = getAssignedCount(state);
  const brokenEntries = getBrokenCount(state);
  const creating = state.worktrees.filter(
    (w) => w.status === 'creating' || w.status === 'warming'
  ).length;
  const other = state.worktrees.length - warm - assigned - creating - brokenEntries;

  return {
    warm,
    assigned,
    creating,
    broken_entries: brokenEntries,
    other,
    total: state.worktrees.length,
    spares_needed: getSparesNeeded(state),
    config: state.config,
    worktrees: state.worktrees,
  };
}

// --- Provenance ---
//
// `pool_dir` is routinely the same directory a developer keeps their own
// worktrees in (imboard-ai/ai-dossier#438: `gc` deleted 29 of them). Location
// inside `pool_dir` is therefore never evidence of ownership — provenance is.

/** Directory-name shape of a worktree the pool created itself (`generateId()`). */
export const POOL_DIR_NAME_PATTERN = /^pool-\d+-\d+$/;

/** Prefix of the temp branch the pool checks out in its own spare worktrees. */
export const POOL_TEMP_BRANCH_PREFIX = 'pool/spare-';

/** True when `name` matches the pool's own `pool-<timestamp>-<pid>` naming. */
export function isPoolDirName(name: string): boolean {
  return POOL_DIR_NAME_PATTERN.test(name);
}

/** True when `branch` is one of the pool's own `pool/spare-*` temp branches. */
export function isPoolTempBranch(branch: string | null | undefined): boolean {
  return (
    typeof branch === 'string' &&
    branch.startsWith(POOL_TEMP_BRANCH_PREFIX) &&
    branch.length > POOL_TEMP_BRANCH_PREFIX.length
  );
}

export type PoolProvenance =
  /** Recorded in `.pool-state.json`. */
  | 'tracked'
  /** Not in state, but unmistakably created by the pool (name + temp branch). */
  | 'pool-created'
  /** Anything else — someone else's worktree, or a directory we cannot vouch for. */
  | 'foreign';

export interface PoolDirEntryInput {
  /** Directory name inside the pool directory. */
  name: string;
  /** Branch checked out there, or `null` for detached HEAD / not a worktree. */
  branch: string | null;
  /** Whether git lists the directory as a worktree of this repo. */
  registered: boolean;
  /** Whether the directory exists on disk. */
  existsOnDisk: boolean;
  /** Matching `.pool-state.json` entry, when there is one. */
  stateEntry: PoolWorktree | null;
  /**
   * Whether the directory's git admin dir (`.git/worktrees/<id>`) is gone, so
   * every git command inside it fails with `fatal: not a git repository`.
   * Undefined when the caller did not look.
   */
  adminDirMissing?: boolean;
}

export interface PoolDirClassification {
  provenance: PoolProvenance;
  /** `true` only when the pool may remove this directory. */
  owned: boolean;
  /** Human-readable justification, printed by `gc` and `status`. */
  reason: string;
  /**
   * Directory is on disk but git has no admin dir for it, so it is unusable
   * until repaired or removed. Reported by `status` and skipped by `claim`
   * rather than being handed out and failing mid-operation.
   */
  broken: boolean;
}

/**
 * Decide whether a directory inside the pool directory belongs to the pool.
 *
 * Owned iff it is recorded in `.pool-state.json` (and still looks like the
 * worktree that record describes), or it carries both of the pool's own marks:
 * a `pool-<timestamp>-<pid>` directory name *and* a `pool/spare-*` branch.
 * Everything else is foreign and must never be removed.
 *
 * Ownership and brokenness are independent: `broken` says the directory is
 * unusable, never that it may be deleted.
 */
export function classifyPoolDirEntry(input: PoolDirEntryInput): PoolDirClassification {
  const { name, branch, registered, existsOnDisk, stateEntry, adminDirMissing } = input;
  const branchLabel = branch ?? (registered ? 'detached HEAD' : 'no branch');

  // A directory git no longer lists, whose `.git` link points at an admin dir
  // that is gone. Only claimed for directories we have some reason to believe
  // were worktrees of ours — a plain scratch directory is merely foreign.
  const broken =
    existsOnDisk === true &&
    registered === false &&
    adminDirMissing === true &&
    (stateEntry !== null || isPoolDirName(name));
  const brokenNote = broken
    ? ' — its git admin dir is gone (a `git worktree prune` after an unrepaired ' +
      'rename), so every git command inside it fails'
    : '';

  if (stateEntry) {
    if (!existsOnDisk) {
      return {
        provenance: 'tracked',
        owned: true,
        broken,
        reason: `recorded in .pool-state.json as ${stateEntry.id}, already gone from disk`,
      };
    }
    // A developer worktree is always registered with git, so an unregistered
    // directory carrying a name we wrote into our own state is ours.
    if (!registered) {
      return {
        provenance: 'tracked',
        owned: true,
        broken,
        reason:
          `recorded in .pool-state.json as ${stateEntry.id}, no longer a ` +
          `registered worktree${brokenNote}`,
      };
    }
    if (
      branch === stateEntry.temp_branch ||
      (stateEntry.assigned_branch !== null && branch === stateEntry.assigned_branch) ||
      isPoolTempBranch(branch)
    ) {
      return {
        provenance: 'tracked',
        owned: true,
        broken,
        reason: `recorded in .pool-state.json as ${stateEntry.id} (${branchLabel})`,
      };
    }
    return {
      provenance: 'foreign',
      owned: false,
      broken,
      reason:
        `recorded in .pool-state.json as ${stateEntry.id}, but ${name} now has ` +
        `${branchLabel} checked out instead of ${stateEntry.temp_branch}`,
    };
  }

  if (!isPoolDirName(name)) {
    return {
      provenance: 'foreign',
      owned: false,
      broken,
      reason:
        'not recorded in .pool-state.json and the directory name does not match ' +
        "the pool's own pool-<timestamp>-<pid> naming",
    };
  }
  if (!registered) {
    return {
      provenance: 'foreign',
      owned: false,
      broken,
      reason:
        "matches the pool's directory naming but is not a registered git worktree, " +
        `so its provenance cannot be confirmed${brokenNote}`,
    };
  }
  if (!isPoolTempBranch(branch)) {
    return {
      provenance: 'foreign',
      owned: false,
      broken,
      reason:
        `matches the pool's directory naming but has ${branchLabel} checked out ` +
        'instead of a pool/spare-* temp branch',
    };
  }
  return {
    provenance: 'pool-created',
    owned: true,
    broken,
    reason: `pool-created name with temp branch ${branch}, not recorded in .pool-state.json`,
  };
}
