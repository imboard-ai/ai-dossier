import { describe, expect, it } from 'vitest';
import {
  appendEvictions,
  createBatch,
  createEmptyState,
  enqueueEntries,
  findBatch,
  findEntry,
  IllegalTransitionError,
  type IssueStatus,
  PARKED_MEMBER_STATUSES,
  parkMember,
  patchBatch,
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
// `requeued → requeued` is not a declared rail edge (state.ts's private
// `ISSUE_BASE_TRANSITIONS` has `requeued: ['dispatched', 'batched']`), so a
// requeue loop that re-requeues an already-`requeued` entry would throw
// IllegalTransitionError if it ever routed through `transitionIssue`.
// `requeueMember` avoids the edge entirely by retagging metadata in place for
// queued/classified/requeued entries — this pins that guard so a regression
// here fails loudly.
const TO_FULL = { mode: 'full', batch: null } as const;

describe('requeueMember (regressions)', () => {
  it('#771: a review=full member requeued to full-cycle keeps its strong floor as a real tier', () => {
    const base = seeded();
    let state = {
      ...base,
      entries: base.entries.map((e) =>
        e.issue === 201 ? { ...e, tier: 'mechanical' as const, review: 'full' as const } : e
      ),
    };
    state = transitionIssue(state, 201, 'classified', {}, NOW);
    state = transitionIssue(state, 201, 'batched', {}, NOW);
    const result = requeueMember(state, 201, TO_FULL, 'evicted', NOW2);
    const entry = findEntry(result.state, 201);
    expect(entry).toMatchObject({ mode: 'full', batch: null, tier: 'strong', review: 'light' });
    // A light member's tier is untouched.
    const light = requeueMember(state, 202, TO_FULL, 'evicted', NOW2);
    expect(findEntry(light.state, 202)).toMatchObject({ tier: 'mid', review: 'light' });
  });

  it('#503: is idempotent on an already-requeued entry — no IllegalTransitionError, metadata retagged', () => {
    let state = seeded();
    state = transitionIssue(state, 201, 'classified', {}, NOW);
    state = transitionIssue(state, 201, 'batched', {}, NOW);
    state = transitionIssue(state, 201, 'evicted', {}, NOW);
    state = transitionIssue(state, 201, 'requeued', { mode: 'slot', batch: 'b1' }, NOW);
    expect(findEntry(state, 201)?.status).toBe('requeued');

    const result = requeueMember(state, 201, TO_FULL, 're-requeued', NOW2);

    expect(result.requeued).toBe(true);
    const entry = findEntry(result.state, 201);
    expect(entry?.status).toBe('requeued');
    expect(entry?.mode).toBe('full');
    expect(entry?.batch).toBeNull();
    expect(entry?.reason).toBe('re-requeued');
    expect(entry?.updated_at).toBe(NOW2.toISOString());
  });

  // Mirrors scheduler.test.ts:195-220 (abandonBatch on a never-dispatched
  // member) at the unit level — kept here too since it is the same
  // short-circuit branch `requeueMember` takes for the #503 case above.
  it.each([
    'queued',
    'classified',
  ] as const)('short-circuits a %s entry the same way — metadata retagged, no status edge', (status) => {
    let state = seeded();
    if (status === 'classified') state = transitionIssue(state, 101, 'classified', {}, NOW);
    const result = requeueMember(state, 101, TO_FULL, 'requeue-from-queued', NOW2);

    expect(result.requeued).toBe(true);
    const entry = findEntry(result.state, 101);
    expect(entry?.status).toBe(status);
    expect(entry?.mode).toBe('full');
    expect(entry?.batch).toBeNull();
    expect(entry?.reason).toBe('requeue-from-queued');
    expect(entry?.updated_at).toBe(NOW2.toISOString());
  });

  // Mirrors recovery.test.ts:378 (evictMembers driving the same branch
  // through the real revert path).
  it('routes an active entry through evicted → requeued', () => {
    let state = seeded();
    state = transitionIssue(state, 101, 'classified', {}, NOW);
    state = transitionIssue(state, 101, 'dispatched', {}, NOW);
    const result = requeueMember(state, 101, TO_FULL, 'batch-dissolved', NOW2);
    expect(result.requeued).toBe(true);
    expect(findEntry(result.state, 101)?.status).toBe('requeued');
  });

  // Mirrors recovery.test.ts:605 and scheduler.test.ts:221 (preserved/shipped
  // members left untouched by eviction and abandonBatch respectively).
  it('leaves a preserved (terminal) member alone', () => {
    let state = seeded();
    state = transitionIssue(state, 101, 'classified', {}, NOW);
    state = transitionIssue(state, 101, 'dispatched', {}, NOW);
    state = transitionIssue(state, 101, 'shipped', {}, NOW);
    state = transitionIssue(state, 101, 'done', {}, NOW);
    const result = requeueMember(state, 101, TO_FULL, 'noop', NOW2);
    expect(result.requeued).toBe(false);
    expect(findEntry(result.state, 101)?.status).toBe('done');
  });
});

describe('#810: parkMember / profile-carrying requeue', () => {
  const inWork = (state: SchedState, issue: number): SchedState => {
    let next = state;
    for (const to of ['classified', 'batched', 'waiting', 'in-work'] as const) {
      next = transitionIssue(next, issue, to, {}, NOW);
    }
    return next;
  };
  const withProfile = (state: SchedState): SchedState =>
    patchBatch(state, 'b1', { dispatch_profile: 'openai' }, NOW);

  it('parks a hand-back as `handed-back` with reason, branch and the batch profile — not requeued, not dispatchable', () => {
    const state = withProfile(inWork(seeded(), 201));
    const result = parkMember(state, 201, 'handed-back', 'scope-mismatch', NOW2, {
      failure_evidence: {
        batch: 'b1',
        reason: 'scope-mismatch',
        failing_tests: [],
        attribution: 'none',
        reverted_commits: [],
        branch: 'batch/b1-m1-201',
        at: NOW2.toISOString(),
      },
    });
    expect(result.parked).toBe(true);
    expect(findEntry(result.state, 201)).toMatchObject({
      status: 'handed-back',
      mode: 'slot',
      batch: 'b1',
      reason: 'scope-mismatch',
      dispatch_profile: 'openai',
      failure_evidence: expect.objectContaining({ branch: 'batch/b1-m1-201' }),
    });
    expect(PARKED_MEMBER_STATUSES.has('handed-back')).toBe(true);
    // Parking twice is a no-op, never a second transition.
    expect(parkMember(result.state, 201, 'evicted', 'again', NOW2).parked).toBe(false);
  });

  it('parks an unverified exit as `evicted`; a classified member walks the batched waypoint first', () => {
    const state = withProfile(seeded());
    const fromClassified = parkMember(
      transitionIssue(state, 202, 'classified', {}, NOW),
      202,
      'evicted',
      'member-worktree-prep-failed:x',
      NOW2
    );
    expect(fromClassified.parked).toBe(true);
    expect(findEntry(fromClassified.state, 202)).toMatchObject({
      status: 'evicted',
      dispatch_profile: 'openai',
    });
    // `queued` has no batch-rail edge and no work — left alone.
    expect(parkMember(state, 202, 'evicted', 'x', NOW2).parked).toBe(false);
  });

  it('a parked member requeues full-cycle ONLY through requeueMember, carrying profile and evidence', () => {
    let state = withProfile(inWork(seeded(), 201));
    state = parkMember(state, 201, 'handed-back', 'needs-input', NOW, {
      failure_evidence: {
        batch: 'b1',
        reason: 'needs-input',
        failing_tests: [],
        attribution: 'none',
        reverted_commits: [],
        branch: 'batch/b1-m1-201',
        at: NOW.toISOString(),
      },
    }).state;
    const result = requeueMember(state, 201, TO_FULL, 'operator-requeue', NOW2);
    expect(result.requeued).toBe(true);
    expect(findEntry(result.state, 201)).toMatchObject({
      status: 'requeued',
      mode: 'full',
      batch: null,
      dispatch_profile: 'openai',
      failure_evidence: expect.objectContaining({ branch: 'batch/b1-m1-201' }),
    });
  });

  it('#713 class: requeueMember carries the BATCH profile onto a member whose own profile is null', () => {
    const state = withProfile(inWork(seeded(), 202));
    expect(findEntry(state, 202)?.dispatch_profile ?? null).toBeNull();
    const result = requeueMember(state, 202, TO_FULL, 'eviction-threshold', NOW2);
    expect(findEntry(result.state, 202)?.dispatch_profile).toBe('openai');
    // An explicit override wins (the profile-missing dissolve).
    const reset = requeueMember(state, 202, TO_FULL, 'x', NOW2, { dispatch_profile: null });
    expect(findEntry(reset.state, 202)?.dispatch_profile).toBeNull();
  });

  it('a parked member keeps its park-time profile on requeue — a deliberate null is not re-derived from the batch', () => {
    // The `dispatch-profile-missing` dissolve parks on the config default; the
    // batch still records the broken profile. `sched requeue` must not revive it.
    let state = withProfile(inWork(seeded(), 201));
    state = parkMember(state, 201, 'evicted', 'dispatch-profile-missing:openai', NOW, {
      dispatch_profile: null,
    }).state;
    expect(findEntry(state, 201)?.dispatch_profile).toBeNull();
    const result = requeueMember(state, 201, TO_FULL, 'operator-requeue', NOW2);
    expect(findEntry(result.state, 201)).toMatchObject({
      status: 'requeued',
      dispatch_profile: null,
    });
  });

  it('validateState refuses a failure_evidence.branch that is not a plain ref', () => {
    let state = inWork(seeded(), 201);
    state = parkMember(state, 201, 'evicted', 'x', NOW, {
      failure_evidence: {
        batch: 'b1',
        reason: 'x',
        failing_tests: [],
        attribution: 'none',
        reverted_commits: [],
        branch: 'batch/b1-m1-201',
        at: NOW.toISOString(),
      },
    }).state;
    expect(() => validateState(JSON.parse(JSON.stringify(state)))).not.toThrow();
    const bad = JSON.parse(JSON.stringify(state));
    bad.entries.find((e: { issue: number }) => e.issue === 201).failure_evidence.branch =
      '--upload-pack=evil';
    expect(() => validateState(bad)).toThrow(/failure_evidence\.branch/);
  });

  it('#822: a 1.26.0 batch with no reprompted_members loads with [] and a malformed record is refused', () => {
    const legacy = JSON.parse(JSON.stringify({ ...seeded(), schema_version: '1.26.0' }));
    delete legacy.batches[0].reprompted_members;
    expect(validateState(legacy).batches[0]?.reprompted_members).toEqual([]);
    const ok = JSON.parse(JSON.stringify(seeded()));
    ok.batches[0].reprompted_members = [{ issue: 7, milestone_at: '2026-09-24T12:00:00Z' }];
    expect(validateState(ok).batches[0]?.reprompted_members).toHaveLength(1);
    for (const bad of [[7], [{ issue: 'x', milestone_at: 'a' }], [{ issue: 7 }], 'nope']) {
      const corrupt = JSON.parse(JSON.stringify(seeded()));
      corrupt.batches[0].reprompted_members = bad;
      expect(() => validateState(corrupt)).toThrow(/reprompted_members/);
    }
  });

  it('#832: a 1.25.0 batch with no agent_exits loads with the respawn counter backfilled null', () => {
    const legacy = JSON.parse(JSON.stringify({ ...seeded(), schema_version: '1.25.0' }));
    delete legacy.batches[0].agent_exits;
    const loaded = validateState(legacy);
    expect(loaded.schema_version).toBe(SCHEMA_VERSION);
    expect(loaded.batches[0]?.agent_exits).toBeNull();
    const counted = JSON.parse(JSON.stringify(seeded()));
    counted.batches[0].agent_exits = { phase: 'tail', count: 2 };
    expect(validateState(counted).batches[0]?.agent_exits).toEqual({ phase: 'tail', count: 2 });
    for (const bad of [
      { phase: 'tail', count: '2' },
      { phase: 'fix', count: 1 },
      { phase: 'tail', count: 0 },
      3,
    ]) {
      const corrupt = JSON.parse(JSON.stringify(seeded()));
      corrupt.batches[0].agent_exits = bad;
      expect(() => validateState(corrupt)).toThrow(/agent_exits/);
    }
  });

  it('a 1.23.0 state loads and migrates to 1.24.0 unchanged (no backfill: kind/branch are optional)', () => {
    const legacy = JSON.parse(JSON.stringify({ ...seeded(), schema_version: '1.23.0' }));
    legacy.batches[0].evictions = [
      {
        issue: 201,
        reason: 'agent-exited-unverified',
        attribution: 'none',
        reverted_commits: [],
        group: [],
        at: NOW.toISOString(),
      },
    ];
    const loaded = validateState(legacy);
    // Migrates to whatever the CURRENT schema is, not a hardcoded literal —
    // #789 bumped past 1.24.0 to 1.25.0, and pinning the exact string here
    // would keep breaking on every future bump for no added test value; the
    // eviction-shape assertion below is what this test actually verifies.
    expect(loaded.schema_version).toBe(SCHEMA_VERSION);
    expect(loaded.batches[0]?.evictions[0]).not.toHaveProperty('kind');
    expect(loaded.entries.map((e) => e.status)).toEqual(seeded().entries.map((e) => e.status));
  });

  it('validateState refuses an unknown eviction kind (it would change what the threshold counts)', () => {
    const state = seeded();
    const bad = {
      ...state,
      batches: state.batches.map((b) => ({
        ...b,
        evictions: [
          {
            issue: 201,
            reason: 'x',
            attribution: 'none',
            reverted_commits: [],
            group: [],
            kind: 'retired',
            at: NOW.toISOString(),
          },
        ],
      })),
    };
    expect(() => validateState(JSON.parse(JSON.stringify(bad)))).toThrow(/evictions\[\]\.kind/);
  });
});

describe('appendEvictions (#595)', () => {
  const record = (issue: number, reason = 'suite-red') => ({
    issue,
    reason,
    attribution: 'overlap' as const,
    reverted_commits: [],
    group: [],
    at: NOW.toISOString(),
  });

  it('appends a fresh record for a member with no prior eviction', () => {
    const batch = createBatch('b1', [201, 202], NOW);
    const { evictions, appended, duplicate } = appendEvictions(batch, [record(201)]);
    expect(evictions).toHaveLength(1);
    expect(appended).toEqual([record(201)]);
    expect(duplicate).toEqual([]);
  });

  it('is a no-op for a member already recorded as evicted — never a second record', () => {
    const batch = { ...createBatch('b1', [201, 202], NOW), evictions: [record(201)] };
    const second = record(201, 'incremental-gate-failed:test.focused');

    const { evictions, appended, duplicate } = appendEvictions(batch, [second]);

    expect(evictions).toHaveLength(1);
    expect(evictions[0]).toEqual(record(201));
    expect(appended).toEqual([]);
    expect(duplicate).toEqual([second]);
  });

  it('handles a mixed batch: one fresh member appends, one already-evicted member does not', () => {
    const batch = { ...createBatch('b1', [201, 202, 203], NOW), evictions: [record(201)] };

    const { evictions, appended, duplicate } = appendEvictions(batch, [record(201), record(202)]);

    expect(evictions.map((e) => e.issue).sort()).toEqual([201, 202]);
    expect(appended).toEqual([record(202)]);
    expect(duplicate).toEqual([record(201)]);
  });
});

describe('batch state machine (RFC-0001 §D.2)', () => {
  it('walks the full happy path including merge and report', () => {
    let state = seeded();
    const path = [
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
    state = transitionBatch(state, 'b1', 'executing', { executing_member: 1 }, NOW2);
    state = transitionBatch(state, 'b1', 'executing', { executing_member: 2 }, NOW2);
    expect(findBatch(state, 'b1')?.executing_member).toBe(2);
  });

  it('walks the attribute → fix → validate rail', () => {
    let state = seeded();
    state = transitionBatch(state, 'b1', 'executing', {}, NOW);
    state = transitionBatch(state, 'b1', 'validating', {}, NOW);
    state = transitionBatch(state, 'b1', 'attributing', {}, NOW);
    state = transitionBatch(state, 'b1', 'fixing', {}, NOW);
    state = transitionBatch(state, 'b1', 'validating', {}, NOW);
    expect(findBatch(state, 'b1')?.status).toBe('validating');
  });

  it('returns validating → executing when a late member is admitted before final review (#714)', () => {
    let state = seeded();
    state = transitionBatch(state, 'b1', 'executing', { executing_member: 1 }, NOW);
    state = transitionBatch(state, 'b1', 'validating', {}, NOW);
    state = transitionBatch(state, 'b1', 'executing', { executing_member: 2 }, NOW2);
    expect(findBatch(state, 'b1')).toMatchObject({ status: 'executing', executing_member: 2 });
  });

  it('walks the eviction and dissolution rails', () => {
    let state = seeded();
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

  it('walks the unreadable-suite rail (#562): validating → blocked → validating resumes, or → dissolving abandons', () => {
    let state = seeded();
    state = transitionBatch(state, 'b1', 'executing', {}, NOW);
    state = transitionBatch(state, 'b1', 'validating', {}, NOW);
    state = transitionBatch(state, 'b1', 'blocked', {}, NOW);
    const resumed = transitionBatch(state, 'b1', 'validating', {}, NOW);
    expect(findBatch(resumed, 'b1')?.status).toBe('validating');
    const abandoned = transitionBatch(state, 'b1', 'dissolving', {}, NOW);
    expect(findBatch(abandoned, 'b1')?.status).toBe('dissolving');
  });

  it('walks the conflict rail (awaiting-merge → rebasing → re-validating → shipping)', () => {
    let state = seeded();
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
    expect(() => transitionBatch(state, 'b1', 'merged')).toThrow('ready → merged');
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
  it('#776: backfills paused_at and stale_closed_at on pre-#776 states, and rejects a malformed paused_at', () => {
    const state = seeded();
    const legacy = JSON.parse(JSON.stringify(state));
    delete legacy.paused_at;
    for (const entry of legacy.entries) delete entry.stale_closed_at;
    const loaded = validateState(legacy);
    expect(loaded.paused_at).toBeNull();
    expect(loaded.entries.every((e) => e.stale_closed_at === null)).toBe(true);
    expect(() => validateState({ ...state, paused_at: 'yesterday' })).toThrow(/paused_at/);
  });

  it('#768: loads a 1.21.0 state, backfills the anchor-close fields, and rejects a malformed anchor_closed_at', () => {
    const state = seeded();
    expect(state.batches.length).toBeGreaterThan(0);
    const legacy = JSON.parse(JSON.stringify(state));
    legacy.schema_version = '1.21.0';
    for (const batch of legacy.batches) {
      delete batch.anchor_closed_at;
      delete batch.anchor_close_failed_reason;
      delete batch.anchor_close_failed_since;
      delete batch.anchor_close_failed_ticks;
    }
    const loaded = validateState(legacy);
    for (const batch of loaded.batches) {
      expect(batch.anchor_closed_at).toBeNull();
      expect(batch.anchor_close_failed_reason).toBeNull();
      expect(batch.anchor_close_failed_since).toBeNull();
      expect(batch.anchor_close_failed_ticks).toBe(0);
    }
    // A non-date would read as "already closed" and silently exempt the batch.
    for (const bad of [true, '', 'yesterday']) {
      expect(() =>
        validateState({
          ...state,
          batches: [{ ...state.batches[0], anchor_closed_at: bad }],
        })
      ).toThrow(/anchor_closed_at/);
    }
  });

  it('#809: loads a 1.22.0 state, backfills member_dispatch/member_runs, and rejects malformed ones', () => {
    const state = seeded();
    expect(state.batches.length).toBeGreaterThan(0);
    const legacy = JSON.parse(JSON.stringify(state));
    legacy.schema_version = '1.22.0';
    for (const batch of legacy.batches) {
      delete batch.member_dispatch;
      delete batch.member_runs;
    }
    const loaded = validateState(legacy);
    for (const batch of loaded.batches) {
      // null, not 'serial': an unclaimed batch still chooses at its claim, and
      // a null mode past `ready` already reads as serial.
      expect(batch.member_dispatch).toBeNull();
      expect(batch.member_runs).toEqual([]);
    }
    expect(() =>
      validateState({ ...state, batches: [{ ...state.batches[0], member_dispatch: 'fast' }] })
    ).toThrow(/member_dispatch/);
    expect(() =>
      validateState({
        ...state,
        batches: [{ ...state.batches[0], member_runs: [{ issue: 1, status: 'flying' }] }],
      })
    ).toThrow(/member_runs/);
  });

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

  it('loads a pre-#544 1.8.0 state and backfills last_label_poll_at as null', () => {
    // Null is exact, not a guess: no label re-check has ever run under a
    // pre-#544 engine, so the first tick after the upgrade should poll
    // immediately rather than wait out a throttle window it has no evidence
    // for.
    const legacy = { ...seeded(), schema_version: '1.8.0' } as Record<string, unknown>;
    delete legacy.last_label_poll_at;

    const migrated = validateState(legacy);

    expect(migrated.schema_version).toBe(SCHEMA_VERSION);
    expect(migrated.last_label_poll_at).toBeNull();
    // everything the 1.8.0 engine persisted is preserved
    expect(migrated.last_pr_poll_at).toBe(seeded().last_pr_poll_at);
    expect(migrated.entries).toHaveLength(seeded().entries.length);
  });

  it('loads a pre-#682 1.15.0 state and backfills the progress dedup marker', () => {
    // Exactly what the 1.15.0 engine persisted: slots with no
    // progress_milestone_* fields at all. Null/null/0 is exact, not a guess:
    // no milestone-progress streak was ever recorded under the old
    // journal-every-transition behavior, so the first tick after the upgrade
    // starts each streak fresh.
    const legacy = { ...seeded(), schema_version: '1.15.0' } as Record<string, unknown>;
    for (const slot of legacy.slots as Record<string, unknown>[]) {
      delete slot.progress_milestone_for;
      delete slot.progress_milestone_since;
      delete slot.progress_milestone_ticks;
    }

    const migrated = validateState(legacy);

    expect(migrated.schema_version).toBe(SCHEMA_VERSION);
    for (const slot of migrated.slots) {
      expect(slot.progress_milestone_for).toBeNull();
      expect(slot.progress_milestone_since).toBeNull();
      expect(slot.progress_milestone_ticks).toBe(0);
    }
    // everything the 1.15.0 engine persisted is preserved
    expect(migrated.entries).toHaveLength(seeded().entries.length);
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

  it('#629: loads a pre-#629 1.12.0 state and backfills the confirmed-dispatch-failure fields', () => {
    // Exactly what a 1.12.0 sched persisted: no consecutive_dispatch_api_errors
    // or dispatch_pause_reset_at — no confirmed dispatch failures were ever
    // tracked, so 0/null is the exact answer, not a guess.
    const legacy = {
      schema_version: '1.12.0',
      paused: false,
      entries: [],
      batches: [],
      slots: [],
      next_slot_id: 1,
      last_pr_poll_at: null,
    };
    const migrated = validateState(legacy);
    expect(migrated.schema_version).toBe(SCHEMA_VERSION);
    expect(migrated.consecutive_dispatch_api_errors).toBe(0);
    expect(migrated.dispatch_pause_reset_at).toBeNull();
  });

  it('#629: rejects a negative consecutive_dispatch_api_errors rather than coercing it', () => {
    const state = seeded();
    expect(() => validateState({ ...state, consecutive_dispatch_api_errors: -1 })).toThrow(
      /consecutive_dispatch_api_errors/
    );
  });

  it('#629: rejects a dispatch_pause_reset_at with a zero count', () => {
    const state = seeded();
    expect(() =>
      validateState({
        ...state,
        consecutive_dispatch_api_errors: 0,
        dispatch_pause_reset_at: '2026-09-06T20:40:00Z',
      })
    ).toThrow(/dispatch_pause_reset_at/);
  });

  it('#629: accepts a nonzero consecutive_dispatch_api_errors with a null reset time — the pair is deliberately NOT a single fact', () => {
    const state = seeded();
    expect(() =>
      validateState({
        ...state,
        consecutive_dispatch_api_errors: 2,
        dispatch_pause_reset_at: null,
      })
    ).not.toThrow();
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

  it('rejects a malformed last_label_poll_at (#544)', () => {
    const state = seeded();
    const bad = { ...state, last_label_poll_at: 'ten minutes ago' };
    expect(() => validateState(bad)).toThrow(/last_label_poll_at/);
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
        schema_version: 'not-a-version',
        paused: false,
        entries: [],
        batches: [],
        slots: [],
        next_slot_id: 1,
      })
    ).toThrow(/Unsupported schema version/);
  });

  it('#537: a numerically newer schema version is rejected with the specific EngineTooOldError, not the generic message', () => {
    expect(() =>
      validateState({
        schema_version: '2.0.0',
        paused: false,
        entries: [],
        batches: [],
        slots: [],
        next_slot_id: 1,
      })
    ).toThrow(/State file was written by a newer schema/);
  });
});

describe('#707 state migration: dispatch_profile', () => {
  it('loads a pre-#707 1.18.0 state and backfills batch dispatch_profile as null', () => {
    // Null is exact, not a guess: no batch before profiles existed ever
    // dispatched anything but the config's default profile.
    const legacy = { ...seeded(), schema_version: '1.18.0' } as Record<string, unknown>;
    for (const batch of legacy.batches as Record<string, unknown>[]) {
      delete batch.dispatch_profile;
    }

    const migrated = validateState(legacy);

    expect(migrated.schema_version).toBe(SCHEMA_VERSION);
    for (const batch of migrated.batches) {
      expect(batch.dispatch_profile).toBeNull();
    }
  });

  it('#713: loads a pre-entry-profile state with the default profile', () => {
    const legacy = { ...seeded(), schema_version: '1.19.0' } as Record<string, unknown>;
    for (const entry of legacy.entries as Record<string, unknown>[]) {
      delete entry.dispatch_profile;
    }

    const migrated = validateState(legacy);

    expect(migrated.schema_version).toBe(SCHEMA_VERSION);
    expect(migrated.entries.every((entry) => entry.dispatch_profile === null)).toBe(true);
  });

  it('rejects a batch whose dispatch_profile violates the name grammar', () => {
    const bad = seeded();
    const batches = bad.batches.map((b) => ({ ...b, dispatch_profile: '../escape' }));
    expect(() => validateState({ ...bad, batches })).toThrow(/dispatch_profile must match/);
  });
});

describe('#635 state migration: last_tick_failure', () => {
  it('backfills no failure for a pre-#635 state', () => {
    const legacy = { ...seeded(), schema_version: '1.20.0' } as Record<string, unknown>;
    delete legacy.last_tick_failure;

    expect(validateState(legacy).last_tick_failure).toBeNull();
  });
});
