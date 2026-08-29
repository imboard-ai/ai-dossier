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
  type SchedConfig,
  SchedStore,
  type SpawnDeps,
  tick,
} from '../index';

/**
 * Engine harness: a real SchedStore on a temp dir, fully fake process I/O
 * (spawn/kill/isAlive backed by a pid counter and a liveness set), and
 * scriptable ground truth. No subprocesses, no LLM calls.
 */
function harness(opts?: { maxSlots?: number; stallTimeoutMs?: number }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-engine-'));
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
  };

  const milestones = new Map<number, GroundTruthMilestone | null>();
  const closedIssues = new Set<number>();
  const branchHeads = new Map<string, string>();
  const groundTruth: GroundTruth = {
    latestMilestone: (issue) => milestones.get(issue) ?? null,
    issueClosed: (issue) => closedIssues.has(issue),
    branchHead: (branch) => branchHeads.get(branch) ?? null,
  };

  let clock = new Date('2026-08-29T12:00:00Z');
  const deps: EngineDeps = {
    store,
    journal,
    groundTruth,
    spawnDeps,
    now: () => clock,
  };

  const config: SchedConfig = {
    max_slots: opts?.maxSlots ?? 3,
    ...(opts?.stallTimeoutMs !== undefined ? { stall_timeout_ms: opts.stallTimeoutMs } : {}),
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
    config,
    deps,
    enqueue: (inputs: EnqueueInput[]) =>
      store.withLock((state) => ({ state: enqueueEntries(state, inputs, clock), result: null })),
    tick: () => tick(deps, config),
    state: () => store.load(),
    setMilestone: (issue: number, phase: string, status = 'done', at?: string) =>
      milestones.set(issue, {
        phase,
        status,
        run: `r-${issue}-x`,
        at: at ?? clock.toISOString(),
        keys: {},
      }),
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    clock: () => clock,
  };
}

const REGISTRIES: string[] = [];
afterEach(() => {
  for (const dir of REGISTRIES.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('dispatch (AC1: spawn with --model per tier; pid/phase/progress in state.json)', () => {
  beforeEach(() => {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (name.startsWith('sched-engine-')) {
        fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
      }
    }
  });

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
