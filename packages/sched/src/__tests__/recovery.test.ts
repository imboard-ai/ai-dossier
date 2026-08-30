/**
 * Recovery core tests (#472): bounded fix attempts, eviction with real git
 * reverts (clean, group, conflict), dissolve triggers and strategies, and
 * the batch-PR conflict path — against scratch repos with seeded failures,
 * per the issue's test strategy. No LLM anywhere; suite runs and milestone
 * posts are fakes, git is real.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attributeSuiteFailure,
  type BatchMilestone,
  beginFixAttempt,
  createExecBatchPoster,
  dissolveBatch,
  evictMembers,
  handlePrConflict,
  Journal,
  type JournalEvent,
  type RecoveryDeps,
  readBoundaries,
  resolveDispatch,
  resolveFixAttempt,
  type SchedState,
  type SuiteResult,
  transitionBatch,
  transitionIssue,
  validateState,
} from '../index';
import { createExecFn, type ExecFn } from '../project';
import type { BatchEntry } from '../types';

const dirs: string[] = [];
const NOW = new Date('2026-08-29T12:00:00Z');
const NOW2 = new Date('2026-08-29T12:30:00Z');

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const exec: ExecFn = createExecFn(30_000);

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function commit(cwd: string, message: string, files: Record<string, string | null>): string {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(cwd, name);
    if (content === null) {
      fs.rmSync(file, { force: true });
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  }
  git(['add', '-A'], cwd);
  git(['commit', '-m', message], cwd);
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
}

/** The marker "suite": red exactly when broken.marker exists (seeded failure). */
const MARKER_TEST = ['node', '-e', "process.exit(require('fs').existsSync('broken.marker')?1:0)"];

/**
 * A scratch repo: bare origin with pushed `main`, plus `batch/b1` carrying
 * one boundary commit per member. `seedConflict` makes a later member edit
 * the same file the offender touched (so reverting the offender conflicts).
 */
function batchRepo(
  members: { issue: number; files?: Record<string, string | null>; broken?: boolean }[]
): { work: string; bare: string } {
  const root = tmpDir('sched-recovery-');
  const bare = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  fs.mkdirSync(bare, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  git(['init', '--bare', '--initial-branch=main', bare], root);
  git(['init', '--initial-branch=main', '.'], work);
  git(['config', 'user.email', 'sched@test'], work);
  git(['config', 'user.name', 'sched test'], work);
  git(['remote', 'add', 'origin', bare], work);
  fs.writeFileSync(path.join(work, 'README.md'), 'scratch\n');
  git(['add', '.'], work);
  git(['commit', '-m', 'init'], work);
  git(['push', '-u', 'origin', 'main'], work);

  git(['checkout', '-b', 'batch/b1'], work);
  for (const member of members) {
    const files = member.broken
      ? { 'broken.marker': 'broken\n', ...member.files }
      : (member.files ?? { [`f${member.issue}.txt`]: 'ok\n' });
    commit(work, `fix: thing (#${member.issue})`, files);
  }
  git(['push', '-u', 'origin', 'batch/b1'], work);
  return { work, bare };
}

/** Advances origin/main (the base moved — the F.9 trigger). */
function advanceBase(bare: string, files: Record<string, string>): void {
  const root = path.dirname(bare);
  const clone = path.join(root, 'base-clone');
  execFileSync('git', ['clone', bare, clone], { cwd: root, encoding: 'utf8' });
  git(['config', 'user.email', 'sched@test'], clone);
  git(['config', 'user.name', 'sched test'], clone);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(clone, name), content);
  }
  git(['add', '-A'], clone);
  git(['commit', '-m', 'base moved'], clone);
  git(['push', 'origin', 'main'], clone);
}

// --- State helpers ---

