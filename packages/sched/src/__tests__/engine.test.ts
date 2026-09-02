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
  type JournalEvent,
  type PrTruth,
  type RunFencer,
  type SchedConfig,
  SchedStore,
  type SetupInfo,
  type SlotReleaseReason,
  type SpawnDeps,
  schedRunsLogPath,
  setPaused,
  tick,
  transitionIssue,
} from '../index';

/**
 * Engine harness: a real SchedStore on a temp dir, fully fake process I/O
 * (spawn/kill/isAlive backed by a pid counter and a liveness set), and
 * scriptable ground truth. No subprocesses, no LLM calls. Since #468 the
 * ground truth is also scriptable for PR states and setup info, and the
 * teardown exec is a recording fake.
 */
function harness(
  opts?: {
    maxSlots?: number;
    stallTimeoutMs?: number;
    phaseStallTimeoutMs?: Record<string, number>;
    prPollIntervalMs?: number;
    labelPollIntervalMs?: number;
    fenceTakeoverTimeoutMs?: number;
  },
  existingDir?: string
) {
  const dir = existingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sched-engine-'));
  const store = new SchedStore(dir);
  const journal = new Journal(dir);
  // #524: runs.jsonl telemetry writes under EngineDeps.homeDir — a fresh
  // tmp dir per harness, so no test ever touches the real machine's
  // ~/.dossier (every dead-pid/external-advance exit now appends an entry).
  // Registered for cleanup automatically — individual tests don't opt in.
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-engine-home-'));
  REGISTRIES.push(homeDir);

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
  /** #544: hard-block labels per issue (absent = no labels), and the read log. */
  const labelsByIssue = new Map<number, string[]>();
  const labelUnreachable = new Set<number>();
  const labelReads: number[] = [];
  let onLabelRead: ((issue: number) => void) | undefined;
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
    issueLabels: (issue) => {
      labelReads.push(issue);
      // #544: `pollLabels` runs OUTSIDE the lock, so a test needs a way to
      // mutate state between the read and the lock pass that consumes it.
      onLabelRead?.(issue);
      return labelUnreachable.has(issue) ? undefined : (labelsByIssue.get(issue) ?? []);
    },
  };
  const teardownExec = (file: string, args: string[], cwd?: string): string | null => {
    teardownCalls.push({ file, args, cwd });
    return teardownScript(file, args);
  };

  /**
   * Recording fake fencer (#504): monotonic per-run generations, and a switch to make
   * the fence fail so the degraded redispatch path is exercised. `spawnsBefore` is what
   * pins the ORDER the ladder must keep — the fence is written before the takeover
   * exists, so it survives the takeover dying too.
   */
  const fenceCalls: Array<{
    issue: number;
    run: string;
    phase: string;
    takeover: string;
    spawnsBefore: number;
  }> = [];
  const fenceGens = new Map<string, number>();
  let fenceFails = false;
  const fencer: RunFencer = (issue, run, phase, takeover) => {
    fenceCalls.push({ issue, run, phase, takeover, spawnsBefore: spawnCalls.length });
    if (fenceFails) return { ok: false, reason: 'fake fencer told to fail' };
    const gen = (fenceGens.get(run) ?? 0) + 1;
    fenceGens.set(run, gen);
    return { ok: true, gen };
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
    fencer,
    homeDir,
  };

  const config: SchedConfig = {
    max_slots: opts?.maxSlots ?? 3,
    ...(opts?.stallTimeoutMs !== undefined ? { stall_timeout_ms: opts.stallTimeoutMs } : {}),
    ...(opts?.prPollIntervalMs !== undefined ? { pr_poll_interval_ms: opts.prPollIntervalMs } : {}),
    ...(opts?.labelPollIntervalMs !== undefined
      ? { label_poll_interval_ms: opts.labelPollIntervalMs }
      : {}),
    ...(opts?.phaseStallTimeoutMs !== undefined || opts?.fenceTakeoverTimeoutMs !== undefined
      ? {
          dispatch: {
            ...(opts?.phaseStallTimeoutMs !== undefined
              ? { phase_stall_timeout_ms: opts.phaseStallTimeoutMs }
              : {}),
            ...(opts?.fenceTakeoverTimeoutMs !== undefined
              ? { fence_takeover_timeout_ms: opts.fenceTakeoverTimeoutMs }
              : {}),
          },
        }
      : {}),
  };

  return {
    dir,
    homeDir,
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
    labelsByIssue,
    labelUnreachable,
    labelReads,
    setOnLabelRead: (hook: (issue: number) => void) => {
      onLabelRead = hook;
    },
    teardownCalls,
    fenceCalls,
    setFenceFails: (fails: boolean) => {
      fenceFails = fails;
    },
    /** Drop the fencer entirely — an engine built before #504, or misconfigured. */
    removeFencer: () => {
      deps.fencer = undefined;
    },
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
    /** #525: whether a `slot-released` event for `issue` with `reason` was journaled. */
    hasSlotReleased: (issue: number, reason: SlotReleaseReason) =>
      journal
        .read()
        .some(
          (e: JournalEvent) =>
            e.event === 'slot-released' && e.issue === issue && e.reason === reason
        ),
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
        run: `r-${issue}-ab12`,
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
    // #525: the most common release path — verified completion via a report-done
    // milestone (not external-advance) — journals `slot-released` with reason
    // 'verify-complete', matching the sibling `verify-complete` event, not 'completed'.
    expect(h.events().some((e) => e.event === 'verify-complete' && e.issue === 101)).toBe(true);
    expect(h.hasSlotReleased(101, 'verify-complete')).toBe(true);
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

describe('per-tier dispatch commands (#527 — mixed agent-CLI escalation ladders)', () => {
  it('a fake two-CLI ladder: mid spawns cmd A, an unverified exit escalates and strong spawns cmd B', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    // mid → a cheap fake "opencode" binary with its own model; strong → a
    // different fake "claude" binary with its own model — the AC2 scenario:
    // "a unit can start on one CLI+model and be rescued on another".
    h.config.dispatch = {
      tiers: {
        mid: { command: ['fake-opencode', 'run', '--model', '{model}'], model: 'fake-glm' },
        strong: { command: ['fake-claude', '-p', '--model', '{model}'], model: 'fake-opus' },
      },
    };
    h.enqueue([{ issue: 527, mode: 'full', tier: 'mid' }]);
    h.tick();
    const firstPid = h.spawnCalls[0].pid;

    // mid tier spawned cmd A, with cmd A's own model.
    expect(h.spawnCalls[0].cmd).toEqual(['fake-opencode', 'run', '--model', 'fake-glm']);

    // The agent exits having posted nothing verifiable — exit alone proves nothing,
    // and the ladder redispatches one tier stronger.
    h.alive.delete(firstPid);
    const result = h.tick();

    expect(result.redispatched).toEqual(['issue:527']);
    expect(h.state().entries.find((e) => e.issue === 527)?.tier).toBe('strong');
    expect(h.spawnCalls).toHaveLength(2);
    // strong tier spawned a DIFFERENT binary (cmd B), not cmd A with a new model.
    expect(h.spawnCalls[1].cmd).toEqual(['fake-claude', '-p', '--model', 'fake-opus']);
    expect(h.spawnCalls[1].pid).not.toBe(firstPid);

    // AC3: the redispatched journal event records both the agent CLI and the model.
    const redispatchedEvent = h.events().find((e) => e.event === 'redispatched' && e.issue === 527);
    expect(redispatchedEvent?.cmd).toBe('fake-claude -p --model fake-opus');
    expect(redispatchedEvent?.model).toBe('fake-opus');

    // AC3: the spawned event for the mid-tier dispatch also recorded the model.
    const spawnedEvents = h.events().filter((e) => e.event === 'spawned' && e.issue === 527);
    expect(spawnedEvents[0]?.model).toBe('fake-glm');
    expect(spawnedEvents[1]?.model).toBe('fake-opus');
  });

  it('a per-tier prompt override actually reaches the spawned agent (AC1 — declared+validated+resolved is not enough, it must be consumed)', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.config.dispatch = {
      tiers: { mid: { prompt: 'MID-TIER-CUSTOM-PROMPT for #{issue}' } },
    };
    h.enqueue([{ issue: 527, mode: 'full', tier: 'mid' }]);
    h.tick();

    expect(h.spawnCalls[0].prompt).toContain('MID-TIER-CUSTOM-PROMPT for #527');
    // a tier without its own override still gets the global default prompt
    const h2 = harness();
    REGISTRIES.push(h2.dir);
    h2.enqueue([{ issue: 528, mode: 'full', tier: 'strong' }]);
    h2.tick();
    expect(h2.spawnCalls[0].prompt).not.toContain('MID-TIER-CUSTOM-PROMPT');
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
    // #525: the completion path journals a distinct slot-released event, not just
    // the completion event itself — a report reading the journal can see the slot
    // emptied at 11:38:06Z instead of inferring it from the next `assigned`.
    expect(h.hasSlotReleased(101, 'external-advance')).toBe(true);
    // #525: the cause event is journaled before its release, not after — a reader
    // scanning the trail forward sees why the slot emptied before seeing that it did.
    const events = h.events();
    const causeIdx = events.findIndex((e) => e.event === 'external-advance' && e.issue === 101);
    const releasedIdx = events.findIndex((e) => e.event === 'slot-released' && e.issue === 101);
    expect(causeIdx).toBeGreaterThanOrEqual(0);
    expect(releasedIdx).toBeGreaterThan(causeIdx);
  });

  it(
    '#525 regression: three independent units fill max_slots=3; one finishes via ' +
      'external-advance (issue closed) → a fourth runnable unit is assigned on the very next tick',
    () => {
      const h = harness({ maxSlots: 3 });
      REGISTRIES.push(h.dir);
      h.enqueue([
        { issue: 101, mode: 'full' },
        { issue: 102, mode: 'full' },
        { issue: 103, mode: 'full' },
      ]);
      h.tick();
      expect(h.spawnCalls).toHaveLength(3);
      expect(h.state().slots.every((s) => s.status === 'running')).toBe(true);

      // A fourth independent, runnable unit shows up once all three slots are full —
      // it has to wait for capacity (max_slots=3), same as the pilot's dependency-free
      // dispatch queue.
      h.enqueue([{ issue: 104, mode: 'full' }]);
      const waiting = h.tick();
      expect(waiting.spawned).toHaveLength(0);
      expect(h.state().entries.find((e) => e.issue === 104)?.status).toBe('queued');
      expect(h.spawnCalls).toHaveLength(3);

      // #101 reaches a terminal state via external-advance (its issue closed,
      // mirroring the pilot's #499 "issue closed" event) while its agent still
      // nominally holds the slot.
      h.closedIssues.add(101);

      const result = h.tick();

      expect(result.externalAdvances).toEqual(['issue:101']);
      // The freed slot was reused for #104 in the SAME tick — no 2h44m gap.
      expect(result.spawned).toEqual(['issue:104']);
      expect(h.state().entries.find((e) => e.issue === 104)?.status).toBe('dispatched');
      expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('done');
      // sched status never shows the terminal unit as still running in a slot.
      expect(h.state().slots.some((s) => s.unit === 'issue:101')).toBe(false);
      expect(h.state().slots.filter((s) => s.status === 'running')).toHaveLength(3);
      expect(h.hasSlotReleased(101, 'external-advance')).toBe(true);
    }
  );

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

  /** Spawns issue 101, posts a milestone naming `next` as the in-flight phase, and registers it as progress. */
  function startInPhase(h: ReturnType<typeof stalledHarness>, phase: string, next: string) {
    h.enqueue([{ issue: 101, mode: 'full', tier: 'mechanical' }]);
    h.tick();
    h.setMilestone(101, phase, 'done', undefined, { next });
    h.advance(60_000);
    expect(h.tick().redispatched).toHaveLength(0);
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
    // #524: a stall-killed dispatch is a real, completed dispatch — it must
    // get its own runs.jsonl entry, not silently vanish (the stalled agent
    // never gets a chance to exit on its own, so the dead-pid rail alone
    // would never record it).
    const logFile = schedRunsLogPath(h.homeDir);
    expect(fs.existsSync(logFile)).toBe(true);
    const entries = fs
      .readFileSync(logFile, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ unit: 'issue:101' });
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
    // #525: the failure rail journals a distinct slot-released event for #101 itself.
    // 102/103 never held a slot (blocked before ever being dispatched — a dependent
    // can only run once its dependency is SATISFIED, so `blockTransitiveDependents`'s
    // own slot-release branch is a defensive guard, not reachable via a simple chain
    // like this one): confirm no phantom `slot-released` was journaled for them.
    // The same reachability argument covers #524's `recordDispatchRunLog` call on
    // that branch — it is defensive for the same reason, so no runs.jsonl entry is
    // expected here either.
    expect(h.hasSlotReleased(101, 'unit-failed')).toBe(true);
    const events = h.events().filter((e) => e.event === 'slot-released');
    expect(events.every((e) => e.issue === 101)).toBe(true);
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

  it('the phase now in flight (via next=) gets its own allowance — implement default is 90 min, not the 30-min global (#495)', () => {
    const h = stalledHarness(); // global stall_timeout_ms=30min; implement keeps its 90-min built-in default
    startInPhase(h, 'plan', 'implement');

    h.advance(31 * 60 * 1000); // ~31 min since last progress — past the 30-min global, well under 90 min
    let result = h.tick();
    expect(result.redispatched).toHaveLength(0);

    h.advance(60 * 60 * 1000); // ~91 min since last progress — past the implement allowance
    result = h.tick();
    expect(result.redispatched).toEqual(['issue:101']);
    // the journal records WHICH allowance fired, not just that one did (supportability)
    const stalled = h.journal.read().find((e) => e.event === 'stalled');
    expect(stalled?.active_phase).toBe('implement');
    expect(stalled?.stall_timeout_ms).toBe(90 * 60 * 1000);
  });

  it('a phase without a built-in override still stalls at the 30-min global default (no regression)', () => {
    const h = stalledHarness();
    startInPhase(h, 'implement', 'review');

    h.advance(30 * 60 * 1000); // ~31 min since last progress
    const result = h.tick();
    expect(result.redispatched).toEqual(['issue:101']);
  });

  it('an operator override via dispatch.phase_stall_timeout_ms wins over the built-in default', () => {
    const h = harness({
      stallTimeoutMs: 30 * 60 * 1000,
      phaseStallTimeoutMs: { implement: 5 * 60 * 1000 },
    });
    REGISTRIES.push(h.dir);
    startInPhase(h, 'plan', 'implement');

    h.advance(5 * 60 * 1000); // ~6 min since last progress — past the 5-min override, well under the 90-min built-in default
    const result = h.tick();
    expect(result.redispatched).toEqual(['issue:101']);
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

describe('unit priority (#565): a ready batch reserves its slot over a competing issue', () => {
  it('the sole free slot goes to nobody — reserved for the higher-priority ready batch, not the older issue', () => {
    const h = harness({ maxSlots: 1 });
    REGISTRIES.push(h.dir);
    // #101 (full-cycle, default priority 0) enqueued first — older, but
    // lower priority than the batch's default (10).
    h.enqueue([{ issue: 101, mode: 'full', tier: 'mid' }]);
    h.enqueue([{ issue: 102, mode: 'slot', batch: 'b1', tier: 'mid' }]);
    expect(h.state().batches.find((b) => b.id === 'b1')?.status).toBe('ready');

    h.tick();

    // dispatchAssignments (issue-only) must NOT have spawned #101 — the dry
    // run over both kinds ranked the ready batch first and the reservation
    // left the slot free rather than handing it to the lower-priority issue.
    // This harness configures no batchExec/runBatchSuite, so the batch's own
    // claim pass does not run either — the slot simply stays idle, proving
    // the issue path alone did not consume it.
    expect(h.spawnCalls).toHaveLength(0);
    expect(h.state().slots.filter((s) => s.status !== 'idle')).toHaveLength(0);
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('queued');
  });

  it('with no competing batch, the issue is dispatched as before (no regression)', () => {
    const h = harness({ maxSlots: 1 });
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full', tier: 'mid' }]);

    h.tick();

    expect(h.spawnCalls).toHaveLength(1);
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('dispatched');
  });

  it('journals the priority on each issue assignment', () => {
    const h = harness({ maxSlots: 1 });
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full', tier: 'mid', priority: 3 }]);

    h.tick();

    const assigned = h.events().find((e) => e.event === 'assigned' && e.unit === 'issue:101');
    expect(assigned?.priority).toBe(3);
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
    expect(h.hasSlotReleased(101, 'unit-failed')).toBe(true);
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
    // #525: parking under detached ship also journals slot-released.
    expect(h.hasSlotReleased(101, 'parked')).toBe(true);
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

  it('#527 AC4: report/mechanical tier can point at a cheaper CLI+model independently of mid/strong', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.config.dispatch = {
      tiers: {
        mechanical: { command: ['fake-haiku-cli', '--model', '{model}'], model: 'fake-cheap' },
      },
    };
    mergedUnit(h);

    const result = h.tick();
    expect(result.reportDispatched).toEqual(['issue:101']);

    const reportSpawn = h.spawnCalls[h.spawnCalls.length - 1];
    expect(reportSpawn.cmd).toEqual(['fake-haiku-cli', '--model', 'fake-cheap']);
    // AC3: the spawned event records the model the report agent used.
    const spawnedEvent = h.events().find((e) => e.event === 'spawned' && e.pid === reportSpawn.pid);
    expect(spawnedEvent?.model).toBe('fake-cheap');
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

describe('#501: stale auto-merge-blocked failures reconcile after a later merge', () => {
  it('a failed auto-merge-blocked unit reconciles to shipped once the PR merges and the issue closes', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    parkUnit(h, 101, 55);
    h.setPr(55, { state: 'OPEN', blocked: true });
    h.advance(200_000);
    let result = h.tick();
    expect(result.failed).toEqual(['issue:101']);
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('failed');

    // Operator re-queues the PR and it merges. No `parked` entries exist any
    // more at this point — this also proves the pollParkedPrs poll-skip
    // guard fix, since the poll must still run for a stale-failed-only tick.
    h.setPr(55, { state: 'MERGED', mergedAt: '2026-08-29T13:00:00Z' });
    h.closedIssues.add(101);
    h.setupInfos.set(101, { worktree: h.wt('wt-101'), poolClaimed: false, branch: 'f/101' });
    h.setTeardownScript(removingTeardown(h.wt('wt-101')));
    h.advance(200_000);
    result = h.tick();

    expect(result.staleReconciled).toEqual(['issue:101']);
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('shipped');
    const ev = h.events().find((e) => e.event === 'stale-failure-reconciled' && e.issue === 101);
    expect(ev).toMatchObject({
      issue: 101,
      pr: 55,
      mergedAt: '2026-08-29T13:00:00Z',
      reason: 'auto-merge-blocked',
    });
    expect(String(ev?.detail)).toContain('MERGED');
  });

  it('does not reconcile while the PR merged but the issue is still open, and journals pr-watch-waiting', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    parkUnit(h, 101, 55);
    h.setPr(55, { state: 'OPEN', blocked: true });
    h.advance(200_000);
    h.tick();

    h.setPr(55, { state: 'MERGED', mergedAt: '2026-08-29T13:00:00Z' });
    h.advance(200_000);
    const result = h.tick();

    expect(result.staleReconciled).toEqual([]);
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('failed');
    expect(h.events().some((e) => e.event === 'pr-watch-waiting' && e.issue === 101)).toBe(true);
  });

  it('never reconciles a failed entry for any reason other than auto-merge-blocked', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    parkUnit(h, 101, 55);
    h.setPr(55, { state: 'OPEN', mergeable: 'CONFLICTING' });
    h.advance(200_000);
    h.tick();
    expect(h.state().entries.find((e) => e.issue === 101)?.reason).toBe('pr-conflicting');

    h.setPr(55, { state: 'MERGED', mergedAt: '2026-08-29T13:00:00Z' });
    h.closedIssues.add(101);
    h.advance(200_000);
    const result = h.tick();

    expect(result.staleReconciled).toEqual([]);
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('failed');
  });

  it('an unreachable PR poll on a stale-failed entry journals ground-truth-unreachable, not silence', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    parkUnit(h, 101, 55);
    h.setPr(55, { state: 'OPEN', blocked: true });
    h.advance(200_000);
    h.tick(); // 101 fails, auto-merge-blocked

    h.prUnreachable.add(55);
    h.advance(200_000);
    const result = h.tick();

    expect(result.staleReconciled).toEqual([]);
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('failed');
    expect(h.events().some((e) => e.event === 'ground-truth-unreachable' && e.issue === 101)).toBe(
      true
    );
  });

  it('stops watching (and re-polling) a stale-failed entry once the reconcile window elapses', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    parkUnit(h, 101, 55);
    h.setPr(55, { state: 'OPEN', blocked: true });
    h.advance(200_000);
    h.tick();
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('failed');

    // 8 days later the PR merges, but the (7-day) reconcile window has elapsed —
    // the entry is no longer watchable at all, so the poll itself never runs.
    h.advance(8 * 24 * 60 * 60 * 1000);
    h.setPr(55, { state: 'MERGED', mergedAt: '2026-09-06T13:00:00Z' });
    h.closedIssues.add(101);
    const result = h.tick();

    expect(result.staleReconciled).toEqual([]);
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('failed');
  });

  it('a PR that is MERGED but still carries a stale auto-merge-blocked label is accepted, never failed', () => {
    // Regression: reconcileParked used to check `blocked` before `MERGED`, so
    // a PR merged while the label was still attached would fail the unit and
    // block its dependents in the same tick reconcileStaleFailedParks would
    // have immediately un-failed it — a noisy, dependent-wedging round trip.
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([
      { issue: 101, mode: 'full', tier: 'mid' },
      { issue: 102, mode: 'full', tier: 'mid', deps: [101] },
    ]);
    h.tick();
    h.milestones.set(101, parkMilestone(55));
    h.alive.delete(h.spawnCalls[0].pid);
    h.tick(); // 101 parked

    h.setPr(55, { state: 'MERGED', mergedAt: '2026-08-29T13:00:00Z', blocked: true });
    h.closedIssues.add(101);
    h.setupInfos.set(101, { worktree: h.wt('wt-101'), poolClaimed: false, branch: 'f/101' });
    h.setTeardownScript(removingTeardown(h.wt('wt-101')));
    h.advance(200_000);
    const result = h.tick();

    expect(result.mergeAccepted).toEqual(['issue:101']);
    expect(result.failed).toEqual([]);
    expect(result.blocked).toEqual([]);
    expect(h.state().entries.find((e) => e.issue === 101)?.status).toBe('shipped');
    expect(h.state().entries.find((e) => e.issue === 102)?.status).not.toBe('blocked');
  });

  it('reconciling a stale failure also unblocks its transitively-dependent entries', () => {
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
    h.tick(); // 101 parked

    h.setPr(55, { state: 'OPEN', blocked: true });
    h.advance(200_000);
    let result = h.tick(); // 101 fails, 102+103 blocked transitively
    expect(result.failed).toEqual(['issue:101']);
    expect(result.blocked.slice().sort()).toEqual([102, 103]);
    expect(h.state().entries.find((e) => e.issue === 102)?.status).toBe('blocked');
    expect(h.state().entries.find((e) => e.issue === 103)?.status).toBe('blocked');

    h.setPr(55, { state: 'MERGED', mergedAt: '2026-08-29T13:00:00Z' });
    h.closedIssues.add(101);
    h.setupInfos.set(101, { worktree: h.wt('wt-101'), poolClaimed: false, branch: 'f/101' });
    h.setTeardownScript(removingTeardown(h.wt('wt-101')));
    h.advance(200_000);
    result = h.tick();

    expect(result.staleReconciled).toEqual(['issue:101']);
    expect(result.dependentsUnblocked.slice().sort()).toEqual(['issue:102', 'issue:103']);
    // 102's only dep (101) is now shipped, so it's runnable and dispatches in
    // this same tick; 103 still depends on 102 (not yet satisfied) and stays queued.
    expect(h.state().entries.find((e) => e.issue === 102)?.status).toBe('dispatched');
    expect(h.state().entries.find((e) => e.issue === 103)?.status).toBe('queued');
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

describe('zombie-run fencing on redispatch (#504)', () => {
  /**
   * A stalling unit: dispatched, one milestone posted, then silence. The stall timeout
   * is an hour and the fence window fifteen minutes, so the two are trivially
   * distinguishable by how far the clock is advanced.
   */
  function stalling(opts: { fenceTakeoverTimeoutMs?: number } = {}) {
    const h = harness({ stallTimeoutMs: 60 * 60 * 1000, ...opts });
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 504, mode: 'full', tier: 'mechanical' }]);
    h.tick(); // dispatch
    h.setMilestone(504, 'gate', 'done', undefined, { next: 'setup' });
    return h;
  }

  const HOUR = 60 * 60 * 1000;

  it('writes the takeover record BEFORE the replacement agent is spawned (AC1)', () => {
    const h = stalling();
    h.advance(HOUR + 1000);

    const result = h.tick();

    expect(result.redispatched).toEqual(['issue:504']);
    expect(h.fenceCalls).toHaveLength(1);
    const fence = h.fenceCalls[0];
    expect(fence.issue).toBe(504);
    // The run id and phase come off the polled trail, not from local bookkeeping.
    expect(fence.run).toBe('r-504-ab12');
    expect(fence.phase).toBe('gate');
    // The ordering is the point: `killUnitAgent` only reaches a pid this process can
    // signal, so the durable record has to exist before the takeover does.
    expect(fence.spawnsBefore).toBe(1);
    expect(h.spawnCalls).toHaveLength(2);
    expect(h.events().some((e) => e.event === 'fence-written')).toBe(true);
  });

  it('records the installed generation on the slot and hands it to the takeover', () => {
    const h = stalling();
    h.advance(HOUR + 1000);
    h.tick();

    const slot = h.state().slots.find((s) => s.unit === 'issue:504');
    expect(slot?.gen).toBe(1);
    expect(slot?.fenced_at).toBe(h.clock().toISOString());

    // The agent has to learn its generation, or its own posts are refused by the CLI.
    const takeoverPrompt = h.spawnCalls[1].prompt;
    expect(takeoverPrompt).toContain('TAKEOVER');
    expect(takeoverPrompt).toContain('--gen 1');
    expect(takeoverPrompt).toContain('runstate check');
    // A first dispatch is unchanged.
    expect(h.spawnCalls[0].prompt).not.toContain('TAKEOVER');
  });

  it('redispatches unfenced, loudly, when the fence cannot be written', () => {
    const h = stalling();
    h.setFenceFails(true);
    h.advance(HOUR + 1000);

    const result = h.tick();

    // Degraded, never blocked: refusing to redispatch would strand the unit forever.
    expect(result.redispatched).toEqual(['issue:504']);
    expect(h.spawnCalls).toHaveLength(2);
    expect(h.events().some((e) => e.event === 'fence-failed')).toBe(true);
    const slot = h.state().slots.find((s) => s.unit === 'issue:504');
    expect(slot?.gen).toBe(0);
    // No fence landed, so the short takeover watch never arms — one failure must not
    // compound into a shortened allowance.
    expect(slot?.fenced_at).toBeNull();
    expect(h.spawnCalls[1].prompt).not.toContain('TAKEOVER');
  });

  it('redispatches unfenced when the trail carries no run id to fence', () => {
    const h = harness({ stallTimeoutMs: HOUR });
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 504, mode: 'full', tier: 'mechanical' }]);
    h.tick();
    // No milestone at all: an agent that has posted nothing has also written nothing
    // to race over.
    h.advance(HOUR + 1000);

    expect(h.tick().redispatched).toEqual(['issue:504']);
    expect(h.fenceCalls).toHaveLength(0);
    expect(
      h.events().some((e) => e.event === 'fence-failed' && e.detail?.includes('no run id'))
    ).toBe(true);
  });

  it('re-enters the ladder on the short fence window when a takeover posts nothing (AC4)', () => {
    const h = stalling({ fenceTakeoverTimeoutMs: 15 * 60 * 1000 });
    h.advance(HOUR + 1000);
    h.tick(); // first stall → fence gen 1

    // Twenty minutes: past the 15-minute fence window, nowhere near the 1-hour phase
    // allowance. Without the short window this takeover's death goes unnoticed for
    // another 40 minutes.
    h.advance(20 * 60 * 1000);
    const result = h.tick();

    expect(result.redispatched).toEqual(['issue:504']);
    // Recovery-of-recovery: the second fence supersedes the first takeover in turn.
    expect(h.fenceCalls).toHaveLength(2);
    expect(h.fenceCalls[1].takeover).not.toBe(h.fenceCalls[0].takeover);
    const slot = h.state().slots.find((s) => s.unit === 'issue:504');
    expect(slot?.gen).toBe(2);
    expect(slot?.recoveries).toBe(2);
    expect(h.spawnCalls[2].prompt).toContain('--gen 2');
  });

  it('gives a takeover that IS working the phase allowance again', () => {
    const h = stalling({ fenceTakeoverTimeoutMs: 15 * 60 * 1000 });
    h.advance(HOUR + 1000);
    h.tick(); // fence gen 1

    // The takeover posts: it is demonstrably alive, so the short watch disarms.
    h.advance(10 * 60 * 1000);
    h.setMilestone(504, 'setup', 'done', undefined, { next: 'plan' });
    h.tick();
    expect(h.state().slots.find((s) => s.unit === 'issue:504')?.fenced_at).toBeNull();

    // Twenty more minutes would have stalled it under the fence window; under the
    // phase allowance it is still healthy.
    h.advance(20 * 60 * 1000);
    expect(h.tick().redispatched).toEqual([]);
    expect(h.fenceCalls).toHaveLength(1);
  });

  it('fences an unverified exit too, not only a stall', () => {
    const h = stalling();
    // The agent exits without ever reaching `report done` — an unverified exit.
    h.alive.clear();

    const result = h.tick();

    expect(result.redispatched).toEqual(['issue:504']);
    expect(h.fenceCalls).toHaveLength(1);
    expect(h.fenceCalls[0].run).toBe('r-504-ab12');
  });

  it('never fences a unit that fails at the escalation cap', () => {
    const h = stalling();
    h.advance(HOUR + 1000);
    h.tick(); // recovery 1 (mechanical → mid)
    h.advance(HOUR + 1000);
    h.tick(); // recovery 2 (mid → strong)
    expect(h.fenceCalls).toHaveLength(2);

    h.advance(HOUR + 1000);
    const result = h.tick(); // cap reached → failed, no takeover to announce

    expect(result.failed).toEqual(['issue:504']);
    expect(h.fenceCalls).toHaveLength(2);
  });

  it('refuses to fence a run id that does not belong to this issue', () => {
    const h = harness({ stallTimeoutMs: HOUR });
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 504, mode: 'full', tier: 'mechanical' }]);
    h.tick();
    // A milestone is an issue comment, so its `run=` is network data. Fencing a
    // well-formed run id belonging to some OTHER issue is worse than not fencing: it
    // would journal success while the real zombie stayed free to write.
    h.milestones.set(504, {
      phase: 'gate',
      status: 'done',
      run: 'r-999-dead',
      at: h.clock().toISOString(),
      keys: { next: 'setup' },
    });
    h.advance(HOUR + 1000);

    expect(h.tick().redispatched).toEqual(['issue:504']);
    expect(h.fenceCalls).toHaveLength(0);
    expect(
      h.events().some((e) => e.event === 'fence-failed' && e.detail?.includes('r-999-dead'))
    ).toBe(true);
  });

  it('journals the fencer’s own reason when the fence write fails', () => {
    const h = stalling();
    h.setFenceFails(true);
    h.advance(HOUR + 1000);
    h.tick();

    const failure = h.events().find((e) => e.event === 'fence-failed');
    // The cause has to survive into the journal — "it failed" is not something an
    // operator can act on.
    expect(failure?.detail).toContain('fake fencer told to fail');
    expect(failure?.detail).toContain('gen=0');
  });

  it('hands a fenced report agent its generation too', () => {
    // A report slot rides the same ladder. Without the generation its `report done`
    // milestone is refused by the CLI and it recovers to the cap on a merged PR.
    const h = harness({ stallTimeoutMs: HOUR });
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 504, mode: 'full', tier: 'mechanical' }]);
    h.tick();
    h.milestones.set(504, parkMilestone(77));
    h.alive.clear();
    h.tick(); // verified park → entry parked, slot released
    h.setPr(77, { state: 'MERGED', mergedAt: '2026-08-29T13:00:00Z' });
    h.closedIssues.add(504);
    h.setTeardownScript(() => 'ok');
    h.advance(10 * 60 * 1000);
    h.tick(); // merge accepted → teardown → report agent dispatched

    const reportSpawn = h.spawnCalls.at(-1);
    expect(reportSpawn?.prompt).toContain('report phase');
    // A first report dispatch is generation 0 and reads as it always did.
    expect(reportSpawn?.prompt).not.toContain('TAKEOVER');

    h.setMilestone(504, 'ship', 'done', undefined, { next: 'report' });
    h.advance(HOUR + 1000);
    h.tick(); // the report agent stalls → fenced and redispatched

    expect(h.fenceCalls).toHaveLength(1);
    const takeoverReport = h.spawnCalls.at(-1);
    expect(takeoverReport?.prompt).toContain('report phase');
    expect(takeoverReport?.prompt).toContain('--gen 1');
  });

  it('runs the pre-#504 redispatch path when no fencer is configured', () => {
    const h = stalling();
    h.removeFencer();
    h.advance(HOUR + 1000);

    expect(h.tick().redispatched).toEqual(['issue:504']);
    expect(h.fenceCalls).toHaveLength(0);
    expect(
      h.events().some((e) => e.event === 'fence-failed' && e.detail?.includes('no fencer'))
    ).toBe(true);
  });
});

