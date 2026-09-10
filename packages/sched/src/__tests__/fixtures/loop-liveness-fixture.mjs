// Child-process fixture for the #679 event-loop-liveness regression test.
//
// Runs the REAL `runLoop` from the BUILT package (`packages/sched/dist`) with
// no-op engine deps and a short tick interval, prints one line per tick, and
// exits 0 on SIGINT. A parent test asserts this process is still alive after
// two tick intervals — against the unfixed code both sleep handles were
// unref'd, the event loop drained after the first tick's work settled, and
// the process exited cleanly on its own (the #679 bug).
//
// Imports from dist, not src: a child process cannot import TypeScript. CI
// runs `make build-all` before tests, so dist always exists there; the test
// skips (loudly) when dist is missing on a cold local tree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distIndex = path.resolve(here, '../../../dist/index.js');

const { SchedStore, Journal, runLoop } = await import(distIndex);

const intervalMs = Number(process.argv[2] ?? 150);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-liveness-'));
const deps = {
  store: new SchedStore(dir),
  journal: new Journal(dir),
  groundTruth: {
    latestMilestone: () => null,
    issueClosed: () => false,
    branchHead: () => null,
    prState: () => undefined,
    openPrForBranch: () => null,
    setupInfo: () => null,
    issueLabels: () => [],
  },
  spawnDeps: {
    spawn: () => {
      throw new Error('fixture queue is empty — spawn must never be reached');
    },
    kill: () => false,
    isAlive: () => false,
    processStart: () => null,
  },
  now: () => new Date(),
  repoDir: dir,
  teardownExec: () => null,
  homeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sched-liveness-home-')),
};

let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
});

console.log(`ready interval=${intervalMs}`);
let tickCount = 0;
try {
  await runLoop(
    deps,
    { reconcile_interval_ms: intervalMs },
    () => stopping,
    () => {
      tickCount += 1;
      console.log(`tick ${tickCount}`);
    }
  );
} catch (err) {
  console.error(`loop-error ${err?.message ?? err}`);
  process.exit(1);
}
console.log(`stopped after ${tickCount} ticks`);

// Prove the loop exited because of the signal, not because the event loop
// drained: a signal-driven stop must show at least one tick; the #679 bug
// showed exactly one tick and a self-exit with no signal at all.
if (process.exitCode === undefined) process.exitCode = 0;
