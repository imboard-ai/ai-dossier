/**
 * Integration tests for #523's batch dispatch: REAL spawned fake-agent
 * processes (one per member, one per tail step), a REAL scratch git repo for
 * batch-setup's `git branch`/`push`/`worktree add`, and file-backed ground
 * truth standing in for `ai-dossier runstate` / `gh` — mirroring
 * `integration.test.ts`'s existing harnesses (`tailHarness`,
 * `fileTailGroundTruth`) at batch granularity. No LLM calls anywhere.
 *
 * Covers the issue's required scenarios (AC7): a 3-member happy path through
 * to `done`, one member evicted (batch still ships with the survivors), and a
 * dissolve (>⅓ evicted, no ship).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
// #613: not part of the package's public `index.ts` surface — imported
// directly because the regression test below must call it twice against one
// stale `BatchEntry` snapshot, a condition the public `runBatchTick`/
// `resumeBlockedGate` entry points cannot reproduce (both always read state
// fresh from the store).
import { type BatchTickResult, evictMemberAndContinue, memberBranchFor } from '../batch-dispatch';
// Same rationale as the `evictMemberAndContinue` import above: a test-only
// path builder, not part of the package's public `index.ts` surface.
import { batchMemberLogPath } from '../dispatch';
import {
  assignToIdleSlot,
  type BatchDispatchDeps,
  type CapabilityGateResult,
  createSpawnDeps,
  type EngineDeps,
  type EnqueueInput,
  type ExecFn,
  enqueueEntries,
  findBatch,
  type GroundTruth,
  type GroundTruthMilestone,
  JOURNAL_DEDUP_REANNOUNCE_TICKS,
  Journal,
  type PrTruth,
  patchBatch,
  patchSlot,
  resolveDispatch,
  resumeBlockedGate,
  runBatchTick,
  type SchedConfig,
  SchedStore,
  type SpawnDeps,
  type SuiteResult,
  setPaused,
  tick,
  transitionBatch,
  transitionIssue,
  transitionSlot,
} from '../index';
import { writeApiErrorLog, writeToolUseLog } from './helpers/dispatch-log';
import { stubGroundTruth } from './helpers/ground-truth';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const FAKE_AGENT = path.join(FIXTURES, 'fake-agent.mjs');

const dirs: string[] = [];
const procsToKill: number[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const pid of procsToKill.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already dead
    }
  }
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Wait (bounded) until a real pid is dead — fake agents exit on their own. */
async function waitUntilDead(
  spawnDeps: { isAlive: (pid: number) => boolean },
  pid: number,
  ms = 10_000
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!spawnDeps.isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !spawnDeps.isAlive(pid);
}

/**
 * File-backed ground truth for batch tests: milestones (member AND anchor —
 * both are just issue numbers) live at `<issue>.json`, PR states at
 * `<pr>.pr.json`. Mirrors `integration.test.ts`'s `fileTailGroundTruth`.
 */
function fileBatchGroundTruth(dir: string): GroundTruth {
  const readJson = (file: string): unknown | undefined => {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return undefined;
    }
  };
  return stubGroundTruth({
    latestMilestone: (issue) => {
      const raw = readJson(`${issue}.json`);
      if (raw === undefined || raw === null || typeof raw !== 'object') return null;
      const m = raw as {
        phase: string;
        status: string;
        run: string;
        at: string;
        keys?: Record<string, string>;
      };
      return { phase: m.phase, status: m.status, run: m.run, at: m.at, keys: m.keys ?? {} };
    },
    prState: (pr) => {
      const raw = readJson(`${pr}.pr.json`);
      if (raw === undefined || raw === null || typeof raw !== 'object') return undefined;
      const t = raw as Partial<PrTruth>;
      if (t.state !== 'OPEN' && t.state !== 'MERGED' && t.state !== 'CLOSED') return undefined;
      return {
        state: t.state,
        mergedAt: t.mergedAt ?? null,
        mergeable: t.mergeable ?? 'MERGEABLE',
        blocked: t.blocked ?? false,
      };
    },
  });
}

/** A scratch repo (bare origin + main worktree) with one pushed commit — batch-setup's real `git` target. */
function scratchRepo(): string {
  const gitRoot = tmpDir('sched-batch-git-');
  const bare = path.join(gitRoot, 'origin.git');
  const work = path.join(gitRoot, 'work');
  fs.mkdirSync(bare);
  fs.mkdirSync(work);
  const git = (args: string[], cwd: string) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git(['init', '--bare', '--initial-branch=main', bare], gitRoot);
  git(['init', '--initial-branch=main', '.'], work);
  git(['config', 'user.email', 'sched@test'], work);
  git(['config', 'user.name', 'sched test'], work);
  git(['remote', 'add', 'origin', bare], work);
  fs.writeFileSync(path.join(work, 'README.md'), 'scratch\n');
  git(['add', '.'], work);
  git(['commit', '-m', 'init'], work);
  git(['push', '-u', 'origin', 'main'], work);
  return work;
}

