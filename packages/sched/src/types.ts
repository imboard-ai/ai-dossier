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
 *           #468 detached ship: dispatched → parked{pr} (PR on auto-merge;
 *           the watcher owns the merge wait) → shipped → done
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

/** Teardown outcome values (#468): verified cleanup or a failed step. */
export type CleanupStatus = 'done' | `failed-${string}`;

// --- Batch failure recovery (#472, RFC-0001 §F.2/F.8/F.9) ---

/**
 * Requeue context for an evicted member (F.2 — "requeue the member as
 * full-cycle **with its context** (plan artifact + failure evidence
 * attached)"). The plan artifact already lives on the issue as the durable
 * `plan:v1` comment; this record is the failure evidence the requeued
 * full-cycle run reads instead of re-deriving what broke.
 */
export interface FailureEvidence {
  /** Batch the member was evicted from. */
  batch: string;
  /** Failing tests attributed to the member, as the suite reported them. */
  failing_tests: string[];
  /** How the failure was attributed: overlap heuristic, bisect, or group eviction. */
  attribution: 'overlap' | 'bisect' | 'group' | 'unattributed';
  /** Eviction reason slug (test-failure | eviction-group | revert-conflict | ...). */
  reason: string;
  /** Commits reverted for this eviction, oldest first; a group eviction carries the whole group's. */
  reverted_commits: string[];
  at: string;
}

/** One recorded eviction (RFC-0001 §D.4 — state.json persists "eviction history"). */
export interface EvictionRecord {
  issue: number;
  /** Eviction reason slug. */
  reason: string;
  /** Member commits reverted, oldest first. */
  reverted_commits: string[];
  /** Members evicted together with this one (the eviction group), this member included. */
  group: number[];
  at: string;
}

/** One bounded fix attempt (F.2 — "1 bounded fix attempt"; see {@link MAX_FIX_ATTEMPTS}). */
export interface FixAttemptRecord {
  issue: number;
  /** `pending` while the fix agent runs; the suite verdict after resolution. */
  outcome: 'pending' | 'green' | 'red';
  at: string;
}

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
   * Teardown outcome for a merged unit (#468): `done` or `failed-<step>`, or
   * null while teardown is still pending. Recorded only after the cleanup
   * was verified (pool return self-check / worktree path gone).
   */
  cleanup: CleanupStatus | null;
  /**
   * Failure evidence attached when an evicted batch member requeues as
   * full-cycle (#472, F.2). Null until the entry has been evicted.
   */
  failure_evidence: FailureEvidence | null;
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
  /**
   * Anchor issue number — where batch milestones post (#472). Null for
   * legacy batches enqueued before the anchor was recorded.
   */
  anchor: number | null;
  /**
   * Batch branch name (`batch/<id>-<date>`); null until setup creates it.
   * The rebase path (F.9) rewrites this branch.
   */
  branch: string | null;
  /**
   * Batch runstate run id (`run=` on the anchor's batch milestones); null
   * for legacy batches. Recovery milestones post with it when present.
   */
  run_id: string | null;
  /**
   * Eviction groups (RFC-0001 §E.4): sets of members whose predicted paths
   * overlap — they see each other's changes in the worktree, so their
   * commits revert TOGETHER when any one of them is evicted. At most one
   * group per batch (prep's composition constraint); ungrouped members
   * revert alone.
   */
  eviction_groups: number[][];
  /** Eviction history (RFC-0001 §D.4) — grows by one record per evicted member. */
  evictions: EvictionRecord[];
  /** Bounded fix attempts (F.2) — at most {@link MAX_FIX_ATTEMPTS} per member. */
  fix_attempts: FixAttemptRecord[];
  /**
   * Rebase attempts on the batch-PR conflict path (F.9 — "re-ship once");
   * the second CONFLICTING/auto-merge-blocked occurrence dissolves the batch.
   */
  rebase_attempts: number;
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
   * `pr_poll_interval_ms` (default 150 s). Polled on each reconcile tick
   * when due (a `reconcile_interval_ms` longer than the interval slows the
   * effective cadence); persisted so the cadence survives a sched restart.
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
   * Checked on each reconcile tick when due; see `SchedState.last_pr_poll_at`.
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

/** The ladder as an ordered array (weakest first) — the single ordering source. */
export const TIER_ORDER: readonly ModelTier[] = ['mechanical', 'mid', 'strong'];

/** Cap on recovery attempts before a unit fails (RFC-0001 §C.1 "cap 2"). */
export const ESCALATION_CAP = 2;

/** Default stall timeout: 30 minutes without a milestone or pushed commit (RFC-0001 §C.1). */
export const DEFAULT_STALL_TIMEOUT_MS = 30 * 60 * 1000;

/** Default reconciliation tick: ~60s (RFC-0001 §C.1). */
export const DEFAULT_RECONCILE_INTERVAL_MS = 60 * 1000;

/** Default parked-PR poll interval: 2.5 min (#468 AC1 "every 2–3 min"). */
export const DEFAULT_PR_POLL_INTERVAL_MS = 150 * 1000;

/**
 * Strictly more than this fraction of a batch's members evicted ⇒ dissolve
 * (RFC-0001 §F.2 "evictions > ⅓ … → dissolve batch").
 */
export const DISSOLVE_EVICTED_FRACTION = 1 / 3;

/** Bounded fix attempts per offending member (RFC-0001 §F.2 "1 bounded fix attempt"). */
export const MAX_FIX_ATTEMPTS = 1;

/** Rebase attempts on the batch-PR conflict path (RFC-0001 §F.9 "re-ship once"). */
export const MAX_REBASE_ATTEMPTS = 1;

export const SCHEMA_VERSION = '1.3.0' as const;

/** Schema versions `validateState` accepts on load (migrated to SCHEMA_VERSION on save). */
export const LEGACY_SCHEMA_VERSIONS: readonly string[] = ['1.0.0', '1.1.0', '1.2.0'];

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
  | 'pr-watch-waiting'
  | 'teardown-done'
  | 'teardown-failed'
  | 'report-dispatched'
  | 'report-failed'
  // --- Batch failure recovery (#472, RFC-0001 §F) ---
  /** The aggregate suite failed; `detail` carries the failing-test count. */
  | 'suite-failed'
  /** Attribution resolved; `detail` carries overlap|bisect|decision-pending. */
  | 'attributed'
  /** A bounded mid-tier fix attempt was dispatched for a member. */
  | 'fix-dispatched'
  /** A member was evicted (reverted + requeued); `detail` carries the reason. */
  | 'member-evicted'
  /** The batch branch was rebased onto a moved base (F.9). */
  | 'batch-rebased'
  /** The batch was dissolved; `detail` carries the reason. */
  | 'batch-dissolved';

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
