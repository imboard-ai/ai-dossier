import { describe, expect, it } from 'vitest';
import {
  buildStatusReport,
  createEmptyState,
  enqueueEntries,
  renderStatus,
  type SchedState,
  type SlotEntry,
  transitionBatch,
  transitionIssue,
} from '../index';

const NOW = new Date('2026-08-29T12:00:00Z');

function seeded(): SchedState {
  const state = enqueueEntries(
    createEmptyState(NOW),
    [
      { issue: 101, mode: 'full' },
      { issue: 102, mode: 'full', deps: [101] },
      { issue: 201, mode: 'slot', batch: 'b1' },
      { issue: 202, mode: 'slot', batch: 'b1' },
    ],
    NOW
  );
  return state;
}

function slot(id: number, status: SlotEntry['status'], unit: string | null): SlotEntry {
  return {
    id,
    status,
    unit,
    pid: null,
    phase: null,
    last_progress_at: null,
    recoveries: 0,
    updated_at: NOW.toISOString(),
  };
}

describe('buildStatusReport', () => {
  it('classifies runnable, blocked, and failed entries (AC4)', () => {
    let state = seeded();
    // #102 blocked on unmerged #101; #101 runnable; batch forming
    state = transitionBatch(state, 'b1', 'ready', {}, NOW);
    state = transitionIssue(state, 101, 'classified', {}, NOW);

    const report = buildStatusReport(state, { max_slots: 3 });
    expect(report.runnable).toBe(2); // issue 101 (classified, unblocked) + batch b1 (ready, deps intra-batch)
    expect(report.blocked.map((b) => b.issue)).toEqual([102]);
    expect(report.blocked[0].reason).toContain('#101');
    expect(report.failed).toEqual([]);
  });

  it('lists failed entries with their reasons', () => {
    let state = seeded();
    state = transitionIssue(state, 101, 'failed', { reason: 'escalation-cap' }, NOW);
    const report = buildStatusReport(state, { max_slots: 3 });
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].reason).toBe('escalation-cap');
  });

  it('counts live slots and reports paused state', () => {
    let state = seeded();
    state = {
      ...state,
      paused: true,
      slots: [slot(1, 'running', 'issue:101'), slot(2, 'idle', null)],
    };
    const report = buildStatusReport(state, { max_slots: 4 });
    expect(report.paused).toBe(true);
    expect(report.live_slots).toBe(1);
    expect(report.max_slots).toBe(4);
  });

  it('flags entries blocked on deps missing from the queue', () => {
    const state = enqueueEntries(createEmptyState(NOW), [{ issue: 1, deps: [999] }], NOW);
    const report = buildStatusReport(state, { max_slots: 3 });
    expect(report.blocked[0].reason).toContain('#999 is not in the queue');
    expect(report.runnable).toBe(0);
  });
});

describe('renderStatus', () => {
  it('renders queue, slots, batches, blocked, and failed sections (AC4)', () => {
    let state = seeded();
    state = transitionIssue(state, 101, 'classified', {}, NOW);
    state = {
      ...state,
      slots: [slot(1, 'running', 'issue:101')],
    };
    const text = renderStatus(buildStatusReport(state, { max_slots: 3 }));
    expect(text).toContain('== Queue ==');
    expect(text).toContain('#101');
    expect(text).toContain('full');
    expect(text).toContain('== Slots ==');
    expect(text).toContain('running');
    expect(text).toContain('issue:101');
    expect(text).toContain('== Batches ==');
    expect(text).toContain('b1');
    expect(text).toContain('== Blocked ==');
    expect(text).toContain('#102');
    expect(text).toContain('== Failed ==');
    expect(text).toContain('(none)');
    expect(text).toContain('slots 1/3 live');
  });

  it('renders empty-slot and empty-batch placeholders', () => {
    const text = renderStatus(buildStatusReport(createEmptyState(), { max_slots: 3 }));
    expect(text).toContain('(no slots materialized yet)');
    expect(text).toContain('(no batches)');
  });
});
