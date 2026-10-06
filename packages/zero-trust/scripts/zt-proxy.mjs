#!/usr/bin/env node
// Host-side package proxy for the gate 2 proof (#1010; requires `npm run build` first).
// Trusted infrastructure on the controller host, never inside the VM:
//
//   Verdaccio (npm) and proxpi (PyPI) are caching mirrors on an --internal Docker
//   network: their only route anywhere is Squid, which also joins an egress network
//   and enforces ztfc-proxy-policy-v1 with TLS inspection (ssl-bump) under a per-run
//   CA that only the mirrors trust. The VM's one provisioning forward is spliced to
//   exactly one mirror by the controller (src/vm/provision-channel.ts).
//
//   zt-proxy.mjs up    --state-dir S [--out endpoints.json]
//   zt-proxy.mjs check --state-dir S --out checks.json   ordinary policy-rejection requests
//   zt-proxy.mjs down  --state-dir S
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const zt = require('../dist/index.js');

/** Pinned images. The Squid image is built from a pinned Ubuntu base; apt supplies
 * `squid-openssl` (the archive's Squid with OpenSSL, needed for ssl-bump). */
const PROXY_IMAGES = Object.freeze({
  ubuntu: 'ubuntu@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55',
  verdaccio:
    'verdaccio/verdaccio@sha256:560744912b640ddc0f23cd475d296b663b656c0fcfa0ba17cc5ca1cbcb620225',
  proxpi: 'epicwink/proxpi@sha256:7f8dce8778b7d4634c1e35d6f8d99f366e83dc60721ffc8f45893d19afcc5a90',
});
const SQUID_TAG = 'zt-squid:local';
const SHIM_DIR = fileURLToPath(new URL('../proxy', import.meta.url));
const NET_MIRRORS = 'zt-mirrors';
const NET_EGRESS = 'zt-egress';
const SUBNET = '172.31.250.0/24';
const IP = Object.freeze({
  squid: '172.31.250.2',
  verdaccio: '172.31.250.3',
  proxpi: '172.31.250.4',
  checker: '172.31.250.5',
  outsider: '172.31.250.9',
});
const NAMES = ['zt-squid', 'zt-verdaccio', 'zt-proxpi'];
const CLIENTS = ['zt-checker', 'zt-outsider'];
/** How long Squid and the mirrors get to start listening. */
const SERVICE_START_TIMEOUT_MS = 120_000;
/** Squid writes the access log line as the request completes; give it a moment. */
const ACCESS_LOG_FLUSH_MS = 300;
const CA_MOUNT = '/etc/zt-ca';
const DEPLOYMENT = Object.freeze({
  squidHost: IP.squid,
  squidPort: 3128,
  squidCaCertPath: `${CA_MOUNT}/ca.crt`,
  squidCaKeyPath: `${CA_MOUNT}/ca.key`,
  verdaccioPort: 4873,
  verdaccioStorage: '/verdaccio/storage',
  proxpiPort: 5000,
  proxpiCacheDir: '/var/cache/proxpi',
  // The checker is the harness's own client for ordinary policy requests; it stands
  // where a mirror stands. Nothing else may use Squid.
  mirrorCidrs: [`${IP.verdaccio}/32`, `${IP.proxpi}/32`, `${IP.checker}/32`],
});
const SQUID_RUNTIME = Object.freeze({
  certgenProgram: '/usr/lib/squid/security_file_certgen',
  certDbDir: '/var/lib/zt-ssl_db',
  accessLog: '/var/log/zt/access.log',
  cacheLog: '/var/log/zt/cache.log',
  pidFile: '/var/log/zt/squid.pid',
});

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) {
    if (fallback === undefined) throw new Error(`missing --${name}`);
    return fallback;
  }
  return process.argv[i + 1];
}

const log = (m) => console.error(`[zt-proxy] ${m}`);
const docker = (args, input) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'inherit'],
  }).trim();
const dockerQuiet = (args) => spawnSync('docker', args, { encoding: 'utf8' });
const envArgs = (env) => Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);

function dirs(stateDir) {
  const root = path.resolve(stateDir);
  return {
    root,
    caPrivate: path.join(root, 'ca-private'),
    caPublic: path.join(root, 'ca-public'),
    squidConf: path.join(root, 'squid'),
    logs: path.join(root, 'logs'),
    verdaccioConf: path.join(root, 'verdaccio-conf'),
    verdaccioStorage: path.join(root, 'verdaccio-storage'),
    proxpiCache: path.join(root, 'proxpi-cache'),
    build: path.join(root, 'squid-build'),
  };
}

/** Resolves once `container` listens on host:port; on timeout the error carries the
 * container's state and the tail of its log, which is where the cause is. */
