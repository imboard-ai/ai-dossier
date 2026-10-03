import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const schedPath = path.resolve(here, '../../../dist/index.js');
const { Journal, SchedStore, createSpawnDeps, runLoop } = await import(
  pathToFileURL(schedPath).href
);

const [stateDir, repoDir, truthDir, batchId, checkpointName, landingIssue] = process.argv.slice(2);
const checkpointFile = path.join(truthDir, 'engine-checkpoint.json');
const spawnLog = path.join(truthDir, 'spawns.jsonl');
const gateLog = path.join(truthDir, 'gate-observations.jsonl');
const expectedFiles = [601, 602, 603].map((issue) => `chaos-${issue}.txt`);
const FAKE_AGENT = path.join(here, 'fake-agent.mjs');

function checkpoint(point, details = {}) {
  fs.writeFileSync(checkpointFile, JSON.stringify({ point, details }));
  process.stdout.write(`CHECKPOINT ${point}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
}

function realExec(file, args, cwd) {
  try {
    return execFileSync(file, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function milestone(issue) {
  const file = path.join(truthDir, `${issue}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...raw, keys: raw.keys ?? {} };
  } catch {
    return null;
  }
}

function parseRunstateArgs(args) {
  const value = (flag) => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  return { value, issue: value('--issue') };
}

let checkpointUsed = false;
const batchExec = (file, args, cwd) => {
  if (file === 'npx') return null; // no pool is configured for this scratch repository
  if (file === 'ai-dossier' && args[0] === 'runstate' && args[1] === 'mint') {
    const issue = args[args.indexOf('--issue') + 1];
    return `r-${issue}-chaos`;
  }
  if (file === 'ai-dossier' && args[0] === 'runstate' && args[1] === 'post') {
    const { value, issue } = parseRunstateArgs(args);
    const keys = {};
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] !== '--kv') continue;
      const pair = args[i + 1] ?? '';
      const splitAt = pair.indexOf('=');
      if (splitAt > 0) keys[pair.slice(0, splitAt)] = pair.slice(splitAt + 1);
    }
    fs.writeFileSync(
      path.join(truthDir, `${issue}.json`),
      JSON.stringify({
        phase: value('--phase'),
        status: value('--status'),
        run: value('--run'),
        at: new Date().toISOString(),
        keys,
      })
    );
    return '';
  }
  if (file === 'git') {
    const result = realExec(file, args, cwd);
    const isSelectedLandingPush =
      args[0] === 'push' && args.some((arg) => arg.includes(`-${landingIssue}`));
    if (checkpointName?.startsWith('land:') && !checkpointUsed && isSelectedLandingPush) {
      checkpointUsed = true;
      checkpoint('mid-land', { issue: landingIssue, args });
    }
    return result;
  }
  return realExec(file, args, cwd);
};

const store = new SchedStore(stateDir, path.join(stateDir, 'user-config.json'));
const acquisition = store.acquireEngineLease();
if (!acquisition.acquired) {
  process.stderr.write(`engine lease held by ${acquisition.holder?.pid ?? 'unknown'}\n`);
  process.exit(3);
}
const journal = new Journal(stateDir);
const releaseLease = () => store.releaseEngineLease(acquisition.lease);
process.once('exit', releaseLease);

const baseSpawnDeps = createSpawnDeps(repoDir);
const spawnDeps = {
  ...baseSpawnDeps,
  spawn(cmd, prompt, logFile) {
    if (checkpointName === 'assign-spawn' && !checkpointUsed) {
      checkpointUsed = true;
      checkpoint('assign-spawn', { prompt, logFile });
    }
    const pid = baseSpawnDeps.spawn(cmd, prompt, logFile);
    const role = /batch report phase/i.test(prompt)
      ? 'report'
      : /batch review and ship tail/i.test(prompt)
        ? 'tail'
        : /member-cycle workflow/i.test(prompt)
          ? 'member'
          : 'other';
    const issue = /#(\d+)/.exec(prompt)?.[1] ?? 'unknown';
    fs.appendFileSync(spawnLog, `${JSON.stringify({ role, issue, pid })}\n`);
    return pid;
  },
};

const prFile = path.join(truthDir, '9000.pr.json');
let shipCheckpointUsed = false;
const groundTruth = {
  latestMilestone: milestone,
  issueClosed: () => false,
  branchHead: (branch) => {
    const listing = realExec('git', ['ls-remote', 'origin', branch], repoDir);
    return listing?.split(/\s+/)[0] ?? null;
  },
  prState: (pr) => {
    if (
      Number(pr) === 9000 &&
      checkpointName === 'ship' &&
      !shipCheckpointUsed &&
      !fs.existsSync(prFile)
    ) {
      shipCheckpointUsed = true;
      checkpoint('mid-ship', { pr });
    }
    if (!fs.existsSync(prFile)) {
      return checkpointName === 'ship'
        ? undefined
        : { state: 'MERGED', mergedAt: '2026-10-02T00:00:00.000Z', mergeable: 'MERGEABLE' };
    }
    try {
      return JSON.parse(fs.readFileSync(prFile, 'utf8'));
    } catch {
      return undefined;
    }
  },
  openPrForBranch: () => null,
  setupInfo: () => null,
  issueLabels: () => [],
};

const runBatchSuite = (worktree) => {
  const present = expectedFiles.filter((name) => fs.existsSync(path.join(worktree, name)));
  const observation = { present, expected: expectedFiles };
  fs.appendFileSync(gateLog, `${JSON.stringify(observation)}\n`);
  fs.writeFileSync(path.join(worktree, 'chaos-gate-observation.json'), JSON.stringify(observation));
  if (checkpointName === 'gate' && !checkpointUsed) {
    checkpointUsed = true;
    checkpoint('mid-gate', observation);
  }
  const failing = expectedFiles.filter((name) => !present.includes(name));
  return { ok: failing.length === 0, failing, readable: true, detail: JSON.stringify(observation) };
};

const deps = {
  store,
  journal,
  groundTruth,
  spawnDeps,
  now: () => new Date(),
  repoDir,
  homeDir: path.join(stateDir, 'home'),
  teardownExec: realExec,
  batchExec,
  runBatchSuite,
};
const config = {
  max_slots: 1,
  member_parallelism: 1,
  reconcile_interval_ms: 25,
  dispatch: {
    command: [
      'node',
      FAKE_AGENT,
      '--mode=batch',
      '--commit-file=chaos-{issue}.txt',
      `--milestones-dir=${truthDir}`,
    ],
    prompt: 'placeholder; batch phases render their own prompts',
  },
};

try {
  await runLoop(deps, config, () =>
    store.load().batches.some((batch) => batch.id === batchId && batch.status === 'done')
  );
  releaseLease();
  process.removeListener('exit', releaseLease);
  process.stdout.write('BATCH_DONE\n');
} catch (err) {
  process.stderr.write(`${err?.stack ?? String(err)}\n`);
  process.exitCode = 1;
}
