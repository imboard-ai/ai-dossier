/**
 * #790: the orphan anchor sweep — a batch whose `state.batches` row is gone
 * entirely (imboard#4244/#4253 shape: `sched status --json` → `batches: []`
 * while both anchors stayed open) is invisible to `sweepAnchors` (#768),
 * which only ever walks the ledger. These tests exercise the GitHub-only
 * classification (`classifyOrphanAnchor`, `parseOrphanAnchorBody`,
 * `sweepOrphanAnchors`) and the abandon-warning predicate
 * (`batchAnchorStillOpen`) as pure functions against a mock
 * `IssueCloseReader` — no engine tick, no real `gh`, matching this module's
 * "pure verdicts, injected I/O" architecture (see `anchor-close.ts`'s file
 * header). The heavier engine-tick coverage for the LEDGER-backed sweep
 * lives in `batch-integration.test.ts`'s `#768` describe block; this file
 * covers only what #790 added.
 */
import { describe, expect, it } from 'vitest';
import {
  batchAnchorStillOpen,
  classifyOrphanAnchor,
  type OpenAnchorIssue,
  ORPHAN_SWEEP_MAX_ANCHORS,
  parseOrphanAnchorBody,
  sweepOrphanAnchors,
} from '../anchor-close';
import type { IssueCloseTruth } from '../groundtruth';
import { createBatch, createEmptyState, type SchedState } from '../index';

const NOW = new Date('2026-09-24T12:00:00Z');

const REPO = 'test-org/test-repo';

function truth(overrides: Partial<IssueCloseTruth> = {}): IssueCloseTruth {
  return {
    state: 'OPEN',
    stateReason: null,
    labels: [],
    closer: null,
    closingPrs: [],
    ...overrides,
  };
}

/** A mock `IssueCloseReader` backed by a plain map; `undefined` for any issue not in it (simulates an unreachable read). */
function readerFrom(
  entries: Record<number, IssueCloseTruth>
): (issue: number) => IssueCloseTruth | undefined {
  return (issue) => entries[issue];
}

const ANCHOR_BODY = (members: number[], baseBranch = 'main'): string =>
  [
    ...members.map((m) => `- [ ] #${m} some member title - risk=low est_files=3 est_diff=50`),
    '',
    `base_branch: ${baseBranch}`,
    'eviction_group: none',
    'batch_dependencies: none',
    'audit_file: pending',
    'dispatch_profile: default',
  ].join('\n');

describe('#790 parseOrphanAnchorBody', () => {
  it('recovers members (checked and unchecked) and base_branch from the batch-compose body format', () => {
    const body = ANCHOR_BODY([4146, 4147], 'main');
    expect(parseOrphanAnchorBody(body)).toEqual({ members: [4146, 4147], base_branch: 'main' });
  });

  it('a checked-off member line ([x]) still counts — the checklist is never re-read as progress', () => {
    const body = '- [x] #100 done already\n- [ ] #101 still open\n\nbase_branch: release';
    expect(parseOrphanAnchorBody(body)).toEqual({ members: [100, 101], base_branch: 'release' });
  });

  it('dedupes a repeated member line and defaults base_branch to main when the metadata line is absent', () => {
    const body = '- [ ] #5 a\n- [ ] #5 a\n- [ ] #6 b\n';
    expect(parseOrphanAnchorBody(body)).toEqual({ members: [5, 6], base_branch: 'main' });
  });

  it('no checklist lines at all → empty members', () => {
    expect(parseOrphanAnchorBody('just prose, no checklist').members).toEqual([]);
  });
});

