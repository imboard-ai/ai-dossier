import { describe, expect, it } from 'vitest';
import {
  buildStatusReport,
  createEmptyState,
  enqueueEntries,
  type SchedState,
  type SlotEntry,
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
    role: 'cycle',
    last_progress_at: null,
    pid_start: null,
    branch: null,
    last_head: null,
    recoveries: 0,
    updated_at: NOW.toISOString(),
  };
}

describe('buildStatusReport', () => {
  it('classifies runnable, blocked, and failed entries (AC4)', () => {
    let state = seeded();
    // #102 blocked on unmerged #101; #101 runnable; batch b1 sealed (by enqueueEntries) and runnable
    state = transitionIssue(state, 101, 'classified', {}, NOW);

    const report = buildStatusReport(state, { max_slots: 3 }, 'test-proj');
    expect(report.runnable).toBe(2);
    // #565: runnable_units is priority-ordered, not queue-insertion-ordered —
    // a batch's default priority (10) outranks a full-cycle entry's (0).
    expect(report.runnable_units).toEqual(['batch:b1', 'issue:101']);
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

  it('#501: a stale-failure-reconciled unit no longer appears under failed', () => {
    let state = seeded();
    state = transitionIssue(state, 101, 'failed', { reason: 'auto-merge-blocked' }, NOW);
    state = transitionIssue(state, 101, 'shipped', { reason: null }, NOW);
    const report = buildStatusReport(state, { max_slots: 3 }, 'p');
    expect(report.failed).toEqual([]);
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

  it('#505: surfaces the dispatch-health counters', () => {
    let state = seeded();
    state = {
      ...state,
      consecutive_suspect_dispatches: 1,
      last_suspect_dispatch_unit: 'issue:101',
    };
    const report = buildStatusReport(state, { max_slots: 3 }, 'p');
    expect(report.dispatch_health).toEqual({
      consecutive_suspect: 1,
      last_suspect_unit: 'issue:101',
    });
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

describe('#468: parked units in the status report', () => {
  it('parked entries surface with their PR and consume zero live slots', () => {
    let state = seeded();
    state = transitionIssue(state, 101, 'classified', {}, NOW);
    state = transitionIssue(state, 101, 'dispatched', {}, NOW);
    state = transitionIssue(state, 101, 'parked', { pr: 55 }, NOW);

    const report = buildStatusReport(state, { max_slots: 3 }, 'proj');
    expect(report.parked).toEqual([{ issue: 101, pr: 55, since: NOW.toISOString() }]);
    expect(report.live_slots).toBe(0);
    // the dependent stays runnable-blocked while parked (gating on MERGE)
    expect(report.blocked.some((b) => b.issue === 102)).toBe(true);
  });

  it('shipped units are no longer parked; cleanup rides the queue entry', () => {
    let state = seeded();
    state = transitionIssue(state, 101, 'classified', {}, NOW);
    state = transitionIssue(state, 101, 'dispatched', {}, NOW);
    state = transitionIssue(state, 101, 'parked', { pr: 55 }, NOW);
    state = transitionIssue(state, 101, 'shipped', {}, NOW);
    state = {
      ...state,
      entries: state.entries.map((e) => (e.issue === 101 ? { ...e, cleanup: 'done' } : e)),
    };

    const report = buildStatusReport(state, { max_slots: 3 }, 'proj');
    expect(report.parked).toEqual([]);
    expect(report.queue.find((e) => e.issue === 101)?.cleanup).toBe('done');
    // merged → the dependent is no longer blocked
    expect(report.blocked.some((b) => b.issue === 102)).toBe(false);
  });
});

describe('#544: the label-poll timestamp is reported', () => {
  it('carries last_label_poll_at through to the report', () => {
    const state: SchedState = { ...seeded(), last_label_poll_at: NOW.toISOString() };
    expect(buildStatusReport(state, { max_slots: 3 }, 'proj').last_label_poll_at).toBe(
      NOW.toISOString()
    );
  });

  it('reports null before the engine has ever re-read labels', () => {
    expect(buildStatusReport(seeded(), { max_slots: 3 }, 'proj').last_label_poll_at).toBeNull();
  });
});