/** Read-only git probe used by the #677 member-worktree tests (and reusable by any test that needs a `git` answer as a string). */
function gitAt(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** `git add . && git commit -m <message> && git push origin main` against a `scratchRepo()`'s `work` dir — shared tail every seeder function below repeats otherwise. */
function commitAllAndPush(work: string, message: string): void {
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git(['add', '.']);
  git(['commit', '-m', message]);
  git(['push', 'origin', 'main']);
}

/**
 * AC5 (#562): a scratch repo seeded with a REAL `.dossier/automation/manifest.yaml`
 * declaring `test.full` — same shape as this repo's own manifest — so a batch
 * worktree branched off it can run a genuine `ai-dossier cap run test.full`
 * (no mocking of `spawnSync`, `cap`, or the manifest parser).
 */
function scratchRepoWithRealSuite(): string {
  const work = scratchRepo();
  fs.mkdirSync(path.join(work, '.dossier', 'automation'), { recursive: true });
  fs.writeFileSync(
    path.join(work, '.dossier', 'automation', 'manifest.yaml'),
    'version: 1\ncapabilities:\n  test.full:\n    command: make test\n    lifecycle: active\n'
  );
  fs.writeFileSync(
    path.join(work, 'Makefile'),
    'test:\n\t@echo "Running tests..."\n\t@echo "OK"\n'
  );
  commitAllAndPush(work, 'seed real cap manifest + Makefile');
  return work;
}

/**
 * #561: a scratch repo seeded with a `package.json` declaring a `file:`
 * dependency on a local vendored package — no network access needed, but a
 * real `npm install` still has something to actually put in `node_modules`
 * (an empty `dependencies: {}` creates no `node_modules` directory at all,
 * which would make the regression test pass vacuously).
 */
function scratchRepoWithPackageJson(): string {
  const work = scratchRepo();
  const vendorDir = path.join(work, 'vendor', 'dummy-dep');
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.writeFileSync(
    path.join(vendorDir, 'package.json'),
    JSON.stringify({ name: 'dummy-dep', version: '1.0.0' })
  );
  fs.writeFileSync(
    path.join(work, 'package.json'),
    JSON.stringify({
      name: 'scratch-batch-warmup',
      version: '1.0.0',
      dependencies: { 'dummy-dep': 'file:vendor/dummy-dep' },
    })
  );
  commitAllAndPush(work, 'seed package.json for batch-warmup regression test');
  return work;
}

/**
 * The default gate stub: `test.focused` reports task-failed, every other capability passes
 * — the shape every incremental-gate test in this file needs.
 */
const FOCUSED_GATE_FAILS: (worktree: string, id: string) => CapabilityGateResult = (
  _worktree,
  id
) => (id === 'test.focused' ? { outcome: 'task-failed' } : { outcome: 'ok' });

/** An empty `BatchTickResult`, for the tests that call the eviction rail directly. */
function noResult(): BatchTickResult {
  return { spawned: [], completed: [], parked: [], mergeAccepted: [], failed: [], blocked: [] };
}

/**
 * A real `runBatchSuite` (AC5, #562) — shells the actual `ai-dossier cap run
 * test.full` in the batch worktree, exactly what `cli/src/batch-suite-runner.ts`'s
 * tier 1 does, rather than a canned mock result.
 */
function realCapRunSuite(worktree: string): SuiteResult {
  const spawned = spawnSync('ai-dossier', ['cap', 'run', 'test.full'], {
    cwd: worktree,
    encoding: 'utf-8',
    timeout: 60_000,
  });
  const lastLine = (spawned.stdout ?? '').trim().split('\n').pop() ?? '';
  const envelope = JSON.parse(lastLine) as { outcome?: string };
  return { ok: envelope.outcome === 'ok', failing: [], readable: true, detail: lastLine };
}

/**
 * `ai-dossier runstate mint`/`post` stubbed as file writes into the same
 * ground-truth directory the test's `GroundTruth` reads from — everything
 * else (`git ...`) runs for real against `repoDir`. Mirrors the
 * `stubbedExec` pattern `integration.test.ts` already uses for `gh`.
 *
 * `npx ... claim` (the pool-claim attempt in `runBatchSetup`, #561) is also
 * intercepted rather than left to fall through to `realExec`: none of these
 * scratch repos has a pool configured, so a real `npx` call here would be
 * genuinely slow/network-dependent for every existing test in this file, not
 * just the new pool-specific ones. `poolClaimPath` defaults to `null` — "no
 * warm spares available", which is what every scratch repo's real state
 * actually is — and a test opts into a simulated warm claim by passing a path.
 */
function fakeBatchExec(
  milestonesDir: string,
  realExec: ExecFn,
  poolClaimPath: string | null = null,
  /** #561: force this bin (e.g. `npm`) to report failure — for the `batch-warmup-failed` regression case, without depending on some real npm invocation's exact failure conditions. */
  failCommand: string | null = null
): ExecFn {
  // #677: claims are STATEFUL — a real pool never hands the same warm spare
  // to two callers, so only the FIRST claim (batch-setup's) gets
  // `poolClaimPath`; later claims (member-worktree prep) read as "no warm
  // spares" and take the cold path, exactly like a real single-spare pool.
  let claimsServed = 0;
  return (file, args, cwd) => {
    if (failCommand && file === failCommand) return null;
    // Argv position, not `includes` — a branch/path argument could otherwise
    // coincidentally equal 'claim'/'status'/'return' and misroute.
    if (file === 'npx' && args[2] === 'claim') {
      return ++claimsServed === 1 ? poolClaimPath : null;
    }
    if (file === 'npx' && args[2] === 'status' && poolClaimPath) {
      return JSON.stringify({ worktrees: [] });
    }
    if (file === 'npx' && args[2] === 'return' && poolClaimPath) {
      return JSON.stringify({ verification: { entry_status: 'warm' } });
    }
    if (file === 'ai-dossier') {
      if (args[0] === 'runstate' && args[1] === 'mint') {
        const issue = args[args.indexOf('--issue') + 1];
        return `r-${issue}-fake`;
      }
      if (args[0] === 'runstate' && args[1] === 'post') {
        const get = (flag: string): string | undefined => {
          const i = args.indexOf(flag);
          return i === -1 ? undefined : args[i + 1];
        };
        const issue = get('--issue');
        const phase = get('--phase');
        const status = get('--status');
        const run = get('--run');
        const keys: Record<string, string> = {};
        args.forEach((a, i) => {
          if (a === '--kv') {
            const pair = args[i + 1];
            const eq = pair.indexOf('=');
            if (eq > 0) keys[pair.slice(0, eq)] = pair.slice(eq + 1);
          }
        });
        fs.mkdirSync(milestonesDir, { recursive: true });
        fs.writeFileSync(
          path.join(milestonesDir, `${issue}.json`),
          JSON.stringify({ phase, status, run, at: new Date().toISOString(), keys })
        );
        return '';
      }
      return null;
    }
    return realExec(file, args, cwd);
  };
}

interface BatchHarness {
  deps: EngineDeps;
  config: SchedConfig;
  store: SchedStore;
  spawnDeps: EngineDeps['spawnDeps'];
  truthDir: string;
  /** Isolated `~/.dossier` stand-in (#564) — without this, `recordMemberRunLog` would append to the REAL user's `~/.dossier/runs.jsonl`. */
  homeDir: string;
  tick: () => ReturnType<typeof tick>;
  enqueue: (inputs: EnqueueInput[]) => void;
  state: () => ReturnType<SchedStore['load']>;
}

function batchHarness(
  repoDir: string,
  agentArgs: string[],
  opts?: {
    maxSlots?: number;
    suite?: (worktree: string) => SuiteResult;
    capability?: (worktree: string, capabilityId: string) => CapabilityGateResult;
    /** #561: simulated `npx worktree-pool claim` result — null = no warm spares (default, matches every scratch repo's real state). */
    poolClaimPath?: string | null;
    /** #561: force this bin to fail — for the `batch-warmup-failed` regression case. */
    failWarmupCommand?: string;
  }
): BatchHarness {
  const store = new SchedStore(tmpDir('sched-batch-'));
  const truthDir = tmpDir('sched-batch-truth-');
  const homeDir = tmpDir('sched-batch-home-');
  const realExec: ExecFn = (file, args, cwd) => {
    try {
      return execFileSync(file, args, {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
    } catch {
      return null;
    }
  };
  const deps: EngineDeps = {
    store,
    journal: new Journal(store.dir),
    groundTruth: fileBatchGroundTruth(truthDir),
    spawnDeps: createSpawnDeps(),
    now: () => new Date(),
    repoDir,
    homeDir,
    teardownExec: realExec,
    batchExec: fakeBatchExec(
      truthDir,
      realExec,
      opts?.poolClaimPath ?? null,
      opts?.failWarmupCommand ?? null
    ),
    runBatchSuite: opts?.suite ?? (() => ({ ok: true, failing: [] })),
    ...(opts?.capability ? { runBatchCapability: opts.capability } : {}),
  };
  const config: SchedConfig = {
    max_slots: opts?.maxSlots ?? 2,
    dispatch: {
      command: ['node', FAKE_AGENT, ...agentArgs, `--milestones-dir=${truthDir}`],
      prompt: 'placeholder — every builder below (member/tail/report/fix) renders its own prompt',
    },
  };
  return {
    deps,
    config,
    store,
    spawnDeps: deps.spawnDeps,
    truthDir,
    homeDir,
    tick: () => tick(deps, config),
    enqueue: (inputs) =>
      store.withLock((state) => ({
        state: enqueueEntries(state, inputs, new Date()),
        result: null,
      })),
    state: () => store.load(),
  };
}

function batchSlotPid(h: BatchHarness, batchId: string): number | undefined {
  const slot = h.state().slots.find((s) => s.unit === `batch:${batchId}`);
  return slot?.pid ?? undefined;
}

/** `BatchDispatchDeps` sliced from a `batchHarness`'s `EngineDeps` (#583 `sched resume --batch` tests) — mirrors `engine.ts`'s own `EngineDeps → BatchDispatchDeps` mapping. */
function batchDispatchDepsFrom(
  h: BatchHarness,
  capability: (worktree: string, id: string) => CapabilityGateResult
): BatchDispatchDeps {
  return {
    store: h.deps.store,
    journal: h.deps.journal,
    groundTruth: h.deps.groundTruth,
    spawnDeps: h.deps.spawnDeps,
    now: h.deps.now,
    repoDir: h.deps.repoDir,
    exec: h.deps.batchExec as ExecFn,
    runSuite: h.deps.runBatchSuite as (worktree: string) => SuiteResult,
    runCapability: capability,
  };
}

describe('integration #523: batch dispatch (real git worktree, real spawned fake agents)', () => {
  it('3-member happy path: setup → 3 serial members → validate → tail → merge → report → done', async () => {
    const repo = scratchRepo();
    const h = batchHarness(repo, ['--mode=batch'], { maxSlots: 1 });
    h.enqueue([
      { issue: 601, mode: 'slot', batch: 'b-happy', anchor: 600, tier: 'mid' },
      { issue: 602, mode: 'slot', batch: 'b-happy', tier: 'mid' },
      { issue: 603, mode: 'slot', batch: 'b-happy', tier: 'mid' },
    ]);
    // b-happy is already sealed forming → ready by enqueueEntries

    // Tick 1: claims the batch, runs REAL batch-setup (branch+worktree+push
    // against the scratch repo), spawns member 1.
    let result = h.tick();
    expect(result.spawned).toEqual(['batch:b-happy']);
    let batch = findBatch(h.state(), 'b-happy');
    expect(batch?.status).toBe('executing');
    expect(batch?.executing_member).toBe(1);
    expect(batch?.branch).toBe(
      `batch/b-happy-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`
    );
    expect(batch?.worktree).toBeTruthy();
    expect(fs.existsSync(batch?.worktree as string)).toBe(true);
    expect(batch?.run_id).toBe('r-600-fake');

    // Member 1 posts review done and exits; the engine advances to member 2.
    let pid = batchSlotPid(h, 'b-happy') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    result = h.tick();
    expect(result.completed).toEqual(['batch:b-happy']);
    expect(result.spawned).toEqual(['batch:b-happy']); // member 2 dispatched same tick
    batch = findBatch(h.state(), 'b-happy');
    expect(batch?.status).toBe('executing');
    expect(batch?.executing_member).toBe(2);

    // Member 2.
    pid = batchSlotPid(h, 'b-happy') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    result = h.tick();
    expect(result.spawned).toEqual(['batch:b-happy']); // member 3
    batch = findBatch(h.state(), 'b-happy');
    expect(batch?.executing_member).toBe(3);

    // Member 3 (the last): completing it runs the (fake, injected) aggregate
    // suite inline and — green — spawns the tail agent.
    pid = batchSlotPid(h, 'b-happy') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    result = h.tick();
    batch = findBatch(h.state(), 'b-happy');
    expect(batch?.status).toBe('reviewing');
    expect(result.spawned).toEqual(['batch:b-happy']); // the tail agent

    // The tail agent posts batch-review done then batch-ship awaiting-merge
    // (pr=9000) and exits — a verified park, zero slots held (AC5).
    pid = batchSlotPid(h, 'b-happy') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    result = h.tick();
    expect(result.parked).toEqual(['batch:b-happy']);
    batch = findBatch(h.state(), 'b-happy');
    expect(batch?.status).toBe('awaiting-merge');
    expect(batch?.pr).toBe(9000);
    expect(h.state().slots.every((s) => s.status === 'idle')).toBe(true); // AC5

    // The PR merges — the watcher accepts it, members ship, the batch report
    // agent is dispatched.
    fs.writeFileSync(
      path.join(h.truthDir, '9000.pr.json'),
      JSON.stringify({ state: 'MERGED', mergedAt: new Date().toISOString() })
    );
    result = h.tick();
    expect(result.mergeAccepted).toEqual(['batch:b-happy']);
    batch = findBatch(h.state(), 'b-happy');
    expect(batch?.status).toBe('deployed');
    for (const issue of [601, 602, 603]) {
      expect(h.state().entries.find((e) => e.issue === issue)?.status).toBe('done');
    }

    // deployed with no live slot → the report agent claims one next tick.
    result = h.tick();
    expect(result.spawned).toEqual(['batch:b-happy']);
    pid = batchSlotPid(h, 'b-happy') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);

    // batch-report done → reported → done, worktree torn down for real.
    result = h.tick();
    expect(result.completed).toEqual(['batch:b-happy']);
    batch = findBatch(h.state(), 'b-happy');
    expect(batch?.status).toBe('done');
    expect(fs.existsSync(batch?.worktree as string)).toBe(false);

    // #564: every completed member recorded its OWN runs.jsonl entry,
    // attributed to `issue:<memberIssue>` — the same unit scheme ordinary
    // engine-dispatched issues use, so it shows up in the default `sched
    // stats` view with no batch-aware read-side needed. The fake agent's
    // stdout isn't Claude-CLI-shaped JSON, so tokens degrade to null
    // (`usage=missing`, #564 AC2) rather than a thrown error or a dropped row.
    const runsLog = path.join(h.homeDir, '.dossier', 'runs.jsonl');
    const lines = fs
      .readFileSync(runsLog, 'utf-8')
      .trim()
      .split('\n')
      .map(
        (l) => JSON.parse(l) as { unit: string; input_tokens: number | null; tier: string | null }
      );
    for (const issue of [601, 602, 603]) {
      const entry = lines.find((l) => l.unit === `issue:${issue}`);
      expect(entry).toBeTruthy();
      expect(entry?.input_tokens).toBeNull();
      // #564 AC1 re-verification: `tier` (enqueued as 'mid' for all three
      // members) must reach the written entry, not just the in-memory
      // `RunLogEntry` a unit test hand-builds — this is the actual write path.
      expect(entry?.tier).toBe('mid');
    }
  }, 60_000);

  it('one member evicted (RFC F.1): batch continues with the survivors and still ships', async () => {
    const repo = scratchRepo();
    const h = batchHarness(repo, ['--mode=batch', '--evict-members=702'], { maxSlots: 1 });
    h.enqueue([
      { issue: 701, mode: 'slot', batch: 'b-evict', anchor: 700, tier: 'mid' },
      { issue: 702, mode: 'slot', batch: 'b-evict', tier: 'mid' },
      { issue: 703, mode: 'slot', batch: 'b-evict', tier: 'mid' },
    ]);
    // b-evict is already sealed forming → ready by enqueueEntries

    h.tick(); // batch-setup + member 1
    let pid = batchSlotPid(h, 'b-evict') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    h.tick(); // member 1 green → member 2 (the evicted one)
    expect(findBatch(h.state(), 'b-evict')?.executing_member).toBe(2);

    // Member 2 posts `status=blocked mode=slot` — evicted directly, no
    // attribution/revert (RFC F.1: it never went green, nothing to revert).
    pid = batchSlotPid(h, 'b-evict') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    const result = h.tick();
    let batch = findBatch(h.state(), 'b-evict');
    expect(batch?.evictions).toHaveLength(1);
    expect(batch?.evictions[0]).toMatchObject({ issue: 702, reason: 'test-failures' });
    // 1/3 evicted does NOT cross the >⅓ dissolve threshold — the batch
    // continues to member 3, not dissolved.
    expect(batch?.status).toBe('executing');
    expect(batch?.executing_member).toBe(3);
    expect(result.spawned).toContain('batch:b-evict'); // member 3 dispatched
    expect(h.state().entries.find((e) => e.issue === 702)?.mode).toBe('full'); // requeued full-cycle
    expect(h.state().entries.find((e) => e.issue === 702)?.batch).toBeNull();

    // #564: a blocked/evicted member still recorded its own dispatch cost —
    // it consumed real tokens before self-reporting blocked, so its entry
    // must exist same as a completed member's (AC2: never silently omitted).
    const runsLog = path.join(h.homeDir, '.dossier', 'runs.jsonl');
    const evictedEntry = fs
      .readFileSync(runsLog, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { unit: string })
      .find((l) => l.unit === 'issue:702');
    expect(evictedEntry).toBeTruthy();

    // Member 3 green — last member — validate (green) → tail.
    pid = batchSlotPid(h, 'b-evict') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    h.tick();
    batch = findBatch(h.state(), 'b-evict');
    expect(batch?.status).toBe('reviewing');

    // Tail parks the PR — the batch ships with the 2 surviving members.
    pid = batchSlotPid(h, 'b-evict') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    const parked = h.tick();
    expect(parked.parked).toEqual(['batch:b-evict']);
    expect(findBatch(h.state(), 'b-evict')?.status).toBe('awaiting-merge');
  }, 60_000);

  it('a member that exits with no milestone at all (agent-exited-unverified) is evicted with last_tool attributed (#591/#620 AC4)', async () => {
    const repo = scratchRepo();
    // No package.json, so batch-setup's warmup step never creates
    // `node_modules/<require-dep>` — the member's first action (resolving it
    // under the worktree) fails and it `process.exit(1)`s having posted NO
    // milestone at all: the `dead && !blockedNow` branch of
    // `reconcileMemberSlot`, distinct from every other eviction test in this
    // file (which all evict via a SELF-REPORTED `blocked` milestone).
    const h = batchHarness(repo, ['--mode=batch', '--require-dep=totally-missing-pkg-620'], {
      maxSlots: 1,
    });
    h.enqueue([{ issue: 901, mode: 'slot', batch: 'b-unverified', anchor: 900, tier: 'mid' }]);
    // b-unverified is already sealed forming → ready by enqueueEntries

    h.tick(); // batch-setup + member 1 spawns, then dies before posting anything
    const pid = batchSlotPid(h, 'b-unverified') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    expect(fs.existsSync(path.join(h.truthDir, '901.json'))).toBe(false); // no milestone posted

    // The agent's own log has no Claude-CLI-shaped output (it's a plain
    // stderr line), so nothing is parseable yet — append one tool_use event
    // the same shape a real headless agent's dispatch log carries, mirroring
    // exactly what `engine.ts`'s equivalent regression test does for the
    // full-cycle path.
    writeToolUseLog(batchMemberLogPath(h.deps.store.runsDir, 'b-unverified', 1, 901));

    const result = h.tick(); // reconciles the dead member: no milestone → agent-exited-unverified
    expect(result.failed).toContain('batch:b-unverified');
    const batch = findBatch(h.state(), 'b-unverified');
    expect(batch?.evictions).toHaveLength(1);
    expect(batch?.evictions[0]).toMatchObject({ issue: 901, reason: 'agent-exited-unverified' });

    const failedEvent = h.deps.journal
      .read()
      .find((e) => e.event === 'unit-failed' && e.issue === 901);
    expect(failedEvent?.reason).toBe('agent-exited-unverified');
    expect(failedEvent?.last_tool).toBe('Monitor');
  }, 60_000);

  it('#629: a member dying on a confirmed provider API error is NOT evicted — it is recorded against the shared pause and retried in place', async () => {
    const repo = scratchRepo();
    // Same dead-before-any-milestone shape as the test above (a missing
    // require-dep kills the member before it can post anything) — the only
    // difference is what the member's own log says about WHY it died.
    const h = batchHarness(repo, ['--mode=batch', '--require-dep=totally-missing-pkg-629'], {
      maxSlots: 1,
    });
    h.enqueue([{ issue: 901, mode: 'slot', batch: 'b-api-error', anchor: 900, tier: 'mid' }]);

    h.tick(); // batch-setup + member 1 spawns, then dies before posting anything
    const pid = batchSlotPid(h, 'b-api-error') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    expect(fs.existsSync(path.join(h.truthDir, '901.json'))).toBe(false);

    // A confirmed 429, not a real crash — the exact shape #629's own incident
    // captured.
    writeApiErrorLog(batchMemberLogPath(h.deps.store.runsDir, 'b-api-error', 1, 901));

    const result = h.tick(); // reconciles the dead member: confirmed API error, not agent-exited-unverified
    const batch = findBatch(h.state(), 'b-api-error');
    expect(batch?.evictions).toHaveLength(0); // NEVER evicted — real work is not thrown away for a wall
    expect(result.failed).not.toContain('batch:b-api-error');

    const failureEvent = h.deps.journal
      .read()
      .find((e) => e.event === 'dispatch-failure' && e.unit === 'batch:b-api-error');
    expect(failureEvent).toBeDefined();
    expect(failureEvent?.detail).toContain('spend limit');
    expect(h.state().consecutive_dispatch_api_errors).toBe(1);
    expect(h.deps.journal.read().some((e) => e.event === 'unit-failed' && e.issue === 901)).toBe(
      false
    );

    // The member keeps its position — `runBatchTick`'s "same wedge" retry
    // (`spawnMemberContinuation`) respawns it in place on the next tick.
    const retryResult = h.tick();
    expect(retryResult.spawned).toEqual(['batch:b-api-error']);
    expect(findBatch(h.state(), 'b-api-error')?.executing_member).toBe(1);
  }, 60_000);

  it("#629: a SECOND dead exit with no result event is NOT misclassified against the first attempt's stale 429 — log_offset_at_spawn fences the classification", async () => {
    const repo = scratchRepo();
    const h = batchHarness(repo, ['--mode=batch', '--require-dep=totally-missing-pkg-629b'], {
      maxSlots: 1,
    });
    h.enqueue([{ issue: 902, mode: 'slot', batch: 'b-api-error-2', anchor: 900, tier: 'mid' }]);

    // First attempt: dies, gets classified as a confirmed API error (as above).
    h.tick();
    let pid = batchSlotPid(h, 'b-api-error-2') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    writeApiErrorLog(batchMemberLogPath(h.deps.store.runsDir, 'b-api-error-2', 1, 902));
    h.tick();
    expect(h.state().consecutive_dispatch_api_errors).toBe(1);
    expect(findBatch(h.state(), 'b-api-error-2')?.evictions).toHaveLength(0);

    // Second attempt (the retry `runBatchTick` dispatched): dies again, but
    // THIS time writes nothing at all — a genuine crash, exactly the
    // #629-incident shape (killed, OOM, no result event). Without offset
    // fencing, `readDispatchApiError` would re-read the FIRST attempt's
    // 429 result (still the last `type:"result"` line in the append-mode
    // file) and wrongly classify this as a SECOND confirmed API error
    // instead of evicting a member that never posted anything.
    h.tick();
    pid = batchSlotPid(h, 'b-api-error-2') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    const result = h.tick();

    expect(result.failed).toContain('batch:b-api-error-2');
    const batch = findBatch(h.state(), 'b-api-error-2');
    expect(batch?.evictions).toHaveLength(1);
    expect(batch?.evictions[0]).toMatchObject({ issue: 902, reason: 'agent-exited-unverified' });
    // The confirmed-api-error streak was NOT incremented a second time —
    // this exit correctly read as "no signal", not "another 429".
    expect(h.state().consecutive_dispatch_api_errors).toBe(1);
  }, 60_000);

  it('#629: while paused, runBatchTick does not claim a READY batch or respawn a wedge — sched resume unwedges it', async () => {
    const repo = scratchRepo();
    // maxSlots: 2 — both the held retry and the other ready batch have their
    // OWN slot once resumed, so this test's assertion isolates "did the
    // pause hold them" from "did they have to wait a tick for capacity".
    const h = batchHarness(repo, ['--mode=batch', '--require-dep=totally-missing-pkg-629c'], {
      maxSlots: 2,
    });
    h.enqueue([{ issue: 903, mode: 'slot', batch: 'b-api-error-3', anchor: 900, tier: 'mid' }]);

    h.tick();
    let pid = batchSlotPid(h, 'b-api-error-3') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    writeApiErrorLog(batchMemberLogPath(h.deps.store.runsDir, 'b-api-error-3', 1, 903));
    h.tick(); // count=1, not yet paused — slot released, no respawn THIS tick
    expect(h.state().consecutive_dispatch_api_errors).toBe(1);
    expect(h.state().paused).toBe(false);

    h.tick(); // `runBatchTick`'s "same wedge" retry spawns attempt 2
    pid = batchSlotPid(h, 'b-api-error-3') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    writeApiErrorLog(batchMemberLogPath(h.deps.store.runsDir, 'b-api-error-3', 1, 903));
    h.tick(); // dead again — count=2, threshold reached, paused

    expect(h.state().paused).toBe(true);
    expect(h.state().consecutive_dispatch_api_errors).toBe(2);

    // A second, unrelated ready batch must not be claimed while paused
    // either — `claimAndSetup` is a provider dispatch (`batch-setup`) too.
    h.enqueue([{ issue: 950, mode: 'slot', batch: 'b-other', anchor: 951, tier: 'mid' }]);
    const heldResult = h.tick();
    expect(findBatch(h.state(), 'b-other')?.status).toBe('ready'); // never claimed
    expect(heldResult.spawned).not.toContain('batch:b-other');
    expect(heldResult.spawned).not.toContain('batch:b-api-error-3');

    // `sched resume` is the unwedge path for both.
    h.store.withLock((s) => ({ state: setPaused(s, false), result: null }));
    const resumed = h.tick();
    expect(resumed.spawned).toContain('batch:b-api-error-3');
  }, 60_000);

  it('dissolve (RFC F.8): >⅓ evicted requeues every unshipped member, batch never ships', async () => {
    const repo = scratchRepo();
    const h = batchHarness(repo, ['--mode=batch', '--evict-members=802,803'], { maxSlots: 1 });
    h.enqueue([
      { issue: 801, mode: 'slot', batch: 'b-dissolve', anchor: 800, tier: 'mid' },
      { issue: 802, mode: 'slot', batch: 'b-dissolve', tier: 'mid' },
      { issue: 803, mode: 'slot', batch: 'b-dissolve', tier: 'mid' },
    ]);
    // b-dissolve is already sealed forming → ready by enqueueEntries

    h.tick(); // batch-setup + member 1 (801, survives)
    let pid = batchSlotPid(h, 'b-dissolve') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    h.tick(); // member 1 green → member 2 (802, will be evicted)

    pid = batchSlotPid(h, 'b-dissolve') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    let result = h.tick(); // 802 evicted (1/3 — not yet over threshold) → member 3 (803, also evicted)
    let batch = findBatch(h.state(), 'b-dissolve');
    expect(batch?.status).toBe('executing');
    expect(batch?.evictions).toHaveLength(1);

    pid = batchSlotPid(h, 'b-dissolve') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    result = h.tick(); // 803 evicted → 2/3 > ⅓ → dissolve
    batch = findBatch(h.state(), 'b-dissolve');
    expect(batch?.status).toBe('dissolved');
    expect(batch?.evictions).toHaveLength(2);
    expect(result.failed).toContain('batch:b-dissolve');

    // Nothing green was discarded: the surviving member (801, already
    // shipped-in-batch-worthy work) keeps its outcome; 802/803 requeue
    // full-cycle. No batch worktree ever reaches `reviewing`/ships a PR.
    const entries = h.state().entries;
    expect(entries.find((e) => e.issue === 802)?.mode).toBe('full');
    expect(entries.find((e) => e.issue === 803)?.mode).toBe('full');
    expect(h.state().slots.every((s) => s.status === 'idle')).toBe(true);
    // The dissolved batch's shared worktree is torn down for real, not
    // leaked (it would otherwise never be removed by anything else).
    expect(batch?.worktree).toBeTruthy();
    expect(fs.existsSync(batch?.worktree as string)).toBe(false);
  }, 60_000);

  it('#613: two resolutions of the same member against one stale batch snapshot never double-advance or double-journal', async () => {
    // The production defect (#613) is a cross-process race: two scheduler
    // ticks each read `executing_member` before either one's advance lands,
    // so both resolve the SAME member. `runBatchTick`/`resumeBlockedGate`
    // always read state fresh, so the public API cannot reproduce this —
    // proving the guard requires calling the eviction rail directly, twice,
    // against one captured pre-advance snapshot (exactly what two racing
    // reads would each see).
    const repo = scratchRepo();
    const h = batchHarness(repo, ['--mode=batch'], { maxSlots: 1 });
    h.enqueue([
      { issue: 941, mode: 'slot', batch: 'b-race', anchor: 940, tier: 'mid' },
      { issue: 942, mode: 'slot', batch: 'b-race', tier: 'mid' },
      { issue: 943, mode: 'slot', batch: 'b-race', tier: 'mid' },
    ]);

    h.tick(); // batch-setup + member 1 (941) spawned
    const staleBatch = findBatch(h.state(), 'b-race');
    if (!staleBatch) throw new Error('b-race not found after setup');
    expect(staleBatch.executing_member).toBe(1);
    expect(staleBatch.evictions).toHaveLength(0);

    const dispatch = resolveDispatch(h.config);

    // #677: the eviction rail now tears the member worktree down (real git
    // exec), so the call needs the BatchDispatchDeps slice with `exec` —
    // `h.deps` (EngineDeps) carries batchExec, which is exactly the mapping
    // `engine.ts` uses.
    const dispatchDeps = batchDispatchDepsFrom(h, () => ({ outcome: 'ok' }));

    // First resolution of member 941 — a genuine eviction.
    evictMemberAndContinue(
      dispatchDeps,
      h.config,
      dispatch,
      'b-race',
      staleBatch,
      941,
      { reason: 'test-failures', detail: 'first resolution' },
      new Date(),
      noResult()
    );
    // Second resolution of the SAME member, against the SAME stale snapshot
    // (executing_member still reads 1 here) — what a racing second process
    // would attempt before ever seeing the first process's write.
    evictMemberAndContinue(
      dispatchDeps,
      h.config,
      dispatch,
      'b-race',
      staleBatch,
      941,
      { reason: 'test-failures', detail: 'second (racing) resolution' },
      new Date(),
      noResult()
    );

    const batch = findBatch(h.state(), 'b-race');
    // Pre-fix: the second call re-reads `executing_member` (already advanced
    // to 2 by the first call) and advances it AGAIN to 3 — skipping member
    // 942 entirely without it ever getting its own record — and journals a
    // second `unit-failed`/`member-advanced` naming 941 again. Post-fix: the
    // second resolution is a no-op once `evictMemberDirectly` reports
    // `duplicate: true`.
    expect(batch?.executing_member).toBe(2);
    expect(batch?.evictions).toHaveLength(1);
    expect(batch?.evictions[0]).toMatchObject({ issue: 941, reason: 'test-failures' });

    const events = h.deps.journal.read();
    const unitFailed = events.filter((e) => e.event === 'unit-failed' && e.unit === 'batch:b-race');
    const memberAdvanced = events.filter(
      (e) => e.event === 'member-advanced' && e.unit === 'batch:b-race'
    );
    expect(unitFailed).toHaveLength(1);
    expect(unitFailed[0]?.issue).toBe(941);
    expect(memberAdvanced).toHaveLength(1);
    expect(memberAdvanced[0]?.issue).toBe(941);
  }, 30_000);

  it('#613 AC4: a 4-member batch evicting members 1-3 in sequence names each record after its OWN member, never the previously evicted one', async () => {
    const repo = scratchRepo();
    const h = batchHarness(repo, ['--mode=batch', '--evict-members=911,912,913'], {
      maxSlots: 1,
    });
    h.enqueue([
      { issue: 910, mode: 'slot', batch: 'b-misattrib', anchor: 909, tier: 'mid' },
      { issue: 911, mode: 'slot', batch: 'b-misattrib', tier: 'mid' },
      { issue: 912, mode: 'slot', batch: 'b-misattrib', tier: 'mid' },
      { issue: 913, mode: 'slot', batch: 'b-misattrib', tier: 'mid' },
    ]);

    h.tick(); // batch-setup + member 1 (910, survives)
    let pid = batchSlotPid(h, 'b-misattrib') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    h.tick(); // member 1 green → member 2 (911, will be evicted)
    expect(findBatch(h.state(), 'b-misattrib')?.executing_member).toBe(2);

    pid = batchSlotPid(h, 'b-misattrib') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    h.tick(); // 911 evicted (1/4 — not over threshold) → member 3 (912, also evicted)
    let batch = findBatch(h.state(), 'b-misattrib');
    expect(batch?.status).toBe('executing');
    expect(batch?.evictions).toHaveLength(1);
    expect(batch?.evictions[0]).toMatchObject({ issue: 911 });
    expect(batch?.executing_member).toBe(3);

    pid = batchSlotPid(h, 'b-misattrib') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    h.tick(); // 912 evicted (2/4 — not over threshold) → member 4 (913, also evicted)
    batch = findBatch(h.state(), 'b-misattrib');
    expect(batch?.evictions).toHaveLength(2);
    // #613: each record names its OWN member. Note this tick-driven test does NOT
    // fail against pre-fix code and is not the regression guard — `reconcileMemberSlot`
    // re-derives `memberIssue` from freshly loaded state on every tick, so sequential
    // eviction was already attributed correctly through the public API. The defect is a
    // cross-process race between two ticks that each read `executing_member` before
    // either advance lands; the test above ('two resolutions of the same member against
    // one stale batch snapshot') is the one that encodes it and the one that fails
    // pre-fix. This test guards the ordinary path against a regression in the new claim.
    expect(batch?.evictions[1]).toMatchObject({ issue: 912 });
    expect(batch?.executing_member).toBe(4);

    pid = batchSlotPid(h, 'b-misattrib') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    h.tick(); // 913 evicted (3/4 > ⅓) → dissolve
    batch = findBatch(h.state(), 'b-misattrib');
    expect(batch?.evictions).toHaveLength(3);
    expect(batch?.evictions.map((e) => e.issue)).toEqual([911, 912, 913]);
  }, 60_000);

  it('#613: sequential incremental-gate evictions across a 4-member batch each name their own member', async () => {
    const repo = scratchRepo();
    const h = batchHarness(repo, ['--mode=batch'], {
      maxSlots: 1,
      capability: FOCUSED_GATE_FAILS,
    });
    h.enqueue([
      { issue: 921, mode: 'slot', batch: 'b-gate-misattrib', anchor: 920, tier: 'mid' },
      { issue: 922, mode: 'slot', batch: 'b-gate-misattrib', tier: 'mid' },
      { issue: 923, mode: 'slot', batch: 'b-gate-misattrib', tier: 'mid' },
      { issue: 924, mode: 'slot', batch: 'b-gate-misattrib', tier: 'mid' },
    ]);

    h.tick(); // batch-setup + member 1 (921)
    let pid = batchSlotPid(h, 'b-gate-misattrib') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    h.tick(); // 921 posts review done, gate fails → evicted (1/4) → member 2 (922) spawned
    let batch = findBatch(h.state(), 'b-gate-misattrib');
    expect(batch?.evictions).toHaveLength(1);
    expect(batch?.evictions[0]).toMatchObject({ issue: 921 });
    expect(batch?.executing_member).toBe(2);

    pid = batchSlotPid(h, 'b-gate-misattrib') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    h.tick(); // 922 posts review done, gate fails → evicted (2/4) → member 3 (923) spawned
    batch = findBatch(h.state(), 'b-gate-misattrib');
    expect(batch?.evictions).toHaveLength(2);
    expect(batch?.evictions[1]).toMatchObject({ issue: 922 });
    expect(batch?.executing_member).toBe(3);

    pid = batchSlotPid(h, 'b-gate-misattrib') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    h.tick(); // 923 posts review done, gate fails → evicted (3/4 > ⅓) → dissolve
    batch = findBatch(h.state(), 'b-gate-misattrib');
    expect(batch?.evictions).toHaveLength(3);
    expect(batch?.evictions.map((e) => e.issue)).toEqual([921, 922, 923]);
  }, 60_000);

  it('#562: an unreadable suite report blocks the batch rather than dissolving it — nothing requeued, worktree preserved', async () => {
    const repo = scratchRepo();
    // Simulates the make-delegated-script bug (#562): the runner never got a
    // parseable report at all, distinct from a genuinely red, PARSEABLE
    // suite. `beginAttribution` would read `failing: []` as "nothing to
    // attribute" and dissolve — `readable: false` must route elsewhere.
    const h = batchHarness(repo, ['--mode=batch'], {
      maxSlots: 1,
      suite: () => ({
        ok: false,
        failing: [],
        readable: false,
        detail: "make: unrecognized option '--reporter=json'",
      }),
    });
    h.enqueue([{ issue: 901, mode: 'slot', batch: 'b-unreadable', anchor: 900, tier: 'mid' }]);
    // b-unreadable is already sealed forming → ready by enqueueEntries

    h.tick(); // batch-setup + the (only) member
    const pid = batchSlotPid(h, 'b-unreadable') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);

    // The member is the last one — completing it runs the (fake, injected)
    // unreadable suite inline. Blocked, not dissolved: no requeue, no revert.
    const result = h.tick();
    const batch = findBatch(h.state(), 'b-unreadable');
    expect(batch?.status).toBe('blocked');
    expect(result.failed).toContain('batch:b-unreadable');
    expect(result.blocked).toEqual([]); // nothing requeued — the whole point of #562

    const entry = h.state().entries.find((e) => e.issue === 901);
    expect(entry?.mode).toBe('slot'); // never flipped to 'full' (no requeue)
    expect(entry?.batch).toBe('b-unreadable'); // still owned by the batch

    // The worktree is preserved (never torn down) — unlike a dissolve, which
    // tears it down — so an operator can fix the suite command and resume.
    expect(batch?.worktree).toBeTruthy();
    expect(fs.existsSync(batch?.worktree as string)).toBe(true);
  }, 60_000);

  it('#562 AC5: a 2-member docs batch ships green end-to-end via a REAL `ai-dossier cap run test.full` (no mocked suite result)', async () => {
    const repo = scratchRepoWithRealSuite();
    // Unlike every other test in this file, `suite` is not a canned result —
    // it shells the real `ai-dossier` binary against the batch worktree,
    // which really does have the manifest+Makefile seeded above (a git
    // worktree of the branch `scratchRepoWithRealSuite` pushed). This is
    // tier 1 of `cli/src/batch-suite-runner.ts`'s resolution order, run for
    // real — the same mechanism that fixes THIS repo's own batch path.
    const h = batchHarness(repo, ['--mode=batch'], { maxSlots: 1, suite: realCapRunSuite });
    h.enqueue([
      { issue: 1001, mode: 'slot', batch: 'b-ac5', anchor: 1000, tier: 'mid' },
      { issue: 1002, mode: 'slot', batch: 'b-ac5', tier: 'mid' },
    ]);
    // b-ac5 is already sealed forming → ready by enqueueEntries

    h.tick(); // batch-setup + member 1
    let pid = batchSlotPid(h, 'b-ac5') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    h.tick(); // member 1 green → member 2

    // Member 2 (the last): completing it runs the REAL `cap run test.full`
    // inline against the real batch worktree — green — and spawns the tail.
    pid = batchSlotPid(h, 'b-ac5') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    const result = h.tick();
    const batch = findBatch(h.state(), 'b-ac5');
    expect(batch?.status).toBe('reviewing');
    expect(result.spawned).toEqual(['batch:b-ac5']); // the tail agent

    // The tail agent parks the PR — the batch ships with both members,
    // driven by a real green suite run, not a test fixture.
    pid = batchSlotPid(h, 'b-ac5') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    const parked = h.tick();
    expect(parked.parked).toEqual(['batch:b-ac5']);
    expect(findBatch(h.state(), 'b-ac5')?.status).toBe('awaiting-merge');
  }, 60_000);

  it('incremental gate (AC2): a member that posts review done but fails cap run test.focused is evicted', async () => {
    const repo = scratchRepo();
    const h = batchHarness(repo, ['--mode=batch'], {
      maxSlots: 1,
      capability: FOCUSED_GATE_FAILS,
    });
    h.enqueue([
      { issue: 901, mode: 'slot', batch: 'b-gate', anchor: 900, tier: 'mid' },
      { issue: 902, mode: 'slot', batch: 'b-gate', tier: 'mid' },
      { issue: 903, mode: 'slot', batch: 'b-gate', tier: 'mid' },
    ]);
    // b-gate is already sealed forming → ready by enqueueEntries

    h.tick(); // batch-setup + member 1
    const pid = batchSlotPid(h, 'b-gate') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);

    // Member 1 posts `review done` for real, but the incremental gate
    // (test.focused) reports `task-failed` — evicted directly, same rail as
    // a self-reported block, never reaching attribution/revert.
    const result = h.tick();
    const batch = findBatch(h.state(), 'b-gate');
    expect(batch?.evictions).toHaveLength(1);
    expect(batch?.evictions[0]).toMatchObject({
      issue: 901,
      reason: 'incremental-gate-failed:test.focused',
    });
    expect(h.state().entries.find((e) => e.issue === 901)?.mode).toBe('full');
    // Only one member left — batch continues to it rather than wedging.
    expect(batch?.status).toBe('executing');
    expect(batch?.executing_member).toBe(2);
    expect(result.spawned).toContain('batch:b-gate');
  }, 60_000);

  it('#594 AC4: a task-failed gate outcome with zero test output blocks the batch and does not evict the member', async () => {
    const repo = scratchRepo();
    // The pilot attempt-4 shape (docs/agent-traps.md): a `task-failed` whose
    // captured output is only a wrapper script's own framing plus a `tee`
    // error — no test names, no failure markers.
    const capability: (worktree: string, id: string) => CapabilityGateResult = (_worktree, id) =>
      id === 'test.focused'
        ? {
            outcome: 'task-failed',
            outputTail: 'Running focused suite...\ntee: /dev/stderr: No such device or address\n',
          }
        : { outcome: 'ok' };
    const h = batchHarness(repo, ['--mode=batch'], { maxSlots: 1, capability });
    h.enqueue([
      { issue: 2401, mode: 'slot', batch: 'b-unreadable', anchor: 2400, tier: 'mid' },
      { issue: 2402, mode: 'slot', batch: 'b-unreadable', tier: 'mid' },
    ]);

    h.tick(); // batch-setup + member 1
    const pid = batchSlotPid(h, 'b-unreadable') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);

    const result = h.tick();
    const batch = findBatch(h.state(), 'b-unreadable');
    // Not evicted: the member's commit/review stands, nothing requeued —
    // exactly #585's block-the-batch path, joined by an evidence-free
    // task-failed rather than only automation-broken/capability-unavailable.
    expect(batch?.evictions).toHaveLength(0);
    expect(h.state().entries.find((e) => e.issue === 2401)?.mode).toBe('slot');
    expect(batch?.status).toBe('blocked');
    expect(batch?.blocked_reason).toBe('gate-inconclusive:test.focused');
    expect(batch?.member_gates?.['2401']).toMatchObject({
      capability: 'test.focused',
      outcome: 'task-failed',
    });
    expect(h.state().slots.find((s) => s.unit === 'batch:b-unreadable')).toBeUndefined();
    expect(result.failed).toContain('batch:b-unreadable');

    const events = h.deps.journal.read();
    const inconclusive = events.find(
      (e) => e.event === 'gate-inconclusive' && e.unit === 'batch:b-unreadable'
    );
    // The journal names which of the two branches fired (AC3) — the detail
    // says `task-failed`, not `automation-broken`/`capability-unavailable`,
    // so a later run does not have to re-derive it from the gate log.
    expect(inconclusive?.detail).toContain('reported task-failed');
  }, 60_000);

  it('#594 AC5: a task-failed gate outcome with real failing-test output still evicts the member', async () => {
    const repo = scratchRepo();
    const capability: (worktree: string, id: string) => CapabilityGateResult = (_worktree, id) =>
      id === 'test.focused'
        ? {
            outcome: 'task-failed',
            outputTail: 'FAIL src/foo.test.ts\n  ✗ should do the thing\n',
          }
        : { outcome: 'ok' };
    const h = batchHarness(repo, ['--mode=batch'], { maxSlots: 1, capability });
    h.enqueue([
      { issue: 2501, mode: 'slot', batch: 'b-earned', anchor: 2500, tier: 'mid' },
      { issue: 2502, mode: 'slot', batch: 'b-earned', tier: 'mid' },
    ]);

    h.tick(); // batch-setup + member 1
    const pid = batchSlotPid(h, 'b-earned') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);

    const result = h.tick();
    const batch = findBatch(h.state(), 'b-earned');
    expect(batch?.evictions).toHaveLength(1);
    expect(batch?.evictions[0]).toMatchObject({
      issue: 2501,
      reason: 'incremental-gate-failed:test.focused',
    });
    expect(h.state().entries.find((e) => e.issue === 2501)?.mode).toBe('full');
    expect(batch?.status).toBe('executing');
    expect(batch?.executing_member).toBe(2);
    expect(result.spawned).toContain('batch:b-earned');
  }, 60_000);

  // #594 review: the evidence bar is per capability. A compiler cannot print
  // `FAIL`/`✗`, so holding `typecheck.run` to test-shaped output would route
  // every genuine build break to the block path — and `sched resume --batch`
  // re-runs the same deterministically failing typecheck, so the batch would
  // wedge there with no automated exit, on a failure the member really caused.
  it('#594: a typecheck failure with compiler output evicts the member — the gate does not wedge on a real build break', async () => {
    const repo = scratchRepo();
    const capability: (worktree: string, id: string) => CapabilityGateResult = (_worktree, id) =>
      id === 'typecheck.run'
        ? {
            outcome: 'task-failed',
            outputTail:
              "src/a.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error in 1 file.\n",
          }
        : { outcome: 'ok' };
    const h = batchHarness(repo, ['--mode=batch'], { maxSlots: 1, capability });
    h.enqueue([
      { issue: 2601, mode: 'slot', batch: 'b-tsc', anchor: 2600, tier: 'mid' },
      { issue: 2602, mode: 'slot', batch: 'b-tsc', tier: 'mid' },
    ]);

    h.tick(); // batch-setup + member 1
    const pid = batchSlotPid(h, 'b-tsc') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);

    h.tick();
    const batch = findBatch(h.state(), 'b-tsc');
    expect(batch?.evictions).toHaveLength(1);
    expect(batch?.evictions[0]).toMatchObject({
      issue: 2601,
      reason: 'incremental-gate-failed:typecheck.run',
    });
    expect(batch?.status).toBe('executing');
  }, 60_000);

  // #594 review: `member_gates` must name the gate the batch was ROUTED on.
  // Recording the raw failure instead would show a `task-failed` member on a
  // batch blocked as inconclusive — and name a different capability than
  // `blocked_reason`, which is the one `sched resume --batch` rechecks.
  it('#594: member_gates records the deciding gate, not the unevidenced failure beside it', async () => {
    const repo = scratchRepo();
    const capability: (worktree: string, id: string) => CapabilityGateResult = (_worktree, id) =>
      id === 'typecheck.run'
        ? { outcome: 'task-failed', outputTail: 'build wrapper: exited 1\n' }
        : { outcome: 'automation-broken', outputTail: 'pnpm filter matched zero projects' };
    const h = batchHarness(repo, ['--mode=batch'], { maxSlots: 1, capability });
    h.enqueue([
      { issue: 2701, mode: 'slot', batch: 'b-decisive', anchor: 2700, tier: 'mid' },
      { issue: 2702, mode: 'slot', batch: 'b-decisive', tier: 'mid' },
    ]);

    h.tick(); // batch-setup + member 1
    const pid = batchSlotPid(h, 'b-decisive') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);

    h.tick();
    const batch = findBatch(h.state(), 'b-decisive');
    expect(batch?.evictions).toHaveLength(0);
    expect(batch?.status).toBe('blocked');
    expect(batch?.blocked_reason).toBe('gate-inconclusive:test.focused');
    expect(batch?.member_gates?.['2701']).toMatchObject({
      capability: 'test.focused',
      outcome: 'automation-broken',
    });
  }, 60_000);

  it('#583 AC1: an automation-broken gate outcome blocks the batch instead of evicting the member', async () => {
    const repo = scratchRepo();
    const capability: (worktree: string, id: string) => CapabilityGateResult = (_worktree, id) =>
      id === 'test.focused'
        ? { outcome: 'automation-broken', outputTail: 'pnpm filter matched zero projects' }
        : { outcome: 'ok' };
    const h = batchHarness(repo, ['--mode=batch'], { maxSlots: 1, capability });
    h.enqueue([
      { issue: 2001, mode: 'slot', batch: 'b-inconclusive', anchor: 2000, tier: 'mid' },
      { issue: 2002, mode: 'slot', batch: 'b-inconclusive', tier: 'mid' },
    ]);

    h.tick(); // batch-setup + member 1
    const pid = batchSlotPid(h, 'b-inconclusive') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);

    const result = h.tick();
    const batch = findBatch(h.state(), 'b-inconclusive');
    // Not evicted: the member's commit/review stands, nothing requeued.
    expect(batch?.evictions).toHaveLength(0);
    expect(h.state().entries.find((e) => e.issue === 2001)?.mode).toBe('slot');
    expect(batch?.status).toBe('blocked');
    expect(batch?.blocked_reason).toBe('gate-inconclusive:test.focused');
    expect(batch?.member_gates?.['2001']).toMatchObject({
      capability: 'test.focused',
      outcome: 'automation-broken',
      output_tail: 'pnpm filter matched zero projects',
    });
    // The slot is released — the batch is not silently wedged.
    expect(h.state().slots.find((s) => s.unit === 'batch:b-inconclusive')).toBeUndefined();
    expect(result.failed).toContain('batch:b-inconclusive');

    const events = h.deps.journal.read();
    const inconclusive = events.find(
      (e) => e.event === 'gate-inconclusive' && e.unit === 'batch:b-inconclusive'
    );
    expect(inconclusive?.detail).toContain('pnpm filter matched zero projects');
  }, 60_000);

  it('#625: an UNDECLARED capability does NOT block — the batch proceeds on the checks that exist', async () => {
    // REVERSES this test's original assertion (#583 AC1, "capability-unavailable
    // also blocks the batch"). #583's block-the-batch rail is for a DECLARED
    // capability whose machinery could not be trusted; an id nobody wrote down
    // is not a verdict at all, it is a repo that has not opted into this half
    // of the gate. Blocking on it made batching opt-in per repo behind an
    // undocumented, source-only requirement.
    const repo = scratchRepo();
    const capability: (worktree: string, id: string) => CapabilityGateResult = (_worktree, id) =>
      id === 'test.focused' ? { outcome: 'capability-unavailable' } : { outcome: 'ok' };
    const h = batchHarness(repo, ['--mode=batch'], { maxSlots: 1, capability });
    h.enqueue([{ issue: 2101, mode: 'slot', batch: 'b-unavail', anchor: 2100, tier: 'mid' }]);

    h.tick();
    const pid = batchSlotPid(h, 'b-unavail') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    h.tick();

    const batch = findBatch(h.state(), 'b-unavail');
    expect(batch?.evictions).toHaveLength(0);
    expect(batch?.status).not.toBe('blocked');
    expect(batch?.blocked_reason).toBeNull();

    // The skip is journalled per member: a gate that silently does not run is
    // its own trap (#594's shape), so silence must never read as a pass.
    const skipped = h.deps.journal
      .read()
      .filter((e) => e.event === 'gate-skipped' && e.issue === 2101);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toBe('gate-skipped:test.focused');
  }, 60_000);

  it('#625: a repo declaring NEITHER gate capability still runs the batch', async () => {
    const repo = scratchRepo();
    const capability: (worktree: string, id: string) => CapabilityGateResult = () => ({
      outcome: 'capability-unavailable',
    });
    const h = batchHarness(repo, ['--mode=batch'], { maxSlots: 1, capability });
    h.enqueue([{ issue: 2111, mode: 'slot', batch: 'b-none', anchor: 2110, tier: 'mid' }]);

    h.tick();
    const pid = batchSlotPid(h, 'b-none') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    h.tick();

    const batch = findBatch(h.state(), 'b-none');
    expect(batch?.status).not.toBe('blocked');
    expect(batch?.evictions).toHaveLength(0);
    // Both halves skipped, both journalled.
    const skipped = h.deps.journal
      .read()
      .filter((e) => e.event === 'gate-skipped' && e.issue === 2111);
    expect(skipped.map((e) => e.reason).sort()).toEqual([
      'gate-skipped:test.focused',
      'gate-skipped:typecheck.run',
    ]);
  }, 60_000);

  it('#625: a DECLARED capability reporting automation-broken still blocks (#583/#585 intact)', async () => {
    const repo = scratchRepo();
    const capability: (worktree: string, id: string) => CapabilityGateResult = (_worktree, id) =>
      id === 'test.focused'
        ? { outcome: 'automation-broken', reason: 'pnpm not found' }
        : { outcome: 'capability-unavailable' };
    const h = batchHarness(repo, ['--mode=batch'], { maxSlots: 1, capability });
    h.enqueue([{ issue: 2121, mode: 'slot', batch: 'b-broken', anchor: 2120, tier: 'mid' }]);

    h.tick();
    const pid = batchSlotPid(h, 'b-broken') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    h.tick();

    // The undeclared typecheck.run is skipped; the DECLARED-but-broken
    // test.focused still blocks. Mixed repos get per-capability treatment
    // rather than all-or-nothing.
    const batch = findBatch(h.state(), 'b-broken');
    expect(batch?.status).toBe('blocked');
    expect(batch?.blocked_reason).toBe('gate-inconclusive:test.focused');
    expect(batch?.evictions).toHaveLength(0);
  }, 60_000);

  it('#681: a timeout-shaped automation-broken SKIPS — recorded capability-unavailable, batch proceeds', async () => {
    // A member touching two workspace roots selects a dependents closure that
    // approaches the whole workspace; test.focused cannot finish inside its
    // deadline and is killed. That is a statement about DURATION, not about
    // the harness's reliability — the gate declines the member (skip; the
    // parent's expensive stage covers it) instead of blocking the batch on a
    // machinery-failure verdict the harness never earned.
    const repo = scratchRepo();
    const selection = 'pnpm --filter ...imboard_be --filter ...@imboard/docs run test';
    const capability: (worktree: string, id: string) => CapabilityGateResult = (_worktree, id) =>
      id === 'test.focused'
        ? {
            outcome: 'automation-broken',
            reason: 'command timed out after 900000ms',
            outputTail: selection,
            durationMs: 901102,
          }
        : { outcome: 'ok' };
    const h = batchHarness(repo, ['--mode=batch'], { maxSlots: 1, capability });
    h.enqueue([{ issue: 2131, mode: 'slot', batch: 'b-timeout', anchor: 2130, tier: 'mid' }]);

    h.tick();
    const pid = batchSlotPid(h, 'b-timeout') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    h.tick();

    const batch = findBatch(h.state(), 'b-timeout');
    expect(batch?.status).not.toBe('blocked');
    expect(batch?.blocked_reason).toBeNull();
    expect(batch?.evictions).toHaveLength(0);
    // AC1/AC2: the recorded outcome names the DECLINE, and the resolved
    // selection + duration ride beside it so breadth and cost are visible —
    // this record IS the unfavourable change-shape case, recorded.
    expect(batch?.member_gates?.['2131']).toMatchObject({
      capability: 'test.focused',
      outcome: 'capability-unavailable',
      output_tail: selection,
      duration_ms: 901102,
    });
    // The skip is journalled under a DISTINCT slug — "the gate declined, it
    // needed more time" must not read as #625's "never declared", and neither
    // may read as a pass (#594's shape).
    const skipped = h.deps.journal
      .read()
      .filter((e) => e.event === 'gate-skipped' && e.issue === 2131);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toBe('gate-skipped-timeout:test.focused');
    expect(skipped[0]?.detail).toContain('command timed out after 900000ms');
  }, 60_000);

  it('#681: a genuine automation-broken beside a timeout still blocks — on the genuine one', async () => {
    const repo = scratchRepo();
    const capability: (worktree: string, id: string) => CapabilityGateResult = (_worktree, id) =>
      id === 'typecheck.run'
        ? { outcome: 'automation-broken', reason: 'pnpm not found' }
        : {
            outcome: 'automation-broken',
            reason: 'command timed out after 900000ms',
            durationMs: 901102,
          };
    const h = batchHarness(repo, ['--mode=batch'], { maxSlots: 1, capability });
    h.enqueue([{ issue: 2141, mode: 'slot', batch: 'b-mixed', anchor: 2140, tier: 'mid' }]);

    h.tick();
    const pid = batchSlotPid(h, 'b-mixed') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    h.tick();

    // The timeout half skips; the genuine machinery failure still blocks —
    // and #594's invariant holds: member_gates names the gate the batch was
    // ROUTED on (typecheck.run), not the timed-out one beside it.
    const batch = findBatch(h.state(), 'b-mixed');
    expect(batch?.status).toBe('blocked');
    expect(batch?.blocked_reason).toBe('gate-inconclusive:typecheck.run');
    expect(batch?.member_gates?.['2141']).toMatchObject({
      capability: 'typecheck.run',
      outcome: 'automation-broken',
    });
  }, 60_000);

  it('#681: sched resume --batch dissolves the block when the recheck classifies a timeout', async () => {
    const repo = scratchRepo();
    // Blocked by the OLD verdict logic on an automation-broken whose shape a
    // newer build can classify as a timeout.
    let testFocusedOutcome: CapabilityGateResult = { outcome: 'automation-broken' };
    const capability: (worktree: string, id: string) => CapabilityGateResult = (_worktree, id) =>
      id === 'test.focused' ? testFocusedOutcome : { outcome: 'ok' };
    const h = batchHarness(repo, ['--mode=batch'], { maxSlots: 1, capability });
    h.enqueue([
      { issue: 2151, mode: 'slot', batch: 'b-resume-timeout', anchor: 2150, tier: 'mid' },
      { issue: 2152, mode: 'slot', batch: 'b-resume-timeout', tier: 'mid' },
    ]);

    h.tick();
    const pid = batchSlotPid(h, 'b-resume-timeout') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    h.tick();
    expect(findBatch(h.state(), 'b-resume-timeout')?.status).toBe('blocked');

    const batchDeps = batchDispatchDepsFrom(h, capability);
    const dispatch = resolveDispatch(h.config);

    testFocusedOutcome = {
      outcome: 'automation-broken',
      reason: 'command timed out after 900000ms',
      outputTail: 'pnpm --filter ...imboard_be run test',
      durationMs: 901102,
    };
    const resumed = resumeBlockedGate(
      batchDeps,
      h.config,
      dispatch,
      'b-resume-timeout',
      new Date()
    );
    expect(resumed).toMatchObject({ outcome: 'skipped', capability: 'test.focused' });
    const batch = findBatch(h.state(), 'b-resume-timeout');
    // The block dissolves: the gate declines, the member's own review stands,
    // and the batch advances exactly as an `ok` recheck would advance it.
    expect(batch?.blocked_reason).toBeNull();
    expect(batch?.status).toBe('executing');
    expect(batch?.executing_member).toBe(2);
    expect(batch?.member_gates?.['2151']).toMatchObject({
      capability: 'test.focused',
      outcome: 'capability-unavailable',
      duration_ms: 901102,
    });
    const skipped = h.deps.journal
      .read()
      .filter((e) => e.event === 'gate-skipped' && e.issue === 2151);
    expect(skipped.at(-1)?.reason).toBe('gate-skipped-timeout:test.focused');
  }, 60_000);

  it('#583 AC4: sched resume --batch re-runs the gate — still inconclusive stays blocked, then a passing recheck completes the member', async () => {
    const repo = scratchRepo();
    let testFocusedOutcome: CapabilityGateResult = { outcome: 'automation-broken' };
    const capability: (worktree: string, id: string) => CapabilityGateResult = (_worktree, id) =>
      id === 'test.focused' ? testFocusedOutcome : { outcome: 'ok' };
    const h = batchHarness(repo, ['--mode=batch'], { maxSlots: 1, capability });
    h.enqueue([
      { issue: 2201, mode: 'slot', batch: 'b-resume', anchor: 2200, tier: 'mid' },
      { issue: 2202, mode: 'slot', batch: 'b-resume', tier: 'mid' },
    ]);

    h.tick();
    const pid = batchSlotPid(h, 'b-resume') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    h.tick();
    expect(findBatch(h.state(), 'b-resume')?.status).toBe('blocked');

    const batchDeps = batchDispatchDepsFrom(h, capability);
    const dispatch = resolveDispatch(h.config);

    testFocusedOutcome = { outcome: 'automation-broken', outputTail: 'still cannot run the suite' };
    const stillBlocked = resumeBlockedGate(batchDeps, h.config, dispatch, 'b-resume', new Date());
    expect(stillBlocked).toMatchObject({
      outcome: 'still-blocked',
      capability: 'test.focused',
      // Which branch blocked it: the capability could not reach a verdict —
      // distinct from a task-failed it could not evidence (#594), which needs
      // a different fix from the operator.
      blockedBy: 'inconclusive',
    });
    expect(findBatch(h.state(), 'b-resume')?.status).toBe('blocked');
    // A still-blocked recheck is not silent (#583 review) — it leaves the
    // same audit trail (journal + member_gates) the live gate does.
    expect(findBatch(h.state(), 'b-resume')?.member_gates?.['2201']).toMatchObject({
      capability: 'test.focused',
      outcome: 'automation-broken',
      output_tail: 'still cannot run the suite',
    });
    const inconclusiveEvents = h.deps.journal
      .read()
      .filter((e) => e.event === 'gate-inconclusive' && e.unit === 'batch:b-resume');
    // The resume recheck's own event, not the original live-gate block.
    expect(inconclusiveEvents.at(-1)?.detail).toContain('still cannot run the suite');

    testFocusedOutcome = { outcome: 'ok' };
    const resumed = resumeBlockedGate(batchDeps, h.config, dispatch, 'b-resume', new Date());
    expect(resumed).toMatchObject({ outcome: 'completed', capability: 'test.focused' });
    const batch = findBatch(h.state(), 'b-resume');
    expect(batch?.blocked_reason).toBeNull();
    expect(batch?.status).toBe('executing');
    expect(batch?.executing_member).toBe(2);
    // member_gates reflects the resolution, not the stale pre-resume verdict.
    expect(batch?.member_gates?.['2201']).toMatchObject({
      capability: 'test.focused',
      outcome: 'ok',
    });
  }, 60_000);

  it('#583 AC4: sched resume --batch evicts the member when the recheck confirms a real task-failed', async () => {
    const repo = scratchRepo();
    let testFocusedOutcome: CapabilityGateResult = { outcome: 'automation-broken' };
    const capability: (worktree: string, id: string) => CapabilityGateResult = (_worktree, id) =>
      id === 'test.focused' ? testFocusedOutcome : { outcome: 'ok' };
    const h = batchHarness(repo, ['--mode=batch'], { maxSlots: 1, capability });
    h.enqueue([
      { issue: 2301, mode: 'slot', batch: 'b-resume-evict', anchor: 2300, tier: 'mid' },
      { issue: 2302, mode: 'slot', batch: 'b-resume-evict', tier: 'mid' },
    ]);

    h.tick();
    const pid = batchSlotPid(h, 'b-resume-evict') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    h.tick();
    expect(findBatch(h.state(), 'b-resume-evict')?.status).toBe('blocked');

    const batchDeps = batchDispatchDepsFrom(h, capability);
    const dispatch = resolveDispatch(h.config);

    testFocusedOutcome = { outcome: 'task-failed' };
    const resumed = resumeBlockedGate(batchDeps, h.config, dispatch, 'b-resume-evict', new Date());
    expect(resumed).toMatchObject({ outcome: 'evicted', capability: 'test.focused' });
    const batch = findBatch(h.state(), 'b-resume-evict');
    expect(batch?.blocked_reason).toBeNull();
    expect(batch?.evictions).toHaveLength(1);
    expect(batch?.evictions[0]).toMatchObject({
      issue: 2301,
      reason: 'incremental-gate-failed:test.focused',
    });
    expect(batch?.status).toBe('executing');
    // member_gates reflects the recheck's task-failed verdict, not the
    // stale automation-broken it was blocked on.
    expect(batch?.member_gates?.['2301']).toMatchObject({
      capability: 'test.focused',
      outcome: 'task-failed',
    });
  }, 60_000);

  it('#561 AC1/AC3: a cold batch worktree is warmed (node_modules present) before member 1 dispatches', async () => {
    const repo = scratchRepoWithPackageJson();
    // `--require-dep=dummy-dep`: member 1's FIRST action resolves
    // `node_modules/dummy-dep` under the worktree the prompt names — AC3's
    // "a member's first command depends on `node_modules` and passes",
    // literally, not just a precondition check from outside the member.
    const h = batchHarness(repo, ['--mode=batch', '--require-dep=dummy-dep'], { maxSlots: 1 });
    h.enqueue([{ issue: 1101, mode: 'slot', batch: 'b-warm', anchor: 1100, tier: 'mid' }]);
    // b-warm is already sealed forming → ready by enqueueEntries

    // Tick 1: batch-setup (no warm spares available — `poolClaimPath` defaults
    // to null — so this is the cold `git worktree add` path) runs a REAL `npm
    // install` against the worktree before member 1 is spawned in the SAME
    // synchronous call, then member 1 dispatches.
    const result = h.tick();
    expect(result.spawned).toEqual(['batch:b-warm']);
    const batch = findBatch(h.state(), 'b-warm');
    expect(batch?.pool_claimed).toBe(false);
    expect(fs.existsSync(path.join(batch?.worktree as string, 'node_modules', 'dummy-dep'))).toBe(
      true
    );
    // AC1: the warm step is journaled with the elapsed time appended to `detail`.
    const events = h.deps.journal.read();
    const warmupDone = events.find(
      (e) => e.event === 'batch-warmup-done' && e.unit === 'batch:b-warm'
    );
    expect(warmupDone?.detail).toMatch(/^pm:npm:1cmds \d+ms$/);

    const pid = batchSlotPid(h, 'b-warm') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    // The member's own first-command dependency check passed — it posted
    // `review done`, not a died-before-doing-anything env-cold exit (AC3/AC4).
    const milestone = JSON.parse(fs.readFileSync(path.join(h.truthDir, '1101.json'), 'utf8'));
    expect(milestone).toMatchObject({ phase: 'review', status: 'done' });
  }, 60_000);

  it('#561: a failed warm command blocks batch-setup (reason names the failing step) and cleans up the branch/worktree', async () => {
    const repo = scratchRepoWithPackageJson();
    const h = batchHarness(repo, ['--mode=batch'], { maxSlots: 1, failWarmupCommand: 'npm' });
    h.enqueue([{ issue: 1301, mode: 'slot', batch: 'b-warmfail', anchor: 1300, tier: 'mid' }]);
    // b-warmfail is already sealed forming → ready by enqueueEntries

    const result = h.tick(); // batch-setup: cold path, `npm install` forced to fail
    expect(result.failed).toContain('batch:b-warmfail');
    const batch = findBatch(h.state(), 'b-warmfail');
    expect(batch?.status).toBe('ready'); // never left `ready` — setup did not land
    expect(batch?.worktree).toBeNull();

    const events = h.deps.journal.read();
    const warmupFailed = events.find(
      (e) => e.event === 'batch-warmup-failed' && e.unit === 'batch:b-warmfail'
    );
    expect(warmupFailed?.detail).toMatch(/^pm:1\/1:npm \d+ms$/);
    const setupFailed = events.find(
      (e) => e.event === 'batch-setup-failed' && e.unit === 'batch:b-warmfail'
    );
    expect(setupFailed?.detail).toBe('warmup-failed:pm:1/1:npm');

    // Cleanup restores the "all-or-nothing" contract: the branch pushed and
    // worktree created before the warm step ran are both gone, so a retry
    // does not deterministically die at `branch-create-failed` forever.
    const branch = `batch/b-warmfail-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
    const remoteBranches = execFileSync('git', ['branch', '-r'], { cwd: repo, encoding: 'utf8' });
    expect(remoteBranches).not.toContain(branch);
    const worktreeList = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' });
    expect(worktreeList).not.toContain(`batch-b-warmfail`);
  }, 60_000);

  // --- #677: per-member worktrees off the integration branch (RFC-0001 §J.3) ---

  it('#677 AC5: each member is dispatched into its OWN worktree on its OWN branch off the integration branch, and lands there when verified', async () => {
    const repo = scratchRepo();
    const h = batchHarness(repo, ['--mode=batch', '--commit-file=member-work.txt'], {
      maxSlots: 1,
    });
    h.enqueue([
      { issue: 1501, mode: 'slot', batch: 'b-members', anchor: 1500, tier: 'mid' },
      { issue: 1502, mode: 'slot', batch: 'b-members', tier: 'mid' },
    ]);

    // Tick 1: batch-setup + member 1 dispatched into its OWN worktree.
    h.tick();
    let batch = findBatch(h.state(), 'b-members');
    expect(batch?.status).toBe('executing');
    const integrationBranch = batch?.branch as string;
    const m1Worktree = batch?.member_worktree as string;
    const m1Branch = batch?.member_branch as string;
    // The member branch is per-member and NOT the integration branch.
    expect(m1Branch).toBe(memberBranchFor('b-members', 1, 1501));
    expect(m1Branch).not.toBe(integrationBranch);
    // The worktree exists, is ON the member branch, and is clean — the three
    // git preconditions member-cycle's Step 0 asserts.
    expect(fs.existsSync(m1Worktree)).toBe(true);
    expect(gitAt(['branch', '--show-current'], m1Worktree).trim()).toBe(m1Branch);
    expect(gitAt(['status', '--porcelain'], m1Worktree).trim()).toBe('');
    // The member branch was cut OFF the integration branch (identical tip at
    // spawn time — the serial model's cut-from-tip invariant), and was pushed
    // so the member can commit to it.
    const integrationTip = gitAt(['rev-parse', integrationBranch], repo).trim();
    expect(gitAt(['rev-parse', m1Branch], repo).trim()).toBe(integrationTip);
    expect(gitAt(['ls-remote', 'origin', m1Branch], repo)).toContain(m1Branch);

    // The member agent commits INTO THE WORKTREE THE PROMPT NAMED (the fake
    // agent parses `worktree=` from its prompt, exactly like a real agent
    // cd-ing in) — on the member branch, never the integration branch.
    let pid = batchSlotPid(h, 'b-members') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    expect(fs.existsSync(path.join(m1Worktree, 'member-work.txt'))).toBe(true);
    expect(gitAt(['log', '--format=%s', '-1', m1Branch], m1Worktree)).toContain('(#1501)');

    // Member 1 completes → its work LANDS on the integration branch
    // (fast-forward) → member 2 dispatched into a DIFFERENT worktree.
    h.tick();
    batch = findBatch(h.state(), 'b-members');
    expect(batch?.executing_member).toBe(2);
    const integrationLog = gitAt(['log', '--format=%s', `origin/main..${integrationBranch}`], repo);
    expect(integrationLog).toContain('(#1501)');
    // Member 1's own tree is gone (landed → torn down, fields cleared).
    expect(fs.existsSync(m1Worktree)).toBe(false);
    // Member 2's context is already recorded by its spawn.
    const m2Worktree = batch?.member_worktree as string;
    const m2Branch = batch?.member_branch as string;
    expect(m2Worktree).not.toBe(m1Worktree);
    expect(fs.existsSync(m2Worktree)).toBe(true);
    expect(m2Branch).toBe(memberBranchFor('b-members', 2, 1502));
    // Member 2 branched off the INTEGRATION TIP THAT INCLUDES member 1 — the
    // serial model's "members see prior members' work" invariant.
    expect(gitAt(['rev-parse', m2Branch], repo).trim()).toBe(
      gitAt(['rev-parse', integrationBranch], repo).trim()
    );

    // Member 2 (the last) completes → lands → aggregate suite → tail.
    pid = batchSlotPid(h, 'b-members') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    h.tick();
    batch = findBatch(h.state(), 'b-members');
    expect(batch?.status).toBe('reviewing');
    const finalLog = gitAt(['log', '--format=%s', `origin/main..${integrationBranch}`], repo);
    expect(finalLog).toContain('(#1501)');
    expect(finalLog).toContain('(#1502)');
    expect(fs.existsSync(m2Worktree)).toBe(false);

    // The batch still ships end-to-end on the integration branch.
    pid = batchSlotPid(h, 'b-members') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    const parked = h.tick();
    expect(parked.parked).toEqual(['batch:b-members']);
  }, 60_000);

  it('#677: a gate-blocked member LANDS before the batch blocks (F.11: the commit stays on the branch)', async () => {
    const repo = scratchRepo();
    const h = batchHarness(repo, ['--mode=batch', '--commit-file=blocked-work.txt'], {
      maxSlots: 1,
      // #594's unevidenced-failure shape: the gate cannot reach a verdict.
      capability: UNEVIDENCED_GATE_FAILS,
    });
    h.enqueue([{ issue: 1511, mode: 'slot', batch: 'b-blocked', anchor: 1510, tier: 'mid' }]);

    h.tick(); // batch-setup + member 1 (into its own worktree)
    const pid = batchSlotPid(h, 'b-blocked') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    h.tick(); // gate blocks → member lands FIRST, then the batch blocks

    const batch = findBatch(h.state(), 'b-blocked');
    expect(batch?.status).toBe('blocked');
    expect(batch?.blocked_reason).toBe('gate-inconclusive:test.focused');
    // The member's verified-shape work is on the INTEGRATION branch — the
    // operator-facing surface — even though the gate never said ok.
    const log = gitAt(['log', '--format=%s', `origin/main..${batch?.branch as string}`], repo);
    expect(log).toContain('(#1511)');
    // The member worktree SURVIVES the block — `sched resume --batch`'s
    // recheck runs against the member's tree.
    expect(fs.existsSync(batch?.member_worktree as string)).toBe(true);
  }, 60_000);

  it("#677: an evicted member's commits NEVER land — its worktree is torn down and the batch continues", async () => {
    const repo = scratchRepo();
    const h = batchHarness(
      repo,
      ['--mode=batch', '--commit-file=doomed-work.txt', '--evict-members=1521'],
      { maxSlots: 1 }
    );
    h.enqueue([
      { issue: 1521, mode: 'slot', batch: 'b-evict', anchor: 1520, tier: 'mid' },
      { issue: 1522, mode: 'slot', batch: 'b-evict', tier: 'mid' },
    ]);

    h.tick(); // batch-setup + member 1 (1521 — will self-report blocked)
    let pid = batchSlotPid(h, 'b-evict') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    // The fake agent commits BEFORE posting blocked — the worktree holds a
    // real commit that must never reach the integration branch.
    const batch1 = findBatch(h.state(), 'b-evict');
    expect(fs.existsSync(path.join(batch1?.member_worktree as string, 'doomed-work.txt'))).toBe(
      true
    );

    h.tick(); // reconcile: self-blocked → evict directly → NO landing
    let batch = findBatch(h.state(), 'b-evict');
    expect(batch?.evictions.map((e) => e.issue)).toEqual([1521]);
    const log = gitAt(['log', '--format=%s', `origin/main..${batch?.branch as string}`], repo);
    expect(log).not.toContain('(#1521)');
    // The evicted member's tree is gone; the local branch (unmerged) is gone.
    expect(fs.existsSync(batch1?.member_worktree as string)).toBe(false);
    expect(gitAt(['branch', '--list', memberBranchFor('b-evict', 1, 1521)], repo).trim()).toBe('');

    // The batch continues: member 2 dispatches, completes, lands.
    pid = batchSlotPid(h, 'b-evict') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    h.tick();
    batch = findBatch(h.state(), 'b-evict');
    const log2 = gitAt(['log', '--format=%s', `origin/main..${batch?.branch as string}`], repo);
    expect(log2).toContain('(#1522)');
    expect(log2).not.toContain('(#1521)');
  }, 60_000);

  it('#677: a takeover redispatch resumes in the SAME member worktree (state, not re-derivation)', async () => {
    const repo = scratchRepo();
    // require-dep makes attempt 1 die with NO milestone (exit 1) — the
    // precondition for the #629 api-error classification and the in-place
    // retry this test exists to pin.
    const h = batchHarness(repo, ['--mode=batch', '--require-dep=dep-1531'], { maxSlots: 1 });
    h.enqueue([{ issue: 1531, mode: 'slot', batch: 'b-takeover', anchor: 1530, tier: 'mid' }]);

    h.tick(); // batch-setup + member 1
    const first = findBatch(h.state(), 'b-takeover');
    const worktree = first?.member_worktree as string;
    // The naming convention the whole recovery surface re-derives from.
    expect(first?.member_branch).toBe('batch/b-takeover-m1-1531');

    // Member 1 dies on a confirmed provider API error (the #629 shape) —
    // classified, NOT evicted; a later tick's "same wedge" retry
    // (spawnMemberContinuation) redispatches it in place.
    let pid = batchSlotPid(h, 'b-takeover') as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    writeApiErrorLog(batchMemberLogPath(h.deps.store.runsDir, 'b-takeover', 1, 1531));
    h.tick(); // classifies the 429 — no eviction
    expect(findBatch(h.state(), 'b-takeover')?.evictions).toHaveLength(0);

    // "Fix the env" so attempt 2 gets past the dep check: the marker goes
    // into the SAME member worktree the retry will reuse.
    fs.mkdirSync(path.join(worktree, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'node_modules', 'dep-1531'), 'fixed\n');

    // Drive until the member has been spawned a SECOND time (the in-place
    // retry — one tick classifies the 429, the next wedge-retries; the fake
    // agent may then complete within that same tick). Member dispatches only
    // (the tail agent's own `spawned` event has no issue and fires later).
    // The durable evidence of the in-place resume is the journal: BOTH
    // member attempts name the SAME worktree — the retry reused the tree
    // instead of re-branching.
    const memberSpawns = (): unknown[] =>
      h.deps.journal
        .read()
        .filter((e) => e.event === 'spawned' && e.unit === 'batch:b-takeover' && e.issue === 1531);
    let guard = 0;
    while (memberSpawns().length < 2 && guard < 4) {
      h.tick();
      guard++;
    }
    expect(findBatch(h.state(), 'b-takeover')?.evictions).toHaveLength(0);
    const spawnedEvents = memberSpawns();
    expect(spawnedEvents.length).toBe(2);
    for (const evt of spawnedEvents) {
      expect((evt as unknown as { worktree: string }).worktree).toBe(worktree);
    }

    // Drive to the tail: the retried member completed → landed → reviewing.
    guard = 0;
    while (findBatch(h.state(), 'b-takeover')?.status !== 'reviewing' && guard < 4) {
      pid = batchSlotPid(h, 'b-takeover') as number | undefined;
      if (pid !== undefined) await waitUntilDead(h.spawnDeps, pid);
      h.tick();
      guard++;
    }
    const done = findBatch(h.state(), 'b-takeover');
    expect(done?.status).toBe('reviewing');
    expect(fs.existsSync(worktree)).toBe(false);
  }, 60_000);

  it('#561 AC2: a pool-claimed batch worktree skips the warm step (already warm)', async () => {
    const repo = scratchRepoWithPackageJson();
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const batchId = 'b-pool';
    const branch = `batch/${batchId}-${date}`;
    // Simulate an already-warm pool worktree: a real second worktree of the
    // same repo, checked out on the branch batch-setup will ask the (faked)
    // pool CLI to claim.
    const poolWorktree = tmpDir('sched-batch-pool-');
    execFileSync('git', ['worktree', 'add', '-b', branch, poolWorktree, 'main'], {
      cwd: repo,
      stdio: 'ignore',
    });

    const h = batchHarness(repo, ['--mode=batch'], { maxSlots: 1, poolClaimPath: poolWorktree });
    h.enqueue([{ issue: 1201, mode: 'slot', batch: batchId, anchor: 1200, tier: 'mid' }]);
    // b-pool is already sealed forming → ready by enqueueEntries

    h.tick(); // batch-setup (claims poolWorktree, pushes the branch) + member 1
    const batch = findBatch(h.state(), batchId);
    expect(batch?.pool_claimed).toBe(true);
    expect(batch?.worktree).toBe(poolWorktree);
    // No warm step ran for the BATCH tree: `package.json`/`vendor/dummy-dep`
    // came from `main`'s history (same as the AC1/AC3 repo), so if the warm
    // step had run `node_modules` would exist — it does not, because a pool
    // claim skips it. (#677: the MEMBER worktree legitimately takes the cold
    // path — the stateful claim fake gives the batch the only warm spare —
    // so a `batch-warmup-done` event may exist; what must never happen is a
    // warm FAILURE.)
    expect(fs.existsSync(path.join(poolWorktree, 'node_modules'))).toBe(false);
    expect(h.deps.journal.read().some((e) => e.event === 'batch-warmup-failed')).toBe(false);

    let pid = batchSlotPid(h, batchId) as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);

    // Drive the single-member batch to `done` — this is the regression case
    // for `teardownBatch`'s containment check (#561): `poolWorktree` lives
    // under `os.tmpdir()`, outside BOTH roots `isSafeWorktree` accepts
    // (`<repo>/worktrees`, `<repo>/../worktrees`), exactly like a real pool
    // configured with a non-default `pool_dir` — teardown must skip that
    // check for a pool-claimed batch rather than reject the path and leak
    // the pool entry forever.
    h.tick(); // member 1 (last) green → aggregate suite → reviewing → tail spawned
    pid = batchSlotPid(h, batchId) as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    const parked = h.tick(); // tail posts batch-review done + batch-ship awaiting-merge
    expect(parked.parked).toEqual([`batch:${batchId}`]);

    fs.writeFileSync(
      path.join(h.truthDir, '9000.pr.json'),
      JSON.stringify({ state: 'MERGED', mergedAt: new Date().toISOString() })
    );
    h.tick(); // merge accepted → deployed
    expect(findBatch(h.state(), batchId)?.status).toBe('deployed');

    h.tick(); // report agent dispatched
    pid = batchSlotPid(h, batchId) as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);

    const result = h.tick(); // batch-report done → reported → done → teardown
    expect(result.completed).toEqual([`batch:${batchId}`]);
    const finalBatch = findBatch(h.state(), batchId);
    expect(finalBatch?.status).toBe('done');
    // The containment check did NOT reject the pool-claimed path (it would
    // have, pre-fix, since `poolWorktree` lives outside both roots
    // `isSafeWorktree` accepts) — teardown reached the pool `return` path and
    // the (mocked) pool self-check reported `warm`. A pool return recycles
    // the directory rather than deleting it, unlike the cold `git worktree
    // remove` path, so the worktree still existing on disk is expected here.
    expect(
      h.deps.journal
        .read()
        .some((e) => e.event === 'teardown-failed' && e.unit === `batch:${batchId}`)
    ).toBe(false);
    expect(
      h.deps.journal
        .read()
        .some((e) => e.event === 'teardown-done' && e.unit === `batch:${batchId}`)
    ).toBe(true);
  }, 60_000);
});

