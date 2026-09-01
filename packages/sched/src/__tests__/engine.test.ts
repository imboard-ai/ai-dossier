import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildStatusReport,
  type EngineDeps,
  type EnqueueInput,
  enqueueEntries,
  type GroundTruth,
  type GroundTruthMilestone,
  Journal,
  type PrTruth,
  type SchedConfig,
  SchedStore,
  type SetupInfo,
  type SpawnDeps,
  tick,
} from '../index';

/**
 * Engine harness: a real SchedStore on a temp dir, fully fake process I/O
 * (spawn/kill/isAlive backed by a pid counter and a liveness set), and
 * scriptable ground truth. No subprocesses, no LLM calls. Since #468 the
 * ground truth is also scriptable for PR states and setup info, and the
 * teardown exec is a recording fake.
 */
function harness(
  opts?: { maxSlots?: number; stallTimeoutMs?: number; prPollIntervalMs?: number },
  existingDir?: string
) {
  const dir = existingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sched-engine-'));
  const store = new SchedStore(dir);
  const journal = new Journal(dir);

  let pidSeq = 4242;
  const alive = new Set<number>();
  const spawnCalls: Array<{ cmd: string[]; prompt: string; logFile: string; pid: number }> = [];
  const killedPids: number[] = [];
  const spawnDeps: SpawnDeps = {
    spawn: (cmd, prompt, logFile) => {
      const pid = pidSeq++;
      alive.add(pid);
      spawnCalls.push({ cmd, prompt, logFile, pid });
      return pid;
    },
    kill: (pid) => {
      killedPids.push(pid);
      return alive.delete(pid);
    },
    isAlive: (pid) => alive.has(pid),
    processStart: () => null, // no /proc in the fake — best-effort identity
  };

  const milestones = new Map<number, GroundTruthMilestone | null>();
  const closedIssues = new Set<number>();
  const branchHeads = new Map<string, string>();
  const unreachable = new Set<number>();
  const prStates = new Map<number, PrTruth | undefined>();
  const prUnreachable = new Set<number>();
  const setupInfos = new Map<number, SetupInfo | null | undefined>();
  const setupUnreachable = new Set<number>();
  const teardownCalls: Array<{ file: string; args: string[]; cwd?: string }> = [];
  /** Scriptable teardown subprocess behavior (default: every call fails). */
  let teardownScript: (file: string, args: string[]) => string | null = () => null;
  const groundTruth: GroundTruth = {
    latestMilestone: (issue) =>
      unreachable.has(issue) ? undefined : (milestones.get(issue) ?? null),
    issueClosed: (issue) => closedIssues.has(issue),
    branchHead: (branch) => branchHeads.get(branch) ?? null,
    prState: (pr) => (prUnreachable.has(pr) ? undefined : prStates.get(pr)),
    setupInfo: (issue) =>
      setupUnreachable.has(issue) ? undefined : (setupInfos.get(issue) ?? null),
  };
  const teardownExec = (file: string, args: string[], cwd?: string): string | null => {
    teardownCalls.push({ file, args, cwd });
    return teardownScript(file, args);
  };

  let clock = new Date('2026-08-29T12:00:00Z');
  const deps: EngineDeps = {
    store,
    journal,
    groundTruth,
    spawnDeps,
    now: () => clock,
    repoDir: dir,
    teardownExec,
  };

  const config: SchedConfig = {
    max_slots: opts?.maxSlots ?? 3,
    ...(opts?.stallTimeoutMs !== undefined ? { stall_timeout_ms: opts.stallTimeoutMs } : {}),
    ...(opts?.prPollIntervalMs !== undefined ? { pr_poll_interval_ms: opts.prPollIntervalMs } : {}),
  };

  return {
    dir,
    store,
    journal,
    spawnCalls,
    killedPids,
    alive,
    milestones,
    closedIssues,
    branchHeads,
    unreachable,
    prStates,
    prUnreachable,
    setupInfos,
    setupUnreachable,
    teardownCalls,
    setTeardownScript: (script: (file: string, args: string[]) => string | null) => {
      teardownScript = script;
    },
    /** A convention-valid worktree path for this harness's repo dir. */
    wt: (name: string) => path.join(dir, 'worktrees', name),
    config,
    deps,
    enqueue: (inputs: EnqueueInput[]) =>
      store.withLock((state) => ({ state: enqueueEntries(state, inputs, clock), result: null })),
    tick: () => tick(deps, config),
    state: () => store.load(),
    events: () => journal.read(),
    setMilestone: (
      issue: number,
      phase: string,
      status = 'done',
      at?: string,
      keys: Record<string, string> = {}
    ) =>
      milestones.set(issue, {
        phase,
        status,
        run: `r-${issue}-x`,
        at: at ?? clock.toISOString(),
        keys,
      }),
    setPr: (pr: number, truth: Partial<PrTruth> & { state: PrTruth['state'] }) =>
      prStates.set(pr, {
        mergedAt: null,
        mergeable: 'MERGEABLE',
        blocked: false,
        ...truth,
      }),
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    clock: () => clock,
  };
}

/** The milestone shape a detached ship run posts when parking its PR (#468). */
function parkMilestone(pr: number, at?: string): GroundTruthMilestone {
  return {
    phase: 'ship',
    status: 'awaiting-merge',
    run: 'r-1-x',
    at: at ?? new Date('2026-08-29T12:00:00Z').toISOString(),
    keys: { pr: String(pr), head: 'abc1234', ci_fix_attempts: '0' },
  };
}

const REGISTRIES: string[] = [];
afterEach(() => {
  for (const dir of REGISTRIES.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// One top-level sweep: every harness dir is a fresh `sched-engine-` tmpdir —
// stale dirs from crashed runs never leak between tests.
beforeEach(() => {
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (name.startsWith('sched-engine-')) {
      fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
    }
  }
});

describe('dispatch (AC1: spawn with --model per tier; pid/phase/progress in state.json)', () => {
  it('dispatches a runnable unit as a spawned agent process with the tier model', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full', tier: 'strong' }]);

    const result = h.tick();

    expect(result.spawned).toEqual(['issue:101']);
    expect(h.spawnCalls).toHaveLength(1);
    // `--model` per tier: strong → opus on the default claude template
    expect(h.spawnCalls[0].cmd).toContain('opus');
    expect(h.spawnCalls[0].cmd.join(' ')).toMatch(/--model opus/);
    expect(h.spawnCalls[0].prompt).toContain('#101');

    // pid + phase + last-progress timestamp persisted in state.json (AC1)
    const state = h.state();
    const slot = state.slots.find((s) => s.unit === 'issue:101');
    expect(slot?.status).toBe('running');
    expect(slot?.pid).toBe(h.spawnCalls[0].pid);
    expect(slot?.phase).toBe('gate');
    expect(slot?.last_progress_at).toBe(h.clock().toISOString());
    expect(state.entries.find((e) => e.issue === 101)?.status).toBe('dispatched');
    // durable on disk, not just in memory
    expect(JSON.parse(fs.readFileSync(h.store.statePath, 'utf8')).slots[0].pid).toBe(
      h.spawnCalls[0].pid
    );
  });

  it('respects max_slots: a second runnable unit waits for a free slot', () => {
    const h = harness({ maxSlots: 1 });
    REGISTRIES.push(h.dir);
    h.enqueue([
      { issue: 101, mode: 'full', tier: 'mid' },
      { issue: 102, mode: 'full', tier: 'mid' },
    ]);

    h.tick();
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.state().entries.find((e) => e.issue === 102)?.status).toBe('queued');
  });

  it('paused scheduler reconciles live units but makes no new assignments', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full' }]);
    h.tick();
    h.store.withLock((state) => ({ state: { ...state, paused: true }, result: null }));

    const result = h.tick();
    expect(result.spawned).toHaveLength(0);
    expect(h.spawnCalls).toHaveLength(1);
  });
});