describe('runs.jsonl telemetry (#524: per-dispatch token/cost recorded on exit)', () => {
  function readRunLogEntries(h: ReturnType<typeof harness>): Array<Record<string, unknown>> {
    const file = schedRunsLogPath(h.homeDir);
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  it('appends one runs.jsonl entry, sourced from modelUsage, when a dispatch exits with a verified milestone', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full', tier: 'mechanical' }]);
    h.tick();
    const spawn = h.spawnCalls[0];

    // The agent wrote its claude JSON result before exiting. The fake spawn
    // (unlike the real one, dispatch.ts's createSpawnDeps) never creates the
    // runs dir, so the test does.
    fs.mkdirSync(path.dirname(spawn.logFile), { recursive: true });
    fs.writeFileSync(
      spawn.logFile,
      JSON.stringify({
        type: 'result',
        modelUsage: {
          'claude-haiku-4': { inputTokens: 500, outputTokens: 80, totalCostUsd: 0.002 },
        },
      })
    );
    h.alive.delete(spawn.pid);
    h.setMilestone(101, 'report', 'done');

    h.tick();

    const entries = readRunLogEntries(h);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      unit: 'issue:101',
      dossier: 'sched:cycle',
      model: 'claude-haiku-4',
      input_tokens: 500,
      output_tokens: 80,
      total_cost_usd: 0.002,
      // #564 AC1: the queue entry's tier reaches the written record, not
      // just the in-memory RunLogEntry a unit-level fixture hand-builds.
      tier: 'mechanical',
    });
  });

  it('appends a separate entry per dispatch on redispatch — never double-counts the same exit', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full', tier: 'mechanical' }]);
    h.tick();
    const firstPid = h.spawnCalls[0].pid;

    // First dispatch exits unverified → redispatched one tier stronger.
    h.alive.delete(firstPid);
    h.tick();
    expect(h.spawnCalls).toHaveLength(2);
    expect(readRunLogEntries(h)).toHaveLength(1); // exactly one entry for the first dispatch

    // Ticking again with nothing changed must NOT append another entry for
    // the same already-recorded exit.
    h.tick();
    expect(readRunLogEntries(h)).toHaveLength(1);

    // Second dispatch also exits and completes — its own, separate entry.
    const secondPid = h.spawnCalls[1].pid;
    h.alive.delete(secondPid);
    h.setMilestone(101, 'report', 'done');
    h.tick();

    const entries = readRunLogEntries(h);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.unit === 'issue:101')).toBe(true);
  });

  it("isolates each dispatch's tokens on redispatch even though the log file is shared and append-only (#524 regression)", () => {
    // The log file is per-UNIT, not per-dispatch, and dispatch.ts's real
    // spawn() opens it with 'a' (append) — so a redispatched unit's second
    // agent writes its JSON result AFTER the first agent's, in the SAME
    // file. Reading the whole file for the second dispatch would either
    // throw on `{...}{...}` (claude) or double-count (opencode). This test
    // writes real content across two dispatches and asserts each entry
    // reflects ONLY its own dispatch — proving `log_offset_at_spawn`
    // actually isolates them, not just that two entries exist.
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full', tier: 'mechanical' }]);
    h.tick();
    const firstSpawn = h.spawnCalls[0];

    fs.mkdirSync(path.dirname(firstSpawn.logFile), { recursive: true });
    fs.writeFileSync(
      firstSpawn.logFile,
      JSON.stringify({
        type: 'result',
        modelUsage: { 'claude-haiku-4': { inputTokens: 100, outputTokens: 10 } },
      })
    );
    h.alive.delete(firstSpawn.pid);
    h.tick(); // first dispatch recorded; redispatched to a second agent

    expect(h.spawnCalls).toHaveLength(2);
    const secondSpawn = h.spawnCalls[1];
    expect(secondSpawn.logFile).toBe(firstSpawn.logFile); // same per-unit path

    // Second agent's own output is APPENDED after the first agent's — the
    // real-world shape (createSpawnDeps opens 'a', not 'w').
    fs.appendFileSync(
      secondSpawn.logFile,
      JSON.stringify({
        type: 'result',
        modelUsage: { 'claude-sonnet-4': { inputTokens: 9000, outputTokens: 900 } },
      })
    );
    h.alive.delete(secondSpawn.pid);
    h.setMilestone(101, 'report', 'done');
    h.tick();

    const entries = readRunLogEntries(h);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ input_tokens: 100, output_tokens: 10 });
    // The critical assertion: the SECOND entry must show only the SECOND
    // dispatch's numbers — neither null (concatenation parse failure) nor
    // 9100/910 (summed with the first dispatch).
    expect(entries[1]).toMatchObject({ input_tokens: 9000, output_tokens: 900 });
  });

  it('records an entry for an external-advance exit too (agent still alive when ground truth completed)', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full' }]);
    h.tick();
    // Agent still alive, but ground truth already says the issue is done.
    h.setMilestone(101, 'report', 'done');

    h.tick();

    expect(readRunLogEntries(h)).toHaveLength(1);
  });

  it('records null usage (never fabricated) when the dispatch log is missing or unparseable', () => {
    const h = harness();
    REGISTRIES.push(h.dir);
    h.enqueue([{ issue: 101, mode: 'full' }]);
    h.tick();
    h.alive.delete(h.spawnCalls[0].pid);
    h.setMilestone(101, 'report', 'done');
    // No log file written at all (simulates the #524 "0 bytes"/missing-log symptom).

    h.tick();

    const entries = readRunLogEntries(h);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      input_tokens: null,
      output_tokens: null,
      total_cost_usd: null,
    });
  });
});

