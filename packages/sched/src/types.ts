/**
 * Types for the deterministic scheduler core (RFC-0001 §B/C.1/D, issue #460).
 *
 * The state unions below are the RFC-0001 §D state machines frozen into types.
 * `state.ts` owns the transition tables; nothing here does I/O. The package
 * itself never invokes an LLM: it spawns the agent process the operator
 * configured (dispatch.ts) and reads ground truth via injectable subprocess
 * exec (project.ts, groundtruth.ts) — never an LLM call of its own (AC7).
 */

// --- Cycle modes and model tiers (RFC-0001 §B model routing) ---

/** Execution mode of a queue entry. `full` runs the unchanged full-cycle; `slot` runs as a batch member. */
export type CycleMode = 'full' | 'slot';

/** Model tier the entry is dispatched at (RFC-0001 role-based routing: mechanical / generation / judgment). */
export type ModelTier = 'mechanical' | 'mid' | 'strong';

// --- D.1 Issue state machine ---

/**
 * Issue lifecycle per RFC-0001 §D.1:
 *
 * ```
 * queued → classified{full|slot}
 *   full:  → dispatched → (full-cycle's own phase trail) → shipped → done
 *   slot:  → batched(b) → waiting → in-work → committed(range) → validated
 *              → shipped-in-batch → done
 * failure edges (any state):
 *   in-work/committed → evicted(reason) → requeued{full}
 *   any → blocked(dep-failed) | decision-pending | failed(escalation-cap)
 * ```
 */
export type IssueStatus =
  | 'queued'
  | 'classified'
  | 'dispatched'
  | 'parked'
  | 'shipped'
  | 'done'
  | 'batched'
  | 'waiting'
  | 'in-work'
  | 'committed'
  | 'validated'
  | 'shipped-in-batch'
  | 'evicted'
  | 'requeued'
  | 'blocked'
  | 'decision-pending'
  | 'failed';

/** Issue statuses that cannot transition further. */
export const TERMINAL_ISSUE_STATUSES: ReadonlySet<IssueStatus> = new Set(['done', 'failed']);

/**
 * Statuses that mean the issue's work has merged. Dependency edges gate on
 * these: "an issue with an unmerged dependency is never runnable" (AC5).
 */
export const SATISFIED_ISSUE_STATUSES: ReadonlySet<IssueStatus> = new Set([
  'shipped',
  'shipped-in-batch',
  'done',
]);

// --- D.2 Batch state machine ---

/**
 * Batch lifecycle per RFC-0001 §D.2:
 *
 * ```
 * forming → ready → executing(member i/N) ⟲ → validating → reviewing → shipping
 *   → awaiting-merge → merged → deployed → reported → done
 * failure edges:
 *   validating → attributing → fixing(1 bounded attempt) → validating
 *              → evicting(revert range) → validating
 *   evictions > ⅓ OR revert-conflict → dissolving → members requeued
 *   awaiting-merge: CONFLICTING | auto-merge-blocked → rebasing → re-validating → shipping
 *                   (2nd failure → dissolved)
 * ```
 */
export type BatchStatus =
  | 'forming'
  | 'ready'
  | 'executing'
  | 'validating'
  | 'attributing'
  | 'fixing'
  | 'evicting'
  | 'reviewing'
  | 'shipping'
  | 'awaiting-merge'
  | 'rebasing'
  | 're-validating'
  | 'merged'
  | 'deployed'
  | 'reported'
  | 'done'
  | 'dissolving'
  | 'dissolved';

/** Batch statuses that cannot transition further. */
export const TERMINAL_BATCH_STATUSES: ReadonlySet<BatchStatus> = new Set(['done', 'dissolved']);

/**
 * Batch statuses that mean the batch's PR has merged. Cross-batch dependency
 * edges gate on these (a batch is never dispatched while a batch it depends
 * on is unmerged — RFC-0001 §E.4 "scheduler gates on merge").
 */
export const MERGED_BATCH_STATUSES: ReadonlySet<BatchStatus> = new Set([
  'merged',
  'deployed',
  'reported',
  'done',
]);

// --- D.3 Worker slot state machine ---

/**
 * Worker slot lifecycle per RFC-0001 §D.3:
 *
 * ```
 * idle → assigned(unit) → running(pid, phase, last_progress_at)
 *   → exited → verifying(reconcile vs GitHub/runstate) → complete → idle
 * stall: running[30 min no progress] → recovering(redispatch tier+1, ≤2) → running | failed → idle
 * ```
 */
export type SlotStatus =
  | 'idle'
  | 'assigned'
  | 'running'
  | 'exited'
  | 'verifying'
  | 'complete'
  | 'recovering'
  | 'failed';