describe('completion verification (AC2: an agent exiting is never proof of completion)', () => {
  it('exit + verified report-done milestone → complete; slot freed; entry done', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full' }]);
    h.tick();

    // The agent exits (pid dies) AND ground truth confirms report done.
    h.alive.delete(h.spawnCalls[0].pid);
    h.setMilestone(101, 'report', 'done');

    const result = h.tick();
    expect(result.completed).toEqual(['issue:101']);
    const state = h.state();
    expect(state.entries.find((e) => e.issue === 101)?.status).toBe('done');
    const slot = state.slots.find((s) => s.id === 1);
    expect(slot?.status).toBe('idle');
    expect(slot?.unit).toBeNull();
  });

  it('exit WITHOUT a verified milestone → unit NOT complete → redispatched one tier stronger', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full', tier: 'mechanical' }]);
    h.tick();
    const firstPid = h.spawnCalls[0].pid;

    // Agent exits having done nothing verifiable — exit alone proves nothing.
    h.alive.delete(firstPid);

    const result = h.tick();

    expect(result.completed).toHaveLength(0);
    expect(result.redispatched).toEqual(['issue:101']);
    // tier escalated mechanical → mid, a new agent spawned with the mid model
    const state = h.state();
    expect(state.entries.find((e) => e.issue === 101)?.tier).toBe('mid');
    expect(state.entries.find((e) => e.issue === 101)?.status).toBe('dispatched');
    expect(h.spawnCalls).toHaveLength(2);
    expect(h.spawnCalls[1].cmd).toContain('sonnet');
    expect(h.spawnCalls[1].pid).not.toBe(firstPid);
    expect(state.slots.find((s) => s.unit === 'issue:101')?.recoveries).toBe(1);
    // journal records the unverified exit
    const events = h.journal.read().map((e) => e.event);
    expect(events).toContain('exit-detected');
    expect(events).toContain('verify-incomplete');
    expect(events).toContain('redispatched');
  });

  it('exit on an issue that GitHub says is closed → complete (ground truth wins)', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full' }]);
    h.tick();
    h.alive.delete(h.spawnCalls[0].pid);
    h.closedIssues.add(101);

    const result = h.tick();
    expect(result.completed).toEqual(['issue:101']);
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('done');
  });
});

describe('reconciliation tick (AC3: external advance + orphaned pids after restart)', () => {
  it('externally-advanced state completes a unit whose agent is still alive', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full' }]);
    h.tick();
    // Someone else finished the work; the spawned agent is still running.
    h.setMilestone(101, 'report', 'done');

    const result = h.tick();

    expect(result.externalAdvances).toEqual(['issue:101']);
    // the leftover agent is killed and the slot reclaimed
    expect(h.killedPids).toContain(h.spawnCalls[0].pid);
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('done');
    expect(h.state().slots.find((s) => s.id === 1)?.status).toBe('idle');
  });

  it('orphaned pid after a sched restart: dead pid on a running slot → exit rail → verify', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full' }]);
    h.tick();
    // Simulate the restart: every recorded pid belongs to a dead process.
    h.alive.clear();

    const result = h.tick();

    // exit detected, not trusted: no milestone → NOT complete, redispatched
    expect(result.completed).toHaveLength(0);
    expect(result.redispatched).toEqual(['issue:101']);
    const events = h.journal.read().map((e) => e.event);
    expect(events).toContain('exit-detected');
    expect(h.spawnCalls).toHaveLength(2); // respawned
  });

  it('updates the live phase from the milestone trail (AC6)', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full' }]);
    h.tick();
    h.setMilestone(101, 'implement', 'done');

    h.tick();

    const report = buildStatusReport(h.state(), h.config, 'test');
    expect(report.slots.find((s) => s.unit === 'issue:101')?.phase).toBe('implement');
    expect(h.journal.read().some((e) => e.event === 'phase-updated')).toBe(true);
  });

  it('captures the branch from the setup milestone and treats a new head as progress', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full' }]);
    h.tick();

    // setup milestone carries branch=
    h.milestones.set(101, {
      phase: 'setup',
      status: 'done',
      run: 'r',
      at: h.clock().toISOString(),
      keys: { branch: 'feature/101-x' },
    });
    h.tick();
    expect(h.state().slots.find((s) => s.unit === 'issue:101')?.branch).toBe('feature/101-x');

    // a WIP push moves the remote head — that is progress even with NO new milestone
    const before = h.state().slots.find((s) => s.unit === 'issue:101')?.last_progress_at;
    h.advance(20 * 60 * 1000); // 20 min: under the 30-min stall timeout
    h.branchHeads.set('feature/101-x', 'aaabbb111');
    h.milestones.delete(101); // no new milestone at all
    h.tick();

    const slot = h.state().slots.find((s) => s.unit === 'issue:101');
    expect(slot?.last_head).toBe('aaabbb111');
    expect(slot?.last_progress_at).not.toBe(before);
    // and no stall fired
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('dispatched');
  });
});

