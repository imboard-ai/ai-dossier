/** Package-proxy policy as typed data, a reference evaluator, and config rendering for
 * the OSS components that enforce it: Verdaccio (npm) and proxpi (PyPI) as caching
 * mirrors whose only upstream route is an enforcing Squid forward proxy. Nothing here
 * opens a socket; the evaluator is the policy's executable specification. */
import { createHash } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { assertNoSecrets } from '../redaction';
import { isRecord } from '../state';
import type { PackageManager } from './detect';
import {
  NPM_REGISTRY,
  NPM_REGISTRY_HOST,
  NPM_SRI_SHA512,
  PYPI_FILES_HOST,
  PYPI_HOST,
  PYPI_SIMPLE,
  UV_SHA256,
  uvArtifacts,
} from './registries';
import { normalizeName, parseHashedRequirements } from './requirements';

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
  /** Redirect hops a mirror may follow. Squid cannot count hops across requests, so
   * only 0 is enforceable there: `renderSquidConfig` then denies every 3xx response. */
  readonly maxRedirects: number;
  readonly maxResponseBytes: number;
}

const NAME = '[A-Za-z0-9][A-Za-z0-9._~-]*';
const SCOPE = `@${NAME}`;
const PYPI_NAME = '[A-Za-z0-9][A-Za-z0-9._-]*';

/** The `ztfc-proxy-policy-v1` allowlist: body-less GET/HEAD of package documents and
 * artifacts per registry host, no redirects, 256 MiB responses. */
export const PROXY_POLICY: ProxyPolicy = Object.freeze({
  version: 'ztfc-proxy-policy-v1',
  methods: Object.freeze(['GET', 'HEAD'] as const),
  rules: Object.freeze([
    Object.freeze({
      name: 'npm',
      host: NPM_REGISTRY_HOST,
      paths: Object.freeze([
        // Package document: /name, /@scope%2fname, /@scope/name
        `^/(${SCOPE}(%2[fF]|/))?${NAME}$`,
        // Tarball: /name/-/name-1.2.3.tgz, /@scope/name/-/name-1.2.3.tgz
        `^/(${SCOPE}/)?${NAME}/-/${NAME}-[0-9][A-Za-z0-9.+-]*\\.tgz$`,
      ]),
    }),
    Object.freeze({
      name: 'pypi-index',
      host: PYPI_HOST,
      paths: Object.freeze([`^/simple/${PYPI_NAME}/$`]),
    }),
    Object.freeze({
      name: 'pypi-files',
      host: PYPI_FILES_HOST,
      paths: Object.freeze([
        '^/packages/[a-f0-9]{2}/[a-f0-9]{2}/[a-f0-9]{60}/[A-Za-z0-9._+-]+\\.(whl|tar\\.gz|zip)(\\.metadata)?$',
      ]),
    }),
  ]),
  // Registry package documents and artifacts are served at canonical URLs; the
  // mirrors request those directly, so no redirect needs to be followed.
  maxRedirects: 0,
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
 * request (same rules, resolved against the original URL), and only within the hop
 * limit. The destination is judged first so an off-registry target is always named. */
export function evaluateRedirect(
  fromUrl: string,
  location: string | undefined,
  hop: number,
  policy: ProxyPolicy = PROXY_POLICY
): Decision<RedirectDenial> {
  if (location === undefined || location.trim() === '') return deny('redirect_missing_location');
  let target: string;
  try {
    target = new URL(location, fromUrl).href;
  } catch {
    return deny('invalid_url');
  }
  const decision = urlDecision(policy, target);
  if (!decision.allowed)
    return decision.reason === 'host_not_allowed' ||
      decision.reason === 'scheme_not_allowed' ||
      decision.reason === 'port_not_allowed'
      ? deny('redirect_off_registry')
      : decision;
  return hop >= policy.maxRedirects ? deny('redirect_limit') : decision;
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
  constructor(readonly code: 'unparseable' | 'invalid_integrity' | 'invalid_artifact' | 'empty') {
    super(`Zero-trust lock index rejected: ${code}`);
    this.name = 'LockIndexError';
  }
}

function parseLock(manager: PackageManager, text: string): unknown {
  try {
    return manager === 'npm' ? JSON.parse(text) : parseToml(text);
  } catch {
    throw new LockIndexError('unparseable');
  }
}

function npmDigests(text: string, artifacts: Map<string, ExpectedDigest[]>): void {
  const lock = parseLock('npm', text);
  if (!isRecord(lock) || !isRecord(lock.packages)) throw new LockIndexError('unparseable');
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '') continue;
    if (!isRecord(entry)) throw new LockIndexError('invalid_artifact');
    // Mirrors detection: only a nested bundled package has no fetch of its own.
    if (
      entry.inBundle === true &&
      key.indexOf('/node_modules/') > 0 &&
      entry.resolved === undefined
    )
      continue;
    if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith(NPM_REGISTRY))
      throw new LockIndexError('invalid_artifact');
    const sri = typeof entry.integrity === 'string' ? NPM_SRI_SHA512.exec(entry.integrity) : null;
    if (!sri) throw new LockIndexError('invalid_integrity');
    artifacts.set(entry.resolved, [
      { algorithm: 'sha512', hex: Buffer.from(sri[1], 'base64').toString('hex') },
    ]);
  }
}

