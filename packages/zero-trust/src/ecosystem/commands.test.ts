import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCommandPlan, CommandPlanError } from './commands';

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
        env: { npm_config_registry: 'http://npm-proxy:4873/', npm_config_audit: 'false' },
        required: true,
      }),
    ]);
    expect(plan.verification.map((c) => [c.id, c.network, c.argv.join(' ')])).toEqual([
      ['npm-rebuild', 'none', 'npm rebuild'],
      ['npm-test', 'none', 'npm test'],
    ]);
    expect(plan.verification[1].env).toMatchObject({ npm_config_offline: 'true', HTTPS_PROXY: '' });
    expect(Object.isFrozen(plan.verification[0].argv)).toBe(true);
  });

  it('pip: hash-required, binary-only install; pytest offline', () => {
    const plan = buildCommandPlan('pip', proxy, { testTargets: ['tests/test_regression.py'] });
    expect(plan.provisioning.map((c) => c.argv.join(' '))).toEqual([
      'python -m venv .venv',
      '.venv/bin/python -m pip install --require-hashes --no-deps --only-binary=:all: -r requirements.txt',
    ]);
    expect(plan.provisioning[1].env.PIP_INDEX_URL).toBe('http://pypi-proxy:5000/index/');
    expect(plan.verification[0]).toMatchObject({
      network: 'none',
      argv: ['.venv/bin/python', '-m', 'pytest', 'tests/test_regression.py'],
      env: { PIP_NO_INDEX: '1' },
    });
  });

  it('uv: frozen sync without builds; offline, no-sync test run', () => {
    const plan = buildCommandPlan('uv', proxy, {
      provisioningTimeoutMs: 60_000,
      verificationTimeoutMs: 120_000,
    });
    expect(plan.provisioning[0]).toMatchObject({
      argv: ['uv', 'sync', '--frozen', '--no-build'],
      env: { UV_DEFAULT_INDEX: 'http://pypi-proxy:5000/index/', UV_NO_BUILD: '1' },
      timeoutMs: 60_000,
    });
    expect(plan.verification[0]).toMatchObject({
      argv: ['uv', 'run', '--frozen', '--offline', '--no-sync', 'pytest'],
      env: { UV_OFFLINE: '1' },
      timeoutMs: 120_000,
    });
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
      expect.objectContaining({ code: 'invalid_endpoint' })
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
      expect.objectContaining({ code: 'invalid_timeout' })
    );
  });
});

describe('no product path executes installs or tests on the host', () => {
  it('src/ecosystem imports no process, network or dynamic-code API', () => {
    const dir = __dirname;
    const sources = fs
      .readdirSync(dir)
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