/**
 * #610: a lightweight harness for `reconcileMemberSlot`'s stale-milestone
 * dedup, deliberately WITHOUT `batchHarness`'s real git worktree / real
 * spawned fake-agent process. The scenario under test — a leftover terminal
 * milestone from a PREVIOUS batch run of this member reads as stale against
 * the CURRENT dispatch's `spawned_at` — starts mid-run (batch already
 * `executing`, slot already `running`), and the real fake-agent posts a
 * FRESH milestone the instant it is spawned, racing out any hand-written
 * stale one before a tick could ever observe it. Placing the batch/slot
 * directly with `assignToIdleSlot`/`transitionBatch` and driving
 * `runBatchTick` (not the full `tick()`) skips `claimAndSetup` entirely, so
 * no worktree, `exec`, or suite ever needs to be real.
 */
function staleMilestoneHarness(memberIssue: number, batchId: string, anchor: number) {
  const store = new SchedStore(tmpDir('sched-batch-stale-'));
  const journal = new Journal(store.dir);
  const setupAt = new Date('2026-09-06T12:00:00.000Z');
  let currentNow = setupAt;

  let state = enqueueEntries(
    store.load(),
    [{ issue: memberIssue, mode: 'slot', batch: batchId, anchor, tier: 'mid' }],
    setupAt
  );
  // enqueueEntries already seals a fresh batch forming → ready.
  state = transitionBatch(state, batchId, 'executing', { executing_member: 1 }, setupAt);
  const assigned = assignToIdleSlot(state, `batch:${batchId}`, 'member', setupAt);
  state = assigned.state;
  const slotId = assigned.slotId;
  state = transitionSlot(state, slotId, 'running', { pid: 4242, pid_start: null }, setupAt);
  store.withLock(() => ({ state, result: undefined }));

  let milestone: GroundTruthMilestone | null = null;
  const groundTruth = stubGroundTruth({ latestMilestone: () => milestone });
  const spawnDeps: SpawnDeps = {
    spawn: () => {
      throw new Error('must not spawn in this test');
    },
    kill: () => true,
    isAlive: () => true, // the member's agent is genuinely still running
    processStart: () => null,
  };
  const config: SchedConfig = { max_slots: 1 };
  const dispatch = resolveDispatch(config);
  const deps: BatchDispatchDeps = {
    store,
    journal,
    groundTruth,
    spawnDeps,
    now: () => currentNow,
    repoDir: store.dir,
    exec: () => {
      throw new Error('must not exec in this test');
    },
    runSuite: () => {
      throw new Error('must not run the aggregate suite in this test');
    },
  };

  return {
    journal,
    slotId,
    setMilestone: (m: GroundTruthMilestone | null) => {
      milestone = m;
    },
    /** Advances the tick clock (`deps.now()`), independent of `spawned_at`. */
    advanceNow: (at: string) => {
      currentNow = new Date(at);
    },
    /** Simulates a fresh dispatch of the SAME member (new spawn, same slot). */
    setSpawnedAt: (at: string) => {
      store.withLock((s) => ({
        state: patchSlot(s, slotId, { spawned_at: at }, currentNow),
        result: undefined,
      }));
    },
    tick: () => runBatchTick(deps, config, dispatch),
  };
}

