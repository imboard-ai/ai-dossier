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
// Usage (after `make build-zero-trust`): node scripts/zero-trust-fixtures-selfcheck.mjs [npm|pip|uv ...]
// ZT_PYTHON overrides the Python interpreter (default: `python3` on PATH).
// Under CI the host runtimes must match the selected profiles; locally a mismatch only warns.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = join(root, 'packages/zero-trust/fixtures/ecosystem');
let zt;
try {
  zt = createRequire(import.meta.url)(join(root, 'packages/zero-trust/dist/index.js'));
} catch (error) {
  console.error(
    `Cannot load packages/zero-trust/dist (${error.code}); run \`make build-zero-trust\` first.`
  );
  process.exit(2);
}

// Public registries stand in for the proxy here; the in-VM run points these at the mirrors.
const REGISTRIES = { npmRegistry: zt.NPM_REGISTRY, pypiIndex: `${zt.PYPI_SIMPLE}/` };
const REGRESSION = {
  npm: ['test/regression.test.js'],
  pip: ['tests/test_regression.py'],
  uv: ['tests/test_regression.py'],
};
// Generous for three tiny fixtures, and well inside the workflow's job timeout.
const TIMEOUTS = { provisioningTimeoutMs: 5 * 60 * 1000, verificationTimeoutMs: 3 * 60 * 1000 };
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'ztfc-fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'ztfc-fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2026-10-06T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-10-06T00:00:00Z',
};
const OUTPUT_TAIL_LINES = 200;

class StepError extends Error {
  constructor(message, steps) {
    super(message);
    this.steps = steps;
  }
}

function tail(text) {
  return text.split('\n').slice(-OUTPUT_TAIL_LINES).join('\n');
}

