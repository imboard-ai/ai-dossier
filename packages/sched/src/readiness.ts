/**
 * Readiness: which units can run right now, as a pure function of state
 * (RFC-0001 §E.4: "scheduler gates on merge" — an issue with an unmerged
 * dependency is never runnable, and a batch is never dispatched while a batch
 * it depends on is unmerged).
 */

import { findBatch } from './state';
import type { BatchEntry, IssueStatus, QueueEntry, SchedState } from './types';
import { MERGED_BATCH_STATUSES, SATISFIED_ISSUE_STATUSES } from './types';

/** A unit the scheduler can place on a slot: one full-mode issue, or one batch. */
export type RunnableUnit = { kind: 'issue'; issue: number } | { kind: 'batch'; batch: string };

/** Why a dependency edge currently blocks its holder. */
export interface DependencyBlocker {
  /** The blocked issue. */
  issue: number;
  /** The unsatisfied dependency. */
  dep: number;
  reason: 'unmerged' | 'not-in-queue';
  /** Current status of the dependency entry, when it exists. */
  depStatus?: IssueStatus;
}

/** Issue statuses from which a full-cycle dispatch may start. */
export const DISPATCHABLE_ISSUE_STATUSES: ReadonlySet<IssueStatus> = new Set([
  // `queued` is dispatchable because the manifest already carries the mode —
  // the classifier (#465) only refines it later.
  'queued',
  'classified',
  'requeued',
]);

function batchOf(state: SchedState, issue: number): BatchEntry | undefined {
  return state.batches.find((b) => b.members.includes(issue));
}

/**
 * Unsatisfied dependency edges of a single entry. Deps satisfied by
 * membership in the SAME batch are not blockers — intra-batch ordering is the
 * batch's own concern once dispatched (RFC-0001 §E.4).
 */
export function dependencyBlockers(state: SchedState, entry: QueueEntry): DependencyBlocker[] {
  const blockers: DependencyBlocker[] = [];
  const ownBatch = entry.batch !== null ? findBatch(state, entry.batch) : undefined;
  for (const dep of entry.deps) {
    if (ownBatch?.members.includes(dep)) continue;
    const depEntry = state.entries.find((e) => e.issue === dep);
    if (!depEntry) {
      blockers.push({ issue: entry.issue, dep, reason: 'not-in-queue' });
      continue;
    }
    if (!SATISFIED_ISSUE_STATUSES.has(depEntry.status)) {
      blockers.push({ issue: entry.issue, dep, reason: 'unmerged', depStatus: depEntry.status });
    }
  }
  return blockers;
}

/** Whether `batch` may dispatch: status `ready` and every cross-batch/cross-issue edge merged. */
export function batchBlockers(state: SchedState, batch: BatchEntry): DependencyBlocker[] {
  const blockers: DependencyBlocker[] = [];
  for (const member of batch.members) {
    const entry = state.entries.find((e) => e.issue === member);
    if (!entry) continue; // validateState guarantees membership consistency
    for (const dep of entry.deps) {
      if (batch.members.includes(dep)) continue; // intra-batch edge
      const depBatch = batchOf(state, dep);
      if (depBatch && depBatch.id !== batch.id) {
        if (!MERGED_BATCH_STATUSES.has(depBatch.status)) {
          blockers.push({ issue: member, dep, reason: 'unmerged' });
        }
        continue;
      }
      const depEntry = state.entries.find((e) => e.issue === dep);
      if (!depEntry) {
        blockers.push({ issue: member, dep, reason: 'not-in-queue' });
      } else if (!SATISFIED_ISSUE_STATUSES.has(depEntry.status)) {
        blockers.push({ issue: member, dep, reason: 'unmerged', depStatus: depEntry.status });
      }
    }
  }
  return blockers;
}

/** One candidate's sort key for `compareByPriority` (#565). */
export interface PriorityRank {
  priority: number;
  /** Readiness age — the entry/batch's `updated_at` (a status transition bumps it, so a fresh `ready`/`requeued` reads as newly-aged, not stale). */
  updated_at: string;
  /** Final, deterministic tiebreak once priority and age both tie — an issue number, or a batch's anchor issue (or `+Infinity` when anchor is unset). */
  tiebreak: number;
}

/**
 * Total order for assignment (#565 AC2): priority desc, then readiness age
 * (older first) asc, then the numeric tiebreak asc. Shared by `runnableUnits`
 * (issues and batches competing for the SAME free slot within
 * `computeAssignments`) and `batch-dispatch.ts`'s own ready-batch claim loop
 * (batches competing against EACH OTHER — that pass never goes through
 * `computeAssignments`, so it applies this comparator directly instead).
 */
export function compareByPriority(a: PriorityRank, b: PriorityRank): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const ageA = Date.parse(a.updated_at);
  const ageB = Date.parse(b.updated_at);
  if (ageA !== ageB) return ageA - ageB;
  return a.tiebreak - b.tiebreak;
}

/**
 * All runnable units, in assignment order (#565 AC2: priority desc →
 * readiness age → issue number). Issues and batches are ranked on the SAME
 * scale — a batch's default priority (`DEFAULT_BATCH_PRIORITY`, 10) outranks
 * a full-cycle entry's default (0) precisely so a ready batch is offered a
 * free slot before a same-readiness issue unit competing for it
 * (`docs/reports/batch-pilot-2-execution.md` §13.4). `computeAssignments`
 * slices this list to free capacity; nothing here itself claims a slot.
 */
export function runnableUnits(state: SchedState): RunnableUnit[] {
  const ranked: { unit: RunnableUnit; rank: PriorityRank }[] = [];
  for (const entry of state.entries) {
    if (entry.mode !== 'full') continue;
    if (!DISPATCHABLE_ISSUE_STATUSES.has(entry.status)) continue;
    if (dependencyBlockers(state, entry).length > 0) continue;
    ranked.push({
      unit: { kind: 'issue', issue: entry.issue },
      rank: { priority: entry.priority, updated_at: entry.updated_at, tiebreak: entry.issue },
    });
  }
  for (const batch of state.batches) {
    if (batch.status !== 'ready') continue;
    if (batchBlockers(state, batch).length > 0) continue;
    ranked.push({
      unit: { kind: 'batch', batch: batch.id },
      rank: {
        priority: batch.priority,
        updated_at: batch.updated_at,
        tiebreak: batch.anchor ?? Number.POSITIVE_INFINITY,
      },
    });
  }
  ranked.sort((a, b) => compareByPriority(a.rank, b.rank));
  return ranked.map((r) => r.unit);
}