describe('stall/escalation ladder (AC4)', () => {
  function stalledHarness() {
    const h = harness({ stallTimeoutMs: 30 * 60 * 1000 });
    REGISTRIES.push(h.dir);
    return h;
  }

  it('30 minutes without milestone or commit → redispatch one tier stronger', () => {
    const h = stalledHarness();
    h.enqueue([{ issue: 101, mode: 'full', tier: 'mechanical' }]);
    h.tick();
    const firstPid = h.spawnCalls[0].pid;

    h.advance(31 * 60 * 1000);
    const result = h.tick();

    expect(result.redispatched).toEqual(['issue:101']);
    expect(h.killedPids).toContain(firstPid); // stalled agent killed
    const state = h.state();
    expect(state.entries.find((e) => e.issue === 101)?.tier).toBe('mid');
    expect(h.spawnCalls[1].cmd).toContain('sonnet');
    expect(state.slots.find((s) => s.unit === 'issue:101')?.recoveries).toBe(1);
    expect(h.journal.read().some((e) => e.event === 'stalled')).toBe(true);
  });

  it('a new milestone inside the window prevents the stall', () => {
    const h = stalledHarness();
    h.enqueue([{ issue: 101, mode: 'full', tier: 'mid' }]);
    h.tick();
    h.advance(20 * 60 * 1000);
    h.setMilestone(101, 'implement', 'done');
    h.advance(20 * 60 * 1000); // 40 min total, but progress 20 min ago

    const result = h.tick();
    expect(result.redispatched).toHaveLength(0);
    expect(h.state().entries.find((e) => e.issue === 101)?.tier).toBe('mid');
  });

  it('cap 2 escalations, then failed + TRANSITIVE dependents blocked', () => {
    // One slot: 101 runs; 102/103 are dep-blocked on it; 104 waits in queue.
    const h = harness({ maxSlots: 1, stallTimeoutMs: 30 * 60 * 1000 });
    REGISTRIES.push(h.dir);
    h.enqueue([
      { issue: 101, mode: 'full', tier: 'mechanical' },
      { issue: 102, mode: 'full', tier: 'mid', deps: [101] },
      { issue: 103, mode: 'full', tier: 'mid', deps: [102] },
      { issue: 104, mode: 'full', tier: 'mid' }, // independent: unaffected
    ]);
    h.tick();
    expect(h.spawnCalls).toHaveLength(1); // only 101 (102/103 dep-blocked, 104 waits)

    // Stall 1: mechanical → mid
    h.advance(31 * 60 * 1000);
    let result = h.tick();
    expect(result.redispatched).toEqual(['issue:101']);
    expect(h.state().entries.find((e) => e.issue === 101)?.tier).toBe('mid');

    // Stall 2: mid → strong
    h.advance(31 * 60 * 1000);
    result = h.tick();
    expect(result.redispatched).toEqual(['issue:101']);
    expect(h.state().entries.find((e) => e.issue === 101)?.tier).toBe('strong');

    // Stall 3: cap reached → failed, dependents blocked transitively
    h.advance(31 * 60 * 1000);
    result = h.tick();
    expect(result.failed).toEqual(['issue:101']);
    const state = h.state();
    expect(state.entries.find((e) => e.issue === 101)?.status).toBe('failed');
    expect(state.entries.find((e) => e.issue === 101)?.reason).toBe('escalation-cap');
    expect(state.entries.find((e) => e.issue === 102)?.status).toBe('blocked');
    expect(state.entries.find((e) => e.issue === 102)?.reason).toBe('dep-failed:101');
    expect(state.entries.find((e) => e.issue === 103)?.status).toBe('blocked');
    expect(state.entries.find((e) => e.issue === 103)?.reason).toBe('dep-failed:101');
    // the independent unit took over the freed slot in the same tick
    expect(state.entries.find((e) => e.issue === 104)?.status).toBe('dispatched');
    expect(state.slots.find((s) => s.unit === 'issue:101')).toBeUndefined();
    expect(h.journal.read().some((e) => e.event === 'dependents-blocked')).toBe(true);
  });

  it('a stall at the strongest tier fails the unit (nowhere stronger to go)', () => {
    const h = stalledHarness();
    h.enqueue([{ issue: 101, mode: 'full', tier: 'strong' }]);
    h.tick();
    h.advance(31 * 60 * 1000);

    const result = h.tick();
    expect(result.failed).toEqual(['issue:101']);
    expect(h.state().entries.find((e) => e.issue === 101)?.reason).toBe('stall-at-strongest-tier');
  });
});

describe('slot refill (AC5: immediate and automatic)', () => {
  it('regression: a freed slot is refilled by the SAME tick — no runnable unit waits', () => {
    const h = harness({ maxSlots: 1 });
    REGISTRIES.push(h.dir);
    h.enqueue([
      { issue: 101, mode: 'full', tier: 'mid' },
      { issue: 102, mode: 'full', tier: 'mid' },
    ]);

    h.tick();
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.state().slots.find((s) => s.unit === 'issue:101')).toBeDefined();

    // 101 finishes and its exit is verifiable
    h.alive.delete(h.spawnCalls[0].pid);
    h.setMilestone(101, 'report', 'done');

    const result = h.tick();

    // 101 completed AND 102 was spawned — in one tick
    expect(result.completed).toEqual(['issue:101']);
    expect(result.spawned).toEqual(['issue:102']);
    const state = h.state();
    expect(state.slots).toHaveLength(1); // the single slot, reused
    expect(state.slots[0].unit).toBe('issue:102');
    expect(state.slots[0].status).toBe('running');
    expect(state.entries.find((e) => e.issue === 101)?.status).toBe('done');
    expect(state.entries.find((e) => e.issue === 102)?.status).toBe('dispatched');
  });
});

describe('restart self-healing', () => {
  it('a slot left assigned by a crash between assign and spawn is spawned on the next tick', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full' }]);
    h.tick();

    // Simulate the crash: roll the slot back to assigned with no pid — direct
    // state surgery, exactly what a crash between assign and spawn persists.
    h.store.withLock((state) => ({
      state: {
        ...state,
        slots: state.slots.map((s) =>
          s.unit === 'issue:101' ? { ...s, status: 'assigned' as const, pid: null, phase: null } : s
        ),
      },
      result: null,
    }));

    const result = h.tick();
    expect(result.spawned).toEqual(['issue:101']);
    expect(h.state().slots.find((s) => s.unit === 'issue:101')?.status).toBe('running');
  });

  it('a dispatched entry no slot holds (crash window) returns to the queue', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full' }]);
    h.tick();

    // Simulate the crash: slot vanished while the entry stayed dispatched.
    h.store.withLock((state) => ({
      state: { ...state, slots: [], next_slot_id: 1 },
      result: null,
    }));

    const result = h.tick();
    // requeued → reassigned → spawned again in the same tick
    expect(result.spawned).toEqual(['issue:101']);
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('dispatched');
    expect(h.state().slots.find((s) => s.unit === 'issue:101')?.status).toBe('running');
  });
});

describe('ground-truth outage pause (decision 2, option A)', () => {
  it('an unreachable poll pauses the stall decision — no kill, no redispatch, journaled', () => {
    const h = harness({ stallTimeoutMs: 30 * 60 * 1000 });
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full', tier: 'mid' }]);
    h.tick();
    const pid = h.spawnCalls[0].pid;

    // Outage: the milestone poll fails, the stall window elapses.
    h.unreachable.add(101);
    h.advance(45 * 60 * 1000);
    const result = h.tick();

    expect(result.redispatched).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(h.killedPids).toHaveLength(0); // the healthy agent was NOT killed
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('dispatched');
    expect(h.journal.read().some((e) => e.event === 'ground-truth-unreachable')).toBe(true);

    // Truth returns WITH progress made during the outage → progress, still no stall.
    h.unreachable.delete(101);
    h.setMilestone(101, 'implement', 'done');
    const after = h.tick();
    expect(after.redispatched).toHaveLength(0);
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('dispatched');
    void pid;
  });

  it('an agent exit during an outage holds in verifying; truth returning completes it', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full' }]);
    h.tick();

    // The agent exits DURING the outage — exit detection is local truth and
    // still fires; verification pauses because truth is unreachable.
    h.alive.delete(h.spawnCalls[0].pid);
    h.unreachable.add(101);
    let result = h.tick();
    expect(result.completed).toHaveLength(0);
    expect(result.redispatched).toHaveLength(0); // NOT failed as unverified — paused
    const slot = h.state().slots.find((s) => s.unit === 'issue:101');
    expect(slot?.status).toBe('verifying');

    // Truth returns and confirms report done → the held exit completes.
    h.unreachable.delete(101);
    h.setMilestone(101, 'report', 'done');
    result = h.tick();
    expect(result.completed).toEqual(['issue:101']);
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('done');
  });

  it('an agent exit during an outage, with truth returning empty, rides the recovery ladder once', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full', tier: 'mechanical' }]);
    h.tick();
    h.alive.delete(h.spawnCalls[0].pid);
    h.unreachable.add(101);
    h.tick(); // paused in verifying

    h.unreachable.delete(101); // truth returns: no milestone exists (known-absent)
    const result = h.tick();
    expect(result.redispatched).toEqual(['issue:101']); // NOW the ladder decides
    expect(h.state().entries.find((e) => e.issue === 101)?.tier).toBe('mid');
  });
});

