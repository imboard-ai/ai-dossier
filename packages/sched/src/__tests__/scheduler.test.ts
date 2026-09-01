import { describe, expect, it } from 'vitest';
import {
  abandonBatch,
  abandonIssue,
  computeAssignments,
  createEmptyState,
  enqueueEntries,
  runnableUnits,
  setPaused,
  transitionBatch,
  transitionIssue,
  transitionSlot,
} from '../index';

const NOW = new Date('2026-08-29T12:00:00Z');
const NOW2 = new Date('2026-08-29T12:10:00Z');

/** Drive an entry from classified-or-dispatched to 'shipped' so dependents unlock. */
function satisfy(state: ReturnType<typeof createEmptyState>, issue: number) {
  const status = state.entries.find((e) => e.issue === issue)?.status;
  let s = state;
  if (status === 'queued') s = transitionIssue(s, issue, 'classified', {}, NOW);
  if (status === 'queued' || status === 'classified')
    s = transitionIssue(s, issue, 'dispatched', {}, NOW);
  return transitionIssue(s, issue, 'shipped', {}, NOW);
}

describe('computeAssignments — max_slots bound (AC5)', () => {
  it('never assigns more units than max_slots', () => {
    const state = enqueueEntries(
      createEmptyState(),
      [1, 2, 3, 4, 5].map((issue) => ({ issue })),
      NOW
    );
    const { state: s1, assignments: a1 } = computeAssignments(state, { max_slots: 2 }, NOW2);
    expect(a1).toHaveLength(2);
    expect(s1.slots.filter((s) => s.status === 'assigned')).toHaveLength(2);
    // a second pass with capacity exhausted assigns nothing
    const { assignments: a2 } = computeAssignments(s1, { max_slots: 2 }, NOW2);
    expect(a2).toHaveLength(0);
  });

  it('reuses idle slots before materializing new ones', () => {
    const state = enqueueEntries(createEmptyState(), [{ issue: 1 }, { issue: 2 }], NOW);
    const r1 = computeAssignments(state, { max_slots: 3 }, NOW2);
    expect(r1.assignments).toHaveLength(2);
    // complete one unit's slot cycle → idle
    let s = r1.state;
    s = transitionSlot(s, r1.assignments[0].slot, 'running', { pid: 1 }, NOW2);
    s = transitionSlot(s, r1.assignments[0].slot, 'exited', {}, NOW2);
    s = transitionSlot(s, r1.assignments[0].slot, 'verifying', {}, NOW2);
    s = transitionSlot(s, r1.assignments[0].slot, 'complete', {}, NOW2);
    s = transitionSlot(s, r1.assignments[0].slot, 'idle', {}, NOW2);
    const r2 = computeAssignments(s, { max_slots: 3 }, NOW2);
    expect(r2.assignments).toHaveLength(1);
    expect(r2.state.slots).toHaveLength(2); // no third slot materialized
    expect(r2.assignments[0].slot).toBe(r1.assignments[0].slot); // reused the idle one
  });

  it('counts live slots (assigned | running | recovering) against the bound', () => {
    const state = enqueueEntries(createEmptyState(), [{ issue: 1 }, { issue: 2 }], NOW);
    const r1 = computeAssignments(state, { max_slots: 2 }, NOW2);
    let s = transitionSlot(r1.state, r1.assignments[0].slot, 'running', { pid: 9 }, NOW2);
    // one running, one assigned → zero free capacity
    const { assignments: none } = computeAssignments(s, { max_slots: 2 }, NOW2);
    expect(none).toHaveLength(0);
    // recovering also holds capacity
    s = transitionSlot(s, r1.assignments[1].slot, 'running', { pid: 10 }, NOW2);
    s = transitionSlot(s, r1.assignments[0].slot, 'recovering', {}, NOW2);
    const { assignments: stillNone } = computeAssignments(s, { max_slots: 2 }, NOW2);
    expect(stillNone).toHaveLength(0);
  });
});

