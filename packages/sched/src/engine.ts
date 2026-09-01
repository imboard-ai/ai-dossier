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
 *    reconcile+refill for every `batch:<id>` unit, run after steps 1-3 so a
 *    batch never takes a slot an issue would otherwise have gotten this tick.
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

import * as path from 'node:path';
import type { BatchDispatchDeps, BatchTickResult } from './batch-dispatch';
import { runBatchTick } from './batch-dispatch';
import {
  buildPrompt,
  buildReportPrompt,
  buildTierCommand,
  dispatchLogPath,
  escalateTier,
  fileSizeOrZero,
  type ResolvedDispatch,
  reportTierFor,
  resolveDispatch,
  type SpawnDeps,
  STOP_POLL_MAX_MS,
  STOP_POLL_MIN_MS,
  stallTimeoutForSlot,
} from './dispatch';
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
import type { SchedStore } from './persist';
import type { ExecFn } from './project';
import {
  appendSchedRunLog,
  buildSchedRunLogEntry,
  readDispatchLog,
  schedRunsLogPath,
  schedTelemetryEnabled,
} from './run-log';
import { assignToIdleSlot, computeAssignments, freeCapacity, setPaused } from './scheduler';
import { findEntry, isReportSlot, transitionIssue, transitionSlot } from './state';
import { runTeardown, type TeardownResult } from './teardown';
import {
  DISPATCH_UNHEALTHY_THRESHOLD,
  ESCALATION_CAP,
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
 * Metadata patch on a slot WITHOUT a status transition (pid/phase/branch/
 * last_head/last_progress are data, not machine states — RFC-0001 §D.3 keeps
 * them alongside the status, and the transition tables stay pure).
 */
function patchSlot(
  state: SchedState,
  slotId: number,
  patch: Partial<SlotEntry>,
  now: Date
): SchedState {
  return {
    ...state,
    slots: state.slots.map((s) =>
      s.id === slotId ? { ...s, ...patch, updated_at: now.toISOString() } : s
    ),
  };
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
    cmd: string[];
    model: string | null;
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
    pid = ctx.deps.spawnDeps.spawn(opts.cmd, opts.prompt, logFile);
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
    cmd: opts.cmd.join(' '),
    ...(opts.model !== null ? { model: opts.model } : {}),
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
    cmd: buildTierCommand(ctx.dispatch, entry.tier, issue),
    model: ctx.dispatch.tiers[entry.tier].model,
    // The slot's generation reaches the agent here (#504): a takeover is told which
    // generation it owns, so its own `runstate post --gen` is accepted while the run it
    // replaced is refused. A first dispatch is generation 0 and reads as it always did.
    prompt: buildPrompt(ctx.dispatch.prompt, issue, slot.gen),
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
    cmd: buildTierCommand(ctx.dispatch, tier, issue),
    model: ctx.dispatch.tiers[tier].model,
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
  opts: { merged?: boolean } = {}
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
      journal(ctx, 'report-failed', unit, { reason });
      releaseReason = 'report-failed';
    } else {
      next = transitionIssue(next, issue, 'failed', { reason }, now);
      journal(ctx, 'unit-failed', unit, { reason });
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
  causeEvent: 'stalled' | 'verify-incomplete',
  cause: string,
  truth: UnitTruth,
  evidence: Record<string, unknown> = {}
): SchedState {
  const issue = issueOfUnit(unit);
  if (issue === null) return state;
  const now = ctx.deps.now();
  const entry = findEntry(state, issue);
  const slot = slotOf(state, unit);
  if (!entry || !slot) return state;

  killUnitAgent(ctx, state, unit);
  // #524: only the STALL path kills a still-live, not-yet-recorded agent —
  // `causeEvent === 'verify-incomplete'` arrives from `completeUnitOrRecover`
  // AFTER the agent's exit was already detected and recorded by the dead-pid
  // branch of `reconcileRunning`; recording again here would double-count
  // that same dispatch.
  if (causeEvent === 'stalled') {
    recordDispatchRunLog(ctx, state, slot, unit);
  }

  const report = isReportSlot(slot);
  const nextTier = report ? reportTierFor(slot.recoveries + 1) : escalateTier(entry.tier);
  if (slot.recoveries >= ESCALATION_CAP || nextTier === null) {
    // Cap reached (2 escalations) or already at the strongest tier — the
    // designed signal that a human, not a stronger model, is next.
    const reason = report
      ? 'report-escalation-cap'
      : slot.recoveries >= ESCALATION_CAP
        ? 'escalation-cap'
        : `${cause}-at-strongest-tier`;
    return failUnit(ctx, state, unit, reason, { merged: report });
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
      recoveries: slot.recoveries + 1,
      gen: fenced ?? slot.gen,
      // Only a fence that actually landed starts the short takeover watch: an
      // unfenced redispatch is already degraded, and cutting its allowance down
      // would compound one failure with another.
      fenced_at: fenced === null ? null : now.toISOString(),
    },
    now
  );
  if (!report) {
    next = {
      ...next,
      entries: next.entries.map((e) =>
        e.issue === issue ? { ...e, tier: nextTier, updated_at: now.toISOString() } : e
      ),
    };
  }
  journal(ctx, causeEvent, unit, {
    detail: cause,
    slot: slot.id,
    ...(slot.last_progress_at !== null ? { last_progress_at: slot.last_progress_at } : {}),
    ...evidence,
  });
  journal(ctx, 'redispatched', unit, {
    tier: nextTier,
    slot: slot.id,
    cmd: buildTierCommand(ctx.dispatch, nextTier, issue).join(' '),
    ...(ctx.dispatch.tiers[nextTier].model !== null
      ? { model: ctx.dispatch.tiers[nextTier].model }
      : {}),
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
 * Park a unit whose agent exited after parking its PR on auto-merge (#468):
 * the exit is VERIFIED (the ship phase's `awaiting-merge` milestone with
 * `pr=`), entry → parked (pr recorded), slot released — a waiting unit
 * consumes zero slots (AC5) and the watcher owns it from here.
 */
function parkUnit(
  ctx: TickCtx,
  state: SchedState,
  unit: string,
  milestone: GroundTruthMilestone
): SchedState {
  const issue = issueOfUnit(unit);
  if (issue === null) return state;
  const now = ctx.deps.now();
  const pr = prOfMilestone(milestone);
  if (pr === null) return state; // isParkedMilestone guarantees this

  const walked = walkSlotToIdle(state, unit, now, stepVerifiedExitToIdle);
  let next = walked.state;

  next = transitionIssue(next, issue, 'parked', { pr }, now);
  journal(ctx, 'pr-parked', unit, { pr });
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
    journal(ctx, 'progress', unit, {
      slot: slot.id,
      detail: truth.milestone
        ? `milestone ${truth.milestone.phase}/${truth.milestone.status}`
        : 'new pushed commit',
    });
  }
  return { state: next, progressed };
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
): void {
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
    return;
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
    return;
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
  const cmd = buildTierCommand(ctx.dispatch, tier, issue);
  const logFile = dispatchLogPath(ctx.deps.store.runsDir, unit);

  // #524: read only THIS dispatch's slice — the log is per-unit and
  // append-mode, so the whole file would include every prior dispatch's
  // output too (claude: unparseable JSON concatenation; opencode: summed
  // tokens double-counted).
  const offset = slot.log_offset_at_spawn ?? 0;
  const logContent = readDispatchLog(logFile, offset);
  const runLogFile = schedRunsLogPath(ctx.deps.homeDir);

  const runEntry = buildSchedRunLogEntry({
    unit,
    role: slot.role,
    cmd0: cmd[0],
    cmd,
    logContent,
    spawnedAt: slot.spawned_at,
    completedAt: ctx.deps.now(),
    configuredModel: ctx.dispatch.tiers[tier].model,
    cwd: ctx.deps.repoDir,
  });

  // An entry with null tokens has four possible causes that look identical in
  // `sched stats` (a row of dashes). Journal WHICH one, so an operator can
  // tell "the agent wrote nothing" from "we couldn't read the log" without
  // re-deriving it from the log file's mtime.
  if (runEntry.input_tokens === null && runEntry.output_tokens === null) {
    journal(ctx, 'run-log-no-usage', unit, {
      log: logFile,
      offset,
      bytes: logContent === null ? null : logContent.length,
      reason:
        logContent === null
          ? 'log-unreadable'
          : logContent.trim() === ''
            ? 'log-empty'
            : 'no-usage-events',
    });
  }

  if (!schedTelemetryEnabled(ctx.deps.homeDir)) {
    // The operator opted out. Journal it: otherwise a missing runs.jsonl entry
    // is indistinguishable from a lost one.
    journal(ctx, 'run-log-skipped', unit, { reason: 'telemetry-disabled' });
    return;
  }

  const written = appendSchedRunLog(runEntry, ctx.deps.homeDir, (err) =>
    journal(ctx, 'run-log-failed', unit, { detail: err.message, file: runLogFile })
  );
  if (written) {
    journal(ctx, 'run-log-recorded', unit, {
      file: runLogFile,
      input_tokens: runEntry.input_tokens,
      output_tokens: runEntry.output_tokens,
    });
  }
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
    recordDispatchRunLog(ctx, state, slot, unit);
    const exited = transitionSlot(state, slot.id, 'exited', {}, now);
    return completeUnitOrRecover(ctx, exited, unit, truth, 'verify-complete');
  }

  // The milestone poll FAILED (gh outage, missing binary) — unreachable is NOT
  // known-absent (decision 2, option A): stall and advance decisions pause for
  // this unit until truth returns. The dead-pid rail above still ran — local
  // truth needs no network.
  if (!truth.reachable) {
    journal(ctx, 'ground-truth-unreachable', unit, {
      slot: slot.id,
      detail: 'stall/advance decisions paused until truth returns',
    });
    return state;
  }

  // Ground truth says the unit is DONE while the agent still holds the slot —
  // externally-advanced state (AC3): reclaim the slot, kill the leftover agent.
  // A parked milestone is deliberately NOT an advance: a detached run parks
  // and stops — the watcher owns the tail (#468); the exit/stall rails take
  // the agent from here.
  if (
    isVerifiedComplete(truth.milestone, effectiveClosedSignal(slot, truth)) &&
    !isParkedMilestone(truth.milestone)
  ) {
    journal(ctx, 'external-advance', unit, {
      pid: slot.pid,
      slot: slot.id,
      // effectiveClosedSignal, not the raw truth.closed, decided this: for a
      // report-role slot `closed` is suppressed, so `truth.closed` reads true
      // at completion regardless — the actual signal was the report milestone.
      detail: effectiveClosedSignal(slot, truth)
        ? 'issue closed'
        : `report done (role=${slot.role})`,
    });
    killUnitAgent(ctx, state, unit);
    // The agent was still alive (that's what "externally-advanced" means) —
    // log it here too, or an external-advance dispatch would never get a
    // runs.jsonl entry at all (it never takes the dead-pid branch above).
    recordDispatchRunLog(ctx, state, slot, unit);
    const exited = transitionSlot(state, slot.id, 'exited', {}, now);
    return completeUnitOrRecover(ctx, exited, unit, truth, 'external-advance');
  }

  const progress = applyProgressSignals(ctx, state, slot, truth, unit);
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
  via: 'verify-complete' | 'external-advance'
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
    journal(ctx, 'ground-truth-unreachable', unit, {
      slot: slot.id,
      detail: 'exit verification paused until truth returns',
    });
    return next;
  }

  const issue = issueOfUnit(unit);
  const entry = issue !== null ? findEntry(next, issue) : undefined;
  // A verified park: the agent exited having parked its PR — the watcher
  // takes the unit (AC2's "never inferred from agent exit" cut both ways:
  // the park IS the milestone, the merge is not).
  if (entry !== undefined && entry.status === 'dispatched' && isParkedMilestone(truth.milestone)) {
    // A verified park is also proof dispatch is healthy (#505) — reset the
    // streak exactly like the sibling `completeUnit` branch below, or a
    // healthy park sandwiched between two unrelated units' suspect exits
    // would be invisible to the cross-unit correlation and could still tip
    // it into a false-positive pause.
    return parkUnit(
      ctx,
      recordDispatchOutcome(ctx, next, unit, slot, false),
      unit,
      truth.milestone
    );
  }

  if (isVerifiedComplete(truth.milestone, effectiveClosedSignal(slot, truth))) {
    return completeUnit(ctx, recordDispatchOutcome(ctx, next, unit, slot, false), unit, via);
  }

  const suspect = msSinceLastProgress(slot, now) < SUSPECT_DISPATCH_WINDOW_MS;
  next = recordDispatchOutcome(ctx, next, unit, slot, suspect);
  return enterRecovery(ctx, next, unit, 'verify-incomplete', 'unverified-exit', truth, {
    observed: truth.milestone
      ? `milestone ${truth.milestone.phase}/${truth.milestone.status}; closed=${truth.closed}`
      : `no milestone; closed=${truth.closed}`,
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
        next = completeUnitOrRecover(ctx, next, unit, truth, 'verify-complete');
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
    next = transitionIssue(next, entry.issue, 'queued', { reason: null }, now);
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
      journal(ctx, 'ground-truth-unreachable', unit, {
        detail: 'pr watch paused until truth returns',
      });
      continue;
    }

    const failWatch = (reason: string): SchedState => {
      journal(ctx, 'pr-watch-failed', unit, { reason, pr: entry.pr });
      return failUnit(ctx, next, unit, reason);
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
        journal(ctx, 'pr-watch-waiting', unit, {
          pr: entry.pr,
          mergedAt: truth.mergedAt,
          detail: 'merge seen but issue not closed — keep watching',
        });
        continue;
      }
      next = transitionIssue(next, issue, 'shipped', { reason: null }, ctx.deps.now());
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
    }
    // OPEN (or mergeable UNKNOWN) — keep watching.
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
      journal(ctx, 'ground-truth-unreachable', unit, {
        detail: 'stale-failure reconcile paused until truth returns',
      });
      continue;
    }

    if (!isPrMerged(truth)) continue; // still blocked/open/conflicting — stays failed

    if (prPoll.closed.get(issue) !== true) {
      journal(ctx, 'pr-watch-waiting', unit, {
        pr: entry.pr,
        mergedAt: truth.mergedAt,
        reason: AUTO_MERGE_BLOCKED_REASON,
        detail: 'stale-failed PR merged but the issue is still open — keep watching',
      });
      continue;
    }

    const failedAt = entry.updated_at;
    next = transitionIssue(next, issue, 'shipped', { reason: null }, ctx.deps.now());
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
function dispatchAssignments(ctx: TickCtx, state: SchedState, config: SchedConfig): SchedState {
  const now = ctx.deps.now();
  const { state: assigned, assignments } = computeAssignments(state, config, now, ['issue']);
  let next = assigned;
  for (const assignment of assignments) {
    if (assignment.kind !== 'issue') continue;
    const unit = `issue:${assignment.issue}`;
    journal(ctx, 'assigned', unit, { slot: assignment.slot });
    const entry = findEntry(next, assignment.issue);
    if (!entry) continue;
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

  const pass1 = deps.store.withLock((state) => {
    const ctx: TickCtx = { deps, dispatch, result: emptyResult() };
    let next = reconcileSlots(ctx, state, polled);
    next = reconcileParked(ctx, next, prPoll);
    next = reconcileStaleFailedParks(ctx, next, prPoll);
    next = requeueOrphanedDispatches(ctx, next);
    next = dispatchReportAgents(ctx, next, config);
    next = dispatchAssignments(ctx, next, config);
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
  // `runBatchTick` never goes through `computeAssignments`/`runnableUnits` at
  // all (batch-dispatch.ts's own bespoke free-capacity-gated claim, mirroring
  // `dispatchReportAgents`) — the ordering guarantee here comes from PASS
  // ORDERING plus that per-claim `freeCapacity` gate: this pass runs strictly
  // after `dispatchAssignments` already filled every slot it could, so a
  // batch never takes a slot an issue would otherwise have gotten this same
  // tick. Only runs when the operator configured batch exec deps; without
  // them a `ready` batch stays queued (visible in `sched status`) rather than
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
      ...(deps.runBatchCapability !== undefined ? { runCapability: deps.runBatchCapability } : {}),
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
    if (typeof timer.unref === 'function') timer.unref();
    if (typeof stopCheck.unref === 'function') stopCheck.unref();
  });
}
