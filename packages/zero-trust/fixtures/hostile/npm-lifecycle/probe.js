// Hostile fixture (canary design, see the execution-profile decision record).
// Runs inside the worker as an npm lifecycle script and as `npm test`. Every
// attempt targets a canary the test harness planted outside the VM; nothing
// here searches for or collects real credentials. Each attempt is recorded as
// {category, attempt, outcome}; the host evaluator decides pass/fail.

const fs = require('node:fs');
const net = require('node:net');
const dgram = require('node:dgram');
const dns = require('node:dns');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const phase = process.argv[2] || 'test';
const targets = JSON.parse(fs.readFileSync(path.join(__dirname, 'targets.json'), 'utf8'));
const records = [];
const record = (category, attempt, outcome, detail = '') =>
  records.push({ category, attempt, outcome, detail: String(detail).slice(0, 200) });

function tcp(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (outcome, detail) => {
      socket.destroy();
      resolve([outcome, detail]);
    };
    socket.setTimeout(4000, () => finish('denied', 'timeout'));
    socket.once('connect', () => finish('succeeded', 'connected'));
    socket.once('error', (e) => finish('denied', e.code || 'error'));
  });
}

function rawDnsQuery(server, name) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const qname = Buffer.concat(
      name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]))
    );
    const query = Buffer.concat([
      Buffer.from([0x5a, 0x54, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
      qname,
      Buffer.from([0, 0, 1, 0, 1]),
    ]);
    const timer = setTimeout(() => {
      socket.close();
      resolve(['denied', 'timeout']);
    }, 4000);
    socket.once('message', () => {
      clearTimeout(timer);
      socket.close();
      resolve(['succeeded', 'answer']);
    });
    socket.once('error', (e) => {
      clearTimeout(timer);
      socket.close();
      resolve(['denied', e.code || 'error']);
    });
    socket.send(query, 53, server);
  });
}

function command(argv) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 10000 });
  if (r.error) return ['denied', r.error.code || 'error'];
  return r.status === 0 ? ['succeeded', 'exit 0'] : ['denied', `exit ${r.status}`];
}

async function main() {
  // Planted host environment canary (set in the controller process only).
  const env = process.env[targets.envName];
  record('host-env', `env:${targets.envName}`, env === undefined ? 'denied' : 'succeeded');

  // Planted host home file, at its host path and common share mount points.
  for (const candidate of [
    targets.hostFile,
    ...['/host', '/mnt', '/media'].map((p) => p + targets.hostFile),
  ]) {
    let outcome = 'denied';
    let detail = '';
    try {
      fs.readFileSync(candidate);
      outcome = 'succeeded';
    } catch (e) {
      detail = e.code || 'error';
    }
    record('host-file', `read:${candidate}`, outcome, detail);
  }

  // Planted listeners: host loopback (via the user-mode gateway and directly) and a LAN address.
  for (const [category, host, port] of [
    ['host-loopback', targets.gateway, targets.loopbackPort],
    ['host-loopback', '127.0.0.1', targets.loopbackPort],
    ['lan', targets.lanHost, targets.lanPort],
  ]) {
    const [outcome, detail] = await tcp(host, port);
    record(category, `tcp:${host}:${port}`, outcome, detail);
  }

  for (const [host, port] of targets.metadata) {
    const [outcome, detail] = await tcp(host, port);
    record('metadata', `tcp:${host}:${port}`, outcome, detail);
  }
  for (const [host, port] of targets.egress) {
    const [outcome, detail] = await tcp(host, port);
    record('direct-egress', `tcp:${host}:${port}`, outcome, detail);
  }

  // A unique canary name: any answer, even NXDOMAIN, means the query left the VM.
  const resolver = new dns.promises.Resolver({ timeout: 3000, tries: 1 });
  try {
    await resolver.resolve4(targets.dnsName);
    record('dns', `resolve:${targets.dnsName}`, 'succeeded', 'answer');
  } catch (e) {
    const answered = e.code === 'ENOTFOUND' || e.code === 'ENODATA';
    record('dns', `resolve:${targets.dnsName}`, answered ? 'succeeded' : 'denied', e.code);
  }
  for (const server of targets.dnsServers) {
    const [outcome, detail] = await rawDnsQuery(server, targets.dnsName);
    record('dns', `udp:${server}`, outcome, detail);
  }

  // Privilege escalation inside the container.
  record(
    'privilege-escalation',
    'uid',
    process.getuid() === 0 ? 'succeeded' : 'denied',
    process.getuid()
  );
  const [sudoOutcome, sudoDetail] = command(['sudo', '-n', 'true']);
  record('privilege-escalation', 'sudo', sudoOutcome, sudoDetail);
  const [nsOutcome, nsDetail] = command(['unshare', '-r', 'true']);
  record('privilege-escalation', 'user-namespace', nsOutcome, nsDetail);
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  const capEff = /CapEff:\s*([0-9a-f]+)/.exec(status)?.[1] ?? '';
  record(
    'privilege-escalation',
    'capabilities',
    /^0+$/.test(capEff) ? 'denied' : 'succeeded',
    capEff
  );
  const nnp = /NoNewPrivs:\s*(\d)/.exec(status)?.[1];
  record('privilege-escalation', 'no-new-privs', nnp === '1' ? 'denied' : 'succeeded', nnp);
  try {
    fs.writeFileSync('/etc/zt-probe', 'x');
    record('privilege-escalation', 'write:/etc', 'succeeded');
  } catch (e) {
    record('privilege-escalation', 'write:/etc', 'denied', e.code);
  }

  // Container -> VM escape primitives.
  for (const sock of [
    '/var/run/docker.sock',
    '/run/docker.sock',
    '/run/containerd/containerd.sock',
  ]) {
    const [outcome, detail] = await new Promise((resolve) => {
      const s = net.connect(sock);
      s.once('connect', () => {
        s.destroy();
        resolve(['succeeded', 'connected']);
      });
      s.once('error', (e) => resolve(['denied', e.code || 'error']));
    });
    record('container-escape', `socket:${sock}`, outcome, detail);
  }
  const mounts = fs.readFileSync('/proc/mounts', 'utf8');
  const shared = /\s(9p|virtiofs|fuse\.\S+|nfs4?|cifs|vboxsf)\s/.test(mounts);
  record('container-escape', 'shared-filesystem-mount', shared ? 'succeeded' : 'denied');
  const blockDevices = fs.readdirSync('/dev').filter((d) => /^(sd|vd|nvme|xvd)/.test(d));
  record(
    'container-escape',
    'block-devices',
    blockDevices.length ? 'succeeded' : 'denied',
    blockDevices.join(',')
  );
  const [mountOutcome, mountDetail] = command(['mount', '-t', 'tmpfs', 'none', '/tmp']);
  record('container-escape', 'mount', mountOutcome, mountDetail);

  // Broker abuse from the worker: the broker port must not be reachable.
  for (const port of [
    '/dev/virtio-ports/org.ai-dossier.zt.broker',
    '/dev/vport0p1',
    '/dev/vport1p1',
  ]) {
    try {
      fs.closeSync(fs.openSync(port, 'r+'));
      record('broker-abuse', `open:${port}`, 'succeeded');
    } catch (e) {
      record('broker-abuse', `open:${port}`, 'denied', e.code);
    }
  }

  const report = { probe: 'node', phase, records };
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'results', `node-${phase}.json`), JSON.stringify(report));
  console.log(`ZT-PROBE-REPORT ${JSON.stringify(report)}`);
}

main().catch((e) => {
  console.error(`probe error: ${e?.message}`);
  process.exitCode = 1;
});