describe('computeAssignments — dependency gating (AC5)', () => {
  it('an issue with an unmerged dependency is never runnable', () => {
    const state = enqueueEntries(
      createEmptyState(),
      [{ issue: 100 }, { issue: 101, deps: [100] }],
      NOW
    );
    // only #100 runnable
    const r = computeAssignments(state, { max_slots: 4 }, NOW2);
    expect(r.assignments.map((a) => a.issue)).toEqual([100]);

    // dependency still not merged (dispatched) → #101 still blocked
    let mid = transitionIssue(r.state, 100, 'classified', {}, NOW2);
    mid = transitionIssue(mid, 100, 'dispatched', {}, NOW2);
    expect(computeAssignments(mid, { max_slots: 4 }, NOW2).assignments).toHaveLength(0);

    // dependency merged → #101 runs
    const unlocked = satisfy(mid, 100);
    const r2 = computeAssignments(unlocked, { max_slots: 4 }, NOW2);
    expect(r2.assignments.map((a) => a.issue)).toEqual([101]);
  });

  it('a dep missing from the queue blocks forever and is nameable', () => {
    const state = enqueueEntries(createEmptyState(), [{ issue: 1, deps: [999] }], NOW);
    expect(runnableUnits(state)).toHaveLength(0);
  });

  it('intra-batch deps do not block the batch; cross-batch deps gate on merge', () => {
    let state = enqueueEntries(
      createEmptyState(),
      [
        { issue: 1, mode: 'slot', batch: 'b1' },
        { issue: 2, mode: 'slot', batch: 'b1', deps: [1] }, // intra-batch: fine
        { issue: 3, mode: 'slot', batch: 'b2', deps: [1] }, // cross-batch: b2 after b1
      ],
      NOW
    );
    // seal both batches
    state = transitionBatch(state, 'b1', 'ready', {}, NOW);
    state = transitionBatch(state, 'b2', 'ready', {}, NOW);

    const units = runnableUnits(state);
    expect(units).toEqual([{ kind: 'batch', batch: 'b1' }]); // b2 gated on b1's merge

    // b1 merged → b2 becomes runnable
    let merged = transitionBatch(state, 'b1', 'executing', {}, NOW);
    merged = transitionBatch(merged, 'b1', 'validating', {}, NOW);
    merged = transitionBatch(merged, 'b1', 'reviewing', {}, NOW);
    merged = transitionBatch(merged, 'b1', 'shipping', {}, NOW);
    merged = transitionBatch(merged, 'b1', 'awaiting-merge', {}, NOW);
    merged = transitionBatch(merged, 'b1', 'merged', {}, NOW);
    expect(runnableUnits(merged)).toContainEqual({ kind: 'batch', batch: 'b2' });
  });

  it('a batch unit is assigned as one slot and unlocks member work', () => {
    let state = enqueueEntries(
      createEmptyState(),
      [
        { issue: 1, mode: 'slot', batch: 'b1' },
        { issue: 2, mode: 'slot', batch: 'b1' },
      ],
      NOW
    );
    state = transitionBatch(state, 'b1', 'ready', {}, NOW);
    const r = computeAssignments(state, { max_slots: 2 }, NOW2);
    expect(r.assignments).toEqual([{ slot: 1, kind: 'batch', batch: 'b1' }]);
    expect(r.state.slots[0].unit).toBe('batch:b1');
  });
});

describe('pause / resume', () => {
  it('a paused scheduler makes no assignments; resume restores them', () => {
    let state = enqueueEntries(createEmptyState(), [{ issue: 1 }], NOW);
    state = setPaused(state, true);
    expect(computeAssignments(state, { max_slots: 3 }, NOW2).assignments).toHaveLength(0);
    state = setPaused(state, false);
    expect(computeAssignments(state, { max_slots: 3 }, NOW2).assignments).toHaveLength(1);
  });

  it('#505: pausing preserves the dispatch-health streak; resuming clears it', () => {
    let state: ReturnType<typeof createEmptyState> = {
      ...createEmptyState(),
      consecutive_suspect_dispatches: 1,
      last_suspect_dispatch_unit: 'issue:101',
    };
    state = setPaused(state, true);
    // Pausing is orthogonal to the streak — it may have BEEN what triggered
    // the pause; a manual `sched pause` must not silently erase evidence.
    expect(state.consecutive_suspect_dispatches).toBe(1);
    expect(state.last_suspect_dispatch_unit).toBe('issue:101');

    state = setPaused(state, false);
    // Resuming is the operator's "I've addressed this" — the streak (and
    // any `sched status` warning citing it) should not linger afterward.
    expect(state.consecutive_suspect_dispatches).toBe(0);
    expect(state.last_suspect_dispatch_unit).toBeNull();
  });
});

