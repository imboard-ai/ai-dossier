import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCommandPlan, CommandPlanError, REPORT_PATH } from './commands';

const proxy = { npmRegistry: 'http://npm-proxy:4873/', pypiIndex: 'http://pypi-proxy:5000/index/' };

describe('buildCommandPlan', () => {
  it('npm: provisions through the proxy without lifecycle scripts, runs scripts offline', () => {
    const plan = buildCommandPlan('npm', proxy);
    expect(plan.provisioning).toEqual([
      expect.objectContaining({
        id: 'npm-ci',
        phase: 'provisioning',
        network: 'package_proxy',
        argv: ['npm', 'ci', '--ignore-scripts', '--no-fund'],
        env: {
          npm_config_registry: 'http://npm-proxy:4873/',
          npm_config_audit: 'false',
          npm_config_update_notifier: 'false',
        },
        required: true,
        captureReport: false,
      }),
    ]);
    expect(plan.verification.map((c) => [c.id, c.network, c.argv.join(' ')])).toEqual([
      ['npm-rebuild', 'none', 'npm rebuild'],
      ['npm-test', 'none', 'npm test'],
    ]);
    expect(plan.verification[1].env).toMatchObject({ npm_config_offline: 'true', HTTPS_PROXY: '' });
    // The test command writes junit to the supervisor's report path; rebuild has no report.
    expect(plan.verification.map((c) => c.captureReport)).toEqual([false, true]);
    expect(plan.verification[1].env.NODE_OPTIONS).toContain(
      `--test-reporter=junit --test-reporter-destination=${REPORT_PATH}`
    );
    expect(Object.isFrozen(plan.verification[0].argv)).toBe(true);
  });

  it('pip: isolated interpreter, venv outside the repository, hash-required binary-only install', () => {
    const plan = buildCommandPlan('pip', proxy, { testTargets: ['tests/test_regression.py'] });
    expect(plan.provisioning.map((c) => c.argv.join(' '))).toEqual([
      '/usr/local/bin/python -I -m venv --clear /opt/ztfc/env',
      '/opt/ztfc/env/bin/python -I -m pip install --require-hashes --no-deps --only-binary=:all: -r requirements.txt',
    ]);
    expect(plan.provisioning[1].env).toMatchObject({
      PIP_INDEX_URL: 'http://pypi-proxy:5000/index/',
      PIP_CONFIG_FILE: '/dev/null',
      // pip ignores a plain-HTTP index unless its host is trusted.
      PIP_TRUSTED_HOST: 'pypi-proxy',
    });
    expect(plan.verification[0]).toMatchObject({
      network: 'none',
      argv: ['/opt/ztfc/env/bin/python', '-m', 'pytest', 'tests/test_regression.py'],
      env: { PIP_NO_INDEX: '1', PYTEST_ADDOPTS: `--junitxml=${REPORT_PATH}` },
      captureReport: true,
    });
  });

  it('pip: an HTTPS index needs no trusted host', () => {
    const plan = buildCommandPlan('pip', { ...proxy, pypiIndex: 'https://pypi.org/simple/' });
    expect(plan.provisioning[1].env.PIP_TRUSTED_HOST).toBeUndefined();
  });

  it('uv: ignores repository config, never downloads Python, environment outside the repository', () => {
    const plan = buildCommandPlan('uv', proxy, {
      provisioningTimeoutMs: 60_000,
      verificationTimeoutMs: 120_000,
      python: '/usr/bin/python3.12',
      environmentDir: '/work/env',
    });
    const common = [
      '--frozen',
      '--no-config',
      '--no-python-downloads',
      '--python',
      '/usr/bin/python3.12',
    ];
    // Not `uv sync --frozen`: it fetches the lockfile's file URLs directly and would
    // bypass the mirror. The lock is exported offline and installed from the mirror.
    expect(plan.provisioning.map((c) => c.argv.join(' '))).toEqual([
      'uv export --frozen --offline --no-config --no-python-downloads --format requirements.txt --no-emit-project --no-header --output-file /opt/ztfc/uv-requirements.txt',
      'uv venv --no-config --no-python-downloads --python /usr/bin/python3.12 /work/env',
      'uv pip install --no-config --no-python-downloads --python /work/env/bin/python --require-hashes --no-deps --only-binary :all: --index-url http://pypi-proxy:5000/index/ -r /opt/ztfc/uv-requirements.txt',
    ]);
    expect(plan.provisioning.every((c) => c.argv[1] !== 'sync')).toBe(true);
    expect(plan.provisioning[2]).toMatchObject({
      network: 'package_proxy',
      env: {
        UV_DEFAULT_INDEX: 'http://pypi-proxy:5000/index/',
        UV_NO_BUILD: '1',
        UV_PROJECT_ENVIRONMENT: '/work/env',
      },
      timeoutMs: 60_000,
    });
    expect(plan.verification[0]).toMatchObject({
      argv: ['uv', 'run', ...common, '--offline', '--no-sync', 'pytest'],
      env: {
        UV_OFFLINE: '1',
        UV_PROJECT_ENVIRONMENT: '/work/env',
        PYTEST_ADDOPTS: `--junitxml=${REPORT_PATH}`,
      },
      timeoutMs: 120_000,
      captureReport: true,
    });
  });

  it('uv: the export file is controller-chosen and validated', () => {
    const plan = buildCommandPlan('uv', proxy, { exportFile: '/work/reqs.txt' });
    expect(plan.provisioning[0].argv.at(-1)).toBe('/work/reqs.txt');
    expect(plan.provisioning[2].argv.at(-1)).toBe('/work/reqs.txt');
    expect(() => buildCommandPlan('uv', proxy, { exportFile: 'reqs.txt' })).toThrow(
      'invalid_path (exportFile)'
    );
  });

  it('npm: passes test targets after the script separator', () => {
    const plan = buildCommandPlan('npm', proxy, { testTargets: ['test/regression.test.js'] });
    expect(plan.verification[1].argv).toEqual(['npm', 'test', '--', 'test/regression.test.js']);
  });

  it.each([
    ['non-URL endpoint', { ...proxy, npmRegistry: 'npm-proxy' }],
    ['file scheme', { ...proxy, npmRegistry: 'file:///etc/' }],
    ['credentials in endpoint', { ...proxy, pypiIndex: 'http://u:p@pypi-proxy:5000/index/' }],
    ['query string', { ...proxy, pypiIndex: 'http://pypi-proxy:5000/index/?x=1' }],
    ['missing trailing slash', { ...proxy, pypiIndex: 'http://pypi-proxy:5000/index' }],
  ])('rejects a %s', (_name, endpoints) => {
    expect(() => buildCommandPlan('npm', endpoints)).toThrow(
      expect.objectContaining({ code: 'invalid_endpoint', field: expect.any(String) })
    );
    expect(() => buildCommandPlan('pip', endpoints)).toThrow(CommandPlanError);
  });

  it.each([
    ['../etc/passwd'],
    ['/abs.py'],
    ['-p'],
    ['tests/x.py::test_a'],
    ['--collect-only'],
  ])('rejects test target %s', (target) => {
    expect(() => buildCommandPlan('uv', proxy, { testTargets: [target] })).toThrow(
      expect.objectContaining({ code: 'invalid_target' })
    );
  });

  it.each([
    [0],
    [500],
    [Number.POSITIVE_INFINITY],
    [3 * 60 * 60 * 1000],
  ])('rejects timeout %s', (ms) => {
    expect(() => buildCommandPlan('npm', proxy, { verificationTimeoutMs: ms })).toThrow(
      expect.objectContaining({ code: 'invalid_timeout', field: 'verificationTimeoutMs' })
    );
  });

  it.each([['relative'], ['/opt/../etc'], ['/opt/ztfc env'], ['']])('rejects path %j', (dir) => {
    expect(() => buildCommandPlan('pip', proxy, { environmentDir: dir })).toThrow(
      expect.objectContaining({ code: 'invalid_path', field: 'environmentDir' })
    );
    expect(() => buildCommandPlan('uv', proxy, { python: dir })).toThrow(
      expect.objectContaining({ code: 'invalid_path', field: 'python' })
    );
  });
});