function seededState(members: number[], batchId = 'b1'): SchedState {
  let state: SchedState = {
    schema_version: '1.3.0',
    paused: false,
    entries: members.map((issue) => ({
      issue,
      mode: 'slot' as const,
      batch: batchId,
      deps: [],
      tier: 'mid' as const,
      status: 'queued' as const,
      reason: null,
      pr: null,
      cleanup: null,
      failure_evidence: null,
      enqueued_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    })),
    batches: [
      {
        id: batchId,
        status: 'forming',
        members,
        base_branch: 'main',
        executing_member: 0,
        anchor: 301,
        branch: 'batch/b1',
        run_id: 'r-301-ab12',
        eviction_groups: [],
        evictions: [],
        fix_attempts: [],
        rebase_attempts: 0,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      },
    ],
    slots: [],
    next_slot_id: 1,
    last_pr_poll_at: null,
  };
  // Walk the rails to a validating batch with committed members.
  state = transitionBatch(state, batchId, 'ready', {}, NOW);
  state = transitionBatch(state, batchId, 'executing', {}, NOW);
  for (const issue of members) {
    state = transitionIssue(state, issue, 'classified', {}, NOW);
    state = transitionIssue(state, issue, 'batched', {}, NOW);
    state = transitionIssue(state, issue, 'waiting', {}, NOW);
    state = transitionIssue(state, issue, 'in-work', {}, NOW);
    state = transitionIssue(state, issue, 'committed', {}, NOW);
  }
  state = transitionBatch(state, batchId, 'validating', {}, NOW);
  return state;
}

/** The pipeline position when a red suite needs attribution/eviction. */
function attributing(state: SchedState, batchId = 'b1'): SchedState {
  return transitionBatch(state, batchId, 'attributing', {}, NOW);
}

// --- Fake deps ---

interface DepsLog {
  suiteCalls: number;
  milestones: Array<{ batchId: string; milestone: BatchMilestone }>;
  focused: string[][];
}

function fakeDeps(
  cwd: string,
  opts: { suite?: SuiteResult[] } = {}
): { deps: RecoveryDeps; log: DepsLog; journal: Journal } {
  const journal = new Journal(tmpDir('sched-recovery-journal-'));
  const log: DepsLog = { suiteCalls: 0, milestones: [], focused: [] };
  let suiteIndex = 0;
  const deps: RecoveryDeps = {
    exec,
    cwd,
    journal,
    now: () => NOW2,
    runSuite: () => {
      const result = opts.suite?.[Math.min(suiteIndex, (opts.suite?.length ?? 1) - 1)] ?? {
        ok: true,
        failing: [],
      };
      suiteIndex++;
      log.suiteCalls++;
      return result;
    },
    focusedTestCommand: (tests) => {
      log.focused.push([...tests]);
      return MARKER_TEST;
    },
    postMilestone: (batch, milestone) => {
      log.milestones.push({ batchId: batch.id, milestone });
    },
  };
  return { deps, log, journal };
}

function eventsOf(journal: Journal): JournalEvent[] {
  return journal.read();
}

// --- Bounded fix attempt (AC2) ---

describe('bounded fix attempt (F.2)', () => {
  it('begins exactly one attempt: dispatch instruction + pending record + fixing rail', () => {
    const state = attributing(seededState([201, 202, 203]));
    const { deps } = fakeDeps('/tmp');
    const resolved = resolveDispatch({ max_slots: 2 });
    const { state: next, dispatch } = beginFixAttempt(
      deps,
      state,
      'b1',
      202,
      ['t1', 't2'],
      resolved
    );
    expect(dispatch).not.toBeNull();
    expect(dispatch?.issue).toBe(202);
    expect(dispatch?.command).toContain('sonnet'); // the mid tier
    expect(dispatch?.prompt).toContain('#202');
    expect(dispatch?.prompt).toContain('- t1');
    expect(findBatchIn(next, 'b1').status).toBe('fixing');
    expect(findBatchIn(next, 'b1').fix_attempts).toEqual([
      { issue: 202, outcome: 'pending', at: NOW2.toISOString() },
    ]);
  });

  it('never dispatches a second attempt for the same member (AC2 bounded)', () => {
    let state = attributing(seededState([201, 202]));
    const { deps } = fakeDeps('/tmp');
    const resolved = resolveDispatch({ max_slots: 2 });
    const first = beginFixAttempt(deps, state, 'b1', 202, ['t1'], resolved);
    expect(first.dispatch).not.toBeNull();
    state = resolveFixAttempt(deps, first.state, 'b1', 202, { ok: false, failing: [] });
    // re-enter the pipeline: validating → attributing, attempt already spent
    state = transitionBatch(state, 'b1', 'attributing', {}, NOW2);
    const second = beginFixAttempt(deps, state, 'b1', 202, ['t1'], resolved);
    expect(second.dispatch).toBeNull();
    expect(findBatchIn(second.state, 'b1').status).toBe('attributing');
  });

  it('resolves green and red with the suite verdict recorded', () => {
    const state = attributing(seededState([201, 202]));
    const { deps } = fakeDeps('/tmp');
    const resolved = resolveDispatch({ max_slots: 2 });
    const { state: fixing } = beginFixAttempt(deps, state, 'b1', 202, ['t1'], resolved);

    const green = resolveFixAttempt(deps, fixing, 'b1', 202, { ok: true, failing: [] });
    expect(findBatchIn(green, 'b1').status).toBe('validating');
    expect(findBatchIn(green, 'b1').fix_attempts[0]?.outcome).toBe('green');

    const red = resolveFixAttempt(deps, fixing, 'b1', 202, { ok: false, failing: [] });
    expect(findBatchIn(red, 'b1').status).toBe('validating');
    expect(findBatchIn(red, 'b1').fix_attempts[0]?.outcome).toBe('red');
  });

  it('guards the rails: begin from attributing, resolve from fixing only', () => {
    const state = attributing(seededState([201, 202]));
    const { deps } = fakeDeps('/tmp');
    const resolved = resolveDispatch({ max_slots: 2 });
    expect(() => beginFixAttempt(deps, state, 'b1', 202, [], resolved)).not.toThrow();
    const fixing = beginFixAttempt(deps, state, 'b1', 202, [], resolved).state;
    expect(() => beginFixAttempt(deps, fixing, 'b1', 201, [], resolved)).toThrow(/attributing/);
    expect(() => resolveFixAttempt(deps, state, 'b1', 202, { ok: true, failing: [] })).toThrow(
      /fixing/
    );
  });
});

