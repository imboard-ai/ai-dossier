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
 *      pushed commit → progress; no progress for `stall_timeout_ms` →
 *      redispatch one tier stronger (cap 2, then failed)
 *    - `exited`/`verifying` slots: the agent exited — completion is verified
 *      against ground truth, never assumed (AC2); an exit whose milestone is
 *      the ship phase's `awaiting-merge` (with `pr=`) is a VERIFIED park:
 *      entry → parked, slot released (a parked unit holds no slot — AC5)
 *    - `parked` entries: the watcher applies the PR truth — merge accepted
 *      only when state MERGED AND mergedAt non-null AND the issue is closed
 *      (AC1) → shipped (gating on MERGE, never the park — AC4);
 *      CONFLICTING / closed-unmerged / auto-merge-blocked → failed + transitive
 *      dependents blocked (AC3)
 *    - failures block their TRANSITIVE dependents (AC4)
 *    - report agents are dispatched for merged units whose teardown is
 *      recorded (before queue refill — cheap reports don't queue behind
 *      long runs)
 * 3. **Teardown** (outside the lock — pool/git subprocesses are slow): for
 *    every freshly-merged unit, recover the setup milestone's worktree info
 *    and run pool return / worktree remove, VERIFIED before claimed
 *    (`cleanup=failed-<step>` on mismatch, AC2). Results land in a second
 *    short lock pass together with the report dispatch.
 * 4. **Refill**: `computeAssignments` fills every freed slot in the SAME tick —
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
  buildReportPrompt,
  escalateTier,
  type ResolvedDispatch,
  reportTierFor,
  resolveDispatch,
  type SpawnDeps,
  STOP_POLL_MAX_MS,
  STOP_POLL_MIN_MS,
  unitLogName,
} from './dispatch';
import {
  type GroundTruth,
  type GroundTruthMilestone,
  isParkedMilestone,
  isVerifiedComplete,
  type PrTruth,
} from './groundtruth';
import { issueOfUnit, type Journal, unitEvent } from './journal';
import type { SchedStore } from './persist';
import type { ExecFn } from './project';
import { computeAssignments } from './scheduler';
import { findEntry, transitionIssue, transitionSlot } from './state';
import { runTeardown, type TeardownResult } from './teardown';
import {
  ESCALATION_CAP,
  type JournalEventName,
  LIVE_SLOT_STATUSES,
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
  /** Repo working directory — cwd for teardown subprocesses (#468). */
  repoDir: string;
  /** Exec for teardown scripts (#468); injectable so tests never touch git/npx. */
  teardownExec: ExecFn;
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
  /** Report agents dispatched for merged units this tick (#468). */
  reportDispatched: string[];
  /** Units redispatched one tier stronger (stall or unverified exit). */
  redispatched: string[];
  /** Units failed (escalation cap / strongest tier / spawn error / PR failure). */
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
    reportDispatched: [],
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
 * Poll parked PRs on their own cadence (#468 AC1 — every 2–3 min, persisted
 * `last_pr_poll_at` so a restart honors it). Runs only when parked entries
 * exist AND the interval elapsed; every subprocess stays outside the lock.
 * The issue-closed signal rides along — it is the second half of the
 * merge-acceptance gate and must not be re-queried under the lock.
 */
function pollParkedPrs(deps: EngineDeps, state: SchedState, dispatch: ResolvedDispatch): PrPoll {
  const parked = state.entries.filter((e) => e.status === 'parked' && e.pr !== null);
  if (parked.length === 0) return { ran: false, truths: new Map(), closed: new Map() };

  const now = deps.now().getTime();
  const last = state.last_pr_poll_at !== null ? Date.parse(state.last_pr_poll_at) : 0;
  if (Number.isFinite(last) && now - last < dispatch.prPollIntervalMs) {
    return { ran: false, truths: new Map(), closed: new Map() };
  }

  const truths = new Map<number, PrTruth | undefined>();
  const closed = new Map<number, boolean>();
  for (const entry of parked) {
    truths.set(entry.issue, deps.groundTruth.prState(entry.pr as number));
    closed.set(entry.issue, deps.groundTruth.issueClosed(entry.issue));
  }
  return { ran: true, truths, closed };
}

// --- Spawn / fail / complete / park ---

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
  // Report slots (crash recovery, ladder redispatch) respawn as report agents.
  if (slot.phase === 'report') {
    return spawnReportAgent(ctx, state, unit);
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
  const patch = {
    pid,
    pid_start: ctx.deps.spawnDeps.processStart(pid),
    phase: 'gate',
    last_progress_at: now.toISOString(),
  };
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

  const cmd = buildAgentCommand(ctx.dispatch.command, tier, issue, ctx.dispatch.tierModels);
  const prompt = buildReportPrompt(ctx.dispatch.reportPrompt, issue, entry.pr, entry.cleanup);
  const logFile = path.join(ctx.deps.store.runsDir, `${unitLogName(unit)}.log`);

  let pid: number;
  try {
    pid = ctx.deps.spawnDeps.spawn(cmd, prompt, logFile);
  } catch (err) {
    // Merged-aware: the PR is merged — a report spawn failure never blocks
    // dependents (gating already released at `shipped`).
    return failUnit(ctx, state, unit, `spawn-error: ${(err as Error).message}`, { merged: true });
  }

  const now = ctx.deps.now();
  const patch = {
    pid,
    pid_start: ctx.deps.spawnDeps.processStart(pid),
    phase: 'report',
    last_progress_at: now.toISOString(),
  };
  const next =
    slot.status === 'assigned' || slot.status === 'recovering'
      ? transitionSlot(state, slot.id, 'running', patch, now)
      : patchSlot(state, slot.id, patch, now);

  journal(ctx, 'spawned', unit, {
    pid,
    tier,
    slot: slot.id,
    cmd: cmd.join(' '),
    log: logFile,
    detail: 'report agent',
  });
  ctx.result.spawned.push(unit);
  return next;
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
  let next = releaseSlotViaFailure(ctx, state, unit);

  const entry = findEntry(next, issue);
  if (entry && !TERMINAL_ISSUE_STATUSES.has(entry.status)) {
    ctx.result.failed.push(unit);
    if (opts.merged === true && entry.status === 'shipped') {
      next = transitionIssue(next, issue, 'done', { reason }, now);
      journal(ctx, 'report-failed', unit, { reason });
    } else {
      next = transitionIssue(next, issue, 'failed', { reason }, now);
      journal(ctx, 'unit-failed', unit, { reason });
      const blocked = blockTransitiveDependents(ctx, next, issue);
      next = blocked.state;
      ctx.result.blocked.push(...blocked.issues);
    }
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
  evidence: Record<string, unknown> = {}
): SchedState {
  const issue = issueOfUnit(unit);
  if (issue === null) return state;
  const now = ctx.deps.now();
  const entry = findEntry(state, issue);
  const slot = slotOf(state, unit);
  if (!entry || !slot) return state;

  killUnitAgent(ctx, state, unit);

  const report = slot.phase === 'report';
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

  let next = transitionSlot(
    state,
    slot.id,
    'recovering',
    { pid: null, recoveries: slot.recoveries + 1 },
    now
  );
  if (!report) {
    next = {
      ...next,
      entries: next.entries.map((e) =>
        e.issue === issue
          ? { ...e, tier: nextTier as NonNullable<typeof nextTier>, updated_at: now.toISOString() }
          : e
      ),
    };
  }
  journal(ctx, causeEvent, unit, {
    detail: cause,
    slot: slot.id,
    ...(slot.last_progress_at !== null ? { last_progress_at: slot.last_progress_at } : {}),
    ...evidence,
  });
  journal(ctx, 'redispatched', unit, { tier: nextTier, slot: slot.id });
  ctx.result.redispatched.push(unit);
  // Respawn immediately on the recovering rail — recovering → running. A
  // report-phase slot routes to the report agent with its escalated tier.
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
    // A report agent completing its run (#468): shipped → done.
    next = transitionIssue(next, issue, 'done', {}, now);
  }

  journal(ctx, via, unit);
  if (via === 'external-advance') ctx.result.externalAdvances.push(unit);
  else ctx.result.completed.push(unit);
  return next;
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
  const pr = Number.parseInt(milestone.keys.pr ?? '', 10);
  if (!Number.isInteger(pr) || pr <= 0) return state; // isParkedMilestone guarantees this

  let next = walkSlotToIdle(state, unit, now, (status) => {
    if (status === 'complete' || status === 'failed') return 'idle';
    if (status === 'running') return 'exited';
    if (status === 'exited') return 'verifying';
    if (status === 'verifying') return 'complete';
    return 'failed'; // assigned/recovering: never wedge
  });

  next = transitionIssue(next, issue, 'parked', { pr }, now);
  journal(ctx, 'pr-parked', unit, { pr });
  ctx.result.parked.push(unit);
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
  if (slot.pid !== null && !ctx.deps.spawnDeps.isAlive(slot.pid, slot.pid_start ?? undefined)) {
    journal(ctx, 'exit-detected', unit, { pid: slot.pid, slot: slot.id });
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
  // A report agent's issue is already closed (closed AT MERGE), so for
  // report-phase slots only the milestone counts. A parked milestone is
  // deliberately NOT an advance: a detached run parks and stops — the watcher
  // owns the tail (#468); the exit/stall rails take the agent from here.
  const closedSignal = slot.phase === 'report' ? false : truth.closed;
  if (isVerifiedComplete(truth.milestone, closedSignal) && !isParkedMilestone(truth.milestone)) {
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
    return parkUnit(ctx, next, unit, truth.milestone as GroundTruthMilestone);
  }

  // Report agents complete on the milestone alone (their issue closed at
  // merge — the closed signal is already true when they spawn).
  const closedSignal = slot.phase === 'report' ? false : truth.closed;
  if (isVerifiedComplete(truth.milestone, closedSignal)) {
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
 */
function reconcileParked(ctx: TickCtx, state: SchedState, prPoll: PrPoll): SchedState {
  let next = state;
  if (prPoll.ran) {
    next = { ...next, last_pr_poll_at: ctx.deps.now().toISOString() };
  }
  if (!prPoll.ran) return next;

  for (const entry of state.entries) {
    if (entry.status !== 'parked' || entry.pr === null) continue;
    const unit = `issue:${entry.issue}`;
    const truth = prPoll.truths.get(entry.issue);
    if (truth === undefined) {
      journal(ctx, 'ground-truth-unreachable', unit, {
        detail: 'pr watch paused until truth returns',
      });
      continue;
    }

    const failWatch = (reason: string): SchedState => {
      journal(ctx, 'pr-watch-failed', unit, { reason, pr: entry.pr });
      return failUnit(ctx, next, unit, reason);
    };

    if (truth.blocked) {
      next = failWatch('auto-merge-blocked');
      continue;
    }
    if (truth.mergeable === 'CONFLICTING') {
      next = failWatch('pr-conflicting');
      continue;
    }
    if (truth.state === 'CLOSED' && truth.mergedAt === null) {
      next = failWatch('pr-closed-unmerged');
      continue;
    }
    if (truth.state === 'MERGED' && truth.mergedAt !== null) {
      // AC1: the issue must ALSO be closed (a merged PR auto-closes it) —
      // until GitHub propagates, the unit stays parked and keeps watching.
      if (prPoll.closed.get(entry.issue) !== true) continue;
      next = transitionIssue(next, entry.issue, 'shipped', { reason: null }, ctx.deps.now());
      journal(ctx, 'merge-accepted', unit, { pr: entry.pr, mergedAt: truth.mergedAt });
      ctx.result.mergeAccepted.push(unit);
    }
    // OPEN (or MERGED without a date / mergeable UNKNOWN) — keep watching.
  }
  return next;
}

/** Whether a report agent already holds (or is being dispatched for) the unit. */
function reportSlotHolds(state: SchedState, unit: string): boolean {
  return state.slots.some((s) => s.unit === unit);
}

/**
 * Dispatch report agents for merged units whose teardown is recorded (#468
 * AC2): shipped + pr + cleanup + no live slot + free capacity → a slot is
 * assigned (phase `report`) and a mechanical-tier agent spawned with the
 * report prompt. Reports run BEFORE queue refill — a cheap report never
 * queues behind long full-cycle runs. A unit waiting for capacity consumes
 * zero slots (AC5).
 */
function dispatchReportAgents(ctx: TickCtx, state: SchedState, config: SchedConfig): SchedState {
  let next = state;
  for (const entry of state.entries) {
    if (entry.status !== 'shipped' || entry.pr === null || entry.cleanup === null) continue;
    const unit = `issue:${entry.issue}`;
    if (reportSlotHolds(next, unit)) continue;

    const live = next.slots.filter((s) => LIVE_SLOT_STATUSES.has(s.status)).length;
    if (live >= config.max_slots) break; // full — wait (zero slots consumed)

    let idle = next.slots.find((s) => s.status === 'idle');
    if (!idle) {
      const slot = {
        id: next.next_slot_id,
        status: 'idle' as const,
        unit: null,
        pid: null,
        pid_start: null,
        phase: null,
        last_progress_at: null,
        branch: null,
        last_head: null,
        recoveries: 0,
        updated_at: ctx.deps.now().toISOString(),
      };
      next = { ...next, slots: [...next.slots, slot], next_slot_id: next.next_slot_id + 1 };
      idle = slot;
    }
    const now = ctx.deps.now();
    next = transitionSlot(
      next,
      idle.id,
      'assigned',
      {
        unit,
        pid: null,
        phase: 'report',
        last_progress_at: now.toISOString(),
      },
      now
    );
    journal(ctx, 'assigned', unit, { slot: idle.id, detail: 'report agent' });
    journal(ctx, 'report-dispatched', unit, {
      slot: idle.id,
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
    next = requeueOrphanedDispatches(ctx, next);
    next = dispatchReportAgents(ctx, next, config);
    next = dispatchAssignments(ctx, next, config);
    return {
      state: next,
      result: { tick: ctx.result, teardownPending: teardownPendingIssues(next) },
    };
  });

  if (pass1.teardownPending.length === 0) {
    return pass1.tick;
  }

  // Teardown subprocesses (pool return / worktree remove) run OUTSIDE the
  // lock; results land in a second short lock pass together with the report
  // dispatch (AC2: teardown, THEN the cheap-tier report agent).
  const results = new Map<number, TeardownResult>();
  for (const issue of pass1.teardownPending) {
    const result = runTeardownFor(deps, issue);
    if (result !== null) results.set(issue, result);
  }
  if (results.size === 0) {
    return pass1.tick; // all deferred (setup info unreachable) — retried next tick
  }

  return deps.store.withLock((state) => {
    const ctx: TickCtx = { deps, dispatch, result: pass1.tick };
    const next = recordTeardowns(ctx, state, results);
    const withReport = dispatchReportAgents(ctx, next, config);
    return { state: withReport, result: ctx.result };
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