function uvDigests(text: string, artifacts: Map<string, ExpectedDigest[]>): void {
  const lock = parseLock('uv', text);
  if (!isRecord(lock) || !Array.isArray(lock.package)) throw new LockIndexError('unparseable');
  for (const pkg of lock.package) {
    if (!isRecord(pkg) || !isRecord(pkg.source)) throw new LockIndexError('invalid_artifact');
    if (pkg.source.registry !== PYPI_SIMPLE) continue;
    for (const a of uvArtifacts(pkg)) {
      if (!isRecord(a) || typeof a.url !== 'string') throw new LockIndexError('invalid_artifact');
      const hash = typeof a.hash === 'string' ? UV_SHA256.exec(a.hash) : null;
      if (!hash) throw new LockIndexError('invalid_integrity');
      artifacts.set(a.url, [{ algorithm: 'sha256', hex: hash[1] }]);
    }
  }
}

function pipDigests(text: string, artifacts: Map<string, ExpectedDigest[]>): void {
  const parsed = parseHashedRequirements(text);
  if (!Array.isArray(parsed)) throw new LockIndexError('unparseable');
  for (const r of parsed)
    artifacts.set(
      `${r.name}==${r.version}`,
      r.hashes.map((hex) => ({ algorithm: 'sha256' as const, hex }))
    );
}

/** Builds the expected-digest index from a lockfile, validating every entry itself
 * rather than trusting that detection ran first. */
export function buildLockIndex(manager: PackageManager, lockText: string): LockIndex {
  const artifacts = new Map<string, ExpectedDigest[]>();
  if (manager === 'npm') npmDigests(lockText, artifacts);
  else if (manager === 'uv') uvDigests(lockText, artifacts);
  else pipDigests(lockText, artifacts);
  if (artifacts.size === 0) throw new LockIndexError('empty');
  return Object.freeze({ manager, artifacts });
}

/** `name==version` of a PyPI wheel or sdist URL that the policy admits on the files
 * host, or `undefined` for anything else (including malformed URLs). Wheel names never
 * contain `-`; an sdist's version follows its last `-`. Metadata sidecars are not artifacts. */
export function pythonArtifactKey(
  url: string,
  policy: ProxyPolicy = PROXY_POLICY
): string | undefined {
  const decision = evaluateRequest({ method: 'GET', url }, policy);
  if (!decision.allowed || decision.rule !== 'pypi-files') return undefined;
  const file = new URL(url).pathname.split('/').pop() as string;
  const m =
    /^([A-Za-z0-9._]+)-([0-9][A-Za-z0-9.+!]*)-.+\.whl$/.exec(file) ??
    /^(.+)-([0-9][A-Za-z0-9.+!]*)\.(tar\.gz|zip)$/.exec(file);
  return m ? `${normalizeName(m[1])}==${m[2]}` : undefined;
}

/** Checks served bytes against the lockfile: the proxy cache keeps an artifact only
 * when its content digest matches what the lockfile pinned for that artifact. */
export function checkArtifact(
  index: LockIndex,
  url: string,
  bytes: Buffer
): Decision<ArtifactDenial> {
  const key = index.manager === 'pip' ? pythonArtifactKey(url) : url;
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
  constructor(readonly code: 'squid_host' | 'port' | 'path' | 'mirror_cidrs' | 'policy_regex') {
    super(`Zero-trust proxy configuration rejected: ${code}`);
    this.name = 'ProxyConfigError';
  }
}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const ABS_PATH = /^\/[A-Za-z0-9._/-]{0,255}$/;
/** An absolute path safe to write into a rendered config line: no spaces, no traversal. */
const isSafeAbsPath = (p: string) => ABS_PATH.test(p) && !p.split('/').includes('..');
/** Squid's certificate store size and helper count. */
export const SQUID_CERT_DB_SIZE = '16MB';
const SQUID_CERTGEN_CHILDREN = 4;
const IPV4_CIDR = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

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

