import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type BatchMilestone,
  beginAttribution,
  beginFixAttempt,
  checkDissolveTrigger,
  createEmptyState,
  createExecFn,
  createExecMilestonePoster,
  dissolveBatch,
  type ExecFn,
  enqueueEntries,
  evictMembers,
  expandEvictionGroups,
  failingTest,
  findBatch,
  findEntry,
  handlePrConflict,
  type JournalEvent,
  type MemberFootprint,
  type MemberRange,
  memberRanges,
  parseBoundaryCommits,
  type RecoveryDeps,
  resolveFixAttempt,
  type SchedState,
  type SuiteResult,
  transitionBatch,
  transitionIssue,
} from '../index';

/**
 * Batch failure recovery (#472 AC2–AC5). Reverts run against REAL scratch
 * repos — a revert conflict is the one failure mode that must never be faked,
 * since the whole dissolve path hangs off it — while milestone posting, the
 * suite runner and the journal are fakes.
 */

const NOW = new Date('2026-08-29T12:00:00Z');
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- fixtures ---

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** A scratch repo with one commit per spec entry on top of a seeded base. */
function scratchRepo(commits: Array<{ subject: string; file: string; content: string }>): {
  repo: string;
  base: string;
  head: string;
} {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-recovery-'));
  dirs.push(repo);
  git(['init', '--initial-branch=main', '.'], repo);
  git(['config', 'user.email', 'sched@test'], repo);
  git(['config', 'user.name', 'sched test'], repo);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'base'], repo);
  const base = git(['rev-parse', 'HEAD'], repo).trim();
  for (const commit of commits) {
    fs.writeFileSync(path.join(repo, commit.file), commit.content);
    git(['add', '.'], repo);
    git(['commit', '-m', commit.subject], repo);
  }
  return { repo, base, head: git(['rev-parse', 'HEAD'], repo).trim() };
}

function rangesOf(repo: string, base: string): MemberRange[] {
  return memberRanges(
    parseBoundaryCommits(git(['log', '--reverse', '--format=%H%x09%s', `${base}..HEAD`], repo))
  );
}

/** A batch of `members` driven to `status`, with every member `committed`. */
function batchState(
  members: number[],
  status: 'validating' | 'attributing' | 'awaiting-merge' = 'attributing',
  opts: { anchor?: number; run?: string; groups?: number[][] } = {}
): SchedState {
  let state = enqueueEntries(
    createEmptyState(),
    members.map((issue, i) => ({
      issue,
      mode: 'slot' as const,
      batch: 'b1',
      ...(i === 0
        ? {
            anchor: opts.anchor ?? 900,
            run_id: opts.run ?? 'r-900-aaaa',
            eviction_groups: opts.groups ?? [],
          }
        : {}),
    })),
    NOW
  );
  for (const issue of members) {
    for (const to of ['classified', 'batched', 'waiting', 'in-work', 'committed'] as const) {
      state = transitionIssue(state, issue, to, {}, NOW);
    }
  }
  state = transitionBatch(state, 'b1', 'ready', {}, NOW);
  state = transitionBatch(state, 'b1', 'executing', {}, NOW);
  state = transitionBatch(state, 'b1', 'validating', {}, NOW);
  if (status === 'attributing') state = transitionBatch(state, 'b1', 'attributing', {}, NOW);
  if (status === 'awaiting-merge') {
    state = transitionBatch(state, 'b1', 'reviewing', {}, NOW);
    state = transitionBatch(state, 'b1', 'shipping', {}, NOW);
    state = transitionBatch(state, 'b1', 'awaiting-merge', {}, NOW);
  }
  return state;
}

interface Harness {
  deps: RecoveryDeps;
  events: JournalEvent[];
  milestones: Array<{ anchor: number; run: string | null; milestone: BatchMilestone }>;
  suiteRuns: number;
}

function harness(
  opts: { exec?: ExecFn; suite?: SuiteResult | null; postOk?: boolean } = {}
): Harness {
  const events: JournalEvent[] = [];
  const milestones: Array<{ anchor: number; run: string | null; milestone: BatchMilestone }> = [];
  const h: Harness = {
    events,
    milestones,
    suiteRuns: 0,
    deps: {
      exec: opts.exec ?? (() => ''),
      repoDir: '/repo',
      journal: { append: (event) => events.push({ ts: NOW.toISOString(), ...event }) },
      postMilestone: (anchor, run, milestone) => {
        milestones.push({ anchor, run, milestone });
        return opts.postOk ?? true;
      },
      runSuite:
        opts.suite === null
          ? undefined
          : () => {
              h.suiteRuns += 1;
              return opts.suite ?? { ok: true, failing: [] };
            },
      now: () => NOW,
    },
  };
  return h;
}