function findBatchIn(state: SchedState, id: string): BatchEntry {
  const batch = state.batches.find((b) => b.id === id);
  if (!batch) throw new Error(`batch ${id} not found`);
  return batch;
}

// --- Eviction (AC2) ---

describe('evictMembers (F.2 — real git reverts)', () => {
  it('clean revert: reverts the member range, requeues with evidence, re-runs the suite', () => {
    const { work } = batchRepo([{ issue: 201 }, { issue: 202, broken: true }, { issue: 203 }]);
    const state = attributing(seededState([201, 202, 203]));
    const { deps, log } = fakeDeps(work, { suite: [{ ok: true, failing: [] }] });
    const boundaries = readBoundaries({ exec, cwd: work }, 'main') ?? [];

    const outcome = evictMembers(deps, state, 'b1', [202], {
      reason: 'test-failure',
      attribution: 'overlap',
      failingTests: ['src/b.test.ts > suite > case'],
      boundaries,
    });

    expect(outcome.revertConflict).toBe(false);
    expect(outcome.dissolve).toBeNull();
    expect(outcome.evicted).toEqual([202]);
    // 1 of 3 members = exactly ⅓ — NOT strictly more, no dissolve
    expect(outcome.suite?.ok).toBe(true);
    expect(log.suiteCalls).toBe(1); // AC2: re-run the suite

    const batch = findBatchIn(outcome.state, 'b1');
    expect(batch.status).toBe('validating');
    expect(batch.evictions).toHaveLength(1);
    expect(batch.evictions[0]?.issue).toBe(202);
    expect(batch.evictions[0]?.reverted_commits).toHaveLength(1);

    const entry = outcome.state.entries.find((e) => e.issue === 202);
    expect(entry?.status).toBe('requeued');
    expect(entry?.mode).toBe('full');
    expect(entry?.batch).toBeNull();
    expect(entry?.failure_evidence).toMatchObject({
      batch: 'b1',
      attribution: 'overlap',
      reason: 'test-failure',
      failing_tests: ['src/b.test.ts > suite > case'],
    });

    // the marker file is GONE on the branch (the revert applied for real)
    expect(fs.existsSync(path.join(work, 'broken.marker'))).toBe(false);
    expect(
      execFileSync('git', ['log', '--oneline', '-1'], { cwd: work, encoding: 'utf8' })
    ).toContain('Revert');

    // milestone + journal (AC5)
    expect(log.milestones).toHaveLength(1);
    expect(log.milestones[0]?.milestone).toMatchObject({
      phase: 'batch-validate',
      status: 'blocked',
      reason: 'evicted:202',
    });
    expect(
      eventsOf(deps.journal).some((e) => e.event === 'member-evicted' && e.issue === 202)
    ).toBe(true);
    // the produced state is persistable
    expect(() => validateState(JSON.parse(JSON.stringify(outcome.state)))).not.toThrow();
  });

  it('eviction groups revert together (AC2/AC6)', () => {
    const { work } = batchRepo([
      { issue: 201, files: { 'shared.ts': 'a\n' } },
      { issue: 202, files: { 'shared.ts': 'a\nb\n' }, broken: true },
      { issue: 203 },
    ]);
    let state = attributing(seededState([201, 202, 203]));
    state = {
      ...state,
      batches: state.batches.map((b) =>
        b.id === 'b1' ? { ...b, eviction_groups: [[201, 202]] } : b
      ),
    };
    const { deps, log } = fakeDeps(work, { suite: [{ ok: true, failing: [] }] });
    const boundaries = readBoundaries({ exec, cwd: work }, 'main') ?? [];

    const outcome = evictMembers(deps, state, 'b1', [202], {
      reason: 'test-failure',
      attribution: 'overlap',
      failingTests: ['shared.test.ts > suite > case'],
      boundaries,
    });

    // the whole group went: offender 202 AND group-mate 201
    expect(outcome.evicted).toEqual([201, 202]);
    expect(outcome.revertedCommits).toHaveLength(2);
    const batch = findBatchIn(outcome.state, 'b1');
    expect(batch.evictions.map((e) => e.issue)).toEqual([201, 202]);
    expect(batch.evictions[0]?.group).toEqual([201, 202]);
    // both commits reverted for real: shared.ts (created by 201, edited by
    // 202) is gone — the group's whole footprint reverted together
    expect(fs.existsSync(path.join(work, 'shared.ts'))).toBe(false);
    expect(fs.existsSync(path.join(work, 'broken.marker'))).toBe(false);

    const mate = outcome.state.entries.find((e) => e.issue === 201);
    expect(mate?.status).toBe('requeued');
    expect(mate?.failure_evidence).toMatchObject({
      attribution: 'group',
      reason: 'eviction-group',
    });
    // 2 of 3 evicted > ⅓ → dissolve fired (full strategy on this trigger)
    expect(outcome.dissolve).toBe('evicted-fraction');
    expect(findBatchIn(outcome.state, 'b1').status).toBe('dissolved');
    expect(log.milestones.some((m) => m.milestone.reason.startsWith('dissolved:'))).toBe(true);
  });

  it('a revert conflict aborts the revert and dissolves into halves (AC3/AC6)', () => {
    // 201 adds the line; 202 EDITS the same line afterwards — reverting 201
    // conflicts with 202's change.
    const { work } = batchRepo([
      { issue: 201, files: { 'conflict.txt': 'line-a\n' } },
      { issue: 202, files: { 'conflict.txt': 'line-b\n' } },
      { issue: 203 },
      { issue: 204 },
    ]);
    const state = attributing(seededState([201, 202, 203, 204]));
    const { deps } = fakeDeps(work);
    const boundaries = readBoundaries({ exec, cwd: work }, 'main') ?? [];

    const outcome = evictMembers(deps, state, 'b1', [201], {
      reason: 'test-failure',
      attribution: 'bisect',
      failingTests: ['conflict.test.ts > suite > case'],
      boundaries,
    });

    expect(outcome.revertConflict).toBe(true);
    expect(outcome.dissolve).toBe('revert-conflict');
    const batch = findBatchIn(outcome.state, 'b1');
    expect(batch.status).toBe('dissolved');
    // the evicted member requeued as full-cycle even though the revert conflicted
    const evictedEntry = outcome.state.entries.find((e) => e.issue === 201);
    expect(evictedEntry?.status).toBe('requeued');
    expect(evictedEntry?.failure_evidence?.reason).toBe('test-failure');
    // dissolved into halves (halved strategy on conflict)
    expect(outcome.dissolution?.halves).toEqual(['b1-a', 'b1-b']);
    // the worktree is not left mid-revert
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: work, encoding: 'utf8' })).toBe(
      ''
    );
    expect(() => validateState(JSON.parse(JSON.stringify(outcome.state)))).not.toThrow();
  });
});

