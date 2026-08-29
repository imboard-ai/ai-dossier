import { describe, expect, it } from 'vitest';
import {
  createEmptyState,
  enqueueEntries,
  findBatch,
  findEntry,
  IllegalTransitionError,
  type SchedState,
  TERMINAL_BATCH_STATUSES,
  TERMINAL_ISSUE_STATUSES,
  transitionBatch,
  transitionIssue,
  transitionSlot,
  validateState,
} from '../index';

const NOW = new Date('2026-08-29T12:00:00Z');
const NOW2 = new Date('2026-08-29T12:05:00Z');

/** Build a state with one full issue and one batch of two slot issues. */
function seeded(): SchedState {
  let state = createEmptyState();
  state = enqueueEntries(
    state,
    [
      { issue: 101, mode: 'full' },
      { issue: 201, mode: 'slot', batch: 'b1' },
      { issue: 202, mode: 'slot', batch: 'b1' },
    ],
    NOW
  );
  return state;
}

describe('issue state machine (RFC-0001 §D.1)', () => {
  it('walks the full happy path', () => {
    let state = seeded();
    state = transitionIssue(state, 101, 'classified', {}, NOW2);
    state = transitionIssue(state, 101, 'dispatched', {}, NOW2);
    state = transitionIssue(state, 101, 'shipped', {}, NOW2);
    state = transitionIssue(state, 101, 'done', {}, NOW2);
    expect(findEntry(state, 101)?.status).toBe('done');
    expect(findEntry(state, 101)?.updated_at).toBe(NOW2.toISOString());
  });

  it('walks the slot happy path', () => {
    let state = seeded();
    for (const issue of [201, 202]) {
      state = transitionIssue(state, issue, 'classified', {}, NOW2);
      state = transitionIssue(state, issue, 'batched', {}, NOW2);
      state = transitionIssue(state, issue, 'waiting', {}, NOW2);
      state = transitionIssue(state, issue, 'in-work', {}, NOW2);
      state = transitionIssue(state, issue, 'committed', {}, NOW2);
      state = transitionIssue(state, issue, 'validated', {}, NOW2);
      state = transitionIssue(state, issue, 'shipped-in-batch', {}, NOW2);
      state = transitionIssue(state, issue, 'done', {}, NOW2);
    }
    expect(findEntry(state, 201)?.status).toBe('done');
  });

  it('walks the eviction rail', () => {
    let state = seeded();
    state = transitionIssue(state, 201, 'classified', {}, NOW2);
    state = transitionIssue(state, 201, 'batched', {}, NOW2);
    state = transitionIssue(state, 201, 'waiting', {}, NOW2);
    state = transitionIssue(state, 201, 'in-work', {}, NOW2);
    state = transitionIssue(state, 201, 'evicted', { reason: 'test-failure' }, NOW2);
    state = transitionIssue(state, 201, 'requeued', { mode: 'full', batch: null }, NOW2);
    expect(findEntry(state, 201)?.mode).toBe('full');
    state = transitionIssue(state, 201, 'dispatched', {}, NOW2);
    expect(findEntry(state, 201)?.status).toBe('dispatched');
  });

  it('allows blocked / decision-pending / failed from every non-terminal state', () => {
    const state = seeded();
    const statuses = [
      'queued',
      'classified',
      'dispatched',
      'batched',
      'waiting',
      'in-work',
      'committed',
      'validated',
    ] as const;
    statuses.forEach((status, i) => {
      let s = state;
      // manufacture the entry into `status` via the rails we've already tested
      if (status !== 'queued') {
        s = transitionIssue(s, 101, 'classified', {}, NOW);
        if (['batched', 'waiting', 'in-work', 'committed', 'validated'].includes(status)) {
          s = transitionIssue(s, 101, 'batched', {}, NOW);
          if (status !== 'batched') {
            s = transitionIssue(s, 101, 'waiting', {}, NOW);
            if (status !== 'waiting') {
              s = transitionIssue(s, 101, 'in-work', {}, NOW);
              if (status === 'committed' || status === 'validated') {
                s = transitionIssue(s, 101, 'committed', {}, NOW);
                if (status === 'validated') s = transitionIssue(s, 101, 'validated', {}, NOW);
              }
            }
          }
        } else if (status === 'dispatched') {
          s = transitionIssue(s, 101, 'dispatched', {}, NOW);
        }
      }
      expect(findEntry(s, 101)?.status, `setup for ${status}`).toBe(status);
      for (const edge of ['blocked', 'decision-pending', 'failed'] as const) {
        expect(() => transitionIssue(s, 101, edge, {}, NOW2), `${status} → ${edge}`).not.toThrow();
      }
      void i;
    });
  });

  it('throws IllegalTransitionError on non-declared edges', () => {
    const state = seeded();
    expect(() => transitionIssue(state, 101, 'done')).toThrow(IllegalTransitionError);
    expect(() => transitionIssue(state, 101, 'done')).toThrow('queued → done');
    expect(() => transitionIssue(state, 101, 'in-work')).toThrow(IllegalTransitionError);
    // failure out of a terminal state is illegal
    const done = transitionIssue(
      transitionIssue(
        transitionIssue(
          transitionIssue(seeded(), 101, 'classified', {}, NOW),
          101,
          'dispatched',
          {},
          NOW
        ),
        101,
        'shipped',
        {},
        NOW
      ),
      101,
      'done',
      {},
      NOW
    );
    expect(() => transitionIssue(done, 101, 'blocked')).toThrow(IllegalTransitionError);
    expect(() => transitionIssue(done, 101, 'failed')).toThrow(IllegalTransitionError);
  });

  it('throws on unknown issue', () => {
    expect(() => transitionIssue(seeded(), 999, 'classified')).toThrow('not found');
  });

  it('exposes exactly the terminal statuses', () => {
    expect(TERMINAL_ISSUE_STATUSES.has('done')).toBe(true);
    expect(TERMINAL_ISSUE_STATUSES.has('failed')).toBe(true);
    expect(TERMINAL_ISSUE_STATUSES.has('dispatched')).toBe(false);
  });
});