const member = (issue: number, paths: string[], focused: string[] = []): MemberFootprint => ({
  issue,
  changedPaths: paths,
  focusedTests: focused,
});

const eventNames = (events: JournalEvent[]): string[] => events.map((e) => e.event);

// --- AC1: attribution orchestration ---

describe('beginAttribution', () => {
  it('moves the batch to attributing and names the offender', () => {
    const state = batchState([201, 202], 'validating');
    const h = harness();
    const test = failingTest('src/a/impl.test.ts', 'a fails');
    const result = beginAttribution(
      state,
      'b1',
      {
        failing: [test],
        footprints: [member(201, ['src/a/impl.ts']), member(202, ['src/b/impl.ts'])],
      },
      h.deps
    );

    expect(findBatch(result.state, 'b1')?.status).toBe('attributing');
    expect(result.outcome.offenders).toEqual([201]);
    expect(result.outcome.method).toBe('overlap');
    expect(result.outcome.bisect).toBeNull();
    expect(eventNames(h.events)).toEqual(['suite-failed', 'attributed']);
  });

  it('does not reach for bisect when overlap answered everything', () => {
    const state = batchState([201], 'validating');
    const calls: string[][] = [];
    const h = harness({
      exec: (file, args) => {
        calls.push([file, ...args]);
        return '';
      },
    });
    beginAttribution(
      state,
      'b1',
      {
        failing: [failingTest('src/a.test.ts', 'a')],
        footprints: [member(201, ['src/a.ts'])],
        bisect: { good: 'aaaaaaa', bad: 'bbbbbbb', testCommand: ['true'], boundary: [] },
      },
      h.deps
    );
    expect(calls.filter((c) => c.includes('bisect'))).toEqual([]);
  });

  it('falls back to bisect for an ambiguous failure and adopts its verdict', () => {
    const state = batchState([201, 202], 'validating');
    const badSha = 'b'.repeat(40);
    // A scripted git: the probe at `bad` fails, then bisect names badSha.
    const exec: ExecFn = (file, args) => {
      if (file !== 'git') return null; // the test command "fails" at bad
      if (args[0] === 'bisect' && args[1] === 'run') return `${badSha} is the first bad commit\n`;
      return '';
    };
    const h = harness({ exec });
    const test = failingTest('src/shared/util.test.ts', 'util');
    const result = beginAttribution(
      state,
      'b1',
      {
        failing: [test],
        footprints: [member(201, ['src/shared/a.ts']), member(202, ['src/shared/b.ts'])],
        bisect: {
          good: 'a'.repeat(40),
          bad: badSha,
          testCommand: ['node', 'check.cjs'],
          boundary: [{ sha: badSha, subject: 'feat: b (#202)', issue: 202 }],
        },
      },
      h.deps
    );

    expect(result.outcome.method).toBe('bisect');
    expect(result.outcome.offenders).toEqual([202]);
    expect(result.outcome.attributed.get(202)).toEqual([test]);
    expect(result.outcome.ambiguous).toHaveLength(1);
  });

  it('attributes nobody when bisect lands on a non-member commit', () => {
    const state = batchState([201, 202], 'validating');
    const badSha = 'c'.repeat(40);
    const exec: ExecFn = (file, args) => {
      if (file !== 'git') return null;
      if (args[0] === 'bisect' && args[1] === 'run') return `${badSha} is the first bad commit\n`;
      return '';
    };
    const h = harness({ exec });
    const result = beginAttribution(
      state,
      'b1',
      {
        failing: [failingTest('src/unknown.test.ts', 'x')],
        footprints: [member(201, ['src/a.ts']), member(202, ['src/b.ts'])],
        bisect: {
          good: 'a'.repeat(40),
          bad: badSha,
          testCommand: ['node', 'check.cjs'],
          boundary: [{ sha: badSha, subject: 'chore: no trailer', issue: null }],
        },
      },
      h.deps
    );
    expect(result.outcome.offenders).toEqual([]);
    expect(result.outcome.method).toBe('none');
    expect(result.outcome.bisect?.kind).toBe('unattributable');
  });
});