/** Slot statuses that hold a live unit against `max_slots`. */
export const LIVE_SLOT_STATUSES: ReadonlySet<SlotStatus> = new Set([
  'assigned',
  'running',
  'recovering',
]);

// --- Persisted entities ---

/** One queued unit of work (RFC-0001 §C.1 "queue entries"). */
export interface QueueEntry {
  /** GitHub issue number. Unique among active entries. */
  issue: number;
  /** Execution mode for this issue. */
  mode: CycleMode;
  /** Batch id when `mode === 'slot'`; always null for `full`. */
  batch: string | null;
  /** Issue numbers this entry depends on (edges gate readiness). */
  deps: number[];
  /** Model tier the entry is dispatched at. */
  tier: ModelTier;
  /** Current D.1 state. */
  status: IssueStatus;
  /** Free-form reason attached to failure-edge transitions (evicted/blocked/failed). */
  reason: string | null;
  /**
   * PR number the unit parked on `auto-merge` (#468), from the ship phase's
   * `awaiting-merge` milestone (`pr=` key). Set when the agent exits parked;
   * drives the PR watcher until the merge is accepted.
   */
  pr: number | null;
  /**
   * Teardown outcome for a merged unit (#468): `done`, `failed-<step>`, or
   * null while teardown is still pending. Recorded only after the cleanup
   * was verified (pool return self-check / worktree path gone).
   */
  cleanup: string | null;
  enqueued_at: string;
  updated_at: string;
}

/** A batch of slot-mode issues sharing one lifecycle (RFC-0001 §C.4/E.4). */
export interface BatchEntry {
  id: string;
  status: BatchStatus;
  /** Member issue numbers, in dispatch order. */
  members: number[];
  base_branch: string;
  /** Index of the member currently in work, when status is `executing` (1-based member pointer). */
  executing_member: number;
  created_at: string;
  updated_at: string;
}

/** A worker slot (RFC-0001 §D.3). */
export interface SlotEntry {
  id: number;
  status: SlotStatus;
  /** Unit identifier currently held: `issue:<n>` or `batch:<id>`; null when idle. */
  unit: string | null;
  /** OS pid of the spawned agent process, when known (#464 dispatch). */
  pid: number | null;
  /**
   * `/proc/<pid>/stat` start-time (field 22) recorded at spawn, when
   * available (Linux). Persisted so a restarted sched can verify a state.json
   * pid still belongs to our agent — a mismatched start time means the pid
   * was reused by an unrelated process and must never be signalled (decision
   * 1, option C). Null on platforms without /proc: best-effort.
   */
  pid_start: number | null;
  /** Scheduler phase the unit is in, when running. */
  phase: string | null;
  /** Last progress signal (new milestone or pushed commit) — stall-timer anchor. */
  last_progress_at: string | null;
  /** Working branch of the unit, captured from the setup milestone's `branch=` key. */
  branch: string | null;
  /** Last seen head sha of `branch` on origin — the "new pushed commit" stall signal. */
  last_head: string | null;
  /** Recovery attempts for the current unit (stall ladder, cap 2 — RFC-0001 §C.1). */
  recoveries: number;
  updated_at: string;
}

/** Hot operational truth, persisted transactionally to `state.json` (RFC-0001 §D.4). */
export interface SchedState {
  schema_version: typeof SCHEMA_VERSION;
  /** When true, `computeAssignments` returns no assignments (sched pause). */
  paused: boolean;
  entries: QueueEntry[];
  batches: BatchEntry[];
  slots: SlotEntry[];
  /** Monotonic counter for stable slot ids. */
  next_slot_id: number;
  /**
   * When the PR watcher last polled (#468) — parked PRs are polled every
   * `pr_poll_interval_ms` (default 150 s), independently of the reconcile
   * tick. Persisted so the cadence survives a sched restart.
   */
  last_pr_poll_at: string | null;
}

/** Durable intent, persisted separately in `config.json` (state.json is rebuildable hot truth). */
export interface SchedConfig {
  max_slots: number;
  /** Stall timeout in ms — no new milestone AND no new pushed commit for this long → redispatch stronger (default 30 min). */
  stall_timeout_ms?: number;
  /** Reconciliation tick interval in ms (default 60 000). */
  reconcile_interval_ms?: number;
  /**
   * Parked-PR poll interval in ms (#468, default 150 000 — "every 2–3 min").
   * Independent of the reconcile tick; see `SchedState.last_pr_poll_at`.
   */
  pr_poll_interval_ms?: number;
  /** Agent dispatch settings (#464); every field optional with engine defaults. */
  dispatch?: DispatchConfig;
}

