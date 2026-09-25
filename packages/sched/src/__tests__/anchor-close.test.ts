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
  ORPHAN_SWEEP_MAX_MEMBERS,
  orphanAnchorListArgs,
  parseOrphanAnchorBody,
  shippingEvidence,
  sweepOrphanAnchors,
} from '../anchor-close';
import type { ClosingPr, IssueCloseTruth } from '../groundtruth';
import {
  createBatch,
  createEmptyState,
  createExecGroundTruth,
  type ExecFn,
  issueCloseReader,
  type OrphanAnchorVerdict,
  type SchedState,
} from '../index';
import { graphqlIssueResponse as graphqlIssue } from './helpers/graphql-fixtures';

/** `classifyOrphanAnchor` returns `null` only for the closed-anchor list-then-read race (tested separately below) — every other test here expects a real verdict. */
function expectVerdict(v: OrphanAnchorVerdict | null): OrphanAnchorVerdict {
  if (v === null) throw new Error('expected a non-null verdict — the anchor was not closed');
  return v;
}

const NOW = new Date('2026-09-24T12:00:00Z');

const REPO = 'test-org/test-repo';

function truth(overrides: Partial<IssueCloseTruth> = {}): IssueCloseTruth {
  return {
    state: 'OPEN',
    stateReason: null,
    labels: [],
    closer: null,
    closingPrs: [],
    lastReopenedAt: null,
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

// `graphqlIssue` (the `data.repository.issue` GraphQL shape
// `createExecGroundTruth`'s `issueCloseTruth` parses — used only by the AC6
// no-write proof below, which drives the REAL gh-argv-building path rather
// than a mock `IssueCloseReader`) now lives in `./helpers/graphql-fixtures`
// as `graphqlIssueResponse`, imported above under this file's original name
// — extracted (#829 DRY review) once `cli/src/__tests__/commands/sched.test.ts`
// needed the identical shape.

/**
 * #790 review (round 3): the AC6 no-write proof's denylist is a module-level
 * function (not inline in the test) so it has its own unit tests, and so
 * "prove it has teeth" (below) exercises exactly this function rather than
 * a copy. Catches: `gh issue close/comment/edit`; `--add-label`/
 * `--remove-label` on any command; `gh api` with `-X`/`--method`
 * POST/PATCH/PUT/DELETE; and `gh api graphql` whose query text contains
 * `mutation` (case-insensitive) — a GraphQL write is a POST at the HTTP
 * layer regardless of the JSON body, so the `-X`/`--method` check alone
 * would miss it.
 */
function isWriteCall(argv: string[]): boolean {
  const [, ...args] = argv;
  if (args[0] === 'issue' && ['close', 'comment', 'edit'].includes(args[1] ?? '')) return true;
  if (args.includes('--add-label') || args.includes('--remove-label')) return true;
  if (args[0] === 'api') {
    const methodIdx = args.findIndex((a) => a === '-X' || a === '--method');
    if (
      methodIdx !== -1 &&
      ['POST', 'PATCH', 'PUT', 'DELETE'].includes((args[methodIdx + 1] ?? '').toUpperCase())
    ) {
      return true;
    }
    if (args[1] === 'graphql' && args.some((a) => /mutation/i.test(a))) return true;
  }
  return false;
}

describe('#790 isWriteCall (the AC6 denylist itself)', () => {
  it('flags gh issue close/comment/edit', () => {
    expect(isWriteCall(['gh', 'issue', 'close', '4244'])).toBe(true);
    expect(isWriteCall(['gh', 'issue', 'comment', '4244', '--body', 'x'])).toBe(true);
    expect(isWriteCall(['gh', 'issue', 'edit', '4244', '--add-label', 'x'])).toBe(true);
  });

  it('flags --add-label/--remove-label anywhere in the argv', () => {
    expect(
      isWriteCall(['gh', 'api', '-X', 'POST', 'repos/o/r/issues/1/labels', '--add-label', 'x'])
    ).toBe(true);
  });

  it('flags gh api with -X or --method POST/PATCH/PUT/DELETE', () => {
    expect(isWriteCall(['gh', 'api', '-X', 'POST', 'repos/o/r/issues'])).toBe(true);
    expect(isWriteCall(['gh', 'api', '--method', 'PATCH', 'repos/o/r/issues/1'])).toBe(true);
    expect(isWriteCall(['gh', 'api', 'repos/o/r/issues/1'])).toBe(false); // GET, no method flag
  });

  it('flags a gh api graphql call whose query text contains a mutation', () => {
    expect(
      isWriteCall([
        'gh',
        'api',
        'graphql',
        '-f',
        'query=mutation { addComment(input: {}) { clientMutationId } }',
      ])
    ).toBe(true);
  });

  it('does not flag a genuine gh api graphql QUERY (read)', () => {
    expect(isWriteCall(['gh', 'api', 'graphql', '-f', 'query=query { repository { name } }'])).toBe(
      false
    );
  });

  it('does not flag a plain gh issue list / gh issue view (read-only commands)', () => {
    expect(isWriteCall(['gh', 'issue', 'list', '--label', 'batch-epic'])).toBe(false);
    expect(isWriteCall(['gh', 'issue', 'view', '4244', '--json', 'state'])).toBe(false);
  });
});

describe('#790 parseOrphanAnchorBody', () => {
  it('recovers members (checked and unchecked) and base_branch from the batch-compose body format', () => {
    const body = ANCHOR_BODY([4146, 4147], 'main');
    expect(parseOrphanAnchorBody(body)).toEqual({
      members: [4146, 4147],
      base_branch: 'main',
      members_over_cap: false,
    });
  });

  it('a checked-off member line ([x]) still counts — the checklist is never re-read as progress', () => {
    const body = '- [x] #100 done already\n- [ ] #101 still open\n\nbase_branch: release';
    expect(parseOrphanAnchorBody(body)).toEqual({
      members: [100, 101],
      base_branch: 'release',
      members_over_cap: false,
    });
  });

  it('dedupes a repeated member line and defaults base_branch to main when the metadata line is absent', () => {
    const body = '- [ ] #5 a\n- [ ] #5 a\n- [ ] #6 b\n';
    expect(parseOrphanAnchorBody(body)).toEqual({
      members: [5, 6],
      base_branch: 'main',
      members_over_cap: false,
    });
  });

  it('no checklist lines at all → empty members', () => {
    expect(parseOrphanAnchorBody('just prose, no checklist').members).toEqual([]);
  });

  // #790 security review: the body is untrusted (anyone who can edit an open
  // batch-epic issue controls it) — these lock in the two validations added
  // in response.
  it('drops a member number outside the valid GitHub issue range (never sent to a GraphQL read)', () => {
    const body = '- [ ] #123 ok\n- [ ] #99999999999 too big\n- [ ] #0 not positive\n';
    expect(parseOrphanAnchorBody(body).members).toEqual([123]);
  });

  it('truncates at ORPHAN_SWEEP_MAX_MEMBERS and sets members_over_cap', () => {
    const many = Array.from({ length: ORPHAN_SWEEP_MAX_MEMBERS + 5 }, (_, i) => 1000 + i);
    const body = ANCHOR_BODY(many);
    const parsed = parseOrphanAnchorBody(body);
    expect(parsed.members).toHaveLength(ORPHAN_SWEEP_MAX_MEMBERS);
    expect(parsed.members_over_cap).toBe(true);
  });

  it('an unsafe base_branch value (fails SAFE_REF_RE) falls back to main rather than being used as a git ref', () => {
    const body = '- [ ] #1 a\n\nbase_branch: main; rm -rf /\n';
    expect(parseOrphanAnchorBody(body).base_branch).toBe('main');
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
    const verdict = expectVerdict(
      classifyOrphanAnchor({ anchor: 4244, members: [4146, 4147], base_branch: 'main' }, read, {
        repo: REPO,
      })
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
    const verdict = expectVerdict(
      classifyOrphanAnchor({ anchor: 4244, members: [4146], base_branch: 'main' }, read, {
        repo: REPO,
      })
    );
    expect(verdict.kind).toBe('orphan-needs-operator');
    expect(verdict.reasons).toEqual(['member-open:#4146']);
  });

  it('a member closed NOT_PLANNED → orphan-needs-operator, naming it', () => {
    const read = readerFrom({
      4244: truth({ state: 'OPEN' }),
      4146: truth({ state: 'CLOSED', stateReason: 'NOT_PLANNED' }),
    });
    const verdict = expectVerdict(
      classifyOrphanAnchor({ anchor: 4244, members: [4146], base_branch: 'main' }, read, {
        repo: REPO,
      })
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
    const verdict = expectVerdict(
      classifyOrphanAnchor({ anchor: 4244, members: [4146], base_branch: 'main' }, read, {
        repo: REPO,
      })
    );
    expect(verdict.kind).toBe('orphan-needs-operator');
    expect(verdict.reasons).toContain('anchor-handed-back');
  });

  it('an unreachable member read → orphan-unknown, decides nothing', () => {
    const verdict = expectVerdict(
      classifyOrphanAnchor({ anchor: 4244, members: [4146], base_branch: 'main' }, readerFrom({}), {
        repo: REPO,
      })
    );
    expect(verdict.kind).toBe('orphan-unknown');
  });

  it('no members recovered from the body → orphan-needs-operator (never mistaken for clean)', () => {
    const read = readerFrom({ 4244: truth({ state: 'OPEN' }) });
    const verdict = expectVerdict(
      classifyOrphanAnchor({ anchor: 4244, members: [], base_branch: 'main' }, read, {
        repo: REPO,
      })
    );
    expect(verdict).toEqual({
      kind: 'orphan-needs-operator',
      reasons: ['no-members-recovered'],
      members: [],
    });
  });

  it('the anchor CLOSED between the GitHub list and this read → null, skipped like sweepAnchors skips a fresh anchor-closed verdict', () => {
    const read = readerFrom({ 4244: truth({ state: 'CLOSED', stateReason: 'COMPLETED' }) });
    const verdict = classifyOrphanAnchor(
      { anchor: 4244, members: [4146], base_branch: 'main' },
      read,
      { repo: REPO }
    );
    expect(verdict).toBeNull();
  });

  it('#790 security review: members_over_cap refuses with NO reads at all — a truncated membership is never treated as the whole batch', () => {
    let reads = 0;
    const read = (issue: number) => {
      reads += 1;
      return issue === 4244 ? truth({ state: 'OPEN' }) : undefined;
    };
    const verdict = expectVerdict(
      classifyOrphanAnchor(
        { anchor: 4244, members: [1, 2, 3], base_branch: 'main', members_over_cap: true },
        read,
        { repo: REPO }
      )
    );
    expect(verdict).toEqual({
      kind: 'orphan-needs-operator',
      reasons: ['members-over-cap'],
      members: [],
    });
    expect(reads).toBe(1); // only the anchor itself — zero member reads
  });

  // #790 review (team-lead ruling): base_branch decides what counts as
  // "shipped" (shippingEvidence) — a value that does not match the
  // project's expected base must NEVER produce orphan-closable-candidate,
  // even when every member's GitHub state would otherwise look clean.
  it('a base_branch that differs from the expected/configured base → orphan-needs-operator with reason base-branch-nonstandard, even with clean members, and NO member reads', () => {
    let memberReads = 0;
    const read = (issue: number) => {
      if (issue === 4244) return truth({ state: 'OPEN' });
      memberReads += 1;
      return truth({
        state: 'CLOSED',
        stateReason: 'COMPLETED',
        closer: { kind: 'pr', number: 1, merged: true, baseRefName: 'release', repo: REPO },
      });
    };
    const verdict = expectVerdict(
      classifyOrphanAnchor({ anchor: 4244, members: [4146], base_branch: 'release' }, read, {
        repo: REPO,
      })
    );
    expect(verdict).toEqual({
      kind: 'orphan-needs-operator',
      reasons: ['base-branch-nonstandard:release'],
      members: [],
    });
    expect(memberReads).toBe(0);
  });

  it('an explicit expectedBaseBranch override accepts a non-main base — the check is against the CONFIGURED base, not a hardcoded main', () => {
    const read = readerFrom({
      4244: truth({ state: 'OPEN' }),
      4146: truth({
        state: 'CLOSED',
        stateReason: 'COMPLETED',
        closer: { kind: 'pr', number: 1, merged: true, baseRefName: 'release', repo: REPO },
      }),
    });
    const verdict = expectVerdict(
      classifyOrphanAnchor({ anchor: 4244, members: [4146], base_branch: 'release' }, read, {
        repo: REPO,
        expectedBaseBranch: 'release',
      })
    );
    expect(verdict.kind).toBe('orphan-closable-candidate');
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
    const result = sweepOrphanAnchors(state, list, readerFrom({}));
    expect(result).toEqual({ items: [], truncated: false });
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
    const result = sweepOrphanAnchors(state, list, read, {
      repo: REPO,
      commitInBase: () => true,
    });
    expect(result?.truncated).toBe(false);
    expect(result?.items).toHaveLength(1);
    expect(result?.items[0]).toMatchObject({
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
    const result = sweepOrphanAnchors(
      state,
      list,
      readerFrom({ 4244: truth({ state: 'OPEN' }), 4146: truth({ state: 'OPEN' }) })
    );
    expect(result?.items).toHaveLength(1);
    expect(result?.items[0]?.verdict).toBe('orphan-needs-operator');
  });

  it('the lister failing (unverified repo / gh unreachable) → null, not an empty-but-clean sweep, no crash', () => {
    const state = createEmptyState();
    const list = (): OpenAnchorIssue[] | undefined => undefined;
    // null (the list itself failed) is distinct from [] (asked, found zero
    // orphans) — the same convention `StatusReport.anchors`/`orphan_anchors`
    // already use for "did not run at all". Collapsing the two would make a
    // failed check look identical to a clean one.
    expect(sweepOrphanAnchors(state, list, readerFrom({}))).toBeNull();
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
    const result = sweepOrphanAnchors(
      state,
      () => many,
      readerFrom({ 1: truth({ state: 'OPEN' }) })
    );
    expect(result?.items).toHaveLength(ORPHAN_SWEEP_MAX_ANCHORS);
    // #790 review: more candidates existed than the cap could classify —
    // the sweep must say so, not report a silently-clean result.
    expect(result?.truncated).toBe(true);
  });

  // #790 review (Maintainability/Supportability/Documentation/Conformance):
  // the cap used to apply BEFORE ledger-tracked anchors were excluded, so a
  // busy repo with `ORPHAN_SWEEP_MAX_ANCHORS`+ open ledger-tracked anchors
  // could crowd real orphans out of the classified set entirely, silently.
  it('ledger-tracked anchors are excluded BEFORE the cap, not counted against it', () => {
    // Fill the ledger with exactly the cap's worth of tracked anchors...
    const ledgerBatches = Array.from({ length: ORPHAN_SWEEP_MAX_ANCHORS }, (_, i) =>
      createBatch(`b${i}`, [], NOW, { anchor: 8000 + i })
    );
    const state: SchedState = { ...createEmptyState(), batches: ledgerBatches };
    // ...GitHub lists all of those PLUS one real orphan, listed first (the
    // pre-fix ordering bug sliced the cap off the front of the raw list).
    const listed: OpenAnchorIssue[] = [
      { number: 4244, title: 'Batch b-orphan: #4146', body: ANCHOR_BODY([4146]) },
      ...ledgerBatches.map((b) => ({
        number: b.anchor as number,
        title: `Batch ${b.id}: #1`,
        body: ANCHOR_BODY([1]),
      })),
    ];
    const result = sweepOrphanAnchors(
      state,
      () => listed,
      readerFrom({
        4244: truth({ state: 'OPEN' }),
        4146: truth({ state: 'OPEN' }),
      })
    );
    expect(result?.items).toHaveLength(1);
    expect(result?.items[0]?.anchor).toBe(4244);
    expect(result?.truncated).toBe(false); // the one real orphan fit well within the cap
  });

  // #790 review (Conformance, AC4 nuance — accepted as-is by team-lead
  // ruling): the sweep's fail-closed `aborted` flag trips only on a fresh
  // `orphan-unknown` verdict. When an anchor ALREADY has a disqualifying
  // reason before a later member's read fails, `classifyOrphanAnchor`
  // returns `orphan-needs-operator` (a known disqualifier always outranks
  // an unreachable read — see `readMembersShipping`'s own comment), so
  // `aborted` never trips and the NEXT anchor is still read normally. This
  // pins that behavior — needs-operator is the safe direction, so it is
  // accepted, not fixed — with no code change.
  it('AC4 nuance: a disqualified anchor whose LATER member read then fails stays needs-operator (never aborts the sweep for later anchors)', () => {
    const list = (): OpenAnchorIssue[] => [
      { number: 4244, title: 'Batch b-a: #4146, #4147', body: ANCHOR_BODY([4146, 4147]) },
      { number: 4300, title: 'Batch b-b: #4148', body: ANCHOR_BODY([4148]) },
    ];
    const read = readerFrom({
      4244: truth({ state: 'OPEN' }),
      4146: truth({ state: 'OPEN' }), // disqualifies #4244 BEFORE #4147 is even read
      // 4147 deliberately absent — its read fails (undefined)
      4300: truth({ state: 'OPEN' }),
      4148: truth({
        state: 'CLOSED',
        stateReason: 'COMPLETED',
        closer: { kind: 'pr', number: 1, merged: true, baseRefName: 'main', repo: REPO },
      }),
    });
    const result = sweepOrphanAnchors(createEmptyState(), list, read, { repo: REPO });
    expect(result?.items).toHaveLength(2);
    expect(result?.items[0]).toMatchObject({ anchor: 4244, verdict: 'orphan-needs-operator' });
    expect(result?.items[0]?.reasons).toContain('member-open:#4146');
    // The second anchor was still read for real — never short-circuited to
    // orphan-unknown by an "aborted" flag the first anchor never tripped.
    expect(result?.items[1]).toMatchObject({ anchor: 4300, verdict: 'orphan-closable-candidate' });
  });

  // #790 review (Conformance/AC6): the earlier version of this test could
  // never fail — `wrote` was only ever assigned `wrote || false`, and the
  // `.length` checks bound an arity, not a capability. Replaced with a
  // RECORDING ExecFn driven through the REAL gh-argv-building path
  // (`createExecGroundTruth` + `issueCloseReader`, the same machinery
  // `orphanAnchorListerFor`/`anchorSweepFor` use in the CLI) so this test
  // actually observes every `gh` invocation the sweep causes, not a mock
  // return value. Manually verified to have teeth: temporarily adding a
  // `gh issue comment` call inside `sweepOrphanAnchors` made this test fail;
  // reverting that made it pass again (not committed — see PR description).
  it('AC6: a full sweep — anchor list, anchor read, member reads — never issues a gh write command', () => {
    const calls: string[][] = [];
    const fakeExec: ExecFn = (file, args) => {
      calls.push([file, ...args]);
      if (file !== 'gh') return null;
      if (args[0] === 'issue' && args[1] === 'list') {
        return JSON.stringify([
          { number: 4244, title: 'Batch b1: #4146, #4147', body: ANCHOR_BODY([4146, 4147]) },
        ]);
      }
      if (args[0] === 'api' && args[1] === 'graphql') {
        const nArg = args.find((a) => a.startsWith('n='));
        const issue = nArg !== undefined ? Number(nArg.slice(2)) : null;
        if (issue === 4244) return JSON.stringify(graphqlIssue({ state: 'OPEN' }));
        // Both members shipped via a merged PR — the closable-candidate
        // shape, since that path reads the most (every member, exhaustive).
        return JSON.stringify(
          graphqlIssue({
            state: 'CLOSED',
            stateReason: 'COMPLETED',
            closer: {
              __typename: 'PullRequest',
              number: 999,
              merged: true,
              baseRefName: 'main',
              repository: { nameWithOwner: REPO },
            },
          })
        );
      }
      return null; // an unrecognized gh call — never treated as a green light
    };

    // #790 review: drive the SAME argv-building function the real CLI
    // lister uses (`orphanAnchorListArgs`) rather than a hand-copied argv —
    // a change to the production command is now covered by this test too.
    const list = (): OpenAnchorIssue[] | undefined => {
      const out = fakeExec('gh', orphanAnchorListArgs(REPO, ORPHAN_SWEEP_MAX_ANCHORS));
      return out === null ? undefined : (JSON.parse(out) as OpenAnchorIssue[]);
    };
    const read = issueCloseReader(
      createExecGroundTruth(fakeExec, { repoDir: '/repo', repo: REPO })
    );
    expect(read).toBeDefined();

    const result = sweepOrphanAnchors(createEmptyState(), list, read as IssueCloseReader, {
      repo: REPO,
    });

    // The sweep genuinely drove real gh calls (proving this isn't a no-op).
    expect(calls.length).toBeGreaterThanOrEqual(3); // list + anchor read + 2 member reads
    expect(result).not.toBeNull();
    expect(result?.items[0]?.verdict).toBe('orphan-closable-candidate');

    expect(calls.filter(isWriteCall)).toEqual([]);
  });

  it('no exec/write capability is even reachable through the sweep’s own parameter types (list/read are data-only)', () => {
    // Type-level guarantee: OpenAnchorLister and IssueCloseReader both return
    // DATA, never an ExecFn or anything write-shaped — there is no channel
    // through either signature for a write to travel through, independent
    // of what the AC6 test above empirically observed.
    expect(sweepOrphanAnchors.length).toBeLessThanOrEqual(4); // (state, list, read, opts)
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

describe("#799 a closing reference must postdate the member's last reopen", () => {
  const MERGED_SEP_10 = '2026-09-10T10:00:00Z';
  const REOPENED_SEP_11 = '2026-09-11T10:00:00Z';
  const MERGED_SEP_12 = '2026-09-12T10:00:00Z';

  const ref = (mergedAt: string | null, number = 4255): ClosingPr => ({
    number,
    merged: true,
    mergedAt,
    baseRefName: 'main',
    repo: REPO,
  });

  /** A member closed as COMPLETED by hand (no closer), vouched for only by `closingPrs`. */
  const handClosed = (
    closingPrs: ClosingPr[],
    lastReopenedAt: IssueCloseTruth['lastReopenedAt']
  ): IssueCloseTruth =>
    truth({ state: 'CLOSED', stateReason: 'COMPLETED', closer: null, closingPrs, lastReopenedAt });

  /** The anchor verdict for one member, through the same predicate the sweep uses. */
  const anchorVerdictFor = (member: IssueCloseTruth): OrphanAnchorVerdict =>
    expectVerdict(
      classifyOrphanAnchor(
        { anchor: 4244, members: [4116], base_branch: 'main' },
        readerFrom({ 4244: truth({ state: 'OPEN' }), 4116: member }),
        { repo: REPO }
      )
    );

  it('merged PR → reopen → hand close ⇒ refused, anchor needs-operator', () => {
    const member = handClosed([ref(MERGED_SEP_10)], REOPENED_SEP_11);
    expect(shippingEvidence(member, 'main', REPO, undefined)).toEqual({
      refused: 'closed-by-hand-ref-predates-reopen',
    });
    const verdict = anchorVerdictFor(member);
    expect(verdict.kind).toBe('orphan-needs-operator');
    expect(verdict.reasons).toEqual(['member-closed-by-hand-ref-predates-reopen:#4116']);
  });

  it('reopen → merged PR → hand close ⇒ shipped, anchor closable', () => {
    const member = handClosed([ref(MERGED_SEP_12)], REOPENED_SEP_11);
    expect(shippingEvidence(member, 'main', REPO, undefined)).toEqual({
      shipped: 'PR #4255 (closing reference; issue closed by hand)',
    });
    const verdict = anchorVerdictFor(member);
    expect(verdict.kind).toBe('orphan-closable-candidate');
    expect(verdict.reasons).toEqual([]);
  });

  it('a stale reference does not mask a later one: the post-reopen PR vouches', () => {
    const member = handClosed(
      [ref(MERGED_SEP_10, 4200), ref(MERGED_SEP_12, 4255)],
      REOPENED_SEP_11
    );
    expect(shippingEvidence(member, 'main', REPO, undefined)).toEqual({
      shipped: 'PR #4255 (closing reference; issue closed by hand)',
    });
  });

  it('merged at the very instant of the reopen ⇒ refused (strictly after only)', () => {
    const member = handClosed([ref(REOPENED_SEP_11)], REOPENED_SEP_11);
    expect(shippingEvidence(member, 'main', REPO, undefined)).toEqual({
      refused: 'closed-by-hand-ref-predates-reopen',
    });
  });

  it('never reopened ⇒ unchanged: the merged closing reference vouches, merge time not required', () => {
    for (const mergedAt of [MERGED_SEP_10, null]) {
      const member = handClosed([ref(mergedAt)], null);
      expect(shippingEvidence(member, 'main', REPO, undefined)).toEqual({
        shipped: 'PR #4255 (closing reference; issue closed by hand)',
      });
      expect(anchorVerdictFor(member).kind).toBe('orphan-closable-candidate');
    }
  });

  it('an unreadable reopen timeline ⇒ refused, never closable', () => {
    const member = handClosed([ref(MERGED_SEP_12)], undefined);
    expect(shippingEvidence(member, 'main', REPO, undefined)).toEqual({
      refused: 'closed-by-hand-reopen-unreadable',
    });
    const verdict = anchorVerdictFor(member);
    expect(verdict.kind).toBe('orphan-needs-operator');
    expect(verdict.reasons).toEqual(['member-closed-by-hand-reopen-unreadable:#4116']);
  });

  it("reopened, and the reference's merge time is unreadable ⇒ refused, never closable", () => {
    const member = handClosed([ref(null)], REOPENED_SEP_11);
    expect(shippingEvidence(member, 'main', REPO, undefined)).toEqual({
      refused: 'closed-by-hand-ref-predates-reopen',
    });
    expect(anchorVerdictFor(member).kind).toBe('orphan-needs-operator');
  });

  it('a hand close with no qualifying reference at all keeps its original reason', () => {
    expect(shippingEvidence(handClosed([], undefined), 'main', REPO, undefined)).toEqual({
      refused: 'closed-by-hand',
    });
  });

  it('a PR or commit CLOSER is the close event itself — a prior reopen does not refuse it', () => {
    const byPr = truth({
      state: 'CLOSED',
      stateReason: 'COMPLETED',
      closer: { kind: 'pr', number: 4256, merged: true, baseRefName: 'main', repo: REPO },
      lastReopenedAt: REOPENED_SEP_11,
    });
    expect(shippingEvidence(byPr, 'main', REPO, undefined)).toEqual({ shipped: 'PR #4256' });
  });

  it('end to end through the real GraphQL parse: reopens + mergedAt reach the verdict', () => {
    const wire = (reopens: unknown) =>
      JSON.stringify({
        data: {
          repository: {
            issue: {
              state: 'CLOSED',
              stateReason: 'COMPLETED',
              labels: { nodes: [], pageInfo: { hasNextPage: false } },
              timelineItems: { nodes: [{ closer: null }] },
              reopens,
              closedByPullRequestsReferences: {
                nodes: [
                  {
                    number: 4255,
                    merged: true,
                    mergedAt: MERGED_SEP_10,
                    baseRefName: 'main',
                    repository: { nameWithOwner: REPO },
                  },
                ],
              },
            },
          },
        },
      });
    const verdictOver = (reopens: unknown) => {
      const exec: ExecFn = (_cmd, args) => {
        const query = args.find((a) => a.startsWith('query=')) ?? '';
        if (!query.includes('issue(number:$n)')) return null;
        const n = args.find((a) => a.startsWith('n='));
        if (n === 'n=4244') return JSON.stringify(graphqlIssue({ state: 'OPEN' }));
        return wire(reopens);
      };
      const gt = createExecGroundTruth(exec, { repo: REPO });
      const read = issueCloseReader(gt);
      if (read === undefined) throw new Error('expected issueCloseTruth to be wired');
      return expectVerdict(
        classifyOrphanAnchor({ anchor: 4244, members: [4116], base_branch: 'main' }, read, {
          repo: REPO,
        })
      );
    };
    // Merged Sep 10, reopened Sep 11, closed by hand: refused.
    expect(verdictOver({ nodes: [{ createdAt: REOPENED_SEP_11 }] }).reasons).toEqual([
      'member-closed-by-hand-ref-predates-reopen:#4116',
    ]);
    // Never reopened: the reference still vouches.
    expect(verdictOver({ nodes: [] }).kind).toBe('orphan-closable-candidate');
    // Reopen connection missing from the payload: unreadable, fail closed.
    expect(verdictOver(undefined).reasons).toEqual([
      'member-closed-by-hand-reopen-unreadable:#4116',
    ]);
  });
});
