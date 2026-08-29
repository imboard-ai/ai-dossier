/**
 * Integration tests for the #464 engine: REAL spawned fake-agent processes
 * (detached, like production agents), REAL pid liveness, and real state files
 * — with file-backed ground truth standing in for `ai-dossier runstate` /
 * `gh` (the issue's "stubbed gh"), and a scratch git repo exercising the real
 * `git ls-remote` path. No LLM calls anywhere.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createExecGroundTruth,
  createSpawnDeps,
  type EngineDeps,
  type EnqueueInput,
  enqueueEntries,
  type GroundTruth,
  groundTruthExec,
  Journal,
  type SchedConfig,
  SchedStore,
  tick,
} from '../index';

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

/** File-backed ground truth: the fake agents "post milestones" by writing files. */
function fileGroundTruth(milestonesDir: string): GroundTruth {
  return {
    latestMilestone: (issue) => {
      const file = path.join(milestonesDir, `${issue}.json`);
      if (!fs.existsSync(file)) return null;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        phase: string;
        status: string;
        run: string;
        at: string;
      };
      return { phase: raw.phase, status: raw.status, run: raw.run, at: raw.at, keys: {} };
    },
    issueClosed: () => false,
    branchHead: () => null,
  };
}

interface IntegrationHarness {
  deps: EngineDeps;
  config: SchedConfig;
  store: SchedStore;
  spawnDeps: EngineDeps['spawnDeps'];
  tick: () => ReturnType<typeof tick>;
  enqueue: (inputs: EnqueueInput[]) => void;
  state: () => ReturnType<SchedStore['load']>;
}

function harness(
  agentArgs: string[],
  opts?: { maxSlots?: number; stallTimeoutMs?: number }
): IntegrationHarness {
  const dir = tmpDir('sched-int-');
  const store = new SchedStore(dir);
  const milestonesDir = tmpDir('sched-int-milestones-');
  const deps: EngineDeps = {
    store,
    journal: new Journal(dir),
    groundTruth: fileGroundTruth(milestonesDir),
    spawnDeps: createSpawnDeps(),
    now: () => new Date(),
  };
  const config: SchedConfig = {
    max_slots: opts?.maxSlots ?? 2,
    ...(opts?.stallTimeoutMs !== undefined ? { stall_timeout_ms: opts.stallTimeoutMs } : {}),
    dispatch: {
      command: ['node', FAKE_AGENT, ...agentArgs, `--milestones-dir=${milestonesDir}`],
      prompt: 'Run the full-cycle workflow for issue #{issue} now.',
    },
  };
  return {
    deps,
    config,
    store,
    spawnDeps: deps.spawnDeps,
    tick: () => tick(deps, config),
    enqueue: (inputs) =>
      store.withLock((state) => ({
        state: enqueueEntries(state, inputs, new Date()),
        result: null,
      })),
    state: () => store.load(),
  };
}

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

describe('integration: dispatch → exit → verify against fake milestones', () => {
  it('a fake agent that posts report-done and exits → unit verified complete', async () => {
    const h = harness(['--mode=complete']);
    h.enqueue([{ issue: 301, mode: 'full', tier: 'mid' }]);

    const spawned = h.tick();
    expect(spawned.spawned).toEqual(['issue:301']);
    const pid = h.state().slots[0].pid as number;
    expect(h.spawnDeps.isAlive(pid)).toBe(true);

    // The agent exits on its own after posting the milestone file.
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);

    // Exit detected → verified against ground truth → complete, slot freed.
    const result = h.tick();
    expect(result.completed).toEqual(['issue:301']);
    const state = h.state();
    expect(state.entries[0].status).toBe('done');
    expect(state.slots[0].status).toBe('idle');
    // the agent's output was journaled to the per-unit log file
    const log = fs.readFileSync(path.join(h.store.runsDir, 'issue-301.log'), 'utf8');
    expect(log).toContain('fake agent');
    expect(log).toContain('#301');
  }, 20_000);

  it('a fake agent that dies without doing anything → NOT complete → redispatched stronger', async () => {
    const h = harness(['--mode=die']);
    h.enqueue([{ issue: 302, mode: 'full', tier: 'mechanical' }]);

    h.tick();
    const firstPid = h.state().slots[0].pid as number;
    expect(await waitUntilDead(h.spawnDeps, firstPid)).toBe(true);

    const result = h.tick();
    expect(result.completed).toHaveLength(0); // exit alone proved nothing (AC2)
    expect(result.redispatched).toEqual(['issue:302']);
    const state = h.state();
    expect(state.entries[0].tier).toBe('mid'); // escalated
    expect(state.entries[0].status).toBe('dispatched');
    const secondPid = state.slots[0].pid as number;
    expect(secondPid).not.toBe(firstPid);
    procsToKill.push(secondPid);
  }, 20_000);

  it('a sleeping fake agent stalls → killed and redispatched (real processes, real SIGTERM)', async () => {
    const h = harness(['--mode=sleep', '--sleep-ms=60000'], {
      maxSlots: 1,
      stallTimeoutMs: 1500,
    });
    h.enqueue([{ issue: 303, mode: 'full', tier: 'mid' }]);

    h.tick();
    const firstPid = h.state().slots[0].pid as number;
    expect(h.spawnDeps.isAlive(firstPid)).toBe(true);

    // Real wall-clock wait past the stall timeout.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const result = h.tick();

    expect(result.redispatched).toEqual(['issue:303']);
    // the stalled agent really died from the engine's SIGTERM
    expect(await waitUntilDead(h.spawnDeps, firstPid, 5000)).toBe(true);
    const state = h.state();
    expect(state.entries[0].tier).toBe('strong');
    const secondPid = state.slots[0].pid as number;
    expect(h.spawnDeps.isAlive(secondPid)).toBe(true);
    procsToKill.push(secondPid);
  }, 30_000);
});