describe('dispatch-health pause (#505: quota/auth walls never ride the per-unit ladder alone)', () => {
  it('one instant unverified exit is journaled suspect-dispatch but does not pause', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full', tier: 'mechanical' }]);
    h.tick();

    // Exits immediately (same tick, zero elapsed) with nothing verifiable —
    // exactly what a quota wall killing the very first request looks like.
    h.alive.delete(h.spawnCalls[0].pid);
    const result = h.tick();

    expect(result.redispatched).toEqual(['issue:101']); // the ladder is unchanged
    expect(h.journal.read().some((e) => e.event === 'suspect-dispatch')).toBe(true);
    expect(h.state().paused).toBe(false);
    expect(h.state().consecutive_suspect_dispatches).toBe(1);
    expect(h.state().last_suspect_dispatch_unit).toBe('issue:101');
  });

  it('a slow unverified exit (>= the window) is never flagged suspect', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full', tier: 'mechanical' }]);
    h.tick();

    h.advance(90 * 1000); // 90s: past SUSPECT_DISPATCH_WINDOW_MS (60s)
    h.alive.delete(h.spawnCalls[0].pid);
    h.tick();

    expect(h.journal.read().some((e) => e.event === 'suspect-dispatch')).toBe(false);
    expect(h.state().consecutive_suspect_dispatches).toBe(0);
  });

  it('repeated instant exits of the SAME unit riding its own ladder never pause', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full', tier: 'mechanical' }]);
    h.tick();

    // mechanical → mid → strong → escalation-cap, every exit instant.
    h.alive.delete(h.spawnCalls[0].pid);
    h.tick();
    h.alive.delete(h.spawnCalls[1].pid);
    h.tick();
    h.alive.delete(h.spawnCalls[2].pid);
    h.tick();

    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('failed');
    expect(h.state().paused).toBe(false); // same unit throughout — no cross-unit correlation
    expect(h.state().consecutive_suspect_dispatches).toBe(1);
    expect(h.state().last_suspect_dispatch_unit).toBe('issue:101');
  });

  it('two instant unverified exits from DIFFERENT units pause new assignments and journal dispatch-unhealthy', () => {
    const h = harness({ maxSlots: 2 });
    REGISTRIES.push(h.dir);
    h.enqueue([
      { issue: 101, mode: 'full', tier: 'mechanical' },
      { issue: 102, mode: 'full', tier: 'mechanical' },
      { issue: 103, mode: 'full', tier: 'mechanical' }, // queued, waits for a slot
    ]);
    h.tick();
    expect(h.spawnCalls).toHaveLength(2); // 101, 102 — 103 waits (maxSlots: 2)

    h.alive.delete(h.spawnCalls[0].pid); // issue:101 quick-exits
    h.tick();
    expect(h.state().paused).toBe(false); // one suspect isn't enough yet

    h.alive.delete(h.spawnCalls[1].pid); // issue:102 quick-exits — a DIFFERENT unit
    h.tick();

    expect(h.state().paused).toBe(true);
    expect(h.state().consecutive_suspect_dispatches).toBe(2);
    const unhealthyEvent = h.journal.read().find((e) => e.event === 'dispatch-unhealthy');
    expect(unhealthyEvent).toBeDefined();
    // both units are named — not just the one that tipped the count over.
    expect(unhealthyEvent?.detail).toContain('issue:101');
    expect(unhealthyEvent?.detail).toContain('issue:102');
    // 103 never dispatches while paused, even though a slot is free again.
    expect(h.state().entries.find((e) => e.issue === 103)?.status).not.toBe('dispatched');
    // the already-recovering units 101/102 are untouched by the pause.
    expect(h.state().entries.find((e) => e.issue === 101)?.tier).toBe('mid');
    expect(h.state().entries.find((e) => e.issue === 102)?.tier).toBe('mid');
  });

  it('a verified completion resets the consecutive-suspect counter', () => {
    const h = harness({ maxSlots: 2 });
    REGISTRIES.push(h.dir);
    h.enqueue([
      { issue: 101, mode: 'full', tier: 'mechanical' },
      { issue: 102, mode: 'full', tier: 'mechanical' },
    ]);
    h.tick();

    h.alive.delete(h.spawnCalls[0].pid); // issue:101 suspect-exits
    h.tick();
    expect(h.state().consecutive_suspect_dispatches).toBe(1);

    // issue:102 finishes for real (verified) before any second suspect exit.
    h.alive.delete(h.spawnCalls[1].pid);
    h.setMilestone(102, 'report', 'done');
    h.tick();

    expect(h.state().entries.find((e) => e.issue === 102)?.status).toBe('done');
    expect(h.state().consecutive_suspect_dispatches).toBe(0);
    expect(h.state().last_suspect_dispatch_unit).toBeNull();
    expect(h.state().paused).toBe(false);
  });

  it('already paused: a further suspect exit does not re-journal dispatch-unhealthy', () => {
    const h = harness({ maxSlots: 3 });
    REGISTRIES.push(h.dir);
    h.enqueue([
      { issue: 101, mode: 'full', tier: 'mechanical' },
      { issue: 102, mode: 'full', tier: 'mechanical' },
      { issue: 103, mode: 'full', tier: 'mechanical' },
    ]);
    h.tick();
    h.alive.delete(h.spawnCalls[0].pid);
    h.tick();
    h.alive.delete(h.spawnCalls[1].pid);
    h.tick();
    expect(h.state().paused).toBe(true);
    const unhealthyCount = h.journal.read().filter((e) => e.event === 'dispatch-unhealthy').length;
    expect(unhealthyCount).toBe(1);

    h.alive.delete(h.spawnCalls[2].pid); // issue:103, a third distinct unit, also suspect
    h.tick();

    expect(h.state().paused).toBe(true); // still paused, unchanged
    const unhealthyCountAfter = h.journal
      .read()
      .filter((e) => e.event === 'dispatch-unhealthy').length;
    expect(unhealthyCountAfter).toBe(1); // not re-journaled — already paused
  });

  it('a verified park also resets the consecutive-suspect counter, same as a completion', () => {
    const h = harness({ maxSlots: 2 });
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full', tier: 'mechanical' }]);
    h.tick();
    h.alive.delete(h.spawnCalls[0].pid); // issue:101 suspect-exits
    h.tick();
    expect(h.state().consecutive_suspect_dispatches).toBe(1);

    parkUnit(h, 102, 77); // issue:102 dispatches and parks cleanly (a healthy dispatch)

    expect(h.state().consecutive_suspect_dispatches).toBe(0);
    expect(h.state().last_suspect_dispatch_unit).toBeNull();
  });

  it('report-agent dispatch is also paused — a report is a NEW assignment too', () => {
    const h = harness({ maxSlots: 3 });
    REGISTRIES.push(h.dir);
    h.enqueue([
      { issue: 101, mode: 'full', tier: 'mechanical' },
      { issue: 102, mode: 'full', tier: 'mechanical' },
    ]);
    h.tick();
    h.alive.delete(h.spawnCalls[0].pid); // issue:101 suspect-exits
    h.tick();
    h.alive.delete(h.spawnCalls[1].pid); // issue:102 suspect-exits — pauses
    h.tick();
    expect(h.state().paused).toBe(true);

    // A third, unrelated unit ships and is ready for its report agent.
    h.enqueue([{ issue: 103, mode: 'full', tier: 'mid' }]);
    h.store.withLock((state) => ({
      state: {
        ...state,
        entries: state.entries.map((e) =>
          e.issue === 103
            ? { ...e, status: 'shipped' as const, pr: 55, cleanup: 'done' as const }
            : e
        ),
      },
      result: null,
    }));
    const spawnCountBefore = h.spawnCalls.length;
    const result = h.tick();

    expect(result.reportDispatched).toHaveLength(0);
    expect(h.spawnCalls).toHaveLength(spawnCountBefore); // no new agent spawned
    expect(result.reportWaiting).toBe(1);
    expect(h.state().slots.find((s) => s.unit === 'issue:103')).toBeUndefined();
  });
});

