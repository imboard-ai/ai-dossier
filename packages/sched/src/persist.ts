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
import { JOURNAL_FILE } from './journal';
import { createEmptyState, validateState } from './state';
import {
  BATCH_PHASES,
  CONFIG_SCHEMA_VERSION,
  DEFAULT_MAX_SLOTS,
  type DispatchConfig,
  LEGACY_CONFIG_SCHEMA_VERSIONS,
  MAX_MAX_SLOTS,
  MIN_MAX_SLOTS,
  type ModelTier,
  PHASES,
  type SchedConfig,
  type SchedConfigFile,
  type SchedState,
  type TierDispatchSpec,
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

  get journalPath(): string {
    return path.join(this.dir, JOURNAL_FILE);
  }

  /** Directory for per-unit agent output logs (`runs/<unit>.log`). */
  get runsDir(): string {
    return path.join(this.dir, 'runs');
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
      // An I/O failure (permissions, disk, read-only mount) is NOT corruption —
      // the destructive "rename to reset" advice must not attach to it.
      throw new CorruptStateError(
        statePath,
        new Error(
          `could not READ the file (${(err as Error).message}) — this is an I/O failure, not corruption; renaming will not fix it`
        )
      );
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
      const version = String(parsed.schema_version);
      if (version !== CONFIG_SCHEMA_VERSION && !LEGACY_CONFIG_SCHEMA_VERSIONS.includes(version)) {
        throw new Error(`unsupported schema version ${version}`);
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
      const config: SchedConfig = { max_slots: parsed.max_slots };
      if (parsed.stall_timeout_ms !== undefined) {
        config.stall_timeout_ms = requirePositiveIntMs('stall_timeout_ms', parsed.stall_timeout_ms);
      }
      if (parsed.reconcile_interval_ms !== undefined) {
        config.reconcile_interval_ms = requirePositiveIntMs(
          'reconcile_interval_ms',
          parsed.reconcile_interval_ms
        );
      }
      if (parsed.pr_poll_interval_ms !== undefined) {
        config.pr_poll_interval_ms = requirePositiveIntMs(
          'pr_poll_interval_ms',
          parsed.pr_poll_interval_ms
        );
      }
      if (parsed.dispatch !== undefined) {
        config.dispatch = validateDispatchConfig(parsed.dispatch);
      }
      return config;
    } catch (err) {
      // Deliberate degrade-to-default (unlike state.json, config is re-derivable
      // operator intent and hard-failing every command on a typo would brick
      // even `sched status`) — but never silently. The whole file degrades, not
      // just the invalid field: name the full blast radius so an operator does
      // not read "unreadable" and assume only the field named in the message
      // reverted (#495 — a `dispatch.*` typo used to look like a narrow issue).
      console.error(
        `⚠ Scheduler config ${this.configPath} is unreadable (${(err as Error).message}) — ` +
          `ALL config (max_slots, stall_timeout_ms, reconcile_interval_ms, pr_poll_interval_ms, ` +
          `dispatch command/prompt/models/tiers/phase-timeouts/fence-takeover-timeout) reverted to built-in defaults ` +
          `(max_slots=${DEFAULT_MAX_SLOTS}); fix the file and re-run`
      );
      return { max_slots: DEFAULT_MAX_SLOTS };
    }
  }

  saveConfig(config: SchedConfig): void {
    const file: SchedConfigFile = {
      schema_version: CONFIG_SCHEMA_VERSION,
      max_slots: config.max_slots,
      ...(config.stall_timeout_ms !== undefined
        ? { stall_timeout_ms: config.stall_timeout_ms }
        : {}),
      ...(config.reconcile_interval_ms !== undefined
        ? { reconcile_interval_ms: config.reconcile_interval_ms }
        : {}),
      ...(config.pr_poll_interval_ms !== undefined
        ? { pr_poll_interval_ms: config.pr_poll_interval_ms }
        : {}),
      ...(config.dispatch !== undefined ? { dispatch: config.dispatch } : {}),
    };
    writeAtomic(this.configPath, `${JSON.stringify(file, null, 2)}\n`);
  }
}

const MODEL_TIERS: readonly ModelTier[] = ['mechanical', 'mid', 'strong'];

/** Every phase name a `dispatch.phase_stall_timeout_ms` key may legally name (#495). */
const STALL_PHASES: readonly string[] = [...PHASES, ...BATCH_PHASES];

