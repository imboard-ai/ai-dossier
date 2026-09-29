// Child-process fixture for the #945 engine-exit tests: the REAL lease +
// heartbeat + exit-logging + runLoop from the BUILT package, mirroring what
// `sched start` wires. argv: <stateDir> [crash]. With `crash`, throws from a
// timer after the second tick (an uncaught exception).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { SchedStore, Journal, runLoop, installEngineExitLogging } = await import(
  path.resolve(here, '../../../dist/index.js')
);

const dir = process.argv[2];
const crash = process.argv[3] === 'crash';
const store = new SchedStore(dir, path.join(dir, 'user-config.json'));
const acquisition = store.acquireEngineLease();
if (!acquisition.acquired) {
  console.error('lease held');
  process.exit(3);
}
const journal = new Journal(dir);
let stopping = false;
let logger;
process.once('exit', () => {
  if (logger?.shouldReleaseLease() ?? true) store.releaseEngineLease(acquisition.lease);
});
logger = installEngineExitLogging({
  journal,
  requestStop: () => {
    stopping = true;
  },
});

const deps = {
  store,
  journal,
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
      throw new Error('unreachable');
    },
    kill: () => false,
    isAlive: () => false,
    processStart: () => null,
  },
  now: () => new Date(),
  repoDir: dir,
  teardownExec: () => null,
  homeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sched-exit-home-')),
};

console.log('ready');
let ticks = 0;
await runLoop(
  deps,
  { reconcile_interval_ms: 100 },
  () => stopping,
  () => {
    ticks += 1;
    console.log(`tick ${ticks}`);
    if (crash && ticks === 2)
      setTimeout(() => {
        throw new Error('fixture crash');
      }, 0);
  }
);
logger.logNormalExit('loop returned');
console.log('stopped');
