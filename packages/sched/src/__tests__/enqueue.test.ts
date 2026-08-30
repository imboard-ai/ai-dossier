import { describe, expect, it } from 'vitest';
import {
  assertNoDependencyCycle,
  createEmptyState,
  EnqueueError,
  enqueueEntries,
  findBatch,
  parseManifest,
  validateState,
} from '../index';

const NOW = new Date('2026-08-29T12:00:00Z');

describe('enqueueEntries', () => {
  it('records issue, mode, batch, deps, and tier on each entry (AC1)', () => {
    const state = enqueueEntries(
      createEmptyState(),
      [
        { issue: 101, mode: 'full', deps: [100], tier: 'strong' },
        { issue: 201, mode: 'slot', batch: 'b1', tier: 'mechanical' },
        { issue: 202, mode: 'slot', batch: 'b1', deps: [201] },
      ],
      NOW
    );
    const e101 = state.entries.find((e) => e.issue === 101);
    expect(e101).toMatchObject({
      issue: 101,
      mode: 'full',
      batch: null,
      deps: [100],
      tier: 'strong',
      status: 'queued',
    });
    const e201 = state.entries.find((e) => e.issue === 201);
    expect(e201).toMatchObject({ mode: 'slot', batch: 'b1', tier: 'mechanical' });
    const e202 = state.entries.find((e) => e.issue === 202);
    expect(e202?.deps).toEqual([201]);
    // one batch formed with both members
    expect(findBatch(state, 'b1')?.members).toEqual([201, 202]);
  });

  it('applies documented defaults (mode full, tier mid, no deps)', () => {
    const state = enqueueEntries(createEmptyState(), [{ issue: 7 }], NOW);
    expect(state.entries[0]).toMatchObject({ mode: 'full', tier: 'mid', deps: [] });
  });

  it('rejects slot mode without a batch and full mode with one', () => {
    expect(() => enqueueEntries(createEmptyState(), [{ issue: 1, mode: 'slot' }], NOW)).toThrow(
      EnqueueError
    );
    expect(() =>
      enqueueEntries(createEmptyState(), [{ issue: 1, mode: 'full', batch: 'b1' }], NOW)
    ).toThrow(EnqueueError);
  });

  it('rejects self-dependencies and duplicate issues', () => {
    expect(() => enqueueEntries(createEmptyState(), [{ issue: 1, deps: [1] }], NOW)).toThrow(
      /depend on itself/
    );
    expect(() => enqueueEntries(createEmptyState(), [{ issue: 1 }, { issue: 1 }], NOW)).toThrow(
      /Duplicate/
    );
    expect(() => enqueueEntries(createEmptyState(), [{ issue: 0 }], NOW)).toThrow(
      /positive integer/
    );
  });

  it('rejects re-enqueueing an active issue but allows re-enqueueing a terminal one', () => {
    let state = createEmptyState();
    state = enqueueEntries(state, [{ issue: 1 }], NOW);
    expect(() => enqueueEntries(state, [{ issue: 1 }], NOW)).toThrow(/already in the queue/);
    state = {
      ...state,
      entries: state.entries.map((e) => (e.issue === 1 ? { ...e, status: 'failed' as const } : e)),
    };
    expect(() => enqueueEntries(state, [{ issue: 1 }], NOW)).not.toThrow();
  });

  it('rejects dependency cycles across new and existing entries', () => {
    let state = createEmptyState();
    state = enqueueEntries(state, [{ issue: 1, deps: [2] }], NOW);
    expect(() => enqueueEntries(state, [{ issue: 2, deps: [1] }], NOW)).toThrow(/cycle/i);

    const fresh = createEmptyState();
    expect(() =>
      enqueueEntries(
        fresh,
        [
          { issue: 1, deps: [2] },
          { issue: 2, deps: [3] },
          { issue: 3, deps: [1] },
        ],
        NOW
      )
    ).toThrow(/cycle/i);
  });

  it('rejects joining a batch that has sealed (left forming)', () => {
    let state = enqueueEntries(
      createEmptyState(),
      [
        { issue: 1, mode: 'slot', batch: 'b1' },
        { issue: 2, mode: 'slot', batch: 'b1' },
      ],
      NOW
    );
    state = {
      ...state,
      batches: state.batches.map((b) => (b.id === 'b1' ? { ...b, status: 'ready' as const } : b)),
    };
    expect(() => enqueueEntries(state, [{ issue: 3, mode: 'slot', batch: 'b1' }], NOW)).toThrow(
      /only join while forming/
    );
  });

  it('allows deps pointing outside the queue (they surface as blocked, not cycles)', () => {
    const state = enqueueEntries(createEmptyState(), [{ issue: 1, deps: [999] }], NOW);
    expect(state.entries[0].deps).toEqual([999]);
  });

  it('rejects boundary-invalid inputs that would persist an unloadable state', () => {
    expect(() =>
      enqueueEntries(createEmptyState(), [{ issue: 1, mode: 'slot', batch: '' }], NOW)
    ).toThrow(/batch must be a non-empty string/);
    expect(() =>
      enqueueEntries(createEmptyState(), [{ issue: 1, mode: 'side' as never }], NOW)
    ).toThrow(/mode must be 'full' or 'slot'/);
    expect(() =>
      enqueueEntries(createEmptyState(), [{ issue: 1, tier: 'ultra' as never }], NOW)
    ).toThrow(/tier must be mechanical \| mid \| strong/);
  });

  it('only produces state that validateState accepts (round-trip invariant)', () => {
    const state = enqueueEntries(
      createEmptyState(),
      [
        { issue: 1, mode: 'full' },
        { issue: 2, mode: 'slot', batch: 'b1', deps: [1] },
      ],
      NOW
    );
    expect(() => validateState(JSON.parse(JSON.stringify(state)))).not.toThrow();
  });

  it('does not churn updated_at on untouched batches', () => {
    let state = enqueueEntries(
      createEmptyState(),
      [{ issue: 1, mode: 'slot', batch: 'b1' }],
      new Date('2026-08-29T10:00:00Z')
    );
    const before = state.batches[0].updated_at;
    state = enqueueEntries(state, [{ issue: 99 }], new Date('2026-08-29T11:00:00Z'));
    expect(state.batches[0].updated_at).toBe(before);
  });

  it('rejects a base_branch conflict when joining an existing forming batch', () => {
    const state = enqueueEntries(
      createEmptyState(),
      [{ issue: 1, mode: 'slot', batch: 'b1', base_branch: 'develop' }],
      NOW
    );
    expect(() =>
      enqueueEntries(state, [{ issue: 2, mode: 'slot', batch: 'b1', base_branch: 'main' }], NOW)
    ).toThrow(/refusing to silently rebase/);
    expect(() =>
      enqueueEntries(state, [{ issue: 2, mode: 'slot', batch: 'b1', base_branch: 'develop' }], NOW)
    ).not.toThrow();
  });

  it('records anchor, run_id, and eviction_groups when creating a batch (#472)', () => {
    const state = enqueueEntries(
      createEmptyState(),
      [
        {
          issue: 201,
          mode: 'slot',
          batch: 'b1',
          anchor: 301,
          run_id: 'r-301-ab12',
          eviction_groups: [[201, 202]],
        },
        { issue: 202, mode: 'slot', batch: 'b1' },
      ],
      NOW
    );
    const batch = findBatch(state, 'b1');
    expect(batch?.anchor).toBe(301);
    expect(batch?.run_id).toBe('r-301-ab12');
    expect(batch?.eviction_groups).toEqual([[201, 202]]);
    expect(batch?.branch).toBeNull();
    expect(batch?.evictions).toEqual([]);
    expect(batch?.fix_attempts).toEqual([]);
    expect(batch?.rebase_attempts).toBe(0);
    expect(() => validateState(JSON.parse(JSON.stringify(state)))).not.toThrow();
  });

  it('rejects an anchor conflict when joining an existing forming batch (#472)', () => {
    const state = enqueueEntries(
      createEmptyState(),
      [{ issue: 1, mode: 'slot', batch: 'b1', anchor: 301 }],
      NOW
    );
    expect(() =>
      enqueueEntries(state, [{ issue: 2, mode: 'slot', batch: 'b1', anchor: 302 }], NOW)
    ).toThrow(/refusing to change it to #302/);
    expect(() =>
      enqueueEntries(state, [{ issue: 2, mode: 'slot', batch: 'b1', anchor: 301 }], NOW)
    ).not.toThrow();
  });

  it('rejects conflicting eviction_groups when joining an existing forming batch (#472)', () => {
    const state = enqueueEntries(
      createEmptyState(),
      [
        { issue: 1, mode: 'slot', batch: 'b1', eviction_groups: [[1, 2]] },
        { issue: 2, mode: 'slot', batch: 'b1' },
      ],
      NOW
    );
    expect(() =>
      enqueueEntries(state, [{ issue: 3, mode: 'slot', batch: 'b1', eviction_groups: [[3]] }], NOW)
    ).toThrow(/different eviction_groups/);
  });

  it('rejects a group naming a member that never joins the batch (#472)', () => {
    expect(() =>
      enqueueEntries(
        createEmptyState(),
        [{ issue: 1, mode: 'slot', batch: 'b1', eviction_groups: [[1, 9]] }],
        NOW
      )
    ).toThrow(/eviction group member 9 is not a batch member/);
  });

  it('rejects malformed recovery metadata at the boundary (#472)', () => {
    expect(() =>
      enqueueEntries(createEmptyState(), [{ issue: 1, mode: 'slot', batch: 'b1', anchor: 0 }], NOW)
    ).toThrow(/anchor must be a positive integer/);
    expect(() =>
      enqueueEntries(createEmptyState(), [{ issue: 1, mode: 'slot', batch: 'b1', run_id: '' }], NOW)
    ).toThrow(/run_id must be a non-empty string/);
    expect(() =>
      enqueueEntries(
        createEmptyState(),
        [{ issue: 1, mode: 'slot', batch: 'b1', eviction_groups: [[]] }],
        NOW
      )
    ).toThrow(/eviction_groups/);
    expect(() => parseManifest([{ issue: 5, anchor: 'x' }])).toThrow(/anchor/);
    expect(() => parseManifest([{ issue: 5, eviction_groups: [[0]] }])).toThrow(/eviction_groups/);
  });
});

describe('assertNoDependencyCycle', () => {
  it('passes for a DAG and fails for a cycle, including self-loops via existing state', () => {
    const state = enqueueEntries(
      createEmptyState(),
      [{ issue: 1 }, { issue: 2, deps: [1] }, { issue: 3, deps: [1, 2] }],
      NOW
    );
    expect(() => assertNoDependencyCycle(state, [{ issue: 4, deps: [3] }])).not.toThrow();
    expect(() => assertNoDependencyCycle(state, [{ issue: 1, deps: [3] }])).toThrow(/cycle/i);
  });
});

describe('parseManifest', () => {
  it('accepts a bare array and the { entries: [...] } shape, ignoring project', () => {
    const bare = parseManifest([{ issue: 1, mode: 'full' }]);
    expect(bare).toEqual([{ issue: 1, mode: 'full' }]);
    const wrapped = parseManifest({
      project: 'imboard-ai-ai-dossier',
      entries: [{ issue: 2, mode: 'slot', batch: 'b1', deps: [1], tier: 'strong' }],
    });
    expect(wrapped).toEqual([{ issue: 2, mode: 'slot', batch: 'b1', deps: [1], tier: 'strong' }]);
  });

  it('flags malformed manifests with the entry index', () => {
    expect(() => parseManifest({ nope: true })).toThrow(/Manifest must be/);
    expect(() => parseManifest([{ issue: 'x' }])).toThrow(/\[0\]/);
    expect(() => parseManifest([{ issue: 5, mode: 'wat' }])).toThrow(/mode/);
    expect(() => parseManifest([{ issue: 5, deps: [0] }])).toThrow(/deps/);
    expect(() => parseManifest([{ issue: 5, tier: 'ultra' }])).toThrow(/tier/);
    expect(() => parseManifest('nope')).toThrow(/Manifest must be/);
  });

  it('manifest and flags inputs enqueue to identical entries (AC1 parity)', () => {
    const viaManifest = enqueueEntries(
      createEmptyState(),
      parseManifest({ entries: [{ issue: 1, mode: 'full', deps: [], tier: 'mid' }] }),
      NOW
    );
    const viaFlags = enqueueEntries(createEmptyState(), [{ issue: 1 }], NOW);
    expect(viaManifest.entries).toEqual(viaFlags.entries);
  });
});
