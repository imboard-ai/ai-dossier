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
  IllegalTransitionError,
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
  validateState,
} from '../index';
import { recording } from './helpers/recording-exec';

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
  milestones: Array<{ anchor: number; run: string; milestone: BatchMilestone }>;
  suiteRuns: number;
}

function harness(
  opts: { exec?: ExecFn; suite?: SuiteResult | null; postOk?: boolean } = {}
): Harness {
  const events: JournalEvent[] = [];
  const milestones: Array<{ anchor: number; run: string; milestone: BatchMilestone }> = [];
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

/**
 * A scripted git for the bisect path: the test command DISCRIMINATES — it fails
 * while the checkout is detached at `badSha` and passes at the good end, which
 * is what `runAttributionBisect` demands before it will trust a bisect at all.
 */
function bisectScript(badSha: string, runOutput: string): ExecFn {
  let at = 'branch';
  return (file, args) => {
    if (file !== 'git') return at === 'bad' ? null : '';
    if (args[0] === 'symbolic-ref') return 'feature/batch';
    // The completed bisect leaves refs/bisect/bad at the first bad commit —
    // this is what the implementation reads, in preference to git's prose.
    if (args[0] === 'rev-parse') {
      return args.includes('refs/bisect/bad') ? badSha : 'f'.repeat(40);
    }
    if (args[0] === 'checkout') {
      at = args.includes(badSha) ? 'bad' : 'good';
      return '';
    }
    if (args[0] === 'bisect' && args[1] === 'run') return runOutput;
    return '';
  };
}

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
    const h = harness({ exec: bisectScript(badSha, `${badSha} is the first bad commit\n`) });
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
    const h = harness({ exec: bisectScript(badSha, `${badSha} is the first bad commit\n`) });
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

  // #503 finding 3 (superseded #472 review, carried into #498's implementation):
  // a red suite with zero parseable failures must not look identical to a
  // green one in the journal — `suite-failed`/`attributed` are both emitted
  // (never silently skipped) and the detail line says explicitly that
  // nothing could be read out of the report, so an operator (or, once
  // recovery is wired into tick() — out of scope here per the issue's
  // Non-goals — a future decision-pending router) can tell the two apart.
  it('journals an explicit empty-report detail when the suite reports zero failing tests', () => {
    const state = batchState([201, 202], 'validating');
    const h = harness();
    const result = beginAttribution(state, 'b1', { failing: [], footprints: [] }, h.deps);

    expect(result.outcome.offenders).toEqual([]);
    expect(result.outcome.method).toBe('none');
    expect(eventNames(h.events)).toEqual(['suite-failed', 'attributed']);
    const suiteFailed = h.events.find((e) => e.event === 'suite-failed');
    expect(suiteFailed?.detail).toMatch(/0 failing.*nothing to attribute/);
    const attributed = h.events.find((e) => e.event === 'attributed');
    expect(attributed?.detail).toMatch(/method=none offenders=none/);
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
        ranges: [
          {
            issue: 201,
            from: '--exec=pwn',
            to: '--exec=pwn',
            commits: ['--exec=pwn'],
            positions: [0],
          },
        ],
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
    // An illegal edge, not a missing batch: a caller catching SchedNotFoundError
    // to mean "unknown batch id" must not swallow this.
    expect(() =>
      dissolveBatch(once.state, 'b1', { strategy: 'full', reason: 'x' }, h.deps)
    ).toThrow(IllegalTransitionError);
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
    const { exec, calls } = recording(() => '');
    const poster = createExecMilestonePoster(exec, { repoDir: '/repo' });

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

describe('eviction integrity (regressions)', () => {
  it('reverts newest-first ACROSS members when their commits interleave', () => {
    // A1 B1 A2 B2 on one branch. Reverting member-by-member (B2,B1,A2,A1)
    // tries to revert B1 while A2 still sits on top of it — which is how a
    // clean eviction turns into a conflict and dissolves the whole batch.
    const { repo, base } = scratchRepo([
      { subject: 'feat: a1 (#201)', file: 'a1.txt', content: 'a1\n' },
      { subject: 'feat: b1 (#202)', file: 'b1.txt', content: 'b1\n' },
      { subject: 'feat: a2 (#201)', file: 'a2.txt', content: 'a2\n' },
      { subject: 'feat: b2 (#202)', file: 'b2.txt', content: 'b2\n' },
    ]);
    const ranges = rangesOf(repo, base);
    const calls: string[][] = [];
    const real = createExecFn(60_000);
    const h = harness({
      exec: (file, args, cwd) => {
        if (file === 'git' && args[0] === 'revert' && args[1] === '--no-edit')
          calls.push([...args]);
        return real(file, args, cwd);
      },
    });
    h.deps.repoDir = repo;

    const byPosition = ranges.flatMap((r) =>
      r.commits.map((sha, i) => ({ sha, p: r.positions[i] }))
    );
    const expected = [...byPosition].sort((x, y) => y.p - x.p).map((c) => c.sha);

    const result = evictMembers(
      state4(),
      'b1',
      { issues: [201, 202], reason: 'suite-red', attribution: 'overlap', ranges },
      h.deps
    );

    expect(result.conflict).toBe(false);
    expect(calls.map((c) => c[2])).toEqual(expected);
    // every evicted file is gone, none of the base survives changed
    for (const f of ['a1.txt', 'a2.txt', 'b1.txt', 'b2.txt']) {
      expect(fs.existsSync(path.join(repo, f))).toBe(false);
    }
  });

  it('dissolves instead of reverting when an eviction group pulls in a shipped member', () => {
    // 202 already shipped: reverting its commits would destroy merged work
    // while requeueMember (rightly) refuses to put it back on the queue.
    const { repo, base } = scratchRepo([
      { subject: 'feat: a (#201)', file: 'a.txt', content: 'a\n' },
      { subject: 'feat: b (#202)', file: 'b.txt', content: 'b\n' },
    ]);
    let state = batchState([201, 202, 203], 'attributing', { groups: [[201, 202]] });
    state = transitionIssue(state, 202, 'validated', {}, NOW);
    state = transitionIssue(state, 202, 'shipped-in-batch', {}, NOW);
    const h = harness({ exec: createExecFn(60_000) });
    h.deps.repoDir = repo;

    const result = evictMembers(
      state,
      'b1',
      { issues: [201], reason: 'suite-red', attribution: 'overlap', ranges: rangesOf(repo, base) },
      h.deps
    );

    expect(result.dissolved).toBe(true);
    expect(result.reverted).toEqual([]);
    // the shipped member keeps both its status and its code
    expect(findEntry(result.state, 202)?.status).toBe('shipped-in-batch');
    expect(fs.existsSync(path.join(repo, 'b.txt'))).toBe(true);
    expect(h.milestones.at(-1)?.milestone.kv).toMatchObject({ reason: 'evicts-shipped-member' });
  });

  it('does not re-revert a commit the branch already reverted', () => {
    const { repo, base } = scratchRepo([
      { subject: 'feat: a (#201)', file: 'a.txt', content: 'a\n' },
    ]);
    const ranges = rangesOf(repo, base);
    const h = harness({ exec: createExecFn(60_000) });
    h.deps.repoDir = repo;
    const input = {
      issues: [201],
      reason: 'suite-red',
      attribution: 'overlap' as const,
      ranges,
    };

    evictMembers(batchState([201, 202, 203]), 'b1', input, h.deps);
    const afterFirst = git(['rev-parse', 'HEAD'], repo).trim();
    // A crash between the revert and the state save: the same eviction re-runs.
    const second = evictMembers(batchState([201, 202, 203]), 'b1', input, h.deps);

    expect(second.conflict).toBe(false);
    // no second revert commit — a double revert would re-apply the broken change
    expect(git(['rev-parse', 'HEAD'], repo).trim()).toBe(afterFirst);
    expect(fs.existsSync(path.join(repo, 'a.txt'))).toBe(false);
  });

  it('treats a suite runner that throws as a red suite instead of losing the eviction', () => {
    const { repo, base } = scratchRepo([
      { subject: 'feat: a (#201)', file: 'a.txt', content: 'a\n' },
    ]);
    const h = harness({ exec: createExecFn(60_000) });
    h.deps.repoDir = repo;
    h.deps.runSuite = () => {
      throw new Error('vitest binary missing');
    };

    const result = evictMembers(
      batchState([201, 202, 203]),
      'b1',
      { issues: [201], reason: 'suite-red', attribution: 'overlap', ranges: rangesOf(repo, base) },
      h.deps
    );

    // the eviction survives: state advanced, entry requeued, evidence recorded
    expect(result.suite).toMatchObject({ ok: false });
    expect(result.requeued).toEqual([201]);
    expect(findEntry(result.state, 201)?.status).toBe('requeued');
    expect(h.events.some((e) => e.detail?.includes('vitest binary missing'))).toBe(true);
  });

  it('names the member whose commits were not found on the branch', () => {
    const h = harness();
    const result = evictMembers(
      batchState([201, 202, 203]),
      'b1',
      { issues: [201], reason: 'suite-red', attribution: 'overlap', ranges: [] },
      h.deps
    );
    expect(result.reverted).toEqual([]);
    expect(h.milestones.at(-1)?.milestone.kv).toMatchObject({ no_commits: '201' });
    expect(h.events.some((e) => e.detail?.includes('was NOT reverted'))).toBe(true);
  });

  it('ignores an eviction group member that is not in the batch', () => {
    const batch = findBatch(batchState([201, 202]), 'b1');
    // 999 is not a member: counting it would trip the dissolve threshold early.
    const withStray = { ...(batch as NonNullable<typeof batch>), eviction_groups: [[201, 999]] };
    expect(expandEvictionGroups(withStray, [201])).toEqual([201]);
  });
});

/** A four-member batch (the interleaved-revert fixture needs 201 and 202 evictable). */
function state4(): SchedState {
  return batchState([201, 202, 203, 204]);
}

describe('milestone posting gaps (regressions)', () => {
  it('journals the milestone it could not post when the batch has no run id', () => {
    const state = batchState([201, 202, 203], 'validating');
    const runless = { ...state, batches: state.batches.map((b) => ({ ...b, run_id: null })) };
    const h = harness();
    dissolveBatch(runless, 'b1', { strategy: 'full', reason: 'x' }, h.deps);

    expect(h.milestones).toEqual([]);
    const failed = h.events.find((e) => e.event === 'milestone-post-failed');
    expect(failed?.detail).toMatch(/no run id/);
    // the keys are in the journal line, so the post can be reconstructed
    expect(failed?.detail).toMatch(/reason=x/);
  });

  it('passes the run id to the poster as a plain string', () => {
    const calls: string[][] = [];
    const poster = createExecMilestonePoster((file, args) => {
      calls.push([file, ...args]);
      return '';
    });
    poster(900, 'r-900-aaaa', { phase: 'batch-ship', status: 'awaiting-merge', kv: {} });
    expect(calls[0]).toContain('--run');
    expect(calls[0]).toContain('r-900-aaaa');
  });
});

describe('PR conflict integrity (regressions)', () => {
  it('reports a re-ship as awaiting-merge, not blocked', () => {
    // `blocked` would stamp next=done on a run that is still going and count
    // toward the runstate resume-loop cap.
    const h = harness();
    handlePrConflict(batchState([201, 202], 'awaiting-merge'), 'b1', h.deps);
    expect(h.milestones.at(-1)?.milestone.status).toBe('awaiting-merge');
    expect(h.milestones.at(-1)?.milestone.phase).toBe('batch-ship');
  });

  it('is idempotent when the batch is already rebasing', () => {
    const state = batchState([201, 202], 'awaiting-merge');
    const rebasing = transitionBatch(state, 'b1', 'rebasing', {}, NOW);
    const h = harness();
    expect(() => handlePrConflict(rebasing, 'b1', h.deps)).not.toThrow();
  });

  it('dissolves with fetch-failed when the fetch fails, not rebase-conflict', () => {
    const h = harness({
      exec: (file, args) => (file === 'git' && args[0] === 'fetch' ? null : ''),
    });
    const result = handlePrConflict(batchState([201, 202], 'awaiting-merge'), 'b1', h.deps);
    expect(result.action).toBe('dissolved');
    expect(h.milestones.at(-1)?.milestone.kv).toMatchObject({ reason: 'fetch-failed' });
  });

  it('refuses to rebase when the checkout is not on the batch branch', () => {
    const state = batchState([201, 202], 'awaiting-merge');
    const withBranch = {
      ...state,
      batches: state.batches.map((b) => ({ ...b, branch: 'feature/batch-b1' })),
    };
    const calls: string[][] = [];
    const h = harness({
      exec: (file, args) => {
        calls.push([file, ...args]);
        return args[0] === 'symbolic-ref' ? 'some/other-branch' : '';
      },
    });
    const result = handlePrConflict(withBranch, 'b1', h.deps);

    expect(result.action).toBe('dissolved');
    expect(calls.some((c) => c.includes('rebase'))).toBe(false);
    expect(h.milestones.at(-1)?.milestone.kv).toMatchObject({ reason: 'wrong-branch-checked-out' });
  });
});

describe('halved dissolve integrity (regressions)', () => {
  it('does not mint a half-batch id that already exists', () => {
    let state = batchState([201, 202, 203], 'validating');
    // Something already owns `b1-a` — reusing it would make state.json
    // unloadable (validateState rejects duplicate batch ids).
    state = enqueueEntries(state, [{ issue: 301, mode: 'slot', batch: 'b1-a' }], NOW);
    const h = harness();

    const result = dissolveBatch(state, 'b1', { strategy: 'halved', reason: 'x' }, h.deps);

    expect(result.newBatches).not.toContain('b1-a');
    expect(new Set(result.state.batches.map((b) => b.id)).size).toBe(result.state.batches.length);
    expect(() => validateState(result.state)).not.toThrow();
  });

  it('leaves half-batch members able to re-enter the batch rail', () => {
    const h = harness();
    const result = dissolveBatch(
      batchState([201, 202, 203], 'validating'),
      'b1',
      { strategy: 'halved', reason: 'x' },
      h.deps
    );
    for (const issue of [201, 202, 203]) {
      expect(() => transitionIssue(result.state, issue, 'batched', {}, NOW)).not.toThrow();
    }
  });

  it('carries failure evidence onto every dissolve-requeued member', () => {
    const h = harness();
    const result = dissolveBatch(
      batchState([201, 202], 'validating'),
      'b1',
      { strategy: 'full', reason: 'eviction-threshold' },
      h.deps
    );
    expect(findEntry(result.state, 201)?.failure_evidence).toMatchObject({
      batch: 'b1',
      reason: 'eviction-threshold',
      attribution: 'none',
    });
  });

  it('journals which members were requeued and preserved, not just how many', () => {
    let state = batchState([201, 202, 203], 'validating');
    state = transitionIssue(state, 201, 'validated', {}, NOW);
    state = transitionIssue(state, 201, 'shipped-in-batch', {}, NOW);
    const h = harness();
    dissolveBatch(state, 'b1', { strategy: 'full', reason: 'x' }, h.deps);

    const dissolved = h.events.find((e) => e.event === 'batch-dissolved');
    expect(dissolved?.detail).toContain('requeued=202,203');
    expect(dissolved?.detail).toContain('preserved=201');
  });
});