// --- Dissolve (AC3) ---

describe('dissolveBatch (F.2/F.8)', () => {
  it('full strategy: nothing green is discarded — shipped members keep their outcome', () => {
    let state = seededState([201, 202, 203]);
    // 201 shipped in the batch (green work survives); 202/203 still committed
    state = transitionIssue(state, 201, 'validated', {}, NOW);
    state = transitionIssue(state, 201, 'shipped-in-batch', {}, NOW);

    const { deps, log } = fakeDeps('/tmp');
    const outcome = dissolveBatch(deps, state, 'b1', 'evicted-fraction', 'full');

    expect(findBatchIn(outcome.state, 'b1').status).toBe('dissolved');
    expect(outcome.preserved).toEqual([201]);
    expect(outcome.requeued).toEqual([202, 203]);
    expect(outcome.halves).toBeNull();
    // 201 keeps its shipped outcome (nothing green discarded)
    expect(outcome.state.entries.find((e) => e.issue === 201)?.status).toBe('shipped-in-batch');
    for (const issue of [202, 203]) {
      const entry = outcome.state.entries.find((e) => e.issue === issue);
      expect(entry?.status).toBe('requeued');
      expect(entry?.mode).toBe('full');
    }
    // AC5: milestone reports what was preserved
    const milestone = log.milestones.find((m) => m.milestone.reason.startsWith('dissolved:'));
    expect(milestone?.milestone.kv?.preserved).toBe('201');
    expect(eventsOf(deps.journal).some((e) => e.event === 'batch-dissolved')).toBe(true);
    expect(() => validateState(JSON.parse(JSON.stringify(outcome.state)))).not.toThrow();
  });

  it('halved strategy: splits still-batched members into two forming halves (AC3/AC4)', () => {
    let state = seededState([201, 202, 203, 204]);
    state = transitionIssue(state, 204, 'validated', {}, NOW);
    state = transitionIssue(state, 204, 'shipped-in-batch', {}, NOW);

    const { deps } = fakeDeps('/tmp');
    const outcome = dissolveBatch(deps, state, 'b1', 'revert-conflict', 'halved');

    expect(outcome.halves).toEqual(['b1-a', 'b1-b']);
    const halfA = findBatchIn(outcome.state, 'b1-a');
    const halfB = findBatchIn(outcome.state, 'b1-b');
    expect(halfA.status).toBe('forming');
    expect(halfB.status).toBe('forming');
    // dispatch order split: ceil(3/2)=2 → A=[201,202], B=[203]; 204 preserved
    expect(halfA.members).toEqual([201, 202]);
    expect(halfB.members).toEqual([203]);
    expect(halfA.anchor).toBe(301);
    expect(halfA.base_branch).toBe('main');
    expect(outcome.preserved).toEqual([204]);
    // members retagged into their halves as batched
    expect(outcome.state.entries.find((e) => e.issue === 201)?.batch).toBe('b1-a');
    expect(outcome.state.entries.find((e) => e.issue === 201)?.status).toBe('batched');
    expect(outcome.state.entries.find((e) => e.issue === 203)?.batch).toBe('b1-b');
    expect(findBatchIn(outcome.state, 'b1').status).toBe('dissolved');
    expect(() => validateState(JSON.parse(JSON.stringify(outcome.state)))).not.toThrow();
  });

  it('halved falls back to full when fewer than two members are halvable', () => {
    let state = seededState([201, 202]);
    state = transitionIssue(state, 201, 'validated', {}, NOW);
    state = transitionIssue(state, 201, 'shipped-in-batch', {}, NOW);
    const { deps } = fakeDeps('/tmp');
    const outcome = dissolveBatch(deps, state, 'b1', 'revert-conflict', 'halved');
    expect(outcome.halves).toBeNull();
    expect(outcome.requeued).toEqual([202]);
    expect(outcome.preserved).toEqual([201]);
  });
});