function waitTcp(container, host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, host);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() <= deadline) return void setTimeout(attempt, 500);
        const state = dockerQuiet(['inspect', '--format', '{{.State.Status}}', container]);
        const logs = dockerQuiet(['logs', '--tail', '50', container]);
        reject(
          new Error(
            `${container} (${host}:${port}) not listening after ${timeoutMs / 1000} s; state ${state.stdout.trim() || 'unknown'}\n${logs.stdout}${logs.stderr}`
          )
        );
      });
    };
    attempt();
  });
}

/** Removes the stack. Errors other than "already gone" are reported, not swallowed,
 * so a leftover network surfaces now instead of as "already exists" on the next `up`. */
function down() {
  const failures = [];
  for (const name of [...NAMES, ...CLIENTS]) {
    const r = dockerQuiet(['rm', '-f', name]);
    if (r.status !== 0 && !/No such container/i.test(r.stderr)) failures.push(r.stderr.trim());
  }
  for (const network of [NET_MIRRORS, NET_EGRESS]) {
    const r = dockerQuiet(['network', 'rm', network]);
    if (r.status !== 0 && !/not found/i.test(r.stderr)) failures.push(r.stderr.trim());
  }
  if (failures.length) throw new Error(`down left resources behind:\n${failures.join('\n')}`);
}

/** The stack uses fixed names, a fixed subnet and fixed addresses: one per host. */
function refuseIfRunning() {
  const running = NAMES.filter((name) => dockerQuiet(['inspect', name]).status === 0);
  const networks = [NET_MIRRORS, NET_EGRESS].filter(
    (n) => dockerQuiet(['network', 'inspect', n]).status === 0
  );
  if (running.length || networks.length)
    throw new Error(
      `a proxy stack already exists (${[...running, ...networks].join(', ')}); run \`zt-proxy.mjs down\` first`
    );
}

/** The state directory holds the inspection CA key and the mirror caches: it must be
 * this user's and private, whatever it was before. */
function privateRoot(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(root);
  if (!info.isDirectory() || info.uid !== process.getuid())
    throw new Error(`${root} must be a directory owned by this user`);
  fs.chmodSync(root, 0o700);
}

async function up(d) {
  refuseIfRunning();
  try {
    return await start(d);
  } catch (error) {
    try {
      down();
    } catch (cleanup) {
      log(cleanup.message);
    }
    throw error;
  }
}