/**
 * Agent dispatch configuration (#464). The command is a template: `{model}`
 * and `{issue}` placeholders are substituted per dispatch; a `{model}` item
 * whose tier has no model configured drops together with its flag.
 */
export interface DispatchConfig {
  /** Command template, e.g. `['claude','-p','--output-format','json','--model','{model}']`. */
  command?: string[];
  /** Prompt template sent on the child's stdin; `{issue}` substituted. */
  prompt?: string;
  /** Tier → model id/alias mapping (defaults: haiku / sonnet / opus). */
  tier_models?: Partial<Record<ModelTier, string>>;
  /**
   * Prompt template for the report agent dispatched after a merged PR
   * (#468); `{issue}`, `{pr}` and `{cleanup}` substituted. Defaults to
   * `DEFAULT_REPORT_PROMPT_TEMPLATE`.
   */
  report_prompt?: string;
}

/** The escalation ladder: one tier stronger, or null at the top (RFC-0001 §C.1). */
export const TIER_LADDER: Readonly<Record<ModelTier, ModelTier | null>> = {
  mechanical: 'mid',
  mid: 'strong',
  strong: null,
};

/** Cap on recovery attempts before a unit fails (RFC-0001 §C.1 "cap 2"). */
export const ESCALATION_CAP = 2;

/** Default stall timeout: 30 minutes without a milestone or pushed commit (RFC-0001 §C.1). */
export const DEFAULT_STALL_TIMEOUT_MS = 30 * 60 * 1000;

/** Default reconciliation tick: ~60s (RFC-0001 §C.1). */
export const DEFAULT_RECONCILE_INTERVAL_MS = 60 * 1000;

/** Default parked-PR poll interval: 2.5 min (#468 AC1 "every 2–3 min"). */
export const DEFAULT_PR_POLL_INTERVAL_MS = 150 * 1000;

export const SCHEMA_VERSION = '1.2.0' as const;

/** Schema versions `validateState` accepts on load (migrated to SCHEMA_VERSION on save). */
export const LEGACY_SCHEMA_VERSIONS: readonly string[] = ['1.0.0', '1.1.0'];

export const CONFIG_SCHEMA_VERSION = '1.2.0' as const;

/** Config schema versions `loadConfig` accepts (older configs carry only max_slots). */
export const LEGACY_CONFIG_SCHEMA_VERSIONS: readonly string[] = ['1.0.0', '1.1.0'];

/** Config file shape (schema_version + the config itself). */
export interface SchedConfigFile {
  schema_version: string;
  max_slots: number;
  stall_timeout_ms?: number;
  reconcile_interval_ms?: number;
  pr_poll_interval_ms?: number;
  dispatch?: DispatchConfig;
}

export const DEFAULT_MAX_SLOTS = 3;

/** Bounds for `max_slots` when reading `config.json` (named — not magic numbers in persist.ts). */
export const MIN_MAX_SLOTS = 1;
export const MAX_MAX_SLOTS = 64;

/** Thrown by every non-declared state-machine edge. */
export class IllegalTransitionError extends Error {
  readonly kind: 'issue' | 'batch' | 'slot';
  readonly from: string;
  readonly to: string;

  constructor(kind: 'issue' | 'batch' | 'slot', from: string, to: string) {
    super(`Illegal ${kind} transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
    this.kind = kind;
    this.from = from;
    this.to = to;
  }
}

/** Thrown when an issue, batch, or slot id does not exist in the state. */
export class SchedNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchedNotFoundError';
  }
}

// --- Dispatch journal events (#464, RFC-0001 §D.4 "Audit") ---

/** Every event the engine journals to `events.jsonl` (append-only). */
export type JournalEventName =
  | 'assigned'
  | 'spawned'
  | 'exit-detected'
  | 'orphan-pid'
  | 'external-advance'
  | 'progress'
  | 'phase-updated'
  | 'verify-complete'
  | 'verify-incomplete'
  | 'stalled'
  | 'redispatched'
  | 'unit-failed'
  | 'dependents-blocked'
  | 'requeued'
  | 'ground-truth-unreachable'
  | 'tick-failed'
  | 'pr-parked'
  | 'merge-accepted'
  | 'pr-watch-failed'
  | 'teardown-done'
  | 'teardown-failed'
  | 'report-dispatched'
  | 'report-failed';

/** One journaled event. `ts` is stamped by the journal, never by callers. */
export interface JournalEvent {
  ts: string;
  event: JournalEventName;
  /** Unit the event concerns (`issue:<n>` / `batch:<id>`), when applicable. */
  unit?: string;
  slot?: number;
  issue?: number;
  pid?: number;
  tier?: ModelTier;
  detail?: string;
}
