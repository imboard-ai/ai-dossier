/** Package-proxy policy as typed data, a reference evaluator, and config rendering for
 * the OSS components that enforce it: Verdaccio (npm) and proxpi (PyPI) as caching
 * mirrors whose only upstream route is an enforcing Squid forward proxy. Nothing here
 * opens a socket; the evaluator is the policy's executable specification. */
import { createHash } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { assertNoSecrets } from '../redaction';
import { normalizeName, type PackageManager, parseHashedRequirements } from './detect';

export interface RegistryRule {
  readonly name: 'npm' | 'pypi-index' | 'pypi-files';
  readonly host: string;
  /** POSIX-ERE-compatible patterns (also valid JS): the same text drives the evaluator
   * and Squid's `urlpath_regex`, so they cannot drift. */
  readonly paths: readonly string[];
}
export interface ProxyPolicy {
  readonly version: 'ztfc-proxy-policy-v1';
  readonly methods: readonly ('GET' | 'HEAD')[];
  readonly rules: readonly RegistryRule[];
  readonly maxRedirects: number;
  readonly maxResponseBytes: number;
}

const NAME = '[A-Za-z0-9][A-Za-z0-9._~-]*';
const SCOPE = `@${NAME}`;
const PYPI_NAME = '[A-Za-z0-9][A-Za-z0-9._-]*';

export const PROXY_POLICY: ProxyPolicy = Object.freeze({
  version: 'ztfc-proxy-policy-v1',
  methods: Object.freeze(['GET', 'HEAD'] as const),
  rules: Object.freeze([
    Object.freeze({
      name: 'npm',
      host: 'registry.npmjs.org',
      paths: Object.freeze([
        // Package document: /name, /@scope%2fname, /@scope/name
        `^/(${SCOPE}(%2[fF]|/))?${NAME}$`,
        // Tarball: /name/-/name-1.2.3.tgz, /@scope/name/-/name-1.2.3.tgz
        `^/(${SCOPE}/)?${NAME}/-/${NAME}-[0-9][A-Za-z0-9.+-]*\\.tgz$`,
      ]),
    }),
    Object.freeze({
      name: 'pypi-index',
      host: 'pypi.org',
      paths: Object.freeze([`^/simple/${PYPI_NAME}/$`]),
    }),
    Object.freeze({
      name: 'pypi-files',
      host: 'files.pythonhosted.org',
      paths: Object.freeze([
        '^/packages/[a-f0-9]{2}/[a-f0-9]{2}/[a-f0-9]{60}/[A-Za-z0-9._+-]+\\.(whl|tar\\.gz|zip)(\\.metadata)?$',
      ]),
    }),
  ]),
  maxRedirects: 3,
  maxResponseBytes: 256 * 1024 * 1024,
});

export type RequestDenial =
  | 'invalid_url'
  | 'scheme_not_allowed'
  | 'credentials_in_url'
  | 'port_not_allowed'
  | 'host_not_allowed'
  | 'method_not_allowed'
  | 'request_body_not_allowed'
  | 'query_not_allowed'
  | 'path_not_allowed';
export type RedirectDenial =
  | RequestDenial
  | 'redirect_limit'
  | 'redirect_off_registry'
  | 'redirect_missing_location';
export type Decision<R> =
  | { readonly allowed: true; readonly rule: RegistryRule['name'] }
  | { readonly allowed: false; readonly reason: R };

export interface ProxyRequest {
  readonly method: string;
  readonly url: string;
  readonly bodyBytes?: number;
}

function deny<R>(reason: R): Decision<R> {
  return Object.freeze({ allowed: false, reason });
}

function urlDecision(policy: ProxyPolicy, url: string): Decision<RequestDenial> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return deny('invalid_url');
  }
  if (parsed.protocol !== 'https:') return deny('scheme_not_allowed');
  if (parsed.username !== '' || parsed.password !== '') return deny('credentials_in_url');
  if (parsed.port !== '') return deny('port_not_allowed');
  const rule = policy.rules.find((r) => r.host === parsed.hostname);
  if (rule === undefined) return deny('host_not_allowed');
  if (parsed.search !== '' || parsed.hash !== '') return deny('query_not_allowed');
  if (!rule.paths.some((p) => new RegExp(p).test(parsed.pathname))) return deny('path_not_allowed');
  return Object.freeze({ allowed: true, rule: rule.name });
}