/** Validates the deployment and returns Squid's URL for the mirrors' uplinks. */
function squidUrl(d: ProxyDeployment): string {
  if (!HOSTNAME.test(d.squidHost)) throw new ProxyConfigError('squid_host');
  if (
    ![d.squidPort, d.verdaccioPort, d.proxpiPort].every(
      (p) => Number.isInteger(p) && p > 0 && p < 65536
    )
  )
    throw new ProxyConfigError('port');
  if (
    ![d.squidCaCertPath, d.squidCaKeyPath, d.verdaccioStorage, d.proxpiCacheDir].every(
      isSafeAbsPath
    )
  )
    throw new ProxyConfigError('path');
  if (d.mirrorCidrs.length === 0 || !d.mirrorCidrs.every((c) => IPV4_CIDR.test(c)))
    throw new ProxyConfigError('mirror_cidrs');
  return `http://${d.squidHost}:${d.squidPort}`;
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
  '::/128',
  '::1',
  '::ffff:0:0/96',
  '64:ff9b::/96',
  '2002::/16',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
];

function squidRegex(pattern: string): string {
  // Squid reads each ACL value as a whitespace-separated token.
  if (/\s/.test(pattern)) throw new ProxyConfigError('policy_regex');
  return pattern;
}

/** Where a running Squid keeps its generated-certificate store, logs and pid. */
export interface SquidRuntime {
  /** Squid's certificate generator helper (`security_file_certgen`). */
  readonly certgenProgram: string;
  /** Directory of the certificate store (initialized before Squid starts). */
  readonly certDbDir: string;
  /** One line per request: time, client, method, URL, status, Squid result code, bytes. */
  readonly accessLog: string;
  readonly cacheLog: string;
  readonly pidFile: string;
}

/** The access log format `renderSquidConfig` writes, parsed by `parseSquidAccessLog`. */
export const SQUID_LOG_FORMAT = 'ztfc %ts.%03tu %>a %rm %ru %>Hs %Ss %<st';

export interface SquidLogEntry {
  readonly client: string;
  readonly method: string;
  readonly url: string;
  /** HTTP status sent to the client; 0 when none was. */
  readonly status: number;
  /** Squid's result code, e.g. `TCP_MISS`, `TCP_DENIED`, `NONE_NONE`. */
  readonly result: string;
}

/** Parses an access log written with `SQUID_LOG_FORMAT`. Unparseable lines are counted,
 * never guessed at. */
export function parseSquidAccessLog(text: string): {
  entries: SquidLogEntry[];
  malformed: number;
} {
  const entries: SquidLogEntry[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = /^\d+\.\d{3} (\S+) (\S+) (\S+) (\d{1,3}|-) ([A-Z_]+)(?:\/\d+)? (\d+|-)$/.exec(
      line.trim()
    );
    if (!m) {
      malformed++;
      continue;
    }
    entries.push({
      client: m[1],
      method: m[2],
      url: m[3],
      status: m[4] === '-' ? 0 : Number(m[4]),
      result: m[5],
    });
  }
  return { entries, malformed };
}

