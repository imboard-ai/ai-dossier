import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [versionFile, stateDir, timelineFile] = process.argv.slice(2);

function append(line) {
  fs.appendFileSync(timelineFile, `${line}\n`);
}

const version = fs.readFileSync(versionFile, 'utf8').trim();
if (version === '0.89.5') {
  append(`old-start:${version}`);
  const cliModule = path.resolve(here, '../../../dist/commands/sched.js');
  const { reexecUpdatedCli, upgradeHasAgents } = await import(pathToFileURL(cliModule).href);
  const schedModule = path.resolve(here, '../../../../packages/sched/dist/index.js');
  const { createSpawnDeps, procStatFields, SchedStore } = await import(
    pathToFileURL(schedModule).href
  );
  const deps = { store: new SchedStore(stateDir), spawnDeps: createSpawnDeps() };
  const pids = [1, 2].map((n) =>
    deps.spawnDeps.spawn(
      [process.execPath, '-e', 'setTimeout(() => process.exit(0), 100)'],
      '',
      path.join(stateDir, `agent-${n}.log`)
    )
  );
  if (!upgradeHasAgents(deps)) throw new Error('live owned agents did not fence upgrade');
  append('upgrade-deferred:two-owned-agents');
  const deadline = Date.now() + 5_000;
  while (upgradeHasAgents(deps) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (upgradeHasAgents(deps)) throw new Error('children failed to drain');
  if (process.platform === 'linux' && pids.some((pid) => procStatFields(pid) !== null)) {
    throw new Error('owned child not reaped before upgrade');
  }
  append('agents-reaped:before-install');
  // The real `npm i -g @ai-dossier/cli@latest` installs the new package before
  // the engine replaces itself. The file is the fixture's installed package.
  fs.writeFileSync(versionFile, '0.89.6');
  append('install-complete:0.89.6');

  if (!reexecUpdatedCli()) {
    // Node versions without process.execve use the same exit contract as the
    // supervised service. The test parent launches the updated entry point.
    process.exitCode = 75;
    process.exit();
  }
  append('old-after-install'); // unreachable after a successful process replace
  process.exit(99);
}

if (version !== '0.89.6') {
  append(`unexpected-version:${version}`);
  process.exit(2);
}

const schedModule = path.resolve(here, '../../../../packages/sched/dist/index.js');
const { SCHEMA_VERSION, SchedStore } = await import(pathToFileURL(schedModule).href);
const store = new SchedStore(stateDir);
const migrated = store.load();
const entry = migrated.entries[0];
if (
  migrated.schema_version !== SCHEMA_VERSION ||
  entry?.ground_truth_unreachable_condition !== null
) {
  append(`migration-failed:${JSON.stringify(migrated)}`);
  process.exit(3);
}
append(
  `new-load:${version}:schema=${migrated.schema_version}:unreachable=${entry.ground_truth_unreachable_condition}`
);

store.withLock((current) => ({ state: { ...current, paused: true }, result: null }));
append(`new-write:${version}:schema=${store.load().schema_version}`);