describe('batch state machine (RFC-0001 §D.2)', () => {
  it('walks the full happy path including merge and report', () => {
    let state = seeded();
    const path = [
      'ready',
      'executing',
      'validating',
      'reviewing',
      'shipping',
      'awaiting-merge',
      'merged',
      'deployed',
      'reported',
      'done',
    ] as const;
    for (const status of path) {
      state = transitionBatch(state, 'b1', status, {}, NOW2);
    }
    expect(findBatch(state, 'b1')?.status).toBe('done');
  });

  it('executing may self-loop (member i/N advance)', () => {
    let state = seeded();
    state = transitionBatch(state, 'b1', 'ready', { executing_member: 1 }, NOW2);
    state = transitionBatch(state, 'b1', 'executing', { executing_member: 1 }, NOW2);
    state = transitionBatch(state, 'b1', 'executing', { executing_member: 2 }, NOW2);
    expect(findBatch(state, 'b1')?.executing_member).toBe(2);
  });

  it('walks the attribute → fix → validate rail', () => {
    let state = seeded();
    state = transitionBatch(state, 'b1', 'ready', {}, NOW);
    state = transitionBatch(state, 'b1', 'executing', {}, NOW);
    state = transitionBatch(state, 'b1', 'validating', {}, NOW);
    state = transitionBatch(state, 'b1', 'attributing', {}, NOW);
    state = transitionBatch(state, 'b1', 'fixing', {}, NOW);
    state = transitionBatch(state, 'b1', 'validating', {}, NOW);
    expect(findBatch(state, 'b1')?.status).toBe('validating');
  });

  it('walks the eviction and dissolution rails', () => {
    let state = seeded();
    state = transitionBatch(state, 'b1', 'ready', {}, NOW);
    state = transitionBatch(state, 'b1', 'executing', {}, NOW);
    state = transitionBatch(state, 'b1', 'validating', {}, NOW);
    state = transitionBatch(state, 'b1', 'attributing', {}, NOW);
    state = transitionBatch(state, 'b1', 'evicting', {}, NOW);
    state = transitionBatch(state, 'b1', 'validating', {}, NOW);
    state = transitionBatch(state, 'b1', 'dissolving', {}, NOW);
    state = transitionBatch(state, 'b1', 'dissolved', {}, NOW);
    expect(TERMINAL_BATCH_STATUSES.has('dissolved')).toBe(true);
    expect(() => transitionBatch(state, 'b1', 'ready')).toThrow(IllegalTransitionError);
  });

  it('walks the conflict rail (awaiting-merge → rebasing → re-validating → shipping)', () => {
    let state = seeded();
    state = transitionBatch(state, 'b1', 'ready', {}, NOW);
    state = transitionBatch(state, 'b1', 'executing', {}, NOW);
    state = transitionBatch(state, 'b1', 'validating', {}, NOW);
    state = transitionBatch(state, 'b1', 'reviewing', {}, NOW);
    state = transitionBatch(state, 'b1', 'shipping', {}, NOW);
    state = transitionBatch(state, 'b1', 'awaiting-merge', {}, NOW);
    state = transitionBatch(state, 'b1', 'rebasing', {}, NOW);
    state = transitionBatch(state, 'b1', 're-validating', {}, NOW);
    state = transitionBatch(state, 'b1', 'shipping', {}, NOW);
    state = transitionBatch(state, 'b1', 'awaiting-merge', {}, NOW);
    state = transitionBatch(state, 'b1', 'merged', {}, NOW);
    expect(findBatch(state, 'b1')?.status).toBe('merged');
  });

  it('throws IllegalTransitionError on non-declared edges', () => {
    const state = seeded();
    expect(() => transitionBatch(state, 'b1', 'merged')).toThrow(IllegalTransitionError);
    expect(() => transitionBatch(state, 'b1', 'merged')).toThrow('forming → merged');
    expect(() => transitionBatch(state, 'nope', 'ready')).toThrow('not found');
  });
});

