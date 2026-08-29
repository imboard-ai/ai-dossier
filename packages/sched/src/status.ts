/**
 * `sched status` rendering (AC4): queue, slots, batches, and the blocked /
 * failed sets, as plain text tables (the package deliberately has no
 * dependency on the CLI's table renderer).
 */

import { batchBlockers, dependencyBlockers } from './readiness';
import type { BatchEntry, QueueEntry, SchedConfig, SchedState, SlotEntry } from './types';

/** An entry that cannot progress, with the human reason. */
export interface BlockedItem {
  issue: number;
  status: string;
  reason: string;
}

/** Machine-readable status report (`sched status --json`). */
export interface StatusReport {
  paused: boolean;
  max_slots: number;
  live_slots: number;
  queue: QueueEntry[];
  slots: SlotEntry[];
  batches: BatchEntry[];
  runnable: number;
  blocked: BlockedItem[];
  failed: QueueEntry[];
}

export function buildStatusReport(state: SchedState, config: SchedConfig): StatusReport {
  const blocked: BlockedItem[] = [];
  const failed: QueueEntry[] = [];
  let runnable = 0;

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
    if (
      entry.status === 'done' ||
      entry.status === 'shipped' ||
      entry.status === 'shipped-in-batch'
    ) {
      continue;
    }

    if (entry.mode === 'full') {
      if (
        entry.status === 'queued' ||
        entry.status === 'classified' ||
        entry.status === 'requeued'
      ) {
        const blockers = dependencyBlockers(state, entry);
        if (blockers.length > 0) {
          blocked.push({
            issue: entry.issue,
            status: entry.status,
            reason: describeBlocker(blockers[0]),
          });
        } else {
          runnable++;
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
          reason: describeBlocker(mine[0]),
        });
      }
    }
  }

  for (const batch of state.batches) {
    if (batch.status === 'ready' && batchBlockers(state, batch).length === 0) {
      runnable++;
    }
  }

  return {
    paused: state.paused,
    max_slots: config.max_slots,
    live_slots: state.slots.filter(
      (s) => s.status === 'assigned' || s.status === 'running' || s.status === 'recovering'
    ).length,
    queue: state.entries,
    slots: state.slots,
    batches: state.batches,
    runnable,
    blocked,
    failed,
  };
}

function pad(cell: string, width: number): string {
  return cell.length >= width ? cell : cell + ' '.repeat(width - cell.length);
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length), 0)
  );
  const head = headers.map((h, i) => pad(h, widths[i])).join('  ');
  const body = rows.map((r) => r.map((c, i) => pad(c ?? '', widths[i])).join('  '));
  return [head, ...body].join('\n');
}

function renderQueue(queue: QueueEntry[]): string {
  return table(
    ['issue', 'mode', 'batch', 'tier', 'deps', 'status'],
    queue.map((e) => [
      `#${e.issue}`,
      e.mode,
      e.batch ?? '-',
      e.tier,
      e.deps.length > 0 ? e.deps.map((d) => `#${d}`).join(',') : '-',
      e.status,
    ])
  );
}

function renderSlots(slots: SlotEntry[]): string {
  if (slots.length === 0) return '(no slots materialized yet)';
  return table(
    ['slot', 'status', 'unit', 'phase', 'recoveries'],
    slots.map((s) => [String(s.id), s.status, s.unit ?? '-', s.phase ?? '-', String(s.recoveries)])
  );
}

function renderBatches(batches: BatchEntry[]): string {
  if (batches.length === 0) return '(no batches)';
  return table(
    ['batch', 'status', 'members', 'member-in-work'],
    batches.map((b) => [
      b.id,
      b.status,
      b.members.length > 0 ? b.members.map((m) => `#${m}`).join(',') : '-',
      b.executing_member > 0 ? `${b.executing_member}/${b.members.length}` : '-',
    ])
  );
}

function renderList(items: string[]): string {
  return items.length > 0 ? items.join('\n') : '(none)';
}

/** Render the full human-readable status (AC4). */
export function renderStatus(report: StatusReport): string {
  const lines: string[] = [];
  lines.push(
    `Scheduler: ${report.paused ? 'PAUSED' : 'running'} · slots ${report.live_slots}/${report.max_slots} live · ${report.runnable} runnable unit(s)`
  );
  lines.push('');
  lines.push('== Queue ==');
  lines.push(renderQueue(report.queue));
  lines.push('');
  lines.push('== Slots ==');
  lines.push(renderSlots(report.slots));
  lines.push('');
  lines.push('== Batches ==');
  lines.push(renderBatches(report.batches));
  lines.push('');
  lines.push('== Blocked ==');
  lines.push(renderList(report.blocked.map((b) => `#${b.issue} [${b.status}] — ${b.reason}`)));
  lines.push('');
  lines.push('== Failed ==');
  lines.push(renderList(report.failed.map((f) => `#${f.issue} — ${f.reason ?? f.status}`)));
  return lines.join('\n');
}