describe('spawn failures (supportability)', () => {
  it('a throwing spawn fails the unit visibly instead of aborting the whole tick', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([
      { issue: 101, mode: 'full', tier: 'mid' },
      { issue: 102, mode: 'full', tier: 'mid' },
    ]);

    // The FIRST spawn throws (bad dispatch command); the second unit still dispatches.
    let calls = 0;
    const realSpawn = h.deps.spawnDeps.spawn;
    const throwingSpawn = (cmd: string[], prompt: string, logFile: string): number => {
      calls++;
      if (calls === 1) throw new Error("failed to spawn 'claude' — is it on PATH?");
      return realSpawn(cmd, prompt, logFile);
    };
    h.deps.spawnDeps = { ...h.deps.spawnDeps, spawn: throwingSpawn };

    const result = h.tick();

    expect(result.failed).toEqual(['issue:101']);
    expect(result.spawned).toEqual(['issue:102']);
    const state = h.state();
    expect(state.entries.find((e) => e.issue === 101)?.status).toBe('failed');
    expect(state.entries.find((e) => e.issue === 101)?.reason).toMatch(/spawn-error/);
    expect(state.entries.find((e) => e.issue === 102)?.status).toBe('dispatched');
    expect(h.journal.read().some((e) => e.event === 'unit-failed')).toBe(true);
  });
});

describe('status surface (AC6)', () => {
  it('sched status renders live phase per running unit', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full' }]);
    h.tick();
    h.setMilestone(101, 'review', 'done');
    h.tick();

    const report = buildStatusReport(h.state(), h.config, 'proj');
    const slot = report.slots.find((s) => s.unit === 'issue:101');
    expect(slot?.status).toBe('running');
    expect(slot?.phase).toBe('review');
    expect(slot?.pid).toBe(h.spawnCalls[0].pid);
    expect(slot?.last_progress_at).not.toBeNull();
  });
});

describe('tier progression across the ladder', () => {
  it('models are mechanical→mid→strong across successive redispatches', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full', tier: 'mechanical' }]);
    h.tick();

    const models: string[] = [h.spawnCalls[0].cmd[h.spawnCalls[0].cmd.length - 1]];
    for (let i = 0; i < 2; i++) {
      h.alive.delete(h.spawnCalls[h.spawnCalls.length - 1].pid); // agent exits, nothing done
      h.tick();
      models.push(h.spawnCalls[h.spawnCalls.length - 1].cmd[h.spawnCalls[0].cmd.length - 1]);
    }
    expect(models).toEqual(['haiku', 'sonnet', 'opus']);

    // third unverified exit hits the cap
    h.alive.delete(h.spawnCalls[h.spawnCalls.length - 1].pid);
    const result = h.tick();
    expect(result.failed).toEqual(['issue:101']);
  });
});

// --- #468: PR watching + script-based tail work ---

/** Drive one unit to parked: enqueue → dispatch → agent parks PR #pr → exits. */
function parkUnit(h: ReturnType<typeof harness>, issue: number, pr: number): void {
  h.enqueue([{ issue, mode: 'full', tier: 'mid' }]);
  h.tick(); // dispatch
  h.setMilestone(issue, 'setup', 'done', undefined, {
    branch: `feature/${issue}-x`,
    worktree: `/tmp/wt-${issue}`,
    pool_claimed: 'false',
  });
  h.milestones.set(issue, parkMilestone(pr));
  h.alive.delete(h.spawnCalls[h.spawnCalls.length - 1].pid); // agent exits after parking
  const result = h.tick();
  expect(result.parked).toEqual([`issue:${issue}`]);
  const entry = h.state().entries.find((e) => e.issue === issue);
  expect(entry?.status).toBe('parked');
  expect(entry?.pr).toBe(pr);
}

/** A teardown script that removes `worktree` from git's listing on `git worktree remove`. */
function removingTeardown(worktree: string): (file: string, args: string[]) => string | null {
  let removed = false;
  return (file, args) => {
    if (file === 'git' && args[0] === 'worktree' && args[1] === 'list') {
      return removed
        ? 'worktree /repo/main\nHEAD abc\n'
        : `worktree /repo/main\nworktree ${worktree}\n`;
    }
    if (file === 'git' && args[1] === 'remove') {
      removed = true;
      return '';
    }
    return null;
  };
}