describe('#544: hard-block labels are re-evaluated each tick', () => {
  /** The state #507's enqueue pre-screen produces: blocked with a `label:<name>` reason. */
  const enqueueLabelBlocked = (h: ReturnType<typeof harness>, issue: number, label: string) => {
    h.enqueue([{ issue, mode: 'full', blocked_label: label }]);
    h.labelsByIssue.set(issue, [label]);
    const entry = h.state().entries.find((e) => e.issue === issue);
    expect(entry).toMatchObject({ status: 'blocked', reason: `label:${label}` });
  };

  it('AC1: a cleared label returns the unit to queued and dispatches it the same tick', () => {
    const h = harness();
    enqueueLabelBlocked(h, 101, 'decision-pending');

    // The human resolves the decision and removes the label.
    h.labelsByIssue.set(101, ['bug']);
    const result = h.tick();

    expect(result.labelCleared).toEqual(['issue:101']);
    expect(h.state().entries[0]).toMatchObject({ status: 'dispatched', reason: null });
    expect(result.spawned).toEqual(['issue:101']);
    expect(h.events().some((e) => e.event === 'label-cleared' && e.issue === 101)).toBe(true);
  });

  it('AC1: a unit whose label is still there stays blocked and is not journaled as cleared', () => {
    const h = harness();
    enqueueLabelBlocked(h, 101, 'decision-pending');

    const result = h.tick();

    expect(result.labelCleared).toEqual([]);
    expect(result.spawned).toEqual([]);
    expect(h.state().entries[0]).toMatchObject({
      status: 'blocked',
      reason: 'label:decision-pending',
    });
    expect(h.events().some((e) => e.event === 'label-cleared')).toBe(false);
  });

  it('AC1: a blocked unit whose label CHANGED gets its stale reason refreshed', () => {
    const h = harness();
    enqueueLabelBlocked(h, 101, 'decision-pending');

    h.labelsByIssue.set(101, ['epic']);
    const result = h.tick();

    expect(result.labelBlocked).toEqual(['issue:101']);
    expect(h.state().entries[0]).toMatchObject({ status: 'blocked', reason: 'label:epic' });
    expect(result.spawned).toEqual([]);
  });

  it('AC1: dependency gating still applies to a just-unblocked unit', () => {
    const h = harness();
    h.enqueue([{ issue: 100, mode: 'full' }]);
    h.enqueue([{ issue: 101, mode: 'full', deps: [100], blocked_label: 'decision-pending' }]);
    h.labelsByIssue.set(101, ['bug']); // label already gone

    const result = h.tick();

    expect(result.labelCleared).toEqual(['issue:101']);
    // Back to `queued`, but #100 has not merged — so it is NOT dispatched.
    expect(h.state().entries.find((e) => e.issue === 101)).toMatchObject({ status: 'queued' });
    expect(result.spawned).toEqual(['issue:100']);
  });

  it('AC2: a queued unit that gains a hard-block label is blocked, not dispatched over', () => {
    const h = harness();
    h.enqueue([{ issue: 101, mode: 'full' }]);
    // A full-cycle hand-off labels the issue between enqueue and dispatch.
    h.labelsByIssue.set(101, ['bug', 'decision-pending']);

    const result = h.tick();

    expect(result.labelBlocked).toEqual(['issue:101']);
    expect(result.spawned).toEqual([]);
    expect(h.spawnCalls).toHaveLength(0);
    expect(h.state().entries[0]).toMatchObject({
      status: 'blocked',
      reason: 'label:decision-pending',
    });
    expect(h.events().some((e) => e.event === 'label-blocked' && e.issue === 101)).toBe(true);
  });

  it('AC2: a dispatched unit is not even watched — a late label costs no read', () => {
    const h = harness();
    h.enqueue([{ issue: 101, mode: 'full' }]);
    h.tick();
    expect(h.state().entries[0].status).toBe('dispatched');
    const readsBefore = h.labelReads.length;

    h.labelsByIssue.set(101, ['decision-pending']);
    const result = h.tick();

    expect(h.labelReads).toHaveLength(readsBefore);
    expect(result.labelBlocked).toEqual([]);
    expect(h.state().entries[0].status).toBe('dispatched');
  });

  it('AC2: a unit requeued mid-tick is screened before it can be re-dispatched', () => {
    // The poll runs OUTSIDE the lock, so state can move under it. Here the
    // entry is dispatched-with-no-slot at read time (the crash window
    // `requeueOrphanedDispatches` recovers), so it lands back in `queued`
    // INSIDE the lock — and the label screen, which runs after that pass and
    // before dispatch, still catches it rather than letting the recovery path
    // walk it straight past the hand-off.
    const h = harness();
    h.enqueue([{ issue: 101, mode: 'full' }]);
    h.labelsByIssue.set(101, ['decision-pending']);
    h.setOnLabelRead(() => {
      h.store.withLock((state) => ({
        state: transitionIssue(
          transitionIssue(state, 101, 'classified', {}, h.clock()),
          101,
          'dispatched',
          {},
          h.clock()
        ),
        result: null,
      }));
    });

    const result = h.tick();

    expect(result.labelBlocked).toEqual(['issue:101']);
    expect(result.spawned).toEqual([]);
    expect(h.state().entries[0]).toMatchObject({
      status: 'blocked',
      reason: 'label:decision-pending',
    });
  });

  it('AC3: an idle tick re-reads at most every 10 minutes, and the timestamp is persisted', () => {
    const h = harness();
    enqueueLabelBlocked(h, 101, 'decision-pending');

    h.tick();
    const firstPoll = h.state().last_label_poll_at;
    expect(firstPoll).toBe(h.clock().toISOString());
    const readsAfterFirst = h.labelReads.length;
    expect(readsAfterFirst).toBe(1);

    // Nothing else to do (no live slot, nothing runnable) — throttled.
    h.advance(60_000);
    h.tick();
    expect(h.labelReads).toHaveLength(readsAfterFirst);
    expect(h.state().last_label_poll_at).toBe(firstPoll);

    // Past the window — reads again.
    h.advance(10 * 60_000);
    h.tick();
    expect(h.labelReads).toHaveLength(readsAfterFirst + 1);
    expect(h.state().last_label_poll_at).toBe(h.clock().toISOString());
  });

  it('AC3: a tick that HAS work re-reads every tick, throttle notwithstanding', () => {
    const h = harness();
    enqueueLabelBlocked(h, 101, 'decision-pending');
    h.enqueue([{ issue: 102, mode: 'full' }]); // runnable → the tick has work

    h.tick();
    const reads = h.labelReads.length;
    expect(reads).toBe(2); // one per watched unit: the blocked one and the runnable one

    // #102 is now running, so the tick still has work one minute later.
    h.advance(60_000);
    h.tick();
    expect(h.labelReads.length).toBeGreaterThan(reads);
  });

  it('an unreachable label read decides nothing and journals label-check-failed', () => {
    const h = harness();
    enqueueLabelBlocked(h, 101, 'decision-pending');
    h.labelUnreachable.add(101);

    const result = h.tick();

    expect(result.labelCleared).toEqual([]);
    expect(result.labelBlocked).toEqual([]);
    expect(h.state().entries[0]).toMatchObject({
      status: 'blocked',
      reason: 'label:decision-pending',
    });
    expect(h.events().some((e) => e.event === 'label-check-failed' && e.issue === 101)).toBe(true);
  });

  it('a unit blocked for a NON-label reason is never unblocked by a clean label read', () => {
    const h = harness();
    h.enqueue([{ issue: 101, mode: 'full' }]);
    h.store.withLock((state) => ({
      state: transitionIssue(state, 101, 'blocked', { reason: 'dep-failed:100' }, h.clock()),
      result: null,
    }));

    const result = h.tick();

    expect(result.labelCleared).toEqual([]);
    expect(h.state().entries[0]).toMatchObject({ status: 'blocked', reason: 'dep-failed:100' });
  });

  it('no label read happens at all when nothing is blocked or runnable', () => {
    const h = harness();

    h.tick();

    expect(h.labelReads).toEqual([]);
    expect(h.state().last_label_poll_at).toBeNull();
  });
});

