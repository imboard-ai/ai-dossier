import { describe, expect, it } from 'vitest';
import {
  buildStatusReport,
  createEmptyState,
  enqueueEntries,
  type SchedState,
  type SlotEntry,
  transitionBatch,
  transitionIssue,
} from '../index';

const NOW = new Date('2026-08-29T12:00:00Z');

function seeded(): SchedState {
  return enqueueEntries(
    createEmptyState(),
    [
      { issue: 101, mode: 'full' },
      { issue: 102, mode: 'full', deps: [101] },
      { issue: 201, mode: 'slot', batch: 'b1' },
      { issue: 202, mode: 'slot', batch: 'b1' },
    ],
    NOW
  );
}

function slot(id: number, status: SlotEntry['status'], unit: string | null): SlotEntry {
  return {
    id,
    status,
    unit,
    pid: null,
    phase: null,
    last_progress_at: null,
    branch: null,
    last_head: null,
    recoveries: 0,
    updated_at: NOW.toISOString(),
  };
}

describe('buildStatusReport', () => {
  it('classifies runnable, blocked, and failed entries (AC4)', () => {
    let state = seeded();
    // #102 blocked on unmerged #101; #101 runnable; batch b1 sealed and runnable
    state = transitionBatch(state, 'b1', 'ready', {}, NOW);
    state = transitionIssue(state, 101, 'classified', {}, NOW);

    const report = buildStatusReport(state, { max_slots: 3 }, 'test-proj');
    expect(report.runnable).toBe(2);
    expect(report.runnable_units).toEqual(['issue:101', 'batch:b1']);
    expect(report.blocked.map((b) => b.issue)).toEqual([102]);
    expect(report.blocked[0].reason).toContain('#101');
    expect(report.failed).toEqual([]);
    expect(report.project).toBe('test-proj');
  });

  it('lists failed entries with their reasons', () => {
    let state = seeded();
    state = transitionIssue(state, 101, 'failed', { reason: 'escalation-cap' }, NOW);
    const report = buildStatusReport(state, { max_slots: 3 }, 'p');
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].reason).toBe('escalation-cap');
  });

  it('counts live slots and reports paused state (paused ⇒ zero runnable)', () => {
    let state = seeded();
    state = transitionIssue(state, 101, 'classified', {}, NOW);
    state = {
      ...state,
      paused: true,
      slots: [slot(1, 'running', 'issue:101'), slot(2, 'idle', null)],
    };
    const report = buildStatusReport(state, { max_slots: 4 }, 'p');
    expect(report.paused).toBe(true);
    expect(report.live_slots).toBe(1);
    expect(report.max_slots).toBe(4);
    expect(report.runnable).toBe(0);
    expect(report.runnable_units).toEqual([]);
  });

  it('flags entries blocked on deps missing from the queue', () => {
    const state = enqueueEntries(createEmptyState(), [{ issue: 1, deps: [999] }], NOW);
    const report = buildStatusReport(state, { max_slots: 3 }, 'p');
    expect(report.blocked[0].reason).toContain('#999 is not in the queue');
    expect(report.runnable).toBe(0);
  });

  it('joins ALL dependency blockers, not just the first', () => {
    const state = enqueueEntries(createEmptyState(), [{ issue: 1, deps: [900, 901, 902] }], NOW);
    const report = buildStatusReport(state, { max_slots: 3 }, 'p');
    expect(report.blocked[0].reason).toContain('#900');
    expect(report.blocked[0].reason).toContain('#901');
    expect(report.blocked[0].reason).toContain('#902');
  });
});