// --- AC2: the one bounded fix attempt ---

describe('fix attempts', () => {
  it('returns a mid-tier dispatch instruction and records the attempt', () => {
    const state = batchState([201, 202]);
    const h = harness();
    const tests = [failingTest('src/a.test.ts', 'a fails')];
    const result = beginFixAttempt(state, 'b1', 201, h.deps, { tests });

    expect(result.dispatch?.tier).toBe('mid');
    expect(result.dispatch?.command).toContain('sonnet');
    expect(result.dispatch?.prompt).toContain('#201');
    expect(result.dispatch?.prompt).toContain('src/a.test.ts::a fails');
    expect(findBatch(result.state, 'b1')?.status).toBe('fixing');
    expect(findBatch(result.state, 'b1')?.fix_attempts).toEqual([
      { issue: 201, tier: 'mid', outcome: 'dispatched', at: NOW.toISOString() },
    ]);
    expect(eventNames(h.events)).toEqual(['fix-dispatched']);
  });

  it('refuses a second attempt for the same member — the next step is eviction', () => {
    const state = batchState([201, 202]);
    const h = harness();
    const first = beginFixAttempt(state, 'b1', 201, h.deps);
    const resolved = resolveFixAttempt(first.state, 'b1', 201, 'red', h.deps);
    const attributing = transitionBatch(resolved.state, 'b1', 'attributing', {}, NOW);

    const second = beginFixAttempt(attributing, 'b1', 201, h.deps);
    expect(second.dispatch).toBeNull();
    expect(second.state).toBe(attributing);
    expect(findBatch(attributing, 'b1')?.fix_attempts).toHaveLength(1);
  });

  it('records the outcome and returns the batch to validating', () => {
    const state = batchState([201]);
    const h = harness();
    const dispatched = beginFixAttempt(state, 'b1', 201, h.deps);
    const resolved = resolveFixAttempt(dispatched.state, 'b1', 201, 'green', h.deps);

    expect(findBatch(resolved.state, 'b1')?.status).toBe('validating');
    expect(findBatch(resolved.state, 'b1')?.fix_attempts[0].outcome).toBe('green');
    expect(eventNames(h.events)).toEqual(['fix-dispatched', 'fix-resolved']);
  });

  it('still allows another member its own attempt', () => {
    const state = batchState([201, 202]);
    const h = harness();
    const first = beginFixAttempt(state, 'b1', 201, h.deps);
    const second = beginFixAttempt(first.state, 'b1', 202, h.deps);
    expect(second.dispatch?.issue).toBe(202);
    expect(findBatch(second.state, 'b1')?.fix_attempts).toHaveLength(2);
  });
});

// --- AC2/AC3: eviction against real git ---