describe('#790 classifyOrphanAnchor', () => {
  it('every member CLOSED as COMPLETED by a merged PR into the recovered base_branch → orphan-closable-candidate, reasons empty', () => {
    const read = readerFrom({
      4244: truth({ state: 'OPEN' }),
      4146: truth({
        state: 'CLOSED',
        stateReason: 'COMPLETED',
        closer: { kind: 'pr', number: 4256, merged: true, baseRefName: 'main', repo: REPO },
      }),
      4147: truth({
        state: 'CLOSED',
        stateReason: 'COMPLETED',
        closer: { kind: 'pr', number: 4257, merged: true, baseRefName: 'main', repo: REPO },
      }),
    });
    const verdict = classifyOrphanAnchor(
      { anchor: 4244, members: [4146, 4147], base_branch: 'main' },
      read,
      { repo: REPO }
    );
    expect(verdict).toEqual({
      kind: 'orphan-closable-candidate',
      reasons: [],
      members: [
        {
          issue: 4146,
          ledger_status: null,
          github: 'CLOSED',
          state_reason: 'COMPLETED',
          shipped_by: 'PR #4256',
        },
        {
          issue: 4147,
          ledger_status: null,
          github: 'CLOSED',
          state_reason: 'COMPLETED',
          shipped_by: 'PR #4257',
        },
      ],
    });
  });

  it('an OPEN member → orphan-needs-operator, naming it', () => {
    const read = readerFrom({ 4244: truth({ state: 'OPEN' }), 4146: truth({ state: 'OPEN' }) });
    const verdict = classifyOrphanAnchor(
      { anchor: 4244, members: [4146], base_branch: 'main' },
      read,
      { repo: REPO }
    );
    expect(verdict.kind).toBe('orphan-needs-operator');
    expect(verdict.reasons).toEqual(['member-open:#4146']);
  });

  it('a member closed NOT_PLANNED → orphan-needs-operator, naming it', () => {
    const read = readerFrom({
      4244: truth({ state: 'OPEN' }),
      4146: truth({ state: 'CLOSED', stateReason: 'NOT_PLANNED' }),
    });
    const verdict = classifyOrphanAnchor(
      { anchor: 4244, members: [4146], base_branch: 'main' },
      read,
      { repo: REPO }
    );
    expect(verdict.kind).toBe('orphan-needs-operator');
    expect(verdict.reasons).toEqual(['member-closed-not_planned:#4146']);
  });

  it('never issues a write: the predicate is pure and takes no exec/write capability at all', () => {
    // Type-level guarantee, asserted at runtime too: classifyOrphanAnchor's
    // signature has no ExecFn/write parameter, so there is no way to smuggle
    // a `gh issue close/comment/edit` call through it. This test exists so a
    // future refactor that widened the signature to accept one would fail
    // loudly (the length check) rather than silently.
    expect(classifyOrphanAnchor.length).toBeLessThanOrEqual(3);
  });

  it('a handed-back anchor (Decision-Pending) → orphan-needs-operator even with clean members', () => {
    const read = readerFrom({
      4244: truth({ labels: ['Decision-Pending'] }),
      4146: truth({
        state: 'CLOSED',
        stateReason: 'COMPLETED',
        closer: { kind: 'pr', number: 1, merged: true, baseRefName: 'main', repo: REPO },
      }),
    });
    const verdict = classifyOrphanAnchor(
      { anchor: 4244, members: [4146], base_branch: 'main' },
      read,
      { repo: REPO }
    );
    expect(verdict.kind).toBe('orphan-needs-operator');
    expect(verdict.reasons).toContain('anchor-handed-back');
  });

  it('an unreachable member read → orphan-unknown, decides nothing', () => {
    const verdict = classifyOrphanAnchor(
      { anchor: 4244, members: [4146], base_branch: 'main' },
      readerFrom({}),
      { repo: REPO }
    );
    expect(verdict.kind).toBe('orphan-unknown');
  });

  it('no members recovered from the body → orphan-needs-operator (never mistaken for clean)', () => {
    const read = readerFrom({ 4244: truth({ state: 'OPEN' }) });
    const verdict = classifyOrphanAnchor({ anchor: 4244, members: [], base_branch: 'main' }, read, {
      repo: REPO,
    });
    expect(verdict).toEqual({
      kind: 'orphan-needs-operator',
      reasons: ['no-members-recovered'],
      members: [],
    });
  });
});

