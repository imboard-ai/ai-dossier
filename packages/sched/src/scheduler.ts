/**
 * The deterministic scheduler core: which units are runnable, and how idle
 * slots get filled (RFC-0001 §B — "refill is a state-machine transition, not
 * a remembered instruction").
 *
 * Everything here is a pure function of (state, config). Dispatching —
 * spawning agent processes, completion verification, stall timers — is #464;
 * this module only decides assignments and performs the typed slot/issue
 * transitions that make them durable. When `state.paused` is set, no
 * assignments are made at all (`sched pause`).
 */

import {
  batchBlockers,
  type DependencyBlocker,
  dependencyBlockers,
  type RunnableUnit,
  runnableUnits,
} from './readiness';
import { findBatch, transitionBatch, transitionIssue, transitionSlot } from './state';
import type { BatchEntry, SchedConfig, SchedState } from './types';
import {
  LIVE_SLOT_STATUSES,
  SATISFIED_ISSUE_STATUSES,
  SchedNotFoundError,
  TERMINAL_BATCH_STATUSES,
  TERMINAL_ISSUE_STATUSES,
} from './types';

export { runnableUnits, dependencyBlockers, batchBlockers };
export type { DependencyBlocker, RunnableUnit };

/** One placement made by `computeAssignments`: slot ← unit. */
export type Assignment =
  | { slot: number; kind: 'issue'; issue: number }
  | { slot: number; kind: 'batch'; batch: string };

function unitId(unit: RunnableUnit): string {
  return unit.kind === 'issue' ? `issue:${unit.issue}` : `batch:${unit.batch}`;
}

/**
 * Fill idle slots with runnable units, bounded by `config.max_slots` (AC5):
 * `max_slots` caps LIVE slots (assigned | running | recovering), so free
 * capacity = max_slots − live. Idle slots are reused first; new slots are
 * materialized lazily (as `idle`, then transitioned `idle → assigned` — a
 * typed edge, never a synthetic mid-state).
 *
 * `kinds` restricts which unit kinds may be assigned (default: both). The
 * #464 engine dispatches `issue` units only — batch member sequencing is a
 * follow-up — so it passes `['issue']` and a `ready` batch never occupies a
 * slot it cannot run on yet.
 */
export function computeAssignments(
  state: SchedState,
  config: SchedConfig,
  now: Date = new Date(),
  kinds: readonly ('issue' | 'batch')[] = ['issue', 'batch']
): { state: SchedState; assignments: Assignment[] } {
  if (state.paused) {
    return { state, assignments: [] };
  }

  if (freeCapacity(state, config) === 0) {
    return { state, assignments: [] };
  }

  const held = new Set(state.slots.map((s) => s.unit).filter((u): u is string => u !== null));
  const candidates = runnableUnits(state)
    .filter((unit) => kinds.includes(unit.kind))
    .filter((unit) => !held.has(unitId(unit)));
  const taken = candidates.slice(0, freeCapacity(state, config));
  if (taken.length === 0) {
    return { state, assignments: [] };
  }

  let next = state;
  const assignments: Assignment[] = [];
  for (const unit of taken) {
    const assigned = assignToIdleSlot(next, unitId(unit), null, now);
    next = assigned.state;
    assignments.push(
      unit.kind === 'issue'
        ? { slot: assigned.slotId, kind: 'issue', issue: unit.issue }
        : { slot: assigned.slotId, kind: 'batch', batch: unit.batch }
    );
  }

  return { state: next, assignments };
}

/** Free live-agent capacity: `max_slots` minus the slots holding live units (AC5). */
export function freeCapacity(state: SchedState, config: SchedConfig): number {
  const live = state.slots.filter((s) => LIVE_SLOT_STATUSES.has(s.status)).length;
  return Math.max(0, config.max_slots - live);
}

/**
 * Assign `unit` to an idle slot (materializing one lazily when none is idle —
 * a typed `idle → assigned` edge, never a synthetic mid-state) and return the
 * new state plus the slot's id. Shared by queue refill (computeAssignments)
 * and the #468 report dispatch so the slot-invariant shape exists once.
 */
export function assignToIdleSlot(
  state: SchedState,
  unit: string,
  phase: string | null,
  now: Date
): { state: SchedState; slotId: number } {
  let next = state;
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
      updated_at: now.toISOString(),
    };
    next = { ...next, slots: [...next.slots, slot], next_slot_id: next.next_slot_id + 1 };
    idle = slot;
  }
  next = transitionSlot(
    next,
    idle.id,
    'assigned',
    {
      unit,
      pid: null,
      phase,
      last_progress_at: now.toISOString(),
    },
    now
  );
  return { state: next, slotId: idle.id };
}

