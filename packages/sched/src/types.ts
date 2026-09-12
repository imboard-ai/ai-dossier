/**
 * Types for the deterministic scheduler core (RFC-0001 §B/C.1/D, issue #460).
 *
 * The state unions below are the RFC-0001 §D state machines frozen into types.
 * `state.ts` owns the transition tables; nothing here does I/O. The package
 * itself never invokes an LLM: it spawns the agent process the operator
 * configured (dispatch.ts) and reads ground truth via injectable subprocess
 * exec (project.ts, groundtruth.ts) — never an LLM call of its own (AC7).
 */

// `MemberRange` is attribution.ts's own leaf type (it imports nothing), so this
// is the one place types.ts reaches outward — a `BatchEntry.ranges` value IS a
// `MemberRange[]`, and duplicating the shape here would let the two drift.
import type { MemberRange } from './attribution';

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
 *   failed(auto-merge-blocked) → shipped   (#501 stale-failure reconcile —
 *     the ONE edge out of `failed`, engine-guarded to that one reason; see
 *     `state.ts`'s `ISSUE_BASE_TRANSITIONS.failed`)
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
  | 'failed'
  | 'stopped';

/**
 * Issue statuses the normal rails never leave: `done` is absolute, and
 * `failed` has exactly one escape hatch (`failed → shipped`, #501's
 * stale-failure reconcile — see `state.ts`). Membership here also suppresses
 * the universal failure edges in `allowedIssueTransitions` — that's the
 * mechanism that keeps `failed`'s one outgoing edge from also reopening
 * `blocked`/`decision-pending`/`failed` itself.
 */
export const TERMINAL_ISSUE_STATUSES: ReadonlySet<IssueStatus> = new Set([
  'done',
  'failed',
  'stopped',
]);

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

/**
 * The four `ai-dossier cap run` outcomes (docs/reference/capabilities.md):
 * `ok` = the capability ran and passed; `task-failed` = it ran and the TASK
 * itself failed (trust the result); `automation-broken` = do not trust the
 * machinery (missing tool, timeout, bad manifest); `capability-unavailable` =
 * no manifest / no such id / `lifecycle: shadow` — no fast path here.
 */
export type CapOutcome = 'ok' | 'task-failed' | 'automation-broken' | 'capability-unavailable';

/**
 * One `deps.runCapability` result (#583) — the bare outcome plus, on a
 * non-`ok` result, the tail of the capability's combined stdout+stderr for
 * attribution (journal detail, `sched status`, the per-gate log file).
 */
export interface CapabilityGateResult {
  outcome: CapOutcome;
  outputTail?: string | null;
  /**
   * The `cap run` envelope's own `reason` (#583 review) — the only
   * explanation available when no subprocess ran at all (`capability-unavailable`,
   * or `automation-broken` from a failed assumption probe), since `outputTail`
   * is unset in those cases.
   */
  reason?: string | null;
  /**
   * The `cap run` envelope's `duration_ms` (#681) — how long the capability
   * actually ran before reaching its verdict. `null` when unknown (an older
   * capability build whose envelope omits the field, or no subprocess ran).
   * Recorded on `member_gates` so the gate's cost is measurable per member —
   * the raw material for reporting gate savings per change shape (AC4).
   */
  durationMs?: number | null;
}

// --- F.2/F.8/F.9 batch failure recovery records (#472) ---

/**
 * How a failing test was traced back to a member: by changed-path /
 * focused-test overlap, by `git bisect` over the issue-boundary commits, or
 * not at all (a blanket dissolve requeue attributes nothing).
 */
export type AttributionMethod = 'overlap' | 'bisect' | 'none';

/**
 * What an evicted member carries into its full-cycle requeue (RFC-0001 §F.9 —
 * "requeue the member as full-cycle with its plan artifact + failure evidence
 * attached"). The plan artifact already lives on the issue as its `plan:v1`
 * comment, so the evidence records only what the batch run learned.
 */
export interface FailureEvidence {
  /** Batch the member was evicted from. */
  batch: string;
  /** Why it was evicted (`suite-red`, `revert-conflict`, `dissolve`, …). */
  reason: string;
  /** Failing test ids attributed to this member (empty for a blanket dissolve). */
  failing_tests: string[];
  /** How those tests were attributed. */
  attribution: AttributionMethod;
  /** Commits reverted out of the batch branch for this member. */
  reverted_commits: string[];
  at: string;
}

/**
 * One eviction, kept on the batch for the batch report and as the classifier
 * feedback signal (RFC-0001 §D.4 audit, AC5 "per-member outcome recorded").
 */
export interface EvictionRecord {
  issue: number;
  reason: string;
  attribution: AttributionMethod;
  reverted_commits: string[];
  /** Members evicted alongside it because they share an eviction group (§E.4). */
  group: number[];
  at: string;
}

/** The one bounded fix attempt a member gets before it is evicted (§F.2). */
export interface FixAttemptRecord {
  issue: number;
  tier: ModelTier;
  /** `dispatched` while the fix agent runs; then the suite's verdict for that member. */
  outcome: 'dispatched' | 'green' | 'red';
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
 *   validating → blocked(suite-unreadable, after the fallback retry when one
 *              applied) → validating (nothing requeued or reverted; the
 *              `validating` edge exists for a future `sched resume`-style
 *              verb; exits today: `sched abandon --batch` (#562) or #686's
 *              stale-blocked reconcile when the work demonstrably shipped)
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
  | 'dissolved'
  /**
   * The suite report itself could not be trusted (empty, unparseable, or a
   * spawn/timeout error) even after the fallback-runner retry, when the
   * resolved primary tier was cap/config (#562) — a repo-detected primary has
   * no further fallback and blocks on its first unreadable report. Never
   * reached for a genuinely red suite with a parseable failing-test list,
   * which still goes through `attributing`. Nothing is requeued or reverted.
   * The `validating` edge below is where a future resume verb would land.
   * Exits today: `sched abandon --batch` (#562), `sched resume --batch`
   * (#583, a passing gate recheck), or #686's stale-blocked reconcile
   * (ground truth says the work shipped anyway).
   */
  | 'blocked';

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
 * stall: running[no progress for the in-flight phase's stall timeout —
 *   30 min default, 90 min for `implement` (#495)] → recovering(redispatch
 *   tier+1, ≤2) → running | failed → idle
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

/** Whether a slot's agent is a full-cycle agent or a #468 report agent. */
export type SlotRole = 'cycle' | 'report';

/** Closed vocabulary for `SlotRole` — the shared validation set (#500). */
export const SLOT_ROLES: ReadonlySet<SlotRole> = new Set(['cycle', 'report']);

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
  /**
   * Assignment weight (#565): higher dispatches first. Default 0 for a
   * full-cycle entry; unused for a slot-mode member (the BATCH's own
   * `BatchEntry.priority` governs assignment — see `runnableUnits`).
   */
  priority: number;
  /** Model tier the entry is dispatched at. */
  tier: ModelTier;
  /**
   * Named dispatch profile resolved at enqueue for a full-cycle entry (#713).
   * Null deliberately selects the project's default profile; slot entries use
   * their batch's profile so there is only one source of truth for a batch.
   */
  dispatch_profile: string | null;
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
   * Why this entry was evicted from a batch, carried into its full-cycle
   * requeue (#472). Null for every entry that never rode the eviction rail.
   */
  failure_evidence: FailureEvidence | null;
  /**
   * ISO time this entry's current `ground-truth-unreachable` streak began
   * (#632, mirrors #630's `pr_watch_failed_since` on `BatchEntry`) — null
   * whenever ground truth answered cleanly the last time it was checked for
   * this unit. Shared by every `ground-truth-unreachable` site in
   * `engine.ts`: a unit is in exactly one of running/verifying/parked/
   * stale-failed at a time, so only one site is ever live for a given issue
   * on a given tick, and `QueueEntry` — unlike `SlotEntry` — exists for a
   * unit regardless of whether it currently holds a slot.
   *
   * Streak identity here is PRESENCE-ONLY: unlike `BatchEntry`'s
   * `pr_watch_failed_reason`, a changed `detail` does not start a new streak.
   * Every site journalling this event must therefore be a flavour of the same
   * underlying condition — a site whose `detail` describes a materially
   * different failure would be silently folded into a running streak (#637).
   */
  ground_truth_unreachable_since: string | null;
  /**
   * Ticks this entry's current `ground-truth-unreachable` streak has
   * persisted (#632), including ticks the dedup kept silent — lets the
   * journal re-announce a still-unreachable streak every
   * `JOURNAL_DEDUP_REANNOUNCE_TICKS` ticks instead of only once, ever, so
   * "unreachable for 40 minutes" is legible from one line. Reset to `0`
   * whenever `ground_truth_unreachable_since` is `null`.
   */
  ground_truth_unreachable_ticks: number;
  /**
   * ISO time this entry's current `pr-watch-waiting` streak began (#632) — a
   * merge GitHub has recorded but not yet reflected as the issue closing.
   * Same shape and same presence-only streak identity as
   * `ground_truth_unreachable_since` above; `null` whenever the wait is not
   * currently live.
   */
  pr_watch_waiting_since: string | null;
  /**
   * Ticks this entry's current `pr-watch-waiting` streak has persisted
   * (#632), silent ticks included. Reset to `0` whenever
   * `pr_watch_waiting_since` is `null`.
   */
  pr_watch_waiting_ticks: number;
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
  /**
   * Assignment weight (#565): higher dispatches first, same scale as
   * `QueueEntry.priority`. Set once at creation (`DEFAULT_BATCH_PRIORITY`,
   * or `SchedConfig.default_batch_priority` when the operator configured
   * one) — a batch above the default full-cycle entry's priority (0) is
   * what lets a ready batch claim a free slot ahead of a same-readiness
   * issue, closing the gap `docs/reports/batch-pilot-2-execution.md` §13.4
   * found (an operator manually deferring full-cycle entries by hand).
   */
  priority: number;
  /** Index of the member currently in work, when status is `executing` (1-based member pointer). */
  executing_member: number;
  /**
   * The batch ANCHOR issue — where every batch milestone posts (#472 AC5).
   * Null until batch-prep supplies one; recovery then journals the milestone it
   * could not post, rather than guessing an issue to comment on.
   */
  anchor: number | null;
  /**
   * The batch INTEGRATION branch, written by batch-setup dispatch (#523) —
   * members branch off it and the scheduler lands their verified work onto
   * it; the tail steps (aggregate suite, review, ship) run in it. Null before the
   * batch has been dispatched a first time; recovery also READS it, to refuse
   * a rebase when the checkout is on some other branch.
   */
  branch: string | null;
  /**
   * Absolute path of the shared worktree batch-setup created (#523) — holds
   * the integration branch, where the tail-phase agents (validate, review,
   * ship, report), the aggregate suite, and each member's landing merge
   * run. Since #677 members execute in their own `member_worktree`, not
   * here. Null until batch-setup lands.
   */
  worktree: string | null;
  /**
   * Whether `worktree` came from a pool claim (already warm) rather than a
   * cold `git worktree add` that batch-setup then warmed itself (#561).
   * Teardown reads this to decide `worktree-pool return` vs `git worktree
   * remove` — mirrors `SetupInfo.poolClaimed` (`groundtruth.ts`) at batch
   * granularity. `false` until batch-setup lands; a state file written before
   * #561 carries no such key at all — `state.ts`'s load-time normalization
   * backfills it to `false` (batches from before this field existed were
   * never pool-claimed, since batch-setup had no pool integration yet).
   */
  pool_claimed: boolean;
  /**
   * The CURRENT member's own branch (#677, RFC-0001 §J.3) — `batch/<id>-m<n>-<issue>`,
   * created off the integration branch, checked out in the member's own
   * worktree, and pushed so the member agent can commit to it. The member
   * NEVER touches the integration branch; the scheduler lands its commits
   * there (`merge --ff-only`) only after the member's incremental gate
   * passes. Null before a member is dispatched and cleared once the member
   * is resolved (landed or evicted); a state file written before #677
   * carries no such key — `state.ts`'s load-time normalization backfills it
   * to `null`. Persisted (not re-derived) so a takeover redispatch or a
   * `sched resume --batch` recheck after an engine restart lands in the SAME
   * worktree/branch the member was already using. Added in schema 1.18.0;
   * 1.17.0 batches backfill null.
   */
  member_branch: string | null;
  /**
   * Absolute path of the CURRENT member's own worktree (#677) — the
   * `{worktree}` input the member prompt carries, and where the incremental
   * gate runs (pre-landing, the member's diff exists only here). Paired with
   * {@link BatchEntry.member_branch}; same lifecycle and backfill-to-null.
   * Added in schema 1.18.0.
   */
  member_worktree: string | null;
  /**
   * Whether {@link BatchEntry.member_worktree} came from a pool claim
   * (#677) — teardown reads this to decide `worktree-pool return` vs
   * `git worktree remove`, mirroring {@link BatchEntry.pool_claimed} at
   * member granularity. `false` until a member worktree is prepared;
   * backfilled to `false` on load like the other #677 fields. Added in
   * schema 1.18.0.
   */
  member_pool_claimed: boolean;
  /**
   * Name of the dispatch profile this batch resolved at ENQUEUE time (#707),
   * null for "the config's default (unnamed) profile". A batch-level fact
   * like `anchor`/`run_id`: resolved once when the first member enqueues,
   * agreed across members, and used for EVERY unit under the batch —
   * batch-setup, each member, the tail integrator, the fix agent, the report
   * agent — regardless of which session ticks the engine. Persisted (not
   * re-derived) so a tick from any session dispatches the same family. A
   * name that no longer resolves against the CURRENT config never silently
   * falls back — the silent fallback is the #680 incident shape: pre-merge
   * the batch DISSOLVES with reason `dispatch-profile-missing:<name>`
   * (members requeue as full-cycle units on the config default), post-merge
   * the remaining tail work runs on the default with a journaled
   * `dispatch-profile-missing` event. Added in schema 1.19.0; 1.18.0
   * batches backfill to null.
   */
  dispatch_profile: string | null;
  /**
   * runstate run id of the batch run (`r-<issue>-<hex>`), null until batch-setup
   * mints it. `ai-dossier runstate post` REQUIRES a run id, so a batch without
   * one cannot post milestones at all — recovery journals them instead.
   */
  run_id: string | null;
  /**
   * Each member's commit range on the batch branch (#523 AC2), recomputed from
   * `git log` after every member completes (`attribution.ts`'s `memberRanges`).
   * The direct input `evictMembers`' `EvictionInput.ranges` expects — kept on
   * the batch so eviction never needs a live worktree to re-derive it.
   */
  ranges: MemberRange[];
  /**
   * PR number the batch parked on `auto-merge` (#523, mirrors `QueueEntry.pr`),
   * from the tail agent's `batch-ship awaiting-merge` milestone (`pr=` key).
   * Persisted (not held only in memory) so a `sched start` restart mid-watch
   * still knows which PR to poll — `awaiting-merge` batches hold no live slot
   * to lose, but a restart with nothing durable would silently stop watching.
   */
  pr: number | null;
  /**
   * Members that must revert together when any one of them is evicted
   * (RFC-0001 §E.4 eviction groups — e.g. a member built on another's API).
   * Each inner array is one group; members in no group evict alone.
   */
  eviction_groups: number[][];
  /** Eviction history, oldest first (§D.4 audit / AC5 feedback signal). */
  evictions: EvictionRecord[];
  /** Fix attempts, at most `MAX_FIX_ATTEMPTS_PER_MEMBER` per member (§F.2). */
  fix_attempts: FixAttemptRecord[];
  /** Rebases of the batch branch after a PR conflict (§F.9, capped at `MAX_REBASE_ATTEMPTS`). */
  rebase_attempts: number;
  /**
   * Most recent incremental-gate result per member (#583), keyed by issue
   * number as a string (JSON object keys are always strings). Populated on
   * every gate run that produces a non-`ok` verdict for at least one checked
   * capability (`typecheck.run`/`test.focused`) — `outcome`/`output_tail`
   * describe whichever capability was "worst" (task-failed beats
   * inconclusive). `sched status --json` surfaces this for free via the raw
   * `BatchEntry`. `{}` for a batch created before this field existed
   * (`state.ts` load-time backfill) or one whose gate never ran/never failed.
   *
   * #681: a timeout-shaped `automation-broken` (reason `command timed out
   * after <N>ms`) is recorded as `capability-unavailable` — the gate
   * DECLINED the member (skip; the parent's expensive stage covers it), it
   * did not reach a machinery-failure verdict. `duration_ms` (#681) is the
   * capability's own runtime, the per-member denominator for gate-cost
   * reporting per change shape; `null` on records from before it existed.
   */
  member_gates: Record<
    string,
    {
      capability: string;
      outcome: CapOutcome;
      output_tail: string | null;
      duration_ms: number | null;
      at: string;
    }
  >;
  /**
   * Reason the batch is `blocked`, set by `blockBatch` (#583 — `blockBatch`
   * previously journaled/posted its reason but never persisted it on the
   * entry itself, so `sched status` had nothing to read back for the #562
   * suite-unreadable case either). Cleared back to `null` on any transition
   * out of `blocked`. `null` when the batch has never been blocked.
   */
  blocked_reason: string | null;
  /**
   * The reason already journalled for this batch's current `pr-watch-failed`
   * streak (#630) — `null` when the PR watch is healthy. Compared against
   * the freshly observed reason each tick so an unchanged condition doesn't
   * re-journal (mirrors #610's `stale_milestone_ignored_for` dedup), while a
   * different reason, or the same reason recurring after the condition
   * cleared (reset to `null` first), always journals a fresh entry.
   */
  pr_watch_failed_reason: string | null;
  /**
   * ISO time `pr_watch_failed_reason`'s current streak began (#630) — lets a
   * reader compute how long the condition has persisted without the journal
   * re-emitting an entry every tick. `null` whenever `pr_watch_failed_reason`
   * is `null`.
   */
  pr_watch_failed_since: string | null;
  /**
   * Ticks `pr_watch_failed_reason`'s current streak has persisted (#630),
   * including ticks that stayed silent under the dedup — this is what lets
   * `reconcilePrWatch` re-announce a still-failing watch every
   * `JOURNAL_DEDUP_REANNOUNCE_TICKS` ticks instead of only once, ever.
   * Reset to `0` whenever `pr_watch_failed_reason` is `null`.
   */
  pr_watch_failed_ticks: number;
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
  /**
   * The phase of the LATEST POSTED milestone — the phase that just
   * COMPLETED, not the one in flight, since it only advances when a
   * milestone lands (see `role`'s doc below for the report-agent case). For
   * the CURRENTLY RUNNING phase, use the milestone's `next=` key instead
   * (`stallTimeoutForPhase`, #495) — reading `phase` directly for that
   * purpose applies a phase's stall allowance one phase too late.
   */
  phase: string | null;
  /**
   * The agent's role: set when the slot is assigned (`assignToIdleSlot`) and
   * cleared back to `'cycle'` when the slot returns to `idle` — never
   * touched by `phase-updated` (#500). `phase` tracks the LATEST posted
   * milestone, which for a report agent stays behind the issue's pre-report
   * milestone (e.g. `ship`) until the report milestone itself lands, so
   * `phase` alone cannot tell a report agent from a cycle agent mid-run.
   * `role` is the stable answer. Added in schema 1.4.0; 1.3.0 states
   * backfill it on load (see `validateState`).
   */
  role: SlotRole;
  /** Last progress signal (new milestone or pushed commit) — stall-timer anchor. */
  last_progress_at: string | null;
  /** Working branch of the unit, captured from the setup milestone's `branch=` key. */
  branch: string | null;
  /** Last seen head sha of `branch` on origin — the "new pushed commit" stall signal. */
  last_head: string | null;
  /** Recovery attempts for the current unit (stall ladder, cap 2 — RFC-0001 §C.1). */
  recoveries: number;
  /**
   * Runstate generation the agent in this slot owns (#504). 0 for a first dispatch —
   * the generation of a run that was never fenced — and the generation the fence
   * installed for every takeover after that. Handed to the agent in its prompt, which
   * passes it to `runstate post --gen`; a superseded agent still holding a lower
   * generation is refused by the CLI. Added in schema 1.6.0; 1.5.0 states backfill 0.
   */
  gen: number;
  /**
   * When this slot's takeover was fenced, while it has still posted NOTHING (#504 AC4).
   * Cleared by the first progress signal. Non-null selects the short
   * `fenceTakeoverTimeoutMs` over the phase's stall allowance, so a takeover that dies
   * immediately re-enters the ladder in minutes rather than after a full phase timeout.
   * Added in schema 1.6.0; 1.5.0 states backfill null.
   */
  fenced_at: string | null;
  /**
   * When the CURRENTLY held unit was (re)spawned (#524) — set in
   * `spawnAndRecord` on every genuine (re)spawn, distinct from
   * `last_progress_at` (which advances on every progress signal and so
   * cannot answer "how long has this dispatch been running"). Used to
   * compute `duration_ms` for the unit's `runs.jsonl` entry. Added in schema
   * 1.7.0; 1.6.0 slots backfill null (their in-flight duration is unknown,
   * not zero).
   */
  spawned_at: string | null;
  /**
   * Byte size of the unit's dispatch log (`dispatchLogPath`) at the moment
   * THIS spawn started (#524) — the log file is per-unit and opened in
   * append mode (`createSpawnDeps`), so a redispatch's output lands after
   * the previous dispatch's in the SAME file. Reading the whole file for a
   * redispatched unit's `runs.jsonl` entry would concatenate two JSON
   * results (parse failure for claude) or double-count summed tokens
   * (opencode) — `recordDispatchRunLog` reads only the bytes from this
   * offset onward, so each dispatch's entry reflects only its own output.
   * `null` when the log did not exist yet at spawn time (first dispatch, or
   * a legacy slot from before this field existed) — treated as offset 0.
   * Added in schema 1.7.0; 1.6.0 slots backfill null.
   */
  log_offset_at_spawn: number | null;
  /**
   * The `spawned_at` value already covered by a `stale-milestone-ignored`
   * journal entry (#610) — `null` until the first stale-milestone decision
   * this dispatch makes. Compared against `spawned_at` itself rather than a
   * boolean: a fresh dispatch stamps a NEW `spawned_at`, so the marker goes
   * stale automatically (no explicit reset needed at any spawn site) and the
   * event is keyed on the dispatch it was decided for, never on the member.
   * Written by BOTH rails that journal the event — the batch member rail
   * (`reconcileMemberSlot`, `batch-dispatch.ts`) and the issue rail
   * (`journalStaleMilestoneIfIgnored`, `engine.ts`) — so the cadence is the
   * same whichever kind of unit holds the slot. Added in schema 1.12.0; 1.11.0
   * slots backfill null (nothing was journalled yet under the old
   * once-per-tick behavior).
   */
  stale_milestone_ignored_for: string | null;
  /**
   * The milestone key already covered by a milestone-driven `progress` journal
   * entry (#682) — `` `${run}:${phase}/${status}` ``, `null` until the first
   * milestone-driven progress signal this slot holds. Compared against the
   * freshly observed key each tick so an UNCHANGED milestone doesn't
   * re-journal (the #630 idiom, scoped to the slot rail like #610's
   * `stale_milestone_ignored_for`), while a new milestone — a different
   * phase/status, or the same one under a NEW run id (a resumed or
   * redispatched run legitimately re-reaching `setup/done`) — always journals
   * a fresh entry: de-duplication, not suppression.
   */
  progress_milestone_for: string | null;
  /**
   * ISO time `progress_milestone_for`'s current streak began (#682) — lets a
   * reader answer "still at implement/done after 40 min" from one journal
   * line instead of counting duplicates. `null` whenever
   * `progress_milestone_for` is `null`.
   */
  progress_milestone_since: string | null;
  /**
   * Ticks `progress_milestone_for`'s current streak has persisted (#682),
   * including ticks that stayed silent under the dedup — this is what lets
   * the milestone-driven progress entry re-announce every
   * `JOURNAL_DEDUP_REANNOUNCE_TICKS` ticks instead of only once, ever.
   * Reset to `0` whenever `progress_milestone_for` is `null`.
   */
  progress_milestone_ticks: number;
  /**
   * The trail run id the slot's active fence was written for (#683) — captured at
   * fence-write time because the bind posted right after the takeover's spawn needs it
   * (the spawn path has no ground-truth read of its own), and the release posted at the
   * `exit-detected` hook needs it after the slot's own milestone may have moved on.
   * `null` when the slot holds no fence (a gen-0 dispatch never fenced). Never used to
   * MATCH identity — fence ownership is run id + generation (#683 AC7); this only names
   * WHICH trail the slot's fence lives on. Added in schema 1.17.0; 1.16.0 slots
   * backfill null.
   */
  run_id: string | null;
  /**
   * The phase token the slot's active fence was written under (#683) — the bind and
   * release records must read coherently with their fence on the trail, and the spawn
   * and exit paths have no trail read to re-derive it. `null` whenever `run_id` is.
   * Added in schema 1.17.0; 1.16.0 slots backfill null.
   */
  fence_phase: string | null;
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
  /**
   * When the engine last re-read hard-block labels (#544). The label
   * re-check runs on every tick that has work; on a tick with nothing else
   * to do it is throttled to `LABEL_POLL_IDLE_INTERVAL_MS` since this
   * timestamp, so an idle fleet does not spend a `gh issue view` per blocked
   * unit per tick forever. Persisted — like `last_pr_poll_at` — so the
   * throttle survives a `sched` restart rather than resetting to "poll now"
   * on every crash loop.
   */
  last_label_poll_at: string | null;
  /**
   * Consecutive `suspect-dispatch` exits (#505) from DIFFERENT units — the
   * dispatch-health signal. A quota/auth wall kills every unit the same way
   * (instant unverified exit, zero progress), so cross-unit correlation is
   * what tells it apart from one unit's own genuine failure. Reset to 0 by
   * any non-suspect dispatch outcome (`recordDispatchOutcome` in engine.ts).
   */
  consecutive_suspect_dispatches: number;
  /**
   * Unit of the most recent `suspect-dispatch` exit, so a repeat from the
   * SAME unit's own ladder retries never counts toward the cross-unit
   * correlation above. Null when the counter is 0.
   */
  last_suspect_dispatch_unit: string | null;
  /**
   * Consecutive CONFIRMED dispatch failures (#629) — a result carrying
   * `api_error_status`/`terminal_reason: "api_error"` (see
   * `parseDispatchApiError` in `@ai-dossier/core`). Unlike
   * `consecutive_suspect_dispatches`, this counts a repeat from the SAME
   * unit: the classification is deterministic (a parsed provider error), not
   * a timing heuristic, so no cross-unit correlation is needed to rule out
   * one unit's own flakiness — a spend/rate wall hits whichever unit
   * happens to be running, repeatedly, and the real incident (#629) was the
   * SAME batch-tail unit nine times. Both dispatch paths RECORD into it
   * (`recordDispatchApiError` in `dispatch-health.ts`, shared by `engine.ts`
   * and every batch reconciler) and both RESET it on a healthy dispatch
   * (`resetDispatchApiErrorStreak` — a verified completion/park on the
   * per-issue path, a successful member/tail/report on the batch path) or on
   * `sched resume` (`setPaused` in scheduler.ts) — NOT exactly like the
   * suspect-dispatch pair above, which also resets on a plain (non-suspect)
   * unverified exit; this counter deliberately does not, since an unverified
   * exit is not evidence the provider wall cleared.
   */
  consecutive_dispatch_api_errors: number;
  /**
   * The provider's own rate-limit reset time (#629 AC4), when the most
   * recent confirmed dispatch failure supplied one. Null when none was
   * reported, or once the streak above resets.
   */
  dispatch_pause_reset_at: string | null;
  /** The latest scheduler-wide tick failure, cleared by the next successful tick (#635). */
  last_tick_failure: { at: string; detail: string } | null;
}

/** Durable intent, persisted separately in `config.json` (state.json is rebuildable hot truth). */
export interface SchedConfig {
  max_slots: number;
  /**
   * Stall timeout in ms — no new milestone AND no new pushed commit for this
   * long → redispatch stronger (default 30 min). Applies to any phase with
   * no per-phase allowance; a phase with a built-in `DEFAULT_PHASE_STALL_TIMEOUT_MS`
   * entry (`implement`, 90 min) uses `max(built-in, this value)` — raising
   * this floor never silently shortens it — while an explicit
   * `dispatch.phase_stall_timeout_ms` entry always wins verbatim (#495).
   */
  stall_timeout_ms?: number;
  /** Reconciliation tick interval in ms (default 60 000). */
  reconcile_interval_ms?: number;
  /**
   * Parked-PR poll interval in ms (#468, default 150 000 — "every 2–3 min").
   * Checked on each reconcile tick when due; see `SchedState.last_pr_poll_at`.
   */
  pr_poll_interval_ms?: number;
  /**
   * Hard-block label re-read interval in ms for an IDLE tick (#544, default
   * 600 000 — 10 min). A tick with work re-reads every tick regardless; this
   * only bounds the cost of a fleet parked entirely on human decisions. Every
   * other poll cadence here is operator-tunable, and an operator hitting a
   * `gh` rate wall — or babysitting a hand-off they want picked up faster —
   * needs the same lever. See `SchedState.last_label_poll_at`.
   */
  label_poll_interval_ms?: number;
  /** Agent dispatch settings (#464); every field optional with engine defaults. */
  dispatch?: DispatchConfig;
  /**
   * Let a cron-driven `sched start --once` self-upgrade (`npm i -g
   * @ai-dossier/cli@latest`) when it detects it is behind npm latest (#537).
   * The `--auto-upgrade` CLI flag overrides this when passed; default off.
   */
  auto_upgrade?: boolean;
  /**
   * Per-project override of the batch dissolve threshold (#563). Both
   * `fraction` and `min_evictions_before_dissolve` are required when this
   * key is present — there is no per-field merge with the default. An
   * absent `dissolve_policy` falls back wholesale to `DEFAULT_DISSOLVE_POLICY`
   * at the point of use, never eagerly merged into config at load time.
   */
  dissolve_policy?: DissolvePolicy;
  /**
   * Default `BatchEntry.priority` for a batch created with no explicit
   * `batch_priority` (#565, e.g. `sched enqueue --mode slot --batch <id>`
   * with no `--priority`). Default `DEFAULT_BATCH_PRIORITY` (10) — above the
   * default full-cycle entry priority (0), so a ready batch is assigned
   * ahead of same-readiness issue units unless the operator says otherwise.
   */
  default_batch_priority?: number;
}

/**
 * Full per-tier spawn spec (#527) — lets a tier point at a different agent
 * CLI, not just a different model within the same one (e.g. `opencode` for
 * `mid`, `claude` for `strong`). Any field left unset falls back to the
 * shorthand: `command` → `DispatchConfig.command`, `model` →
 * `DispatchConfig.tier_models[tier]`, `prompt` → `DispatchConfig.prompt`.
 */
export interface TierDispatchSpec {
  /** Command template for this tier only; same `{model}`/`{issue}` substitution rules as the top-level `command`. */
  command?: string[];
  /** Model id/alias for this tier only. */
  model?: string;
  /** Prompt template for this tier only; `{issue}` substituted. */
  prompt?: string;
}

/**
 * A named dispatch profile (#707) — the spawn-shaping subset of
 * {@link DispatchConfig}, bundled under one name so a batch can record and
 * inherit a whole agent FAMILY (command + per-tier model ladder) instead of
 * the config's default. Fields left unset fall back to the config's own
 * values at resolution time (`resolveProfiledDispatch`), so a profile may
 * carry as little as a `tier_models` ladder.
 */
export interface DispatchProfile {
  /** Command template; same `{model}`/`{issue}` substitution rules as `DispatchConfig.command`. */
  command?: string[];
  /** Prompt template sent on the child's stdin; `{issue}` substituted. */
  prompt?: string;
  /** The profile's own per-tier ladder — "GLM family" is flash/mid/strong GLMs, not one model everywhere (#707 AC8). */
  tier_models?: Partial<Record<ModelTier, string>>;
  /** Per-tier full spawn spec (#527), same fallback rules as the top-level `tiers`. */
  tiers?: Partial<Record<ModelTier, TierDispatchSpec>>;
}

/** The configuration layer that supplied a resolved named dispatch profile. */
export type DispatchProfileSource = 'user' | 'project';

/**
 * Agent dispatch configuration (#464). The command is a template: `{model}`
 * and `{issue}` placeholders are substituted per dispatch; a `{model}` item
 * whose tier has no model configured drops together with its flag.
 */
export interface DispatchConfig {
  /** Command template, e.g. `['claude','-p','--output-format','stream-json','--verbose','--model','{model}']`. */
  command?: string[];
  /** Prompt template sent on the child's stdin; `{issue}` substituted. */
  prompt?: string;
  /** Tier → model id/alias mapping (defaults: haiku / sonnet / opus). */
  tier_models?: Partial<Record<ModelTier, string>>;
  /**
   * Named dispatch profiles (#707) — the resolution target for
   * `sched enqueue --dispatch <name>` and `BatchEntry.dispatch_profile`. The
   * top-level `command`/`tier_models`/`tiers`/`prompt` above remain the
   * DEFAULT (unnamed) profile, so an unconfigured or unprofiled batch
   * dispatches exactly as before. A profile must carry its own per-tier
   * ladder; a profile whose tiers all name one model is expressible but is
   * never a default (#707).
   */
  dispatch_profiles?: Record<string, DispatchProfile>;
  /** Runtime-only provenance for resolved named profiles; never persisted to project config. */
  dispatch_profile_sources?: Record<string, DispatchProfileSource>;
  /**
   * Per-tier full spawn spec (#527) — the mixed agent-CLI escalation ladder.
   * A tier without an entry here falls back to `command`/`tier_models`/
   * `prompt` (the pre-#527 shorthand), so existing configs keep working
   * unchanged; this is the "migrate transparently" path — there is no
   * on-disk rewrite, only resolution-time fallback (`resolveDispatch`).
   */
  tiers?: Partial<Record<ModelTier, TierDispatchSpec>>;
  /**
   * Per-phase stall timeout overrides in ms, keyed by runstate milestone
   * phase (one of `PHASES`/`BATCH_PHASES` below — an unrecognized key is
   * rejected at config-load time, never silently ignored) — falls back to
   * `stall_timeout_ms` (or its own built-in default, for `implement`) for
   * any phase not listed. Selected by the CURRENTLY RUNNING phase — the last
   * milestone's `next=` — not the last COMPLETED phase, since a long
   * phase's progress signals go quiet for its entire duration (#495).
   */
  phase_stall_timeout_ms?: Record<string, number>;
  /**
   * Prompt template for the report agent dispatched after a merged PR
   * (#468); `{issue}`, `{pr}` and `{cleanup}` substituted. Defaults to
   * `DEFAULT_REPORT_PROMPT_TEMPLATE`.
   */
  report_prompt?: string;
  /**
   * Prompt template for the one bounded fix attempt on a failing batch member
   * (#472); `{issue}`, `{batch}` and `{tests}` substituted. Defaults to
   * `DEFAULT_FIX_PROMPT_TEMPLATE`.
   */
  fix_prompt?: string;
  /**
   * Aggregate batch-suite command, argv form (#562) — the middle tier of the
   * suite-command resolution order (`cap run test.full` manifest → this →
   * repo-detected safe default). Set this when the repo's `test` script
   * delegates to something that cannot take extra reporter flags (a
   * Makefile, a shell wrapper) and there is no `.dossier/automation/`
   * manifest to declare `test.full` in instead. Never appended with extra
   * flags — argv exactly as given.
   */
  suite_command?: string[];
  /**
   * Prompt template for one batch member (#523 AC1, #677) — runs
   * `imboard-ai/git/member-cycle` in the member's OWN worktree off the
   * integration branch; `{issue}`, `{batch}`, `{worktree}` and
   * `{integration_branch}` substituted. Defaults to
   * `DEFAULT_MEMBER_PROMPT_TEMPLATE`.
   */
  member_prompt?: string;
  /**
   * Prompt template for the batch tail agent (#523 AC3) — aggregate review
   * then batch-mode ship, parking the PR exactly like a full-cycle run;
   * `{batch}`, `{anchor}`, `{members}` and `{worktree}` substituted. Defaults
   * to `DEFAULT_BATCH_TAIL_PROMPT_TEMPLATE`.
   */
  batch_tail_prompt?: string;
  /**
   * Prompt template for the cheap-tier batch report agent (#523 AC3),
   * dispatched after the batch PR merges — mirrors `report_prompt` at batch
   * granularity; `{batch}`, `{anchor}`, `{pr}` substituted. Defaults to
   * `DEFAULT_BATCH_REPORT_PROMPT_TEMPLATE`.
   */
  batch_report_prompt?: string;
  /**
   * How long a freshly-fenced slot may go without any progress signal before the
   * ladder re-enters recovery (#504 AC4). A takeover can die on its own first breath,
   * and waiting out the phase's full stall allowance (90 min for `implement`) to
   * discover that wastes the very time the redispatch was meant to save. Applied only
   * while the takeover has posted nothing at all — the first progress signal clears it
   * and the ordinary per-phase timeout takes over. Defaults to
   * {@link DEFAULT_FENCE_TAKEOVER_TIMEOUT_MS}.
   */
  fence_takeover_timeout_ms?: number;
  /**
   * Tool names to deny on every `claude`-family dispatch via `--disallowedTools` (#591).
   * Defaults to `['Monitor']` — a headless `claude -p` session ends the instant the model
   * stops responding, so an agent that arms `Monitor` to wait on a background command (e.g.
   * `ci-parity.sh`) and then ends its turn abandons the run with the subprocess still going;
   * the engine can only see this as an unverified exit (`agent-exited-unverified` /
   * `unverified-exit-at-strongest-tier`). `NO_BACKGROUND_EXIT_INSTRUCTION` asks the model not
   * to do this; this flag makes it structurally impossible for `claude`-family CLIs. Set `[]`
   * to opt out entirely. Never applied to a non-`claude` command (e.g. `opencode`), which has
   * no such flag.
   */
  disallowed_tools?: string[];
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

/**
 * Default {@link DispatchConfig.fence_takeover_timeout_ms} — 15 minutes.
 *
 * Long enough that a takeover doing real work (fetching the workflow, materializing a
 * worktree, warming it) is never cut off before its gate milestone lands; short enough
 * that a takeover killed at birth by a quota wall does not sit out an `implement`-length
 * stall allowance before anyone notices.
 */
export const DEFAULT_FENCE_TAKEOVER_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * An unverified exit is `suspect-dispatch` (#505) when it happens within
 * this many ms of the slot's last progress (spawn or respawn, since
 * `last_progress_at` is re-stamped on every dispatch): real work rarely
 * produces zero milestones this fast, but a quota/auth wall that rejects the
 * agent's very first request does, every time.
 */
export const SUSPECT_DISPATCH_WINDOW_MS = 60 * 1000;

/**
 * Consecutive `suspect-dispatch` exits from DIFFERENT units before dispatch
 * itself is judged unhealthy and new assignments pause (#505). Two, like
 * `ESCALATION_CAP` — this codebase's standard bounded-retry number.
 */
export const DISPATCH_UNHEALTHY_THRESHOLD = 2;

/** Default stall timeout: 30 minutes without a milestone or pushed commit (RFC-0001 §C.1). */
export const DEFAULT_STALL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Built-in per-phase stall timeout overrides (#495): the `implement` phase
 * alone regularly runs 1-3h on a large monorepo (cold worktree warmup +
 * implement + test suite) with zero intermediate milestone or pushed
 * commit, so the blanket 30-min default kills healthy agents mid-phase. 90
 * minutes matches the value operators had already validated as a manual
 * per-project workaround (`docs/reports/sched-parity.md` §2.1 engine config
 * / §5 divergence D1 — the W1-W3 fleet-parity run applied
 * `stall_timeout_ms=90min` globally) — long enough to cover a real implement
 * phase, short enough that the ladder still fires on a genuine hang. Every
 * other phase keeps `DEFAULT_STALL_TIMEOUT_MS`. Frozen: exported from the
 * package, so an in-process consumer mutating it must never change the
 * ladder for every other project sharing the process.
 */
export const DEFAULT_PHASE_STALL_TIMEOUT_MS: Readonly<Record<string, number>> = Object.freeze({
  implement: 90 * 60 * 1000,
});

/** Default reconciliation tick: ~60s (RFC-0001 §C.1). */
export const DEFAULT_RECONCILE_INTERVAL_MS = 60 * 1000;

/** Default parked-PR poll interval: 2.5 min (#468 AC1 "every 2–3 min"). */
export const DEFAULT_PR_POLL_INTERVAL_MS = 150 * 1000;

/**
 * Default idle-tick hard-block label re-read interval (#544): 10 min. Only a
 * tick with nothing else to do waits this long — see `pollLabels`.
 */
export const DEFAULT_LABEL_POLL_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Fraction of a batch's members whose eviction dissolves it: STRICTLY more
 * than a third (RFC-0001 §F.8 "> ⅓ evicted → dissolve"). Kept as the default
 * `DissolvePolicy.fraction` below — see that type for how it combines with
 * `min_evictions_before_dissolve` into the actual threshold.
 */
export const DISSOLVE_EVICTION_FRACTION = 1 / 3;

/**
 * Dissolve threshold policy (#563) — how many evictions a batch tolerates
 * before it dissolves. The threshold is `max(ceil(N × fraction),
 * min_evictions_before_dissolve)`, clamped below `N` (see `dissolveThreshold`
 * in recovery.ts) so a batch that loses every member always dissolves
 * regardless of the floor; a batch dissolves once evictions exceed the
 * (clamped) threshold. A raw `evicted > N × fraction` float comparison (the
 * pre-#563 behavior) rounds down for small N — at N=4 it dissolves on the
 * 2nd eviction, the same as N=3, leaving one member's failure as the entire
 * tolerance at the batch sizes the pilot actually uses (`docs/reports/batch-pilot-2-execution.md` B3c).
 * Taking `ceil` of the fraction term fixes N=4 (dissolves on the 3rd
 * eviction instead of the 2nd) — and, more generally, tolerates one more
 * eviction than before for every N that is NOT a multiple of the fraction's
 * denominator (with the default ⅓: every N except 3, 6, 9, …). A caller
 * relying on dissolve timing for a specific N should verify it against this
 * formula rather than assume only N=4 changed. `min_evictions_before_dissolve`
 * is a floor a project can raise further, independent of the fraction.
 */
export interface DissolvePolicy {
  /** Fraction of members lost that contributes to the threshold (RFC-0001 §F.8 default: 1/3). */
  fraction: number;
  /** Floor on the threshold, regardless of what the fraction alone would compute. */
  min_evictions_before_dissolve: number;
}

/** Default dissolve policy — RFC-0001 §F.8's fraction, no floor beyond `ceil(N × fraction)` itself. */
export const DEFAULT_DISSOLVE_POLICY: DissolvePolicy = {
  fraction: DISSOLVE_EVICTION_FRACTION,
  min_evictions_before_dissolve: 1,
};

/** The one `?? DEFAULT_DISSOLVE_POLICY` fallback, shared by every site that resolves a policy from an optional source (`SchedConfig.dissolve_policy`, `RecoveryDeps.dissolvePolicy`). */
export function resolveDissolvePolicy(policy: DissolvePolicy | undefined): DissolvePolicy {
  return policy ?? DEFAULT_DISSOLVE_POLICY;
}

/** Bounded fix attempts per member before it is evicted (§F.2 "one bounded attempt"). */
export const MAX_FIX_ATTEMPTS_PER_MEMBER = 1;

/**
 * Tier the one bounded fix attempt runs at (§F.2 "mid-tier agent dispatch").
 * Deliberately not the member's own tier: that tier already produced the code
 * the suite is failing on.
 */
export const FIX_ATTEMPT_TIER: ModelTier = 'mid';

/**
 * The per-issue full-cycle runstate phases.
 *
 * MUST stay in sync with `PHASES` in `cli/src/runstate.ts`, which is the
 * validating authority — this package cannot import from the CLI (the CLI
 * depends on this package), so the vocabulary is a deliberate copy, exactly
 * like `BATCH_PHASES` below. Used to reject an unrecognized
 * `dispatch.phase_stall_timeout_ms` key at config-load time (#495) instead
 * of silently ignoring a typo.
 */
export const PHASES = ['gate', 'setup', 'plan', 'implement', 'review', 'ship', 'report'] as const;

export type Phase = (typeof PHASES)[number];

/**
 * The batch-line runstate phases (RFC-0001 §D.2).
 *
 * MUST stay in sync with `BATCH_PHASES`/`BATCH_SPECS` in `cli/src/runstate.ts`,
 * which is the validating authority — this package cannot import from the CLI
 * (the CLI depends on this package), so the vocabulary is a deliberate copy.
 * A phase or status the CLI rejects makes the milestone un-postable at runtime.
 */
export const BATCH_PHASES = [
  'batch-setup',
  'batch-validate',
  'batch-review',
  'batch-ship',
  'batch-report',
] as const;

export type BatchPhase = (typeof BATCH_PHASES)[number];

/** Rebases of a conflicting batch PR before dissolving into halves (§F.9 "re-ship once"). */
export const MAX_REBASE_ATTEMPTS = 1;

/**
 * Ticks a still-live durable condition stays silent before the journal
 * re-announces it (#610/#630/#632). One policy, one definition: `engine.ts`
 * and `batch-dispatch.ts` are duplicate, independently-maintained state
 * machines by design (see `docs/agent-traps.md`), which is exactly why this
 * tunable must not be declared once per rail — a retune of one copy would
 * silently not apply to the other.
 *
 * It is a TICK count, not a duration, and the two rails tick at different
 * rates: at the default intervals it is ~20 min for the per-reconcile sites
 * (`DEFAULT_RECONCILE_INTERVAL_MS`) and ~50 min for the sites gated on the
 * parked-PR poll (`DEFAULT_PR_POLL_INTERVAL_MS`). Both intervals are
 * operator-tunable, which is why every deduped entry also carries `since`.
 */
export const JOURNAL_DEDUP_REANNOUNCE_TICKS = 20;

/**
 * 1.13.0 (#630): `BatchEntry` gains `pr_watch_failed_reason`/`_since`/`_ticks`.
 * 1.14.0 (#632): `QueueEntry` gains `ground_truth_unreachable_since`/`_ticks`
 * and `pr_watch_waiting_since`/`_ticks`.
 * 1.15.0 (#629): `SchedState` gains `consecutive_dispatch_api_errors` +
 * `dispatch_pause_reset_at`.
 * 1.16.0 (#682): `SlotEntry` gains `progress_milestone_for`/`_since`/`_ticks`.
 * 1.17.0 (#683): `SlotEntry` gains `run_id`/`fence_phase` — the fence's trail
 * coordinates, captured at write time so the spawn-path bind and the
 * `exit-detected`-hook release can name the same record without a trail read.
 * 1.18.0 (#677): `BatchEntry` gains `member_branch`/`member_worktree`/
 * `member_pool_claimed` — the current member's own worktree/branch context
 * (RFC-0001 §J.3); `null`/`null`/`false` backfilled on load.
 * 1.19.0 (#707): `BatchEntry` gains `dispatch_profile` — the named dispatch
 * profile resolved at enqueue (null = the config's default); `null`
 * backfilled on load.
 * 1.20.0 (#713): `QueueEntry` gains `dispatch_profile` for full-cycle
 * entries; `null` is backfilled on load.
 * 1.21.0 (#635): `SchedState` gains `last_tick_failure`, retaining the latest
 * scheduler-wide error for `sched status`; null is backfilled on load.
 */
export const SCHEMA_VERSION = '1.21.0' as const;

/** Schema versions `validateState` accepts on load (migrated to SCHEMA_VERSION on save). */
export const LEGACY_SCHEMA_VERSIONS: readonly string[] = [
  '1.0.0',
  '1.1.0',
  '1.2.0',
  '1.3.0',
  '1.4.0',
  '1.5.0',
  '1.6.0',
  '1.7.0',
  '1.8.0',
  '1.9.0',
  '1.10.0',
  '1.11.0',
  '1.12.0',
  '1.13.0',
  '1.14.0',
  '1.15.0',
  '1.16.0',
  '1.17.0',
  '1.18.0',
  '1.19.0',
  '1.20.0',
];

export const CONFIG_SCHEMA_VERSION = '1.9.0' as const;

/** Config schema versions `loadConfig` accepts and migrates transparently on load (fields absent in an older version simply resolve to their defaults). */
export const LEGACY_CONFIG_SCHEMA_VERSIONS: readonly string[] = [
  '1.0.0',
  '1.1.0',
  '1.2.0',
  '1.3.0',
  '1.4.0',
  '1.5.0',
  '1.6.0',
  '1.7.0',
  '1.8.0',
];

/** Config file shape (schema_version + the config itself). */
export interface SchedConfigFile {
  schema_version: string;
  max_slots: number;
  stall_timeout_ms?: number;
  reconcile_interval_ms?: number;
  pr_poll_interval_ms?: number;
  label_poll_interval_ms?: number;
  dispatch?: DispatchConfig;
  auto_upgrade?: boolean;
  dissolve_policy?: DissolvePolicy;
  default_batch_priority?: number;
}

export const DEFAULT_MAX_SLOTS = 3;

/**
 * Default `QueueEntry.priority` for a full-cycle entry (#565). Named
 * alongside `DEFAULT_BATCH_PRIORITY` because the two only make sense
 * relative to each other — the whole point of the feature is
 * `DEFAULT_BATCH_PRIORITY > DEFAULT_ISSUE_PRIORITY`, so a ready batch is
 * assigned before a same-readiness issue by default.
 */
export const DEFAULT_ISSUE_PRIORITY = 0;

/** Default `BatchEntry.priority` (#565) — see `SchedConfig.default_batch_priority`. Must stay > `DEFAULT_ISSUE_PRIORITY`. */
export const DEFAULT_BATCH_PRIORITY = 10;

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

/**
 * Thrown when `state.json`'s `schema_version` is numerically NEWER than the
 * installed engine's `SCHEMA_VERSION` (#537) — a distinct case from a
 * generically unsupported/garbage version string (`CorruptStateError`
 * still covers that). This is not corruption: another (newer) engine wrote
 * this state, and "rename or remove it to reset the queue" would destroy
 * real queue data the installed engine simply can't read yet. The fix is to
 * upgrade the installed engine, not the state file.
 */
export class EngineTooOldError extends Error {
  readonly stateVersion: string;
  readonly installedVersion: string;

  constructor(stateVersion: string, installedVersion: string) {
    super(
      `State file was written by a newer schema (${stateVersion}) than the installed ` +
        `@ai-dossier/sched (${installedVersion}). Upgrade: npm i -g @ai-dossier/cli@latest`
    );
    this.name = 'EngineTooOldError';
    this.stateVersion = stateVersion;
    this.installedVersion = installedVersion;
  }
}

// --- Dispatch journal events (#464, RFC-0001 §D.4 "Audit") ---

/**
 * Every event journaled to `events.jsonl` (append-only) — by the engine, and
 * (since #507) by `sched enqueue` itself, before any dispatch: see the
 * `label-blocked`/`label-check-failed` group below.
 */
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
  // #613: a member resolution that lost the one-shot claim on
  // `executing_member` and therefore advanced nothing. Journaled rather than
  // dropped, for the same reason `eviction-duplicate` is (#595): a batch that
  // stops advancing must say so, otherwise an operator sees a clean
  // `verify-complete` and then silence, with no way to tell a benign duplicate
  // from a batch stuck on a member nobody will spawn.
  | 'member-advance-skipped'
  | 'dependents-blocked'
  // #707: a batch's recorded dispatch profile no longer resolves against the
  // current config, and the batch is POST-merge (its product already shipped)
  // — the remaining tail work falls back to the default dispatch, loudly.
  // Pre-merge the same condition dissolves the batch instead (a state
  // transition, journaled once). Post-merge notices are also journal-deduped,
  // so this event remains bounded across reconcile ticks and restarts.
  | 'dispatch-profile-missing'
  // #525: a slot reaching `idle` on a per-issue dispatch terminal path
  // (verified completion, external-advance, a detached-ship park, a direct
  // failure, or a dependent released by `blockTransitiveDependents`) —
  // journaled once, right after that path's own cause event, at the point
  // the slot ACTUALLY empties. A report reading the journal never has to
  // infer release time from the next `assigned` event on that slot. Not yet
  // journaled by `sched abandon` (`scheduler.ts`'s `abandonIssue`) or by
  // batch-slot release (`batch-dispatch.ts`'s `releaseSlot`) — both walk a
  // slot to `idle` through their own copy of this same edge table, but
  // neither is wired to this event (tracked as a follow-up, not this issue's
  // scope: #525's own Scope section names only `scheduler.ts`/`state.ts`).
  | 'slot-released'
  | 'requeued'
  | 'ground-truth-unreachable'
  | 'suspect-dispatch'
  | 'dispatch-unhealthy'
  // #629: a dispatch result carrying `api_error_status`/`terminal_reason:
  // "api_error"` — a confirmed provider-side wall, never an agent that ran.
  | 'dispatch-failure'
  | 'tick-failed'
  | 'pr-parked'
  | 'merge-accepted'
  | 'pr-watch-failed'
  | 'pr-watch-waiting'
  | 'teardown-done'
  | 'teardown-failed'
  | 'report-dispatched'
  | 'report-failed'
  // #501: a `failed reason=auto-merge-blocked` entry whose PR was later
  // manually re-queued and merged is reconciled back to `shipped` (and its
  // dependents unblocked).
  | 'stale-failure-reconciled'
  // #472 batch failure recovery (RFC-0001 §F.2/F.8/F.9)
  | 'suite-failed'
  | 'git-failed'
  | 'attributed'
  | 'fix-dispatched'
  | 'fix-resolved'
  | 'member-evicted'
  | 'revert-conflict'
  | 'batch-rebased'
  | 'batch-dissolved'
  // #563: the dissolve threshold was crossed, but a fresh suite re-run
  // confirmed the survivors are green — they stay in the batch and ship
  // together; only the evicted members requeue. Never `dissolved`.
  | 'batch-preserved'
  | 'batch-split'
  // #562: the aggregate suite report was unreadable even after the one
  // fallback-runner retry — the batch blocks (no requeue, no revert) rather
  // than dissolving on an "unattributable" red suite that was never really
  // parsed at all.
  | 'batch-blocked'
  // #583: the per-member incremental gate (`typecheck.run`/`test.focused`
  // via `cap run`) came back `automation-broken`/`capability-unavailable`
  // rather than a definite `ok`/`task-failed` — the gate itself could not
  // reach a verdict, so the batch blocks (member's commit stays on the
  // branch, nothing requeued/reverted) instead of evicting a possibly-good
  // member on a false signal. Mirrors `batch-blocked`'s "block, don't
  // dissolve" precedent one level down, at the per-member gate rather than
  // the aggregate suite.
  | 'gate-inconclusive'
  // #625: a gate capability this repo never DECLARED, so that half of the
  // member gate did not run. Distinct from `gate-inconclusive`, which means a
  // declared capability could not be trusted: an undeclared id is not a
  // verdict, it is a repo that has not opted into the capability layer.
  // Journalled per member because a gate that silently does not run is its
  // own trap — silence must never read as a pass.
  | 'gate-skipped'
  | 'milestone-post-failed'
  // #504 zombie-run fencing: the takeover record written before a redispatch
  // respawns, and the degraded path where it could not be written.
  | 'fence-written'
  | 'fence-failed'
  // #683 fence lifecycle: the takeover's spawn bound its pid to the fence (so
  // readers can tell a live owner from a ghost), and the owning dispatch's
  // `exit-detected` released the fence — plus the degraded path of either.
  | 'fence-bound'
  | 'fence-bind-failed'
  | 'fence-released'
  | 'fence-release-failed'
  // #683: an agent that exited BECAUSE a fence told it to — a deliberate,
  // correct no-op, never an unverified failure. Redispatched at the same tier
  // without consuming an escalation rung.
  | 'deferred-to-owner'
  // #685: the announce-then-exit signature — a CLEAN exit whose final message
  // announces a wait on background work (true interactively, false under
  // `-p`). A known-recoverable condition, never an unverified failure:
  // redispatched at the same tier without consuming an escalation rung.
  | 'announced-wait'
  | 'stopped'
  // #523 batch dispatch: claiming the shared worktree/branch, and advancing
  // the member pointer between member-cycle runs (#677: members run in their
  // own worktrees off the integration branch). Member/tail-agent spawn,
  // progress, completion and park events reuse the existing unit-generic
  // names above (`assigned`/`spawned`/`progress`/`external-advance`/
  // `verify-complete`/`pr-parked`/`merge-accepted`/`report-dispatched`) —
  // `unit` is `batch:<id>` and `issueOfUnit` already returns null for it.
  | 'batch-setup-done'
  | 'batch-setup-failed'
  // #561: the cold-path warm step (pool-claimed worktrees skip it — already
  // warm) — `JournalEvent` has no `duration_ms` field, so the elapsed time is
  // appended to `detail` instead (`<tag> <n>ms`), alongside which path ran
  // (`cap:worktree.prepare` / `pm:<npm|pnpm|yarn|bun>:<n>cmds` / `skipped:...`
  // / a `pool-claim-invalid:` prefix when the cold path was taken because a
  // pool claim returned unusable output rather than "no warm spares"), even
  // when there was nothing to warm.
  | 'batch-warmup-done'
  | 'batch-warmup-failed'
  | 'member-advanced'
  // #677 per-member worktrees (RFC-0001 §J.3): an on-disk worktree for the
  // SAME member reused by a takeover redispatch (spawn-time event, never
  // per-tick); a member's verified branch fast-forward-landed onto the
  // integration branch; the mechanical landing step failing (blocks the
  // batch); the member's own worktree/branch cleaned up after resolution;
  // and persisted member context that does NOT belong to the current
  // member (stale after a failed teardown or a crash mid-eviction),
  // journalled once at the moment it is discarded for a fresh prep.
  | 'member-worktree-reused'
  | 'member-landed'
  | 'landing-failed'
  | 'member-worktree-torn-down'
  | 'stale-member-worktree'
  // #507 enqueue-time hard-block label pre-screen (journaled by the CLI,
  // NOT the engine — sched enqueue appends these before the issue is ever
  // dispatched)
  | 'label-blocked'
  | 'label-check-failed'
  // #544 per-tick hard-block label re-check (journaled by the ENGINE, unlike
  // the two above): a `label:<name>`-blocked entry whose label the operator
  // has since removed, returned to `queued`. Its `reason` is the block that
  // was CLEARED (`label:<name>`), not one now in force — the one place in this
  // vocabulary where `reason` names a past state, so that the removed label is
  // recoverable from the journal at all. The engine also re-uses
  // `label-blocked` (a dispatchable entry that GAINED a hard-block label
  // mid-wave, or a blocked entry whose label CHANGED — the latter carries
  // `previous_reason`) and `label-check-failed` (an unreachable label read,
  // which decides nothing) — one event vocabulary across both screens.
  | 'label-cleared'
  // #524 runs.jsonl telemetry: a dispatch's exit produced no entry (unit left
  // the queue, or is not an `issue:<n>` unit), or the append itself failed.
  | 'run-log-skipped'
  | 'run-log-recorded'
  | 'run-log-no-usage'
  | 'run-log-failed'
  // #537: the installed `@ai-dossier/sched` is behind npm latest (journaled
  // by the CLI's `sched start`, process-scoped like `tick-failed` — not
  // unit-scoped). Appended once per distinct (installed, latest) pair, not
  // every tick — see `installed_version`/`latest_version` on `JournalEvent`.
  | 'engine-stale'
  // #537: `--auto-upgrade`'s `npm i -g @ai-dossier/cli@latest` outcome —
  // journaled so an operator whose stderr isn't captured (systemd unit
  // without journald wiring, redirected to /dev/null) can still answer "was
  // an upgrade attempted, and did it work?" from events.jsonl alone.
  | 'engine-auto-upgrade-attempted'
  | 'engine-auto-upgrade-failed'
  // #565: `sched reprioritize` mutates state.json directly with no other
  // trace — `updated_at` is deliberately NOT bumped (it is the readiness-age
  // tiebreak in `compareByPriority`, and a manual priority edit must not also
  // reset a long-waiting unit's queue position), so without this event there
  // is no way to answer "when did this unit's priority change, and to what"
  // after the fact. `priority` carries the new value, `detail` the previous.
  | 'reprioritized'
  // #575: `reconcileRunning` saw a `report/done` milestone that would have
  // externally-advanced the unit under the old rule, but it predates this
  // dispatch's `spawned_at` (a stale milestone from a PREVIOUS completed run
  // on a re-enqueued issue) — the dispatch fence in `isVerifiedComplete`
  // ignored it and the fresh agent keeps running. Journaled per-tick while
  // the condition holds, same convention as `ground-truth-unreachable`.
  | 'stale-milestone-ignored'
  // #595: a second eviction call named a member already in `batch.evictions`
  // — the append is a no-op (never a second `EvictionRecord`), journaled here
  // instead of silently dropped so the duplicate attempt is still visible.
  | 'eviction-duplicate';

/**
 * The closed `reason` vocabulary a `slot-released` event carries (#525) —
 * one entry per per-issue terminal path `walkSlotToIdle` can be released
 * from, matching the cause event journaled immediately before it
 * (`verify-complete`/`external-advance` for a completion, `unit-failed` or
 * `report-failed` for a failure, `dependents-blocked` for a released
 * dependent, `parked` for a detached-ship park).
 */
export type SlotReleaseReason =
  | 'verify-complete'
  | 'external-advance'
  | 'unit-failed'
  | 'report-failed'
  | 'dependents-blocked'
  | 'parked'
  | 'stopped';

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
  /** The worktree a member dispatch spawned into (#677) — the per-member evidence trail. */
  worktree?: string;
  detail?: string;
  /**
   * Free-form cause, matching `QueueEntry.reason`'s vocabulary for a
   * block/failure event (e.g. `unit-failed`, `dependents-blocked`,
   * `label-blocked`) — declared here so callers get the same excess-property
   * check `detail` gets, instead of routing through a loosely-typed
   * `Record<string, unknown>` the way `engine.ts`'s local `journal()`
   * wrapper already does for every pre-#507 use of this field. Since #525
   * `slot-released` also uses this field, for the closed `SlotReleaseReason`
   * vocabulary above rather than `QueueEntry.reason`'s.
   */
  reason?: string;
  /**
   * The `reason` an event REPLACED, in the same vocabulary as `reason` (#544's
   * `label-blocked` on a changed label: `reason` is the label now in force,
   * `previous_reason` the one it displaced). Without it the old value is
   * unrecoverable from `events.jsonl` — the entry's `reason` is overwritten in
   * place — and "was this relabelled, or did the policy order change under
   * me?" becomes unanswerable.
   */
  previous_reason?: string;
  /**
   * Agent command actually spawned, joined with spaces (#527) — declared so
   * `spawned`/`redispatched` writers get an excess-property check instead of
   * silently dropping through a loose `Record<string, unknown>` extra bag.
   */
  cmd?: string;
  /**
   * Model id/alias the spawned tier resolved to (#527) — audit-trail
   * visibility only (`sched status`/`events.jsonl`). `runstate stats`'s
   * per-model buckets come independently from `runs.jsonl`'s
   * `RunLogEntry.model` (`recordDispatchRunLog`'s own tier-model read).
   */
  model?: string;
  /** Absolute path to the spawned process's log file. */
  log?: string;
  /** `engine-stale` (#537): the installed `@ai-dossier/sched` version. */
  installed_version?: string;
  /** `engine-stale` (#537): npm registry latest at check time. */
  latest_version?: string;
  /** The unit's `priority` at assignment time (#565 AC2 — "journaled on each assignment"). */
  priority?: number;
  /**
   * Last tool the exited dispatch called (#591) — attributes an unverified exit
   * (`verify-incomplete`, and the terminal `unit-failed` reasons `agent-exited-unverified` /
   * `unverified-exit-at-strongest-tier`) to a concrete cause (e.g. `Monitor`) without opening
   * the transcript. Absent when the tool name could not be established at
   * all — the dispatch log yielded no `tool_use` block, OR it was
   * unreadable, OR the slot never spawned. The three are not distinguished:
   * the field is omitted rather than guessed.
   */
  last_tool?: string;
  /**
   * `stale-milestone-ignored` (#610): the ignored milestone's OWN timestamp.
   * The entry's `ts` (and `at`) is the time the ENGINE made the decision;
   * this is how old the milestone it ignored actually was. Declared here so
   * both emitters — `engine.ts`'s `journalStaleMilestoneIfIgnored` and
   * `batch-dispatch.ts`'s `reconcileMemberSlot` — get the same
   * excess-property check, and so `events.jsonl` consumers have one shape to
   * read rather than one per rail.
   */
  milestone_at?: string;
  /**
   * `unit-failed` (#596): what the open-PR ground-truth check concluded
   * before this unit was failed terminally — `none` (checked, no PR to
   * adopt), `unreachable` (`gh` failed; the unit may have shipped work
   * nobody owns now), `no-branch` (no branch was ever recorded to check), or
   * absent when the check does not apply (a stall, or a report slot).
   * Without it all four are the same `unit-failed` line, which is the
   * ambiguity that stranded imboard-monorepo#3999.
   */
  pr_check?: 'no-branch' | 'unreachable' | 'none';
  /**
   * `pr-parked` (#596): the branch the adopted PR was found on. `slot.branch`
   * is captured from whichever milestone first carried one and is not
   * re-derived between recovery redispatches, so without it "why is this
   * unit parked on PR N?" has nothing to correlate against.
   */
  branch?: string;
  /**
   * `pr-watch-failed` (#630), `ground-truth-unreachable` and
   * `pr-watch-waiting` (#632): the time the ENGINE made this decision.
   * Distinct from `milestone_at`, which is a foreign timestamp.
   */
  at?: string;
  /**
   * The deduped events above: ISO onset of the streak this entry reports.
   * `ticks_persisted` is a tick count, and both tick cadences are
   * operator-tunable, so this is the only field that answers "since when?"
   * off a single line without assuming an interval.
   */
  since?: string;
  /**
   * The deduped events above: how many consecutive ticks the streak has
   * persisted, counting the ticks the dedup suppressed. `1` on a streak's
   * onset entry, then a multiple of `JOURNAL_DEDUP_REANNOUNCE_TICKS` on each
   * re-announcement. Declared here — like `milestone_at` — so both emitters
   * get the same excess-property check and `events.jsonl` consumers have one
   * shape to read rather than one per rail.
   */
  ticks_persisted?: number;
  /**
   * `dispatch-failure` / `dispatch-unhealthy` (#629): the provider's own HTTP
   * status from a confirmed dispatch failure (e.g. `429`). Declared here so
   * BOTH emitters — `dispatch-health.ts`'s `recordDispatchApiError` and
   * `engine.ts`'s `enterRecovery` evidence — get the same excess-property
   * check (`dispatchApiErrorFields` in `dispatch-health.ts` builds this
   * object for both), rather than one hand-written shape per rail.
   */
  api_error_status?: number;
  /** `dispatch-failure` (#629): e.g. `"api_error"` — the provider's own terminal-reason field. */
  terminal_reason?: string;
  /** `dispatch-failure` / `dispatch-unhealthy` (#629): the provider's own rate-limit reset time, when it supplied one (AC4). */
  reset_at?: string;
  /** `dispatch-failure` (#629): `modelUsage` was present and empty — corroboration (AC5) that no tokens were spent, never the classification signal. */
  empty_model_usage?: boolean;
  /** `dispatch-failure` (#629): the result's own `is_error` flag — corroboration (AC5) only. */
  is_error?: boolean;
  /**
   * `fence-bound`/`fence-bind-failed`/`fence-released`/`fence-release-failed` and
   * `deferred-to-owner` (#683): the generation the record describes — the fence a bind
   * or release lands at, or the fence that made a dispatched agent defer.
   */
  fence_gen?: number;
  /**
   * `deferred-to-owner` (#683 AC3): the takeover label the deferring agent's fence
   * named, when the dispatch log carried it. The label is descriptive only — fence
   * ownership is run id + generation (#683 AC7) — so this exists for the human reading
   * `events.jsonl`, never for a decision.
   */
  fence_takeover?: string;
}