describe('#468 AC1/AC5: parking and the PR watcher', () => {
  it('an agent exiting on an awaiting-merge milestone parks the unit and frees its slot', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    parkUnit(h, 101, 55);
    // AC5: a waiting unit consumes zero slots
    const state = h.state();
    expect(state.slots.filter((s) => s.unit === 'issue:101')).toHaveLength(0);
    expect(state.slots.every((s) => s.status === 'idle')).toBe(true);
    // the park is journaled
    expect(h.events().some((e) => e.event === 'pr-parked' && e.issue === 101)).toBe(true);
  });

  it('a parked PR never unblocks dependents; MERGE does (AC4)', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([
      { issue: 101, mode: 'full', tier: 'mid' },
      { issue: 102, mode: 'full', tier: 'mid', deps: [101] },
    ]);
    h.tick(); // 101 dispatched (102 dep-blocked)
    expect(h.spawnCalls).toHaveLength(1);

    // 101 parks
    h.milestones.set(101, parkMilestone(55));
    h.alive.delete(h.spawnCalls[0].pid);
    h.tick();
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('parked');

    // while parked: 102 still blocked (parking is not merging)
    h.setPr(55, { state: 'OPEN' });
    h.advance(200_000);
    h.tick();
    expect(h.spawnCalls).toHaveLength(1); // 102 never dispatched
    expect(h.state().entries.find((e) => e.issue === 102)?.status).toBe('queued');

    // the PR merges and the issue closes → 102 becomes runnable
    h.setPr(55, { state: 'MERGED', mergedAt: '2026-08-29T12:30:00Z' });
    h.closedIssues.add(101);
    h.setupInfos.set(101, { worktree: h.wt('wt-101'), poolClaimed: false, branch: 'f/101' });
    h.setTeardownScript(removingTeardown(h.wt('wt-101')));
    h.advance(200_000);
    const result = h.tick();
    expect(result.mergeAccepted).toEqual(['issue:101']);
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('shipped');
    // 102 dispatched in the same tick (or the report agent holds the slot first)
    const later = h.spawnCalls.map((c) => c.prompt).join('\n');
    expect(later).toContain('#102');
  });

  it('merge acceptance requires the issue to be closed too (AC1)', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    parkUnit(h, 101, 55);

    // PR merged, issue still open → NOT accepted, and the wait is journaled
    h.setPr(55, { state: 'MERGED', mergedAt: '2026-08-29T12:30:00Z' });
    h.advance(200_000);
    let result = h.tick();
    expect(result.mergeAccepted).toEqual([]);
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('parked');
    expect(h.events().some((e) => e.event === 'pr-watch-waiting' && e.issue === 101)).toBe(true);

    // issue closes → accepted
    h.closedIssues.add(101);
    h.setupInfos.set(101, { worktree: h.wt('wt-101'), poolClaimed: false, branch: 'f/101' });
    h.setTeardownScript(removingTeardown(h.wt('wt-101')));
    h.advance(200_000);
    result = h.tick();
    expect(result.mergeAccepted).toEqual(['issue:101']);
  });

  it('a report that cannot get a slot waits visibly and consumes zero slots', () => {
    const h = harness({ maxSlots: 1 });
    REGISTRIES.push(h.dir);
    // 101 parks first (its park frees the only slot)…
    parkUnit(h, 101, 55);
    // …and a long full-cycle unit takes it over before the merge lands
    h.enqueue([{ issue: 201, mode: 'full', tier: 'mid' }]);
    h.tick(); // dispatch 201

    h.setPr(55, { state: 'MERGED', mergedAt: '2026-08-29T12:30:00Z' });
    h.closedIssues.add(101);
    h.setupInfos.set(101, { worktree: h.wt('wt-101'), poolClaimed: false, branch: 'f/101' });
    h.setTeardownScript(removingTeardown(h.wt('wt-101')));
    h.advance(200_000);

    const result = h.tick();
    expect(result.mergeAccepted).toEqual(['issue:101']);
    expect(result.teardownDone).toEqual(['issue:101']);
    expect(result.reportDispatched).toEqual([]); // no free slot
    expect(result.reportWaiting).toBe(1); // visible, not silent
    // the merged unit holds NO slot while waiting (AC5)
    expect(h.state().slots.filter((s) => s.unit === 'issue:101')).toHaveLength(0);
  });

  it('the poll cadence is honored: no PR poll before pr_poll_interval_ms elapses', () => {
    const h = harness({ prPollIntervalMs: 150_000 });
    REGISTRIES.push(h.dir);
    parkUnit(h, 101, 55);
    h.setPr(55, { state: 'OPEN' });

    // first poll happens (last_pr_poll_at was null)
    const first = h.tick();
    expect(first.parked).toEqual([]);
    expect(h.state().last_pr_poll_at).toBe(h.clock().toISOString());
    const polledAt = h.state().last_pr_poll_at;

    // before the interval elapses, a MERGED PR is not even looked at
    h.setPr(55, { state: 'MERGED', mergedAt: '2026-08-29T12:30:00Z' });
    h.closedIssues.add(101);
    h.advance(60_000);
    h.tick();
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('parked');
    expect(h.state().last_pr_poll_at).toBe(polledAt);

    // after the interval, the merge is seen
    h.advance(120_000);
    h.setupInfos.set(101, { worktree: h.wt('wt-101'), poolClaimed: false, branch: 'f/101' });
    h.setTeardownScript(removingTeardown(h.wt('wt-101')));
    const result = h.tick();
    expect(result.mergeAccepted).toEqual(['issue:101']);
  });

  it('an unreachable PR poll pauses the watcher (decision 2, option A)', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    parkUnit(h, 101, 55);
    h.prUnreachable.add(55);
    h.advance(200_000);
    const result = h.tick();
    expect(result.mergeAccepted).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('parked');
    expect(h.events().some((e) => e.event === 'ground-truth-unreachable' && e.issue === 101)).toBe(
      true
    );
  });
});

