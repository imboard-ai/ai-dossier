/**
 * The scheduler engine (#464): dispatch, completion verification, and the
 * stall/escalation ladder (RFC-0001 §C.1) — the deterministic organs that
 * replace fleet-cycle's LLM supervision. Since #468 it also owns the
 * detached-ship tail: the PR watcher, script-based teardown, and the
 * cheap-tier report dispatch.
 *
 * One `tick()` is a full reconcile+refill cycle:
 *
 * 1. **Poll** ground truth for every live unit and every parked PR OUTSIDE
 *    the state lock (gh/git subprocesses are slow; the lock must never wait
 *    on a network call). Parked PRs poll on their own cadence
 *    (`pr_poll_interval_ms`, persisted `last_pr_poll_at`) — every 2–3 min.
 *    Hard-block labels (#544) are re-read in the same outside-the-lock phase,
 *    every tick that has work and at most every 10 min on a tick that does
 *    not (persisted `last_label_poll_at`).
 * 2. **Apply** under `SchedStore.withLock`:
 *    - `assigned` slots (crash between assign and spawn) are spawned/re-attached
 *    - `running` slots: dead pid → exit rail; ground truth says complete →
 *      external advance (kill the leftover agent, complete); new milestone or
 *      pushed commit → progress; no progress for the in-flight phase's
 *      stall timeout (`stall_timeout_ms`, or a per-phase override —
 *      `implement` defaults to 90 min, #495) → redispatch one tier
 *      stronger (cap 2, then failed)
 *    - `exited`/`verifying` slots: the agent exited — completion is verified
 *      against ground truth, never assumed (AC2); an exit whose milestone is
 *      the ship phase's `awaiting-merge` (with `pr=`) is a VERIFIED park:
 *      entry → parked, slot released (a parked unit holds no slot — AC5); an
 *      unverified exit within `SUSPECT_DISPATCH_WINDOW_MS` of the slot's last
 *      progress is also `suspect-dispatch` (#505) — a quota/auth wall kills
 *      every unit near-instantly with zero progress, indistinguishable from a
 *      genuine crash except by this timing; `DISPATCH_UNHEALTHY_THRESHOLD`
 *      consecutive suspects from DIFFERENT units pauses new assignments
 *      (`dispatch-unhealthy`, cleared only by an operator's `sched resume`)
 *      without touching the per-unit ladder or any already-live slot
 *    - `parked` entries: the watcher applies the PR truth — merge accepted
 *      only when state MERGED AND mergedAt non-null AND the issue is closed
 *      (AC1) → shipped (gating on MERGE, never the park — AC4);
 *      CONFLICTING / closed-unmerged / auto-merge-blocked → failed + transitive
 *      dependents blocked (AC3)
 *    - failures block their TRANSITIVE dependents (AC4)
 *    - report agents are dispatched for merged units whose teardown is
 *      already recorded (before queue refill — cheap reports don't queue
 *      behind long runs)
 *    - **Refill** in the SAME lock pass: `computeAssignments` fills every
 *      freed slot — a runnable unit never waits while a slot is idle (AC5)
 * 3. **Teardown** (outside the lock — pool/git subprocesses are slow): for
 *    every freshly-merged unit, recover the setup milestone's worktree info
 *    and run pool return / worktree remove, VERIFIED before claimed
 *    (`cleanup=failed-<step>` on mismatch, AC2). Results land in a second
 *    short lock pass together with the report dispatch.
 * 4. **Batch pass** (#523, only when `batchExec`/`runBatchSuite` are both
 *    configured): `batch-dispatch.ts`'s `runBatchTick` — a self-contained
 *    reconcile+refill for every `batch:<id>` unit, run after steps 1-3. Step
 *    2's refill already reserved capacity for any ready batch that outranks
 *    a competing issue in `runnableUnits`' priority order (#565) — this pass
 *    never takes a slot an issue actually won.
 *

 * Everything that touches the world (processes, GitHub, git) is injected;
 * the state machine is pure. This file dispatches `issue:<n>` units only —
 * since #523, `tick()` also runs a second pass (`batch-dispatch.ts`'s
 * `runBatchTick`) that drives every `batch:<id>` unit (serial slot-cycle
 * members, the aggregate suite, the tail agent, the PR watch, the report
 * agent), merging its result into this tick's `TickResult`. That pass runs
 * only when `EngineDeps.batchExec`/`runBatchSuite` are both supplied — an
 * engine missing either never dispatches a `ready` batch (it stays queued).
 */

import { type DispatchApiError, parseDispatchApiError, parseLastToolUse } from '@ai-dossier/core';
import type { BatchDispatchDeps, BatchTickResult } from './batch-dispatch';
import { runBatchTick } from './batch-dispatch';
import {
  buildPrompt,
  buildReportPrompt,
  dispatchLogPath,
  escalateTier,
  fileSizeOrZero,
  journalCmdModelFields,
  type ResolvedDispatch,
  reportTierFor,
  resolveDispatch,
  resolveTierSpawn,
  type SpawnDeps,
  STOP_POLL_MAX_MS,
  STOP_POLL_MIN_MS,
  stallTimeoutForSlot,
  type TierSpawn,
} from './dispatch';
import {
  dispatchApiErrorDetail,
  dispatchApiErrorFields,
  recordDispatchApiError,
  resetDispatchApiErrorStreak,
} from './dispatch-health';
import type { RunFencer } from './fence';
import {
  type GroundTruth,
  type GroundTruthMilestone,
  isParkedMilestone,
  isVerifiedComplete,
  type PrTruth,
  prOfMilestone,
} from './groundtruth';
import { issueOfUnit, type Journal, unitEvent } from './journal';
import { labelBlockReason, labelOfBlockReason, pickHardBlockLabel } from './labels';
import type { SchedStore } from './persist';
import type { ExecFn } from './project';
import { DISPATCHABLE_ISSUE_STATUSES, runnableUnits } from './readiness';
import { buildSchedRunLogEntry, finalizeRunLogEntry, readDispatchLog } from './run-log';
import { assignToIdleSlot, computeAssignments, freeCapacity, setPaused } from './scheduler';
import {
  CLEARED_ENTRY_DEDUP_MARKERS,
  findEntry,
  isReportSlot,
  patchEntry,
  patchSlot,
  transitionIssue,
  transitionSlot,
} from './state';
import { runTeardown, type TeardownResult } from './teardown';
import {
  DISPATCH_UNHEALTHY_THRESHOLD,
  ESCALATION_CAP,
  JOURNAL_DEDUP_REANNOUNCE_TICKS,
  type JournalEventName,
  type ModelTier,
  type QueueEntry,
  type SchedConfig,
  type SchedState,
  type SlotEntry,
  type SlotReleaseReason,
  type SlotStatus,
  SUSPECT_DISPATCH_WINDOW_MS,
  TERMINAL_ISSUE_STATUSES,
} from './types';

export interface EngineDeps {
  store: SchedStore;
  journal: Journal;
  groundTruth: GroundTruth;
  spawnDeps: SpawnDeps;
  now: () => Date;
  /** Repo working directory — cwd for teardown subprocesses (#468). */
  repoDir: string;
  /** Exec for teardown scripts (#468); injectable so tests never touch git/npx. */
  teardownExec: ExecFn;
  /**
   * Writes the takeover record before a redispatch respawns (#504). Optional: an
   * engine constructed without one redispatches exactly as it did before fencing
   * existed, journaling `fence-failed` so the gap is visible rather than silent.
   */
  fencer?: RunFencer;
  /**
   * Home directory `runs.jsonl` telemetry (#524) is written under —
   * `<homeDir>/.dossier/runs.jsonl`, the same file `cli`'s `ai-dossier run`
   * writes to. Optional and defaults to `os.homedir()` (via
   * `appendSchedRunLog`'s own default) when absent — override ONLY for
   * tests, so they never touch the real machine's `~/.dossier`.
   */
  homeDir?: string;
  /**
   * Exec for batch git/milestone-CLI operations (#523) — worktree claim, member
   * commit-range recording, milestone posting, PR watch. Optional, and required
   * TOGETHER with `runBatchSuite`: the batch pass (`runBatchTick`) runs only
   * when BOTH are supplied — an engine missing either never dispatches a
   * `ready` batch at all (it stays queued, visible in `sched status`), rather
   * than half-driving a batch it could not validate.
   */
  batchExec?: BatchDispatchDeps['exec'];
  /**
   * Exec for batch-setup's cold-path warm-up install/build (#561), on its own
   * (longer) budget than `batchExec` — falls back to `batchExec` when not
   * supplied. Optional independently of `batchExec`/`runBatchSuite`.
   */
  batchWarmExec?: BatchDispatchDeps['warmExec'];
  /**
   * Runs the aggregate suite inside a batch worktree (#523) — the deterministic
   * gate between `executing` and `reviewing`. Optional; see `batchExec`'s doc
   * for the paired-requirement contract.
   */
  runBatchSuite?: BatchDispatchDeps['runSuite'];
  /**
   * Runs one `ai-dossier cap run <id>` in a batch worktree for the per-member
   * incremental gate (#523 AC2). Fully optional — independently of
   * `batchExec`/`runBatchSuite` — since it is itself a "when available" fast
   * path: without it the gate is simply skipped, exactly as if the repo had no
   * `.dossier/automation/` manifest.
   */
  runBatchCapability?: BatchDispatchDeps['runCapability'];
}

/** What one tick did — surfaced by `sched start`. */
export interface TickResult {
  /** Units spawned this tick (first dispatch or redispatch). */
  spawned: string[];
  /** Units completed by external ground truth while their agent was still alive. */
  externalAdvances: string[];
  /** Units verified complete after an observed exit. */
  completed: string[];
  /** Units whose agent exited having parked its PR (#468) — now watcher-owned. */
  parked: string[];
  /** Parked units whose merge was accepted this tick (#468). */
  mergeAccepted: string[];
  /** `failed reason=auto-merge-blocked` units reconciled to `shipped` this tick after a later merge (#501). */
  staleReconciled: string[];
  /** Dependents released from `blocked reason=dep-failed:<n>` this tick because `<n>` reconciled to `shipped` (#501). */
  dependentsUnblocked: string[];
  /** Report agents dispatched for merged units this tick (#468). */
  reportDispatched: string[];
  /** Merged units whose report could not dispatch — waiting for a free slot (#468). */
  reportWaiting: number;
  /** Units whose teardown was verified this tick (#468). */
  teardownDone: string[];
  /** Units whose teardown failed a step this tick (#468) — degradation, not unit failure. */
  teardownFailed: string[];
  /** Units redispatched one tier stronger (stall or unverified exit). */
  redispatched: string[];
  /**
   * Units that hit a failure rail. Full-cycle units end `failed`; MERGED
   * units also land here on merged-aware REPORT failures
   * (`report-escalation-cap` / report spawn-error), where the unit actually
   * completes (`done`, reason recorded) — the report failed, not the work.
   */
  failed: string[];
  /** Issues blocked transitively by a failure. */
  blocked: number[];
  /** Units returned to `queued` this tick because their hard-block label was removed (#544). */
  labelCleared: string[];
  /**
   * Units moved to `blocked` this tick by a hard-block label the engine
   * re-read (#544) — a dispatchable entry that gained one mid-wave, or a
   * blocked entry whose label changed under it.
   */
  labelBlocked: string[];
  /**
   * Units whose hard-block label read was UNREACHABLE this tick (#544). Not
   * cosmetic: an unverified dispatchable unit is deferred rather than
   * dispatched, so without this an operator sees a tick that did nothing and
   * no reason for it.
   */
  labelCheckFailed: string[];
}

function emptyResult(): TickResult {
  return {
    spawned: [],
    externalAdvances: [],
    completed: [],
    parked: [],
    mergeAccepted: [],
    staleReconciled: [],
    dependentsUnblocked: [],
    reportDispatched: [],
    reportWaiting: 0,
    teardownDone: [],
    teardownFailed: [],
    redispatched: [],
    failed: [],
    blocked: [],
    labelCleared: [],
    labelBlocked: [],
    labelCheckFailed: [],
  };
}

/** Ground-truth snapshot for one unit, gathered outside the lock. */
interface UnitTruth {
  /** False when the milestone poll FAILED (unreachable) — decisions that need truth pause (decision 2, option A). */
  reachable: boolean;
  milestone: GroundTruthMilestone | null;
  closed: boolean;
  head: string | null;
}

/** Parked-PR truths gathered outside the lock (#468). */
interface PrPoll {
  /** Whether a poll actually ran this tick (cadence due AND parked entries exist). */
  ran: boolean;
  /** PR truth per parked issue; `undefined` value = poll FAILED (unreachable). */
  truths: Map<number, PrTruth | undefined>;
  /** Issue-closed signal per parked issue (the merge-acceptance gate, AC1). */
  closed: Map<number, boolean>;
}

/**
 * Hard-block label truths gathered outside the lock (#544) — what
 * `reconcileLabelBlocks` decides on.
 */
interface LabelPoll {
  /** Whether a label read actually ran this tick (watch set non-empty AND not throttled). */
  ran: boolean;
  /**
   * Per watched issue: the label names it currently carries (`[]` = verifiably
   * none), or `undefined` when the read FAILED (unreachable). The `[]`/
   * `undefined` split is the whole safety property — `[]` can unblock a unit,
   * `undefined` must decide nothing.
   *
   * The raw names are carried rather than a pre-picked hard-block label
   * because the two questions the reconcile asks are different: "does this
   * entry's OWN block label still exist on the issue?" (any label name —
   * `enqueue`'s `blocked_label` accepts more than the four) versus "has a
   * dispatchable entry gained one of the four?".
   */
  labels: Map<number, string[] | undefined>;
}

interface TickCtx {
  deps: EngineDeps;
  dispatch: ResolvedDispatch;
  result: TickResult;
}

function journal(
  ctx: TickCtx,
  event: JournalEventName,
  unit: string,
  extra: Record<string, unknown> = {}
): void {
  ctx.deps.journal.append(unitEvent(event, unit, extra), ctx.deps.now());
}

function slotOf(state: SchedState, unit: string): SlotEntry | undefined {
  return state.slots.find((s) => s.unit === unit);
}

/**
 * Milliseconds since a slot's last known progress, for both the stall timer
 * (AC4) and the suspect-dispatch check (#505) — a single fallback
 * convention for the whole file: a null `last_progress_at` reads as
 * maximally stale (epoch 0), never as "just now", so an unreachable-in-
 * practice null (see `spawnAndRecord`/`assignToIdleSlot`, which always
 * stamp it) degrades toward "recover/not-suspect" rather than silently
 * forcing the opposite verdict.
 */
function msSinceLastProgress(slot: SlotEntry, now: Date): number {
  return now.getTime() - (slot.last_progress_at ? Date.parse(slot.last_progress_at) : 0);
}

/**
 * Walk a slot to `idle` one declared edge per iteration; `step` picks the
 * next status. Returns the released slot id — non-null only when the walk
 * actually emptied a held slot, never for a slot that was already idle or
 * held no unit. Journals nothing itself (#525): each caller journals its own
 * cause event first, then `slot-released`, so the trail reads cause-then-
 * release rather than the reverse.
 *
 * Bounded at 8 iterations — mirroring `batch-dispatch.ts`'s `releaseSlot` —
 * though the longest real walk (`running` → `exited` → `verifying` →
 * `complete` → `idle`, or `recovering` → `failed` → `idle`) is 4 hops. A
 * non-converging `step` leaves the slot on whatever status it last reached
 * rather than spinning forever inside the state lock; `releasedSlotId` stays
 * null in that case, so no `slot-released` is journaled for a release that
 * did not actually happen.
 */
