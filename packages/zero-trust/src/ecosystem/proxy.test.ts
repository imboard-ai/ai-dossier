import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildLockIndex,
  checkArtifact,
  evaluateRedirect,
  evaluateRequest,
  LockIndexError,
  PROXY_POLICY,
  ProxyConfigError,
  type ProxyDeployment,
  proxpiEnvironment,
  renderSquidConfig,
  renderVerdaccioConfig,
  verdaccioEnvironment,
} from './proxy';

const FIXTURES = path.join(__dirname, '../../fixtures/ecosystem');
const fixture = (name: string, file: string) =>
  fs.readFileSync(path.join(FIXTURES, name, 'base', file), 'utf8');
const NPM = 'https://registry.npmjs.org';
const FILES = `https://files.pythonhosted.org/packages/aa/bb/${'c'.repeat(60)}`;
const get = (url: string) => evaluateRequest({ method: 'GET', url });

describe('evaluateRequest', () => {
  it.each([
    [`${NPM}/ms`, 'npm'],
    [`${NPM}/@types%2fnode`, 'npm'],
    [`${NPM}/@types/node`, 'npm'],
    [`${NPM}/ms/-/ms-2.1.3.tgz`, 'npm'],
    [`${NPM}/@types/node/-/node-22.1.0.tgz`, 'npm'],
    ['https://pypi.org/simple/pytest/', 'pypi-index'],
    [`${FILES}/pytest-8.4.2-py3-none-any.whl`, 'pypi-files'],
    [`${FILES}/pytest-8.4.2-py3-none-any.whl.metadata`, 'pypi-files'],
    [`${FILES}/iniconfig-2.3.0.tar.gz`, 'pypi-files'],
  ])('admits package request %s', (url, rule) => {
    expect(get(url)).toEqual({ allowed: true, rule });
    expect(evaluateRequest({ method: 'HEAD', url, bodyBytes: 0 }).allowed).toBe(true);
  });

  // Rejection case 1: a non-package request to an allowlisted host.
  it.each([
    [`${NPM}/-/v1/search`, 'path_not_allowed'],
    [`${NPM}/-/whoami`, 'path_not_allowed'],
    [`${NPM}/-/user/org.couchdb.user:alice`, 'path_not_allowed'],
    [`${NPM}/-/npm/v1/security/advisories/bulk`, 'path_not_allowed'],
    [`${NPM}/ms/-/../../-/whoami`, 'path_not_allowed'],
    [`${NPM}/ms?write=true`, 'query_not_allowed'],
    ['https://pypi.org/simple/', 'path_not_allowed'],
    ['https://pypi.org/pypi/pytest/json', 'path_not_allowed'],
    ['https://pypi.org/legacy/', 'path_not_allowed'],
    ['https://pypi.org/account/login/', 'path_not_allowed'],
    ['https://files.pythonhosted.org/packages/x/evil.sh', 'path_not_allowed'],
  ])('rejects non-package request %s', (url, reason) => {
    expect(get(url)).toEqual({ allowed: false, reason });
  });

  it.each([
    [{ method: 'PUT', url: `${NPM}/ms` }, 'method_not_allowed'],
    [{ method: 'POST', url: 'https://pypi.org/simple/pytest/' }, 'method_not_allowed'],
    [{ method: 'DELETE', url: `${NPM}/ms/-/ms-2.1.3.tgz` }, 'method_not_allowed'],
    [{ method: 'CONNECT', url: `${NPM}/ms` }, 'method_not_allowed'],
    [{ method: 'GET', url: `${NPM}/ms`, bodyBytes: 10 }, 'request_body_not_allowed'],
    [{ method: 'GET', url: 'http://registry.npmjs.org/ms' }, 'scheme_not_allowed'],
    [{ method: 'GET', url: 'https://user:token@registry.npmjs.org/ms' }, 'credentials_in_url'],
    [{ method: 'GET', url: 'https://registry.npmjs.org:8443/ms' }, 'port_not_allowed'],
    [{ method: 'GET', url: 'https://registry.npmjs.org.evil.example/ms' }, 'host_not_allowed'],
    [{ method: 'GET', url: 'https://169.254.169.254/latest/meta-data/' }, 'host_not_allowed'],
    [{ method: 'GET', url: 'https://github.com/a/b' }, 'host_not_allowed'],
    [{ method: 'GET', url: 'not a url' }, 'invalid_url'],
  ])('rejects %j', (request, reason) => {
    expect(evaluateRequest(request)).toEqual({ allowed: false, reason });
  });
});