describe('abandon', () => {
  it('abandonIssue fails the entry and releases its slot', () => {
    const state = enqueueEntries(createEmptyState(), [{ issue: 1 }], NOW);
    const r = computeAssignments(state, { max_slots: 1 }, NOW2);
    const s = transitionSlot(r.state, 1, 'running', { pid: 77 }, NOW2);
    const out = abandonIssue(s, 1, 'operator abort', NOW2);
    expect(out.state.entries.find((e) => e.issue === 1)?.status).toBe('failed');
    expect(out.state.entries.find((e) => e.issue === 1)?.reason).toBe('operator abort');
    expect(out.releasedSlots).toEqual([1]);
    expect(out.state.slots[0].status).toBe('idle');
    expect(out.state.slots[0].unit).toBeNull();
  });

  it('abandonIssue refuses terminal entries and unknown issues', () => {
    let state = enqueueEntries(createEmptyState(), [{ issue: 1 }], NOW);
    state = satisfy(state, 1);
    state = transitionIssue(state, 1, 'done', {}, NOW);
    expect(() => abandonIssue(state, 1)).toThrow(/already done/);
    expect(() => abandonIssue(state, 42)).toThrow(/not found/);
  });

  it('abandonBatch dissolves the batch and requeues members as full-cycle', () => {
    let state = enqueueEntries(
      createEmptyState(),
      [
        { issue: 1, mode: 'slot', batch: 'b1' },
        { issue: 2, mode: 'slot', batch: 'b1' },
      ],
      NOW
    );
    state = transitionBatch(state, 'b1', 'ready', {}, NOW);
    state = transitionBatch(state, 'b1', 'executing', {}, NOW);
    // #1 mid-member (walk the slot rail to in-work), #2 still waiting
    state = transitionIssue(state, 1, 'classified', {}, NOW);
    state = transitionIssue(state, 1, 'batched', {}, NOW);
    state = transitionIssue(state, 1, 'waiting', {}, NOW);
    state = transitionIssue(state, 1, 'in-work', {}, NOW);
    const out = abandonBatch(state, 'b1', 'operator dissolve', NOW2);
    expect(out.state.batches.find((b) => b.id === 'b1')?.status).toBe('dissolved');
    expect(new Set(out.requeued)).toEqual(new Set([1, 2]));
    for (const issue of [1, 2]) {
      const entry = out.state.entries.find((e) => e.issue === issue);
      expect(entry?.mode).toBe('full');
      expect(entry?.batch).toBeNull();
      expect(['requeued', 'queued']).toContain(entry?.status);
    }
  });

  it('abandonBatch leaves shipped members untouched', () => {
    let state = enqueueEntries(
      createEmptyState(),
      [
        { issue: 1, mode: 'slot', batch: 'b1' },
        { issue: 2, mode: 'slot', batch: 'b1' },
      ],
      NOW
    );
    state = transitionBatch(state, 'b1', 'ready', {}, NOW);
    state = transitionIssue(state, 1, 'classified', {}, NOW);
    state = transitionIssue(state, 1, 'batched', {}, NOW);
    state = transitionIssue(state, 1, 'waiting', {}, NOW);
    state = transitionIssue(state, 1, 'in-work', {}, NOW);
    state = transitionIssue(state, 1, 'committed', {}, NOW);
    state = transitionIssue(state, 1, 'validated', {}, NOW);
    state = transitionIssue(state, 1, 'shipped-in-batch', {}, NOW);
    const out = abandonBatch(state, 'b1', 'late dissolve', NOW2);
    expect(out.requeued).toEqual([2]);
    expect(out.state.entries.find((e) => e.issue === 1)?.status).toBe('shipped-in-batch');
  });

  it('abandonBatch refuses terminal batches', () => {
    const state = enqueueEntries(
      createEmptyState(),
      [{ issue: 1, mode: 'slot', batch: 'b1' }],
      NOW
    );
    expect(() => abandonBatch(state, 'nope')).toThrow(/not found/);
  });
});