function run(argv, cwd, env, timeout) {
  const started = Date.now();
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env: { ...process.env, ...GIT_ENV, ...env },
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error?.code,
    ms: Date.now() - started,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function git(args, cwd, what) {
  const result = run(['git', '-c', 'core.hooksPath=/dev/null', ...args], cwd, {}, 60_000);
  if (result.status !== 0) throw new Error(`git ${what} failed: ${tail(result.output)}`);
  return result.output.trim();
}

function commit(cwd, message) {
  git(['add', '-A'], cwd, 'add');
  git(['commit', '-q', '-m', message], cwd, `commit "${message}"`);
  return git(['rev-parse', 'HEAD'], cwd, 'rev-parse');
}

function hostPython() {
  const python = process.env.ZT_PYTHON ?? 'python3';
  const r = run(
    [python, '-c', 'import sys; print(sys.executable, "%d.%d" % sys.version_info[:2])'],
    root,
    {},
    30_000
  );
  if (r.status !== 0) throw new Error(`cannot run ${python}: ${r.error ?? tail(r.output)}`);
  const [executable, version] = r.output.trim().split(' ');
  return { executable, version };
}

/** The host must run the profile's runtime line, or the check proves the wrong runtime. */
function checkRuntime(profile, python) {
  const host = profile.ecosystem === 'node' ? process.versions.node.split('.')[0] : python.version;
  const wanted =
    profile.ecosystem === 'node'
      ? profile.runtimeVersion.split('.')[0]
      : profile.runtimeVersion.split('.').slice(0, 2).join('.');
  if (host === wanted) return host;
  const message = `expected ${profile.ecosystem} ${wanted} (profile ${profile.id}) but host has ${host}`;
  if (process.env.CI) throw new Error(message);
  console.error(`WARN ${message}`);
  return host;
}

/** Runs a phase's commands; all but the last must pass, the last must match `expectPass`. */
function runStep(ctx, step, sha, commands, expectPass) {
  for (const command of commands) {
    console.error(`[${ctx.name}] ${step}: ${command.argv.join(' ')} (${command.network})`);
    const result = run(command.argv, ctx.work, command.env, command.timeoutMs);
    console.error(
      `[${ctx.name}] ${step}: exit=${result.status} signal=${result.signal} error=${result.error ?? '-'} ${result.ms}ms`
    );
    const last = command === commands.at(-1);
    const passed = result.status === 0;
    ctx.steps.push({
      step,
      sha,
      command: command.argv.join(' '),
      network: command.network,
      exit: result.status,
      signal: result.signal,
      error: result.error ?? null,
      ms: result.ms,
    });
    if ((!last && !passed) || (last && passed !== expectPass))
      throw new StepError(
        `${step}: ${command.id} expected ${last && !expectPass ? 'fail' : 'pass'}, got exit ${result.status} signal ${result.signal} error ${result.error ?? '-'}\n${tail(result.output)}`,
        ctx.steps
      );
  }
}

function check(name, python) {
  const base = join(fixtures, name, 'base');
  const detection = zt.detectEcosystem(zt.sourceFilesFromManifest(zt.exportSource(base)));
  if (!detection.supported)
    throw new Error(
      `detection rejected the fixture: ${detection.reason} ${detection.detail ?? ''}`
    );
  const selection = zt.selectProfile(detection);
  if (!selection.ok) throw new Error(`no profile: ${selection.reason} ${selection.detail ?? ''}`);
  const hostRuntime = checkRuntime(selection.profile, python);
  const ctx = { name, work: mkdtempSync(join(tmpdir(), `ztfc-${name}-`)), steps: [] };
  const env = mkdtempSync(join(tmpdir(), `ztfc-${name}-env-`));
  // Environment and exported requirements live outside the fixture, as in the VM.
  const options = {
    ...TIMEOUTS,
    python: python.executable,
    environmentDir: join(env, 'venv'),
    exportFile: join(env, 'uv-requirements.txt'),
    reportFile: join(env, 'report.xml'),
  };
  try {
    cpSync(base, ctx.work, { recursive: true });
    git(['init', '-q', '-b', 'main'], ctx.work, 'init');
    const shas = { base: commit(ctx.work, 'base') };
    const plan = zt.buildCommandPlan(detection.manager, REGISTRIES, options);
    const regression = zt.buildCommandPlan(detection.manager, REGISTRIES, {
      ...options,
      testTargets: REGRESSION[name],
    });
    runStep(ctx, 'provision', shas.base, plan.provisioning, true);
    runStep(ctx, 'baseline-suite', shas.base, plan.verification, true);
    git(
      ['apply', join(fixtures, name, 'regression.patch')],
      ctx.work,
      `apply ${name}/regression.patch`
    );
    shas.regression = commit(ctx.work, 'test: add regression test');
    runStep(ctx, 'regression-on-base', shas.regression, regression.verification, false);
    git(['apply', join(fixtures, name, 'fix.patch')], ctx.work, `apply ${name}/fix.patch`);
    shas.fix = commit(ctx.work, 'fix: known bug');
    runStep(ctx, 'regression-on-fix', shas.fix, regression.verification, true);
    runStep(ctx, 'suite-on-fix', shas.fix, plan.verification, true);
    return {
      fixture: name,
      profile: selection.profile.id,
      hostRuntime,
      manager: detection.manager,
      shas,
      steps: ctx.steps,
      result: 'pass',
    };
  } finally {
    rmSync(ctx.work, { recursive: true, force: true });
    rmSync(env, { recursive: true, force: true });
  }
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(REGRESSION);
const unknown = names.filter((n) => !(n in REGRESSION));
if (unknown.length) {
  console.error(
    `unknown fixture ${unknown.join(', ')} (known: ${Object.keys(REGRESSION).join(', ')})`
  );
  process.exit(2);
}
const python = hostPython();
let failed = false;
for (const name of names) {
  try {
    console.log(JSON.stringify(check(name, python)));
  } catch (error) {
    failed = true;
    console.error(`FAIL fixture ${name}: ${error.message}`);
    if (error.steps) console.error(`steps so far: ${JSON.stringify(error.steps)}`);
  }
}
process.exit(failed ? 1 : 0);