describe('evaluateRedirect', () => {
  const from = 'https://pypi.org/simple/pytest/';
  it('follows a redirect to another package path on an allowlisted registry', () => {
    expect(evaluateRedirect(from, `${FILES}/pytest-8.4.2-py3-none-any.whl`, 0)).toEqual({
      allowed: true,
      rule: 'pypi-files',
    });
    expect(evaluateRedirect(`${NPM}/MS`, '/ms', 1)).toEqual({ allowed: true, rule: 'npm' });
  });

  // Rejection case 2: a redirect off the registry.
  it.each([
    ['https://evil.example/pytest.whl', 'redirect_off_registry'],
    ['http://pypi.org/simple/pytest/', 'redirect_off_registry'],
    ['https://pypi.org:444/simple/pytest/', 'redirect_off_registry'],
    ['//169.254.169.254/latest/meta-data/', 'redirect_off_registry'],
    ['https://registry.npmjs.org/-/whoami', 'path_not_allowed'],
    ['https://u:p@pypi.org/simple/pytest/', 'credentials_in_url'],
    ['', 'redirect_missing_location'],
    [undefined, 'redirect_missing_location'],
    ['http://[::1', 'invalid_url'],
  ])('rejects redirect to %s', (location, reason) => {
    expect(evaluateRedirect(from, location, 0)).toEqual({ allowed: false, reason });
  });

  it('enforces the hop limit', () => {
    expect(evaluateRedirect(from, from, PROXY_POLICY.maxRedirects)).toEqual({
      allowed: false,
      reason: 'redirect_limit',
    });
  });
});

describe('lockfile hash enforcement', () => {
  const bytes = Buffer.from('artifact bytes');
  const sri = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  it('npm: accepts the locked bytes and rejects a hash mismatch', () => {
    const url = `${NPM}/ms/-/ms-2.1.3.tgz`;
    const index = buildLockIndex(
      'npm',
      JSON.stringify({
        lockfileVersion: 3,
        packages: { '': {}, 'node_modules/ms': { resolved: url, integrity: sri } },
      })
    );
    expect(checkArtifact(index, url, bytes)).toEqual({ allowed: true, rule: 'npm' });
    // Rejection case 3: lockfile hash mismatch.
    expect(checkArtifact(index, url, Buffer.from('tampered'))).toEqual({
      allowed: false,
      reason: 'hash_mismatch',
    });
    expect(checkArtifact(index, `${NPM}/other/-/other-1.0.0.tgz`, bytes)).toEqual({
      allowed: false,
      reason: 'artifact_not_in_lockfile',
    });
  });

  it('pip: matches any locked hash for the wheel name and version', () => {
    const index = buildLockIndex(
      'pip',
      `my_pkg==1.0 --hash=sha256:${'0'.repeat(64)} --hash=sha256:${sha256}\n`
    );
    expect(checkArtifact(index, `${FILES}/my_pkg-1.0-py3-none-any.whl`, bytes).allowed).toBe(true);
    expect(checkArtifact(index, `${FILES}/My.Pkg-1.0.tar.gz`, bytes).allowed).toBe(true);
    expect(checkArtifact(index, `${FILES}/my_pkg-1.0-py3-none-any.whl`, Buffer.from('x'))).toEqual({
      allowed: false,
      reason: 'hash_mismatch',
    });
    expect(checkArtifact(index, `${FILES}/my_pkg-2.0-py3-none-any.whl`, bytes)).toEqual({
      allowed: false,
      reason: 'artifact_not_in_lockfile',
    });
    expect(checkArtifact(index, `${FILES}/README`, bytes).allowed).toBe(false);
  });

  it('builds indexes from the real fixture lockfiles', () => {
    const npm = buildLockIndex('npm', fixture('npm', 'package-lock.json'));
    expect([...npm.artifacts.keys()]).toEqual([`${NPM}/ms/-/ms-2.1.3.tgz`]);
    expect(
      buildLockIndex('pip', fixture('pip', 'requirements.txt')).artifacts.has('pytest==8.4.2')
    ).toBe(true);
    const uv = buildLockIndex('uv', fixture('uv', 'uv.lock'));
    const wheel = [...uv.artifacts.keys()].find((u) => u.includes('/pytest-8.4.2-'));
    expect(wheel).toBeDefined();
    expect(checkArtifact(uv, wheel as string, Buffer.from('not the wheel'))).toEqual({
      allowed: false,
      reason: 'hash_mismatch',
    });
  });

  it.each([
    ['npm', 'nope'],
    ['npm', JSON.stringify({ packages: { '': {} } })],
    ['npm', JSON.stringify({ packages: { a: { resolved: 'x', integrity: 'sha1-x' } } })],
    ['uv', 'version = 1\n[[package]]\nname = "x"\nwheels = [{ url = 1 }]\n'],
    ['pip', 'pytest>=8\n'],
  ] as const)('rejects an unusable %s lockfile', (manager, text) => {
    expect(() => buildLockIndex(manager, text)).toThrow(LockIndexError);
  });
});

