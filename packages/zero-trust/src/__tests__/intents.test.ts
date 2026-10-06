import { spawn } from 'node:child_process';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  engagementMarker,
  type Intent,
  IntentDriver,
  IntentError,
  type IntentInput,
  idempotencyKey,
  MutationUncertainError,
  OPERATION_KINDS,
  parseEngagementMarker,
  type ReconcileResult,
  replayIntents,
  type WriteAdapter,
  WriteBlockedError,
} from '../intents';
import { Journal, JournalError } from '../journal';
import { createRun, ReasonCode, RUN_STATES, type RunRecord, transitionRun } from '../state';

const timestamp = '2026-10-05T00:00:00.000Z';
const gating = createRun(
  { runId: 'run-1', contributor: 'alice', upstreamIssue: 'https://github.com/o/r/issues/1' },
  timestamp
);
function advance(initial: RunRecord, ...reasons: ReasonCode[]): RunRecord {
  return reasons.reduce((current, reason) => transitionRun(current, reason, timestamp), initial);
}
const run = advance(
  gating,
  ReasonCode.GatePassed,
  ReasonCode.PlanApproved,
  ReasonCode.CandidateReady,
  ReasonCode.VerificationPassed
);
const sha = 'a'.repeat(40);
const input: IntentInput = {
  contributionId: 'c-1',
  target: 'o/r/pulls',
  operationKind: 'pr_create',
  candidateSha: sha,
};
const dirs: string[] = [];
const journals: Journal[] = [];
function directory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-intents-'));
  dirs.push(dir);
  return dir;
}
function journal(dir = directory()): Journal {
  const j = new Journal(dir);
  journals.push(j);
  return j;
}
function driver(j: Journal, adapter: WriteAdapter, current = run): IntentDriver {
  return new IntentDriver(j, adapter, { run: current, contributionId: 'c-1' }, () => timestamp);
}
class FakeAdapter implements WriteAdapter {
  readonly artifacts = new Map<string, { artifactRef: string; remoteSha?: string }>();
  writes = 0;
  reads = 0;
  mode: 'success' | 'lost' | 'fail' = 'success';
  observation: ReconcileResult | undefined;
  async mutate(intent: Intent) {
    this.writes++;
    if (this.mode === 'fail') throw new Error('synthetic private provider error');
    const artifact = {
      artifactRef: `artifact-${this.writes}`,
      ...(intent.operationKind === 'push_branch'
        ? { remoteSha: intent.candidateSha as string }
        : {}),
    };
    this.artifacts.set(intent.key, artifact);
    if (this.mode === 'lost') throw new Error('response lost');
    return artifact;
  }
  async reconcile(intent: Intent): Promise<ReconcileResult> {
    this.reads++;
    if (this.observation) return this.observation;
    const artifact = this.artifacts.get(intent.key);
    return artifact ? { kind: 'found', ...artifact } : { kind: 'absent' };
  }
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const j of journals.splice(0)) j.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('durable provider-independent write intents', () => {
  it('rejects credentials and snapshots getter-backed input/results once', async () => {
    const fake = new FakeAdapter();
    const j = journal();
    const d = driver(j, fake);
    const secret = `ghp_${'x'.repeat(36)}`;
    expect(() => d.execute({ ...input, target: secret })).toThrow();
    let kindReads = 0;
    const op = {
      ...input,
      get operationKind() {
        kindReads++;
        return kindReads === 1 ? ('pr_create' as const) : ('push_branch' as const);
      },
    };
    let refReads = 0;
    vi.spyOn(fake, 'mutate').mockResolvedValue({
      get artifactRef() {
        refReads++;
        return refReads === 1 ? 'safe' : secret;
      },
    });
    expect(await d.execute(op)).toBe('safe');
    expect(kindReads).toBe(1);
    expect(refReads).toBe(1);
    expect(fs.readFileSync(j.filePath, 'utf8')).not.toContain(secret);
  });
  it.each([
    'empty',
    'secret',
    'null',
    'getter',
  ] as const)('treats %s success evidence as ambiguous and reconciles without echoing it', async (mode) => {
    const fake = new FakeAdapter();
    const j = journal();
    const d = driver(j, fake);
    const secret = `ghp_${'x'.repeat(36)}`;
    vi.spyOn(fake, 'mutate').mockImplementation(async () => {
      if (mode === 'null') return null as unknown as { artifactRef: string };
      if (mode === 'getter')
        return {
          get artifactRef(): string {
            throw new Error(secret);
          },
        };
      return { artifactRef: mode === 'secret' ? secret : '' };
    });
    await expect(d.execute(input)).rejects.toThrow(MutationUncertainError);
    expect(d.snapshot().intents.get(idempotencyKey(input))?.status).toBe('ambiguous');
    expect(fs.readFileSync(j.filePath, 'utf8')).not.toContain(secret);
    fake.observation = { kind: 'found', artifactRef: 'observed' };
    expect(await d.execute(input)).toBe('observed');
  });
  it('snapshots reconciliation discriminator once and blocks throwing getters', async () => {
    const fake = new FakeAdapter();
    fake.mode = 'lost';
    const d = driver(journal(), fake);
    await expect(d.execute(input)).rejects.toThrow(MutationUncertainError);
    let reads = 0;
    vi.spyOn(fake, 'reconcile').mockResolvedValue({
      get kind() {
        reads++;
        return reads === 1 ? ('found' as const) : ('absent' as never);
      },
      artifactRef: 'observed',
    });
    expect(await d.execute(input)).toBe('observed');
    expect(reads).toBe(1);
    expect(fake.writes).toBe(1);
    const otherFake = new FakeAdapter();
    otherFake.mode = 'lost';
    const other = driver(journal(), otherFake);
    await expect(other.execute(input)).rejects.toThrow(MutationUncertainError);
    vi.spyOn(otherFake, 'reconcile').mockResolvedValue({
      get kind(): 'unknown' {
        throw new Error('private');
      },
    });
    await expect(other.resume()).rejects.toThrow(WriteBlockedError);
    expect(other.snapshot().run.state).toBe('blocked');
  });
  it('rejects terminal lifecycle writes even with a fresh journal', async () => {
    const terminal = transitionRun(run, ReasonCode.UserCancelled, timestamp);
    const d = new IntentDriver(
      journal(),
      new FakeAdapter(),
      { run: terminal, contributionId: 'c-1' },
      () => timestamp
    );
    await expect(d.execute(input)).rejects.toThrow(WriteBlockedError);
  });
  it('denies further admission even when the blocked transition clock fails', async () => {
    const fake = new FakeAdapter();
    fake.mode = 'lost';
    const d = new IntentDriver(journal(), fake, { run, contributionId: 'c-1' }, () => {
      throw new Error('clock unavailable');
    });
    await expect(d.execute(input)).rejects.toThrow(MutationUncertainError);
    fake.observation = { kind: 'unknown' };
    await expect(d.resume()).rejects.toThrow('clock unavailable');
    fake.observation = { kind: 'absent' };
    await expect(d.execute({ ...input, target: 'new' })).rejects.toThrow(WriteBlockedError);
    expect(fake.writes).toBe(1);
  });
  it('recovery binds all controller identities before constructing a writer', async () => {
    const dir = directory();
    const fake = new FakeAdapter();
    const j = journal(dir);
    await driver(j, fake).execute(input);
    j.close();
    const restoredJournal = journal(dir);
    for (const changed of [
      { run: createRun({ ...run, runId: 'other' }, timestamp), contributionId: 'c-1' },
      { run: createRun({ ...run, contributor: 'bob' }, timestamp), contributionId: 'c-1' },
      {
        run: createRun({ ...run, upstreamIssue: 'https://github.com/o/r/issues/2' }, timestamp),
        contributionId: 'c-1',
      },
      { run, contributionId: 'other' },
    ])
      expect(() => new IntentDriver(restoredJournal, fake, changed, () => timestamp)).toThrow(
        IntentError
      );
    expect(await driver(restoredJournal, fake).execute(input)).toBe('artifact-1');
    expect(fake.writes).toBe(1);
  });
  it.each(
    OPERATION_KINDS
  )('persists intended and attempted before %s and never duplicates confirmed writes', async (operationKind) => {
    const j = journal();
    const fake = new FakeAdapter();
    const mutate = vi.spyOn(fake, 'mutate').mockImplementation(async (intent) => {
      expect(replayIntents(j.read()).intents.get(intent.key)?.status).toBe('attempted');
      expect(j.read().map((e) => (e as { type: string }).type)).toEqual([
        'run',
        'intended',
        'attempted',
      ]);
      return { artifactRef: 'existing', remoteSha: sha };
    });
    const d = driver(j, fake, operationKind === 'engagement_comment' ? gating : run);
    const op = { ...input, operationKind };
    expect(await d.execute(op)).toBe('existing');
    expect(await d.execute(op)).toBe('existing');
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(replayIntents(j.read())).toEqual(d.snapshot());
  });
  it.each([
    'pr_create',
    'engagement_comment',
    'push_branch',
  ] as const)('lost %s response resumes without duplicate artifacts (11/16/18)', async (operationKind) => {
    const dir = directory();
    const fake = new FakeAdapter();
    fake.mode = 'lost';
    const j = journal(dir);
    const current = operationKind === 'engagement_comment' ? gating : run;
    const d = driver(j, fake, current);
    const op = {
      ...input,
      operationKind,
      candidateSha: operationKind === 'engagement_comment' ? null : sha,
    };
    await expect(d.execute(op)).rejects.toBeInstanceOf(MutationUncertainError);
    j.close();
    const restored = driver(journal(dir), fake, current);
    await restored.resume();
    expect(await restored.execute(op)).toBe('artifact-1');
    expect(fake.writes).toBe(1);
    expect(fake.reads).toBe(1);
    expect(restored.snapshot().intents.get(idempotencyKey(op))?.status).toBe('confirmed');
  });
  it('reconciles a lost comment via its hidden contribution marker', async () => {
    const comments: string[] = [];
    const adapter: WriteAdapter = {
      async mutate(i) {
        comments.push(`Request\n${engagementMarker(i.contributionId)}`);
        throw new Error('lost');
      },
      async reconcile(i) {
        return comments.some((c) => parseEngagementMarker(c) === i.contributionId)
          ? { kind: 'found', artifactRef: 'comment/1' }
          : { kind: 'absent' };
      },
    };
    const d = driver(journal(), adapter, gating);
    const op = { ...input, operationKind: 'engagement_comment' as const, candidateSha: null };
    await expect(d.execute(op)).rejects.toThrow(MutationUncertainError);
    expect(await d.execute(op)).toBe('comment/1');
    expect(comments).toHaveLength(1);
  });
  it('bounds an absent retry across repeated restarts', async () => {
    const dir = directory();
    const fake = new FakeAdapter();
    fake.mode = 'fail';
    let j = journal(dir);
    let d = driver(j, fake);
    await expect(d.execute(input)).rejects.toThrow(MutationUncertainError);
    j.close();
    j = journal(dir);
    d = driver(j, fake);
    await d.resume();
    await d.resume();
    await expect(d.execute(input)).rejects.toThrow(MutationUncertainError);
    j.close();
    j = journal(dir);
    d = driver(j, fake);
    await expect(d.resume()).rejects.toThrow(WriteBlockedError);
    expect(d.snapshot().run.state).toBe('blocked');
    expect(d.snapshot().blockedReason).toBe('retry_exhausted');
    expect(fake.writes).toBe(2);
    const blockedRun = d.snapshot().run;
    j.close();
    d = driver(journal(dir), fake, blockedRun);
    await expect(d.execute({ ...input, target: 'new' })).rejects.toThrow(WriteBlockedError);
    expect(fake.writes).toBe(2);
  });
  it('an absent result permits one successful retry', async () => {
    const fake = new FakeAdapter();
    fake.mode = 'fail';
    const d = driver(journal(), fake);
    await expect(d.execute(input)).rejects.toThrow(MutationUncertainError);
    fake.mode = 'success';
    expect(await d.execute(input)).toBe('artifact-2');
    expect(fake.reads).toBe(1);
    expect(fake.writes).toBe(2);
  });
  it.each([
    'unknown',
    'throw',
    'invalid',
    'bad-artifact',
  ] as const)('blocks all new writes on %s reconciliation', async (mode) => {
    const fake = new FakeAdapter();
    fake.mode = 'fail';
    const j = journal();
    const d = driver(j, fake);
    await expect(d.execute(input)).rejects.toThrow(MutationUncertainError);
    vi.spyOn(fake, 'reconcile').mockImplementation(async () => {
      if (mode === 'throw') throw new Error('private');
      if (mode === 'invalid') return { kind: 'nonsense' } as unknown as ReconcileResult;
      if (mode === 'bad-artifact') return { kind: 'found', artifactRef: '' };
      return { kind: 'unknown' };
    });
    await expect(d.execute({ ...input, target: 'new' })).rejects.toThrow(WriteBlockedError);
    expect(fake.writes).toBe(1);
    expect(replayIntents(j.read()).run.state).toBe('blocked');
  });
  it.each([
    'b'.repeat(40),
    undefined,
  ])('blocks push reconciliation without the expected remote SHA', async (remoteSha) => {
    const fake = new FakeAdapter();
    fake.mode = 'lost';
    const d = driver(journal(), fake);
    const op = { ...input, operationKind: 'push_branch' as const };
    await expect(d.execute(op)).rejects.toThrow(MutationUncertainError);
    fake.observation = { kind: 'found', artifactRef: 'branch', remoteSha };
    await expect(d.resume()).rejects.toThrow(WriteBlockedError);
    expect(fake.writes).toBe(1);
  });
  it('blocks an unexpected SHA even on a successful mutation response', async () => {
    const fake = new FakeAdapter();
    vi.spyOn(fake, 'mutate').mockResolvedValue({
      artifactRef: 'branch',
      remoteSha: 'b'.repeat(40),
    });
    const d = driver(journal(), fake);
    await expect(d.execute({ ...input, operationKind: 'push_branch' })).rejects.toThrow(
      WriteBlockedError
    );
    expect(d.snapshot().run.state).toBe('blocked');
    expect(d.snapshot().blockedReason).toBe('unexpected_remote_sha');
  });
  it('serializes same-key calls and snapshots caller input before awaiting', async () => {
    const fake = new FakeAdapter();
    const d = driver(journal(), fake);
    const mutable = { ...input };
    const first = d.execute(mutable);
    mutable.target = 'changed';
    expect(await Promise.all([first, d.execute(input), d.execute(input)])).toEqual([
      'artifact-1',
      'artifact-1',
      'artifact-1',
    ]);
    expect(fake.writes).toBe(1);
  });
  it('reconciles pending operations before admitting a different mutation', async () => {
    const fake = new FakeAdapter();
    fake.mode = 'lost';
    const d = driver(journal(), fake);
    await expect(d.execute(input)).rejects.toThrow(MutationUncertainError);
    fake.mode = 'success';
    const order: string[] = [];
    vi.spyOn(fake, 'reconcile').mockImplementation(async () => {
      order.push('reconcile');
      return { kind: 'found', artifactRef: 'old' };
    });
    vi.spyOn(fake, 'mutate').mockImplementation(async () => {
      order.push('mutate');
      return { artifactRef: 'new' };
    });
    await d.execute({ ...input, target: 'different' });
    expect(order).toEqual(['reconcile', 'mutate']);
  });
  it('replays seeded random operation sequences exactly', async () => {
    for (let seed = 1; seed <= 12; seed++) {
      let random = seed;
      const j = journal();
      const fake = new FakeAdapter();
      const d = driver(j, fake);
      for (let index = 0; index < 25; index++) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const kinds = OPERATION_KINDS.filter((kind) => kind !== 'engagement_comment');
        const operationKind = kinds[random % kinds.length] as IntentInput['operationKind'];
        const op = { ...input, target: `target-${index}`, operationKind };
        fake.mode = random % 3 === 0 ? 'lost' : 'success';
        try {
          await d.execute(op);
        } catch {
          await d.resume();
        }
        expect(replayIntents(j.read())).toEqual(d.snapshot());
      }
    }
  });
  it('rejects invalid kinds, SHAs, credentials, foreign contributions and resume identities', async () => {
    const j = journal();
    const fake = new FakeAdapter();
    const d = driver(j, fake);
    for (const patch of [
      { operationKind: 'delete' },
      { candidateSha: null },
      { candidateSha: 'short' },
      { target: '' },
      { contributionId: 'other' },
    ]) {
      try {
        await d.execute({ ...input, ...patch } as IntentInput);
        expect.fail('invalid input accepted');
      } catch (e) {
        expect(e).toBeInstanceOf(IntentError);
      }
    }
    expect(() => driver(j, fake)).toThrow(IntentError);
    expect(
      () =>
        new IntentDriver(
          j,
          fake,
          { run: createRun({ ...run, contributor: 'bob' }, timestamp), contributionId: 'c-1' },
          () => timestamp
        )
    ).toThrow(IntentError);
    expect(fake.writes).toBe(0);
    expect(idempotencyKey({ ...input, target: 'a,b' })).not.toBe(
      idempotencyKey({ ...input, contributionId: 'c-1,a', target: 'b' })
    );
  });
  it('rejects corrupted event histories, illegal edges and duplicate initializations', async () => {
    const j = journal();
    const d = driver(j, new FakeAdapter());
    await d.execute(input);
    const events = j.read();
    for (const bad of [
      [...events, events[0]],
      [events[0], { v: 1, type: 'confirmed', key: idempotencyKey(input), artifactRef: 'x' }],
      [events[0], { v: 2, type: 'intended', input }],
      [events[0], { v: 1, type: 'intended', input }, { v: 1, type: 'intended', input }],
    ])
      expect(() => replayIntents(bad)).toThrow(IntentError);
    expect(() => replayIntents([])).toThrow(IntentError);
    expect(() => replayIntents([null])).toThrow(IntentError);
  });
  it('replay refuses illegal transitions, push evidence and renewed retry budgets', () => {
    const start = { v: 1, type: 'run', run, contributionId: 'c-1' };
    const intended = { v: 1, type: 'intended', input };
    const key = idempotencyKey(input);
    const attempted = { v: 1, type: 'attempted', key };
    const absent = { v: 1, type: 'absent', key };
    const blocked = transitionRun(run, ReasonCode.PolicyBlocked, timestamp);
    for (const bad of [
      [start, intended, { v: 1, type: 'ambiguous', key }],
      [start, intended, { v: 1, type: 'absent', key }],
      [start, intended, { v: 1, type: 'confirmed', key, artifactRef: 'x' }],
      [start, intended, attempted, attempted],
      [start, intended, attempted, absent, attempted, absent],
      [start, intended, attempted, absent, attempted, { v: 1, type: 'unexpected', key }],
      [start, { v: 1, type: 'blocked', run: blocked, reason: 'unrecognized' }],
      [
        start,
        { v: 1, type: 'blocked', run: { ...blocked, contributor: 'bob' }, reason: 'unknown' },
      ],
      [start, { v: 1, type: 'blocked', run: blocked, reason: 'unknown' }, intended],
    ])
      expect(() => replayIntents(bad)).toThrow(IntentError);
    const push = { ...input, operationKind: 'push_branch' as const };
    const pushKey = idempotencyKey(push);
    expect(() =>
      replayIntents([
        start,
        { v: 1, type: 'intended', input: push },
        { v: 1, type: 'attempted', key: pushKey },
        { v: 1, type: 'confirmed', key: pushKey, artifactRef: 'branch', remoteSha: 'b'.repeat(40) },
      ])
    ).toThrow(IntentError);
  });
  it('builds and parses exact bounded engagement markers, rejecting ambiguous markers', () => {
    expect(parseEngagementMarker(`body\n${engagementMarker('c-1')}`)).toBe('c-1');
    expect(parseEngagementMarker(engagementMarker('c-1').repeat(2))).toBeNull();
    expect(
      parseEngagementMarker('<!-- ai-dossier:ztfc contribution=bad id op=engagement -->')
    ).toBeNull();
    for (const id of ['', 'x -->', 'a'.repeat(129)])
      expect(() => engagementMarker(id)).toThrow(IntentError);
  });
});