/** Squid configuration enforcing the policy on the mirrors' upstream traffic. */
export function renderSquidConfig(
  d: ProxyDeployment,
  policy: ProxyPolicy = PROXY_POLICY,
  runtime?: SquidRuntime
): string {
  squidUrl(d);
  if (
    runtime &&
    ![
      runtime.certgenProgram,
      runtime.certDbDir,
      runtime.accessLog,
      runtime.cacheLog,
      runtime.pidFile,
    ].every(isSafeAbsPath)
  )
    throw new ProxyConfigError('path');
  const lines = [
    `# Generated from ${policy.version}. Do not edit; regenerate from the policy.`,
    `http_port ${d.squidPort} ssl-bump tls-cert=${d.squidCaCertPath} tls-key=${d.squidCaKeyPath} generate-host-certificates=on`,
    `acl mirrors src ${d.mirrorCidrs.join(' ')}`,
    `acl forbidden_dst dst ${FORBIDDEN_DESTINATIONS.join(' ')}`,
    'acl ip_literal dstdom_regex ^[0-9.]+$ ^\\[ ^[0-9a-fA-F:]+$',
    'acl tls_port port 443',
    'acl https_proto proto HTTPS',
    'acl has_body req_header Content-Length ^[1-9]',
    'acl chunked_body req_header Transfer-Encoding .',
    'acl CONNECT method CONNECT',
    `acl package_methods method ${policy.methods.join(' ')}`,
    // Every 3xx except 304 Not Modified, which answers a mirror's conditional request.
    'acl redirect_status http_status 300-303 305-399',
  ];
  const allowed: string[] = [];
  for (const rule of policy.rules) {
    const id = rule.name.replace(/-/g, '_');
    lines.push(`acl host_${id} dstdomain -n ${rule.host}`);
    lines.push(`acl path_${id} urlpath_regex ${rule.paths.map(squidRegex).join(' ')}`);
    allowed.push(
      `http_access allow mirrors https_proto tls_port package_methods host_${id} path_${id}`
    );
  }
  const hosts = policy.rules.map((r) => r.host.replace(/\./g, '\\.')).join('|');
  lines.push(`acl registry_hosts dstdomain -n ${policy.rules.map((r) => r.host).join(' ')}`);
  lines.push(`acl registry_location rep_header Location ^https://(${hosts})/`);
  lines.push(
    // Peek at the client hello, stare at the server certificate, then bump: the
    // generated certificate mimics the real one and carries the Authority Key
    // Identifier that strict TLS clients (Python 3.13+) require. Bumping at step 1
    // would generate a bare certificate the PyPI mirror rejects (#1010).
    'acl step1 at_step SslBump1',
    'ssl_bump peek step1',
    'ssl_bump stare all',
    'ssl_bump bump all',
    'http_access deny !mirrors',
    'http_access deny forbidden_dst',
    'http_access deny ip_literal',
    'http_access allow CONNECT mirrors tls_port registry_hosts',
    'http_access deny CONNECT',
    // Inside the bumped tunnel: HTTPS only, and no request body (Squid has no
    // "max body 0"; `request_body_max_size 0` means unlimited).
    'http_access deny !https_proto',
    'http_access deny has_body',
    'http_access deny chunked_body',
    ...allowed,
    'http_access deny all',
    // Squid sees each hop as an unrelated request, so the only hop limit it can
    // enforce is zero; otherwise it admits only redirects that stay on a registry.
    policy.maxRedirects === 0
      ? 'http_reply_access deny redirect_status'
      : 'http_reply_access deny redirect_status !registry_location',
    `reply_body_max_size ${Math.floor(policy.maxResponseBytes / 1024)} KB`,
    'forwarded_for delete',
    'via off',
    'cache deny all'
  );
  if (runtime)
    lines.push(
      `sslcrtd_program ${runtime.certgenProgram} -s ${runtime.certDbDir} -M ${SQUID_CERT_DB_SIZE}`,
      `sslcrtd_children ${SQUID_CERTGEN_CHILDREN}`,
      `logformat ${SQUID_LOG_FORMAT}`,
      `access_log stdio:${runtime.accessLog} ztfc`,
      `cache_log stdio:${runtime.cacheLog}`,
      `pid_filename ${runtime.pidFile}`,
      // Logs are evidence the controller reads; nothing secret is written to them.
      'umask 022'
    );
  const text = `${lines.join('\n')}\n`;
  assertNoSecrets(text);
  return text;
}

/** Verdaccio: read-only npm mirror. Publishing, the web UI and auth are disabled; its
 * single uplink goes through Squid. */
export function renderVerdaccioConfig(d: ProxyDeployment): string {
  const proxy = squidUrl(d);
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
    `    url: ${JSON.stringify(NPM_REGISTRY)}`,
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
  squidUrl(d);
  return Object.freeze({ NODE_EXTRA_CA_CERTS: d.squidCaCertPath });
}

/** proxpi environment: a caching PyPI simple-index mirror that serves files itself,
 * with PyPI as its only index, reached through Squid. */
export function proxpiEnvironment(d: ProxyDeployment): Readonly<Record<string, string>> {
  const proxy = squidUrl(d);
  return Object.freeze({
    PROXPI_INDEX_URL: `${PYPI_SIMPLE}/`,
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