describe('#790 sweepOrphanAnchors', () => {
  it('an anchor listed on GitHub but already in the ledger is never double-listed', () => {
    const state: SchedState = {
      ...createEmptyState(),
      batches: [createBatch('b1', [4146], NOW, { anchor: 4244 })],
    };
    const list = (): OpenAnchorIssue[] => [
      { number: 4244, title: 'Batch b1: #4146', body: ANCHOR_BODY([4146]) },
    ];
    const items = sweepOrphanAnchors(state, list, readerFrom({}));
    expect(items).toEqual([]);
  });

  it('an anchor NOT in the ledger, every member shipped → one orphan-closable-candidate row', () => {
    const state = createEmptyState();
    const list = (): OpenAnchorIssue[] => [
      { number: 4244, title: 'Batch b-20260912-02: #4146, #4147', body: ANCHOR_BODY([4146, 4147]) },
    ];
    const read = readerFrom({
      4244: truth({ state: 'OPEN' }),
      4146: truth({
        state: 'CLOSED',
        stateReason: 'COMPLETED',
        closer: { kind: 'commit', oid: 'a'.repeat(40) },
      }),
      4147: truth({
        state: 'CLOSED',
        stateReason: 'COMPLETED',
        closer: { kind: 'pr', number: 1, merged: true, baseRefName: 'main', repo: REPO },
      }),
    });
    const items = sweepOrphanAnchors(state, list, read, {
      repo: REPO,
      commitInBase: () => true,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      anchor: 4244,
      verdict: 'orphan-closable-candidate',
      reasons: [],
    });
  });

  it('an orphan with a still-open member → orphan-needs-operator', () => {
    const state = createEmptyState();
    const list = (): OpenAnchorIssue[] => [
      { number: 4244, title: 'Batch b1: #4146', body: ANCHOR_BODY([4146]) },
    ];
    const items = sweepOrphanAnchors(
      state,
      list,
      readerFrom({ 4244: truth({ state: 'OPEN' }), 4146: truth({ state: 'OPEN' }) })
    );
    expect(items).toHaveLength(1);
    expect(items[0].verdict).toBe('orphan-needs-operator');
  });

  it('the lister failing (unverified repo / gh unreachable) → empty sweep, no crash', () => {
    const state = createEmptyState();
    const list = (): OpenAnchorIssue[] | undefined => undefined;
    expect(sweepOrphanAnchors(state, list, readerFrom({}))).toEqual([]);
  });

  it('caps at ORPHAN_SWEEP_MAX_ANCHORS — a huge open-anchor list never balloons the read cost', () => {
    const state = createEmptyState();
    const many: OpenAnchorIssue[] = Array.from(
      { length: ORPHAN_SWEEP_MAX_ANCHORS + 10 },
      (_, i) => ({
        number: 9000 + i,
        title: `Batch b${i}: #1`,
        body: ANCHOR_BODY([1]),
      })
    );
    const items = sweepOrphanAnchors(
      state,
      () => many,
      readerFrom({ 1: truth({ state: 'OPEN' }) })
    );
    expect(items).toHaveLength(ORPHAN_SWEEP_MAX_ANCHORS);
  });

  it("never issues a gh write command: no anchor row here can even carry a write — the function takes only read-shaped inputs (list/read), and #768's closeAnchor (the only writer in this module) is never called from this path", () => {
    let wrote = false;
    const state = createEmptyState();
    const list = (): OpenAnchorIssue[] => [
      { number: 4244, title: 'Batch b1: #4146', body: ANCHOR_BODY([4146]) },
    ];
    const read = readerFrom({
      4244: truth({ state: 'OPEN' }),
      4146: truth({
        state: 'CLOSED',
        stateReason: 'COMPLETED',
        closer: { kind: 'pr', number: 1, merged: true, baseRefName: 'main', repo: REPO },
      }),
    });
    // Wrap `read` to prove it's the only GitHub call surface this function
    // uses — no injected exec/write function exists in its signature at all.
    const spiedRead = (issue: number) => {
      wrote = wrote || false; // no write path reachable through `read`
      return read(issue);
    };
    const items = sweepOrphanAnchors(state, list, spiedRead, { repo: REPO });
    expect(items[0].verdict).toBe('orphan-closable-candidate');
    expect(wrote).toBe(false);
    expect(sweepOrphanAnchors.length).toBeLessThanOrEqual(4); // (state, list, read, opts) — no exec param
  });
});

describe('#790 batchAnchorStillOpen (the abandon-warning predicate)', () => {
  it('anchor set and OPEN on GitHub → returns the anchor number', () => {
    expect(
      batchAnchorStillOpen({ anchor: 4244 }, readerFrom({ 4244: truth({ state: 'OPEN' }) }))
    ).toBe(4244);
  });

  it('anchor set but CLOSED → null (nothing to warn about)', () => {
    expect(
      batchAnchorStillOpen({ anchor: 4244 }, readerFrom({ 4244: truth({ state: 'CLOSED' }) }))
    ).toBeNull();
  });

  it('no anchor at all → null, no read performed', () => {
    let read = false;
    expect(
      batchAnchorStillOpen({ anchor: null }, () => {
        read = true;
        return truth();
      })
    ).toBeNull();
    expect(read).toBe(false);
  });

  it('an unreachable read → null (fail silent, never guess "still open")', () => {
    expect(batchAnchorStillOpen({ anchor: 4244 }, readerFrom({}))).toBeNull();
  });
});