describe('evictMembers (real git reverts)', () => {
  const twoMembers = () =>
    scratchRepo([
      { subject: 'feat: a (#201)', file: 'a.txt', content: 'a\n' },
      { subject: 'feat: b (#202)', file: 'b.txt', content: 'b\n' },
    ]);

  it('reverts the member commits, requeues it as full-cycle with evidence, and re-runs the suite', () => {
    const { repo, base } = twoMembers();
    const state = batchState([201, 202, 203]);
    const h = harness({ exec: createExecFn(60_000), suite: { ok: true, failing: [] } });
    h.deps.repoDir = repo;
    const tests = [failingTest('a.test.ts', 'a fails')];

    const result = evictMembers(
      state,
      'b1',
      {
        issues: [201],
        reason: 'suite-red',
        attribution: 'overlap',
        ranges: rangesOf(repo, base),
        failingByMember: new Map([[201, tests]]),
      },
      h.deps
    );

    expect(result.conflict).toBe(false);
    expect(result.evicted).toEqual([201]);
    expect(result.requeued).toEqual([201]);
    expect(result.reverted).toHaveLength(1);
    // The member's file is really gone from the batch checkout; the other
    // member's work is untouched.
    expect(fs.existsSync(path.join(repo, 'a.txt'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'b.txt'))).toBe(true);

    const entry = findEntry(result.state, 201);
    expect(entry?.status).toBe('requeued');
    expect(entry?.mode).toBe('full');
    expect(entry?.batch).toBeNull();
    expect(entry?.failure_evidence).toEqual({
      batch: 'b1',
      reason: 'suite-red',
      failing_tests: ['a.test.ts::a fails'],
      attribution: 'overlap',
      reverted_commits: result.reverted,
      at: NOW.toISOString(),
    });
    // the suite re-ran and the batch is back in validating
    expect(h.suiteRuns).toBe(1);
    expect(result.suite).toEqual({ ok: true, failing: [] });
    expect(findBatch(result.state, 'b1')?.status).toBe('validating');
    expect(findBatch(result.state, 'b1')?.evictions).toHaveLength(1);
  });

  it('evicts an eviction group together', () => {
    const { repo, base } = twoMembers();
    const state = batchState([201, 202, 203, 204], 'attributing', { groups: [[201, 202]] });
    const h = harness({ exec: createExecFn(60_000) });
    h.deps.repoDir = repo;

    const result = evictMembers(
      state,
      'b1',
      { issues: [201], reason: 'suite-red', attribution: 'bisect', ranges: rangesOf(repo, base) },
      h.deps
    );

    expect(result.evicted).toEqual([201, 202]);
    expect(fs.existsSync(path.join(repo, 'a.txt'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'b.txt'))).toBe(false);
    expect(findEntry(result.state, 202)?.status).toBe('requeued');
    const record = findBatch(result.state, 'b1')?.evictions.find((e) => e.issue === 201);
    expect(record?.group).toEqual([202]);
  });

  it('posts a batch milestone naming the reason and the evicted members', () => {
    const { repo, base } = twoMembers();
    const state = batchState([201, 202, 203]);
    const h = harness({ exec: createExecFn(60_000) });
    h.deps.repoDir = repo;

    evictMembers(
      state,
      'b1',
      { issues: [201], reason: 'suite-red', attribution: 'overlap', ranges: rangesOf(repo, base) },
      h.deps
    );

    expect(h.milestones).toHaveLength(1);
    expect(h.milestones[0].anchor).toBe(900);
    expect(h.milestones[0].run).toBe('r-900-aaaa');
    expect(h.milestones[0].milestone.phase).toBe('batch-validate');
    expect(h.milestones[0].milestone.status).toBe('blocked');
    expect(h.milestones[0].milestone.kv).toMatchObject({
      reason: 'suite-red',
      evicted: '201',
      requeued: '201',
      attribution: 'overlap',
    });
    expect(eventNames(h.events)).toContain('member-evicted');
  });

  it('dissolves instead of half-reverting when a revert conflicts', () => {
    // Both members rewrite the same line, so reverting the first conflicts.
    const { repo, base } = scratchRepo([
      { subject: 'feat: a (#201)', file: 'shared.txt', content: 'a\n' },
      { subject: 'feat: b (#202)', file: 'shared.txt', content: 'b\n' },
    ]);
    const state = batchState([201, 202]);
    const h = harness({ exec: createExecFn(60_000) });
    h.deps.repoDir = repo;

    const result = evictMembers(
      state,
      'b1',
      { issues: [201], reason: 'suite-red', attribution: 'overlap', ranges: rangesOf(repo, base) },
      h.deps
    );

    expect(result.conflict).toBe(true);
    expect(result.dissolved).toBe(true);
    expect(findBatch(result.state, 'b1')?.status).toBe('dissolved');
    expect(result.requeued.sort()).toEqual([201, 202]);
    // the worktree is left clean — no half-applied revert
    expect(git(['status', '--porcelain'], repo).trim()).toBe('');
    expect(eventNames(h.events)).toContain('revert-conflict');
    expect(h.milestones.at(-1)?.milestone.kv).toMatchObject({ reason: 'revert-conflict' });
  });

  it('dissolves once more than a third of the members are evicted', () => {
    const { repo, base } = twoMembers();
    // 2 of 3 evicted (an eviction group) is over the ⅓ threshold.
    const state = batchState([201, 202, 203], 'attributing', { groups: [[201, 202]] });
    const h = harness({ exec: createExecFn(60_000) });
    h.deps.repoDir = repo;

    const result = evictMembers(
      state,
      'b1',
      { issues: [201], reason: 'suite-red', attribution: 'overlap', ranges: rangesOf(repo, base) },
      h.deps
    );

    expect(result.dissolved).toBe(true);
    expect(findBatch(result.state, 'b1')?.status).toBe('dissolved');
    // the survivor is requeued as full-cycle, not discarded
    expect(findEntry(result.state, 203)?.mode).toBe('full');
    expect(findEntry(result.state, 203)?.status).toBe('requeued');
    expect(eventNames(h.events)).toContain('batch-dissolved');
  });

  it('refuses to revert a sha that is not a sha', () => {
    const state = batchState([201, 202]);
    const calls: string[][] = [];
    const h = harness({
      exec: (file, args) => {
        calls.push([file, ...args]);
        return '';
      },
    });
    const result = evictMembers(
      state,
      'b1',
      {
        issues: [201],
        reason: 'suite-red',
        attribution: 'overlap',
        ranges: [{ issue: 201, from: '--exec=pwn', to: '--exec=pwn', commits: ['--exec=pwn'] }],
      },
      h.deps
    );
    expect(result.conflict).toBe(true);
    expect(calls.some((c) => c.includes('revert'))).toBe(false);
  });
});

