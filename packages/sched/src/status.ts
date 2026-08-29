/**
 * `sched status` report (AC4): queue, slots, batches, parked PRs, and the
 * blocked/failed sets as a machine-readable report. Text rendering lives in
 * the CLI (`cli/src/commands/sched.ts`, on top of the CLI's shared
 * `renderTable`) — the package deliberately has no dependency on CLI
 * utilities.
 */

import {
  batchBlockers,
  DISPATCHABLE_ISSUE_STATUSES,
  dependencyBlockers,
  runnableUnits,
} from './readiness';
import type { BatchEntry, QueueEntry, SchedConfig, SchedState, SlotEntry } from './types';
import { LIVE_SLOT_STATUSES, SATISFIED_ISSUE_STATUSES, TERMINAL_ISSUE_STATUSES } from './types';

/** An entry that cannot progress, with the human reason. */
export interface BlockedItem {
  issue: number;
  status: string;
  reason: string;
}

/** A parked unit awaiting its PR merge (#468). */
export interface ParkedItem {
  issue: number;
  pr: number;
  /** When the unit parked (entry `updated_at`). */
  since: string;
}

/** Machine-readable status report (`sched status --json`). */
export interface StatusReport {
  /** Project slug the report was built for (which state bucket this is). */
  project: string;
  paused: boolean;
  max_slots: number;
  live_slots: number;
  queue: QueueEntry[];
  slots: SlotEntry[];
  batches: BatchEntry[];
  /** Parked units being watched by the PR watcher (#468). */
  parked: ParkedItem[];
  /** When the PR watcher last polled (#468) — null before the first poll. */
  last_pr_poll_at: string | null;
  /** How many units are runnable right now. */
  runnable: number;
  /** Which units are runnable (`issue:<n>` / `batch:<id>`), in dispatch order. */
  runnable_units: string[];
  blocked: BlockedItem[];
  failed: QueueEntry[];
}

export function buildStatusReport(
  state: SchedState,
  config: SchedConfig,
  project: string
): StatusReport {
  const blocked: BlockedItem[] = [];
  const failed: QueueEntry[] = [];

  const describeBlocker = (b: { dep: number; reason: string; depStatus?: string }): string =>
    b.reason === 'not-in-queue'
      ? `dependency #${b.dep} is not in the queue`
      : `dependency #${b.dep} not merged (status: ${b.depStatus ?? 'unknown'})`;

  for (const entry of state.entries) {
    if (entry.status === 'failed') {
      failed.push(entry);
      continue;
    }
    if (entry.status === 'blocked' || entry.status === 'decision-pending') {
      blocked.push({
        issue: entry.issue,
        status: entry.status,
        reason: entry.reason ?? entry.status,
      });
      continue;
    }
    if (TERMINAL_ISSUE_STATUSES.has(entry.status) || SATISFIED_ISSUE_STATUSES.has(entry.status)) {
      continue;
    }

    if (entry.mode === 'full') {
      if (DISPATCHABLE_ISSUE_STATUSES.has(entry.status)) {
        const blockers = dependencyBlockers(state, entry);
        if (blockers.length > 0) {
          blocked.push({
            issue: entry.issue,
            status: entry.status,
            reason: blockers.map(describeBlocker).join('; '),
          });
        }
      }
      continue;
    }

    // Slot mode: the member runs when its batch dispatches. Cross-batch /
    // external dependency blockers come from the batch's edge set.
    const batch = state.batches.find((b) => b.id === entry.batch);
    if (batch && batch.status !== 'forming' && batch.status !== 'dissolved') {
      const mine = batchBlockers(state, batch).filter((b) => b.issue === entry.issue);
      if (mine.length > 0) {
        blocked.push({
          issue: entry.issue,
          status: entry.status,
          reason: mine.map(describeBlocker).join('; '),
        });
      }
    }
  }

  const units = state.paused ? [] : runnableUnits(state);

  const parked: ParkedItem[] = state.entries
    .filter((e): e is QueueEntry & { pr: number } => e.status === 'parked' && e.pr !== null)
    .map((e) => ({ issue: e.issue, pr: e.pr, since: e.updated_at }));

  return {
    project,
    paused: state.paused,
    max_slots: config.max_slots,
    live_slots: state.slots.filter((s) => LIVE_SLOT_STATUSES.has(s.status)).length,
    queue: state.entries,
    slots: state.slots,
    batches: state.batches,
    parked,
    last_pr_poll_at: state.last_pr_poll_at,
    runnable: units.length,
    runnable_units: units.map((u) =>
      u.kind === 'issue' ? `issue:${u.issue}` : `batch:${u.batch}`
    ),
    blocked,
    failed,
  };
}