describe('#544 review hardening: paused fleets, evidence, and read cost', () => {
  it('a paused fleet does not re-read its backlog every tick', () => {
    // `runnableUnits` does not consider `paused`, so without the guard a paused
    // fleet with a backlog would burn one `gh issue view` per runnable unit per
    // tick forever while dispatching nothing — and the dispatch-health auto-pause
    // fires exactly when gh is already walled.
    const h = harness();
    h.enqueue([
      { issue: 101, mode: 'full' },
      { issue: 102, mode: 'full' },
    ]);
    h.store.withLock((state) => ({ state: setPaused(state, true, h.clock()), result: null }));

    h.tick();
    expect(h.labelReads).toEqual([]);

    // Still throttled a minute later; nothing is dispatchable, so the tick is idle.
    h.advance(60_000);
    h.tick();
    expect(h.labelReads).toEqual([]);
  });

  it('the runnable half of the watch set is capped at max_slots, not the backlog', () => {
    const h = harness({ maxSlots: 2 });
    h.enqueue([
      { issue: 101, mode: 'full' },
      { issue: 102, mode: 'full' },
      { issue: 103, mode: 'full' },
      { issue: 104, mode: 'full' },
    ]);

    h.tick();

    // Two slots ⇒ at most two units can be placed ⇒ at most two label reads.
    expect(h.labelReads).toEqual([101, 102]);
    expect(h.spawnCalls).toHaveLength(2);
  });

  it('a unit outside the read window is deferred one tick when this tick blocked something', () => {
    // The cap is exact only while nothing is blocked. Blocking #101 slides #103
    // into range unread, so it waits for the next tick's read rather than being
    // dispatched on information nobody gathered.
    const h = harness({ maxSlots: 2 });
    h.enqueue([
      { issue: 101, mode: 'full' },
      { issue: 102, mode: 'full' },
      { issue: 103, mode: 'full' },
    ]);
    h.labelsByIssue.set(101, ['decision-pending']);

    const first = h.tick();

    expect(first.labelBlocked).toEqual(['issue:101']);
    expect(first.spawned).toEqual(['issue:102']);

    // Next tick #103 is inside the window, read, and dispatched.
    h.advance(60_000);
    const second = h.tick();
    expect(second.spawned).toEqual(['issue:103']);
  });

  it('a block reason outside HARD_BLOCK_LABELS is only cleared when that label is really gone', () => {
    // `enqueue` accepts any GitHub label name as `blocked_label`, so a
    // policy-list test would report "cleared" for a label still on the issue.
    const h = harness();
    h.enqueue([{ issue: 101, mode: 'full', blocked_label: 'needs-security-signoff' }]);
    h.labelsByIssue.set(101, ['needs-security-signoff']);

    const first = h.tick();

    expect(first.labelCleared).toEqual([]);
    expect(h.state().entries[0]).toMatchObject({
      status: 'blocked',
      reason: 'label:needs-security-signoff',
    });

    // Removed for real → cleared.
    h.labelsByIssue.set(101, []);
    h.advance(11 * 60_000);
    expect(h.tick().labelCleared).toEqual(['issue:101']);
  });

  it('a second hard-block label keeps the unit blocked when the first is removed', () => {
    const h = harness();
    h.enqueue([{ issue: 101, mode: 'full', blocked_label: 'decision-pending' }]);
    h.labelsByIssue.set(101, ['epic']); // decision-pending resolved, epic remains

    const result = h.tick();

    expect(result.labelCleared).toEqual([]);
    expect(result.labelBlocked).toEqual(['issue:101']);
    expect(h.state().entries[0]).toMatchObject({ status: 'blocked', reason: 'label:epic' });
    expect(
      h
        .events()
        .some(
          (e) =>
            e.event === 'label-blocked' &&
            e.issue === 101 &&
            e.previous_reason === 'label:decision-pending'
        )
    ).toBe(true);
  });

  it('an unreachable read is surfaced in the tick result, not only the journal', () => {
    const h = harness();
    h.enqueue([{ issue: 101, mode: 'full', blocked_label: 'decision-pending' }]);
    h.labelUnreachable.add(101);

    const result = h.tick();

    expect(result.labelCheckFailed).toEqual(['issue:101']);
  });

  it('a tick where every read failed does not stamp last_label_poll_at', () => {
    // Otherwise `sched status` reports "labels last checked 30s ago" through a
    // gh outage — asserting exactly what the timestamp exists to deny — and an
    // idle fleet burns a full throttle window on a poll that learned nothing.
    const h = harness();
    h.enqueue([{ issue: 101, mode: 'full', blocked_label: 'decision-pending' }]);
    h.labelUnreachable.add(101);

    h.tick();

    expect(h.state().last_label_poll_at).toBeNull();

    // gh recovers: the next attempt is not throttled out, and now it stamps.
    h.labelUnreachable.delete(101);
    h.advance(60_000);
    h.tick();
    expect(h.state().last_label_poll_at).toBe(h.clock().toISOString());
  });

  it('label_poll_interval_ms overrides the 10-minute idle default', () => {
    const h = harness({ labelPollIntervalMs: 60_000 });
    h.enqueue([{ issue: 101, mode: 'full', blocked_label: 'decision-pending' }]);
    h.labelsByIssue.set(101, ['decision-pending']);

    h.tick();
    expect(h.labelReads).toHaveLength(1);

    h.advance(30_000);
    h.tick();
    expect(h.labelReads).toHaveLength(1); // still inside the configured window

    h.advance(31_000);
    h.tick();
    expect(h.labelReads).toHaveLength(2);
  });
});
