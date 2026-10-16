import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Command } from 'commander';

const [mode, dir] = process.argv.slice(2);
process.env.HOME = dir;
process.chdir(dir);
const here = path.dirname(fileURLToPath(import.meta.url));
const sched = await import(
  pathToFileURL(path.resolve(here, '../../../../packages/sched/dist/index.js'))
);
const cli = await import(pathToFileURL(path.resolve(here, '../../../dist/commands/sched.js')));
const runners = await import(
  pathToFileURL(path.resolve(here, '../../../dist/sched-tick-runner.js'))
);
const store = new sched.SchedStore(path.join(dir, 'state'));
const deps = { store, spawnDeps: sched.createSpawnDeps() };
const agentCode = `setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(path.join(dir, 'release'))})) process.exit(0); }, 10)`;

if (mode === 'legacy') {
  const child = spawn(process.execPath, ['-e', agentCode], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  fs.writeFileSync(path.join(dir, 'pid'), String(child.pid));
  if (typeof process.execve !== 'function') throw new Error('execve unavailable');
  process.execve(
    process.execPath,
    [process.execPath, process.argv[1], 'inherited', dir],
    process.env
  );
  throw new Error('execve returned');
}

let runner;
if (mode === 'worker') {
  const workerFile = path.join(dir, 'worker.cjs');
  const dispatchModule = path.resolve(here, '../../../../packages/sched/dist/index.js');
  fs.writeFileSync(
    workerFile,
    `
    const { parentPort } = require('node:worker_threads');
    const { createSpawnDeps } = require(${JSON.stringify(dispatchModule)});
    const fs = require('node:fs');
    const deps = createSpawnDeps();
    parentPort.on('message', ({id, config}) => {
      if (config.mode === 'spawn') {
        const pid = deps.spawn([process.execPath, '-e', ${JSON.stringify(agentCode)}], '', ${JSON.stringify(path.join(dir, 'agent.log'))});
        fs.writeFileSync(${JSON.stringify(path.join(dir, 'pid'))}, String(pid));
      }
      if (config.mode === 'crash') process.exit(17);
      parentPort.postMessage({ id, ok: true, result: {}, unreapedChildren: deps.hasUnreapedChildren() });
    });
  `
  );
  runner = runners.createWorkerTickRunner(workerFile, { stateDir: store.dir, repoDir: dir });
  await runner.runTick({ mode: 'spawn' });
  if (!runner.hasUnreapedChildren()) throw new Error('missing worker fence');
  try {
    await runner.runTick({ mode: 'crash' });
  } catch {}
  await runner.runTick({ mode: 'empty' }); // replacement has no wait handle
}

try {
  // Even a replacement SpawnDeps/worker with no owned callbacks must fence a
  // live inherited child. Once Z, request a real process exit, NEVER execve.
  if (!cli.upgradeHasAgents(deps)) throw new Error('inherited live child did not fence upgrade');
  fs.writeFileSync(path.join(dir, 'release'), 'exit');
  const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
  const deadline = Date.now() + 5_000;
  while (!cli.needsChildReaperRestart(deps) && Date.now() < deadline) await delay(10);
  if (!cli.needsChildReaperRestart(deps)) throw new Error('missing reaper restart request');
  if (sched.procStatFields(pid)?.[0] !== 'Z') throw new Error('fixture child is not a zombie');
  await runner?.close();
  runner = undefined;
  // Drive the production CLI caller too. The continuous case uses the real
  // compiled tick worker, on isolated empty scheduler state after slot release.
  const program = new Command();
  cli.registerSchedCommand(program);
  await program.parseAsync([
    'node',
    'ai-dossier',
    'sched',
    'start',
    '--project',
    'reaper-fixture',
    ...(mode === 'inherited' ? ['--once'] : ['--interval', '1', '--unsupervised']),
  ]);
  if (process.exitCode !== 75) throw new Error('production caller did not request process restart');
  console.log('live-fenced; zombie-dead; supervisor-restart=75');
} finally {
  await runner?.close();
}