function walkSlotToIdle(
  state: SchedState,
  unit: string,
  now: Date,
  step: (status: SlotStatus) => SlotStatus
): { state: SchedState; releasedSlotId: number | null } {
  let next = state;
  let slot = slotOf(next, unit);
  if (!slot || slot.status === 'idle') return { state: next, releasedSlotId: null };
  const slotId = slot.id;
  // Look the slot back up by id, not by `unit`, on every iteration: the
  // `idle` transition clears `unit` (CLEARED_SLOT_FIELDS), so `slotOf(next,
  // unit)` can no longer find it the instant it actually empties.
  for (let i = 0; i < 8 && slot && slot.status !== 'idle'; i++) {
    next = transitionSlot(next, slot.id, step(slot.status), {}, now);
    slot = next.slots.find((s) => s.id === slotId);
  }
  return { state: next, releasedSlotId: slot?.status === 'idle' ? slotId : null };
}

/**
 * Journal `slot-released` (#525) when `walkSlotToIdle` actually freed a
 * slot. Callers invoke this AFTER journaling their own cause event, so the
 * trail reads cause-then-release, never the reverse.
 */
function journalSlotReleased(
  ctx: TickCtx,
  unit: string,
  releasedSlotId: number | null,
  reason: SlotReleaseReason
): void {
  if (releasedSlotId !== null) {
    journal(ctx, 'slot-released', unit, { slot: releasedSlotId, reason });
  }
}

/** Kill the agent holding `unit`'s slot, if it is alive. */
function killUnitAgent(ctx: TickCtx, state: SchedState, unit: string): void {
  const slot = slotOf(state, unit);
  if (
    slot &&
    slot.pid !== null &&
    ctx.deps.spawnDeps.isAlive(slot.pid, slot.pid_start ?? undefined)
  ) {
    ctx.deps.spawnDeps.kill(slot.pid, slot.pid_start ?? undefined);
  }
}

// --- Poll (outside the lock) ---

function pollUnits(deps: EngineDeps, state: SchedState): Map<string, UnitTruth> {
  const out = new Map<string, UnitTruth>();
  for (const slot of state.slots) {
    if (slot.unit === null) continue;
    if (slot.status !== 'running' && slot.status !== 'verifying' && slot.status !== 'exited') {
      continue;
    }
    const issue = issueOfUnit(slot.unit);
    if (issue === null || out.has(slot.unit)) continue;
    const milestone = deps.groundTruth.latestMilestone(issue);
    out.set(slot.unit, {
      reachable: milestone !== undefined,
      milestone: milestone ?? null,
      closed: deps.groundTruth.issueClosed(issue),
      head: slot.branch !== null ? deps.groundTruth.branchHead(slot.branch) : null,
    });
  }
  return out;
}

/**
 * The `QueueEntry.reason` written when the watcher sees the `auto-merge-blocked`
 * label (#468 AC3) — the ONLY reason #501's stale-failure reconcile is
 * eligible for. Written in `reconcileParked`, read by `pollParkedPrs` and
 * `reconcileStaleFailedParks`; conceptually distinct from (but happens to
 * share the string with) the GitHub label name matched in
 * `groundtruth.ts`'s `parsePrViewJson`.
 */
const AUTO_MERGE_BLOCKED_REASON = 'auto-merge-blocked';

/**
 * #501: how long after a unit fails `auto-merge-blocked` its PR stays
 * watched for a late operator re-queue + merge. `failed` entries are never
 * pruned from `state.entries`, and each watched entry costs its own
 * `gh pr view` + `gh issue view` per poll — past this window an abandoned
 * entry is left as a plain terminal failure rather than polled forever.
 */
const STALE_RECONCILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * #501: a `failed` entry a later merge can still reconcile — the single
 * definition shared by the poll set (`pollParkedPrs`) and the reconcile set
 * (`reconcileStaleFailedParks`, including its mid-loop re-check). Duplicating
 * this predicate is exactly how a poll set and a reconcile set can silently
 * drift out of sync.
 */
function isStaleFailedPark(e: QueueEntry, nowMs: number): e is QueueEntry & { pr: number } {
  return (
    e.status === 'failed' &&
    e.reason === AUTO_MERGE_BLOCKED_REASON &&
    e.pr !== null &&
    nowMs - Date.parse(e.updated_at) < STALE_RECONCILE_WINDOW_MS
  );
}

/**
 * RFC-0001 §E.4 / #468 AC1's merged half: MERGED with a real merge
 * timestamp. The issue-closed half is checked separately by callers that
 * need to distinguish "merged, not yet closed" (journaled as
 * `pr-watch-waiting`) from "not merged at all".
 */
function isPrMerged(truth: PrTruth): truth is PrTruth & { mergedAt: string } {
  return truth.state === 'MERGED' && truth.mergedAt !== null;
}

/**
 * Poll parked PRs on their own cadence (#468 AC1 — every 2–3 min, persisted
 * `last_pr_poll_at` so a restart honors it). Runs only when parked entries
 * exist AND the interval elapsed; every subprocess stays outside the lock.
 * The issue-closed signal rides along — it is the second half of the
 * merge-acceptance gate and must not be re-queried under the lock.
 *
 * #501: also polls `failed reason=auto-merge-blocked` entries — a unit an
 * operator may have manually re-queued and merged after the engine already
 * marked it terminal. Piggybacking this poll (rather than a second cadence)
 * means `reconcileStaleFailedParks` needs no separate scheduling — it still
 * costs the usual `gh pr view`/`gh issue view` pair per watched entry.
 */
function pollParkedPrs(deps: EngineDeps, state: SchedState, dispatch: ResolvedDispatch): PrPoll {
  const nowMs = deps.now().getTime();
  const watchable = state.entries.filter(
    (e): e is QueueEntry & { pr: number } =>
      (e.status === 'parked' && e.pr !== null) || isStaleFailedPark(e, nowMs)
  );
  if (watchable.length === 0) return { ran: false, truths: new Map(), closed: new Map() };

  const last = state.last_pr_poll_at !== null ? Date.parse(state.last_pr_poll_at) : 0;
  if (Number.isFinite(last) && nowMs - last < dispatch.prPollIntervalMs) {
    return { ran: false, truths: new Map(), closed: new Map() };
  }

  const truths = new Map<number, PrTruth | undefined>();
  const closed = new Map<number, boolean>();
  for (const entry of watchable) {
    truths.set(entry.issue, deps.groundTruth.prState(entry.pr));
    closed.set(entry.issue, deps.groundTruth.issueClosed(entry.issue));
  }
  return { ran: true, truths, closed };
}

/**
 * Re-read hard-block labels outside the lock (#544), mirroring
 * `pollParkedPrs`' shape (cadence check, `ran: false` early return, every
 * subprocess outside the lock).
 *
 * The watch set is deliberately two-sided, because the bug is two-sided:
 *
 * - Entries `blocked` with a `label:<name>` reason — #507's enqueue screen
 *   ran ONCE, in the CLI, so without this read a decision resolved by a human
 *   never reaches the queue and `sched status` keeps printing a stale reason.
 * - The runnable ISSUE units a dispatch could actually place this tick, which
 *   is where AC2's "a fresh human hand-off is never dispatched over" bites.
 *
 * The second half is capped at `max_slots` — the hard ceiling on how many
 * units `computeAssignments` can place in one tick — so the per-tick `gh`
 * cost is bounded by the SLOT count, not by the backlog. Capping is only safe
 * because `dispatchAssignments` refuses to place an issue this poll did not
 * confirm clean: without that gate, blocking the first candidate would slide
 * an unread one into range. `state.paused` short-circuits the half entirely —
 * a paused fleet dispatches nothing, so reading its backlog every tick would
 * burn quota to learn nothing (and dispatch-health pauses fire precisely when
 * `gh` is already walled).
 */
function pollLabels(
  deps: EngineDeps,
  state: SchedState,
  config: SchedConfig,
  dispatch: ResolvedDispatch
): LabelPoll {
  const watched = new Set<number>();
  for (const entry of state.entries) {
    if (entry.status === 'blocked' && labelOfBlockReason(entry.reason) !== null) {
      watched.add(entry.issue);
    }
  }
  const held = new Set(state.slots.map((slot) => slot.unit).filter((u): u is string => u !== null));
  const dispatchable = state.paused
    ? []
    : runnableUnits(state)
        .filter((unit): unit is { kind: 'issue'; issue: number } => unit.kind === 'issue')
        .filter((unit) => !held.has(`issue:${unit.issue}`))
        .slice(0, config.max_slots);
  for (const unit of dispatchable) watched.add(unit.issue);
  if (watched.size === 0) return { ran: false, labels: new Map() };

  // "Nothing else to do" (AC3) = no live slot to reconcile AND nothing to
  // dispatch. A fleet in that shape is waiting on a human, so a re-read every
  // `label_poll_interval_ms` (10 min default) is responsive enough; anything
  // busier re-reads every tick.
  const nowMs = deps.now().getTime();
  const idle = !state.slots.some((slot) => slot.status !== 'idle') && dispatchable.length === 0;
  if (idle) {
    const last = state.last_label_poll_at !== null ? Date.parse(state.last_label_poll_at) : 0;
    if (Number.isFinite(last) && nowMs - last < dispatch.labelPollIntervalMs) {
      return { ran: false, labels: new Map() };
    }
  }

  const labels = new Map<number, string[] | undefined>();
  for (const issue of watched) labels.set(issue, deps.groundTruth.issueLabels(issue));
  return { ran: true, labels };
}

/**
 * Issues this tick's read CONFIRMED carry no hard-block label (#544) — the
 * only issues `dispatchAssignments` may place. A failed read is absent here,
 * as is an issue that was never watched: both mean "not confirmed", and
 * confirmation is the gate.
 */
function labelVerified(poll: LabelPoll): Set<number> {
  const verified = new Set<number>();
  for (const [issue, labels] of poll.labels) {
    if (labels !== undefined && pickHardBlockLabel(labels) === null) verified.add(issue);
  }
  return verified;
}

/**
 * Apply this tick's label read (#544) — the reconcile half of the fix, run
 * immediately before `dispatchAssignments` so both directions land in the
 * SAME tick they were observed in:
 *
 * - blocked by a label that is now gone from the issue → `queued`, `reason`
 *   cleared, `label-cleared` journaled; normal dependency gating takes over
 *   from there, and a free slot picks it up later this same tick. The test is
 *   the entry's OWN label name against the fetched list, not
 *   `pickHardBlockLabel`: `enqueue` accepts any GitHub label name as
 *   `blocked_label`, so a list-based test would report "label cleared" — an
 *   affirmative "a human resolved this" signal — for a block whose label is
 *   still sitting on the issue, merely outside the four.
 * - blocked by a label that CHANGED (`decision-pending` → `epic`) → reason
 *   refreshed in place, old value preserved as `previous_reason`. `sched
 *   status` printing a reason that no longer matches the issue is the same
 *   defect as never unblocking at all.
 * - dispatchable and now carrying a hard-block label → `blocked`, so the
 *   dispatch pass below can no longer see it (`runnableUnits` gates on
 *   `DISPATCHABLE_ISSUE_STATUSES`, which excludes `blocked`).
 * - unreachable read → `label-check-failed` and NOTHING else. An unreachable
 *   poll can never be evidence that a hand-off was resolved. It is surfaced in
 *   `TickResult.labelCheckFailed` rather than left journal-only, because the
 *   failure is silent in the other direction too: an unread dispatchable entry
 *   is simply not verified, so it defers instead of dispatching, and an
 *   operator watching `sched start` needs to see why nothing moved.
 */
function reconcileLabelBlocks(ctx: TickCtx, state: SchedState, poll: LabelPoll): SchedState {
  if (!poll.ran) return state;
  const now = ctx.deps.now();
  // Only stamp the cadence when something was actually LEARNED. Stamping on a
  // total failure would make `sched status` report "labels last checked 30s
  // ago" during a gh outage — asserting the very thing the timestamp exists to
  // distinguish — and would burn a full throttle window on an idle fleet.
  const learned = [...poll.labels.values()].some((labels) => labels !== undefined);
  let next: SchedState = learned ? { ...state, last_label_poll_at: now.toISOString() } : state;

  /** Block `issue` on `label`, journaling and recording it exactly once. */
  const blockOn = (
    from: SchedState,
    issue: number,
    unit: string,
    label: string,
    previous: string | null
  ): SchedState => {
    const reason = labelBlockReason(label);
    journal(ctx, 'label-blocked', unit, {
      reason,
      ...(previous !== null ? { previous_reason: labelBlockReason(previous) } : {}),
    });
    ctx.result.labelBlocked.push(unit);
    return transitionIssue(from, issue, 'blocked', { reason }, now);
  };

  for (const [issue, labels] of poll.labels) {
    const entry = findEntry(next, issue);
    if (entry === undefined) continue; // left the queue between the poll and the lock
    const unit = `issue:${issue}`;

    if (labels === undefined) {
      journal(ctx, 'label-check-failed', unit, { reason: 'unreachable' });
      ctx.result.labelCheckFailed.push(unit);
      continue;
    }

    const blockedBy = entry.status === 'blocked' ? labelOfBlockReason(entry.reason) : null;
    if (blockedBy !== null) {
      // Two questions, deliberately separate. "Is this entry's OWN block label
      // still on the issue?" is answered against the fetched names, because
      // `enqueue` accepts any GitHub label name as `blocked_label` — a
      // policy-list test would report "label cleared" (an affirmative "a human
      // resolved this") for a block whose label is still sitting on the issue,
      // merely outside the four. "Is the issue blocked AT ALL?" is the policy
      // question, and it is what decides whether clearing is safe: dropping the
      // block because `decision-pending` went away, while `epic` remains, would
      // dispatch over the second hand-off.
      const ownStillPresent = labels.some((name) => name.toLowerCase() === blockedBy.toLowerCase());
      const current = pickHardBlockLabel(labels);
      if (!ownStillPresent && current === null) {
        // #633: an unblocked entry is a fresh attempt too — see
        // `requeueOrphanedDispatches`.
        next = transitionIssue(
          next,
          issue,
          'queued',
          { reason: null, ...CLEARED_ENTRY_DEDUP_MARKERS },
          now
        );
        journal(ctx, 'label-cleared', unit, { reason: labelBlockReason(blockedBy) });
        ctx.result.labelCleared.push(unit);
      } else if (current !== null && current !== blockedBy) {
        // Still blocked, but by a different label than the reason records —
        // relabelled, or a higher-priority label added. A `sched status`
        // reason that no longer matches the issue is the same defect as never
        // unblocking at all.
        next = blockOn(next, issue, unit, current, blockedBy);
      }
      continue;
    }

    // Not label-blocked today. Only a dispatchable entry can be blocked from
    // here: a `dispatched`/`parked`/`shipped` unit is already past the point
    // where a hand-off label could stop it, and blocking it mid-flight would
    // abandon a live agent's work. Defence in depth rather than a hot path —
    // the watch set holds only label-blocked and runnable entries — but the
    // poll runs outside the lock, so any of them can have moved on by now.
    const gained = pickHardBlockLabel(labels);
    if (gained !== null && DISPATCHABLE_ISSUE_STATUSES.has(entry.status)) {
      next = blockOn(next, issue, unit, gained, null);
    }
  }

  return next;
}

// --- Spawn / fail / complete / park ---