describe('checkDissolveTrigger', () => {
  const batchWith = (members: number[], evicted: number[]) => ({
    ...(findBatch(batchState(members), 'b1') as NonNullable<ReturnType<typeof findBatch>>),
    evictions: evicted.map((issue) => ({
      issue,
      reason: 'suite-red',
      attribution: 'overlap' as const,
      reverted_commits: [],
      group: [],
      at: NOW.toISOString(),
    })),
  });

  it('is strictly more than a third, not at least', () => {
    expect(checkDissolveTrigger(batchWith([201, 202, 203], [201]))).toBe(false); // exactly ⅓
    expect(checkDissolveTrigger(batchWith([201, 202, 203], [201, 202]))).toBe(true);
    expect(checkDissolveTrigger(batchWith([201, 202, 203, 204], [201, 202]))).toBe(true);
  });

  it('counts each member once however often it was recorded', () => {
    expect(checkDissolveTrigger(batchWith([201, 202, 203], [201, 201]))).toBe(false);
  });
});

describe('expandEvictionGroups', () => {
  it('pulls in every transitively grouped member', () => {
    const batch = findBatch(
      batchState([201, 202, 203, 204], 'attributing', {
        groups: [
          [201, 202],
          [202, 203],
        ],
      }),
      'b1'
    );
    expect(expandEvictionGroups(batch as NonNullable<typeof batch>, [201])).toEqual([
      201, 202, 203,
    ]);
  });

  it('leaves an ungrouped member alone', () => {
    const batch = findBatch(batchState([201, 202], 'attributing', { groups: [] }), 'b1');
    expect(expandEvictionGroups(batch as NonNullable<typeof batch>, [201])).toEqual([201]);
  });
});

// --- AC3: dissolve ---