describe('slot state machine (RFC-0001 §D.3)', () => {
  function withIdleSlot(): SchedState {
    const state = seeded();
    return {
      ...state,
      slots: [
        {
          id: 1,
          status: 'idle',
          unit: null,
          pid: null,
          phase: null,
          last_progress_at: null,
          pid_start: null,
          branch: null,
          last_head: null,
          recoveries: 0,
          updated_at: NOW.toISOString(),
        },
      ],
      next_slot_id: 2,
    };
  }

  it('walks idle → assigned → running → exited → verifying → complete → idle', () => {
    let state = withIdleSlot();
    state = transitionSlot(state, 1, 'assigned', { unit: 'issue:101' }, NOW2);
    expect(state.slots[0].unit).toBe('issue:101');
    state = transitionSlot(state, 1, 'running', { pid: 4242, phase: 'implement' }, NOW2);
    state = transitionSlot(state, 1, 'exited', {}, NOW2);
    state = transitionSlot(state, 1, 'verifying', {}, NOW2);
    state = transitionSlot(state, 1, 'complete', {}, NOW2);
    state = transitionSlot(state, 1, 'idle', {}, NOW2);
    expect(state.slots[0].status).toBe('idle');
    // idle transition clears the unit and resets recovery count
    expect(state.slots[0].unit).toBeNull();
    expect(state.slots[0].pid).toBeNull();
    expect(state.slots[0].phase).toBeNull();
  });

  it('walks the stall ladder (running → recovering → running, then → failed → idle)', () => {
    let state = withIdleSlot();
    state = transitionSlot(state, 1, 'assigned', { unit: 'issue:101' }, NOW);
    state = transitionSlot(state, 1, 'running', { pid: 1 }, NOW);
    state = transitionSlot(state, 1, 'recovering', { recoveries: 1 }, NOW2);
    state = transitionSlot(state, 1, 'running', { pid: 2 }, NOW2);
    state = transitionSlot(state, 1, 'recovering', { recoveries: 2 }, NOW2);
    state = transitionSlot(state, 1, 'failed', {}, NOW2);
    state = transitionSlot(state, 1, 'idle', {}, NOW2);
    expect(state.slots[0].status).toBe('idle');
  });

  it('#464: verify-fail rail — exited → verifying → recovering → running (unverified exit is redispatched)', () => {
    let state = withIdleSlot();
    state = transitionSlot(state, 1, 'assigned', { unit: 'issue:101' }, NOW);
    state = transitionSlot(state, 1, 'running', { pid: 1 }, NOW);
    state = transitionSlot(state, 1, 'exited', {}, NOW2);
    state = transitionSlot(state, 1, 'verifying', {}, NOW2);
    // the extension #464 adds: an agent that exited WITHOUT verified completion
    state = transitionSlot(state, 1, 'recovering', { recoveries: 1 }, NOW2);
    state = transitionSlot(state, 1, 'running', { pid: 2 }, NOW2);
    expect(state.slots[0].status).toBe('running');
    expect(state.slots[0].recoveries).toBe(1);
  });

  it('operator abort: any unit-holding state may force failed → idle', () => {
    for (const status of ['assigned', 'running', 'exited', 'verifying', 'recovering'] as const) {
      let state = withIdleSlot();
      state = transitionSlot(state, 1, 'assigned', { unit: 'issue:101' }, NOW);
      if (status !== 'assigned') {
        state = transitionSlot(state, 1, 'running', { pid: 1 }, NOW);
        if (status === 'exited' || status === 'verifying') {
          state = transitionSlot(state, 1, 'exited', {}, NOW);
          if (status === 'verifying') state = transitionSlot(state, 1, 'verifying', {}, NOW);
        }
        if (status === 'recovering') state = transitionSlot(state, 1, 'recovering', {}, NOW);
      }
      expect(
        () => transitionSlot(state, 1, 'failed', {}, NOW2),
        `abort from ${status}`
      ).not.toThrow();
    }
  });

  it('complete cannot be forced to failed, and idle cannot abort', () => {
    let state = withIdleSlot();
    state = transitionSlot(state, 1, 'assigned', { unit: 'issue:101' }, NOW);
    state = transitionSlot(state, 1, 'running', {}, NOW);
    state = transitionSlot(state, 1, 'exited', {}, NOW);
    state = transitionSlot(state, 1, 'verifying', {}, NOW);
    state = transitionSlot(state, 1, 'complete', {}, NOW);
    expect(() => transitionSlot(state, 1, 'failed')).toThrow(IllegalTransitionError);
    expect(() => transitionSlot(withIdleSlot(), 1, 'failed')).toThrow(IllegalTransitionError);
  });

  it('throws on unknown slot', () => {
    expect(() => transitionSlot(seeded(), 99, 'assigned')).toThrow('not found');
  });
});