describe('integration: real-subprocess ground truth', () => {
  it('reads milestones through a real executable and branch heads through a real scratch git repo', async () => {
    // A "stubbed ai-dossier runstate" as an executable script.
    const binDir = tmpDir('sched-int-bin-');
    const fakeRunstate = path.join(binDir, 'fake-runstate');
    fs.writeFileSync(
      fakeRunstate,
      '#!/bin/sh\necho \'{"phase":"report","status":"done","run":"r-1-fake","at":"2026-08-29T12:00:00Z"}\'\n',
      { mode: 0o755 }
    );

    // A stubbed gh: issue 1 CLOSED, everything else OPEN.
    const fakeGh = path.join(binDir, 'gh');
    fs.writeFileSync(
      fakeGh,
      '#!/bin/sh\ncase "$*" in "issue view 1 "*) echo CLOSED;; *) echo OPEN;; esac\n',
      { mode: 0o755 }
    );

    // A scratch git repo with a pushed branch (the real ls-remote path).
    const gitRoot = tmpDir('sched-int-git-');
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
    git(['checkout', '-b', 'feature/464-x'], work);
    git(['push', '-u', 'origin', 'feature/464-x'], work);

    // gh is resolved by name — prepend the stub dir to PATH through a wrapper
    // exec that re-execs with the extended environment.
    const stubbedExec = ((file: string, args: string[], cwd?: string) => {
      if (file === 'gh') {
        return groundTruthExec(fakeGh, args, cwd);
      }
      return groundTruthExec(file, args, cwd);
    }) as typeof groundTruthExec;

    const gt = createExecGroundTruth(stubbedExec, {
      repoDir: work,
      runstateBin: fakeRunstate,
    });

    expect(gt.latestMilestone(1)?.phase).toBe('report');
    expect(gt.issueClosed(1)).toBe(true);
    expect(gt.issueClosed(2)).toBe(false);
    const head = gt.branchHead('feature/464-x');
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(gt.branchHead('missing-branch')).toBeNull();
  }, 20_000);
});

// --- #468: PR watching, teardown, report dispatch (AC6) ---
//
// Real spawned agents (park + report), a REAL scratch git repo with a REAL
// worktree for the REAL `git worktree remove` teardown, and file-backed
// ground truth standing in for `gh` (the "stubbed gh"): PR states, issue
// closure, and the setup milestone's teardown keys all live in files.

import { createExecFn, type PrTruth, type SetupInfo, TEARDOWN_TIMEOUT_MS } from '../index';

/**
 * File-backed ground truth for the #468 flow: milestones carry keys (the park
 * milestone's `pr=`), PRs are `<pr>.pr.json`, issue closure is `<issue>.closed`,
 * and setup info is `<issue>.setup.json`.
 */