describe('#610: stale-milestone-ignored journals once per dispatch, not once per tick', () => {
  it('AC4: three consecutive ticks against one stale milestone produce exactly one journal entry', () => {
    const h = staleMilestoneHarness(610, 'b-stale', 609);
    h.advanceNow('2026-09-06T12:10:00.000Z');
    h.setSpawnedAt('2026-09-06T12:05:00.000Z');
    // A `review done mode=slot` milestone from a PREVIOUS batch run — well
    // before this dispatch's spawned_at, and well past the 60s dispatch-fence
    // tolerance (`postdatesDispatch`).
    const staleMilestone: GroundTruthMilestone = {
      phase: 'review',
      status: 'done',
      run: 'r-610-old',
      at: '2026-09-06T11:00:00.000Z',
      keys: { mode: 'slot', batch: 'b-stale' },
    };
    h.setMilestone(staleMilestone);

    h.tick();
    h.tick();
    h.tick();

    const events = h.journal.read().filter((e) => e.event === 'stale-milestone-ignored');
    expect(events).toHaveLength(1);
    expect(events[0]?.issue).toBe(610);
    // AC2: the event's own `at` is the engine's decision time — NOT the
    // milestone's — with the milestone's own timestamp kept as a separate field.
    // Neither key is declared on `JournalEvent` (a loosely-typed `extra` bag,
    // same as `run`/`detail` on this event historically), hence the cast.
    const [entry] = events as unknown as { at: string; milestone_at: string }[];
    expect(entry?.at).not.toBe(staleMilestone.at);
    expect(entry?.milestone_at).toBe(staleMilestone.at);
  });

  it('AC5: a second, later dispatch that also sees a stale milestone produces its own entry — dedup is per dispatch, not per member', () => {
    const h = staleMilestoneHarness(610, 'b-stale2', 609);
    h.advanceNow('2026-09-06T12:10:00.000Z');
    h.setSpawnedAt('2026-09-06T12:05:00.000Z');
    const staleMilestone: GroundTruthMilestone = {
      phase: 'review',
      status: 'done',
      run: 'r-610-old',
      at: '2026-09-06T11:00:00.000Z',
      keys: { mode: 'slot', batch: 'b-stale2' },
    };
    h.setMilestone(staleMilestone);

    h.tick();
    h.tick();
    expect(h.journal.read().filter((e) => e.event === 'stale-milestone-ignored')).toHaveLength(1);

    // A fresh dispatch of the SAME member (e.g. a requeue-with-context
    // re-batch) — the milestone is unchanged and still stale relative to the
    // NEW spawned_at, so the dedup marker (keyed on the OLD spawned_at) must
    // not suppress this dispatch's own entry.
    h.advanceNow('2026-09-06T13:10:00.000Z');
    h.setSpawnedAt('2026-09-06T13:05:00.000Z');
    h.tick();
    h.tick();

    const events = h.journal.read().filter((e) => e.event === 'stale-milestone-ignored');
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.issue === 610)).toBe(true);
  });
});