/** A request is admitted only as a body-less GET/HEAD of a package document or
 * artifact path on an allowlisted registry host. Allowlisting a host is not enough. */
export function evaluateRequest(
  request: ProxyRequest,
  policy: ProxyPolicy = PROXY_POLICY
): Decision<RequestDenial> {
  if (!(policy.methods as readonly string[]).includes(request.method))
    return deny('method_not_allowed');
  if ((request.bodyBytes ?? 0) !== 0) return deny('request_body_not_allowed');
  return urlDecision(policy, request.url);
}

/** A redirect is followed only to a location that would itself be admitted as a
 * request (same rules, resolved against the original URL), within the hop limit. */
export function evaluateRedirect(
  fromUrl: string,
  location: string | undefined,
  hop: number,
  policy: ProxyPolicy = PROXY_POLICY
): Decision<RedirectDenial> {
  if (hop >= policy.maxRedirects) return deny('redirect_limit');
  if (location === undefined || location.trim() === '') return deny('redirect_missing_location');
  let target: string;
  try {
    target = new URL(location, fromUrl).href;
  } catch {
    return deny('invalid_url');
  }
  const decision = urlDecision(policy, target);
  if (decision.allowed) return decision;
  return decision.reason === 'host_not_allowed' ||
    decision.reason === 'scheme_not_allowed' ||
    decision.reason === 'port_not_allowed'
    ? deny('redirect_off_registry')
    : decision;
}

/** Expected artifact digests taken from the lockfile, never from the registry. */
export interface LockIndex {
  readonly manager: PackageManager;
  /** Keyed by artifact URL (npm, uv) or `name==version` (pip, whose file name is not locked). */
  readonly artifacts: ReadonlyMap<string, readonly ExpectedDigest[]>;
}
export interface ExpectedDigest {
  readonly algorithm: 'sha256' | 'sha512';
  readonly hex: string;
}
export type ArtifactDenial = 'artifact_not_in_lockfile' | 'hash_mismatch';

export class LockIndexError extends Error {
  constructor() {
    super('Zero-trust lock index rejected');
    this.name = 'LockIndexError';
  }
}

function sriToHex(integrity: string): ExpectedDigest {
  const m = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  if (!m) throw new LockIndexError();
  return { algorithm: 'sha512', hex: Buffer.from(m[1], 'base64').toString('hex') };
}

/** Builds the expected-digest index from a lockfile that detection already accepted. */
export function buildLockIndex(manager: PackageManager, lockText: string): LockIndex {
  const artifacts = new Map<string, ExpectedDigest[]>();
  try {
    if (manager === 'npm') {
      const lock = JSON.parse(lockText) as {
        packages: Record<string, { resolved?: string; integrity?: string }>;
      };
      for (const [key, entry] of Object.entries(lock.packages)) {
        if (key === '' || entry.resolved === undefined || entry.integrity === undefined) continue;
        artifacts.set(entry.resolved, [sriToHex(entry.integrity)]);
      }
    } else if (manager === 'uv') {
      const lock = parseToml(lockText) as {
        package: {
          sdist?: { url?: string; hash?: string };
          wheels?: { url?: string; hash?: string }[];
        }[];
      };
      for (const pkg of lock.package) {
        for (const a of [...(pkg.sdist ? [pkg.sdist] : []), ...(pkg.wheels ?? [])]) {
          if (typeof a.url !== 'string' || typeof a.hash !== 'string') throw new LockIndexError();
          artifacts.set(a.url, [{ algorithm: 'sha256', hex: a.hash.replace(/^sha256:/, '') }]);
        }
      }
    } else {
      const parsed = parseHashedRequirements(lockText);
      if (!Array.isArray(parsed)) throw new LockIndexError();
      for (const r of parsed)
        artifacts.set(
          `${r.name}==${r.version}`,
          r.hashes.map((hex) => ({ algorithm: 'sha256' as const, hex }))
        );
    }
  } catch {
    throw new LockIndexError();
  }
  if (artifacts.size === 0) throw new LockIndexError();
  return Object.freeze({ manager, artifacts });
}