describe('#468 AC2: teardown + report dispatch on merge', () => {
  /** Park 101 (PR 55), then merge + close + provide setup info. */
  function mergedUnit(h: ReturnType<typeof harness>): void {
    parkUnit(h, 101, 55);
    h.setPr(55, { state: 'MERGED', mergedAt: '2026-08-29T12:30:00Z' });
    h.closedIssues.add(101);
    h.setupInfos.set(101, { worktree: h.wt('wt-101'), poolClaimed: false, branch: 'f/101' });
    h.setTeardownScript(removingTeardown(h.wt('wt-101')));
    h.advance(200_000);
  }

  it('merged → teardown script runs (verified) → cheap-tier report agent dispatched', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    mergedUnit(h);

    const result = h.tick();
    expect(result.mergeAccepted).toEqual(['issue:101']);

    const state = h.state();
    const entry = state.entries.find((e) => e.issue === 101);
    expect(entry?.status).toBe('shipped');
    expect(entry?.cleanup).toBe('done'); // verified before claimed

    // teardown ran as a script: git worktree remove --force
    const removeCall = h.teardownCalls.find((c) => c.file === 'git' && c.args[1] === 'remove');
    expect(removeCall?.args).toContain('--force');
    expect(removeCall?.args).toContain(h.wt('wt-101'));
    expect(removeCall?.cwd).toBe(h.dir); // repoDir

    // teardown-done journaled
    expect(h.events().some((e) => e.event === 'teardown-done' && e.issue === 101)).toBe(true);

    // a report agent was dispatched on a slot in the SAME tick
    expect(result.reportDispatched).toEqual(['issue:101']);
    const reportSpawn = h.spawnCalls[h.spawnCalls.length - 1];
    expect(reportSpawn.cmd.join(' ')).toMatch(/haiku/); // cheap tier (mechanical)
    expect(reportSpawn.prompt).toContain('report');
    expect(reportSpawn.prompt).toContain('#101');
    expect(reportSpawn.prompt).toContain('#55');
    expect(reportSpawn.prompt).toContain('done');
    const slot = state.slots.find((s) => s.unit === 'issue:101');
    expect(slot?.status).toBe('running');
    expect(slot?.phase).toBe('report');
  });

  it('pool-claimed worktrees return to the pool (verified via the pool self-check)', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    parkUnit(h, 101, 55);
    h.setPr(55, { state: 'MERGED', mergedAt: '2026-08-29T12:30:00Z' });
    h.closedIssues.add(101);
    h.setupInfos.set(101, { worktree: '/pool/wt-101', poolClaimed: true, branch: 'f/101' });
    h.advance(200_000);
    h.setTeardownScript((file, args) => {
      if (file === 'npx' && args[2] === 'status') {
        return JSON.stringify({ worktrees: [] });
      }
      if (file === 'npx' && args[2] === 'return') {
        return JSON.stringify({
          id: 'wt-9',
          path: '/pool/wt-9',
          verification: {
            entry_status: 'warm',
            directory_clean: true,
            checked_out_branch: 'pool/spare-9',
            expected_branch: 'pool/spare-9',
          },
        });
      }
      return null;
    });

    const result = h.tick();
    expect(result.mergeAccepted).toEqual(['issue:101']);
    expect(h.state().entries.find((e) => e.issue === 101)?.cleanup).toBe('done');
    const returnCall = h.teardownCalls.find((c) => c.file === 'npx' && c.args[2] === 'return');
    expect(returnCall?.args).toContain('--path');
    expect(returnCall?.args).toContain('/pool/wt-101');
  });

  it('a failed teardown records cleanup=failed-<step> and the report still dispatches', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    parkUnit(h, 101, 55);
    h.setPr(55, { state: 'MERGED', mergedAt: '2026-08-29T12:30:00Z' });
    h.closedIssues.add(101);
    h.setupInfos.set(101, { worktree: h.wt('wt-101'), poolClaimed: false, branch: 'f/101' });
    h.advance(200_000);
    // the remove keeps failing AND the worktree stays listed → failed step
    h.setTeardownScript((file, args) => {
      if (file === 'git' && args[1] === 'list')
        return `worktree /repo/main\nworktree ${h.wt('wt-101')}\n`;
      if (file === 'git' && args[1] === 'remove') return '';
      return null;
    });

    const result = h.tick();
    expect(result.reportDispatched).toEqual(['issue:101']); // report regardless
    const entry = h.state().entries.find((e) => e.issue === 101);
    expect(entry?.status).toBe('shipped');
    expect(entry?.cleanup).toBe('failed-worktree-remove');
    expect(h.events().some((e) => e.event === 'teardown-failed' && e.issue === 101)).toBe(true);
    // the failure is surfaced to the report agent
    const reportSpawn = h.spawnCalls[h.spawnCalls.length - 1];
    expect(reportSpawn.prompt).toContain('failed-worktree-remove');
  });

  it('missing setup info records failed-missing-setup-info; unreachable defers to the next tick', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    parkUnit(h, 101, 55);
    h.setPr(55, { state: 'MERGED', mergedAt: '2026-08-29T12:30:00Z' });
    h.closedIssues.add(101);
    h.advance(200_000);

    // verifiably no setup milestone → failed step, report dispatched
    h.setupInfos.set(101, null);
    let result = h.tick();
    expect(h.state().entries.find((e) => e.issue === 101)?.cleanup).toBe(
      'failed-missing-setup-info'
    );
    expect(result.reportDispatched).toEqual(['issue:101']);

    // unreachable → teardown deferred (cleanup stays null), retried later
    parkUnit(h, 202, 66);
    h.setPr(66, { state: 'MERGED', mergedAt: '2026-08-29T12:40:00Z' });
    h.closedIssues.add(202);
    h.advance(200_000);
    h.setupUnreachable.add(202);
    result = h.tick();
    const entry202 = h.state().entries.find((e) => e.issue === 202);
    expect(entry202?.status).toBe('shipped');
    expect(entry202?.cleanup).toBeNull(); // deferred, not failed
    expect(result.reportDispatched).toEqual([]); // no report before teardown is attempted
    expect(h.events().some((e) => e.event === 'ground-truth-unreachable' && e.issue === 202)).toBe(
      true
    );
  });

  it('the report agent completes the unit: report-done milestone → shipped → done', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    mergedUnit(h);
    h.tick(); // merge accepted + teardown + report dispatched

    // the report agent posts its final milestone and exits
    h.milestones.set(101, {
      phase: 'report',
      status: 'done',
      run: 'r-101-x',
      at: h.clock().toISOString(),
      keys: {},
    });
    h.alive.delete(h.spawnCalls[h.spawnCalls.length - 1].pid);
    const result = h.tick();
    expect(result.completed).toEqual(['issue:101']);
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('done');
    expect(h.state().slots.every((s) => s.status === 'idle')).toBe(true);
  });

  it('a dead report agent is redispatched up the report ladder, then fails WITHOUT blocking dependents', () => {
    const h = harness({ stallTimeoutMs: 1000 });
    REGISTRIES.push(h.dir);
    mergedUnit(h);
    h.tick(); // report agent #1 (mechanical/haiku)

    // report agent dies without posting anything — redispatched at mid
    h.alive.delete(h.spawnCalls[h.spawnCalls.length - 1].pid);
    let result = h.tick();
    expect(result.redispatched).toEqual(['issue:101']);
    expect(h.spawnCalls[h.spawnCalls.length - 1].cmd.join(' ')).toMatch(/sonnet/);

    // dies again → strong
    h.alive.delete(h.spawnCalls[h.spawnCalls.length - 1].pid);
    result = h.tick();
    expect(result.redispatched).toEqual(['issue:101']);
    expect(h.spawnCalls[h.spawnCalls.length - 1].cmd.join(' ')).toMatch(/opus/);

    // dies a third time → cap → the REPORT failed but the unit is MERGED:
    // entry completes (done, reason recorded), dependents stay released
    h.enqueue([{ issue: 102, mode: 'full', tier: 'mid', deps: [101] }]);
    h.alive.delete(h.spawnCalls[h.spawnCalls.length - 1].pid);
    result = h.tick();
    expect(result.failed).toEqual(['issue:101']);
    expect(result.blocked).toEqual([]); // merged — dependents stay released
    expect(h.events().some((e) => e.event === 'report-failed' && e.issue === 101)).toBe(true);
    const entry101 = h.state().entries.find((e) => e.issue === 101);
    expect(entry101?.status).toBe('done'); // work is merged — the unit completes
    expect(entry101?.reason).toBe('report-escalation-cap');
    // 102 was never blocked by the report failure — it dispatches against the merged dep
    expect(h.state().entries.find((e) => e.issue === 102)?.status).toBe('dispatched');
  });

  it('a running report agent is never killed by the already-closed issue (report completion is milestone-only)', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    mergedUnit(h);
    h.tick(); // report dispatched; issue 101 is closed (merged) the whole time

    // the report agent is alive and mid-work; the issue being closed must NOT
    // external-advance it (its completion is the report milestone only)
    const result = h.tick();
    expect(result.externalAdvances).toEqual([]);
    const slot = h.state().slots.find((s) => s.unit === 'issue:101');
    expect(slot?.status).toBe('running');
    expect(h.killedPids).toHaveLength(0);
  });

  it('#500: an exit after phase-updated corrupts slot.phase still requires the report milestone (role survives the resync)', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    mergedUnit(h); // leaves issue 101's latest milestone at ship/awaiting-merge (the park milestone)
    h.tick(); // report agent A dispatched — slot.phase = slot.role = 'report'

    // No report milestone is ever posted. A reconcile tick while agent A is
    // still alive resyncs slot.phase to the issue's latest (still
    // ship/awaiting-merge) milestone — the `phase-updated` corruption from
    // the bug report's events.jsonl (`phase-updated issue:3891 phase=ship`).
    h.tick();
    expect(h.events().some((e) => e.event === 'phase-updated' && e.issue === 101)).toBe(true);
    const corrupted = h.state().slots.find((s) => s.unit === 'issue:101');
    expect(corrupted?.phase).toBe('ship'); // phase drifted off 'report'...
    expect(corrupted?.role).toBe('report'); // ...but role did not

    // Agent A now exits WITHOUT ever posting a report milestone (crash,
    // #497-style exit-while-waiting) — exactly `exit-detected (agent B exits
    // "waiting for the deploy run") → verify-complete` from the bug report.
    // Completion must still require the report milestone, not silently fall
    // back to the issue's already-closed status.
    h.alive.delete(h.spawnCalls[h.spawnCalls.length - 1].pid);
    const result = h.tick();
    expect(result.completed).toEqual([]);
    expect(result.externalAdvances).toEqual([]);
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('shipped'); // not done
    // unverified exit → redispatched up the report ladder, not silently completed
    expect(result.redispatched).toEqual(['issue:101']);

    // AC3: the redispatch itself exercises the other two role-vs-phase call
    // sites (`enterRecovery`'s report ladder, `spawnUnit`'s respawn check) —
    // both must still recognize this as a report agent despite the phase
    // corruption. A cycle-path misfire would spawn a full-cycle `gate` agent
    // with a completely different prompt/tier-selection instead.
    const respawn = h.spawnCalls[h.spawnCalls.length - 1];
    expect(respawn.prompt).toContain('report');
    expect(respawn.cmd.join(' ')).toMatch(/sonnet/); // report ladder: mechanical → mid, not the cycle ladder
    const redispatchedSlot = h.state().slots.find((s) => s.unit === 'issue:101');
    expect(redispatchedSlot?.phase).toBe('report'); // respawn re-sets phase to 'report'
    expect(redispatchedSlot?.role).toBe('report');

    // The real report milestone still completes it normally.
    h.milestones.set(101, {
      phase: 'report',
      status: 'done',
      run: 'r-101-x',
      at: h.clock().toISOString(),
      keys: {},
    });
    h.alive.delete(h.spawnCalls[h.spawnCalls.length - 1].pid);
    const final = h.tick();
    expect(final.completed).toEqual(['issue:101']);
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('done');
  });
});

