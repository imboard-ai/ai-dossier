/**
 * The scheduler engine (#464): dispatch, completion verification, and the
 * stall/escalation ladder (RFC-0001 §C.1) — the deterministic organs that
 * replace fleet-cycle's LLM supervision.
 *
 * One `tick()` is a full reconcile+refill cycle:
 *
 * 1. **Poll** ground truth for every live unit OUTSIDE the state lock (gh/git
 *    subprocesses are slow; the lock must never wait on a network call).
 * 2. **Apply** under `SchedStore.withLock`:
 *    - `assigned` slots (crash between assign and spawn) are spawned/re-attached
 *    - `running` slots: dead pid → exit rail; ground truth says complete →
 *      external advance (kill the leftover agent, complete); new milestone or
 *      pushed commit → progress; no progress for `stall_timeout_ms` →
 *      redispatch one tier stronger (cap 2, then failed)
 *    - `exited`/`verifying` slots: the agent exited — completion is verified
 *      against ground truth, never assumed (AC2); unverified exits ride the
 *      same recovery ladder as stalls
 *    - `recovering` slots: respawned with the escalated tier (resume rails —
 *      the agent re-enters via gate and resumes from the milestone trail)
 *    - failures block their TRANSITIVE dependents (AC4)
 * 3. **Refill**: `computeAssignments` fills every freed slot in the SAME tick —
 *    a runnable unit never waits while a slot is idle (AC5).
 *
 * Everything that touches the world (processes, GitHub, git) is injected;
 * the state machine is pure. Only `issue:<n>` units are dispatched — batch
 * member sequencing is a follow-up (#464 non-goal).
 */

import * as path from 'node:path';
import {
  buildAgentCommand,
  buildPrompt,
  escalateTier,
  type ResolvedDispatch,
  resolveDispatch,
  type SpawnDeps,
  STOP_POLL_MAX_MS,
  STOP_POLL_MIN_MS,
  unitLogName,
} from './dispatch';
import { type GroundTruth, type GroundTruthMilestone, isVerifiedComplete } from './groundtruth';
import { issueOfUnit, type Journal, unitEvent } from './journal';
import type { SchedStore } from './persist';
import { computeAssignments } from './scheduler';
import { findEntry, transitionIssue, transitionSlot } from './state';
import {
  ESCALATION_CAP,
  type JournalEventName,
  type SchedConfig,
  type SchedState,
  type SlotEntry,
  type SlotStatus,
  TERMINAL_ISSUE_STATUSES,
} from './types';

export interface EngineDeps {
  store: SchedStore;
  journal: Journal;
  groundTruth: GroundTruth;
  spawnDeps: SpawnDeps;
  now: () => Date;
}

/** What one tick did — surfaced by `sched start`. */
export interface TickResult {
  /** Units spawned this tick (first dispatch or redispatch). */
  spawned: string[];
  /** Units completed by external ground truth while their agent was still alive. */
  externalAdvances: string[];
  /** Units verified complete after an observed exit. */
  completed: string[];
  /** Units redispatched one tier stronger (stall or unverified exit). */
  redispatched: string[];
  /** Units failed (escalation cap / strongest tier / spawn error). */
  failed: string[];
  /** Issues blocked transitively by a failure. */
  blocked: number[];
}

function emptyResult(): TickResult {
  return {
    spawned: [],
    externalAdvances: [],
    completed: [],
    redispatched: [],
    failed: [],
    blocked: [],
  };
}

/** Ground-truth snapshot for one unit, gathered outside the lock. */
interface UnitTruth {
  milestone: GroundTruthMilestone | null;
  closed: boolean;
  head: string | null;
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

/** Walk a slot to `idle` one declared edge per iteration; `step` picks the next status. */
function walkSlotToIdle(
  state: SchedState,
  unit: string,
  now: Date,
  step: (status: SlotStatus) => SlotStatus
): SchedState {
  let next = state;
  let slot = slotOf(next, unit);
  while (slot && slot.status !== 'idle') {
    next = transitionSlot(next, slot.id, step(slot.status), {}, now);
    slot = slotOf(next, unit);
  }
  return next;
}

/** Kill the agent holding `unit`'s slot, if it is alive. */
function killUnitAgent(ctx: TickCtx, state: SchedState, unit: string): void {
  const slot = slotOf(state, unit);
  if (slot && slot.pid !== null && ctx.deps.spawnDeps.isAlive(slot.pid)) {
    ctx.deps.spawnDeps.kill(slot.pid);
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
    out.set(slot.unit, {
      milestone: deps.groundTruth.latestMilestone(issue),
      closed: deps.groundTruth.issueClosed(issue),
      head: slot.branch !== null ? deps.groundTruth.branchHead(slot.branch) : null,
    });
  }
  return out;
}

// --- Spawn / fail / complete ---

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

