import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { enqueueEntries, Journal, type SchedState, SchedStore } from '../index';

const FIXTURE = fileURLToPath(new URL('./fixtures/engine-chaos-fixture.mjs', import.meta.url));
const roots: string[] = [];
const children: ChildProcess[] = [];
const scenarios: Scenario[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }
  for (const scenario of scenarios.splice(0)) {
    const stateFile = path.join(scenario.stateDir, 'state.json');
    if (!fs.existsSync(stateFile)) continue;
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as {
        slots?: Array<{ pid?: number | null; status?: string }>;
      };
      for (const slot of state.slots ?? []) {
        if (!slot.pid || slot.status === 'idle') continue;
        try {
          process.kill(-slot.pid, 'SIGKILL');
        } catch {
          try {
            process.kill(slot.pid, 'SIGKILL');
          } catch {
            // already exited
          }
        }
      }
    } catch {
      // State may be mid-write only if the test itself found a crash defect.
    }
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface Scenario {
  root: string;
  repoDir: string;
  stateDir: string;
  truthDir: string;
  batchId: string;
}

function scratchScenario(name: string): Scenario {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sched-chaos-${name}-`));
  roots.push(root);
  const bare = path.join(root, 'origin.git');
  const repoDir = path.join(root, 'repo');
  fs.mkdirSync(bare);
  fs.mkdirSync(repoDir);
  const git = (args: string[], cwd: string) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git(['init', '--bare', '--initial-branch=main', bare], root);
  git(['init', '--initial-branch=main', '.'], repoDir);
  git(['config', 'user.email', 'sched-chaos@test'], repoDir);
  git(['config', 'user.name', 'sched chaos test'], repoDir);
  git(['remote', 'add', 'origin', bare], repoDir);
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'restart chaos fixture\n');
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'fixture: initialize chaos repository'], repoDir);
  git(['push', '-u', 'origin', 'main'], repoDir);

  const stateDir = path.join(root, 'state');
  const truthDir = path.join(root, 'truth');
  fs.mkdirSync(truthDir);
  const store = new SchedStore(stateDir, path.join(stateDir, 'user-config.json'));
  const batchId = 'b-945-chaos';
  const inputs = [601, 602, 603].map((issue, index) => ({
    issue,
    mode: 'slot' as const,
    batch: batchId,
    ...(index === 0 ? { anchor: 600 } : {}),
    tier: 'mid' as const,
  }));
  store.withLock((state) => ({ state: enqueueEntries(state, inputs, new Date()), result: null }));
  const scenario = { root, repoDir, stateDir, truthDir, batchId };
  scenarios.push(scenario);
  return scenario;
}

interface EngineProcess {
  child: ChildProcess;
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  exitResult: () => { code: number | null; signal: NodeJS.Signals | null } | null;
}

function startEngine(scenario: Scenario, checkpoint: string): EngineProcess {
  const marker = path.join(scenario.truthDir, 'engine-checkpoint.json');
  fs.rmSync(marker, { force: true });
  const landingIssue = checkpoint.startsWith('land:') ? checkpoint.slice('land:'.length) : 'none';
  const child = spawn(
    process.execPath,
    [
      FIXTURE,
      scenario.stateDir,
      scenario.repoDir,
      scenario.truthDir,
      scenario.batchId,
      checkpoint,
      landingIssue,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  children.push(child);
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  let exitResult: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      exitResult = { code, signal };
      resolve(exitResult);
    });
  });
  return { child, output: () => output, exited, exitResult: () => exitResult };
}

async function waitForCheckpoint(
  engine: EngineProcess,
  scenario: Scenario,
  expected: string,
  timeoutMs = 15_000
): Promise<Record<string, unknown>> {
  const marker = path.join(scenario.truthDir, 'engine-checkpoint.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(marker)) {
      const payload = JSON.parse(fs.readFileSync(marker, 'utf8')) as Record<string, unknown>;
      if (payload.point !== expected) {
        throw new Error(
          `expected checkpoint ${expected}, got ${String(payload.point)}; ${engine.output()}`
        );
      }
      return payload;
    }
    if (engine.exitResult() !== null) {
      throw new Error(`engine exited before checkpoint ${expected}: ${engine.output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const stateFile = path.join(scenario.stateDir, 'state.json');
  const state = fs.existsSync(stateFile)
    ? (JSON.parse(fs.readFileSync(stateFile, 'utf8')) as SchedState)
    : null;
  const lockDir = path.join(scenario.stateDir, '.sched-lock');
  const lockPid = fs.existsSync(path.join(lockDir, 'pid'))
    ? fs.readFileSync(path.join(lockDir, 'pid'), 'utf8')
    : null;
  const lease = new SchedStore(
    scenario.stateDir,
    path.join(scenario.stateDir, 'user-config.json')
  ).engineLeaseStatus();
  const spawns = spawnKeys(scenario.truthDir);
  const journal = new Journal(scenario.stateDir).read().map((event) => event.event);
  engine.child.kill('SIGKILL');
  await engine.exited;
  throw new Error(
    `timed out waiting for checkpoint ${expected} in pid ${engine.child.pid}: ${engine.output()}\n` +
      `batches=${JSON.stringify(state?.batches.map((batch) => [batch.status, batch.member_branch, batch.ranges]))}\n` +
      `entries=${JSON.stringify(state?.entries.map((entry) => [entry.issue, entry.status]))}\n` +
      `slots=${JSON.stringify(state?.slots.map((slot) => [slot.status, slot.unit, slot.pid]))}\n` +
      `lease=${JSON.stringify(lease)} lockPid=${lockPid}\n` +
      `spawns=${JSON.stringify(spawns)} journal=${JSON.stringify(journal)}`
  );
}

async function killEngine(engine: EngineProcess): Promise<void> {
  engine.child.kill('SIGKILL');
  expect(await engine.exited).toMatchObject({ code: null, signal: 'SIGKILL' });
}

async function finishBatch(scenario: Scenario, checkpoint: string): Promise<EngineProcess> {
  const engine = startEngine(scenario, checkpoint);
  let timeout: NodeJS.Timeout;
  const result = await Promise.race([
    engine.exited,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const stateFile = path.join(scenario.stateDir, 'state.json');
        const state = fs.existsSync(stateFile)
          ? (JSON.parse(fs.readFileSync(stateFile, 'utf8')) as SchedState)
          : null;
        const truth = fs
          .readdirSync(scenario.truthDir)
          .filter((name) => name.endsWith('.json'))
          .map((name) => [name, fs.readFileSync(path.join(scenario.truthDir, name), 'utf8')]);
        reject(
          new Error(
            `batch did not finish: ${engine.output()}\nstate=${JSON.stringify(state?.batches)}\n` +
              `entries=${JSON.stringify(state?.entries.map((e) => [e.issue, e.status]))}\n` +
              `truth=${JSON.stringify(truth)}\n` +
              `journal=${JSON.stringify(new Journal(scenario.stateDir).read().map((e) => e.event))}`
          )
        );
      }, 45_000);
    }),
  ]).finally(() => clearTimeout(timeout));
  expect(result).toEqual({ code: 0, signal: null });
  return engine;
}