/** A positive-integer-milliseconds field, validated once and reused by every `*_ms` config key. */
function requirePositiveIntMs(label: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${label} must be a positive integer (milliseconds); got ${JSON.stringify(value)}`
    );
  }
  return value;
}

/** A plain (non-array, non-null) object field, validated once and reused by every map-shaped config key. */
function requirePlainObject(label: string, value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `${label} must be an object; got ${Array.isArray(value) ? 'array' : typeof value}`
    );
  }
  return value as Record<string, unknown>;
}

/** A non-empty array of non-empty strings, validated once and reused by every command-array config key (top-level `dispatch.command` and each `dispatch.tiers.<tier>.command`). */
function requireNonEmptyStringArray(label: string, value: unknown): void {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((c) => typeof c !== 'string' || c.length === 0)
  ) {
    throw new Error(`${label} must be a non-empty array of non-empty strings`);
  }
}

/** Strict validation of one `dispatch.tiers[<tier>]` spec (#527). */
function validateTierDispatchSpec(tier: string, raw: unknown): void {
  const spec = requirePlainObject(`dispatch.tiers.${tier}`, raw);
  if (spec.command !== undefined) {
    requireNonEmptyStringArray(`dispatch.tiers.${tier}.command`, spec.command);
  }
  if (spec.model !== undefined && (typeof spec.model !== 'string' || spec.model.length === 0)) {
    throw new Error(`dispatch.tiers.${tier}.model must be a non-empty string`);
  }
  if (spec.prompt !== undefined && (typeof spec.prompt !== 'string' || spec.prompt.length === 0)) {
    throw new Error(`dispatch.tiers.${tier}.prompt must be a non-empty string`);
  }
}

/** Strict validation of the optional `dispatch` section (#464). */
function validateDispatchConfig(raw: unknown): DispatchConfig {
  const dispatch = requirePlainObject('dispatch', raw);
  if (dispatch.command !== undefined) {
    requireNonEmptyStringArray('dispatch.command', dispatch.command);
  }
  if (dispatch.prompt !== undefined && typeof dispatch.prompt !== 'string') {
    throw new Error('dispatch.prompt must be a string');
  }
  if (dispatch.report_prompt !== undefined && typeof dispatch.report_prompt !== 'string') {
    throw new Error('dispatch.report_prompt must be a string');
  }
  if (dispatch.fix_prompt !== undefined && typeof dispatch.fix_prompt !== 'string') {
    throw new Error('dispatch.fix_prompt must be a string');
  }
  if (dispatch.member_prompt !== undefined && typeof dispatch.member_prompt !== 'string') {
    throw new Error('dispatch.member_prompt must be a string');
  }
  if (dispatch.batch_tail_prompt !== undefined && typeof dispatch.batch_tail_prompt !== 'string') {
    throw new Error('dispatch.batch_tail_prompt must be a string');
  }
  if (
    dispatch.batch_report_prompt !== undefined &&
    typeof dispatch.batch_report_prompt !== 'string'
  ) {
    throw new Error('dispatch.batch_report_prompt must be a string');
  }
  if (dispatch.tier_models !== undefined) {
    const tierModels = requirePlainObject('dispatch.tier_models', dispatch.tier_models);
    for (const [tier, model] of Object.entries(tierModels)) {
      if (!MODEL_TIERS.includes(tier as ModelTier)) {
        throw new Error(`dispatch.tier_models: unknown tier '${tier}'`);
      }
      if (typeof model !== 'string' || model.length === 0) {
        throw new Error(`dispatch.tier_models.${tier} must be a non-empty string`);
      }
    }
  }
  if (dispatch.tiers !== undefined) {
    const tiers = requirePlainObject('dispatch.tiers', dispatch.tiers);
    for (const [tier, spec] of Object.entries(tiers)) {
      if (!MODEL_TIERS.includes(tier as ModelTier)) {
        throw new Error(`dispatch.tiers: unknown tier '${tier}'`);
      }
      validateTierDispatchSpec(tier, spec);
    }
  }
  if (dispatch.phase_stall_timeout_ms !== undefined) {
    const phaseTimeouts = requirePlainObject(
      'dispatch.phase_stall_timeout_ms',
      dispatch.phase_stall_timeout_ms
    );
    for (const [phase, ms] of Object.entries(phaseTimeouts)) {
      if (!STALL_PHASES.includes(phase)) {
        throw new Error(
          `dispatch.phase_stall_timeout_ms: unknown phase '${phase}' (expected one of: ${STALL_PHASES.join(', ')})`
        );
      }
      requirePositiveIntMs(`dispatch.phase_stall_timeout_ms.${phase}`, ms);
    }
  }
  if (dispatch.fence_takeover_timeout_ms !== undefined) {
    requirePositiveIntMs('dispatch.fence_takeover_timeout_ms', dispatch.fence_takeover_timeout_ms);
  }
  const out: DispatchConfig = {};
  if (dispatch.command !== undefined) out.command = dispatch.command as string[];
  if (dispatch.prompt !== undefined) out.prompt = dispatch.prompt as string;
  if (dispatch.report_prompt !== undefined) out.report_prompt = dispatch.report_prompt as string;
  if (dispatch.fix_prompt !== undefined) out.fix_prompt = dispatch.fix_prompt as string;
  if (dispatch.member_prompt !== undefined) out.member_prompt = dispatch.member_prompt as string;
  if (dispatch.batch_tail_prompt !== undefined) {
    out.batch_tail_prompt = dispatch.batch_tail_prompt as string;
  }
  if (dispatch.batch_report_prompt !== undefined) {
    out.batch_report_prompt = dispatch.batch_report_prompt as string;
  }
  if (dispatch.tier_models !== undefined) {
    out.tier_models = dispatch.tier_models as Partial<Record<ModelTier, string>>;
  }
  if (dispatch.tiers !== undefined) {
    out.tiers = dispatch.tiers as Partial<Record<ModelTier, TierDispatchSpec>>;
  }
  if (dispatch.phase_stall_timeout_ms !== undefined) {
    out.phase_stall_timeout_ms = dispatch.phase_stall_timeout_ms as Record<string, number>;
  }
  if (dispatch.fence_takeover_timeout_ms !== undefined) {
    out.fence_takeover_timeout_ms = dispatch.fence_takeover_timeout_ms as number;
  }
  return out;
}