/**
 * `sched pause` / `sched resume`: toggle the paused flag. Pausing does not
 * touch live units — it only stops new assignments.
 */
export function setPaused(state: SchedState, paused: boolean): SchedState {
  return { ...state, paused };
}

/**
 * `sched abandon --issue N`: mark an entry failed via the universal failure
 * edge, recording the reason, and release any slot holding it
 * (running/exited/verifying → failed → idle). Terminal entries cannot be
 * abandoned.
 */
export function abandonIssue(
  state: SchedState,
  issue: number,
  reason = 'abandoned',
  now: Date = new Date()
): { state: SchedState; releasedSlots: number[] } {
  const entry = state.entries.find((e) => e.issue === issue);
  if (!entry) {
    throw new SchedNotFoundError(`Queue entry not found: ${issue}`);
  }
  if (TERMINAL_ISSUE_STATUSES.has(entry.status)) {
    throw new SchedNotFoundError(`Issue ${issue} is already ${entry.status} — nothing to abandon`);
  }
  let next = transitionIssue(state, issue, 'failed', { reason }, now);
  const unit = `issue:${issue}`;
  const released: number[] = [];
  for (const slot of next.slots) {
    if (slot.unit === unit && slot.status !== 'idle') {
      if (slot.status !== 'failed' && slot.status !== 'complete') {
        next = transitionSlot(next, slot.id, 'failed', {}, now);
      }
      next = transitionSlot(next, slot.id, 'idle', {}, now);
      released.push(slot.id);
    }
  }
  return { state: next, releasedSlots: released };
}

/**
 * Requeue every unshipped member of a dissolving batch as full-cycle
 * (RFC-0001 §D.2 dissolving → "members requeued"; F.8 "nothing green is
 * discarded" — members already shipped stay put). Shared by the operator
 * `abandonBatch` and the recovery core's automatic dissolve (#472).
 */
export function requeueUnshippedMembers(
  state: SchedState,
  batch: BatchEntry,
  reason: string,
  now: Date = new Date()
): { state: SchedState; requeued: number[] } {
  let next = state;
  const requeued: number[] = [];
  for (const issue of batch.members) {
    const entry = next.entries.find((e) => e.issue === issue);
    if (!entry) continue;
    // Nothing green is discarded (F.8): terminal or already-shipped members
    // keep their outcome; only active members requeue.
    if (TERMINAL_ISSUE_STATUSES.has(entry.status) || SATISFIED_ISSUE_STATUSES.has(entry.status)) {
      continue;
    }
    if (entry.status === 'queued' || entry.status === 'classified') {
      // Never reached the batch rail — retag as full-cycle (metadata change,
      // not a status transition) and it stays queued as-is.
      next = {
        ...next,
        entries: next.entries.map((e) =>
          e.issue === issue
            ? { ...e, mode: 'full', batch: null, reason, updated_at: now.toISOString() }
            : e
        ),
      };
      requeued.push(issue);
      continue;
    }
    if (entry.status === 'requeued') {
      // Already requeued as full-cycle (e.g. evicted by #472's recovery
      // before the batch dissolved) — nothing to do, but it counts.
      requeued.push(issue);
      continue;
    }
    if (entry.status === 'evicted') {
      next = transitionIssue(next, issue, 'requeued', { mode: 'full', batch: null, reason }, now);
      requeued.push(issue);
      continue;
    }
    // Any other active state: force onto the failure rail (evicted → requeued{full}).
    next = transitionIssue(next, issue, 'evicted', { reason }, now);
    next = transitionIssue(next, issue, 'requeued', { mode: 'full', batch: null, reason }, now);
    requeued.push(issue);
  }
  return { state: next, requeued };
}

/**
 * `sched abandon --batch B`: dissolve the batch and requeue every non-terminal
 * member as full-cycle (RFC-0001 §D.2 dissolving → "members requeued"; F.8
 * "nothing green is discarded" — members already shipped stay put).
 */
export function abandonBatch(
  state: SchedState,
  batchId: string,
  reason = 'batch abandoned',
  now: Date = new Date()
): { state: SchedState; requeued: number[] } {
  const batch = findBatch(state, batchId);
  if (!batch) {
    throw new SchedNotFoundError(`Batch not found: ${batchId}`);
  }
  if (TERMINAL_BATCH_STATUSES.has(batch.status)) {
    throw new SchedNotFoundError(
      `Batch ${batchId} is already ${batch.status} — nothing to abandon`
    );
  }
  let next = transitionBatch(state, batchId, 'dissolving', {}, now);
  next = transitionBatch(next, batchId, 'dissolved', {}, now);

  const { state: requeuedState, requeued } = requeueUnshippedMembers(
    next,
    findBatch(next, batchId) as BatchEntry,
    reason,
    now
  );
  return { state: requeuedState, requeued };
}
