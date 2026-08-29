/**
 * Crash-safe persistence for the scheduler core.
 *
 * `state.json` is written atomically: contents land in `state.json.tmp` in the
 * SAME directory (rename is atomic only within a filesystem), get fsynced, and
 * are renamed over `state.json`. A process killed between writes therefore
 * leaves either the previous complete state or the new one — never a partial
 * file (AC2). A stray `.tmp` is ignored by `load()` and overwritten by the
 * next write.
 *
 * Cross-process mutations are serialized by a directory mutex (`.sched-lock`),
 * the same acquire/release protocol as `packages/worktree-pool/src/pool-actions.ts`
 * (acquireLock/releaseLock there) — the two copies must be kept in lockstep.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createEmptyState, validateState } from './state';
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_MAX_SLOTS,
  MAX_MAX_SLOTS,
  MIN_MAX_SLOTS,
  type SchedConfig,
  type SchedConfigFile,
  type SchedState,
} from './types';

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 200;

const STATE_FILE = 'state.json';
const CONFIG_FILE = 'config.json';
const LOCK_DIR = '.sched-lock';

/** Thrown when the cross-process lock cannot be acquired in time. */
export class LockTimeoutError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string, heldByPid: number | null) {
    const holder = heldByPid !== null ? `; held by pid ${heldByPid}` : ' (no pid file found)';
    super(
      `Timed out waiting for scheduler lock (${LOCK_TIMEOUT_MS}ms)${holder}. ` +
        `If that process is not running, remove ${lockPath}`
    );
    this.name = 'LockTimeoutError';
    this.lockPath = lockPath;
  }
}

export class CorruptStateError extends Error {
  readonly filePath: string;

  constructor(filePath: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `Scheduler state file is corrupt: ${filePath} (${reason}). ` +
        'Rename or remove it to reset the queue — GitHub remains the system of record.'
    );
    this.name = 'CorruptStateError';
    this.filePath = filePath;
  }
}

/** Write `contents` to `filePath` atomically (tmp + fsync + rename, same directory). */
export function writeAtomic(filePath: string, contents: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, contents, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
  // Best-effort directory fsync so the rename itself is durable. Not available
  // on every platform/fs — a failure here never blocks the write.
  try {
    const dfd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    // ignore
  }
}

// --- Lock (directory mutex, worktree-pool protocol) ---

function acquireLock(dir: string): void {
  const lockPath = path.join(dir, LOCK_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const start = Date.now();
  let heldByPid: number | null = null;
  while (true) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, 'pid'), String(process.pid), { mode: 0o600 });
      return;
    } catch {
      heldByPid = null;
      try {
        const pidFile = path.join(lockPath, 'pid');
        if (fs.existsSync(pidFile)) {
          const lockPid = Number.parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
          heldByPid = Number.isNaN(lockPid) ? null : lockPid;
          try {
            process.kill(lockPid, 0);
          } catch {
            // Recorded holder is dead. Take the stale lock over by RENAMING it
            // first: with two contenders both seeing the dead pid, only one
            // rename succeeds — the loser's rmSync cannot delete the winner's
            // freshly-acquired lock (the plain rmSync-race the pool protocol
            // inherits from its original mkdir-mutex).
            const stale = `${lockPath}.stale-${process.pid}-${Date.now()}`;
            try {
              fs.renameSync(lockPath, stale);
            } catch {
              // another contender already took it over — fall through to retry
            }
            try {
              fs.rmSync(stale, { recursive: true, force: true });
            } catch {
              // best effort cleanup
            }
            continue;
          }
        }
      } catch {
        // retry
      }

      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new LockTimeoutError(lockPath, heldByPid);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
    }
  }
}

function releaseLock(dir: string): void {
  fs.rmSync(path.join(dir, LOCK_DIR), { recursive: true, force: true });
}

// --- Store ---

/**
 * Filesystem-backed store for one project's scheduler state
 * (`~/.dossier/sched/<project>/`). The constructor only records the directory;
 * all I/O happens per call so a long-lived instance always sees fresh disk
 * state under the lock.
 */
export class SchedStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  get statePath(): string {
    return path.join(this.dir, STATE_FILE);
  }

  get configPath(): string {
    return path.join(this.dir, CONFIG_FILE);
  }

  load(): SchedState {
    const statePath = this.statePath;
    if (!fs.existsSync(statePath)) {
      return createEmptyState();
    }
    let raw: string;
    try {
      raw = fs.readFileSync(statePath, 'utf-8');
    } catch (err) {
      throw new CorruptStateError(statePath, err);
    }
    try {
      return validateState(JSON.parse(raw));
    } catch (err) {
      throw new CorruptStateError(statePath, err);
    }
  }

  save(state: SchedState): void {
    writeAtomic(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  /**
   * Load → mutate → save under the cross-process lock. The mutator must be
   * pure (state in, state out) — same contract as pool's `withLock`.
   */
  withLock<T>(fn: (state: SchedState) => { state: SchedState; result: T }): T {
    acquireLock(this.dir);
    try {
      const current = this.load();
      const { state, result } = fn(current);
      this.save(state);
      return result;
    } finally {
      releaseLock(this.dir);
    }
  }

  loadConfig(): SchedConfig {
    if (!fs.existsSync(this.configPath)) {
      return { max_slots: DEFAULT_MAX_SLOTS };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.configPath, 'utf-8')) as SchedConfigFile;
      if (parsed.schema_version !== CONFIG_SCHEMA_VERSION) {
        throw new Error(`unsupported schema version ${String(parsed.schema_version)}`);
      }
      if (
        !Number.isInteger(parsed.max_slots) ||
        parsed.max_slots < MIN_MAX_SLOTS ||
        parsed.max_slots > MAX_MAX_SLOTS
      ) {
        throw new Error(
          `max_slots must be an integer between ${MIN_MAX_SLOTS} and ${MAX_MAX_SLOTS}`
        );
      }
      return { max_slots: parsed.max_slots };
    } catch (err) {
      // Deliberate degrade-to-default (unlike state.json, config is re-derivable
      // operator intent and hard-failing every command on a typo would brick
      // even `sched status`) — but never silently.
      console.error(
        `⚠ Scheduler config ${this.configPath} is unreadable (${(err as Error).message}) — using default max_slots=${DEFAULT_MAX_SLOTS}`
      );
      return { max_slots: DEFAULT_MAX_SLOTS };
    }
  }

  saveConfig(config: SchedConfig): void {
    const file: SchedConfigFile = {
      schema_version: CONFIG_SCHEMA_VERSION,
      max_slots: config.max_slots,
    };
    writeAtomic(this.configPath, `${JSON.stringify(file, null, 2)}\n`);
  }
}
