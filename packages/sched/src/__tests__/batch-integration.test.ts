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
import {
  type CapOutcome,
  createSpawnDeps,
  type EngineDeps,
  type EnqueueInput,
  type ExecFn,
  enqueueEntries,
  findBatch,
  type GroundTruth,
  Journal,
  type PrTruth,
  type SchedConfig,
  SchedStore,
  type SuiteResult,
  tick,
} from '../index';
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
  return (file, args, cwd) => {
    if (failCommand && file === failCommand) return null;
    // Argv position, not `includes` — a branch/path argument could otherwise
    // coincidentally equal 'claim'/'status'/'return' and misroute.
    if (file === 'npx' && args[2] === 'claim') {
      return poolClaimPath;
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
    capability?: (worktree: string, capabilityId: string) => CapOutcome;
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
    const capability: (worktree: string, id: string) => CapOutcome = (_worktree, id) =>
      id === 'test.focused' ? 'task-failed' : 'ok';
    const h = batchHarness(repo, ['--mode=batch'], { maxSlots: 1, capability });
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
    // No warm step ran: `package.json`/`vendor/dummy-dep` came from `main`'s
    // history (same as the AC1/AC3 repo), so if the warm step had run
    // `node_modules` would exist — it does not, because a pool claim skips it.
    expect(fs.existsSync(path.join(poolWorktree, 'node_modules'))).toBe(false);
    // No warmup event at all — the claim path never calls `warmColdBatchWorktree`.
    expect(
      h.deps.journal
        .read()
        .some((e) => e.event === 'batch-warmup-done' || e.event === 'batch-warmup-failed')
    ).toBe(false);

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