const lifecycleRuns = [
  gating,
  advance(gating, ReasonCode.PermissionRequired),
  advance(gating, ReasonCode.GatePassed),
  advance(gating, ReasonCode.GatePassed, ReasonCode.PlanApproved),
  advance(gating, ReasonCode.GatePassed, ReasonCode.PlanApproved, ReasonCode.CandidateReady),
  advance(run, ReasonCode.UserPaused),
  run,
  advance(run, ReasonCode.PublicationObserved),
  advance(run, ReasonCode.PublicationObserved, ReasonCode.ReviewAwaited),
  advance(run, ReasonCode.PublicationObserved, ReasonCode.RevisionRequested),
  advance(run, ReasonCode.PublicationObserved, ReasonCode.UpstreamAccepted),
  advance(run, ReasonCode.PublicationObserved, ReasonCode.ObservedUpstreamMerge),
  advance(run, ReasonCode.PublicationObserved, ReasonCode.UpstreamDeclined),
  advance(run, ReasonCode.PolicyBlocked),
  advance(run, ReasonCode.UnsupportedEnvironment),
  advance(run, ReasonCode.ExecutionFailed),
  advance(run, ReasonCode.UserCancelled),
  advance(run, ReasonCode.CleanupFailed),
];
const deniedRuns = lifecycleRuns.filter((r) =>
  [
    'cancelled',
    'failed',
    'declined',
    'merged',
    'blocked',
    'unsupported',
    'blocked_cleanup',
    'paused_user',
  ].includes(r.state)
);