// --- Batch-PR conflict path (AC4) ---

describe('handlePrConflict (F.9)', () => {
  it('first occurrence: rebases onto the moved base, re-runs the suite, re-ships', () => {
    const { work, bare } = batchRepo([{ issue: 201 }, { issue: 202 }]);
    advanceBase(bare, { 'base-file.txt': 'moved\n' }); // base moved under the batch
    let state = seededState([201, 202]);
    state = transitionBatch(state, 'b1', 'reviewing', {}, NOW);
    state = transitionBatch(state, 'b1', 'shipping', {}, NOW);
    state = transitionBatch(state, 'b1', 'awaiting-merge', {}, NOW);

    const { deps, log } = fakeDeps(work, { suite: [{ ok: true, failing: [] }] });
    const outcome = handlePrConflict(deps, state, 'b1', 'pr-conflicting');

    expect(outcome.kind).toBe('rebased');
    if (outcome.kind !== 'rebased') return;
    expect(outcome.suite.ok).toBe(true);
    expect(log.suiteCalls).toBe(1); // AC4: re-run the suite
    const batch = findBatchIn(outcome.state, 'b1');
    expect(batch.status).toBe('shipping'); // re-ship once
    expect(batch.rebase_attempts).toBe(1);
    // the rebase really happened: base-file.txt from the moved base is present
    expect(fs.existsSync(path.join(work, 'base-file.txt'))).toBe(true);
    // and the batch member work is still there
    expect(fs.existsSync(path.join(work, 'f201.txt'))).toBe(true);
    expect(eventsOf(deps.journal).some((e) => e.event === 'batch-rebased')).toBe(true);
    expect(() => validateState(JSON.parse(JSON.stringify(outcome.state)))).not.toThrow();
  });

  it('second occurrence dissolves into two half-batches immediately (AC4)', () => {
    let state = seededState([201, 202, 203, 204]);
    state = transitionBatch(state, 'b1', 'reviewing', {}, NOW);
    state = transitionBatch(state, 'b1', 'shipping', {}, NOW);
    state = transitionBatch(state, 'b1', 'awaiting-merge', {}, NOW);
    state = {
      ...state,
      batches: state.batches.map((b) => (b.id === 'b1' ? { ...b, rebase_attempts: 1 } : b)),
    };
    const { deps } = fakeDeps('/tmp');
    const outcome = handlePrConflict(deps, state, 'b1', 'auto-merge-blocked');

    expect(outcome.kind).toBe('dissolved');
    if (outcome.kind !== 'dissolved') return;
    expect(outcome.dissolution.halves).toEqual(['b1-a', 'b1-b']);
    expect(findBatchIn(outcome.state, 'b1').status).toBe('dissolved');
  });

  it('a rebase conflict aborts and dissolves into halves', () => {
    const { work, bare } = batchRepo([{ issue: 201 }, { issue: 202 }, { issue: 203 }]);
    // base moves with an edit to the SAME file member 201 touched → conflict
    advanceBase(bare, { 'f201.txt': 'base-changed\n' });
    let state = seededState([201, 202, 203]);
    state = transitionBatch(state, 'b1', 'reviewing', {}, NOW);
    state = transitionBatch(state, 'b1', 'shipping', {}, NOW);
    state = transitionBatch(state, 'b1', 'awaiting-merge', {}, NOW);

    const { deps } = fakeDeps(work);
    const outcome = handlePrConflict(deps, state, 'b1', 'pr-conflicting');

    expect(outcome.kind).toBe('dissolved');
    if (outcome.kind !== 'dissolved') return;
    expect(outcome.dissolution.halves).toEqual(['b1-a', 'b1-b']);
    // worktree not left mid-rebase
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: work, encoding: 'utf8' })).toBe(
      ''
    );
  });

  it('guards the rail: only an awaiting-merge batch enters the conflict path', () => {
    const state = seededState([201, 202]);
    const { deps } = fakeDeps('/tmp');
    expect(() => handlePrConflict(deps, state, 'b1', 'pr-conflicting')).toThrow(/awaiting-merge/);
  });
});