async function start(d) {
  privateRoot(d.root);
  for (const dir of Object.values(d)) if (dir !== d.root) fs.mkdirSync(dir, { recursive: true });
  // Per-run inspection CA, valid for a day. The key stays with Squid; mirrors get
  // the certificate only. Workers never see either.
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      `/CN=ztfc-inspection-${randomBytes(4).toString('hex')}`,
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
      '-keyout',
      path.join(d.caPrivate, 'ca.key'),
      '-out',
      path.join(d.caPrivate, 'ca.crt'),
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  );
  fs.copyFileSync(path.join(d.caPrivate, 'ca.crt'), path.join(d.caPublic, 'ca.crt'));
  // Container users (Squid's `proxy`, Verdaccio's uid 10001) must read and write these;
  // the 0700 root keeps every other host user out.
  fs.chmodSync(d.caPrivate, 0o755);
  fs.chmodSync(path.join(d.caPrivate, 'ca.key'), 0o644);
  for (const dir of [d.caPublic, d.squidConf, d.verdaccioConf]) fs.chmodSync(dir, 0o755);
  for (const dir of [d.logs, d.verdaccioStorage, d.proxpiCache]) fs.chmodSync(dir, 0o777);

  fs.writeFileSync(
    path.join(d.squidConf, 'squid.conf'),
    zt.renderSquidConfig(DEPLOYMENT, zt.PROXY_POLICY, SQUID_RUNTIME)
  );
  fs.writeFileSync(path.join(d.verdaccioConf, 'config.yaml'), zt.renderVerdaccioConfig(DEPLOYMENT));
  fs.writeFileSync(
    path.join(d.build, 'Dockerfile'),
    [
      `FROM ${PROXY_IMAGES.ubuntu}`,
      'RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends squid-openssl ca-certificates curl \\',
      ' && rm -rf /var/lib/apt/lists/*',
      // The certificate store must be created fresh, by the helper, as Squid's user.
      `CMD rm -rf ${SQUID_RUNTIME.certDbDir} ${SQUID_RUNTIME.pidFile} && ${SQUID_RUNTIME.certgenProgram} -c -s ${SQUID_RUNTIME.certDbDir} -M ${zt.SQUID_CERT_DB_SIZE} >/dev/null \\`,
      ` && chown -R proxy:proxy ${SQUID_RUNTIME.certDbDir} && exec squid -N -f /etc/zt-squid/squid.conf`,
      '',
    ].join('\n')
  );
  log('building Squid image');
  docker(['build', '-q', '-t', SQUID_TAG, d.build]);
  docker(['network', 'create', '--internal', '--subnet', SUBNET, NET_MIRRORS]);
  docker(['network', 'create', NET_EGRESS]);

  docker([
    'run',
    '-d',
    '--name',
    'zt-squid',
    '--network',
    NET_MIRRORS,
    '--ip',
    IP.squid,
    '--mount',
    `type=bind,src=${d.caPrivate},dst=${CA_MOUNT},readonly`,
    '--mount',
    `type=bind,src=${d.squidConf},dst=/etc/zt-squid,readonly`,
    '--mount',
    `type=bind,src=${d.logs},dst=/var/log/zt`,
    SQUID_TAG,
  ]);
  docker(['network', 'connect', NET_EGRESS, 'zt-squid']);

  docker([
    'run',
    '-d',
    '--name',
    'zt-verdaccio',
    '--network',
    NET_MIRRORS,
    '--ip',
    IP.verdaccio,
    ...envArgs(zt.verdaccioEnvironment(DEPLOYMENT)),
    '--mount',
    `type=bind,src=${d.caPublic},dst=${CA_MOUNT},readonly`,
    '--mount',
    `type=bind,src=${d.verdaccioConf},dst=/verdaccio/conf,readonly`,
    '--mount',
    `type=bind,src=${d.verdaccioStorage},dst=${DEPLOYMENT.verdaccioStorage}`,
    PROXY_IMAGES.verdaccio,
  ]);
  docker([
    'run',
    '-d',
    '--name',
    'zt-proxpi',
    '--network',
    NET_MIRRORS,
    '--ip',
    IP.proxpi,
    ...envArgs(zt.proxpiEnvironment(DEPLOYMENT)),
    '--mount',
    `type=bind,src=${d.caPublic},dst=${CA_MOUNT},readonly`,
    '--mount',
    `type=bind,src=${d.proxpiCache},dst=${DEPLOYMENT.proxpiCacheDir}`,
    // The image's own gunicorn command, with the canonical-URL shim as the app.
    '--mount',
    `type=bind,src=${SHIM_DIR},dst=/zt,readonly`,
    '--env',
    'PYTHONPATH=/zt',
    '--entrypoint',
    'gunicorn',
    PROXY_IMAGES.proxpi,
    '--preload',
    '--access-logfile',
    '-',
    '--logger-class',
    'proxpi.server._GunicornLogger',
    'zt_proxpi:app',
    '--bind',
    `0.0.0.0:${DEPLOYMENT.proxpiPort}`,
    '--threads',
    '8',
    '--no-control-socket',
  ]);
  await Promise.all([
    waitTcp('zt-squid', IP.squid, DEPLOYMENT.squidPort, SERVICE_START_TIMEOUT_MS),
    waitTcp('zt-verdaccio', IP.verdaccio, DEPLOYMENT.verdaccioPort, SERVICE_START_TIMEOUT_MS),
    waitTcp('zt-proxpi', IP.proxpi, DEPLOYMENT.proxpiPort, SERVICE_START_TIMEOUT_MS),
  ]);
  const imageId = (ref) => docker(['image', 'inspect', '--format', '{{.Id}}', ref]);
  return {
    npm: { host: IP.verdaccio, port: DEPLOYMENT.verdaccioPort },
    pypi: { host: IP.proxpi, port: DEPLOYMENT.proxpiPort },
    accessLog: path.join(d.logs, 'access.log'),
    cacheLog: path.join(d.logs, 'cache.log'),
    verdaccioStorage: d.verdaccioStorage,
    proxpiCache: d.proxpiCache,
    images: {
      squid: imageId(SQUID_TAG),
      squidPackage: docker([
        'run',
        '--rm',
        '--entrypoint',
        'dpkg-query',
        SQUID_TAG,
        '-W',
        '-f',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a dpkg-query format, not JS.
        '${Version}',
        'squid-openssl',
      ]),
      verdaccio: PROXY_IMAGES.verdaccio,
      proxpi: PROXY_IMAGES.proxpi,
    },
    policy: zt.PROXY_POLICY.version,
  };
}

/** Ordinary requests through Squid from a client standing where a mirror stands,
 * each with the outcome the policy requires. Not probes: plain curl GET/POST. */