describe('config rendering', () => {
  const deployment: ProxyDeployment = {
    squidHost: 'egress-proxy',
    squidPort: 3128,
    squidCaCertPath: '/etc/squid/ca.pem',
    squidCaKeyPath: '/etc/squid/ca.key',
    verdaccioPort: 4873,
    verdaccioStorage: '/verdaccio/storage',
    proxpiPort: 5000,
    proxpiCacheDir: '/var/cache/proxpi',
    mirrorCidrs: ['10.20.0.0/29'],
  };

  it('renders Squid ACLs from the same policy patterns the evaluator uses', () => {
    const conf = renderSquidConfig(deployment);
    for (const rule of PROXY_POLICY.rules) {
      expect(conf).toContain(`dstdomain ${rule.host}`);
      for (const p of rule.paths) expect(conf).toContain(p);
    }
    expect(conf).toContain('acl package_methods method GET HEAD');
    expect(conf).toContain('http_access deny forbidden_dst');
    expect(conf).toContain('169.254.0.0/16');
    expect(conf).toContain('http_access allow CONNECT mirrors tls_port registry_hosts');
    expect(conf).toContain('http_reply_access deny redirect_status !registry_location');
    expect(conf.trim().split('\n').indexOf('http_access deny all')).toBeGreaterThan(
      conf
        .trim()
        .split('\n')
        .findIndex((l) => l.startsWith('http_access allow mirrors'))
    );
  });

  it('renders a read-only Verdaccio mirror and a non-redirecting proxpi', () => {
    const yaml = renderVerdaccioConfig(deployment);
    expect(yaml).toContain('publish: $nobody');
    expect(yaml).toContain('https_proxy: "http://egress-proxy:3128"');
    expect(yaml).toContain('enable: false');
    expect(verdaccioEnvironment(deployment)).toEqual({ NODE_EXTRA_CA_CERTS: '/etc/squid/ca.pem' });
    expect(proxpiEnvironment(deployment)).toMatchObject({
      PROXPI_INDEX_URL: 'https://pypi.org/simple/',
      PROXPI_EXTRA_INDEX_URLS: '',
      PROXPI_DOWNLOAD_TIMEOUT: '600',
      HTTPS_PROXY: 'http://egress-proxy:3128',
    });
  });

  it.each([
    ['host injection', { squidHost: 'proxy\nhttp_access allow all' }],
    ['relative path', { verdaccioStorage: 'storage' }],
    ['path traversal', { proxpiCacheDir: '/var/../etc' }],
    ['bad port', { squidPort: 70000 }],
    ['no mirror range', { mirrorCidrs: [] }],
    ['bad mirror range', { mirrorCidrs: ['all'] }],
  ])('rejects %s', (_name, override) => {
    const bad = { ...deployment, ...override } as ProxyDeployment;
    expect(() => renderSquidConfig(bad)).toThrow(ProxyConfigError);
    expect(() => renderVerdaccioConfig(bad)).toThrow(ProxyConfigError);
    expect(() => proxpiEnvironment(bad)).toThrow(ProxyConfigError);
    expect(() => verdaccioEnvironment(bad)).toThrow(ProxyConfigError);
  });

  it('refuses a policy pattern Squid would split', () => {
    const policy = {
      ...PROXY_POLICY,
      rules: [{ name: 'npm' as const, host: 'registry.npmjs.org', paths: ['^/a b$'] }],
    };
    expect(() => renderSquidConfig(deployment, policy)).toThrow(ProxyConfigError);
  });
});