/**
 * #630: a lightweight harness for `reconcilePrWatch`'s per-batch dedup —
 * deliberately WITHOUT `batchHarness`'s real git worktree / spawned
 * fake-agent process, same rationale as `staleMilestoneHarness` above. An
 * `awaiting-merge` batch holds no live slot (`BatchEntry.pr`'s own doc
 * comment), so `runBatchTick`'s PR-watch pass is reachable with no slot at
 * all — placing the batch directly at `awaiting-merge` via the real
 * transition rail and stubbing `groundTruth.prState` is enough.
 */
function prWatchHarness(memberIssue: number, batchId: string, anchor: number, pr: number) {
  const store = new SchedStore(tmpDir('sched-batch-prwatch-'));
  const journal = new Journal(store.dir);
  const setupAt = new Date('2026-09-06T12:00:00.000Z');
  let currentNow = setupAt;

  let state = enqueueEntries(
    store.load(),
    [{ issue: memberIssue, mode: 'slot', batch: batchId, anchor }],
    setupAt
  );
  for (const to of ['classified', 'batched', 'waiting', 'in-work', 'committed'] as const) {
    state = transitionIssue(state, memberIssue, to, {}, setupAt);
  }
  state = transitionBatch(state, batchId, 'executing', {}, setupAt);
  state = transitionBatch(state, batchId, 'validating', {}, setupAt);
  state = transitionBatch(state, batchId, 'reviewing', {}, setupAt);
  state = transitionBatch(state, batchId, 'shipping', {}, setupAt);
  state = transitionBatch(state, batchId, 'awaiting-merge', { pr }, setupAt);
  store.withLock(() => ({ state, result: undefined }));

  let truth: PrTruth | undefined;
  const groundTruth = stubGroundTruth({ prState: () => truth });
  const spawnDeps: SpawnDeps = {
    spawn: () => {
      throw new Error('must not spawn in this test');
    },
    kill: () => true,
    isAlive: () => true,
    processStart: () => null,
  };
  const config: SchedConfig = { max_slots: 1 };
  const dispatch = resolveDispatch(config);
  const deps: BatchDispatchDeps = {
    store,
    journal,
    groundTruth,
    spawnDeps,
    now: () => currentNow,
    repoDir: store.dir,
    exec: () => {
      throw new Error('must not exec in this test');
    },
    runSuite: () => {
      throw new Error('must not run the aggregate suite in this test');
    },
  };

  return {
    journal,
    store,
    setTruth: (t: PrTruth | undefined) => {
      truth = t;
    },
    advanceNow: (at: string) => {
      currentNow = new Date(at);
    },
    batch: () => findBatch(store.load(), batchId),
    tick: () => runBatchTick(deps, config, dispatch),
  };
}