describe('no product path executes installs or tests on the host', () => {
  it('src/ecosystem imports no process, network or dynamic-code API', () => {
    const dir = __dirname;
    const sources = fs
      .readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
    expect(sources.length).toBeGreaterThanOrEqual(5);
    for (const source of sources) {
      expect(source).not.toMatch(
        /node:child_process|['"]child_process['"]|node:net|node:http|node:https|node:dgram|node:vm|node:worker_threads|\beval\(|new Function\(/
      );
    }
  });
});

/** Security review HIGH #1, with the attacking input: a repository that ships its own
 * `venv.py`, `pip.py` and `.venv` must not get them executed while provisioning has
 * network access. Runs our own sentinel files with the host Python (a test control,
 * not a product path); skipped where no Python 3 is installed. */
describe.skipIf(!fs.existsSync('/usr/bin/python3'))(
  'provisioning ignores repository Python code',
  () => {
    const python = '/usr/bin/python3';
    const sentinelCode = (name: string) =>
      `import pathlib; pathlib.Path(${JSON.stringify(name)}).write_text("ran")\n`;

    it('a committed venv.py / pip.py / .venv runs under plain `-m`, but not under the plan', () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-hostile-repo-'));
      const env = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-env-'));
      try {
        fs.writeFileSync(path.join(repo, 'venv.py'), sentinelCode('venv-sentinel'));
        fs.writeFileSync(path.join(repo, 'pip.py'), sentinelCode('pip-sentinel'));
        fs.mkdirSync(path.join(repo, '.venv', 'bin'), { recursive: true });
        fs.writeFileSync(
          path.join(repo, '.venv', 'bin', 'python'),
          '#!/bin/sh\ntouch venv-bin-sentinel\n',
          { mode: 0o755 }
        );

        // Positive control: the attack works against the naive `python -m venv .venv`.
        spawnSync(python, ['-m', 'venv', '.venv'], { cwd: repo });
        expect(fs.existsSync(path.join(repo, 'venv-sentinel'))).toBe(true);
        fs.rmSync(path.join(repo, 'venv-sentinel'));

        const plan = buildCommandPlan('pip', proxy, { python, environmentDir: env });
        const [venv, install] = plan.provisioning;
        const created = spawnSync(venv.argv[0], venv.argv.slice(1), {
          cwd: repo,
          encoding: 'utf8',
        });
        expect(created.status).toBe(0);
        // Same interpreter flags as the install step, but only ask pip for its version.
        const pip = spawnSync(install.argv[0], [...install.argv.slice(1, 4), '--version'], {
          cwd: repo,
          encoding: 'utf8',
        });
        expect(pip.status).toBe(0);
        expect(pip.stdout).toContain(env);
        for (const sentinel of ['venv-sentinel', 'pip-sentinel', 'venv-bin-sentinel'])
          expect(fs.existsSync(path.join(repo, sentinel))).toBe(false);
        expect(install.argv[0].startsWith(repo)).toBe(false);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
        fs.rmSync(env, { recursive: true, force: true });
      }
    }, 60_000);
  }
);