function seededLandingIssue(seed: number): number {
  let value = seed >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return [601, 602, 603][(value >>> 0) % 3] as number;
}

function semanticState(state: SchedState) {
  return {
    entries: state.entries
      .map(({ issue, status, mode, batch, tier }) => ({ issue, status, mode, batch, tier }))
      .sort((a, b) => a.issue - b.issue),
    batches: state.batches.map((batch) => ({
      id: batch.id,
      status: batch.status,
      members: batch.members,
      executing_member: batch.executing_member,
      pr: batch.pr,
      landed_members: batch.ranges.map((range) => range.issue).sort((a, b) => a - b),
    })),
    slots: state.slots
      .map(({ status, unit }) => ({ status, unit }))
      .sort((a, b) => (a.unit ?? '').localeCompare(b.unit ?? '')),
  };
}

function journalOutcomes(stateDir: string) {
  const outcomes = new Set([
    'member-advanced',
    'member-handed-back',
    'pr-parked',
    'merge-accepted',
    'report-dispatched',
    'member-worktree-torn-down',
  ]);
  return new Journal(stateDir)
    .read()
    .filter((event) => outcomes.has(event.event))
    .map((event) => ({
      event: event.event,
      unit: event.unit,
      issue: event.issue,
      pr: event.pr,
      detail: event.detail,
    }));
}