/**
 * The shared spawn-and-record tail of every agent dispatch (#464 full-cycle,
 * #468 report): log file, try-spawn (a throw fails the unit through the
 * declared failure rail — visible in `sched status`, never a tick abort),
 * pid/phase/progress patch, the `assigned|recovering → running` transition,
 * and the `spawned` journal event. `spawnUnit`/`spawnReportAgent` differ only
 * in tier, prompt, phase, and failure opts.
 */
function spawnAndRecord(
  ctx: TickCtx,
  state: SchedState,
  unit: string,
  slot: SlotEntry,
  opts: {
    tier: ModelTier;
    spawn: TierSpawn;
    prompt: string;
    phase: string;
    failOpts?: { merged?: boolean };
    journalExtra?: Record<string, unknown>;
  }
): SchedState {
  const logFile = dispatchLogPath(ctx.deps.store.runsDir, unit);
  // #524: the log is per-unit and opened in append mode (createSpawnDeps), so
  // a redispatch's output lands after any prior dispatch's in the SAME file.
  // Captured BEFORE spawning — the size at this instant is exactly where
  // THIS dispatch's own output will start.
  const logOffset = fileSizeOrZero(logFile);

  let pid: number;
  try {
    pid = ctx.deps.spawnDeps.spawn(opts.spawn.cmd, opts.prompt, logFile);
  } catch (err) {
    return failUnit(ctx, state, unit, `spawn-error: ${(err as Error).message}`, opts.failOpts);
  }

  const now = ctx.deps.now();
  const patch = {
    pid,
    pid_start: ctx.deps.spawnDeps.processStart(pid),
    phase: opts.phase,
    last_progress_at: now.toISOString(),
    // #524: distinct from last_progress_at, which later progress signals
    // overwrite — this is the one field that answers "when did THIS dispatch
    // start", the anchor `runs.jsonl`'s duration_ms is measured from.
    spawned_at: now.toISOString(),
    log_offset_at_spawn: logOffset,
  };
  const next =
    slot.status === 'assigned' || slot.status === 'recovering'
      ? transitionSlot(state, slot.id, 'running', patch, now)
      : patchSlot(state, slot.id, patch, now);

  journal(ctx, 'spawned', unit, {
    pid,
    tier: opts.tier,
    slot: slot.id,
    ...journalCmdModelFields(opts.spawn),
    log: logFile,
    // #524: which byte of the append-mode per-unit log this dispatch starts
    // at — without it, mapping a log slice to this dispatch needs state.json,
    // and `CLEARED_SLOT_FIELDS` nulls the field when the slot is released.
    log_offset: logOffset,
    ...(opts.journalExtra ?? {}),
  });
  ctx.result.spawned.push(unit);
  return next;
}

/** Spawn (or respawn) the agent for `unit` and move its slot to `running`. */
function spawnUnit(ctx: TickCtx, state: SchedState, unit: string): SchedState {
  const issue = issueOfUnit(unit);
  if (issue === null) return state;
  const entry = findEntry(state, issue);
  const slot = slotOf(state, unit);
  if (
    !entry ||
    !slot ||
    slot.status === 'idle' ||
    slot.status === 'complete' ||
    slot.status === 'failed'
  ) {
    return state;
  }
  // Report slots (crash recovery, ladder redispatch) respawn as report agents
  // — keyed off `role`, not `phase` (#500: `phase` can drift back to the
  // issue's pre-report milestone while the slot is still a report agent).
  if (isReportSlot(slot)) {
    return spawnReportAgent(ctx, state, unit);
  }

  return spawnAndRecord(ctx, state, unit, slot, {
    tier: entry.tier,
    spawn: resolveTierSpawn(ctx.dispatch, entry.tier, issue),
    // The slot's generation reaches the agent here (#504): a takeover is told which
    // generation it owns, so its own `runstate post --gen` is accepted while the run it
    // replaced is refused. A first dispatch is generation 0 and reads as it always did.
    // The tier's own resolved prompt (#527) — falls back to the global
    // dispatch.prompt when the tier has no override.
    prompt: buildPrompt(ctx.dispatch.tiers[entry.tier].prompt, issue, slot.gen),
    phase: 'gate',
    ...(slot.gen > 0 ? { journalExtra: { detail: `takeover gen=${slot.gen}` } } : {}),
  });
}

/**
 * Spawn the report agent for a merged unit (#468 AC2 — "a cheap-tier report
 * agent is dispatched", never a full-cycle tail run). The tier climbs the
 * ladder from mechanical across redispatches (`reportTierFor`).
 */
function spawnReportAgent(ctx: TickCtx, state: SchedState, unit: string): SchedState {
  const issue = issueOfUnit(unit);
  if (issue === null) return state;
  const entry = findEntry(state, issue);
  const slot = slotOf(state, unit);
  if (!entry || !slot || entry.pr === null || entry.cleanup === null) return state;
  const tier = reportTierFor(slot.recoveries);
  if (tier === null) return state;

  return spawnAndRecord(ctx, state, unit, slot, {
    tier,
    spawn: resolveTierSpawn(ctx.dispatch, tier, issue),
    // Report agents use the dedicated report-prompt template (`{pr}`/`{cleanup}`
    // placeholders), never a tier's `prompt` override — that override's fallback
    // chain is the cycle-agent prompt (a different template family), so wiring
    // it here would silently substitute the wrong placeholders.
    // The generation reaches the report agent exactly as it reaches a cycle agent
    // (#504): a report slot is fenced by the same ladder, and a report agent that did
    // not know its generation would have its `report done` milestone refused by the
    // CLI — recovering forever on a PR that already merged.
    prompt: buildReportPrompt(ctx.dispatch.reportPrompt, issue, entry.pr, entry.cleanup, slot.gen),
    phase: 'report',
    // Merged-aware: the PR is merged — a report spawn failure never blocks
    // dependents (gating already released at `shipped`).
    failOpts: { merged: true },
    journalExtra: {
      detail: slot.gen > 0 ? `report agent, takeover gen=${slot.gen}` : 'report agent',
    },
  });
}

/**
 * Fail a unit: entry → failed, slot released, transitive dependents blocked
 * (AC4). `merged: true` (report-agent failures on a merged unit, #468) is the
 * merged-aware rail: the PR is merged, so the unit COMPLETES (done, reason
 * recorded) instead of failing — a failed report never fails shipped work and
 * never blocks dependents whose dependency actually merged.
 */
function failUnit(
  ctx: TickCtx,
  state: SchedState,
  unit: string,
  reason: string,
  opts: { merged?: boolean; extra?: Record<string, unknown> } = {}
): SchedState {
  const issue = issueOfUnit(unit);
  if (issue === null) return state;
  const now = ctx.deps.now();

  killUnitAgent(ctx, state, unit);
  const released = releaseSlotViaFailure(state, unit, now);
  let next = released.state;
  let releaseReason: SlotReleaseReason = 'unit-failed';

  const entry = findEntry(next, issue);
  if (entry && !TERMINAL_ISSUE_STATUSES.has(entry.status)) {
    ctx.result.failed.push(unit);
    if (opts.merged === true && entry.status === 'shipped') {
      next = transitionIssue(next, issue, 'done', { reason }, now);
      journal(ctx, 'report-failed', unit, { reason, ...opts.extra });
      releaseReason = 'report-failed';
    } else {
      next = transitionIssue(next, issue, 'failed', { reason }, now);
      journal(ctx, 'unit-failed', unit, { reason, ...opts.extra });
      const blocked = blockTransitiveDependents(ctx, next, issue);
      next = blocked.state;
      ctx.result.blocked.push(...blocked.issues);
    }
  }
  journalSlotReleased(ctx, unit, released.releasedSlotId, releaseReason);
  return next;
}

/** Release a unit's slot to idle through the failure rail (failed → idle). */
function releaseSlotViaFailure(
  state: SchedState,
  unit: string,
  now: Date
): { state: SchedState; releasedSlotId: number | null } {
  return walkSlotToIdle(state, unit, now, (status) =>
    status === 'complete' || status === 'failed' ? 'idle' : 'failed'
  );
}

/** Block every entry that transitively depends on `failedIssue` (AC4). */
function blockTransitiveDependents(
  ctx: TickCtx,
  state: SchedState,
  failedIssue: number
): { state: SchedState; issues: number[] } {
  const now = ctx.deps.now();
  const reason = `dep-failed:${failedIssue}`;

  // BFS over reversed dependency edges: who depends on the failed issue,
  // directly or through another to-be-blocked entry?
  const queue: number[] = [failedIssue];
  const seen = new Set<number>([failedIssue]);
  const dependents: number[] = [];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const entry of state.entries) {
      if (seen.has(entry.issue) || !entry.deps.includes(current)) continue;
      seen.add(entry.issue);
      queue.push(entry.issue);
      dependents.push(entry.issue);
    }
  }

  const blockedIssues: number[] = [];
  let next = state;
  for (const issue of dependents) {
    const entry = findEntry(next, issue);
    if (!entry) continue;
    // Terminal/satisfied entries keep their outcome; already-blocked entries
    // keep their (possibly more specific) reason.
    if (
      TERMINAL_ISSUE_STATUSES.has(entry.status) ||
      entry.status === 'blocked' ||
      entry.status === 'shipped' ||
      entry.status === 'shipped-in-batch'
    ) {
      continue;
    }

    // A dependent mid-run is working toward a doomed merge — release its slot.
    const unit = `issue:${issue}`;
    const slot = slotOf(next, unit);
    killUnitAgent(ctx, next, unit);
    // #524: this agent was live and never recorded — same reasoning as the
    // stall/external-advance kills. Runs BEFORE the release, since
    // `recordDispatchRunLog`'s guard requires the slot still be `running`.
    if (slot) recordDispatchRunLog(ctx, next, slot, unit);
    const released = releaseSlotViaFailure(next, unit, now);
    next = released.state;

    next = transitionIssue(next, issue, 'blocked', { reason }, now);
    journal(ctx, 'dependents-blocked', unit, { reason });
    journalSlotReleased(ctx, unit, released.releasedSlotId, 'dependents-blocked');
    blockedIssues.push(issue);
  }
  return { state: next, issues: blockedIssues };
}

/**
 * A run id, and the issue it must belong to.
 *
 * The run id comes off the milestone trail — issue comments, i.e. network data — so a
 * forged comment could otherwise aim the fence at a well-formed run id for some other
 * issue. That is WORSE than not fencing: the CLI would accept it, the engine would
 * journal `fence-written`, and the real zombie would stay free to write.
 */
const RUN_ID_FOR_ISSUE_RE = /^r-(\d+)-[0-9a-f]{4,}$/;

