#!/usr/bin/env node
// CI-only self-check for the zero-trust gate 2 fixtures (packages/zero-trust/fixtures/ecosystem).
//
// For each fixture it proves, with real commands and exit codes:
//   1. the baseline suite passes on the base commit,
//   2. the regression test FAILS on base + regression commit,
//   3. the suite and the regression test PASS on the fix commit.
//
// This deliberately runs package installs and tests on the CI runner, outside any
// isolation. That is acceptable ONLY because the fixtures are our own code with pinned,
// hash-locked public dependencies. It is not, and must not become, a product path:
// the product (@ai-dossier/zero-trust) only builds command plans as data, and the real
// proof under network isolation is the in-VM run (#1010).
//
// Usage (after `make build-all`): node scripts/zero-trust-fixtures-selfcheck.mjs [npm|pip|uv ...]
// ZT_PYTHON overrides the `python` executable used to create the pip fixture's venv.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const fixtures = join(root, 'packages/zero-trust/fixtures/ecosystem');
const zt = createRequire(import.meta.url)(join(root, 'packages/zero-trust/dist/index.js'));

// Public registries stand in for the proxy here; the in-VM run points these at the mirrors.
const REGISTRIES = {
  npmRegistry: 'https://registry.npmjs.org/',
  pypiIndex: 'https://pypi.org/simple/',
};
const REGRESSION = {
  npm: ['test/regression.test.js'],
  pip: ['tests/test_regression.py'],
  uv: ['tests/test_regression.py'],
};
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'ztfc-fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'ztfc-fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2026-10-06T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-10-06T00:00:00Z',
};

function run(argv, cwd, env = {}, timeout = 15 * 60 * 1000) {
  const [cmd, ...args] =
    argv[0] === 'python' && process.env.ZT_PYTHON
      ? [process.env.ZT_PYTHON, ...argv.slice(1)]
      : argv;
  const result = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...GIT_ENV, ...env },
    encoding: 'utf8',
    timeout,
  });
  return {
    status: result.status,
    signal: result.signal,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function git(args, cwd) {
  const result = run(['git', '-c', 'core.hooksPath=/dev/null', ...args], cwd);
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.output}`);
  return result.output.trim();
}

function commit(cwd, message) {
  git(['add', '-A'], cwd);
  git(['commit', '-q', '-m', message], cwd);
  return git(['rev-parse', 'HEAD'], cwd);
}

function sourceFiles(dir) {
  const files = new Map();
  for (const name of readdirSync(dir)) {
    if (statSync(join(dir, name)).isFile()) files.set(name, readFileSync(join(dir, name), 'utf8'));
  }
  return files;
}

function check(name) {
  const base = join(fixtures, name, 'base');
  const detection = zt.detectEcosystem(sourceFiles(base));
  if (!detection.supported)
    throw new Error(`${name}: detection rejected the fixture (${detection.reason})`);
  const selection = zt.selectProfile(detection);
  if (!selection.ok) throw new Error(`${name}: no profile (${selection.reason})`);
  const work = mkdtempSync(join(tmpdir(), `ztfc-${name}-`));
  const steps = [];
  try {
    cpSync(base, work, { recursive: true });
    git(['init', '-q', '-b', 'main'], work);
    const shas = { base: commit(work, 'base') };
    const plan = zt.buildCommandPlan(detection.manager, REGISTRIES);
    const regression = zt.buildCommandPlan(detection.manager, REGISTRIES, {
      testTargets: REGRESSION[name],
    });
    const exec = (step, sha, commands, expectPass) => {
      for (const command of commands) {
        const result = run(command.argv, work, command.env, command.timeoutMs);
        const last = command === commands.at(-1);
        const passed = result.status === 0;
        steps.push({
          step,
          sha,
          command: command.argv.join(' '),
          network: command.network,
          exit: result.status,
          signal: result.signal,
        });
        if (!last && !passed)
          throw new Error(`${name}/${step}: ${command.id} failed\n${result.output}`);
        if (last && passed !== expectPass)
          throw new Error(
            `${name}/${step}: expected ${expectPass ? 'pass' : 'fail'}, got exit ${result.status}\n${result.output}`
          );
      }
    };
    exec('provision', shas.base, plan.provisioning, true);
    exec('baseline-suite', shas.base, plan.verification, true);
    git(['apply', join(fixtures, name, 'regression.patch')], work);
    shas.regression = commit(work, 'test: add regression test');
    exec('regression-on-base', shas.regression, regression.verification, false);
    git(['apply', join(fixtures, name, 'fix.patch')], work);
    shas.fix = commit(work, 'fix: known bug');
    exec('regression-on-fix', shas.fix, regression.verification, true);
    exec('suite-on-fix', shas.fix, plan.verification, true);
    return {
      fixture: name,
      profile: selection.profile.id,
      manager: detection.manager,
      shas,
      steps,
      result: 'pass',
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : ['npm', 'pip', 'uv'];
let failed = false;
for (const name of names) {
  try {
    console.log(JSON.stringify(check(name)));
  } catch (error) {
    failed = true;
    console.error(`FAIL ${relative(root, join(fixtures, name))}: ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