describe('#468 AC3: watcher failure paths', () => {
  it('CONFLICTING → failed with reason + transitive dependents blocked', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([
      { issue: 101, mode: 'full', tier: 'mid' },
      { issue: 102, mode: 'full', tier: 'mid', deps: [101] },
      { issue: 103, mode: 'full', tier: 'mid', deps: [102] }, // transitive
    ]);
    h.tick(); // 101 dispatched
    h.milestones.set(101, parkMilestone(55));
    h.alive.delete(h.spawnCalls[0].pid);
    h.tick(); // parked

    h.setPr(55, { state: 'OPEN', mergeable: 'CONFLICTING' });
    h.advance(200_000);
    const result = h.tick();

    expect(result.failed).toEqual(['issue:101']);
    expect(result.blocked).toEqual([102, 103]); // transitive
    const state = h.state();
    expect(state.entries.find((e) => e.issue === 101)?.reason).toBe('pr-conflicting');
    expect(state.entries.find((e) => e.issue === 102)?.status).toBe('blocked');
    expect(state.entries.find((e) => e.issue === 103)?.status).toBe('blocked');
    expect(h.events().some((e) => e.event === 'pr-watch-failed' && e.issue === 101)).toBe(true);
  });

  it('closed-unmerged → failed with reason', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    parkUnit(h, 101, 55);
    h.setPr(55, { state: 'CLOSED' });
    h.advance(200_000);
    const result = h.tick();
    expect(result.failed).toEqual(['issue:101']);
    expect(h.state().entries.find((e) => e.issue === 101)?.reason).toBe('pr-closed-unmerged');
  });

  it('auto-merge-blocked label → failed with reason', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    parkUnit(h, 101, 55);
    h.setPr(55, { state: 'OPEN', blocked: true });
    h.advance(200_000);
    const result = h.tick();
    expect(result.failed).toEqual(['issue:101']);
    expect(h.state().entries.find((e) => e.issue === 101)?.reason).toBe('auto-merge-blocked');
  });

  it('OPEN and mergeable keeps watching (no failure, no slots)', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    parkUnit(h, 101, 55);
    h.setPr(55, { state: 'OPEN' });
    h.advance(200_000);
    const result = h.tick();
    expect(result.failed).toEqual([]);
    expect(result.mergeAccepted).toEqual([]);
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('parked');
    expect(h.state().slots.every((s) => s.status === 'idle')).toBe(true);
  });
});

describe('#468 AC6: restart mid-watch', () => {
  it('a fresh engine instance resumes the watch from state.json alone', () => {
    const first = harness();
    REGISTRIES.push(first.dir);
    parkUnit(first, 101, 55);
    // engine "dies" — a brand-new instance (new store/journal/fakes) takes over
    const h = harness({}, first.dir);
    REGISTRIES.push(h.dir);

    // state survived: parked, pr recorded, zero live slots
    const loaded = h.state();
    expect(loaded.entries.find((e) => e.issue === 101)?.status).toBe('parked');
    expect(loaded.entries.find((e) => e.issue === 101)?.pr).toBe(55);

    // the new instance watches from the persisted state — merge accepted on its tick
    h.setPr(55, { state: 'MERGED', mergedAt: '2026-08-29T12:30:00Z' });
    h.closedIssues.add(101);
    h.setupInfos.set(101, { worktree: h.wt('wt-101'), poolClaimed: false, branch: 'f/101' });
    h.setTeardownScript(removingTeardown(h.wt('wt-101')));
    h.advance(200_000);
    const result = h.tick();
    expect(result.mergeAccepted).toEqual(['issue:101']);
    expect(h.state().entries.find((e) => e.issue === 101)?.cleanup).toBe('done');
    expect(result.reportDispatched).toEqual(['issue:101']);

    // report completes
    h.milestones.set(101, {
      phase: 'report',
      status: 'done',
      run: 'r-101-x',
      at: h.clock().toISOString(),
      keys: {},
    });
    h.alive.delete(h.spawnCalls[h.spawnCalls.length - 1].pid);
    h.tick();
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('done');
  });

  it('the PR poll cadence survives the restart (last_pr_poll_at persisted)', () => {
    const first = harness({ prPollIntervalMs: 150_000 });
    REGISTRIES.push(first.dir);
    parkUnit(first, 101, 55);
    first.setPr(55, { state: 'OPEN' });
    first.tick(); // polls now
    const polledAt = first.state().last_pr_poll_at;
    expect(polledAt).not.toBeNull();

    // restart + only 60s pass: no re-poll (the merge is invisible)
    const h = harness({ prPollIntervalMs: 150_000 }, first.dir);
    REGISTRIES.push(h.dir);
    h.setPr(55, { state: 'MERGED', mergedAt: '2026-08-29T12:30:00Z' });
    h.closedIssues.add(101);
    h.advance(60_000);
    h.tick();
    expect(h.state().last_pr_poll_at).toBe(polledAt);
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('parked');

    // after the interval: seen
    h.advance(120_000);
    h.setupInfos.set(101, { worktree: h.wt('wt-101'), poolClaimed: false, branch: 'f/101' });
    h.setTeardownScript(removingTeardown(h.wt('wt-101')));
    expect(h.tick().mergeAccepted).toEqual(['issue:101']);
  });
});