function fileTailGroundTruth(dir: string): GroundTruth {
  const readJson = (file: string): unknown | undefined => {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return undefined;
    }
  };
  return {
    latestMilestone: (issue) => {
      const raw = readJson(`${issue}.json`);
      if (raw === undefined) return null;
      if (raw === null || typeof raw !== 'object') return null;
      const m = raw as {
        phase: string;
        status: string;
        run: string;
        at: string;
        keys?: Record<string, string>;
      };
      return {
        phase: m.phase,
        status: m.status,
        run: m.run,
        at: m.at,
        keys: m.keys ?? {},
      };
    },
    issueClosed: (issue) => fs.existsSync(path.join(dir, `${issue}.closed`)),
    branchHead: () => null,
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
    setupInfo: (issue) => {
      const raw = readJson(`${issue}.setup.json`);
      if (raw === undefined || raw === null || typeof raw !== 'object') return null;
      const s = raw as Partial<SetupInfo>;
      if (typeof s.worktree !== 'string') return null;
      return {
        worktree: s.worktree,
        poolClaimed: s.poolClaimed === true,
        branch: s.branch ?? null,
      };
    },
  };
}

interface TailHarness {
  deps: EngineDeps;
  config: SchedConfig;
  store: SchedStore;
  spawnDeps: EngineDeps['spawnDeps'];
  truthDir: string;
  tick: () => ReturnType<typeof tick>;
  enqueue: (inputs: EnqueueInput[]) => void;
  state: () => ReturnType<SchedStore['load']>;
}

/**
 * The #468 harness: file ground truth, REAL spawned fake agents
 * (park/report via prompt), and a REAL teardown exec against `repoDir`.
 */
function tailHarness(
  truthDir: string,
  repoDir: string,
  opts?: { maxSlots?: number; existingStoreDir?: string }
): TailHarness {
  const store = new SchedStore(opts?.existingStoreDir ?? tmpDir('sched-tail-'));
  const deps: EngineDeps = {
    store,
    journal: new Journal(store.dir),
    groundTruth: fileTailGroundTruth(truthDir),
    spawnDeps: createSpawnDeps(),
    now: () => new Date(),
    repoDir,
    teardownExec: createExecFn(TEARDOWN_TIMEOUT_MS),
  };
  const config: SchedConfig = {
    max_slots: opts?.maxSlots ?? 2,
    dispatch: {
      command: ['node', FAKE_AGENT, '--mode=tail', `--milestones-dir=${truthDir}`],
      prompt: 'Run the full-cycle workflow for issue #{issue} now.',
    },
  };
  return {
    deps,
    config,
    store,
    spawnDeps: deps.spawnDeps,
    truthDir,
    tick: () => tick(deps, config),
    enqueue: (inputs) =>
      store.withLock((state) => ({
        state: enqueueEntries(state, inputs, new Date()),
        result: null,
      })),
    state: () => store.load(),
  };
}