  const cmd = buildAgentCommand(ctx.dispatch.command, entry.tier, issue, ctx.dispatch.tierModels);
  const prompt = buildPrompt(ctx.dispatch.prompt, issue);
  const logFile = path.join(ctx.deps.store.runsDir, `${unitLogName(unit)}.log`);

  let pid: number;
  try {
    pid = ctx.deps.spawnDeps.spawn(cmd, prompt, logFile);
  } catch (err) {
    // A spawn failure fails the unit through the declared failure rail —
    // visible in `sched status` (Failed: … spawn-error) instead of aborting
    // the whole tick and silently discarding every other unit's reconcile.
    return failUnit(ctx, state, unit, `spawn-error: ${(err as Error).message}`);
  }

  const now = ctx.deps.now();
  const patch = { pid, phase: 'gate', last_progress_at: now.toISOString() };
  const next =
    slot.status === 'assigned' || slot.status === 'recovering'
      ? transitionSlot(state, slot.id, 'running', patch, now)
      : patchSlot(state, slot.id, patch, now);

  journal(ctx, 'spawned', unit, {
    pid,
    tier: entry.tier,
    slot: slot.id,
    cmd: cmd.join(' '),
    log: logFile,
  });
  ctx.result.spawned.push(unit);
  return next;
}

/** Fail a unit: entry → failed, slot released, transitive dependents blocked (AC4). */
function failUnit(ctx: TickCtx, state: SchedState, unit: string, reason: string): SchedState {
  const issue = issueOfUnit(unit);
  if (issue === null) return state;
  const now = ctx.deps.now();

  killUnitAgent(ctx, state, unit);
  let next = releaseSlotViaFailure(ctx, state, unit);

  const entry = findEntry(next, issue);
  if (entry && !TERMINAL_ISSUE_STATUSES.has(entry.status)) {
    next = transitionIssue(next, issue, 'failed', { reason }, now);
    journal(ctx, 'unit-failed', unit, { reason });
    ctx.result.failed.push(unit);

    const blocked = blockTransitiveDependents(ctx, next, issue);
    next = blocked.state;
    ctx.result.blocked.push(...blocked.issues);
  }
  return next;
}

/** Release a unit's slot to idle through the failure rail (failed → idle). */
function releaseSlotViaFailure(ctx: TickCtx, state: SchedState, unit: string): SchedState {
  return walkSlotToIdle(state, unit, ctx.deps.now(), (status) =>
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
    killUnitAgent(ctx, next, unit);
    next = releaseSlotViaFailure(ctx, next, unit);

    next = transitionIssue(next, issue, 'blocked', { reason }, now);
    journal(ctx, 'dependents-blocked', unit, { reason });
    blockedIssues.push(issue);
  }
  return { state: next, issues: blockedIssues };
}

/**
 * The recovery decision for a unit that must be redispatched one tier
 * stronger (stall or unverified exit, AC4). At the escalation cap or the
 * strongest tier, the unit fails instead — the designed signal that a human,
 * not a stronger model, is next.
 */