describe('validateState', () => {
  it('accepts a state produced by the package itself', () => {
    const state = seeded();
    expect(validateState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('rejects wrong schema version, malformed shapes, and dangling references', () => {
    const state = seeded();
    expect(() => validateState({ ...state, schema_version: '0.9.0' })).toThrow(/schema version/);
    expect(() => validateState({ ...state, paused: 'yes' })).toThrow(/paused/);
    expect(() => validateState({ ...state, entries: 'nope' })).toThrow(/entries/);
    expect(() =>
      validateState({ ...state, entries: [{ ...state.entries[0], issue: -5 }] })
    ).toThrow(/issue must be a positive integer/);
    expect(() =>
      validateState({ ...state, entries: [{ ...state.entries[0], mode: 'side' }] })
    ).toThrow(/mode/);
    expect(() =>
      validateState({
        ...state,
        entries: [...state.entries, { ...state.entries[0] }],
      })
    ).toThrow(/Duplicate queue entry/);
    // slot invariants
    const badSlot = {
      ...state,
      slots: [
        {
          id: 1,
          status: 'idle',
          unit: 'issue:101',
          pid: null,
          phase: null,
          last_progress_at: null,
          pid_start: null,
          branch: null,
          last_head: null,
          recoveries: 0,
          updated_at: NOW.toISOString(),
        },
      ],
    };
    expect(() => validateState(badSlot)).toThrow(/idle slot must not hold a unit/);
  });
});

describe('#464 schema migration (1.0.0 → 1.1.0)', () => {
  it('loads a pre-#464 1.0.0 state and backfills slot branch/last_head as null', () => {
    // Exactly what #460 persisted: no branch/last_head on slots.
    const legacy = {
      schema_version: '1.0.0',
      paused: false,
      entries: [
        {
          issue: 101,
          mode: 'full',
          batch: null,
          deps: [],
          tier: 'mid',
          status: 'dispatched',
          reason: null,
          enqueued_at: NOW.toISOString(),
          updated_at: NOW.toISOString(),
        },
      ],
      batches: [],
      slots: [
        {
          id: 1,
          status: 'running',
          unit: 'issue:101',
          pid: 4242,
          phase: 'implement',
          last_progress_at: NOW.toISOString(),
          recoveries: 0,
          updated_at: NOW.toISOString(),
        },
      ],
      next_slot_id: 2,
    };
    const migrated = validateState(legacy);
    expect(migrated.schema_version).toBe('1.1.0');
    expect(migrated.slots[0].branch).toBeNull();
    expect(migrated.slots[0].last_head).toBeNull();
    // everything #460 persisted is preserved
    expect(migrated.slots[0].pid).toBe(4242);
    expect(migrated.entries[0].issue).toBe(101);
  });

  it('current-schema states round-trip unchanged', () => {
    let state = seeded();
    state = {
      ...state,
      slots: [
        {
          id: 1,
          status: 'idle' as const,
          unit: null,
          pid: null,
          phase: null,
          last_progress_at: null,
          pid_start: null,
          branch: null,
          last_head: null,
          recoveries: 0,
          updated_at: NOW.toISOString(),
        },
      ],
      next_slot_id: 2,
    };
    state = transitionSlot(
      state,
      1,
      'assigned',
      { unit: 'issue:101', branch: 'feature/101-x', last_head: 'abc' },
      NOW
    );
    const roundTripped = validateState(JSON.parse(JSON.stringify(state)));
    expect(roundTripped.slots[0].branch).toBe('feature/101-x');
    expect(roundTripped.slots[0].last_head).toBe('abc');
  });

  it('unknown schema versions are still rejected loudly', () => {
    expect(() =>
      validateState({
        schema_version: '2.0.0',
        paused: false,
        entries: [],
        batches: [],
        slots: [],
        next_slot_id: 1,
      })
    ).toThrow(/Unsupported schema version/);
  });
});