describe('dissolveBatch', () => {
  it('preserves shipped members and requeues only the unshipped ones', () => {
    let state = batchState([201, 202, 203], 'validating');
    state = transitionIssue(state, 201, 'validated', {}, NOW);
    state = transitionIssue(state, 201, 'shipped-in-batch', {}, NOW);
    const h = harness();

    const result = dissolveBatch(state, 'b1', { strategy: 'full', reason: 'operator' }, h.deps);

    expect(result.preserved).toEqual([201]);
    expect(result.requeued).toEqual([202, 203]);
    expect(findEntry(result.state, 201)?.status).toBe('shipped-in-batch');
    expect(findEntry(result.state, 202)?.mode).toBe('full');
    expect(findEntry(result.state, 202)?.batch).toBeNull();
    expect(findBatch(result.state, 'b1')?.status).toBe('dissolved');
  });

  it('splits into two forming half-batches, retagging the entries', () => {
    const state = batchState([201, 202, 203], 'validating');
    const h = harness();

    const result = dissolveBatch(
      state,
      'b1',
      { strategy: 'halved', reason: 'pr-conflict-recurred' },
      h.deps
    );

    expect(result.newBatches).toEqual(['b1-a', 'b1-b']);
    expect(findBatch(result.state, 'b1-a')?.members).toEqual([201, 202]);
    expect(findBatch(result.state, 'b1-b')?.members).toEqual([203]);
    expect(findBatch(result.state, 'b1-a')?.status).toBe('forming');
    expect(findBatch(result.state, 'b1-a')?.anchor).toBe(900);
    expect(findBatch(result.state, 'b1-a')?.base_branch).toBe('main');

    expect(findEntry(result.state, 201)?.mode).toBe('slot');
    expect(findEntry(result.state, 201)?.batch).toBe('b1-a');
    expect(findEntry(result.state, 203)?.batch).toBe('b1-b');
    expect(eventNames(h.events)).toContain('batch-split');
  });

  it('keeps an eviction group only when it survives the split intact', () => {
    const state = batchState([201, 202, 203, 204], 'validating', {
      groups: [
        [201, 202],
        [202, 203],
      ],
    });
    const h = harness();
    const result = dissolveBatch(state, 'b1', { strategy: 'halved', reason: 'x' }, h.deps);

    // [201,202] lands wholly in the first half; [202,203] is split and drops.
    expect(findBatch(result.state, 'b1-a')?.eviction_groups).toEqual([[201, 202]]);
    expect(findBatch(result.state, 'b1-b')?.eviction_groups).toEqual([]);
  });

  it('creates a single half-batch when only one member is left', () => {
    const state = batchState([201], 'validating');
    const h = harness();
    const result = dissolveBatch(state, 'b1', { strategy: 'halved', reason: 'x' }, h.deps);
    expect(result.newBatches).toEqual(['b1-a']);
    expect(findEntry(result.state, 201)?.batch).toBe('b1-a');
  });

  it('reports what was preserved on the milestone', () => {
    let state = batchState([201, 202, 203], 'validating');
    state = transitionIssue(state, 201, 'validated', {}, NOW);
    state = transitionIssue(state, 201, 'shipped-in-batch', {}, NOW);
    const h = harness();

    dissolveBatch(state, 'b1', { strategy: 'full', reason: 'eviction-threshold' }, h.deps);

    expect(h.milestones.at(-1)?.milestone.kv).toMatchObject({
      reason: 'eviction-threshold',
      dissolved: 'true',
      strategy: 'full',
      requeued: '202,203',
      preserved: '201',
    });
  });

  it('refuses to dissolve a batch that is already dissolved', () => {
    const state = batchState([201], 'validating');
    const h = harness();
    const once = dissolveBatch(state, 'b1', { strategy: 'full', reason: 'x' }, h.deps);
    expect(() =>
      dissolveBatch(once.state, 'b1', { strategy: 'full', reason: 'x' }, h.deps)
    ).toThrow(/already dissolved/);
  });
});

// --- AC4: the batch PR conflict path ---