function enterRecovery(
  ctx: TickCtx,
  state: SchedState,
  unit: string,
  causeEvent: 'stalled' | 'verify-incomplete',
  cause: string,
  evidence: Record<string, unknown> = {}
): SchedState {
  const issue = issueOfUnit(unit);
  if (issue === null) return state;
  const now = ctx.deps.now();
  const entry = findEntry(state, issue);
  const slot = slotOf(state, unit);
  if (!entry || !slot) return state;

  killUnitAgent(ctx, state, unit);

  const nextTier = escalateTier(entry.tier);
  if (slot.recoveries >= ESCALATION_CAP || nextTier === null) {
    // Cap reached (2 escalations) or already at the strongest tier — the
    // designed signal that a human, not a stronger model, is next.
    const reason =
      slot.recoveries >= ESCALATION_CAP ? 'escalation-cap' : `${cause}-at-strongest-tier`;
    return failUnit(ctx, state, unit, reason);
  }

  let next = transitionSlot(
    state,
    slot.id,
    'recovering',
    { pid: null, recoveries: slot.recoveries + 1 },
    now
  );
  next = {
    ...next,
    entries: next.entries.map((e) =>
      e.issue === issue ? { ...e, tier: nextTier, updated_at: now.toISOString() } : e
    ),
  };
  journal(ctx, causeEvent, unit, {
    detail: cause,
    slot: slot.id,
    ...(slot.last_progress_at !== null ? { last_progress_at: slot.last_progress_at } : {}),
    ...evidence,
  });
  journal(ctx, 'redispatched', unit, { tier: nextTier, slot: slot.id });
  ctx.result.redispatched.push(unit);
  // Respawn immediately on the recovering rail — recovering → running.
  return spawnUnit(ctx, next, unit);
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

  // Walk the slot machine to idle through its declared edges: complete is
  // reachable only via exited → verifying → complete → idle.
  let next = walkSlotToIdle(state, unit, now, (status) => {
    if (status === 'complete' || status === 'failed') return 'idle';
    if (status === 'running') return 'exited';
    if (status === 'exited') return 'verifying';
    if (status === 'verifying') return 'complete';
    return 'failed'; // assigned/recovering: nothing verified yet — never wedge
  });

  const entry = findEntry(next, issue);
  if (entry && entry.status === 'dispatched') {
    next = transitionIssue(next, issue, 'shipped', {}, now);
    next = transitionIssue(next, issue, 'done', {}, now);
  } else if (entry && entry.status === 'shipped') {
    next = transitionIssue(next, issue, 'done', {}, now);
  }

  journal(ctx, via, unit);
  if (via === 'external-advance') ctx.result.externalAdvances.push(unit);
  else ctx.result.completed.push(unit);
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
    next = patchSlot(next, slot.id, { last_progress_at: now.toISOString() }, now);
    journal(ctx, 'progress', unit, {
      slot: slot.id,
      detail: truth.milestone
        ? `milestone ${truth.milestone.phase}/${truth.milestone.status}`
        : 'new pushed commit',
    });
  }
  return { state: next, progressed };
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
  if (slot.pid !== null && !ctx.deps.spawnDeps.isAlive(slot.pid)) {
    journal(ctx, 'exit-detected', unit, { pid: slot.pid, slot: slot.id });
    const exited = transitionSlot(state, slot.id, 'exited', {}, now);
    return completeUnitOrRecover(ctx, exited, unit, truth, 'verify-complete');
  }

  // Ground truth says the unit is DONE while the agent still holds the slot —
  // externally-advanced state (AC3): reclaim the slot, kill the leftover agent.
  if (isVerifiedComplete(truth.milestone, truth.closed)) {
    journal(ctx, 'external-advance', unit, {
      pid: slot.pid,
      slot: slot.id,
      detail: truth.closed ? 'issue closed' : 'report done',
    });
    killUnitAgent(ctx, state, unit);
    const exited = transitionSlot(state, slot.id, 'exited', {}, now);
    return completeUnitOrRecover(ctx, exited, unit, truth, 'external-advance');
  }

  const progress = applyProgressSignals(ctx, state, slot, truth, unit);
  if (progress.progressed) return progress.state;

  // No progress: the stall timer (AC4).
  const lastProgress = slot.last_progress_at ? Date.parse(slot.last_progress_at) : 0;
  if (now.getTime() - lastProgress >= ctx.dispatch.stallTimeoutMs) {
    return enterRecovery(ctx, progress.state, unit, 'stalled', 'stall');
  }
  return progress.state;
}

/**
 * An exited/verifying slot: verify the claimed state against ground truth
 * (AC2). Verified → complete; unverified → the same recovery ladder as a
 * stall. `via` distinguishes the journal's completion event.
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

  if (isVerifiedComplete(truth.milestone, truth.closed)) {
    return completeUnit(ctx, next, unit, via);
  }
  return enterRecovery(ctx, next, unit, 'verify-incomplete', 'unverified-exit', {
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
    const truth: UnitTruth = polled.get(unit) ?? {
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

/**
 * One full reconcile+refill cycle. Ground truth is polled WITHOUT the lock;
 * every state mutation happens under `store.withLock`; refills are computed in
 * the same pass, so a freed slot is reused within this tick (AC5).
 */
export function tick(deps: EngineDeps, config: SchedConfig): TickResult {
  const dispatch = resolveDispatch(config);
  const polled = pollUnits(deps, deps.store.load());

  return deps.store.withLock((state) => {
    const ctx: TickCtx = { deps, dispatch, result: emptyResult() };
    let next = reconcileSlots(ctx, state, polled);
    next = requeueOrphanedDispatches(ctx, next);
    next = dispatchAssignments(ctx, next, config);
    return { state: next, result: ctx.result };
  });
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