// --- Attribution pipeline (AC1) ---

describe('attributeSuiteFailure (F.2 pipeline)', () => {
  it('resolves unique overlaps without touching git bisect', () => {
    const { work } = batchRepo([{ issue: 201 }, { issue: 202 }]);
    const { deps, log } = fakeDeps(work);
    const verdict = attributeSuiteFailure(
      deps,
      findBatchIn(seededState([201, 202]), 'b1'),
      [{ id: 'src/a.test.ts > suite > case', file: 'src/a.test.ts' }],
      [
        { issue: 201, changed_paths: ['src/a.ts', 'src/a.test.ts'], focused_tests: [] },
        { issue: 202, changed_paths: ['src/b.ts'], focused_tests: [] },
      ],
      []
    );
    expect(verdict).not.toHaveProperty('kind');
    if ('attributed' in verdict) {
      expect(verdict.attributed.get(201)).toEqual(['src/a.test.ts > suite > case']);
      expect(verdict.methods.get(201)).toBe('overlap');
    }
    expect(log.focused).toHaveLength(0); // no bisect needed
  });

  it('resolves ambiguity with the deterministic bisect (AC1)', () => {
    // both members touched the failing test file → overlap is ambiguous; the
    // bisect pins the member that actually broke the suite.
    const { work } = batchRepo([
      { issue: 201, files: { 'src/shared.test.ts': 'test\n' } },
      { issue: 202, files: { 'src/shared.test.ts': 'test2\n' }, broken: true },
    ]);
    const { deps } = fakeDeps(work);
    const state = seededState([201, 202]);
    const boundaries = readBoundaries({ exec, cwd: work }, 'main') ?? [];
    const verdict = attributeSuiteFailure(
      deps,
      findBatchIn(state, 'b1'),
      [{ id: 'src/shared.test.ts > suite > case', file: 'src/shared.test.ts' }],
      [
        { issue: 201, changed_paths: ['src/shared.test.ts'], focused_tests: [] },
        { issue: 202, changed_paths: ['src/shared.test.ts'], focused_tests: [] },
      ],
      boundaries
    );
    expect(verdict).not.toHaveProperty('kind');
    if ('attributed' in verdict) {
      expect(verdict.attributed.get(202)).toEqual(['src/shared.test.ts > suite > case']);
      expect(verdict.methods.get(202)).toBe('bisect');
    }
  });

  it('unattributable failures hand off to a human (decision-pending)', () => {
    const { work } = batchRepo([{ issue: 201 }, { issue: 202 }]);
    const { deps } = fakeDeps(work);
    const verdict = attributeSuiteFailure(
      deps,
      findBatchIn(seededState([201, 202]), 'b1'),
      [{ id: 'mystery.test.ts > suite > case', file: 'mystery.test.ts' }],
      [{ issue: 201, changed_paths: ['src/a.ts'], focused_tests: [] }],
      []
    );
    // overlap found nothing → bisect ran → the failure does not reproduce at
    // head (nothing is broken in the fixture) → green → decision-pending
    expect(verdict).toMatchObject({ kind: 'decision-pending' });
  });
});

