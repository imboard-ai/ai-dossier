import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildKeptWorktreeWarnings,
  buildStatusReport,
  buildStatusWarnings,
  createEmptyState,
  defaultKeptWorktreeReader,
  enqueueEntries,
  KEPT_WORKTREE_PROBE_LIMIT,
  type KeptWorktreeReader,
  keptWorktreeCandidates,
  POOL_ARGS_PREFIX,
  POOL_BIN,
  parkMember,
  patchBatch,
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

  it('#789 AC12: a PR recorded by the automatic hand-opened-PR detection shows in the batches report, same as any other batch.pr', () => {
    let state = seeded();
    // The exact write reconcileStaleBlockedBatches performs when it detects a
    // hand-opened PR the ledger never recorded (batch-dispatch.ts's `merged`
    // transition patch) — buildStatusReport does no PR-source-specific
    // handling, it passes `BatchEntry.pr` straight through regardless of how
    // it was set, so this proves the existing `pr` column/field needs no
    // change for #789, not a new one.
    state = transitionBatch(
      state,
      'b1',
      'blocked',
      { blocked_reason: 'gate-inconclusive:test.focused' },
      NOW
    );
    state = transitionBatch(state, 'b1', 'merged', { pr: 4255 }, NOW);
    const report = buildStatusReport(state, { max_slots: 3 }, 'p');
    const batch = report.batches.find((b) => b.id === 'b1');
    expect(batch?.pr).toBe(4255);
  });

  it('lists failed entries with their reasons', () => {
    let state = seeded();
    state = transitionIssue(state, 101, 'failed', { reason: 'escalation-cap' }, NOW);
    const report = buildStatusReport(state, { max_slots: 3 }, 'p');
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].reason).toBe('escalation-cap');
  });

  it('lists terminal stopped entries separately from failed entries', () => {
    let state = seeded();
    state = transitionIssue(state, 101, 'stopped', { reason: 'operator stop' }, NOW);
    const report = buildStatusReport(state, { max_slots: 3 }, 'p');
    expect(report.failed).toEqual([]);
    expect(report.stopped).toHaveLength(1);
    expect(report.stopped[0]).toMatchObject({ issue: 101, reason: 'operator stop' });
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

  it('includes the current engine lease holder and liveness', () => {
    const report = buildStatusReport(seeded(), { max_slots: 3 }, 'p', {
      pid: 1234,
      pid_start: 5678,
      alive: true,
    });
    expect(report.engine_lease).toEqual({ pid: 1234, pid_start: 5678, alive: true });
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
      consecutive_api_errors: 0,
      pause_reset_at: null,
    });
  });

  it('#629: surfaces the confirmed-dispatch-failure counter and reset time independently of the suspect-dispatch pair', () => {
    let state = seeded();
    state = {
      ...state,
      consecutive_dispatch_api_errors: 2,
      dispatch_pause_reset_at: '2026-09-06T20:40:00Z',
    };
    const report = buildStatusReport(state, { max_slots: 3 }, 'p');
    expect(report.dispatch_health).toEqual({
      consecutive_suspect: 0,
      last_suspect_unit: null,
      consecutive_api_errors: 2,
      pause_reset_at: '2026-09-06T20:40:00Z',
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

  it('#583 AC4: a blocked batch (gate-inconclusive) surfaces under `blocked` with its reason', () => {
    let state = seeded();
    state = {
      ...state,
      batches: state.batches.map((b) =>
        b.id === 'b1'
          ? {
              ...b,
              status: 'blocked' as const,
              blocked_reason: 'gate-inconclusive:test.focused',
              anchor: 200,
            }
          : b
      ),
    };
    const report = buildStatusReport(state, { max_slots: 3 }, 'p');
    const batchBlocked = report.blocked.find((b) => b.status === 'batch-blocked');
    expect(batchBlocked).toMatchObject({
      issue: 200,
      status: 'batch-blocked',
      reason: 'gate-inconclusive:test.focused',
    });
  });

  it("#595: dedupes a batch's evictions by issue, first occurrence kept — both for the table and --json readers", () => {
    let state = seeded();
    state = {
      ...state,
      batches: state.batches.map((b) =>
        b.id === 'b1'
          ? {
              ...b,
              evictions: [
                {
                  issue: 201,
                  reason: 'suite-red',
                  attribution: 'overlap' as const,
                  reverted_commits: ['a'],
                  group: [],
                  at: NOW.toISOString(),
                },
                {
                  issue: 201,
                  reason: 'incremental-gate-failed:test.focused',
                  attribution: 'none' as const,
                  reverted_commits: [],
                  group: [],
                  at: NOW.toISOString(),
                },
              ],
            }
          : b
      ),
    };
    const report = buildStatusReport(state, { max_slots: 3 }, 'p');
    const batch = report.batches.find((b) => b.id === 'b1');
    expect(batch?.evictions).toHaveLength(1);
    expect(batch?.evictions[0].reason).toBe('suite-red');
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

describe('#810: parked batch members in the status report', () => {
  it('lists evicted / handed-back members with reason, branch, profile and exact remedies', () => {
    let state = patchBatch(seeded(), 'b1', { dispatch_profile: 'openai' }, NOW);
    for (const issue of [201, 202]) {
      for (const to of ['classified', 'batched', 'waiting', 'in-work'] as const) {
        state = transitionIssue(state, issue, to, {}, NOW);
      }
    }
    const evidence = (issue: number, reason: string) => ({
      batch: 'b1',
      reason,
      failing_tests: [],
      attribution: 'none' as const,
      reverted_commits: [],
      branch: `batch/b1-m${issue - 200}-${issue}`,
      at: NOW.toISOString(),
    });
    state = parkMember(state, 201, 'handed-back', 'meta-test-event-code-unavailable', NOW, {
      failure_evidence: evidence(201, 'meta-test-event-code-unavailable'),
    }).state;
    state = parkMember(state, 202, 'evicted', 'agent-exited-unverified', NOW, {
      failure_evidence: evidence(202, 'agent-exited-unverified'),
    }).state;

    const report = buildStatusReport(state, { max_slots: 3 }, 'proj');
    expect(report.parked_members).toEqual([
      expect.objectContaining({
        issue: 201,
        batch: 'b1',
        kind: 'handed-back',
        reason: 'meta-test-event-code-unavailable',
        branch: 'batch/b1-m1-201',
        dispatch_profile: 'openai',
        remedies: [
          'ai-dossier sched requeue --issue 201',
          'ai-dossier sched abandon --issue 201 --reason <why>',
        ],
      }),
      expect.objectContaining({
        issue: 202,
        kind: 'evicted',
        reason: 'agent-exited-unverified',
        branch: 'batch/b1-m2-202',
      }),
    ]);
    expect(report.parked_members[1]?.note).toContain('from batch/b1-m2-202 on profile openai');
    // A parked member is not also reported as blocked or runnable.
    expect(report.blocked.some((b) => b.issue === 201 || b.issue === 202)).toBe(false);
    expect(report.runnable_units).not.toContain('issue:201');
  });

  it('a batch blocked over validated members names them and the operator exits', () => {
    let state = seeded();
    for (const to of [
      'classified',
      'batched',
      'waiting',
      'in-work',
      'committed',
      'validated',
    ] as const) {
      state = transitionIssue(state, 201, to, {}, NOW);
    }
    state = patchBatch(state, 'b1', { branch: 'batch/b1' }, NOW);
    const blockedOn = (why: string) =>
      buildStatusReport(
        transitionBatch(state, 'b1', 'blocked', { blocked_reason: why }, NOW),
        { max_slots: 3 },
        'proj'
      ).blocked.find((b) => b.status === 'batch-blocked')?.reason;

    const unattributed = blockedOn('dissolve-refused:unattributable-suite-failure');
    expect(unattributed).toContain('validated member(s) #201 stay landed on batch/b1');
    expect(unattributed).toContain('gh pr create --head batch/b1 --base main');
    expect(unattributed).toContain('ai-dossier sched abandon --batch b1');
    // A red suite is not a branch to ship as-is.
    expect(blockedOn('dissolve-refused:eviction-threshold-suite-red')).toContain(
      'inspect it before shipping'
    );
    // Any other block reason gets no dissolve-refused note.
    expect(blockedOn('suite-unreadable')).toBe('suite-unreadable');
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

describe('#680: the configured dispatch agent + resolved per-tier models are visible', () => {
  it('defaults to the claude CLI with haiku/sonnet/opus', () => {
    const report = buildStatusReport(seeded(), { max_slots: 3 }, 'proj');
    expect(report.dispatch).toEqual({
      tiers: {
        mechanical: { agent: 'claude', model: 'haiku', effort: null, variant: null },
        mid: { agent: 'claude', model: 'sonnet', effort: null, variant: null },
        strong: { agent: 'claude', model: 'opus', effort: null, variant: null },
      },
      // #707: no profiles configured — the named set is empty, not absent
      profiles: {},
      profile_sources: {},
    });
  });

  it('reflects tier_models overrides and a mixed dispatch.tiers ladder', () => {
    const report = buildStatusReport(
      seeded(),
      {
        max_slots: 3,
        dispatch: {
          tier_models: { mid: 'glm-5.3' },
          tiers: {
            mechanical: {
              command: ['opencode', 'run', '--auto', '--model', '{model}'],
              model: 'glm-5.3-flash',
            },
          },
        },
      },
      'proj'
    );
    expect(report.dispatch.tiers.mechanical).toEqual({
      agent: 'opencode',
      model: 'glm-5.3-flash',
      effort: null,
      variant: null,
    });
    expect(report.dispatch.tiers.mid).toEqual({
      agent: 'claude',
      model: 'glm-5.3',
      effort: null,
      variant: null,
    });
    expect(report.dispatch.tiers.strong).toEqual({
      agent: 'claude',
      model: 'opus',
      effort: null,
      variant: null,
    });
  });
});

describe('#707 status: dispatch profiles are named, not just the models', () => {
  it('surfaces each configured profile with its resolved tier executors', () => {
    const report = buildStatusReport(
      seeded(),
      {
        max_slots: 2,
        dispatch: {
          dispatch_profiles: {
            glm: {
              command: ['opencode', 'run', '-m', '{model}', '--format', 'json', '--'],
              tier_models: { mechanical: 'glm-flash', mid: 'glm-5.3', strong: 'glm-5.2' },
            },
          },
        },
      },
      'test-project'
    );
    expect(report.dispatch.profiles.glm).toBeDefined();
    expect(report.dispatch.profiles.glm.mechanical).toEqual({
      agent: 'opencode',
      model: 'glm-flash',
      effort: null,
      variant: null,
    });
    expect(report.dispatch.profile_sources).toEqual({});
    // batches carry their own assignment (null = default here)
    expect(report.batches.every((b) => b.dispatch_profile === null)).toBe(true);
  });

  it('reports no profiles when none are configured (AC1)', () => {
    const report = buildStatusReport(seeded(), { max_slots: 2 }, 'test-project');
    expect(report.dispatch.profiles).toEqual({});
    expect(report.dispatch.profile_sources).toEqual({});
  });

  it('includes the resolved source layer for each profile', () => {
    const report = buildStatusReport(
      seeded(),
      {
        max_slots: 2,
        dispatch: {
          dispatch_profiles: { glm: { tier_models: { mid: 'glm-5.3' } } },
          dispatch_profile_sources: { glm: 'user' },
        },
      },
      'test-project'
    );
    expect(report.dispatch.profile_sources).toEqual({ glm: 'user' });
  });
});

describe('#776: status health warnings', () => {
  const HOUR = 60 * 60 * 1000;
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  const kinds = (state: SchedState, lease: Parameters<typeof buildStatusWarnings>[1] = null) =>
    buildStatusWarnings(state, lease, NOW).map((w) => w.kind);

  it('a healthy state raises no warnings, and --json carries an empty warnings[]', () => {
    const state = seeded();
    expect(buildStatusReport(state, { max_slots: 3 }, 'p', null, NOW).warnings).toEqual([]);
  });

  it('warns when paused for more than 24h, not for a fresh pause', () => {
    const fresh = { ...seeded(), paused: true, paused_at: ago(2 * HOUR) };
    expect(kinds(fresh)).toEqual([]);
    const long = { ...seeded(), paused: true, paused_at: ago(4 * 24 * HOUR) };
    const [w] = buildStatusWarnings(long, null, NOW);
    expect(w).toMatchObject({ kind: 'long-pause' });
    expect(w.message).toContain('4d');
    expect(w.remedy).toContain('sched resume');
  });

  it('warns on a pause of unknown age (state predates paused_at)', () => {
    const legacy = { ...seeded(), paused: true, paused_at: null };
    const [w] = buildStatusWarnings(legacy, null, NOW);
    expect(w.kind).toBe('long-pause');
    expect(w.message).toContain('unknown');
  });

  it('warns on a stale engine lease only while work is pending', () => {
    const dead = { pid: 4321, pid_start: null, alive: false };
    const [w] = buildStatusWarnings(seeded(), dead, NOW);
    expect(w.kind).toBe('stale-engine-lease');
    expect(w.message).toContain('pid 4321');
    expect(w.remedy).toContain('sched start');
    // A live lease, or a dead one with nothing to do, is not a warning.
    expect(kinds(seeded(), { ...dead, alive: true })).toEqual([]);
    expect(kinds(createEmptyState(), dead)).toEqual([]);
  });

  it('warns when a live slot has made no progress for more than 24h', () => {
    const stuck = {
      ...slot(2, 'recovering', 'issue:101'),
      last_progress_at: ago(4 * 24 * HOUR),
    };
    const busy = { ...slot(3, 'running', 'batch:b1'), last_progress_at: ago(HOUR) };
    const state = { ...seeded(), slots: [stuck, busy] };
    const warnings = buildStatusWarnings(state, null, NOW);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ kind: 'stuck-slot', slot: 2, issue: 101 });
    expect(warnings[0].remedy).toContain('sched stop --issue 101');
    // A stuck batch slot names the batch stop instead.
    const stuckBatch = { ...busy, last_progress_at: ago(30 * HOUR) };
    const [b] = buildStatusWarnings({ ...seeded(), slots: [stuckBatch] }, null, NOW);
    expect(b.remedy).toContain('sched stop --batch b1');
  });

  it('lists a stale-closed entry with the exact `sched stop --issue N` remedy (and no duplicate stuck-slot line)', () => {
    let state = seeded();
    state = {
      ...state,
      entries: state.entries.map((e) =>
        e.issue === 101 ? { ...e, stale_closed_at: ago(HOUR) } : e
      ),
    };
    state = {
      ...state,
      slots: [{ ...slot(2, 'recovering', 'issue:101'), last_progress_at: ago(4 * 24 * HOUR) }],
    };
    const report = buildStatusReport(state, { max_slots: 3 }, 'p', null, NOW);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatchObject({
      kind: 'stale-closed',
      issue: 101,
      slot: 2,
      remedy: 'sched stop --issue 101',
    });
    expect(report.warnings[0].message).toContain('recovering');
  });
});

describe('#768 status: the open-anchor sweep is report-only', () => {
  it('is null unless asked for (--anchors) — status makes no network call by default', () => {
    expect(buildStatusReport(seeded(), { max_slots: 3 }, 'p').anchors).toBeNull();
  });

  it('never lists an in-flight batch, and never reads an issue for one', () => {
    const reads: number[] = [];
    const report = buildStatusReport(seeded(), { max_slots: 3 }, 'p', null, NOW, {
      read: (n) => {
        reads.push(n);
        return { state: 'OPEN', stateReason: null, labels: [], closer: null, closingPrs: [] };
      },
    });
    expect(report.anchors).toEqual([]);
    expect(reads).toEqual([]);
  });
});

describe('#791: kept-worktree warning', () => {
  const WORKTREE = '/repo/worktrees/batch-b1-20260924';
  const POOL_REMEDY_PREFIX = `${POOL_BIN} ${POOL_ARGS_PREFIX.join(' ')} return --path`;
  /** A path that actually exists on this machine — needed once `defaultKeptWorktreeReader` starts calling real `fs.realpathSync`. */
  const REAL_DIR = os.tmpdir();

  /** `seeded()`'s slot batch `b1`, patched to `done` with a kept worktree. */
  function doneBatchWithWorktree(
    patch: Partial<{ worktree: string | null; pool_claimed: boolean }> = {}
  ): SchedState {
    const state = seeded();
    return {
      ...state,
      batches: state.batches.map((b) =>
        b.id === 'b1'
          ? { ...b, status: 'done', worktree: WORKTREE, pool_claimed: false, ...patch }
          : b
      ),
    };
  }

  it('AC1/AC5: a done batch with `worktree` set warns; the same batch not-done does not', () => {
    const done = doneBatchWithWorktree();
    const candidates = keptWorktreeCandidates(done);
    expect(candidates).toEqual([
      { batch: 'b1', field: 'worktree', path: WORKTREE, poolClaimed: false },
    ]);

    const blocked = {
      ...done,
      batches: done.batches.map((b) => (b.id === 'b1' ? { ...b, status: 'blocked' } : b)),
    };
    expect(keptWorktreeCandidates(blocked)).toEqual([]);
  });

  it('AC1: a done batch with only `member_worktree` set warns for that field', () => {
    const state = seeded();
    const withMember: SchedState = {
      ...state,
      batches: state.batches.map((b) =>
        b.id === 'b1'
          ? { ...b, status: 'done', member_worktree: WORKTREE, member_pool_claimed: true }
          : b
      ),
    };
    expect(keptWorktreeCandidates(withMember)).toEqual([
      { batch: 'b1', field: 'member_worktree', path: WORKTREE, poolClaimed: true },
    ]);
  });

  it('a candidate whose path is still held by a non-done (in-flight) batch is skipped (#791 supportability review finding 5)', () => {
    // b1 is `done` and kept WORKTREE; enqueue a second in-flight batch b2
    // that has since claimed the very same path (a returned pool worktree
    // re-issued to a fresh batch before b1's ledger field was cleared).
    let withB1 = doneBatchWithWorktree();
    withB1 = enqueueEntries(withB1, [{ issue: 301, mode: 'slot', batch: 'b2' }], NOW);
    withB1 = {
      ...withB1,
      batches: withB1.batches.map((b) =>
        b.id === 'b2' ? { ...b, status: 'executing', worktree: WORKTREE, pool_claimed: true } : b
      ),
    };
    expect(keptWorktreeCandidates(withB1)).toEqual([]);

    // Once b2 no longer holds that path, b1's candidate reappears.
    const b2Released = {
      ...withB1,
      batches: withB1.batches.map((b) => (b.id === 'b2' ? { ...b, worktree: null } : b)),
    };
    expect(keptWorktreeCandidates(b2Released)).toEqual([
      { batch: 'b1', field: 'worktree', path: WORKTREE, poolClaimed: false },
    ]);
  });

  it('AC2: a missing path reports the path is gone and clears automatically, no destructive remedy implied', () => {
    const reader: KeptWorktreeReader = { exists: () => false, hasLocalWork: () => false };
    const [w] = buildKeptWorktreeWarnings(keptWorktreeCandidates(doneBatchWithWorktree()), reader);
    expect(w).toMatchObject({ kind: 'kept-worktree', batch: 'b1' });
    expect(w.message).toContain('no longer exists on disk');
    expect(w.remedy).toContain('no local cleanup needed');
  });

  it('#791 maintainability review finding 3: `exists()` throwing means "could not be checked", never "gone"', () => {
    const reader: KeptWorktreeReader = {
      exists: () => {
        throw new Error('EACCES');
      },
      hasLocalWork: () => false,
    };
    const [w] = buildKeptWorktreeWarnings(keptWorktreeCandidates(doneBatchWithWorktree()), reader);
    expect(w.message).toContain('could not be checked');
    expect(w.message).not.toContain('no longer exists on disk');
    expect(w.remedy).not.toContain('no local cleanup needed');
  });

  it('AC3: pool-claimed picks the pool-return remedy (built from POOL_BIN/POOL_ARGS_PREFIX); cold picks git worktree remove', () => {
    const exists: KeptWorktreeReader['exists'] = () => true;
    const clean: KeptWorktreeReader['hasLocalWork'] = () => false;

    const [cold] = buildKeptWorktreeWarnings(
      keptWorktreeCandidates(doneBatchWithWorktree({ pool_claimed: false })),
      { exists, hasLocalWork: clean }
    );
    expect(cold.remedy).toBe(`git worktree remove ${WORKTREE}`);

    const [pooled] = buildKeptWorktreeWarnings(
      keptWorktreeCandidates(doneBatchWithWorktree({ pool_claimed: true })),
      { exists, hasLocalWork: clean }
    );
    // Not `ai-dossier worktree-pool return` — that binary does not exist
    // (#791 DRY/documentation review finding 1).
    expect(pooled.remedy).toBe(`${POOL_REMEDY_PREFIX} ${WORKTREE}`);
    expect(pooled.message).toContain('pool claim held indefinitely');
  });

  it('#791 security review finding 1: a worktree path with a space is shell-quoted in every remedy', () => {
    const SPACEY = '/repo/worktrees/batch b1 20260924';
    const exists: KeptWorktreeReader['exists'] = () => true;
    const clean: KeptWorktreeReader['hasLocalWork'] = () => false;
    const state = doneBatchWithWorktree({ worktree: SPACEY, pool_claimed: false });

    const [cold] = buildKeptWorktreeWarnings(keptWorktreeCandidates(state), {
      exists,
      hasLocalWork: clean,
    });
    expect(cold.remedy).toBe(`git worktree remove '${SPACEY}'`);

    const pooledState = doneBatchWithWorktree({ worktree: SPACEY, pool_claimed: true });
    const [pooled] = buildKeptWorktreeWarnings(keptWorktreeCandidates(pooledState), {
      exists,
      hasLocalWork: clean,
    });
    expect(pooled.remedy).toBe(`${POOL_REMEDY_PREFIX} '${SPACEY}'`);
  });

  it('AC4: dirty/unpushed is flagged unsafe; clean+pushed is flagged safe', () => {
    const candidates = keptWorktreeCandidates(doneBatchWithWorktree());

    const [dirty] = buildKeptWorktreeWarnings(candidates, {
      exists: () => true,
      hasLocalWork: () => true,
    });
    expect(dirty.message).toContain('uncommitted changes or commits not on any remote branch');
    expect(dirty.remedy).toContain('commit/push first');

    const [clean] = buildKeptWorktreeWarnings(candidates, {
      exists: () => true,
      hasLocalWork: () => false,
    });
    expect(clean.message).toContain('clean and fully pushed');
    expect(clean.remedy).toBe(`git worktree remove ${WORKTREE}`);
  });

  it('AC6: a git probe failure (or a throwing reader) reports unknown and never throws', () => {
    const candidates = keptWorktreeCandidates(doneBatchWithWorktree());

    const [nullResult] = buildKeptWorktreeWarnings(candidates, {
      exists: () => true,
      hasLocalWork: () => null,
    });
    expect(nullResult.message).toContain('could not be checked');

    const [thrown] = buildKeptWorktreeWarnings(candidates, {
      exists: () => true,
      hasLocalWork: () => {
        throw new Error('boom');
      },
    });
    expect(thrown.message).toContain('could not be checked');

    expect(() =>
      buildKeptWorktreeWarnings(candidates, {
        exists: () => {
          throw new Error('boom');
        },
        hasLocalWork: () => false,
      })
    ).not.toThrow();

    // buildStatusReport itself must not throw or omit other warnings when the
    // reader is unhealthy.
    const report = buildStatusReport(
      doneBatchWithWorktree(),
      { max_slots: 3 },
      'p',
      null,
      NOW,
      undefined,
      {
        exists: () => true,
        hasLocalWork: () => {
          throw new Error('boom');
        },
      }
    );
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0].kind).toBe('kept-worktree');
  });

  it("#791 supportability review finding 3: a kept path that is no longer its own worktree root reports unknown, not the enclosing repo's status", () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const exec = (file: string, args: string[]): string | null => {
      calls.push({ file, args });
      if (args[0] === 'rev-parse') return path.dirname(REAL_DIR); // an ENCLOSING dir, not REAL_DIR itself
      if (args.includes('status')) return ''; // would report "clean" if trusted — must not be reached
      return null;
    };
    const reader = defaultKeptWorktreeReader(exec, () => true);
    expect(reader.hasLocalWork(REAL_DIR)).toBeNull();
    // The mismatch is caught before any status/log call.
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toBe('rev-parse');
  });

  it('AC7 (+ #791 review findings 2/4): the real reader runs only read-only, HEAD-scoped, lock-safe git probes — never a destructive command', () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const exec = (file: string, args: string[]): string | null => {
      calls.push({ file, args });
      if (args[0] === 'rev-parse') return REAL_DIR; // its own toplevel — passes containment
      if (args.includes('status')) return ''; // clean
      if (args[0] === 'log') return ''; // nothing unpushed
      return null;
    };
    const reader = defaultKeptWorktreeReader(exec, () => true);
    const result = reader.hasLocalWork(REAL_DIR);
    expect(result).toBe(false);

    expect(calls).toHaveLength(3);
    const DESTRUCTIVE =
      /\bworktree\s+(remove|prune)\b|\bworktree-pool\b|\bclean\b|\breset\b|\bcheckout\b|\bstash\b|\breturn\b|\bgc\b/;
    for (const call of calls) {
      expect(call.file).toBe('git');
      expect(call.args.join(' ')).not.toMatch(DESTRUCTIVE);
    }
    expect(calls[0].args).toEqual(['rev-parse', '--show-toplevel']);
    expect(calls[1].args).toEqual(['--no-optional-locks', 'status', '--porcelain']);
    // HEAD-scoped, not `--branches` (which would read every local branch in
    // the shared repo, including unrelated worktrees' — #791 supportability
    // and maintainability review).
    expect(calls[2].args).toEqual(['log', 'HEAD', '--not', '--remotes', '--oneline']);
  });

  it('a full sweep over multiple kept worktrees never invokes a destructive git/worktree/pool command (#791 review — replaces a prior vacuous test)', () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const exec = (file: string, args: string[]): string | null => {
      calls.push({ file, args });
      if (args[0] === 'rev-parse') return REAL_DIR;
      if (args.includes('status')) return ' M dirty-file'; // dirty — exercises the unsafe path too
      if (args[0] === 'log') return 'abc123 unpushed commit';
      return null;
    };
    const fsCalls: string[] = [];
    const fsExists = (p: string) => {
      fsCalls.push(p);
      return true;
    };
    const reader = defaultKeptWorktreeReader(exec, fsExists);

    let state = seeded();
    state = enqueueEntries(state, [{ issue: 302, mode: 'slot', batch: 'b3' }], NOW);
    state = {
      ...state,
      batches: state.batches.map((b) => {
        if (b.id === 'b1') {
          return { ...b, status: 'done', worktree: REAL_DIR, pool_claimed: true };
        }
        if (b.id === 'b3') {
          return {
            ...b,
            status: 'done',
            member_worktree: REAL_DIR,
            member_pool_claimed: false,
          };
        }
        return b;
      }),
    };

    const warnings = buildKeptWorktreeWarnings(keptWorktreeCandidates(state), reader);
    expect(warnings.length).toBeGreaterThan(0);
    expect(fsCalls.length).toBeGreaterThan(0);

    const DESTRUCTIVE =
      /\bworktree\s+(remove|prune)\b|\bworktree-pool\b|\bclean\b|\breset\b|\bcheckout\b|\bstash\b|\breturn\b|\bgc\b/;
    for (const call of calls) {
      expect(call.args.join(' ')).not.toMatch(DESTRUCTIVE);
    }
    // Every remedy STRING may legitimately mention `worktree remove` /
    // `worktree-pool ... return` — that text is for a human to run by hand,
    // never executed here. The assertion above is over `calls` (what this
    // pass actually RAN), not over the warnings' remedy text.

    // Revert-proof (manual, not re-run automatically): temporarily adding a
    // `exec('git', ['worktree', 'remove', '--force', REAL_DIR])` call inside
    // `defaultKeptWorktreeReader` and re-running this test makes the
    // assertion above fail — confirmed during implementation, then reverted.
  });

  it('#791 supportability review finding 7: probing is capped, the remainder is reported as not-probed without being probed', () => {
    let state = seeded();
    const manyIssues = Array.from({ length: KEPT_WORKTREE_PROBE_LIMIT + 3 }, (_, i) => ({
      issue: 400 + i,
      mode: 'slot' as const,
      batch: `bx${i}`,
    }));
    state = enqueueEntries(state, manyIssues, NOW);
    state = {
      ...state,
      batches: state.batches.map((b) =>
        b.id.startsWith('bx')
          ? {
              ...b,
              status: 'done' as const,
              worktree: `/repo/worktrees/${b.id}`,
              pool_claimed: false,
            }
          : b
      ),
    };
    const candidates = keptWorktreeCandidates(state);
    expect(candidates.length).toBe(KEPT_WORKTREE_PROBE_LIMIT + 3);

    let probeCalls = 0;
    const reader: KeptWorktreeReader = {
      exists: () => {
        probeCalls++;
        return true;
      },
      hasLocalWork: () => false,
    };
    const warnings = buildKeptWorktreeWarnings(candidates, reader);
    expect(warnings).toHaveLength(candidates.length);
    expect(probeCalls).toBe(KEPT_WORKTREE_PROBE_LIMIT);
    const overflowWarnings = warnings.filter((w) => w.message.includes('not probed'));
    expect(overflowWarnings).toHaveLength(3);
  });

  it('AC8: omitting the reader is the default — no kept-worktree warnings, and nothing is executed', () => {
    const state = doneBatchWithWorktree();
    const report = buildStatusReport(state, { max_slots: 3 }, 'p', null, NOW);
    expect(report.warnings.filter((w) => w.kind === 'kept-worktree')).toEqual([]);
  });
});