describe('current controller lifecycle admission', () => {
  it('recovery from the durable exhaustion prefix fences same and different keys even when the block clock failed', async () => {
    const dir = directory();
    const j = journal(dir);
    const fake = new FakeAdapter();
    fake.mode = 'fail';
    const d = new IntentDriver(j, fake, { run, contributionId: 'c-1' }, () => {
      throw new Error('clock unavailable');
    });
    await expect(d.execute(input)).rejects.toThrow(MutationUncertainError);
    await expect(d.execute(input)).rejects.toThrow(MutationUncertainError);
    await expect(d.resume()).rejects.toThrow('clock unavailable');
    expect((j.read().at(-1) as { type: string }).type).toBe('exhausted');
    expect(d.snapshot().run.state).toBe('shipping');
    j.close();
    const recovered = journal(dir);
    const restored = driver(recovered, fake);
    const reads = fake.reads;
    await restored.resume();
    for (const target of [input.target, 'other'])
      await expect(restored.execute({ ...input, target })).rejects.toThrow(WriteBlockedError);
    expect(fake.writes).toBe(2);
    expect(fake.reads).toBe(reads);
    expect(restored.snapshot().blockedReason).toBe('retry_exhausted');
    expect(() =>
      replayIntents([
        ...recovered.read(),
        { v: 1, type: 'intended', input: { ...input, target: 'other' } },
      ])
    ).toThrow(IntentError);
  });
  it('pending resume rejects when observation fsync fails during a retry-ready reconciliation', async () => {
    const j = journal();
    const fake = new FakeAdapter();
    fake.mode = 'fail';
    const d = driver(j, fake);
    await expect(d.execute(input)).rejects.toThrow(MutationUncertainError);
    await d.resume();
    let finish!: (result: ReconcileResult) => void;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(fake, 'reconcile').mockImplementation(() => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const pending = d.resume();
    await reading;
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => {
      throw new Error('disk');
    });
    expect(() => d.observeRun(advance(run, ReasonCode.UserCancelled))).toThrow(JournalError);
    finish({ kind: 'absent' });
    await expect(pending).rejects.toThrow(WriteBlockedError);
    await expect(d.execute({ ...input, target: 'other' })).rejects.toThrow(WriteBlockedError);
    expect(fake.writes).toBe(1);
  });
  it('reconciles legacy paused-run journal effects under a current cancellation without new writes', async () => {
    const paused = advance(run, ReasonCode.UserPaused);
    const cancelled = advance(paused, ReasonCode.UserCancelled);
    const j = journal();
    for (const event of [
      { v: 1, type: 'run', run: paused, contributionId: 'c-1' },
      { v: 1, type: 'intended', input },
      { v: 1, type: 'attempted', key: idempotencyKey(input) },
      { v: 1, type: 'ambiguous', key: idempotencyKey(input) },
    ])
      j.append(event);
    const fake = new FakeAdapter();
    fake.observation = { kind: 'found', artifactRef: 'legacy-effect' };
    const d = driver(j, fake, cancelled);
    await d.resume();
    await expect(d.execute(input)).rejects.toThrow(WriteBlockedError);
    expect(fake.writes).toBe(0);
    expect(fake.reads).toBe(1);
    expect(d.snapshot().intents.get(idempotencyKey(input))?.artifactRef).toBe('legacy-effect');
    expect(replayIntents(j.read())).toEqual(d.snapshot());
  });
  it.each([
    'success',
    'lost',
  ] as const)('preserves an already-issued %s mutation outcome after cancellation', async (mode) => {
    const j = journal();
    const fake = new FakeAdapter();
    let finish!: () => void;
    let started!: () => void;
    const issued = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(fake, 'mutate').mockImplementation(async () => {
      fake.writes++;
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      if (mode === 'lost') throw new Error('lost response');
      return { artifactRef: 'issued-effect' };
    });
    const d = driver(j, fake);
    const pending = d.execute(input);
    await issued;
    const current = advance(run, ReasonCode.UserCancelled);
    d.observeRun(current);
    finish();
    if (mode === 'lost') await expect(pending).rejects.toThrow(MutationUncertainError);
    else await expect(pending).resolves.toBe('issued-effect');
    expect(d.snapshot().run).toEqual(current);
    expect(d.snapshot().intents.get(idempotencyKey(input))?.status).toBe(
      mode === 'lost' ? 'ambiguous' : 'confirmed'
    );
    await expect(d.execute({ ...input, target: 'other' })).rejects.toThrow(WriteBlockedError);
    expect(fake.writes).toBe(1);
    expect(replayIntents(j.read())).toEqual(d.snapshot());
  });
  it.each([
    ReasonCode.UserCancelled,
    ReasonCode.CleanupFailed,
  ])('durably records exhausted absence after %s without renewing retries', async (reason) => {
    const dir = directory();
    let j = journal(dir);
    const fake = new FakeAdapter();
    fake.mode = 'fail';
    const d = driver(j, fake);
    await expect(d.execute(input)).rejects.toThrow(MutationUncertainError);
    await expect(d.execute(input)).rejects.toThrow(MutationUncertainError);
    const current = advance(run, reason);
    d.observeRun(current);
    await expect(d.resume()).rejects.toThrow(WriteBlockedError);
    expect(d.snapshot().blockedReason).toBe('retry_exhausted');
    expect(d.snapshot().run).toEqual(current);
    expect(d.snapshot().intents.get(idempotencyKey(input))).toMatchObject({
      attempts: 2,
      retryReady: false,
      exhaustedAbsent: true,
    });
    expect(j.read()).toContainEqual({ v: 1, type: 'exhausted', key: idempotencyKey(input) });
    j.close();
    j = journal(dir);
    const restored = driver(j, fake, current);
    const events = j.read().length;
    const reads = fake.reads;
    await restored.resume();
    await expect(restored.execute(input)).rejects.toThrow(WriteBlockedError);
    expect(fake.writes).toBe(2);
    expect(fake.reads).toBe(reads);
    expect(j.read()).toHaveLength(events);
    expect(restored.snapshot().blockedReason).toBe('retry_exhausted');
    expect(replayIntents(j.read())).toEqual(restored.snapshot());
    expect(() =>
      replayIntents([...j.read(), { v: 1, type: 'attempted', key: idempotencyKey(input) }])
    ).toThrow(IntentError);
  });
  it('covers every lifecycle state', () => {
    expect(new Set(lifecycleRuns.map((r) => r.state))).toEqual(new Set(RUN_STATES));
  });
  it.each(lifecycleRuns)('enforces operation scope in $state', async (current) => {
    const allowed =
      current.state === 'shipping'
        ? ['fork_ensure', 'push_branch', 'pr_create', 'pr_update', 'pr_close']
        : current.state === 'revising'
          ? ['pr_update', 'pr_close']
          : ['gating', 'awaiting_maintainer'].includes(current.state)
            ? ['engagement_comment']
            : ['submitted', 'awaiting_review', 'accepted'].includes(current.state)
              ? ['pr_close']
              : [];
    for (const operationKind of OPERATION_KINDS) {
      const fake = new FakeAdapter();
      const d = driver(journal(), fake, current);
      const result = d.execute({ ...input, operationKind });
      if (allowed.includes(operationKind)) await expect(result).resolves.toBe('artifact-1');
      else await expect(result).rejects.toThrow(WriteBlockedError);
      expect(fake.writes).toBe(allowed.includes(operationKind) ? 1 : 0);
    }
  });
  it.each(
    deniedRuns
  )('resumes $state and journals reconciliation without new writes', async (current) => {
    for (const status of ['attempted', 'ambiguous'] as const) {
      for (const kind of ['found', 'absent'] as const) {
        const dir = directory();
        const j = journal(dir);
        j.append({ v: 1, type: 'run', run, contributionId: 'c-1' });
        j.append({ v: 1, type: 'intended', input });
        j.append({ v: 1, type: 'attempted', key: idempotencyKey(input) });
        if (status === 'ambiguous')
          j.append({ v: 1, type: 'ambiguous', key: idempotencyKey(input) });
        j.close();
        const fake = new FakeAdapter();
        fake.observation = kind === 'found' ? { kind, artifactRef: 'existing' } : { kind };
        const restored = journal(dir);
        const d = driver(restored, fake, current);
        await d.resume();
        expect(fake.reads).toBe(1);
        expect(d.snapshot().run).toEqual(current);
        expect(restored.read()).toContainEqual({ v: 1, type: 'run_update', run: current });
        expect((restored.read().at(-1) as { type: string }).type).toBe(
          kind === 'found' ? 'confirmed' : 'absent'
        );
        for (const operationKind of OPERATION_KINDS)
          await expect(d.execute({ ...input, operationKind })).rejects.toThrow(WriteBlockedError);
        expect(fake.writes).toBe(0);
        expect(replayIntents(restored.read())).toEqual(d.snapshot());
      }
    }
  });
  it('rejects rollback, divergent history, changed creation time and forged replay updates', () => {
    const dir = directory();
    const j = journal(dir);
    driver(j, new FakeAdapter());
    j.close();
    const resumed = journal(dir);
    const divergence = advance(
      gating,
      ReasonCode.UserPaused,
      ReasonCode.ResumeGating,
      ReasonCode.GatePassed,
      ReasonCode.PlanApproved,
      ReasonCode.CandidateReady,
      ReasonCode.VerificationPassed
    );
    const changedCreation = createRun(gating, '2026-10-04T00:00:00.000Z');
    for (const invalid of [gating, divergence, changedCreation]) {
      expect(() => driver(resumed, new FakeAdapter(), invalid)).toThrow(IntentError);
      expect(() =>
        replayIntents([...resumed.read(), { v: 1, type: 'run_update', run: invalid }])
      ).toThrow(IntentError);
    }
    const d = driver(resumed, new FakeAdapter());
    const length = resumed.read().length;
    d.observeRun(run);
    expect(resumed.read()).toHaveLength(length);
    expect(() => d.observeRun(divergence)).toThrow(IntentError);
  });
  it.each([
    ReasonCode.CleanupFailed,
    ReasonCode.UserCancelled,
  ])('live %s revokes queued writes and persists across restart', async (reason) => {
    const dir = directory();
    const j = journal(dir);
    const fake = new FakeAdapter();
    const d = driver(j, fake);
    const pending = d.execute(input);
    const current = advance(run, reason);
    d.observeRun(current);
    await expect(pending).rejects.toThrow(WriteBlockedError);
    await expect(d.execute(input)).rejects.toThrow(WriteBlockedError);
    j.close();
    await expect(driver(journal(dir), fake, current).execute(input)).rejects.toThrow(
      WriteBlockedError
    );
    expect(fake.writes).toBe(0);
  });
  it('observes cancellation during asynchronous reconciliation before admitting a mutation', async () => {
    const fake = new FakeAdapter();
    fake.mode = 'lost';
    const d = driver(journal(), fake);
    await expect(d.execute(input)).rejects.toThrow(MutationUncertainError);
    let finish!: (result: ReconcileResult) => void;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(fake, 'reconcile').mockImplementation(() => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const pending = d.execute({ ...input, target: 'other' });
    await reading;
    d.observeRun(advance(run, ReasonCode.UserCancelled));
    finish({ kind: 'found', artifactRef: 'existing' });
    await expect(pending).rejects.toThrow(WriteBlockedError);
    expect(fake.writes).toBe(1);
    expect(d.snapshot().intents.get(idempotencyKey(input))?.status).toBe('confirmed');
  });
  it('computes a write block from the latest controller lifecycle', async () => {
    const fake = new FakeAdapter();
    fake.mode = 'lost';
    const j = journal();
    const d = driver(j, fake);
    await expect(d.execute(input)).rejects.toThrow(MutationUncertainError);
    const current = advance(run, ReasonCode.PublicationObserved, ReasonCode.RevisionRequested);
    d.observeRun(current);
    fake.observation = { kind: 'unknown' };
    await expect(d.resume()).rejects.toThrow(WriteBlockedError);
    expect(d.snapshot().run).toEqual(advance(current, ReasonCode.PolicyBlocked));
    expect(d.snapshot().run.history.at(-1)?.from).toBe('revising');
    expect(replayIntents(j.read())).toEqual(d.snapshot());
  });
  it.each(
    deniedRuns
  )('uncertain reconciliation in $state cannot invent a lifecycle transition', async (current) => {
    const fake = new FakeAdapter();
    fake.mode = 'lost';
    const d = driver(journal(), fake);
    await expect(d.execute(input)).rejects.toThrow(MutationUncertainError);
    d.observeRun(current);
    fake.observation = { kind: 'unknown' };
    await expect(d.resume()).rejects.toThrow(WriteBlockedError);
    expect(d.snapshot().run.state).toBe(
      current.state === 'paused_user' ? 'blocked' : current.state
    );
    expect(fake.writes).toBe(1);
  });
});

describe('fail-closed journal durability', () => {
  it('fails initialization closed on file or directory fsync failure', () => {
    const dir = directory();
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => {
      throw new Error('private path');
    });
    expect(() => journal(dir)).toThrow(JournalError);
    vi.restoreAllMocks();
    const sync = fs.fsyncSync;
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error('directory fsync');
      sync(fd);
    });
    expect(() => journal(dir)).toThrow(JournalError);
  });
  it('rejects duplicate journal owners, unreadable data, changed modes and bad serialization', () => {
    const j = journal();
    expect(() => journal(path.dirname(j.filePath))).toThrow(JournalError);
    fs.chmodSync(j.filePath, 0o644);
    expect(() => j.append({})).toThrow(JournalError);
    const read = journal();
    read.append({});
    vi.spyOn(fs, 'readSync').mockReturnValueOnce(0);
    expect(() => read.read()).toThrow(JournalError);
    const utf = journal();
    utf.close();
    fs.writeFileSync(utf.filePath, Buffer.from([0xff, 0x0a]));
    expect(() => journal(path.dirname(utf.filePath))).toThrow(JournalError);
    const undefinedEvent = journal();
    expect(() => undefinedEvent.append(undefined)).toThrow(JournalError);
  });
  it('creates private directories/files and supports repeated full replay', () => {
    const dir = path.join(directory(), 'nested', 'private');
    const j = journal(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.dirname(dir)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(j.filePath).mode & 0o777).toBe(0o600);
    j.append({ value: 1 });
    j.append({ value: 2 });
    expect(j.read()).toEqual([{ value: 1 }, { value: 2 }]);
    expect(j.read()).toEqual(j.read());
    j.close();
    expect(() => j.append({})).toThrow(JournalError);
  });
  it.each([
    'write',
    'fsync',
    'zero-write',
  ] as const)('fails closed before mutation on %s failure', async (failure) => {
    const j = journal();
    const fake = new FakeAdapter();
    const d = driver(j, fake);
    if (failure === 'fsync')
      vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
        throw new Error('disk');
      });
    else
      vi.spyOn(fs, 'writeSync').mockImplementation(() => {
        if (failure === 'zero-write') return 0;
        throw new Error('disk');
      });
    await expect(d.execute(input)).rejects.toThrow(JournalError);
    expect(fake.writes).toBe(0);
    await expect(d.execute(input)).rejects.toThrow(WriteBlockedError);
  });
  it('handles short writes and fsyncs before any mutation', async () => {
    const j = journal();
    const fake = new FakeAdapter();
    const write = fs.writeSync;
    vi.spyOn(fs, 'writeSync').mockImplementation(((
      fd: number,
      bytes: Buffer,
      offset: number,
      length: number
    ) => write(fd, bytes, offset, Math.min(length, 7))) as typeof fs.writeSync);
    const sync = vi.spyOn(fs, 'fsyncSync');
    vi.spyOn(fake, 'mutate').mockImplementation(async () => {
      expect(sync).toHaveBeenCalledTimes(3);
      return { artifactRef: 'x' };
    });
    const d = driver(j, fake);
    await d.execute(input);
    expect(j.read()).toHaveLength(4);
  });
  it('recovers an attempted event if the controller dies before invoking the adapter', async () => {
    const dir = directory();
    const j = journal(dir);
    const fake = new FakeAdapter();
    const d = driver(j, fake);
    const append = j.append.bind(j);
    vi.spyOn(j, 'append').mockImplementation((event) => {
      append(event);
      if ((event as { type: string }).type === 'attempted') throw new JournalError();
    });
    await expect(d.execute(input)).rejects.toThrow(JournalError);
    expect(fake.writes).toBe(0);
    j.close();
    const restored = driver(journal(dir), fake);
    expect(await restored.execute(input)).toBe('artifact-1');
    expect(fake.reads).toBe(1);
    expect(restored.snapshot().intents.get(idempotencyKey(input))?.attempts).toBe(2);
  });
  it('confirmation journal failure never repeats a successful external write', async () => {
    const dir = directory();
    const j = journal(dir);
    const fake = new FakeAdapter();
    const d = driver(j, fake);
    const append = j.append.bind(j);
    vi.spyOn(j, 'append').mockImplementation((event) => {
      if ((event as { type: string }).type === 'confirmed') throw new JournalError();
      append(event);
    });
    await expect(d.execute(input)).rejects.toThrow(JournalError);
    j.close();
    const restored = driver(journal(dir), fake);
    await restored.resume();
    expect(await restored.execute(input)).toBe('artifact-1');
    expect(fake.writes).toBe(1);
  });
  it('real confirmation fsync failure poisons admission and restart preserves the external effect', async () => {
    const dir = directory();
    const j = journal(dir);
    const fake = new FakeAdapter();
    const d = driver(j, fake);
    const sync = fs.fsyncSync;
    let syncs = 0;
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      syncs++;
      if (syncs === 3) throw new Error('confirmation flush failed');
      sync(fd);
    });
    await expect(d.execute(input)).rejects.toThrow(JournalError);
    await expect(d.execute({ ...input, target: 'other' })).rejects.toThrow(WriteBlockedError);
    expect(fake.writes).toBe(1);
    vi.restoreAllMocks();
    j.close();
    const restored = driver(journal(dir), fake);
    expect(await restored.execute(input)).toBe('artifact-1');
    expect(fake.writes).toBe(1);
  });
  it('a torn append aborts mutation and cannot be silently skipped on restart', async () => {
    const dir = directory();
    const j = journal(dir);
    const fake = new FakeAdapter();
    const d = driver(j, fake);
    const write = fs.writeSync;
    let calls = 0;
    vi.spyOn(fs, 'writeSync').mockImplementation(((
      fd: number,
      bytes: Buffer,
      offset: number,
      length: number
    ) => {
      calls++;
      if (calls > 1) throw new Error('disk full');
      return write(fd, bytes, offset, Math.min(length, 5));
    }) as typeof fs.writeSync);
    await expect(d.execute(input)).rejects.toThrow(JournalError);
    expect(fake.writes).toBe(0);
    vi.restoreAllMocks();
    j.close();
    expect(() => journal(dir)).toThrow(JournalError);
  });
  it.each(['{"broken":', '{oops}\n', '\n'])('refuses truncated/corrupt JSONL %s', (text) => {
    const dir = directory();
    fs.writeFileSync(path.join(dir, 'events.jsonl'), text, { mode: 0o600 });
    expect(() => journal(dir)).toThrow(JournalError);
  });
  it('rejects symlinks, hardlinks, file replacement and external append', () => {
    const dir = directory();
    const target = path.join(dir, 'target');
    fs.writeFileSync(target, '');
    const linked = path.join(dir, 'linked');
    fs.symlinkSync(dir, linked);
    expect(() => journal(linked)).toThrow(JournalError);
    fs.symlinkSync(target, path.join(dir, 'events.jsonl'));
    expect(() => journal(dir)).toThrow(JournalError);
    fs.unlinkSync(path.join(dir, 'events.jsonl'));
    fs.linkSync(target, path.join(dir, 'events.jsonl'));
    expect(() => journal(dir)).toThrow(JournalError);
    fs.unlinkSync(path.join(dir, 'events.jsonl'));
    const j = journal(dir);
    fs.appendFileSync(j.filePath, '{}\n');
    expect(() => j.append({})).toThrow(JournalError);
    const other = journal();
    fs.renameSync(other.filePath, `${other.filePath}.old`);
    fs.writeFileSync(other.filePath, '', { mode: 0o600 });
    expect(() => other.read()).toThrow(JournalError);
  });
  it('survives real process death after durable attempt and external effect', async () => {
    // The package build precedes this test; the child uses the exact compiled public API.
    const dir = directory();
    const artifact = path.join(dir, 'remote-artifact');
    const modulePath = path.resolve(__dirname, '../../dist/index.js');
    const code = `const fs=require('node:fs'); const {Journal,IntentDriver}=require(${JSON.stringify(modulePath)});
      const j=new Journal(${JSON.stringify(path.join(dir, 'journal'))});
      const d=new IntentDriver(j,{reconcile:async()=>({kind:'unknown'}),mutate:async()=>{
        const fd=fs.openSync(${JSON.stringify(artifact)},'w',0o600);fs.writeSync(fd,'pr/1');fs.fsyncSync(fd);fs.closeSync(fd);
        process.stdout.write('effect\\n'); await new Promise(()=>{});
      }},{run:${JSON.stringify(run)},contributionId:'c-1'},()=>${JSON.stringify(timestamp)});
      d.execute(${JSON.stringify(input)}); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('child did not reach effect'));
      }, 10000);
      child.stdout.once('data', () => {
        child.kill('SIGKILL');
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (_code, signal) => {
        clearTimeout(timer);
        signal === 'SIGKILL' ? resolve() : reject(new Error(stderr));
      });
    });
    const mutate = vi.fn(async () => ({ artifactRef: 'duplicate' }));
    const reconcile = vi.fn(
      async (): Promise<ReconcileResult> => ({
        kind: 'found',
        artifactRef: fs.readFileSync(artifact, 'utf8'),
      })
    );
    const restored = driver(journal(path.join(dir, 'journal')), { mutate, reconcile });
    await restored.resume();
    expect(await restored.execute(input)).toBe('pr/1');
    expect(mutate).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(1);
  }, 15000);
});
