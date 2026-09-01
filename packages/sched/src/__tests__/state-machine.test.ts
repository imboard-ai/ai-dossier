import { describe, expect, it } from 'vitest';
import {
  createEmptyState,
  enqueueEntries,
  findBatch,
  findEntry,
  IllegalTransitionError,
  type IssueStatus,
  requeueMember,
  SATISFIED_ISSUE_STATUSES,
  SCHEMA_VERSION,
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

  it('walks the detached-ship park rail (#468): dispatched → parked → shipped → done', () => {
    let state = seeded();
    state = transitionIssue(state, 101, 'classified', {}, NOW2);
    state = transitionIssue(state, 101, 'dispatched', {}, NOW2);
    state = transitionIssue(state, 101, 'parked', { pr: 55 }, NOW2);
    const parked = findEntry(state, 101);
    expect(parked?.status).toBe('parked');
    expect(parked?.pr).toBe(55);
    // parked is NOT a satisfied status — gating on MERGE, never the park (AC4)
    expect(SATISFIED_ISSUE_STATUSES.has('parked')).toBe(false);
    state = transitionIssue(state, 101, 'shipped', {}, NOW2);
    state = transitionIssue(state, 101, 'done', {}, NOW2);
    expect(findEntry(state, 101)?.status).toBe('done');
  });

  it('parked entries keep the universal failure edges (watcher failures, AC3)', () => {
    let state = seeded();
    state = transitionIssue(state, 101, 'classified', {}, NOW);
    state = transitionIssue(state, 101, 'dispatched', {}, NOW);
    state = transitionIssue(state, 101, 'parked', { pr: 55 }, NOW);
    expect(() =>
      transitionIssue(state, 101, 'failed', { reason: 'pr-conflicting' }, NOW2)
    ).not.toThrow();
    expect(() => transitionIssue(state, 101, 'blocked', {}, NOW2)).not.toThrow();
  });

  it('parked is reachable only from dispatched, and leaves only to shipped (+failure edges)', () => {
    let state = seeded();
    // not from queued
    expect(() => transitionIssue(state, 101, 'parked', { pr: 55 }, NOW)).toThrow(
      IllegalTransitionError
    );
    state = transitionIssue(state, 101, 'classified', {}, NOW);
    expect(() => transitionIssue(state, 101, 'parked', { pr: 55 }, NOW)).toThrow(
      IllegalTransitionError
    );
    state = transitionIssue(state, 101, 'dispatched', {}, NOW);
    state = transitionIssue(state, 101, 'parked', { pr: 55 }, NOW);
    // requeued is still reachable only THROUGH evicted, never directly
    expect(() => transitionIssue(state, 101, 'requeued', {}, NOW)).toThrow(IllegalTransitionError);
    // ...but evicted itself is legal from parked (#472): a dissolving batch
    // requeues every unshipped member whatever state it reached, and an
    // unmodelled edge there throws mid-eviction, after the reverts have landed.
    const evicted = transitionIssue(state, 101, 'evicted', {}, NOW);
    expect(findEntry(evicted, 101)?.status).toBe('evicted');
  });

  it('lets a halved dissolve put a requeued member back on the batch rail (#472)', () => {
    let state = seeded();
    state = transitionIssue(state, 201, 'classified', {}, NOW);
    state = transitionIssue(state, 201, 'batched', {}, NOW);
    state = transitionIssue(state, 201, 'evicted', {}, NOW);
    state = transitionIssue(state, 201, 'requeued', { mode: 'slot', batch: 'b1' }, NOW);
    // Without requeued → batched, a member requeued into a half-batch is
    // dispatchable as neither an issue unit nor a batch member.
    state = transitionIssue(state, 201, 'batched', {}, NOW);
    expect(findEntry(state, 201)?.status).toBe('batched');
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

  it('failed has exactly one outgoing edge, to shipped (#501 stale-failure reconcile)', () => {
    let state = seeded();
    state = transitionIssue(state, 101, 'classified', {}, NOW);
    state = transitionIssue(state, 101, 'dispatched', {}, NOW);
    state = transitionIssue(state, 101, 'parked', { pr: 55 }, NOW);
    state = transitionIssue(state, 101, 'failed', { reason: 'auto-merge-blocked' }, NOW2);

    // `state` is the pre-transition value — transitionIssue is pure (state.ts
    // header invariant), so re-using it below for every other target is safe.
    const shipped = transitionIssue(state, 101, 'shipped', { reason: null }, NOW2);
    expect(findEntry(shipped, 101)?.status).toBe('shipped');

    const ALL_STATUSES: IssueStatus[] = [
      'queued',
      'classified',
      'dispatched',
      'parked',
      'shipped',
      'done',
      'batched',
      'waiting',
      'in-work',
      'committed',
      'validated',
      'shipped-in-batch',
      'evicted',
      'requeued',
      'blocked',
      'decision-pending',
      'failed',
    ];
    for (const to of ALL_STATUSES) {
      if (to === 'shipped') continue; // already proven above
      expect(() => transitionIssue(state, 101, to, {}, NOW2)).toThrow(IllegalTransitionError);
    }
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

// #503 finding 2 (superseded #472 review, carried into #498's implementation):
// `requeued → requeued` is not a declared rail edge (ISSUE_BASE_TRANSITIONS
// above has `requeued: ['dispatched', 'batched']`), so a requeue loop that
// re-requeues an already-`requeued` entry would throw IllegalTransitionError
// if it ever routed through `transitionIssue`. `requeueMember` avoids the
// edge entirely by retagging metadata in place for queued/classified/requeued
// entries — this pins that guard so a regression here fails loudly.
describe('requeueMember (#503: requeued → requeued must not throw)', () => {
  it('is idempotent on an already-requeued entry — no IllegalTransitionError, metadata retagged', () => {
    let state = seeded();
    state = transitionIssue(state, 201, 'classified', {}, NOW);
    state = transitionIssue(state, 201, 'batched', {}, NOW);
    state = transitionIssue(state, 201, 'evicted', {}, NOW);
    state = transitionIssue(state, 201, 'requeued', { mode: 'slot', batch: 'b1' }, NOW);
    expect(findEntry(state, 201)?.status).toBe('requeued');

    let result: ReturnType<typeof requeueMember> | undefined;
    expect(() => {
      result = requeueMember(state, 201, { mode: 'full', batch: null }, 're-requeued', NOW2);
    }).not.toThrow();

    expect(result?.requeued).toBe(true);
    const entry = findEntry(result?.state as SchedState, 201);
    expect(entry?.status).toBe('requeued');
    expect(entry?.mode).toBe('full');
    expect(entry?.batch).toBeNull();
    expect(entry?.reason).toBe('re-requeued');
    expect(entry?.updated_at).toBe(NOW2.toISOString());
  });

  it('short-circuits queued/classified entries the same way, without a status edge', () => {
    const state = seeded();
    const result = requeueMember(
      state,
      101,
      { mode: 'full', batch: null },
      'requeue-from-queued',
      NOW2
    );
    expect(result.requeued).toBe(true);
    expect(findEntry(result.state, 101)?.status).toBe('queued');
  });

  it('routes an active entry through evicted → requeued', () => {
    let state = seeded();
    state = transitionIssue(state, 101, 'classified', {}, NOW);
    state = transitionIssue(state, 101, 'dispatched', {}, NOW);
    const result = requeueMember(
      state,
      101,
      { mode: 'full', batch: null },
      'batch-dissolved',
      NOW2
    );
    expect(result.requeued).toBe(true);
    expect(findEntry(result.state, 101)?.status).toBe('requeued');
  });

  it('leaves a preserved (terminal) member alone', () => {
    let state = seeded();
    state = transitionIssue(state, 101, 'classified', {}, NOW);
    state = transitionIssue(state, 101, 'dispatched', {}, NOW);
    state = transitionIssue(state, 101, 'shipped', {}, NOW);
    state = transitionIssue(state, 101, 'done', {}, NOW);
    const result = requeueMember(state, 101, { mode: 'full', batch: null }, 'noop', NOW2);
    expect(result.requeued).toBe(false);
    expect(findEntry(result.state, 101)?.status).toBe('done');
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
          role: 'cycle',
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

describe('schema migrations (1.0.0 → 1.1.0 → 1.2.0 → 1.3.0 → 1.4.0 → 1.5.0)', () => {
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
    expect(migrated.schema_version).toBe(SCHEMA_VERSION);
    expect(migrated.slots[0].branch).toBeNull();
    expect(migrated.slots[0].last_head).toBeNull();
    // everything #460 persisted is preserved
    expect(migrated.slots[0].pid).toBe(4242);
    expect(migrated.entries[0].issue).toBe(101);
  });

  it('loads a pre-#468 1.1.0 state and backfills pr/cleanup/last_pr_poll_at as null', () => {
    // Exactly what #464 persisted: entries without pr/cleanup, no
    // last_pr_poll_at on the state.
    const legacy = {
      schema_version: '1.1.0',
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
          pid_start: null,
          phase: 'ship',
          last_progress_at: NOW.toISOString(),
          branch: 'feature/101-x',
          last_head: null,
          recoveries: 0,
          updated_at: NOW.toISOString(),
        },
      ],
      next_slot_id: 2,
    };
    const migrated = validateState(legacy);
    expect(migrated.schema_version).toBe(SCHEMA_VERSION);
    expect(migrated.entries[0].pr).toBeNull();
    expect(migrated.entries[0].cleanup).toBeNull();
    expect(migrated.last_pr_poll_at).toBeNull();
    // everything #464 persisted is preserved
    expect(migrated.slots[0].branch).toBe('feature/101-x');
    expect(migrated.entries[0].status).toBe('dispatched');
  });

  it('loads a pre-#472 1.2.0 state and backfills the recovery fields', () => {
    // Exactly what #468 persisted: entries with pr/cleanup but no
    // failure_evidence, batches with none of the recovery fields.
    const legacy = {
      schema_version: '1.2.0',
      paused: false,
      entries: [
        {
          issue: 201,
          mode: 'slot',
          batch: 'b1',
          deps: [],
          tier: 'mid',
          status: 'committed',
          reason: null,
          pr: 77,
          cleanup: null,
          enqueued_at: NOW.toISOString(),
          updated_at: NOW.toISOString(),
        },
      ],
      batches: [
        {
          id: 'b1',
          status: 'validating',
          members: [201],
          base_branch: 'main',
          executing_member: 1,
          created_at: NOW.toISOString(),
          updated_at: NOW.toISOString(),
        },
      ],
      slots: [],
      next_slot_id: 1,
      last_pr_poll_at: null,
    };
    const migrated = validateState(legacy);
    expect(migrated.schema_version).toBe(SCHEMA_VERSION);
    expect(migrated.entries[0].failure_evidence).toBeNull();
    const batch = findBatch(migrated, 'b1');
    expect(batch?.anchor).toBeNull();
    expect(batch?.branch).toBeNull();
    expect(batch?.run_id).toBeNull();
    expect(batch?.eviction_groups).toEqual([]);
    expect(batch?.evictions).toEqual([]);
    expect(batch?.fix_attempts).toEqual([]);
    expect(batch?.rebase_attempts).toBe(0);
    // everything #468 persisted is preserved
    expect(migrated.entries[0].pr).toBe(77);
    expect(batch?.status).toBe('validating');
    expect(batch?.executing_member).toBe(1);
  });

  it('loads a pre-#500 1.3.0 state and backfills slot role via the phase fallback when no queue entry matches', () => {
    // A slot whose unit has no queue entry (crash-window orphan, or a unit
    // parsing edge case) falls back to the phase check: phase 'report'
    // backfills role='report', anything else backfills 'cycle'.
    const legacy = {
      schema_version: '1.3.0',
      paused: false,
      entries: [
        {
          issue: 102,
          mode: 'full',
          batch: null,
          deps: [],
          tier: 'mid',
          status: 'dispatched',
          reason: null,
          pr: null,
          cleanup: null,
          failure_evidence: null,
          enqueued_at: NOW.toISOString(),
          updated_at: NOW.toISOString(),
        },
      ],
      batches: [],
      slots: [
        {
          id: 1,
          status: 'running',
          unit: 'issue:999',
          pid: 4242,
          pid_start: null,
          phase: 'report',
          last_progress_at: NOW.toISOString(),
          branch: null,
          last_head: null,
          recoveries: 0,
          updated_at: NOW.toISOString(),
        },
        {
          id: 2,
          status: 'running',
          unit: 'issue:102',
          pid: 4343,
          pid_start: null,
          phase: 'implement',
          last_progress_at: NOW.toISOString(),
          branch: 'feature/102-x',
          last_head: null,
          recoveries: 0,
          updated_at: NOW.toISOString(),
        },
      ],
      next_slot_id: 3,
      last_pr_poll_at: null,
    };
    const migrated = validateState(legacy);
    expect(migrated.schema_version).toBe(SCHEMA_VERSION);
    expect(migrated.slots.find((s) => s.id === 1)?.role).toBe('report');
    expect(migrated.slots.find((s) => s.id === 2)?.role).toBe('cycle');
    // everything #472 persisted is preserved
    expect(migrated.slots.find((s) => s.id === 1)?.phase).toBe('report');
  });

  it('#500: recovers role from the queue entry even when phase already drifted off "report" — the exact production scenario', () => {
    // The production case from the bug report: a live report agent whose
    // slot.phase drifted to 'ship' (phase-updated resyncing to the issue's
    // stale pre-report milestone) BEFORE the operator upgraded. A
    // phase-only backfill would silently produce role='cycle' here,
    // reopening #500 on the very first tick after migration. The
    // entry-status check (shipped + pr + cleanup, the same guard
    // `dispatchReportAgents` used to assign this slot in the first place)
    // recovers the correct answer regardless of what phase drifted to.
    const legacy = {
      schema_version: '1.3.0',
      paused: false,
      entries: [
        {
          issue: 101,
          mode: 'full',
          batch: null,
          deps: [],
          tier: 'mid',
          status: 'shipped',
          reason: null,
          pr: 55,
          cleanup: 'done',
          failure_evidence: null,
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
          pid_start: null,
          phase: 'ship', // drifted off 'report' before the upgrade
          last_progress_at: NOW.toISOString(),
          branch: null,
          last_head: null,
          recoveries: 0,
          updated_at: NOW.toISOString(),
        },
      ],
      next_slot_id: 2,
      last_pr_poll_at: null,
    };
    const migrated = validateState(legacy);
    expect(migrated.schema_version).toBe(SCHEMA_VERSION);
    expect(migrated.slots.find((s) => s.id === 1)?.role).toBe('report');
    expect(migrated.slots.find((s) => s.id === 1)?.phase).toBe('ship'); // phase itself is untouched by the migration
    expect(migrated.entries[0].pr).toBe(55);
  });

  it('#500: an entry that is shipped but missing pr or cleanup does not count as a report slot', () => {
    const legacy = {
      schema_version: '1.3.0',
      paused: false,
      entries: [
        {
          issue: 101,
          mode: 'full',
          batch: null,
          deps: [],
          tier: 'mid',
          status: 'shipped',
          reason: null,
          pr: null,
          cleanup: null,
          failure_evidence: null,
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
          pid_start: null,
          phase: 'ship',
          last_progress_at: NOW.toISOString(),
          branch: null,
          last_head: null,
          recoveries: 0,
          updated_at: NOW.toISOString(),
        },
      ],
      next_slot_id: 2,
      last_pr_poll_at: null,
    };
    const migrated = validateState(legacy);
    expect(migrated.slots.find((s) => s.id === 1)?.role).toBe('cycle');
  });

  it('#505: loads a pre-#505 1.4.0 state and backfills the dispatch-health fields', () => {
    // Exactly what a 1.4.0 sched persisted: no consecutive_suspect_dispatches
    // or last_suspect_dispatch_unit — no suspect dispatches were ever tracked,
    // so 0/null is the exact answer, not a guess.
    const legacy = {
      schema_version: '1.4.0',
      paused: false,
      entries: [],
      batches: [],
      slots: [],
      next_slot_id: 1,
      last_pr_poll_at: null,
    };
    const migrated = validateState(legacy);
    expect(migrated.schema_version).toBe(SCHEMA_VERSION);
    expect(migrated.consecutive_suspect_dispatches).toBe(0);
    expect(migrated.last_suspect_dispatch_unit).toBeNull();
  });

  it('#505: rejects a negative consecutive_suspect_dispatches rather than coercing it', () => {
    const state = seeded();
    expect(() => validateState({ ...state, consecutive_suspect_dispatches: -1 })).toThrow(
      /consecutive_suspect_dispatches/
    );
  });

  it('#505: rejects a nonzero count with no last_suspect_dispatch_unit', () => {
    const state = seeded();
    expect(() =>
      validateState({
        ...state,
        consecutive_suspect_dispatches: 1,
        last_suspect_dispatch_unit: null,
      })
    ).toThrow(/zero.*null/);
  });

  it('#505: rejects a last_suspect_dispatch_unit with a zero count', () => {
    const state = seeded();
    expect(() =>
      validateState({
        ...state,
        consecutive_suspect_dispatches: 0,
        last_suspect_dispatch_unit: 'issue:101',
      })
    ).toThrow(/zero.*null/);
  });

  it('rejects a malformed slot role', () => {
    const state = seeded();
    const bad = {
      ...state,
      slots: [
        {
          id: 1,
          status: 'idle',
          unit: null,
          pid: null,
          pid_start: null,
          phase: null,
          role: 'admin',
          last_progress_at: null,
          branch: null,
          last_head: null,
          recoveries: 0,
          updated_at: NOW.toISOString(),
        },
      ],
    };
    expect(() => validateState(bad)).toThrow(/role must be/);
  });

  it('rejects malformed recovery fields rather than coercing them', () => {
    const state = seeded();
    const badGroups = {
      ...state,
      batches: state.batches.map((b) => ({ ...b, eviction_groups: [[201, 'nope']] })),
    };
    expect(() => validateState(badGroups)).toThrow(/eviction group/);

    const badAnchor = {
      ...state,
      batches: state.batches.map((b) => ({ ...b, anchor: -1 })),
    };
    expect(() => validateState(badAnchor)).toThrow(/anchor must be a positive integer/);

    const badRebase = {
      ...state,
      batches: state.batches.map((b) => ({ ...b, rebase_attempts: -2 })),
    };
    expect(() => validateState(badRebase)).toThrow(/rebase_attempts/);

    const badEvidence = {
      ...state,
      entries: state.entries.map((e) => ({ ...e, failure_evidence: { batch: '' } })),
    };
    expect(() => validateState(badEvidence)).toThrow(/failure_evidence\.batch/);
  });

  it('rejects a malformed pr field', () => {
    const state = seeded();
    const bad = {
      ...state,
      entries: state.entries.map((e) => ({ ...e, pr: 'not-a-number' })),
    };
    expect(() => validateState(bad)).toThrow(/pr must be a positive integer or null/);
  });

  it('rejects a malformed last_pr_poll_at', () => {
    const state = seeded();
    const bad = { ...state, last_pr_poll_at: 'yesterday' };
    expect(() => validateState(bad)).toThrow(/last_pr_poll_at/);
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
          role: 'cycle' as const,
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