/** A phase name safe to hand to the CLI, matching the milestone grammar's shape. */
const PHASE_TOKEN_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Post the takeover record for a unit about to be redispatched (#504 AC1), returning the
 * generation the fence installed — or null when no fence could be written.
 *
 * Every null is journaled as `fence-failed` WITH its cause, and every one is DEGRADED
 * rather than fatal:
 *
 * - **No fencer configured.** An engine built before #504, or misconfigured.
 * - **No usable run id.** The run id lives on the trail, so a unit that has posted no
 *   milestone has nothing to fence — and an agent that has written nothing has also
 *   written nothing to race over. A run id that does not belong to THIS issue is
 *   rejected for the reason above.
 * - **The post failed.** gh auth, a missing binary, a network wall — the fencer's own
 *   reason says which.
 *
 * The redispatch proceeds either way. Refusing to redispatch would strand a stalled unit
 * forever, which is a worse and more common failure than the race a fence prevents; the
 * journal line is what makes the unprotected redispatch visible afterwards.
 */
function writeFence(
  ctx: TickCtx,
  unit: string,
  issue: number,
  slot: SlotEntry,
  truth: UnitTruth
): number | null {
  const failed = (detail: string): null => {
    journal(ctx, 'fence-failed', unit, { slot: slot.id, detail });
    return null;
  };

  if (ctx.deps.fencer === undefined) {
    return failed('no fencer configured — redispatching unfenced');
  }

  const run = truth.milestone?.run ?? '';
  if (run === '') {
    return failed('no run id on the trail to fence — redispatching unfenced');
  }
  const owner = RUN_ID_FOR_ISSUE_RE.exec(run);
  if (owner === null || Number(owner[1]) !== issue) {
    return failed(
      `trail run id '${run}' is not a run id for issue #${issue} — redispatching unfenced`
    );
  }

  // The phase the superseded agent was IN, as its own last milestone recorded it — the
  // fence names where the work was taken over, not where it will resume. A value that is
  // not a plain phase token would just be rejected by the CLI, so the slot's own record
  // is preferred over spending the attempt on it.
  const claimed = truth.milestone?.phase ?? '';
  const phase = PHASE_TOKEN_RE.test(claimed) ? claimed : (slot.phase ?? 'gate');
  const takeover = `slot-${slot.id}-r${slot.recoveries + 1}`;

  const outcome = ctx.deps.fencer(issue, run, phase, takeover);
  if (!outcome.ok) {
    return failed(`${outcome.reason} — redispatching at gen=${slot.gen}`);
  }

  journal(ctx, 'fence-written', unit, {
    slot: slot.id,
    detail: `${run} gen=${outcome.gen} takeover=${takeover}`,
  });
  return outcome.gen;
}

/**
 * The end of the ladder: the unit has no stronger tier left, so it fails —
 * UNLESS ground truth says its branch already carries an open PR the
 * milestone trail never recorded (#596), in which case it parks and the
 * watcher owns it. Extracted from `enterRecovery` so the terminal decision,
 * which now has four distinct outcomes, is readable on its own.
 *
 * Fails closed (AC5): a report slot (no branch of its own — AC7), a stall
 * (a hung agent never had the chance to open anything), an unknown branch,
 * or an unreachable lookup all take the terminal path. Only a confirmed open
 * PR number parks (AC4). Which of those four it was is journaled as
 * `pr_check`, because "we checked and there was none" and "`gh` was down and
 * we failed a unit whose PR may have been mergeable" are the same
 * `unit-failed` line otherwise — and that indistinguishability is exactly
 * what cost imboard-monorepo#3999 (docs/agent-traps.md).
 */
function failOrAdoptOpenPr(
  ctx: TickCtx,
  state: SchedState,
  unit: string,
  slot: SlotEntry,
  report: boolean,
  // #629: never `'dispatch-failure'` in practice — `enterRecovery` only
  // reaches this function under `escalate: true` (its cap-check is itself
  // gated on `escalate`), and a `dispatch-failure` cause always passes
  // `escalate: false`. Kept as the two-member union `enterRecovery` uses
  // before its escalate check, so a maintainer reading this signature does
  // not read "a spend wall can terminally fail a unit" as a live path.
  causeEvent: 'stalled' | 'verify-incomplete',
  cause: string,
  evidence: Record<string, unknown>
): SchedState {
  let prCheck: 'skipped' | 'no-branch' | 'unreachable' | 'none' = 'skipped';
  if (!report && causeEvent === 'verify-incomplete') {
    if (slot.branch === null) {
      prCheck = 'no-branch';
    } else {
      const openPr = ctx.deps.groundTruth.openPrForBranch(slot.branch);
      if (typeof openPr === 'number') {
        // A unit that demonstrably opened a PR is proof this dispatch was
        // healthy, whatever its exit looked like — reset the suspect streak
        // exactly like the milestone-verified park in `completeUnitOrRecover`
        // (#505), or a rescued unit still counts toward a false-positive
        // `dispatch-unhealthy` pause. `completeUnitOrRecover` has already
        // journaled this tick's `suspect-dispatch`; the reset following it is
        // the correct record of a classification made on incomplete evidence
        // and then retracted.
        return parkUnit(ctx, recordDispatchOutcome(ctx, state, unit, slot, false), unit, openPr, {
          detail: 'unverified-exit-recovered-open-pr',
          branch: slot.branch,
        });
      }
      prCheck = openPr === undefined ? 'unreachable' : 'none';
      // #632: confirmed NOT one of the per-tick re-emit sites — this
      // function always ends by either parking the unit (the branch above)
      // or falling through to the unconditional `failUnit` below, so the
      // unit is terminal (or parked) by the time this call returns. There is
      // no "next tick" on which the SAME dispatch reaches this check again,
      // so no dedup marker is needed here; the line fires exactly once, on
      // the one terminal decision it accompanies.
      if (prCheck === 'unreachable') {
        journal(ctx, 'ground-truth-unreachable', unit, {
          slot: slot.id,
          detail: `open-PR check for branch ${slot.branch} unreachable — failing closed; re-check with \`gh pr list --head ${slot.branch} --state open\` before writing this unit off`,
        });
      }
    }
  }

  // Cap reached (2 escalations) or already at the strongest tier — the
  // designed signal that a human, not a stronger model, is next.
  const reason = report
    ? 'report-escalation-cap'
    : slot.recoveries >= ESCALATION_CAP
      ? 'escalation-cap'
      : `${cause}-at-strongest-tier`;
  // #591/#620: surface `last_tool` on the terminal `unit-failed` journal
  // entry too — the `evidence` object already carries it for the non-terminal
  // `verify-incomplete` journal event, because BOTH rails that reach here
  // with `causeEvent === 'verify-incomplete'` thread it through
  // `completeUnitOrRecover`: `reconcileRunning`'s dead-pid rail, from
  // `recordDispatchRunLog`'s own read, and (since #620) `reconcileSlots`'
  // `exited`/`verifying` rail, from `readDispatchSignalsForSlot`. The two agree —
  // the dispatch log is static once the agent has exited — so the tool name
  // survives regardless of which tick reaches this decision. It stays
  // OPTIONAL: a slice with no parseable `tool_use` yields null, hence the
  // guard below.
  const extra = {
    ...(typeof evidence.last_tool === 'string' ? { last_tool: evidence.last_tool } : {}),
    ...(prCheck !== 'skipped' ? { pr_check: prCheck } : {}),
  };
  return failUnit(ctx, state, unit, reason, {
    merged: report,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
  });
}

/**
 * The recovery decision for a unit that must be redispatched one tier
 * stronger (stall or unverified exit, AC4). At the escalation cap or the
 * strongest tier, the unit fails instead — the designed signal that a human,
 * not a stronger model, is next. Report agents (#468) climb their own
 * mechanical-starting ladder and fail MERGED-AWARE at the cap: the PR is
 * already merged, so dependents stay released.
 */
function enterRecovery(
  ctx: TickCtx,
  state: SchedState,
  unit: string,
  causeEvent: 'stalled' | 'verify-incomplete' | 'dispatch-failure',
  cause: string,
  truth: UnitTruth,
  evidence: Record<string, unknown> = {},
  // #629: `escalate: false` for a CONFIRMED provider API error — it must
  // never consume the per-unit escalation ladder or the ESCALATION_CAP
  // (a spend/rate wall is not the issue's fault), so the respawn keeps the
  // slot's CURRENT tier and `recoveries` count unchanged. Every other caller
  // keeps the default (`true`), unaffected.
  options: { escalate?: boolean } = {}
): SchedState {
  const escalate = options.escalate ?? true;
  const issue = issueOfUnit(unit);
  if (issue === null) return state;
  const now = ctx.deps.now();
  const entry = findEntry(state, issue);
  const slot = slotOf(state, unit);
  if (!entry || !slot) return state;

  killUnitAgent(ctx, state, unit);
  // #524: only the STALL path kills a still-live, not-yet-recorded agent —
  // `causeEvent === 'verify-incomplete'`/`'dispatch-failure'` arrive from
  // `completeUnitOrRecover` AFTER the agent's exit was already detected and
  // recorded by the dead-pid branch of `reconcileRunning`; recording again
  // here would double-count that same dispatch. #591: a stall kill still has
  // a fresh log slice worth reading for `last_tool` — a hung agent's last
  // tool is exactly what tells an operator what it hung in.
  if (causeEvent === 'stalled') {
    const stallLastTool = recordDispatchRunLog(ctx, state, slot, unit).lastTool;
    if (stallLastTool !== null) evidence = { ...evidence, last_tool: stallLastTool };
  }

  const report = isReportSlot(slot);
  let resolvedTier: ModelTier;
  if (escalate) {
    const escalated = report ? reportTierFor(slot.recoveries + 1) : escalateTier(entry.tier);
    if (slot.recoveries >= ESCALATION_CAP || escalated === null) {
      // #629: unreachable with `causeEvent === 'dispatch-failure'` — that
      // cause always passes `escalate: false` above, so this branch (and the
      // narrower `causeEvent` type `failOrAdoptOpenPr` declares) is never
      // actually asked to terminally fail a unit over a provider wall.
      return failOrAdoptOpenPr(
        ctx,
        state,
        unit,
        slot,
        report,
        causeEvent as 'stalled' | 'verify-incomplete',
        cause,
        evidence
      );
    }
    resolvedTier = escalated;
  } else {
    // An unescalated redispatch keeps the CURRENT tier — `reportTierFor`
    // evaluated at the unchanged `slot.recoveries` for a report slot (mirrors
    // `recordDispatchRunLog`'s own tier expression), `entry.tier` verbatim
    // otherwise — never `escalateTier`/`recoveries + 1`.
    resolvedTier = report ? (reportTierFor(slot.recoveries) ?? entry.tier) : entry.tier;
  }

  // Fence BEFORE the respawn (#504 AC1/AC4): `killUnitAgent` above only reaches a pid
  // this process can see and signal, and #472 proved that is not the same as a dead
  // agent. The takeover record is what stops the survivor from writing to the trail —
  // and it is written first precisely so it survives the takeover dying too.
  const fenced = writeFence(ctx, unit, issue, slot, truth);

  let next = transitionSlot(
    state,
    slot.id,
    'recovering',
    {
      pid: null,
      recoveries: escalate ? slot.recoveries + 1 : slot.recoveries,
      gen: fenced ?? slot.gen,
      // Only a fence that actually landed starts the short takeover watch: an
      // unfenced redispatch is already degraded, and cutting its allowance down
      // would compound one failure with another.
      fenced_at: fenced === null ? null : now.toISOString(),
    },
    now
  );
  if (!report && escalate) {
    next = {
      ...next,
      entries: next.entries.map((e) =>
        e.issue === issue ? { ...e, tier: resolvedTier, updated_at: now.toISOString() } : e
      ),
    };
  }
  journal(ctx, causeEvent, unit, {
    detail: cause,
    slot: slot.id,
    ...(slot.last_progress_at !== null ? { last_progress_at: slot.last_progress_at } : {}),
    ...evidence,
  });

  // #629: an UNESCALATED redispatch (a confirmed provider API error) has no
  // natural bound — `recoveries`/`ESCALATION_CAP` never advance for it — so
  // once the dispatch-health pause has fired, respawning it every tick would
  // reproduce the exact incident this fix exists to stop, just on the
  // per-issue rail instead of the batch one (`runBatchTick` gets the
  // equivalent gate below). Hold the slot in `recovering`, unspawned, until
  // `sched resume`: `reconcileRecovering` (below) is what retries it once the
  // pause clears — no separate re-classification happens while parked, since
  // this function is reached exactly once per dead dispatch.
  if (!escalate && next.paused) {
    return next;
  }

  journal(ctx, 'redispatched', unit, {
    tier: resolvedTier,
    slot: slot.id,
    ...journalCmdModelFields(resolveTierSpawn(ctx.dispatch, resolvedTier, issue)),
  });
  ctx.result.redispatched.push(unit);
  // Respawn immediately on the recovering rail — recovering → running. A
  // report-role slot (`role`, never `phase` — #500) routes to the report
  // agent with its escalated tier.
  return spawnUnit(ctx, next, unit);
}

/**
 * Verified-exit walk to idle: `complete` is reachable only via
 * exited → verifying → complete → idle; the fallback keeps the walk from
 * ever wedging (assigned/recovering have nothing verified yet).
 */
function stepVerifiedExitToIdle(status: SlotStatus): SlotStatus {
  if (status === 'complete' || status === 'failed') return 'idle';
  if (status === 'running') return 'exited';
  if (status === 'exited') return 'verifying';
  if (status === 'verifying') return 'complete';
  return 'failed';
}

/** Complete a unit whose ground truth is verified (AC2). */
function completeUnit(
  ctx: TickCtx,
  state: SchedState,
  unit: string,
  via: 'verify-complete' | 'external-advance'
): SchedState {
  const issue = issueOfUnit(unit);
  if (issue === null) return state;
  const now = ctx.deps.now();

  const { state: next, releasedSlotId } = walkSlotToIdle(state, unit, now, stepVerifiedExitToIdle);

  let withEntry = next;
  const entry = findEntry(next, issue);
  if (entry && entry.status === 'dispatched') {
    withEntry = transitionIssue(next, issue, 'shipped', {}, now);
    withEntry = transitionIssue(withEntry, issue, 'done', {}, now);
  } else if (entry && entry.status === 'shipped') {
    // A report agent completing its run (#468): shipped → done.
    withEntry = transitionIssue(next, issue, 'done', {}, now);
  }

  journal(ctx, via, unit);
  if (via === 'external-advance') ctx.result.externalAdvances.push(unit);
  else ctx.result.completed.push(unit);
  journalSlotReleased(ctx, unit, releasedSlotId, via);
  return withEntry;
}

/**
 * Park a unit whose agent exited having already produced an open PR — the
 * ship phase's `awaiting-merge` milestone with `pr=` (#468), or (#596) a
 * terminal unverified exit whose branch ground truth found one the milestone
 * trail never recorded: entry → parked (pr recorded), slot released — a
 * waiting unit consumes zero slots (AC5) and the watcher owns it from here.
 * `extra.detail` names WHICH path adopted the PR, so an operator reading
 * `pr-parked` alone can tell a milestone-verified park from a
 * recovery-adopted one (#596 AC3); `extra.branch` names the ref the PR was
 * found on, without which "why is this unit parked on PR N?" has nothing to
 * correlate against — `slot.branch` is captured from whichever milestone
 * first carried one and is not re-derived between recovery redispatches.
 *
 * Typed rather than a `Record<string, unknown>` bag: both keys are declared
 * `JournalEvent` fields, and routing them through an open record would
 * discard the excess-property check they exist to get.
 */
function parkUnit(
  ctx: TickCtx,
  state: SchedState,
  unit: string,
  pr: number,
  extra: { detail?: string; branch?: string } = {}
): SchedState {
  const issue = issueOfUnit(unit);
  if (issue === null) return state;
  const now = ctx.deps.now();

  const walked = walkSlotToIdle(state, unit, now, stepVerifiedExitToIdle);
  let next = walked.state;

  next = transitionIssue(next, issue, 'parked', { pr }, now);
  journal(ctx, 'pr-parked', unit, { pr, ...extra });
  ctx.result.parked.push(unit);
  journalSlotReleased(ctx, unit, walked.releasedSlotId, 'parked');
  return next;
}

// --- Per-slot reconciliation ---

/** Apply the polled milestone/branch/head signals; returns whether progress happened. */
function applyProgressSignals(
  ctx: TickCtx,
  state: SchedState,
  slot: SlotEntry,
  truth: UnitTruth,
  unit: string
): { state: SchedState; progressed: boolean } {
  const now = ctx.deps.now();
  let next = state;
  let progressed = false;
  let milestoneAdvanced = false;

  if (truth.milestone !== null) {
    // Live phase per unit (AC6).
    if (truth.milestone.phase !== slot.phase) {
      next = patchSlot(next, slot.id, { phase: truth.milestone.phase }, now);
      journal(ctx, 'phase-updated', unit, { phase: truth.milestone.phase, slot: slot.id });
    }
    // The setup milestone carries the branch name — capture it once so the
    // pushed-commit stall signal can watch the remote head.
    if (slot.branch === null && typeof truth.milestone.keys.branch === 'string') {
      next = patchSlot(next, slot.id, { branch: truth.milestone.keys.branch }, now);
    }
    if (Date.parse(truth.milestone.at) > Date.parse(slot.last_progress_at ?? '')) {
      progressed = true;
      milestoneAdvanced = true;
    }
  }

  if (truth.head !== null && truth.head !== slot.last_head) {
    progressed = true;
    next = patchSlot(next, slot.id, { last_head: truth.head }, now);
  }

  if (progressed) {
    // The takeover is demonstrably alive, so the short fence watch has done its job and
    // the phase's ordinary stall allowance takes over from here (#504 AC4).
    next = patchSlot(
      next,
      slot.id,
      {
        last_progress_at: now.toISOString(),
        ...(slot.fenced_at !== null ? { fenced_at: null } : {}),
      },
      now
    );
    // The journal entry names the TRIGGER, not whichever truth happened to be
    // present (#682): before, a push-driven signal was labelled with the
    // unchanged milestone whenever one existed — 30% of all `progress`
    // entries read as a re-journal of a milestone that had not moved, and a
    // repeated `progress` is indistinguishable from real forward motion at a
    // glance. A milestone advance and a push in the same tick journal once,
    // as the milestone (the stronger signal); the push is still visible in
    // `last_head` and any later push re-fires with its own sha.
    if (milestoneAdvanced && truth.milestone !== null) {
      next = journalMilestoneProgressIfDue(ctx, next, slot.id, truth.milestone, unit, now, true);
    } else {
      journal(ctx, 'progress', unit, {
        slot: slot.id,
        detail: 'new pushed commit',
        ...(truth.head !== null ? { head: truth.head } : {}),
      });
    }
  }
  // Persistence counting (#682): every tick the unit is still seen at the SAME
  // milestone advances the streak — silent unless the re-announce window
  // elapses — so "still at implement/done after 40 min" is legible from one
  // line without a journal entry per tick. It runs even when nothing
  // progressed; it never STARTS a streak (that happens only on a real
  // milestone advance above) and never journals one.
  if (truth.milestone !== null && !milestoneAdvanced) {
    next = journalMilestoneProgressIfDue(ctx, next, slot.id, truth.milestone, unit, now, false);
  }
  return { state: next, progressed };
}

/**
 * Journal (or silently count, AC3) the milestone-driven `progress` signal for
 * `slotId` under the shared dedup idiom (#682): once per distinct milestone
 * per unit — keyed on `` `${run}:${phase}/${status}` ``, so a NEW milestone
 * (different phase/status, or the same one re-reached under a NEW run id by a
 * resumed or redispatched run) always journals, while an unchanged one stays
 * silent — and then re-announced only every `JOURNAL_DEDUP_REANNOUNCE_TICKS`
 * ticks while it persists, carrying `since` + `ticks_persisted` so "still at
 * implement/done after 40 min" is legible from one line. Mirrors #630's
 * `pr_watch_failed_*` triple scoped to the slot rail (#610's
 * `stale_milestone_ignored_for` precedent) and #632's
 * `journalConditionIfDue` cadence — no third mechanism.
 *
 * `advanced=false` is a persistence tick: the streak is only counted (and
 * re-announced on the window), never started — a streak begins exclusively
 * on a real milestone advance, so a unit seen carrying a milestone that
 * predates its own dispatch (a redispatch's stale `implement/done`) journals
 * nothing.
 *
 * The streak is keyed on the milestone, not the dispatch: pushes during a
 * milestone ("new pushed commit" entries) are real motion and journal
 * freely, but they do not reset the "still at X" clock — a unit that pushed
 * four times during `implement/done` is still legibly AT `implement/done`.
 *
 * Returns the patched state — callers must thread it, or the marker is lost
 * and the event re-fires next tick as if nothing had been recorded.
 */
function journalMilestoneProgressIfDue(
  ctx: TickCtx,
  state: SchedState,
  slotId: number,
  milestone: NonNullable<UnitTruth['milestone']>,
  unit: string,
  now: Date,
  advanced: boolean
): SchedState {
  const key = `${milestone.run}:${milestone.phase}/${milestone.status}`;
  // Read the CURRENT marker from `state`, not a captured slot — the caller
  // may have patched the slot earlier in the same tick (last_head,
  // last_progress_at) and the persisted marker is what the streak continues.
  const cur = state.slots.find((s) => s.id === slotId);
  if (cur === undefined) return state;
  if (advanced) {
    const isNewStreak = cur.progress_milestone_for !== key;
    const ticks = isNewStreak ? 1 : cur.progress_milestone_ticks + 1;
    const since = isNewStreak
      ? now.toISOString()
      : (cur.progress_milestone_since ?? now.toISOString());
    if (isNewStreak || ticks % JOURNAL_DEDUP_REANNOUNCE_TICKS === 0) {
      // `at` is the decision clock; `since` is the streak's onset. Both are
      // needed: `ticks_persisted` is a TICK count, which maps to no fixed
      // wall-clock across operator-tunable tick intervals.
      journal(ctx, 'progress', unit, {
        slot: slotId,
        detail: `milestone ${milestone.phase}/${milestone.status}`,
        run: milestone.run,
        at: now.toISOString(),
        since,
        ticks_persisted: ticks,
      });
    }
    return patchSlot(
      state,
      slotId,
      {
        progress_milestone_for: key,
        progress_milestone_since: since,
        progress_milestone_ticks: ticks,
      },
      now
    );
  }
  if (cur.progress_milestone_for !== key || cur.progress_milestone_since === null) return state;
  const ticks = cur.progress_milestone_ticks + 1;
  if (ticks % JOURNAL_DEDUP_REANNOUNCE_TICKS === 0) {
    journal(ctx, 'progress', unit, {
      slot: slotId,
      detail: `milestone ${milestone.phase}/${milestone.status}`,
      run: milestone.run,
      at: now.toISOString(),
      since: cur.progress_milestone_since,
      ticks_persisted: ticks,
    });
  }
  return patchSlot(state, slotId, { progress_milestone_ticks: ticks }, now);
}

/**
 * The issue-closed completion signal for a live unit (#468): a report agent's
 * issue is already closed (closed AT MERGE), so for report agents the closed
 * signal is suppressed — only the report milestone can complete them. Keyed
 * off `slot.role`, set when the slot is assigned, never `slot.phase` (#500):
 * `phase` is resynced from the issue's latest polled milestone on every
 * reconcile tick (`applyProgressSignals`), and a report agent's issue keeps
 * reporting its PRE-report milestone (e.g. `ship`) until the report
 * milestone itself lands — so a phase-keyed check silently re-enables the
 * closed signal mid-run and completes the unit before any report milestone
 * was ever posted.
 */
function effectiveClosedSignal(slot: SlotEntry, truth: UnitTruth): boolean {
  return isReportSlot(slot) ? false : truth.closed;
}

/**
 * Journal `event` for `unit` on the first tick of a new streak, then again
 * only every `JOURNAL_DEDUP_REANNOUNCE_TICKS` ticks while it persists (#632).
 * That window is a TICK count, not a duration: the sites reached every
 * reconcile re-announce at ~20 min on the default 60 s interval, while
 * `reconcileParked`/`reconcileStaleFailedParks` are gated on `prPoll.ran` and
 * so advance once per 150 s PR poll, ~50 min. Both intervals are
 * operator-tunable — which is why each entry also carries `since`
 * — `ground-truth-unreachable` and `pr-watch-waiting` were previously
 * journaled every tick the condition held, for as long as it lasted (an
 * outage produced one entry every reconcile interval, per affected unit, for
 * up to `max_slots` units at once).
 *
 * `sinceOf`/`ticksOf` read the entry's marker for THIS event family and
 * `withMarker` writes it back — `ground-truth-unreachable` and
 * `pr-watch-waiting` dedup independently via two separate marker pairs on
 * `QueueEntry` (mirrors #630's `pr_watch_failed_*` on `BatchEntry`, scoped
 * to the issue instead of the batch: these sites span both slot-held units
 * and parked/stale-failed ones with no live slot, and `QueueEntry` is the
 * one record every unit has either way).
 *
 * A caller with no `QueueEntry` to key on (should not happen for a real
 * issue-dispatch unit) journals unconditionally rather than silently drop
 * the line — the pre-#632 behavior, and safe: it can only make the journal
 * more verbose, never hide a real condition.
 *
 * Returns the patched state — callers must thread it, or the marker is lost
 * and the event re-fires next tick as if nothing had been recorded.
 */
function journalConditionIfDue(
  ctx: TickCtx,
  state: SchedState,
  unit: string,
  event: 'ground-truth-unreachable' | 'pr-watch-waiting',
  sinceOf: (entry: QueueEntry) => string | null,
  ticksOf: (entry: QueueEntry) => number,
  withMarker: (since: string | null, ticks: number) => Partial<QueueEntry>,
  extra: Record<string, unknown>
): SchedState {
  const issue = issueOfUnit(unit);
  const entry = issue === null ? undefined : findEntry(state, issue);
  if (issue === null || entry === undefined) {
    journal(ctx, event, unit, extra);
    return state;
  }
  const isNewStreak = sinceOf(entry) === null;
  const ticks = isNewStreak ? 1 : ticksOf(entry) + 1;
  const now = ctx.deps.now();
  const since = isNewStreak ? now.toISOString() : (sinceOf(entry) as string);
  if (isNewStreak || ticks % JOURNAL_DEDUP_REANNOUNCE_TICKS === 0) {
    // `at` is the decision clock (AC3); `since` is the streak's onset. Both
    // are needed: `ticks_persisted` is a TICK count, and the two rails tick at
    // different, operator-tunable rates, so it maps to no fixed wall-clock.
    journal(ctx, event, unit, {
      ...extra,
      at: now.toISOString(),
      since,
      ticks_persisted: ticks,
    });
  }
  // `touchUpdatedAt: false` — this marker is dedup bookkeeping, not a
  // substantive change to the entry; `QueueEntry.updated_at` is relied on
  // elsewhere (`isStaleFailedPark`'s window, `status.ts`'s "since" display,
  // `readiness.ts`'s dispatch tiebreak) as a clock that must not reset on a
  // silent tick.
  return patchEntry(state, issue, withMarker(since, ticks), now, false);
}

function journalGroundTruthUnreachableIfDue(
  ctx: TickCtx,
  state: SchedState,
  unit: string,
  extra: Record<string, unknown>
): SchedState {
  return journalConditionIfDue(
    ctx,
    state,
    unit,
    'ground-truth-unreachable',
    (e) => e.ground_truth_unreachable_since,
    (e) => e.ground_truth_unreachable_ticks,
    (since, ticks) => ({
      ground_truth_unreachable_since: since,
      ground_truth_unreachable_ticks: ticks,
    }),
    extra
  );
}

function journalPrWatchWaitingIfDue(
  ctx: TickCtx,
  state: SchedState,
  unit: string,
  extra: Record<string, unknown>
): SchedState {
  return journalConditionIfDue(
    ctx,
    state,
    unit,
    'pr-watch-waiting',
    (e) => e.pr_watch_waiting_since,
    (e) => e.pr_watch_waiting_ticks,
    (since, ticks) => ({ pr_watch_waiting_since: since, pr_watch_waiting_ticks: ticks }),
    extra
  );
}

/**
 * Clear a `QueueEntry`'s `ground-truth-unreachable` marker once truth
 * answers again (#632) — a no-op when nothing was set, so callers can call
 * this unconditionally on every tick truth is healthy without churning
 * `updated_at` for entries that were never in a streak.
 */
function clearGroundTruthUnreachable(state: SchedState, unit: string, now: Date): SchedState {
  const issue = issueOfUnit(unit);
  const entry = issue === null ? undefined : findEntry(state, issue);
  if (issue === null || entry === undefined || entry.ground_truth_unreachable_since === null) {
    return state;
  }
  return patchEntry(
    state,
    issue,
    { ground_truth_unreachable_since: null, ground_truth_unreachable_ticks: 0 },
    now,
    false
  );
}

/** Same as `clearGroundTruthUnreachable`, for the `pr-watch-waiting` marker. */
function clearPrWatchWaiting(state: SchedState, unit: string, now: Date): SchedState {
  const issue = issueOfUnit(unit);
  const entry = issue === null ? undefined : findEntry(state, issue);
  if (issue === null || entry === undefined || entry.pr_watch_waiting_since === null) {
    return state;
  }
  return patchEntry(
    state,
    issue,
    { pr_watch_waiting_since: null, pr_watch_waiting_ticks: 0 },
    now,
    false
  );
}

/**
 * #575: journal the ignored stale milestone — shared by `reconcileRunning`'s
 * external-advance check and `completeUnitOrRecover`'s verify-complete check,
 * the two call sites `isVerifiedComplete`'s dispatch fence guards. Fires only
 * when the raw milestone WOULD have completed the unit under the old,
 * unfenced rule (`isVerifiedComplete(milestone, false)`, `dispatchedAt`
 * omitted) but the fenced check just rejected it — i.e. a `report/done`
 * milestone that predates this dispatch's `spawned_at`.
 *
 * #610 fixed this event on the batch member rail (`reconcileMemberSlot`,
 * `batch-dispatch.ts`) and the same two defects were live here, on the rail
 * that fires far more often:
 *
 *  - CADENCE. It was journaled per-tick while the condition held, so a unit
 *    carrying one stale milestone emitted an identical line every reconcile
 *    interval for its whole run — roughly twenty for a 40-minute unit, which
 *    `tick.sh` then forwards to Telegram one by one. It is now gated on the
 *    same `SlotEntry.stale_milestone_ignored_for` marker: at most once per
 *    DISPATCH. The marker holds the `spawned_at` it was decided for, so a
 *    redispatch's new `spawned_at` re-arms it with no reset site.
 *  - PAYLOAD. `at` was the MILESTONE's timestamp here and the engine's
 *    decision time on the batch rail — one event name, two meanings, and
 *    nothing in the line to say which. Both rails now agree: `at` is the
 *    decision time, `milestone_at` is how old the ignored milestone is.
 *
 * Returns the patched state (the marker is persisted) — callers must thread
 * it, or the event re-fires next tick as if nothing had been recorded.
 */
function journalStaleMilestoneIfIgnored(
  ctx: TickCtx,
  state: SchedState,
  unit: string,
  slot: SlotEntry,
  truth: UnitTruth,
  verifiedComplete: boolean,
  closedSignal: boolean
): SchedState {
  const { milestone } = truth;
  if (verifiedComplete || closedSignal || milestone === null) return state;
  if (!isVerifiedComplete(milestone, false)) return state;
  if (slot.stale_milestone_ignored_for === slot.spawned_at) return state;
  const now = ctx.deps.now();
  journal(ctx, 'stale-milestone-ignored', unit, {
    slot: slot.id,
    run: milestone.run,
    at: now.toISOString(),
    milestone_at: milestone.at,
    detail: `predates dispatch spawned_at=${slot.spawned_at}`,
  });
  return patchSlot(state, slot.id, { stale_milestone_ignored_for: slot.spawned_at }, now);
}

/**
 * Both signals a completed dispatch's log can yield — the last tool called
 * (#591) and, since #629, whether the exit was a confirmed provider API
 * error rather than an agent that ran. Read together from the SAME log slice
 * so `completeUnitOrRecover`'s two branches can never derive them from
 * different content.
 */
interface DispatchSignals {
  lastTool: string | null;
  apiError: DispatchApiError | null;
}

const NO_DISPATCH_SIGNALS: DispatchSignals = { lastTool: null, apiError: null };

/**
 * Read THIS dispatch's last tool call and API-error classification (#591,
 * #620, #629) from its log slice — a pure, side-effect-free parse, safe to
 * call from any slot status and any number of times: unlike
 * `recordDispatchRunLog` below, it writes nothing to `runs.jsonl`, so it
 * carries no exactly-once constraint. Exists because a `verify-incomplete`/
 * `dispatch-failure` decision can land on a LATER tick than the one that
 * detected the dead pid (e.g. ground truth was unreachable in between) — by
 * then the slot has moved past `running` and `recordDispatchRunLog`'s guard
 * refuses to re-read, but the dispatch's log file is static once the agent
 * has exited, so re-parsing it here yields the same answer every time.
 */
function readDispatchSignalsForSlot(ctx: TickCtx, slot: SlotEntry, unit: string): DispatchSignals {
  if (slot.spawned_at === null) return NO_DISPATCH_SIGNALS;
  const { content } = dispatchLogSlice(ctx, slot, unit);
  return { lastTool: parseLastToolUse(content), apiError: parseDispatchApiError(content) };
}

/**
 * THIS dispatch's slice of the per-unit log: path, start offset, contents.
 *
 * #524: the log is per-unit and append-mode, so reading from byte 0 would
 * include every PRIOR dispatch's output too (claude: unparseable JSON
 * concatenation; opencode: summed tokens double-counted). One reader so the
 * `?? 0` legacy default (a pre-1.7.0 slot has no recorded offset) cannot
 * drift between the two callers — `readLastToolForSlot`'s "always agrees
 * with whatever `reconcileRunning` saw" guarantee is exactly the claim that
 * a second copy of this derivation would quietly break.
 */
function dispatchLogSlice(
  ctx: TickCtx,
  slot: SlotEntry,
  unit: string
): { logFile: string; offset: number; content: string | null } {
  const logFile = dispatchLogPath(ctx.deps.store.runsDir, unit);
  const offset = slot.log_offset_at_spawn ?? 0;
  return { logFile, offset, content: readDispatchLog(logFile, offset) };
}

/**
 * Append this dispatch's `runs.jsonl` entry (#524) — one per completed
 * spawn, not per unit: a redispatch/takeover produces another entry, each
 * with its own tokens/duration, never an update to the first. Called from
 * every place a dispatch ends: `reconcileRunning`'s dead-pid branch (the
 * agent exited on its own), its external-advance branch (ground truth says
 * done while the agent was still alive and had to be killed), the
 * stall-timeout kill in `enterRecovery`, and the dependents-blocked kill in
 * `blockTransitiveDependents`.
 *
 * Exactly-once per dispatch is enforced by the guard below (slot still
 * `running` and actually spawned), not by the call sites' ordering — two of
 * the four reach slots in any non-idle status.
 */
function recordDispatchRunLog(
  ctx: TickCtx,
  state: SchedState,
  slot: SlotEntry,
  unit: string
): DispatchSignals {
  // Enforce the once-per-dispatch invariant HERE rather than restating it in
  // prose at four call sites (#524 review). `blockTransitiveDependents` and
  // `enterRecovery` reach slots in any non-idle status: a slot already moved
  // to `exited`/`verifying` was recorded on the way out, and re-recording it
  // would append a SECOND entry over the same log slice — doubling that
  // issue's tokens in `sched stats`, the exact number-fabrication this work
  // exists to eliminate. A slot that never spawned (`assigned`/`starting`,
  // `spawned_at` still null) is worse: it would read from offset 0 and
  // re-attribute every prior dispatch's tokens to a phantom run.
  if (slot.status !== 'running' || slot.spawned_at === null) {
    journal(ctx, 'run-log-skipped', unit, {
      reason: slot.spawned_at === null ? 'never-spawned' : `already-recorded-${slot.status}`,
      slot: slot.id,
    });
    return NO_DISPATCH_SIGNALS;
  }

  const issue = issueOfUnit(unit);
  const entry = issue === null ? undefined : findEntry(state, issue);
  if (issue === null || !entry) {
    // Left the queue already, or a batch unit (#464 non-goal: only issue:<n>
    // units are dispatched) — nothing to attribute the run to. Journaled so
    // an operator sees WHY a dispatch produced no runs.jsonl entry, rather
    // than a silent gap next to `exit-detected`.
    journal(ctx, 'run-log-skipped', unit, {
      reason: issue === null ? 'not-an-issue-unit' : 'entry-gone',
    });
    return NO_DISPATCH_SIGNALS;
  }

  // Report slots ride the same tier the cycle escalation ladder set at
  // dispatch time, EXCEPT `entry.tier` is deliberately not updated for a
  // report redispatch (`enterRecovery`'s `if (!report)` guard) — mirror the
  // spawn-side branch (`spawnReportAgent`) or a report slot's tier/model
  // here would silently disagree with what was actually spawned.
  const tier = isReportSlot(slot) ? (reportTierFor(slot.recoveries) ?? entry.tier) : entry.tier;
  // #527: the tier's OWN resolved command/model — not the global
  // dispatch.command/tierModels — so a mixed agent-CLI ladder's runs.jsonl
  // entry (AC3) matches what was actually spawned for this dispatch.
  const { cmd, model } = resolveTierSpawn(ctx.dispatch, tier, issue);
  // #524: read only THIS dispatch's slice — see `dispatchLogSlice`.
  const { logFile, offset, content: logContent } = dispatchLogSlice(ctx, slot, unit);

  const runEntry = buildSchedRunLogEntry({
    unit,
    role: slot.role,
    cmd0: cmd[0],
    cmd,
    logContent,
    spawnedAt: slot.spawned_at,
    completedAt: ctx.deps.now(),
    configuredModel: model,
    cwd: ctx.deps.repoDir,
    tier,
  });

  finalizeRunLogEntry(
    runEntry,
    logContent,
    ctx.deps.homeDir,
    (event, extra) => journal(ctx, event, unit, extra),
    { log: logFile, offset }
  );

  // #591: the last tool this dispatch called, so an unverified exit attributes to a
  // concrete cause (e.g. `Monitor`) without opening the transcript — see `enterRecovery`.
  // #629: whether this SAME dispatch was a confirmed provider API error — see
  // `completeUnitOrRecover`.
  return { lastTool: parseLastToolUse(logContent), apiError: parseDispatchApiError(logContent) };
}

/** Reconcile one running slot against its polled ground truth. */
function reconcileRunning(
  ctx: TickCtx,
  state: SchedState,
  slot: SlotEntry,
  truth: UnitTruth,
  unit: string
): SchedState {
  const now = ctx.deps.now();

  // Orphaned pid after a sched restart, or a normally-exited agent: the exit
  // is DETECTED, never trusted as completion (AC2/AC3).
  if (slot.pid !== null && !ctx.deps.spawnDeps.isAlive(slot.pid, slot.pid_start ?? undefined)) {
    journal(ctx, 'exit-detected', unit, { pid: slot.pid, slot: slot.id });
    const signals = recordDispatchRunLog(ctx, state, slot, unit);
    const exited = transitionSlot(state, slot.id, 'exited', {}, now);
    return completeUnitOrRecover(ctx, exited, unit, truth, 'verify-complete', signals);
  }

  // The milestone poll FAILED (gh outage, missing binary) — unreachable is NOT
  // known-absent (decision 2, option A): stall and advance decisions pause for
  // this unit until truth returns. The dead-pid rail above still ran — local
  // truth needs no network.
  if (!truth.reachable) {
    return journalGroundTruthUnreachableIfDue(ctx, state, unit, {
      slot: slot.id,
      detail: 'stall/advance decisions paused until truth returns',
    });
  }
  // #632: truth answered this tick — any unreachable streak recorded against
  // a PREVIOUS tick is over.
  // Named for what it holds — a SchedState with the streak cleared — not for
  // `truth.reachable`, the boolean five lines up.
  const cleared = clearGroundTruthUnreachable(state, unit, now);

  // Ground truth says the unit is DONE while the agent still holds the slot —
  // externally-advanced state (AC3): reclaim the slot, kill the leftover agent.
  // A parked milestone is deliberately NOT an advance: a detached run parks
  // and stops — the watcher owns the tail (#468); the exit/stall rails take
  // the agent from here.
  const closedSignal = effectiveClosedSignal(slot, truth);
  // #575: `slot.spawned_at` fences a `report/done` milestone to THIS dispatch
  // — a re-enqueued issue's PREVIOUS run's report milestone must not read as
  // "complete" the moment the fresh agent's first tick polls it.
  const verifiedComplete = isVerifiedComplete(truth.milestone, closedSignal, slot.spawned_at);
  // Threaded, not discarded: the once-per-dispatch marker lives in the state
  // this returns.
  const marked = journalStaleMilestoneIfIgnored(
    ctx,
    cleared,
    unit,
    slot,
    truth,
    verifiedComplete,
    closedSignal
  );
  if (verifiedComplete && !isParkedMilestone(truth.milestone)) {
    journal(ctx, 'external-advance', unit, {
      pid: slot.pid,
      slot: slot.id,
      // closedSignal, not the raw truth.closed, decided this: for a
      // report-role slot `closed` is suppressed, so `truth.closed` reads true
      // at completion regardless — the actual signal was the report milestone.
      detail: closedSignal ? 'issue closed' : `report done (role=${slot.role})`,
    });
    killUnitAgent(ctx, marked, unit);
    // The agent was still alive (that's what "externally-advanced" means) —
    // log it here too, or an external-advance dispatch would never get a
    // runs.jsonl entry at all (it never takes the dead-pid branch above).
    recordDispatchRunLog(ctx, marked, slot, unit);
    const exited = transitionSlot(marked, slot.id, 'exited', {}, now);
    return completeUnitOrRecover(ctx, exited, unit, truth, 'external-advance');
  }

  const progress = applyProgressSignals(ctx, marked, slot, truth, unit);
  if (progress.progressed) return progress.state;

  // No progress: the stall timer (AC4). The phase now IN FLIGHT is the last
  // milestone's `next=`, not `slot.phase` — `slot.phase` is set to
  // `truth.milestone.phase`, which names the phase that just COMPLETED, so
  // using it directly would apply a phase's timeout allowance to the phase
  // AFTER it (#495). Falls back to `slot.phase` (set to 'gate' at spawn,
  // 'report' for a report agent) for the brief window before any milestone
  // has posted.
  const activePhase = truth.milestone?.keys.next ?? slot.phase;
  // A takeover that has posted NOTHING since it was fenced in gets the short fence
  // window instead of the phase's full allowance (#504 AC4) — a takeover can die on its
  // own first breath, and waiting out an `implement`-length timeout to notice wastes the
  // time the redispatch was meant to save.
  const stallTimeoutMs = stallTimeoutForSlot(ctx.dispatch, activePhase, slot.fenced_at);
  if (msSinceLastProgress(slot, now) >= stallTimeoutMs) {
    return enterRecovery(ctx, progress.state, unit, 'stalled', 'stall', truth, {
      active_phase: activePhase,
      stall_timeout_ms: stallTimeoutMs,
      ...(slot.fenced_at !== null ? { fenced_at: slot.fenced_at } : {}),
    });
  }
  return progress.state;
}

/**
 * Record one dispatch outcome against the cross-unit `suspect-dispatch`
 * signal (#505). `suspect === false` (a verified completion, or an
 * unverified exit that took at least `SUSPECT_DISPATCH_WINDOW_MS`) resets
 * the streak — that dispatch clearly ran for real, so whatever caused an
 * earlier suspect exit isn't an ongoing wall. `suspect === true` journals
 * `suspect-dispatch`; a repeat from the SAME unit updates bookkeeping only
 * (one flaky unit isn't cross-unit correlation), while a DIFFERENT unit
 * increments the streak and, at `DISPATCH_UNHEALTHY_THRESHOLD`, pauses new
 * assignments exactly like `sched pause` — already-live slots are untouched,
 * only `computeAssignments` stops filling idle ones. The per-unit ladder
 * this accompanies (`enterRecovery`) is never altered by this function.
 */
function recordDispatchOutcome(
  ctx: TickCtx,
  state: SchedState,
  unit: string,
  slot: SlotEntry,
  suspect: boolean
): SchedState {
  if (!suspect) {
    if (state.consecutive_suspect_dispatches === 0 && state.last_suspect_dispatch_unit === null) {
      return state;
    }
    return { ...state, consecutive_suspect_dispatches: 0, last_suspect_dispatch_unit: null };
  }

  journal(ctx, 'suspect-dispatch', unit, {
    slot: slot.id,
    detail: `exit within ${SUSPECT_DISPATCH_WINDOW_MS}ms of last progress, unverified`,
  });

  const previousUnit = state.last_suspect_dispatch_unit;
  if (previousUnit === unit) {
    return state;
  }

  const count = state.consecutive_suspect_dispatches + 1;
  let next: SchedState = {
    ...state,
    consecutive_suspect_dispatches: count,
    last_suspect_dispatch_unit: unit,
  };
  if (count >= DISPATCH_UNHEALTHY_THRESHOLD && !next.paused) {
    next = setPaused(next, true);
    // Name both units involved — the current one and the one that carried
    // the streak into it — so an operator reading `dispatch-unhealthy` in
    // isolation (without scrolling back through prior `suspect-dispatch`
    // lines) can already see the cross-unit correlation that triggered it.
    journal(ctx, 'dispatch-unhealthy', unit, {
      detail: `${count} consecutive suspect dispatches across different units (${previousUnit ?? 'unknown'} then ${unit}) — new assignments paused; \`sched resume\` once dispatch is healthy`,
    });
  }
  return next;
}

/**
 * An exited/verifying slot: verify the claimed state against ground truth
 * (AC2). Verified → complete; a ship-phase `awaiting-merge` milestone with
 * `pr=` → parked (the detached-run exit, #468); unverified → the same
 * recovery ladder as a stall. `via` distinguishes the journal's completion
 * event.
 */
function completeUnitOrRecover(
  ctx: TickCtx,
  state: SchedState,
  unit: string,
  truth: UnitTruth,
  via: 'verify-complete' | 'external-advance',
  // #591/#629: the last tool called AND whether the exit was a confirmed
  // provider API error (from `recordDispatchRunLog`'s dead-pid reading),
  // threaded through to the unverified-exit decision below. The
  // `external-advance` caller passes none — it DOES record a run log
  // (`reconcileRunning`, #524), but ground truth already confirmed
  // completion, so this path never reaches that decision and neither signal
  // has anything to attribute.
  //
  // #620: a THUNK, not a value, for the deferred `exited`/`verifying` rail — that caller
  // has no read of its own to hand over and would otherwise have to read the dispatch log
  // eagerly on every tick, including the majority that return early (ground truth
  // unreachable) or complete the unit, discarding it. The log is bounded at
  // MAX_DISPATCH_LOG_BYTES (32 MiB) and its size is set by the spawned agent, so an
  // eager read is up to 32 MiB per slot per tick for as long as an outage holds slots in
  // `verifying`. Resolved once, only on the branch that consumes it.
  dispatchSignals: DispatchSignals | (() => DispatchSignals) = NO_DISPATCH_SIGNALS
): SchedState {
  const now = ctx.deps.now();
  let next = state;
  let slot = slotOf(next, unit);
  if (slot && slot.status === 'exited') {
    next = transitionSlot(next, slot.id, 'verifying', {}, now);
    slot = slotOf(next, unit);
  }
  if (!slot || slot.status !== 'verifying') return next;

  // The poll failed — unreachable is not "unverified" (decision 2, option A):
  // hold the exit in `verifying` until truth returns, then decide. The agent
  // is already gone; no slot work is lost by waiting.
  if (!truth.reachable) {
    return journalGroundTruthUnreachableIfDue(ctx, next, unit, {
      slot: slot.id,
      detail: 'exit verification paused until truth returns',
    });
  }

  const issue = issueOfUnit(unit);
  const entry = issue !== null ? findEntry(next, issue) : undefined;
  // A verified park: the agent exited having parked its PR — the watcher
  // takes the unit (AC2's "never inferred from agent exit" cut both ways:
  // the park IS the milestone, the merge is not).
  if (entry !== undefined && entry.status === 'dispatched' && isParkedMilestone(truth.milestone)) {
    // A verified park is also proof dispatch is healthy (#505/#629) — reset
    // both streaks exactly like the sibling `completeUnit` branch below, or a
    // healthy park sandwiched between two unrelated units' suspect/api-error
    // exits would be invisible to the correlation and could still tip it
    // into a false-positive pause.
    const parked = resetDispatchApiErrorStreak(recordDispatchOutcome(ctx, next, unit, slot, false));
    const pr = prOfMilestone(truth.milestone); // non-null: isParkedMilestone guarantees it
    if (pr === null) {
      // Structurally unreachable, and deliberately not silent if it ever is:
      // the slot is already in `verifying`, so an early return with nothing
      // journaled leaves it re-deciding the same way every tick, forever,
      // against an empty trail. Return the recorded state (the pre-#596 form
      // did — `parkUnit`'s internal guard returned the state it was handed),
      // not the un-recorded `next`. #632: dedup like the sibling check above
      // — same marker, since only one of the two can be live for this unit
      // on a given tick (this branch is reached only after `truth.reachable`
      // already held).
      return journalGroundTruthUnreachableIfDue(ctx, parked, unit, {
        slot: slot.id,
        detail: `parked milestone (run=${truth.milestone?.run ?? 'unknown'}) carries no parseable pr= key — holding in verifying`,
      });
    }
    // #632: a pr= key was found — both flavors of this unit's
    // ground-truth-unreachable streak (unreachable poll, unparseable pr=)
    // are resolved.
    return parkUnit(ctx, clearGroundTruthUnreachable(parked, unit, now), unit, pr);
  }

  // #632: truth answered this tick and this unit isn't stuck on the
  // missing-pr= edge above — any streak recorded against a PREVIOUS tick
  // (either flavor) is over.
  next = clearGroundTruthUnreachable(next, unit, now);

  // #575: fence to THIS dispatch's `spawned_at` — an agent that exited having
  // posted nothing new must not read as complete against the issue's
  // PREVIOUS run's report milestone; it falls through to the recovery ladder
  // below (`unverified-exit`) instead.
  const closedSignal = effectiveClosedSignal(slot, truth);
  const verifiedComplete = isVerifiedComplete(truth.milestone, closedSignal, slot.spawned_at);
  next = journalStaleMilestoneIfIgnored(
    ctx,
    next,
    unit,
    slot,
    truth,
    verifiedComplete,
    closedSignal
  );
  if (verifiedComplete) {
    const completed = resetDispatchApiErrorStreak(
      recordDispatchOutcome(ctx, next, unit, slot, false)
    );
    return completeUnit(ctx, completed, unit, via);
  }

  const resolved = typeof dispatchSignals === 'function' ? dispatchSignals() : dispatchSignals;

  // #629: a CONFIRMED provider API error is a dispatch failure, never an
  // unverified exit — it skips `recordDispatchOutcome`'s timing-based
  // suspect check entirely (the classification is deterministic, not a
  // heuristic) and never reaches `enterRecovery`'s escalation.
  if (resolved.apiError) {
    // `journalFailure: false` — `enterRecovery` journals its own `causeEvent`
    // (`'dispatch-failure'`) with this same evidence immediately below; without
    // the flag this rail double-journals every confirmed error (#629 review).
    const recorded = recordDispatchApiError(
      (event, u, extra) => journal(ctx, event, u, extra),
      next,
      unit,
      resolved.apiError,
      { journalFailure: false }
    );
    return enterRecovery(
      ctx,
      recorded,
      unit,
      'dispatch-failure',
      dispatchApiErrorDetail(resolved.apiError),
      truth,
      dispatchApiErrorFields(resolved.apiError),
      { escalate: false }
    );
  }

  const suspect = msSinceLastProgress(slot, now) < SUSPECT_DISPATCH_WINDOW_MS;
  next = recordDispatchOutcome(ctx, next, unit, slot, suspect);
  return enterRecovery(ctx, next, unit, 'verify-incomplete', 'unverified-exit', truth, {
    observed: truth.milestone
      ? `milestone ${truth.milestone.phase}/${truth.milestone.status}; closed=${truth.closed}`
      : `no milestone; closed=${truth.closed}`,
    // #591: attributes the unverified exit to a concrete cause (e.g. `Monitor`)
    // without opening the transcript. Omitted when the log yielded no tool_use.
    ...(resolved.lastTool !== null ? { last_tool: resolved.lastTool } : {}),
  });
}

/** Re-attach or spawn a slot left `assigned` by a crash between assign and spawn. */
function reconcileAssigned(
  ctx: TickCtx,
  state: SchedState,
  slot: SlotEntry,
  unit: string
): SchedState {
  if (slot.pid !== null && ctx.deps.spawnDeps.isAlive(slot.pid)) {
    // Crash after spawn, before the running transition: re-attach by pid.
    journal(ctx, 'orphan-pid', unit, {
      pid: slot.pid,
      slot: slot.id,
      detail: 're-attached after restart',
    });
    return transitionSlot(state, slot.id, 'running', {}, ctx.deps.now());
  }
  journal(ctx, 'assigned', unit, { slot: slot.id, detail: 'crash-recovery spawn' });
  return spawnUnit(ctx, state, unit);
}

/** Reconcile a `recovering` slot: respawn with the escalated tier. */
function reconcileRecovering(ctx: TickCtx, state: SchedState, unit: string): SchedState {
  // #629: while paused, do not resume a `recovering` slot's respawn — this is
  // the crash-recovery rail (a sched restart caught a slot between
  // `enterRecovery`'s transition and its own `spawnUnit` call, OR `enterRecovery`
  // itself deliberately parked an unescalated redispatch here, see its own
  // pause check). Either way, `sched resume` is what lets the tick loop reach
  // this function again and actually respawn.
  if (state.paused) return state;
  return spawnUnit(ctx, state, unit);
}

// --- Tick phases ---

/** Phase 1: reconcile every existing slot against its polled ground truth. */
function reconcileSlots(
  ctx: TickCtx,
  state: SchedState,
  polled: Map<string, UnitTruth>
): SchedState {
  let next = state;
  for (const slot of state.slots) {
    const unit = slot.unit;
    if (unit === null) continue;
    // Batch slots (#523) are reconciled entirely by `runBatchTick` — this loop
    // is issue-dispatch-specific (`pollUnits` never polls a `batch:<id>` unit,
    // since `issueOfUnit` returns null for it), and falling through to the
    // synthetic default truth below would read a batch's live agent as
    // ground-truth-unreachable and kill it out from under the batch pass.
    if (issueOfUnit(unit) === null) continue;
    const truth: UnitTruth = polled.get(unit) ?? {
      reachable: true,
      milestone: null,
      closed: false,
      head: null,
    };
    switch (slot.status) {
      case 'assigned':
        next = reconcileAssigned(ctx, next, slot, unit);
        break;
      case 'running':
        next = reconcileRunning(ctx, next, slot, truth, unit);
        break;
      case 'exited':
      case 'verifying':
        // #620: this branch is reached on a LATER tick than the one that
        // detected the dead pid whenever the first attempt's ground truth
        // was unreachable (`completeUnitOrRecover` returns early in that
        // case, before consuming the lastTool `reconcileRunning` already
        // read). Re-read it here rather than losing it — the log itself is
        // static once the agent has exited, so this always agrees with
        // whatever `reconcileRunning` saw. Passed as a thunk so the read
        // happens only on the tick that actually reaches the unverified-exit
        // decision, not on every tick an outage holds the slot here.
        next = completeUnitOrRecover(ctx, next, unit, truth, 'verify-complete', () =>
          readDispatchSignalsForSlot(ctx, slot, unit)
        );
        break;
      case 'recovering':
        next = reconcileRecovering(ctx, next, unit);
        break;
      default:
        break;
    }
  }
  return next;
}

/** Phase 2: self-heal orphaned dispatches (crash between the entry and slot transitions). */
function requeueOrphanedDispatches(ctx: TickCtx, state: SchedState): SchedState {
  const held = new Set(state.slots.map((s) => s.unit).filter((u): u is string => u !== null));
  let next = state;
  for (const entry of state.entries) {
    if (entry.status !== 'dispatched' || held.has(`issue:${entry.issue}`)) continue;
    const now = ctx.deps.now();
    next = transitionIssue(next, entry.issue, 'blocked', { reason: 'orphaned-dispatch' }, now);
    // #633: same rule as `requeueMember` — a requeue is a fresh attempt, so a
    // dedup streak recorded against the PREVIOUS dispatch must not suppress
    // that condition's first occurrence on this one. Without it, a crash
    // during an outage leaves `ground_truth_unreachable_ticks` mid-streak and
    // the redispatched unit stays silent until the next re-announcement.
    next = transitionIssue(
      next,
      entry.issue,
      'queued',
      { reason: null, ...CLEARED_ENTRY_DEDUP_MARKERS },
      now
    );
    journal(ctx, 'requeued', `issue:${entry.issue}`, {
      detail: 'orphaned dispatch requeued after restart',
    });
  }
  return next;
}

/**
 * The PR watcher's decision pass (#468): apply polled PR truths to parked
 * entries. Merge acceptance (AC1) requires state MERGED AND mergedAt non-null
 * AND the issue closed — never an agent exit. Failure states (AC3) fail the
 * unit and block transitive dependents; the engine never merges anything
 * itself. `shipped` (not `parked`) is what unblocks dependents (AC4).
 *
 * Entries are re-read fresh each iteration: a mid-loop failure blocks OTHER
 * parked entries (transitive dependents), and acting on a stale snapshot
 * would drive an already-blocked entry through `parked → shipped`.
 */
function reconcileParked(ctx: TickCtx, state: SchedState, prPoll: PrPoll): SchedState {
  if (!prPoll.ran) return state;
  let next: SchedState = { ...state, last_pr_poll_at: ctx.deps.now().toISOString() };

  const parkedIssues = state.entries
    .filter((e) => e.status === 'parked' && e.pr !== null)
    .map((e) => e.issue);

  for (const issue of parkedIssues) {
    const entry = findEntry(next, issue);
    if (!entry || entry.status !== 'parked' || entry.pr === null) continue; // blocked mid-loop
    const unit = `issue:${issue}`;
    const truth = prPoll.truths.get(issue);
    if (truth === undefined) {
      if (!prPoll.truths.has(issue)) {
        continue; // parked AFTER the poll ran (this tick) — next cadence picks it up
      }
      next = journalGroundTruthUnreachableIfDue(ctx, next, unit, {
        detail: 'pr watch paused until truth returns',
      });
      continue;
    }
    // #632: truth answered this tick — any unreachable streak recorded
    // against a PREVIOUS tick is over.
    next = clearGroundTruthUnreachable(next, unit, ctx.deps.now());

    const failWatch = (reason: string): SchedState => {
      journal(ctx, 'pr-watch-failed', unit, { reason, pr: entry.pr });
      // #632: the watch is ending (terminal failure) — no more "waiting".
      return clearPrWatchWaiting(failUnit(ctx, next, unit, reason), unit, ctx.deps.now());
    };

    // #501: MERGED is checked FIRST, before any failure rail. A PR that is
    // genuinely merged is merged regardless of a leftover `auto-merge-blocked`
    // label (GitHub does not clear labels on merge) or a `mergeable` snapshot
    // that hasn't caught up yet — checking `blocked`/`CONFLICTING` first would
    // fail a unit whose work already shipped, only to have
    // `reconcileStaleFailedParks` immediately re-reconcile it later that same
    // tick, after `blockTransitiveDependents` had already wedged its
    // dependents on a "failure" that was never real.
    if (isPrMerged(truth)) {
      // AC1: the issue must ALSO be closed (a merged PR auto-closes it) —
      // until GitHub propagates, the unit stays parked and keeps watching.
      if (prPoll.closed.get(issue) !== true) {
        next = journalPrWatchWaitingIfDue(ctx, next, unit, {
          pr: entry.pr,
          mergedAt: truth.mergedAt,
          detail: 'merge seen but issue not closed — keep watching',
        });
        continue;
      }
      next = transitionIssue(next, issue, 'shipped', { reason: null }, ctx.deps.now());
      next = clearPrWatchWaiting(next, unit, ctx.deps.now());
      journal(ctx, 'merge-accepted', unit, { pr: entry.pr, mergedAt: truth.mergedAt });
      ctx.result.mergeAccepted.push(unit);
      continue;
    }
    if (truth.blocked) {
      next = failWatch(AUTO_MERGE_BLOCKED_REASON);
      continue;
    }
    if (truth.mergeable === 'CONFLICTING') {
      next = failWatch('pr-conflicting');
      continue;
    }
    if (truth.state === 'CLOSED' && truth.mergedAt === null) {
      next = failWatch('pr-closed-unmerged');
    } else {
      // OPEN (or mergeable UNKNOWN) — keep watching. #632: this tick's truth
      // is NOT "merge seen but not closed", so a waiting streak from an
      // earlier tick's merge-then-reverted flicker is over.
      next = clearPrWatchWaiting(next, unit, ctx.deps.now());
    }
  }
  return next;
}

/**
 * #501: reconcile `failed reason=auto-merge-blocked` entries whose PR later
 * merged after an operator manually re-queued it (removed
 * `auto-merge-blocked`, re-added `auto-merge`) — outside the engine's own
 * watch, since `reconcileParked` stops watching an entry the instant it
 * leaves `parked`, including into `failed`. Flips it to `shipped` so
 * `sched status` and `dispatchReportAgents` treat it exactly like a
 * normally-watched merge, and unblocks dependents wedged on the original
 * (now-reversed) failure; ground truth comes from `pollParkedPrs`, which
 * this piggybacks — no separate poll pass, though each watched entry still
 * costs its own `gh pr view`/`gh issue view`.
 *
 * Deliberately narrow: only `isStaleFailedPark` entries are eligible (AC3) —
 * a `failed` entry for any other reason, or one whose PR has sat blocked
 * past `STALE_RECONCILE_WINDOW_MS`, is never touched.
 */
function reconcileStaleFailedParks(ctx: TickCtx, state: SchedState, prPoll: PrPoll): SchedState {
  if (!prPoll.ran) return state;
  let next: SchedState = state;
  const nowMs = ctx.deps.now().getTime();

  const staleFailed = state.entries.filter((e) => isStaleFailedPark(e, nowMs)).map((e) => e.issue);

  for (const issue of staleFailed) {
    const entry = findEntry(next, issue);
    if (!entry || !isStaleFailedPark(entry, nowMs)) continue; // reconciled or expired mid-loop
    const unit = `issue:${issue}`;
    const truth = prPoll.truths.get(issue);
    if (truth === undefined) {
      if (!prPoll.truths.has(issue)) {
        continue; // failed AFTER the poll ran this tick — next cadence picks it up
      }
      next = journalGroundTruthUnreachableIfDue(ctx, next, unit, {
        detail: 'stale-failure reconcile paused until truth returns',
      });
      continue;
    }
    // #632: truth answered this tick — any unreachable streak recorded
    // against a PREVIOUS tick is over.
    next = clearGroundTruthUnreachable(next, unit, ctx.deps.now());

    if (!isPrMerged(truth)) {
      // Still blocked/open/conflicting — stays failed. #632: not "merge seen
      // but not closed" either, so a waiting streak from an earlier tick's
      // merge-then-reverted flicker is over.
      next = clearPrWatchWaiting(next, unit, ctx.deps.now());
      continue;
    }

    if (prPoll.closed.get(issue) !== true) {
      next = journalPrWatchWaitingIfDue(ctx, next, unit, {
        pr: entry.pr,
        mergedAt: truth.mergedAt,
        reason: AUTO_MERGE_BLOCKED_REASON,
        detail: 'stale-failed PR merged but the issue is still open — keep watching',
      });
      continue;
    }

    const failedAt = entry.updated_at;
    next = transitionIssue(next, issue, 'shipped', { reason: null }, ctx.deps.now());
    next = clearPrWatchWaiting(next, unit, ctx.deps.now());
    journal(ctx, 'stale-failure-reconciled', unit, {
      pr: entry.pr,
      mergedAt: truth.mergedAt,
      reason: AUTO_MERGE_BLOCKED_REASON,
      failedAt,
      detail: `PR #${entry.pr} is MERGED and the issue is closed — ledger reconciled failed to shipped (failed at ${failedAt}); teardown and report will now dispatch`,
    });
    ctx.result.staleReconciled.push(unit);

    const unblocked = unblockDependentsOf(ctx, next, issue);
    next = unblocked.state;
    ctx.result.dependentsUnblocked.push(...unblocked.units);
  }
  return next;
}

/**
 * #501: undo `blockTransitiveDependents` for a unit that turned out to have
 * shipped after all. `blockTransitiveDependents` stamps EVERY entry in the
 * transitive closure with the same `dep-failed:<issue>` reason (never a
 * more-specific one per level), so matching that one string recovers the
 * whole closure without re-walking the dependency graph. A `slot`-mode
 * dependent returns to `waiting` (its batch rail), a `full`-mode one to
 * `queued` — both are already-legal edges out of `blocked`.
 */
function unblockDependentsOf(
  ctx: TickCtx,
  state: SchedState,
  issue: number
): { state: SchedState; units: string[] } {
  const depReason = `dep-failed:${issue}`;
  const now = ctx.deps.now();
  let next = state;
  const units: string[] = [];
  for (const entry of state.entries) {
    if (entry.status !== 'blocked' || entry.reason !== depReason) continue;
    const to = entry.mode === 'slot' ? 'waiting' : 'queued';
    next = transitionIssue(next, entry.issue, to, { reason: null }, now);
    const unit = `issue:${entry.issue}`;
    journal(ctx, 'stale-failure-reconciled', unit, {
      detail: `dependency #${issue} actually merged — unblocked from ${depReason}`,
    });
    units.push(unit);
  }
  return { state: next, units };
}

/**
 * Dispatch report agents for merged units whose teardown is recorded (#468
 * AC2): shipped + pr + cleanup + no live slot + free capacity → a slot is
 * assigned (phase AND role `report` — #500) and a mechanical-tier agent
 * spawned with the report prompt. Reports run BEFORE queue refill — a cheap
 * report never queues behind long full-cycle runs. A unit waiting for
 * capacity consumes zero slots (AC5) and is surfaced via `result.reportWaiting`.
 * When `state.paused`, dispatches nothing (#505) — a report agent is a NEW
 * assignment into an idle slot exactly like a fresh full-cycle dispatch, so
 * it rides the same quota/auth wall a dispatch-health (or manual `sched
 * pause`) pause exists to stop; waiting reports still count toward
 * `reportWaiting` so the pause's effect stays visible.
 */
function dispatchReportAgents(ctx: TickCtx, state: SchedState, config: SchedConfig): SchedState {
  if (state.paused) {
    ctx.result.reportWaiting = state.entries.filter(
      (e) =>
        e.status === 'shipped' &&
        e.pr !== null &&
        e.cleanup !== null &&
        slotOf(state, `issue:${e.issue}`) === undefined
    ).length;
    return state;
  }
  let next = state;
  for (const entry of state.entries) {
    if (entry.status !== 'shipped' || entry.pr === null || entry.cleanup === null) continue;
    const unit = `issue:${entry.issue}`;
    if (slotOf(next, unit) !== undefined) continue; // a slot already holds the unit

    if (freeCapacity(next, config) === 0) {
      // Full — the report waits (zero slots consumed). Count what is waiting
      // so the wait is visible, then stop scanning.
      ctx.result.reportWaiting = state.entries.filter(
        (e) =>
          e.status === 'shipped' &&
          e.pr !== null &&
          e.cleanup !== null &&
          slotOf(next, `issue:${e.issue}`) === undefined
      ).length;
      break;
    }

    const now = ctx.deps.now();
    const assigned = assignToIdleSlot(next, unit, 'report', now, 'report');
    next = assigned.state;
    journal(ctx, 'assigned', unit, { slot: assigned.slotId, detail: 'report agent' });
    journal(ctx, 'report-dispatched', unit, {
      slot: assigned.slotId,
      pr: entry.pr,
      cleanup: entry.cleanup,
    });
    ctx.result.reportDispatched.push(unit);
    next = spawnReportAgent(ctx, next, unit);
  }
  return next;
}

/**
 * Run the teardown script for one merged unit OUTSIDE the state lock (#468
 * AC2). Returns null when teardown must be retried next tick (setup info
 * unreachable — a transient outage, never a failure).
 */
function runTeardownFor(deps: EngineDeps, issue: number): TeardownResult | null {
  const info = deps.groundTruth.setupInfo(issue);
  const unit = `issue:${issue}`;
  if (info === undefined) {
    // #633: AUDITED, NOT DEDUPED. This is a tenth site with #632's shape —
    // `teardownPendingIssues` reaches it every tick and a `null` return leaves
    // `cleanup` unset, so an unreachable `setupInfo` re-emits this line once
    // per reconcile interval for as long as the outage lasts.
    //
    // Left as-is deliberately: #632 enumerated nine sites and its plan makes
    // the boundary load-bearing ("a site outside the table is a NEW issue, not
    // a reason to widen this one") — widening is what dissolved b-07. The fix
    // is tracked in #636, and is not a one-liner here: `runTeardownFor` runs
    // OUTSIDE the store lock and has no `SchedState` to patch, so the marker
    // has to be threaded through the caller's second lock pass.
    deps.journal.append(
      unitEvent('ground-truth-unreachable', unit, {
        detail: 'teardown paused until truth returns',
      }),
      deps.now()
    );
    return null;
  }
  if (info === null) {
    return {
      cleanup: 'failed-missing-setup-info',
      detail: 'no setup milestone with worktree= found on the issue',
    };
  }
  return runTeardown(deps.teardownExec, deps.repoDir, info);
}

/** Phase 3: refill — every freed slot is filled in THIS tick (AC5). */
function dispatchAssignments(
  ctx: TickCtx,
  state: SchedState,
  config: SchedConfig,
  labelVerifiedIssues: ReadonlySet<number>
): SchedState {
  const now = ctx.deps.now();
  // #544: `pollLabels` reads only the first `max_slots` runnable units — the
  // ceiling on what this pass can place — which keeps the per-tick `gh` cost
  // proportional to the SLOT count instead of the backlog. That cap is exact
  // while nothing is blocked: `freeCapacity <= max_slots`, and blocking
  // nothing preserves the candidate order, so every unit placed below was
  // read. The moment this tick DID block something, the cap stops being
  // exact — a unit that sat outside the read window slides into range unread
  // — so those unverified units are deferred for one tick rather than
  // dispatched on stale information. They are inside the next tick's read
  // window, so the cost is one tick of latency in the rare labelled case, and
  // nothing at all in the common one (#525 AC5's same-tick refill is
  // untouched when no label moved).
  const exclude =
    ctx.result.labelBlocked.length > 0
      ? new Set(
          state.entries
            .filter((entry) => !labelVerifiedIssues.has(entry.issue))
            .map((entry) => `issue:${entry.issue}`)
        )
      : new Set<string>();
  // #565: decide who wins each free slot over BOTH kinds — a ready batch
  // outranking a same-readiness issue (priority desc → readiness age → issue
  // number, `runnableUnits`) must not lose its capacity to an issue dispatch
  // pass that never looked at it. This is a READ-ONLY dry run: `assigned`
  // (the mutated state) is discarded — applying its batch-kind assignment
  // would leave a slot permanently `assigned` to `batch:<id>` with no agent
  // ever spawned, since only `batch-dispatch.ts`'s own `claimAndSetup` does
  // the actual worktree/branch setup, and it skips a batch that already
  // holds a slot (`slotFor`). Only the ISSUE winners are applied below,
  // against the ORIGINAL `state` — the batch-dispatch pass later this same
  // tick claims the capacity this reservation left free (module doc: batch
  // claims never go through `computeAssignments` themselves).
  //
  // The reservation is gated on the batch pass actually running this tick
  // (`batchExec`/`runBatchSuite` both configured, mirroring the guard at the
  // batch-pass call site below): without that gate, a `ready` batch with
  // nothing ever able to claim it would reserve a slot every tick forever —
  // not a one-tick wait, a permanent one, contradicting the batch pass's own
  // documented fallback ("a `ready` batch stays queued", never "queued AND
  // blocks other work").
  const batchPassWillRun = ctx.deps.batchExec !== undefined && ctx.deps.runBatchSuite !== undefined;
  const dryRunKinds = batchPassWillRun ? (['issue', 'batch'] as const) : (['issue'] as const);
  const { assignments } = computeAssignments(state, config, now, dryRunKinds, exclude);
  let next = state;
  for (const assignment of assignments) {
    if (assignment.kind !== 'issue') continue;
    const unit = `issue:${assignment.issue}`;
    const entry = findEntry(next, assignment.issue);
    if (!entry) continue;
    const { state: withSlot, slotId } = assignToIdleSlot(next, unit, null, now);
    next = withSlot;
    journal(ctx, 'assigned', unit, { slot: slotId, priority: entry.priority });
    if (entry.status === 'queued') {
      next = transitionIssue(next, assignment.issue, 'classified', {}, now);
    }
    next = transitionIssue(next, assignment.issue, 'dispatched', {}, now);
    next = spawnUnit(ctx, next, unit);
  }
  return next;
}

/** Entries freshly shipped whose teardown has not run yet (cleanup still null). */
function teardownPendingIssues(state: SchedState): number[] {
  return state.entries
    .filter((e) => e.status === 'shipped' && e.pr !== null && e.cleanup === null)
    .map((e) => e.issue);
}

/** Record teardown results on their entries + journal (the lock pass after the subprocesses). */
function recordTeardowns(
  ctx: TickCtx,
  state: SchedState,
  results: Map<number, TeardownResult>
): SchedState {
  const now = ctx.deps.now();
  let next = state;
  for (const [issue, result] of results) {
    const unit = `issue:${issue}`;
    next = {
      ...next,
      entries: next.entries.map((e) =>
        e.issue === issue ? { ...e, cleanup: result.cleanup, updated_at: now.toISOString() } : e
      ),
    };
    journal(ctx, result.cleanup === 'done' ? 'teardown-done' : 'teardown-failed', unit, {
      cleanup: result.cleanup,
      detail: result.detail,
    });
    if (result.cleanup === 'done') ctx.result.teardownDone.push(unit);
    else ctx.result.teardownFailed.push(unit);
  }
  return next;
}

/**
 * One full reconcile+refill cycle. Ground truth is polled WITHOUT the lock
 * (live units AND parked PRs); every state mutation happens under
 * `store.withLock`; refills are computed in the same pass, so a freed slot
 * is reused within this tick (AC5). Teardown subprocesses run between two
 * short lock passes — a slow `npx`/`git` call never holds the lock.
 */
export function tick(deps: EngineDeps, config: SchedConfig): TickResult {
  const dispatch = resolveDispatch(config);
  const state0 = deps.store.load();
  const polled = pollUnits(deps, state0);
  const prPoll = pollParkedPrs(deps, state0, dispatch);
  const labelPoll = pollLabels(deps, state0, config, dispatch);
  const labelVerifiedIssues = labelVerified(labelPoll);

  const pass1 = deps.store.withLock((state) => {
    const ctx: TickCtx = { deps, dispatch, result: emptyResult() };
    let next = reconcileSlots(ctx, state, polled);
    next = reconcileParked(ctx, next, prPoll);
    next = reconcileStaleFailedParks(ctx, next, prPoll);
    next = requeueOrphanedDispatches(ctx, next);
    next = dispatchReportAgents(ctx, next, config);
    // #544: immediately before the dispatch pass, so a cleared label can be
    // dispatched this same tick and a fresh one can never be dispatched over.
    next = reconcileLabelBlocks(ctx, next, labelPoll);
    next = dispatchAssignments(ctx, next, config, labelVerifiedIssues);
    return {
      state: next,
      result: { tick: ctx.result, teardownPending: teardownPendingIssues(next) },
    };
  });

  let result = pass1.tick;

  if (pass1.teardownPending.length > 0) {
    // Teardown subprocesses (pool return / worktree remove) run OUTSIDE the
    // lock; results land in a second short lock pass together with the report
    // dispatch (AC2: teardown, THEN the cheap-tier report agent).
    const results = new Map<number, TeardownResult>();
    for (const issue of pass1.teardownPending) {
      const teardownResult = runTeardownFor(deps, issue);
      if (teardownResult !== null) results.set(issue, teardownResult);
    }
    if (results.size > 0) {
      result = deps.store.withLock((state) => {
        const ctx: TickCtx = { deps, dispatch, result };
        const next = recordTeardowns(ctx, state, results);
        const withReport = dispatchReportAgents(ctx, next, config);
        return { state: withReport, result: ctx.result };
      });
    }
  }

  // Batch dispatch (#523) — a separate pass, deliberately after issue dispatch:
  // `runBatchTick` never goes through `computeAssignments`/`runnableUnits` for
  // its OWN claim (batch-dispatch.ts's own bespoke free-capacity-gated claim,
  // mirroring `dispatchReportAgents`) — a batch's worktree/branch setup has
  // no per-issue equivalent, so its claim stays a distinct code path. The
  // capacity split between the two passes is no longer pure PASS ORDERING,
  // though (#565): `dispatchAssignments` above already consulted
  // `computeAssignments` over BOTH kinds and applied only the issue winners,
  // reserving a free slot here for any ready batch that outranked a
  // same-readiness issue in that ordering — so a higher-priority batch is
  // NOT starved by issue dispatch this same tick, closing the gap
  // `docs/reports/batch-pilot-2-execution.md` §13.4 found. What IS still
  // true: this pass never claims a slot `dispatchAssignments` already gave to
  // an issue — the reservation is the only coupling between the two passes.
  // Only runs when the operator configured batch exec deps; without them a
  // `ready` batch stays queued (visible in `sched status`) rather than
  // crashing.
  if (deps.batchExec !== undefined && deps.runBatchSuite !== undefined) {
    const batchDeps: BatchDispatchDeps = {
      store: deps.store,
      journal: deps.journal,
      groundTruth: deps.groundTruth,
      spawnDeps: deps.spawnDeps,
      now: deps.now,
      repoDir: deps.repoDir,
      exec: deps.batchExec,
      runSuite: deps.runBatchSuite,
      homeDir: deps.homeDir,
      ...(deps.runBatchCapability !== undefined ? { runCapability: deps.runBatchCapability } : {}),
      ...(deps.batchWarmExec !== undefined ? { warmExec: deps.batchWarmExec } : {}),
    };
    const batchResult = runBatchTick(batchDeps, config, dispatch);
    result = mergeBatchResult(result, batchResult);
  }

  return result;
}

/** Fold a `BatchTickResult` into the issue-oriented `TickResult` — same unit-id-shaped arrays, one extra source. */
function mergeBatchResult(result: TickResult, batch: BatchTickResult): TickResult {
  return {
    ...result,
    spawned: [...result.spawned, ...batch.spawned],
    completed: [...result.completed, ...batch.completed],
    parked: [...result.parked, ...batch.parked],
    mergeAccepted: [...result.mergeAccepted, ...batch.mergeAccepted],
    failed: [...result.failed, ...batch.failed],
    blocked: [...result.blocked, ...batch.blocked],
  };
}

/**
 * The long-running loop behind `sched start`: tick, sleep, repeat. Returns
 * when `shouldStop()` says so (the CLI wires SIGINT). A failed tick is
 * journaled (`tick-failed`, with the error name — `LockTimeoutError` and
 * `CorruptStateError` demand different operator actions) and reported on
 * stderr, and the loop continues — one bad tick (e.g. a transient gh
 * failure) never stops the scheduler.
 */
export async function runLoop(
  deps: EngineDeps,
  config: SchedConfig,
  shouldStop: () => boolean,
  onTick?: (result: TickResult) => void
): Promise<void> {
  const interval = resolveDispatch(config).reconcileIntervalMs;
  while (!shouldStop()) {
    try {
      const result = tick(deps, config);
      onTick?.(result);
    } catch (err) {
      const detail = `${(err as Error).name}: ${(err as Error).message}`;
      process.stderr.write(`⚠ sched tick failed: ${detail}\n`);
      deps.journal.append({ event: 'tick-failed', detail }, deps.now());
    }
    if (shouldStop()) break;
    await sleep(interval, shouldStop);
  }
}

function sleep(ms: number, shouldStop: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      clearInterval(stopCheck);
      resolve();
    }, ms);
    const stopCheck = setInterval(
      () => {
        if (shouldStop()) {
          clearTimeout(timer);
          clearInterval(stopCheck);
          resolve();
        }
      },
      Math.min(STOP_POLL_MAX_MS, Math.max(STOP_POLL_MIN_MS, Math.floor(ms / 10)))
    );
    // NEVER unref these handles (#679). They are what holds the event loop
    // open between ticks: spawned agents are detached and unref'd on purpose
    // (dispatch.ts), so if the sleep timers are unref'd too, nothing keeps
    // the process alive once a tick's async work settles — the loop drains
    // and `sched start` exits cleanly after its first tick, silently
    // behaving like `--once`. Ref'd timers cost nothing here: SIGINT still
    // stops the engine promptly, because the ref'd stop-check polls
    // shouldStop() and resolves this sleep early.
  });
}