/** Locates a pip artifact by the name/version in its wheel or sdist file name. */
function pipKey(url: string): string | undefined {
  const file = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  const m = /^([A-Za-z0-9._]+)-([0-9][A-Za-z0-9.+!]*)(-.+\.whl|\.tar\.gz|\.zip)$/.exec(file);
  return m ? `${normalizeName(m[1])}==${m[2]}` : undefined;
}

/** Checks served bytes against the lockfile: the proxy cache keeps an artifact only
 * when its content digest matches what the lockfile pinned for that artifact. */
export function checkArtifact(
  index: LockIndex,
  url: string,
  bytes: Buffer
): Decision<ArtifactDenial> {
  const key = index.manager === 'pip' ? pipKey(url) : url;
  const expected = key === undefined ? undefined : index.artifacts.get(key);
  if (expected === undefined) return deny('artifact_not_in_lockfile');
  const digests = new Map<string, string>();
  const ok = expected.some((e) => {
    if (!digests.has(e.algorithm))
      digests.set(e.algorithm, createHash(e.algorithm).update(bytes).digest('hex'));
    return digests.get(e.algorithm) === e.hex;
  });
  return ok
    ? Object.freeze({ allowed: true, rule: index.manager === 'npm' ? 'npm' : 'pypi-files' })
    : deny('hash_mismatch');
}

export class ProxyConfigError extends Error {
  constructor() {
    super('Zero-trust proxy configuration rejected');
    this.name = 'ProxyConfigError';
  }
}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const ABS_PATH = /^\/[A-Za-z0-9._/-]{0,255}$/;

export interface ProxyDeployment {
  /** Squid's address on the isolated service network (host name of the container). */
  readonly squidHost: string;
  readonly squidPort: number;
  /** Controller CA used by Squid to inspect mirror uplink TLS. Mirrors trust it; workers never do. */
  readonly squidCaCertPath: string;
  readonly squidCaKeyPath: string;
  readonly verdaccioPort: number;
  readonly verdaccioStorage: string;
  readonly proxpiPort: number;
  readonly proxpiCacheDir: string;
  /** Source addresses of the mirror containers; only they may use Squid. */
  readonly mirrorCidrs: readonly string[];
}

function checkDeployment(d: ProxyDeployment): void {
  const ports = [d.squidPort, d.verdaccioPort, d.proxpiPort];
  if (
    !HOSTNAME.test(d.squidHost) ||
    !ports.every((p) => Number.isInteger(p) && p > 0 && p < 65536) ||
    ![d.squidCaCertPath, d.squidCaKeyPath, d.verdaccioStorage, d.proxpiCacheDir].every(
      (p) => ABS_PATH.test(p) && !p.split('/').includes('..')
    ) ||
    d.mirrorCidrs.length === 0 ||
    !d.mirrorCidrs.every((c) => /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(c))
  )
    throw new ProxyConfigError();
}

/** Destination ranges Squid must never connect to, checked AFTER its own DNS
 * resolution so a registry name cannot be rebound to an internal address. */
const FORBIDDEN_DESTINATIONS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::1',
  'fc00::/7',
  'fe80::/10',
];

function squidRegex(pattern: string): string {
  // Squid reads each ACL value as a whitespace-separated token.
  if (/\s/.test(pattern)) throw new ProxyConfigError();
  return pattern;
}