function spawnKeys(truthDir: string): string[] {
  const file = path.join(truthDir, 'spawns.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line) as { role: string; issue: string };
      return `${row.role}:${row.issue}`;
    })
    .sort();
}

describe('restart-anytime chaos integration (#945 AC5)', () => {
  it('matches an uninterrupted scripted batch after seeded SIGKILLs at assign/spawn, land, gate, and ship', async () => {
    const baseline = scratchScenario('baseline');
    const baselineEngine = await finishBatch(baseline, 'none');
    const baselineStore = new SchedStore(
      baseline.stateDir,
      path.join(baseline.stateDir, 'user-config.json')
    );
    const baselineState = semanticState(baselineStore.load());
    const baselineOutcomes = journalOutcomes(baseline.stateDir);
    const baselineSpawns = spawnKeys(baseline.truthDir);
    const baselineGate = fs
      .readFileSync(path.join(baseline.truthDir, 'gate-observations.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { present: string[] });
    expect(baselineEngine.output()).toContain('BATCH_DONE');
    expect(baselineGate.at(-1)?.present).toEqual([
      'chaos-601.txt',
      'chaos-602.txt',
      'chaos-603.txt',
    ]);

    const chaos = scratchScenario('chaos');
    const seed = 0x945;
    const landingIssue = seededLandingIssue(seed);
    const killPoints = ['assign-spawn', `land:${landingIssue}`, 'gate', 'ship'];
    const observed: string[] = [];
    for (const point of killPoints) {
      const engine = startEngine(chaos, point);
      const expectedCheckpoint = point.startsWith('land:')
        ? 'mid-land'
        : point === 'gate'
          ? 'mid-gate'
          : point === 'ship'
            ? 'mid-ship'
            : 'assign-spawn';
      await waitForCheckpoint(engine, chaos, expectedCheckpoint);
      await killEngine(engine);
      observed.push(expectedCheckpoint);
      if (point === 'ship') {
        fs.writeFileSync(
          path.join(chaos.truthDir, '9000.pr.json'),
          JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-02T00:00:00.000Z' })
        );
      }
    }

    const finalEngine = await finishBatch(chaos, 'none');
    const chaosStore = new SchedStore(
      chaos.stateDir,
      path.join(chaos.stateDir, 'user-config.json')
    );
    const chaosState = chaosStore.load();
    const chaosGate = fs
      .readFileSync(path.join(chaos.truthDir, 'gate-observations.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { present: string[] });

    expect(observed).toEqual(['assign-spawn', 'mid-land', 'mid-gate', 'mid-ship']);
    expect(semanticState(chaosState)).toEqual(baselineState);
    expect(journalOutcomes(chaos.stateDir)).toEqual(baselineOutcomes);
    expect(
      new Journal(chaos.stateDir).read().filter((event) => event.event === 'assigned-recovered')
    ).toHaveLength(1);
    expect(spawnKeys(chaos.truthDir)).toEqual(baselineSpawns);
    expect(new Set(spawnKeys(chaos.truthDir)).size).toBe(baselineSpawns.length);
    expect(
      chaosGate.every(
        (run) => run.present.join(',') === 'chaos-601.txt,chaos-602.txt,chaos-603.txt'
      )
    ).toBe(true);
    expect(chaosStore.engineLeaseStatus()).toBeNull();
    expect(chaosState.slots.every((slot) => slot.status === 'idle')).toBe(true);
    expect(finalEngine.output()).toContain('BATCH_DONE');
  }, 120_000);
});