describe('handlePrConflict', () => {
  it('rebases, re-runs the suite and re-ships on the first occurrence', () => {
    const state = batchState([201, 202], 'awaiting-merge');
    const calls: string[][] = [];
    const h = harness({
      exec: (file, args) => {
        calls.push([file, ...args]);
        return '';
      },
    });

    const result = handlePrConflict(state, 'b1', h.deps);

    expect(result.action).toBe('reship');
    expect(result.rebased).toBe(true);
    expect(h.suiteRuns).toBe(1);
    expect(findBatch(result.state, 'b1')?.status).toBe('shipping');
    expect(findBatch(result.state, 'b1')?.rebase_attempts).toBe(1);
    expect(calls).toContainEqual(['git', 'rebase', 'origin/main']);
    expect(eventNames(h.events)).toContain('batch-rebased');
  });

  it('dissolves into halves on the second occurrence, without rebasing again', () => {
    const state = batchState([201, 202, 203], 'awaiting-merge');
    const calls: string[][] = [];
    const h = harness({
      exec: (file, args) => {
        calls.push([file, ...args]);
        return '';
      },
    });

    const first = handlePrConflict(state, 'b1', h.deps);
    // the re-shipped PR lands back on awaiting-merge, still conflicting
    const reshipped = transitionBatch(first.state, 'b1', 'awaiting-merge', {}, NOW);
    calls.length = 0;
    const second = handlePrConflict(reshipped, 'b1', h.deps);

    expect(second.action).toBe('dissolved');
    expect(second.dissolve?.newBatches).toEqual(['b1-a', 'b1-b']);
    expect(calls.some((c) => c.includes('rebase'))).toBe(false);
    expect(h.milestones.at(-1)?.milestone.phase).toBe('batch-ship');
    expect(h.milestones.at(-1)?.milestone.kv).toMatchObject({ reason: 'pr-conflict-recurred' });
  });

  it('aborts and dissolves when the rebase itself conflicts', () => {
    const calls: string[][] = [];
    const h = harness({
      exec: (file, args) => {
        calls.push([file, ...args]);
        return args[0] === 'rebase' && args[1] !== '--abort' ? null : '';
      },
    });
    const result = handlePrConflict(batchState([201, 202], 'awaiting-merge'), 'b1', h.deps);

    expect(result.action).toBe('dissolved');
    expect(result.rebased).toBe(false);
    expect(calls).toContainEqual(['git', 'rebase', '--abort']);
    expect(h.milestones.at(-1)?.milestone.kv).toMatchObject({ reason: 'rebase-conflict' });
  });

  it('dissolves when the suite is red after a clean rebase', () => {
    const h = harness({ suite: { ok: false, failing: [failingTest('a.test.ts', 'a')] } });
    const result = handlePrConflict(batchState([201, 202], 'awaiting-merge'), 'b1', h.deps);

    expect(result.action).toBe('dissolved');
    expect(result.rebased).toBe(true);
    expect(h.milestones.at(-1)?.milestone.kv).toMatchObject({ reason: 'rebase-suite-red' });
  });

  it('refuses a base branch that is not a ref name', () => {
    let state = batchState([201], 'awaiting-merge');
    state = {
      ...state,
      batches: state.batches.map((b) => ({ ...b, base_branch: '--upload-pack=pwn' })),
    };
    const calls: string[][] = [];
    const h = harness({
      exec: (file, args) => {
        calls.push([file, ...args]);
        return '';
      },
    });
    const result = handlePrConflict(state, 'b1', h.deps);

    expect(result.action).toBe('dissolved');
    expect(calls.some((c) => c.includes('rebase'))).toBe(false);
    expect(h.milestones.at(-1)?.milestone.kv).toMatchObject({ reason: 'invalid-base-branch' });
  });
});

// --- AC5: milestone posting ---

describe('createExecMilestonePoster', () => {
  it('shells the runstate CLI with the phase, status and reason keys', () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const poster = createExecMilestonePoster(
      (file, args) => {
        calls.push({ file, args });
        return '';
      },
      { repoDir: '/repo' }
    );

    const ok = poster(900, 'r-900-aaaa', {
      phase: 'batch-validate',
      status: 'blocked',
      kv: { reason: 'suite red', evicted: '201,202' },
    });

    expect(ok).toBe(true);
    expect(calls[0].file).toBe('ai-dossier');
    expect(calls[0].args).toEqual([
      'runstate',
      'post',
      '--issue',
      '900',
      '--phase',
      'batch-validate',
      '--status',
      'blocked',
      '--run',
      'r-900-aaaa',
      // values carry no spaces — the dossier milestone rule
      '--kv',
      'reason=suite-red',
      '--kv',
      'evicted=201,202',
    ]);
  });

  it('reports a failed post rather than throwing', () => {
    const poster = createExecMilestonePoster(() => null);
    expect(poster(900, null, { phase: 'batch-ship', status: 'blocked', kv: {} })).toBe(false);
  });

  it('journals a failed post during an eviction', () => {
    const { repo, base } = scratchRepo([
      { subject: 'feat: a (#201)', file: 'a.txt', content: 'a\n' },
    ]);
    const h = harness({ exec: createExecFn(60_000), postOk: false });
    h.deps.repoDir = repo;
    evictMembers(
      batchState([201, 202, 203]),
      'b1',
      { issues: [201], reason: 'suite-red', attribution: 'overlap', ranges: rangesOf(repo, base) },
      h.deps
    );
    expect(eventNames(h.events)).toContain('milestone-post-failed');
  });

  it('skips posting when the batch has no anchor', () => {
    const state = batchState([201, 202, 203], 'validating', { anchor: undefined });
    const anchorless = {
      ...state,
      batches: state.batches.map((b) => ({ ...b, anchor: null })),
    };
    const h = harness();
    dissolveBatch(anchorless, 'b1', { strategy: 'full', reason: 'x' }, h.deps);
    expect(h.milestones).toEqual([]);
    expect(eventNames(h.events)).toContain('batch-dissolved');
  });
});