/** A scratch repo (bare origin + main worktree) with one pushed commit. */
function scratchRepo(): string {
  const gitRoot = tmpDir('sched-tail-git-');
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

describe('integration #468: park → watch → merged → teardown (real git) → report → done', () => {
  it('walks the full detached-ship tail with a real worktree removal', async () => {
    const truthDir = tmpDir('sched-tail-truth-');
    const repo = scratchRepo();

    // a REAL worktree the fake run "created"
    const branch = 'feature/401-x';
    execFileSync('git', ['worktree', 'add', '-b', branch, path.join(repo, 'wt-401'), 'main'], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    expect(fs.existsSync(path.join(repo, 'wt-401', 'README.md'))).toBe(true);

    const h = tailHarness(truthDir, repo);
    h.enqueue([{ issue: 401, mode: 'full', tier: 'mid' }]);

    // dispatch → the agent parks PR #77 (issue 401) and exits
    const spawned = h.tick();
    expect(spawned.spawned).toEqual(['issue:401']);
    const parkPid = h.state().slots[0].pid as number;
    expect(await waitUntilDead(h.spawnDeps, parkPid)).toBe(true);

    // exit verified as a park — no slot held, entry parked with pr
    let result = h.tick();
    expect(result.parked).toEqual(['issue:401']);
    expect(h.state().entries[0].status).toBe('parked');
    expect(h.state().entries[0].pr).toBe(401); // --pr omitted → pr = issue
    expect(h.state().slots.every((s) => s.status === 'idle')).toBe(true);

    // the PR merges and the issue closes (files = the stubbed gh)
    const pr = h.state().entries[0].pr as number;
    fs.writeFileSync(
      path.join(truthDir, `${pr}.pr.json`),
      JSON.stringify({ state: 'MERGED', mergedAt: new Date().toISOString() })
    );
    fs.writeFileSync(path.join(truthDir, '401.closed'), '');
    fs.writeFileSync(
      path.join(truthDir, '401.setup.json'),
      JSON.stringify({ worktree: path.join(repo, 'wt-401'), poolClaimed: false, branch })
    );

    // the watcher accepts the merge, tears the worktree down (REAL git), and
    // dispatches the cheap-tier report agent
    result = h.tick();
    expect(result.mergeAccepted).toEqual(['issue:401']);
    expect(result.reportDispatched).toEqual(['issue:401']);
    expect(h.state().entries[0].status).toBe('shipped');
    expect(h.state().entries[0].cleanup).toBe('done');
    // the worktree is REALLY gone
    expect(fs.existsSync(path.join(repo, 'wt-401'))).toBe(false);

    // the report agent (same command, report prompt) posts report done + exits
    const reportPid = h.state().slots.find((s) => s.unit === 'issue:401')?.pid as number;
    expect(reportPid).toBeDefined();
    expect(await waitUntilDead(h.spawnDeps, reportPid)).toBe(true);

    result = h.tick();
    expect(result.completed).toEqual(['issue:401']);
    expect(h.state().entries[0].status).toBe('done');
    expect(h.state().slots.every((s) => s.status === 'idle')).toBe(true);
  }, 30_000);

  it('a CONFLICTING PR fails the unit and blocks transitive dependents', async () => {
    const truthDir = tmpDir('sched-tail-truth-');
    const repo = scratchRepo();
    const h = tailHarness(truthDir, repo);
    h.enqueue([
      { issue: 402, mode: 'full', tier: 'mid' },
      { issue: 403, mode: 'full', tier: 'mid', deps: [402] },
    ]);

    h.tick(); // dispatch 402
    const pid = h.state().slots[0].pid as number;
    expect(await waitUntilDead(h.spawnDeps, pid)).toBe(true);
    const parked = h.tick();
    expect(parked.parked).toEqual(['issue:402']);
    const pr = h.state().entries.find((e) => e.issue === 402)?.pr as number;

    fs.writeFileSync(
      path.join(truthDir, `${pr}.pr.json`),
      JSON.stringify({ state: 'OPEN', mergeable: 'CONFLICTING' })
    );

    const result = h.tick();
    expect(result.failed).toEqual(['issue:402']);
    expect(result.blocked).toEqual([403]);
    const state = h.state();
    expect(state.entries.find((e) => e.issue === 402)?.reason).toBe('pr-conflicting');
    expect(state.entries.find((e) => e.issue === 403)?.status).toBe('blocked');
  }, 30_000);

  it('restart mid-watch: a fresh engine instance resumes from state.json and finishes the tail', async () => {
    const truthDir = tmpDir('sched-tail-truth-');
    const repo = scratchRepo();
    execFileSync(
      'git',
      ['worktree', 'add', '-b', 'feature/404-x', path.join(repo, 'wt-404'), 'main'],
      {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );

    const first = tailHarness(truthDir, repo);
    first.enqueue([{ issue: 404, mode: 'full', tier: 'mid' }]);
    first.tick();
    const pid = first.state().slots[0].pid as number;
    expect(await waitUntilDead(first.spawnDeps, pid)).toBe(true);
    expect(first.tick().parked).toEqual(['issue:404']);

    // engine "dies": a brand-new instance (new store handle, new journal,
    // new spawn deps — same state.json on disk) takes over the watch
    const storeDir = first.store.dir;
    const h = tailHarness(truthDir, repo, { existingStoreDir: storeDir });
    const pr = h.state().entries[0].pr as number;
    fs.writeFileSync(
      path.join(truthDir, `${pr}.pr.json`),
      JSON.stringify({ state: 'MERGED', mergedAt: new Date().toISOString() })
    );
    fs.writeFileSync(path.join(truthDir, '404.closed'), '');
    fs.writeFileSync(
      path.join(truthDir, '404.setup.json'),
      JSON.stringify({ worktree: path.join(repo, 'wt-404'), poolClaimed: false })
    );

    const result = h.tick();
    expect(result.mergeAccepted).toEqual(['issue:404']);
    expect(h.state().entries[0].cleanup).toBe('done');
    expect(fs.existsSync(path.join(repo, 'wt-404'))).toBe(false);

    const reportPid = h.state().slots.find((s) => s.unit === 'issue:404')?.pid as number;
    expect(await waitUntilDead(h.spawnDeps, reportPid)).toBe(true);
    expect(h.tick().completed).toEqual(['issue:404']);
    expect(h.state().entries[0].status).toBe('done');
  }, 30_000);
});