const CHECKS = [
  { id: 'allowed-package-document', url: 'https://registry.npmjs.org/ms', expect: 'allow' },
  { id: 'allowed-simple-index', url: 'https://pypi.org/simple/pytest/', expect: 'allow' },
  { id: 'non-package-path-npm', url: 'https://registry.npmjs.org/-/whoami', expect: 'deny' },
  { id: 'non-package-path-pypi-json', url: 'https://pypi.org/pypi/pytest/json', expect: 'deny' },
  { id: 'non-package-root-index', url: 'https://pypi.org/simple/', expect: 'deny' },
  { id: 'query-string', url: 'https://registry.npmjs.org/-/v1/search?text=ms', expect: 'deny' },
  { id: 'request-body', url: 'https://registry.npmjs.org/ms', method: 'POST', expect: 'deny' },
  { id: 'plain-http-registry', url: 'http://registry.npmjs.org/ms', expect: 'deny' },
  // PyPI answers a non-normalized project name with a redirect to the normalized one.
  { id: 'redirect-on-registry', url: 'https://pypi.org/simple/PyTest/', expect: 'deny' },
  { id: 'off-registry-host', url: 'https://example.com/', expect: 'deny' },
  { id: 'ip-literal', url: 'https://1.1.1.1/', expect: 'deny' },
  { id: 'metadata-address', url: 'http://169.254.169.254/latest/meta-data/', expect: 'deny' },
];

function curl(d, name, ip, check) {
  const argv = [
    'run',
    '--rm',
    '--name',
    name,
    '--network',
    NET_MIRRORS,
    '--ip',
    ip,
    '--mount',
    `type=bind,src=${d.caPublic},dst=${CA_MOUNT},readonly`,
    '--entrypoint',
    'curl',
    SQUID_TAG,
    '-sS',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code} %{http_connect}',
    '--max-time',
    '30',
    '--proxy',
    `http://${IP.squid}:${DEPLOYMENT.squidPort}`,
    '--cacert',
    `${CA_MOUNT}/ca.crt`,
    '--max-redirs',
    '0',
  ];
  if (check.method === 'POST') argv.push('-X', 'POST', '--data', 'x');
  argv.push(check.url);
  const r = spawnSync('docker', argv, { encoding: 'utf8' });
  const [code, connect] = (r.stdout || '000 000').trim().split(' ');
  // Kept so an `error` outcome says why: no image, a leftover client, a curl failure.
  return {
    httpCode: Number(code),
    connectCode: Number(connect),
    curlExit: r.status,
    stderr: (r.stderr ?? '').slice(-500),
  };
}

function logSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** The verdict comes from Squid's own access log, not from the client: a request is
 * denied when Squid logged it TCP_DENIED (TCP_DENIED_REPLY: the response, e.g. a
 * redirect, was refused), and allowed when Squid fetched it and answered 2xx. */
function outcomeFrom(entries) {
  if (entries.some((e) => e.result.startsWith('TCP_DENIED'))) return 'deny';
  if (
    entries.some(
      (e) => e.method !== 'CONNECT' && e.status >= 200 && e.status < 300 && e.result !== 'NONE_NONE'
    )
  )
    return 'allow';
  return 'error';
}

async function check(d) {
  const file = path.join(d.logs, 'access.log');
  if (!fs.existsSync(file))
    throw new Error(`Squid wrote no access log at ${file}; is zt-squid running (zt-proxy.mjs up)?`);
  const results = [];
  const run = async (c, name, ip) => {
    const before = logSize(file);
    const client = curl(d, name, ip, c);
    await new Promise((r) => setTimeout(r, ACCESS_LOG_FLUSH_MS));
    const text = fs.readFileSync(file, 'utf8').slice(before);
    const { entries, malformed } = zt.parseSquidAccessLog(text);
    const squid = entries.filter((e) => e.client === ip);
    results.push({ ...c, client, squid, malformed, outcome: outcomeFrom(squid) });
  };
  for (const c of CHECKS) await run(c, 'zt-checker', IP.checker);
  // A client outside the mirror addresses is refused even for an allowed request.
  await run({ ...CHECKS[0], id: 'non-mirror-source', expect: 'deny' }, 'zt-outsider', IP.outsider);
  return { passed: results.every((r) => r.outcome === r.expect), results };
}

const command = process.argv[2];
try {
  const d = dirs(arg('state-dir'));
  if (command === 'up') {
    const endpoints = await up(d);
    const out = arg('out', '');
    if (out) fs.writeFileSync(out, `${JSON.stringify(endpoints, null, 2)}\n`);
    console.log(JSON.stringify(endpoints, null, 2));
  } else if (command === 'check') {
    const result = await check(d);
    fs.writeFileSync(arg('out'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result.results.map((r) => [r.id, r.expect, r.outcome])));
    if (!result.passed) process.exit(1);
  } else if (command === 'down') {
    down();
  } else {
    throw new Error('usage: zt-proxy.mjs up|check|down --state-dir S');
  }
} catch (error) {
  log(error.stack ?? String(error));
  process.exit(1);
}