// --- Milestone poster (AC5) ---

describe('createExecBatchPoster', () => {
  it('shells ai-dossier runstate post on the anchor with sanitized values', () => {
    const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
    const execFake: ExecFn = (file, args, cwd) => {
      calls.push({ file, args: [...args], cwd: cwd ?? '' });
      return '';
    };
    const poster = createExecBatchPoster(execFake, '/repo');
    const batch = findBatchIn(seededState([201]), 'b1');
    poster(batch, {
      phase: 'batch-validate',
      status: 'blocked',
      reason: 'evicted:201,202 with spaces',
      kv: { reverted: '2' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe('ai-dossier');
    expect(calls[0]?.args).toEqual([
      'runstate',
      'post',
      '--issue',
      '301',
      '--phase',
      'batch-validate',
      '--status',
      'blocked',
      '--kv',
      'reason=evicted:201,202-with-spaces',
      '--run',
      'r-301-ab12',
      '--kv',
      'reverted=2',
    ]);
  });

  it('warns and posts nothing when the batch has no anchor', () => {
    const calls: string[][] = [];
    const execFake: ExecFn = (file, args) => {
      calls.push([file, ...args]);
      return '';
    };
    const poster = createExecBatchPoster(execFake, '/repo');
    let state = seededState([201]);
    state = { ...state, batches: state.batches.map((b) => ({ ...b, anchor: null })) };
    poster(findBatchIn(state, 'b1'), {
      phase: 'batch-validate',
      status: 'blocked',
      reason: 'x',
    });
    expect(calls).toHaveLength(0);
  });

  it('a failed post is degradation, not a crash', () => {
    const execFake: ExecFn = () => null;
    const poster = createExecBatchPoster(execFake, '/repo');
    expect(() =>
      poster(findBatchIn(seededState([201]), 'b1'), {
        phase: 'batch-validate',
        status: 'blocked',
        reason: 'x',
      })
    ).not.toThrow();
  });
});