const BLOCKED_TRUTH: PrTruth = {
  state: 'OPEN',
  mergedAt: null,
  mergeable: 'MERGEABLE',
  blocked: true,
};

const CONFLICTING_TRUTH: PrTruth = {
  state: 'OPEN',
  mergedAt: null,
  mergeable: 'CONFLICTING',
  blocked: false,
};

const HEALTHY_TRUTH: PrTruth = {
  state: 'OPEN',
  mergedAt: null,
  mergeable: 'MERGEABLE',
  blocked: false,
};

describe('#630: pr-watch-failed journals once per distinct condition, not once per tick', () => {
  it('AC1/AC5: three consecutive ticks against one unchanged watch failure produce exactly one entry; changing the reason produces a second', () => {
    const h = prWatchHarness(630, 'b-prwatch', 629, 4069);
    h.setTruth(BLOCKED_TRUTH);

    h.tick();
    h.tick();
    h.tick();

    let events = h.journal.read().filter((e) => e.event === 'pr-watch-failed');
    expect(events).toHaveLength(1);
    expect(events[0]?.issue).toBeUndefined(); // batch-scoped, not issue-scoped
    expect((events[0] as unknown as { reason: string }).reason).toBe('auto-merge-blocked');

    // A genuine first occurrence is still reported immediately (Test Scope) —
    // and a DIFFERENT reason is a distinct condition (AC1), so it reports too.
    h.setTruth(CONFLICTING_TRUTH);
    h.tick();

    events = h.journal.read().filter((e) => e.event === 'pr-watch-failed');
    expect(events).toHaveLength(2);
    expect((events[1] as unknown as { reason: string }).reason).toBe('pr-conflicting');
  });

  it('AC2: the condition clearing and re-occurring produces a new entry — dedup, not suppression', () => {
    const h = prWatchHarness(630, 'b-prwatch2', 629, 4070);
    h.setTruth(BLOCKED_TRUTH);
    h.tick();
    h.tick();
    expect(h.journal.read().filter((e) => e.event === 'pr-watch-failed')).toHaveLength(1);

    h.setTruth(HEALTHY_TRUTH);
    h.tick(); // clears — no merge, PR just healthy again
    expect(h.batch()?.pr_watch_failed_reason).toBeNull();

    h.setTruth(BLOCKED_TRUTH);
    h.tick();
    h.tick();

    const events = h.journal.read().filter((e) => e.event === 'pr-watch-failed');
    expect(events).toHaveLength(2);
  });

  it('AC3: the entry’s `at` is the engine’s clock, not a value copied from the observed condition, and carries `ticks_persisted`', () => {
    const h = prWatchHarness(630, 'b-prwatch3', 629, 4071);
    h.advanceNow('2026-09-06T21:15:08.000Z');
    h.setTruth(BLOCKED_TRUTH);
    h.tick();

    const [entry] = h.journal.read().filter((e) => e.event === 'pr-watch-failed');
    expect(entry?.at).toBe('2026-09-06T21:15:08.000Z');
    expect(entry?.ticks_persisted).toBe(1);
    // #633: `ticks_persisted` is a tick count against an operator-tunable
    // interval, so `since` is what actually makes the duration legible.
    expect(entry?.since).toBe('2026-09-06T21:15:08.000Z');
    expect(h.batch()?.pr_watch_failed_since).toBe('2026-09-06T21:15:08.000Z');
  });

  it('AC3: a still-blocked streak re-announces every JOURNAL_DEDUP_REANNOUNCE_TICKS ticks, so "still blocked after N checks" is legible from the journal — without breaking AC5’s 3-tick dedup', () => {
    const h = prWatchHarness(630, 'b-prwatch4', 629, 4072);
    h.setTruth(BLOCKED_TRUTH);

    // Driven off the constant, not a literal: a retune must fail on the
    // assertion it invalidates, not on an opaque `expected 1 to be 2`.
    for (let i = 0; i < JOURNAL_DEDUP_REANNOUNCE_TICKS - 1; i++) h.tick();
    let events = h.journal.read().filter((e) => e.event === 'pr-watch-failed');
    expect(events).toHaveLength(1);

    h.tick(); // re-announcement threshold
    events = h.journal.read().filter((e) => e.event === 'pr-watch-failed');
    expect(events).toHaveLength(2);
    expect(events[1]?.ticks_persisted).toBe(JOURNAL_DEDUP_REANNOUNCE_TICKS);
    // The re-announcement still points at the streak's ORIGINAL onset.
    expect(events[1]?.since).toBe(events[0]?.since);
    expect(h.batch()?.pr_watch_failed_ticks).toBe(JOURNAL_DEDUP_REANNOUNCE_TICKS);
  });

  it('#633: a silent dedup tick does not bump the batch’s `updated_at`', () => {
    const h = prWatchHarness(630, 'b-prwatch5', 629, 4073);
    h.setTruth(BLOCKED_TRUTH);
    h.advanceNow('2026-09-06T21:15:00.000Z');
    h.tick(); // onset — journals
    const afterOnset = h.batch()?.updated_at;

    h.advanceNow('2026-09-06T21:16:00.000Z');
    h.tick(); // silent: counter only
    expect(h.batch()?.pr_watch_failed_ticks).toBe(2);
    expect(h.journal.read().filter((e) => e.event === 'pr-watch-failed')).toHaveLength(1);
    // A batch blocked for hours must not read as freshly-touched in
    // `sched status --json` or in `readiness.ts`'s age tiebreak.
    expect(h.batch()?.updated_at).toBe(afterOnset);
  });

  it('#633: the marker is cleared when the batch leaves `awaiting-merge`, so the same reason after a re-ship journals afresh', () => {
    const h = prWatchHarness(630, 'b-prwatch6', 629, 4074);
    h.setTruth(BLOCKED_TRUTH);
    h.tick();
    expect(h.batch()?.pr_watch_failed_reason).toBe('auto-merge-blocked');

    // `BATCH_TRANSITIONS` permits awaiting-merge → rebasing on the same id
    // (`recovery.ts`'s `handlePrConflict`); the streak belongs to the stretch
    // that just ended, not to the next one.
    h.store.withLock((s) => ({
      state: transitionBatch(s, 'b-prwatch6', 'rebasing', {}, new Date()),
      result: undefined,
    }));
    h.tick();
    expect(h.batch()?.pr_watch_failed_reason).toBeNull();
    expect(h.batch()?.pr_watch_failed_since).toBeNull();
    expect(h.batch()?.pr_watch_failed_ticks).toBe(0);
  });
});

