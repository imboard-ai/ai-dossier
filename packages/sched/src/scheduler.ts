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
import type { SchedConfig, SchedState } from './types';
import { LIVE_SLOT_STATUSES } from './types';

export { runnableUnits, dependencyBlockers, batchBlockers };
export type { DependencyBlocker, RunnableUnit };

/** One placement made by `computeAssignments`: slot ← unit. */
export interface Assignment {
  slot: number;
  kind: 'issue' | 'batch';
  issue?: number;
  batch?: string;
}

function unitId(unit: RunnableUnit): string {
  return unit.kind === 'issue' ? `issue:${unit.issue}` : `batch:${unit.batch}`;
}

/**
 * Fill idle slots with runnable units, bounded by `config.max_slots` (AC5):
 * `max_slots` caps LIVE slots (assigned | running | recovering), so free
 * capacity = max_slots − live. Idle slots are reused first; new slots are
 * materialized lazily (as `idle`, then transitioned `idle → assigned` — a
 * typed edge, never a synthetic mid-state).
 */
export function computeAssignments(
  state: SchedState,
  config: SchedConfig,
  now: Date = new Date()
): { state: SchedState; assignments: Assignment[] } {
  if (state.paused) {
    return { state, assignments: [] };
  }

  const live = state.slots.filter((s) => LIVE_SLOT_STATUSES.has(s.status)).length;
  const freeCapacity = Math.max(0, config.max_slots - live);
  if (freeCapacity === 0) {
    return { state, assignments: [] };
  }

  const held = new Set(state.slots.map((s) => s.unit).filter((u): u is string => u !== null));
  const candidates = runnableUnits(state).filter((unit) => !held.has(unitId(unit)));
  const taken = candidates.slice(0, freeCapacity);
  if (taken.length === 0) {
    return { state, assignments: [] };
  }

  let next = state;
  const assignments: Assignment[] = [];
  for (const unit of taken) {
    let idle = next.slots.find((s) => s.status === 'idle');
    if (!idle) {
      const slot = {
        id: next.next_slot_id,
        status: 'idle' as const,
        unit: null,
        pid: null,
        phase: null,
        last_progress_at: null,
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
        unit: unitId(unit),
        pid: null,
        phase: null,
        last_progress_at: now.toISOString(),
      },
      now
    );
    assignments.push(
      unit.kind === 'issue'
        ? { slot: idle.id, kind: 'issue', issue: unit.issue }
        : { slot: idle.id, kind: 'batch', batch: unit.batch }
    );
  }

  return { state: next, assignments };
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
    throw new Error(`Queue entry not found: ${issue}`);
  }
  if (entry.status === 'done' || entry.status === 'failed') {
    throw new Error(`Issue ${issue} is already ${entry.status} — nothing to abandon`);
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
    throw new Error(`Batch not found: ${batchId}`);
  }
  if (batch.status === 'done' || batch.status === 'dissolved') {
    throw new Error(`Batch ${batchId} is already ${batch.status} — nothing to abandon`);
  }
  let next = transitionBatch(state, batchId, 'dissolving', {}, now);
  next = transitionBatch(next, batchId, 'dissolved', {}, now);

  const requeued: number[] = [];
  for (const issue of batch.members) {
    const entry = next.entries.find((e) => e.issue === issue);
    if (!entry) continue;
    if (
      entry.status === 'done' ||
      entry.status === 'failed' ||
      entry.status === 'shipped' ||
      entry.status === 'shipped-in-batch'
    ) {
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
    if (entry.status === 'evicted' || entry.status === 'requeued') {
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