/** Squid configuration enforcing the policy on the mirrors' upstream traffic. */
export function renderSquidConfig(d: ProxyDeployment, policy: ProxyPolicy = PROXY_POLICY): string {
  checkDeployment(d);
  const lines = [
    `# Generated from ${policy.version}. Do not edit; regenerate from the policy.`,
    `http_port ${d.squidPort} ssl-bump tls-cert=${d.squidCaCertPath} tls-key=${d.squidCaKeyPath} generate-host-certificates=on`,
    `acl mirrors src ${d.mirrorCidrs.join(' ')}`,
    `acl forbidden_dst dst ${FORBIDDEN_DESTINATIONS.join(' ')}`,
    'acl ip_literal dstdom_regex ^[0-9.]+$ ^\\[',
    'acl tls_port port 443',
    'acl CONNECT method CONNECT',
    `acl package_methods method ${policy.methods.join(' ')}`,
    'acl redirect_status http_status 300-399',
  ];
  const allowed: string[] = [];
  for (const rule of policy.rules) {
    const id = rule.name.replace(/-/g, '_');
    lines.push(`acl host_${id} dstdomain ${rule.host}`);
    lines.push(`acl path_${id} urlpath_regex ${rule.paths.map(squidRegex).join(' ')}`);
    allowed.push(`http_access allow mirrors package_methods host_${id} path_${id}`);
  }
  const hosts = policy.rules.map((r) => r.host.replace(/\./g, '\\.')).join('|');
  lines.push(`acl registry_hosts dstdomain ${policy.rules.map((r) => r.host).join(' ')}`);
  lines.push(`acl registry_location rep_header Location ^https://(${hosts})/`);
  lines.push(
    'ssl_bump bump all',
    'http_access deny !mirrors',
    'http_access deny forbidden_dst',
    'http_access deny ip_literal',
    'http_access allow CONNECT mirrors tls_port registry_hosts',
    'http_access deny CONNECT',
    ...allowed,
    'http_access deny all',
    'http_reply_access deny redirect_status !registry_location',
    'request_body_max_size 0 KB',
    `reply_body_max_size ${Math.floor(policy.maxResponseBytes / 1024)} KB`,
    'forwarded_for delete',
    'via off',
    'cache deny all'
  );
  const text = `${lines.join('\n')}\n`;
  assertNoSecrets(text);
  return text;
}

/** Verdaccio: read-only npm mirror. Publishing, the web UI and auth are disabled; its
 * single uplink goes through Squid. */
export function renderVerdaccioConfig(d: ProxyDeployment): string {
  checkDeployment(d);
  const proxy = `http://${d.squidHost}:${d.squidPort}`;
  const text = [
    `storage: ${JSON.stringify(d.verdaccioStorage)}`,
    `listen: ${JSON.stringify(`0.0.0.0:${d.verdaccioPort}`)}`,
    `https_proxy: ${JSON.stringify(proxy)}`,
    `http_proxy: ${JSON.stringify(proxy)}`,
    'max_body_size: "1kb"',
    'web:',
    '  enable: false',
    'auth: {}',
    'uplinks:',
    '  npmjs:',
    '    url: "https://registry.npmjs.org/"',
    '    cache: true',
    '    max_fails: 2',
    'packages:',
    '  "**":',
    '    access: $all',
    '    publish: $nobody',
    '    unpublish: $nobody',
    '    proxy: npmjs',
    'log: { type: stdout, format: json, level: warn }',
    '',
  ].join('\n');
  assertNoSecrets(text);
  return text;
}

/** Verdaccio's container environment: trust Squid's inspection CA for the uplink. */
export function verdaccioEnvironment(d: ProxyDeployment): Readonly<Record<string, string>> {
  checkDeployment(d);
  return Object.freeze({ NODE_EXTRA_CA_CERTS: d.squidCaCertPath });
}

/** proxpi environment: a caching PyPI simple-index mirror that serves files itself,
 * with PyPI as its only index, reached through Squid. */
export function proxpiEnvironment(d: ProxyDeployment): Readonly<Record<string, string>> {
  checkDeployment(d);
  const proxy = `http://${d.squidHost}:${d.squidPort}`;
  return Object.freeze({
    PROXPI_INDEX_URL: 'https://pypi.org/simple/',
    PROXPI_EXTRA_INDEX_URLS: '',
    PROXPI_CACHE_DIR: d.proxpiCacheDir,
    PROXPI_BINARY_FILE_MIME_TYPE: '1',
    // proxpi otherwise REDIRECTS clients to the upstream file URL when a download takes
    // longer than 0.9 s, which would send the worker straight to files.pythonhosted.org.
    PROXPI_DOWNLOAD_TIMEOUT: '600',
    REQUESTS_CA_BUNDLE: d.squidCaCertPath,
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    NO_PROXY: '',
  });
}