// --- #686: stale-BLOCKED batch reconciliation (ground truth beats the ledger) ---

/**
 * The #594 block shape: `test.focused` reports `task-failed` whose captured
 * output is only framing (no failing-test evidence) — the gate blocks the
 * batch (`gate-inconclusive:test.focused`) instead of evicting the member.
 */
const UNEVIDENCED_GATE_FAILS: (worktree: string, id: string) => CapabilityGateResult = (
  _worktree,
  id
) =>
  id === 'test.focused'
    ? { outcome: 'task-failed', outputTail: 'tee: /dev/stderr: No such device or address\n' }
    : { outcome: 'ok' };

/**
 * Drive a 1-member batch to the exact state the #686 issue found in
 * production (b-20260909-01): the member's work is ON THE BATCH BRANCH (the
 * fake agent makes a real `(#<issue>)`-trailer commit, so `batch.ranges`
 * records it), the gate blocked the batch on `gate-inconclusive:test.focused`,
 * and the member sits at `validated` with the batch `blocked` — while the
 * work has demonstrably shipped.
 */
async function blockedBatchHarness(
  batchId: string,
  anchor: number,
  member: number,
  extraMembers: number[] = []
) {
  const repo = scratchRepo();
  const h = batchHarness(repo, ['--mode=batch', `--commit-file=member-${member}.txt`], {
    maxSlots: 1,
    capability: UNEVIDENCED_GATE_FAILS,
  });
  h.enqueue([
    { issue: member, mode: 'slot', batch: batchId, anchor, tier: 'mid' },
    ...extraMembers.map((issue) => ({
      issue,
      mode: 'slot' as const,
      batch: batchId,
      tier: 'mid' as const,
    })),
  ]);

  h.tick(); // batch-setup + member 1
  const pid = batchSlotPid(h, batchId) as number;
  expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
  h.tick(); // member advance (ranges recorded) → gate blocks the batch

  const batch = findBatch(h.state(), batchId);
  expect(batch?.status).toBe('blocked');
  expect(batch?.blocked_reason).toBe('gate-inconclusive:test.focused');
  // The member's commit is real and ON THE BATCH BRANCH — the branch is what
  // the reconcile's merge evidence reads (a gate-blocked member's range is
  // never recorded, which is exactly why the evidence is branch-based).
  const branch = batch?.branch as string;
  const branchLog = execFileSync('git', ['log', '--format=%s', `origin/main..${branch}`], {
    cwd: batch?.worktree as string,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  expect(branchLog).toContain(`(#${member})`);
  return { h, repo, batchId };
}

/** Out-of-band merge: fold the batch branch into origin main for real (the b-20260909-01 shape). */
function mergeBatchBranchIntoMain(repo: string, branch: string, worktree: string): void {
  const git = (args: string[], cwd: string = repo) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  // The member's commits live in the batch WORKTREE — batch-setup pushed the
  // branch before any member committed, so origin's copy is stale. An
  // operator merging out of band publishes the branch first.
  git(['push', 'origin', branch], worktree);
  git(['fetch', 'origin', branch]);
  git(['merge', '--no-ff', '--no-edit', `origin/${branch}`]);
  git(['push', 'origin', 'main']);
}

describe('#686: a blocked batch whose work merged out of band reconciles (ground truth beats the ledger)', () => {
  it('AC4: blocked on gate-inconclusive, its PR merges out of band → next tick reconciles it; report dispatches and teardown runs', async () => {
    const { h, batchId } = await blockedBatchHarness('b-stale-pr', 6800, 6801);
    const batchBefore = findBatch(h.state(), batchId);
    expect(batchBefore?.pr).toBeNull();

    // Out of band: an operator opens a PR for the batch branch and merges it.
    h.store.withLock((s) => ({
      state: patchBatch(s, batchId, { pr: 9600 }),
      result: null,
    }));
    fs.writeFileSync(
      path.join(h.truthDir, '9600.pr.json'),
      JSON.stringify({ state: 'MERGED', mergedAt: '2026-09-10T09:00:00.000Z' })
    );

    const result = h.tick(); // the stale-blocked reconcile fires
    expect(result.mergeAccepted).toContain(`batch:${batchId}`);
    const batch = findBatch(h.state(), batchId);
    // On the same rail a normally-watched merge takes: report dispatches next.
    expect(batch?.status).toBe('deployed');
    // AC3: the member did NOT stay mid-rail — it is done, like its batch.
    expect(h.state().entries.find((e) => e.issue === 6801)?.status).toBe('done');
    const ev = h.deps.journal
      .read()
      .find((e) => e.event === 'stale-failure-reconciled' && e.unit === `batch:${batchId}`);
    expect(String(ev?.detail)).toContain('MERGED');
    expect(String(ev?.detail)).toContain('gate-inconclusive:test.focused');

    // deployed, no live slot → the report agent claims one next tick, and
    // batch-report done walks the batch to `done` with a REAL worktree teardown.
    const r2 = h.tick();
    expect(r2.spawned).toEqual([`batch:${batchId}`]);
    const rpid = batchSlotPid(h, batchId) as number;
    expect(await waitUntilDead(h.spawnDeps, rpid)).toBe(true);
    const r3 = h.tick();
    expect(r3.completed).toEqual([`batch:${batchId}`]);
    const done = findBatch(h.state(), batchId);
    expect(done?.status).toBe('done');
    expect(fs.existsSync(done?.worktree as string)).toBe(false);
  }, 60_000);

  it('AC1 (pr=None, the b-20260909-01 shape): every member commit an ancestor of the base → reconciles to done and tears the worktree down inline', async () => {
    const { h, repo, batchId } = await blockedBatchHarness('b-stale-anc', 6810, 6811);
    const batchBefore = findBatch(h.state(), batchId);
    const branch = batchBefore?.branch as string;
    const worktree = batchBefore?.worktree as string;

    // Ground truth arrives without any PR: the batch branch lands in main.
    mergeBatchBranchIntoMain(repo, branch, worktree);

    const result = h.tick();
    expect(result.mergeAccepted).toContain(`batch:${batchId}`);
    const batch = findBatch(h.state(), batchId);
    // No PR → no report agent can be prompted; the batch walks the terminal
    // rail in the same tick and its worktree is torn down HERE (AC1's
    // "dispatches teardown", with the skipped report stated in the journal).
    expect(batch?.status).toBe('done');
    expect(h.state().entries.find((e) => e.issue === 6811)?.status).toBe('done');
    expect(fs.existsSync(batch?.worktree as string)).toBe(false);
    expect(
      h.deps.journal
        .read()
        .some((e) => e.event === 'teardown-done' && e.unit === `batch:${batchId}`)
    ).toBe(true);
    const ev = h.deps.journal
      .read()
      .find((e) => e.event === 'stale-failure-reconciled' && e.unit === `batch:${batchId}`);
    expect(String(ev?.detail)).toContain('ancestor');
    // The merge really is why it reconciled: a second tick changes nothing.
    expect(h.tick().mergeAccepted).toEqual([]);
  }, 60_000);

  it('AC1 guard: a batch with a surviving member that never ran does NOT reconcile — its work never shipped', async () => {
    // Member 6821 never dispatched (the gate blocked after member 6820): no
    // commits, no shipped work — reconciling it to `done` would mint the
    // exact ledger/ground-truth drift #686 exists to cure.
    const { h } = await blockedBatchHarness('b-stale-guard', 6819, 6820, [6821]);

    h.store.withLock((s) => ({
      state: patchBatch(s, 'b-stale-guard', { pr: 9601 }),
      result: null,
    }));
    fs.writeFileSync(
      path.join(h.truthDir, '9601.pr.json'),
      JSON.stringify({ state: 'MERGED', mergedAt: '2026-09-10T09:00:00.000Z' })
    );

    const result = h.tick();
    expect(result.mergeAccepted).not.toContain('batch:b-stale-guard');
    const batch = findBatch(h.state(), 'b-stale-guard');
    expect(batch?.status).toBe('blocked');
    expect(batch?.blocked_reason).toBe('gate-inconclusive:test.focused');
    // The gate-blocked member sits `in-work` (its gate never advanced it);
    // the never-dispatched one stays `queued`. NEITHER may be declared done.
    expect(h.state().entries.find((e) => e.issue === 6820)?.status).toBe('in-work');
    expect(h.state().entries.find((e) => e.issue === 6821)?.status).toBe('queued');
  }, 60_000);
});
