/** Feasibility gate 1 (#1009, scenario 4): runs the hostile fixtures in a real
 * local VM against freshly planted host canaries and requires the boundary to
 * hold. Needs QEMU and a baked profile, so it only runs with ZT_VM_E2E=1:
 *
 *   ZT_VM_E2E=1 ZT_PROFILE_DIR=<baked profile> [ZT_ACCEL=auto|kvm|tcg] \
 *   [ZT_EVIDENCE_OUT=evidence.json] npx vitest run src/__tests__/vm-gate.e2e.test.ts
 *
 * The verdict comes from host-side measurements (canary values in any guest
 * byte, connections on the planted listeners, broker rejections); fixture
 * reports are untrusted and can only add violations. */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AcceleratorRequest, ContainerProfile, VmHandle, VmLimits } from '../vm/adapter';
import { BrokerError } from '../vm/adapter';
import { validateRequest } from '../vm/broker';
import {
  assertBoundaryHeld,
  type BoundaryEvidence,
  evaluateBoundary,
  type ProbeReport,
  parseReport,
  parseReports,
} from '../vm/evidence';
import { LocalQemuAdapter } from '../vm/local-qemu';

const ENABLED = process.env.ZT_VM_E2E === '1';
const FIXTURES = path.join(__dirname, '..', '..', 'fixtures', 'hostile');
const LIMITS: VmLimits = { vcpus: 2, memoryMiB: 4096, diskGiB: 10, commandTimeoutMs: 10 * 60_000 };
/** Categories whose denial must hold even for root inside the VM: they are
 * enforced by QEMU on the host, not by the container runtime. */
const HOST_ENFORCED = new Set([
  'host-env',
  'host-file',
  'host-loopback',
  'lan',
  'metadata',
  'direct-egress',
  'dns',
]);
/** Every report the fixtures must produce, as results/<probe>-<phase>.json. */
const CONTAINER_PHASES: Record<string, string[]> = {
  'npm-lifecycle': ['node-preinstall', 'node-postinstall', 'node-test'],
  'pip-setup': ['python-install', 'python-test'],
};

const hex = (n: number) => randomBytes(n).toString('hex');

function lanAddress(): string {
  for (const list of Object.values(os.networkInterfaces()))
    for (const entry of list ?? [])
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  throw new Error('No non-loopback IPv4 address to plant the LAN listener on');
}

interface Listener {
  readonly server: net.Server;
  readonly port: number;
  connections: number;
}

async function listen(host: string): Promise<Listener> {
  const listener = { connections: 0 } as Listener;
  const server = net.createServer((socket) => {
    listener.connections++;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
  return Object.assign(listener, { server, port: (server.address() as net.AddressInfo).port });
}

describe.skipIf(!ENABLED)('execution profile gate (real VM)', () => {
  const canaries: string[] = [];
  const guestOutputs: string[] = [];
  const reports: ProbeReport[] = [];
  const brokerChecks: { attempt: string; rejected: boolean }[] = [];
  const timings: Record<string, number> = {};
  let malformedReports = 0;
  let adapter: LocalQemuAdapter;
  let hostHome: string;
  let stateDir: string;
  let runtimeDir: string;
  let envName: string;
  let loopback: Listener;
  let lan: Listener;
  let targets: Record<string, unknown>;
  let evidence: BoundaryEvidence | undefined;

  beforeAll(async () => {
    const profileDir = process.env.ZT_PROFILE_DIR;
    if (!profileDir || !path.isAbsolute(profileDir))
      throw new Error('ZT_PROFILE_DIR must be the absolute path of a baked profile');
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-gate-state-'));
    // Short on purpose: broker socket paths must fit in sun_path.
    runtimeDir = fs.mkdtempSync('/tmp/ztr-');
    // Planted canaries: a variable in QEMU's parent environment and a secret
    // file in a temporary host home directory.
    envName = `ZT_CANARY_${hex(8).toUpperCase()}`;
    const envCanary = `zt-env-${hex(16)}`;
    process.env[envName] = envCanary;
    hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-gate-home-'));
    const hostFile = path.join(hostHome, '.zt-canary-secret');
    const fileCanary = `zt-file-${hex(16)}`;
    fs.writeFileSync(hostFile, fileCanary, { mode: 0o600 });
    canaries.push(envCanary, fileCanary);
    loopback = await listen('127.0.0.1');
    const lanHost = lanAddress();
    lan = await listen(lanHost);
    targets = {
      envName,
      hostFile,
      gateway: '10.0.2.2',
      loopbackPort: loopback.port,
      lanHost,
      lanPort: lan.port,
      metadata: [
        ['169.254.169.254', 80],
        ['fd00:ec2::254', 80],
      ],
      egress: [
        ['1.1.1.1', 443],
        ['8.8.8.8', 53],
      ],
      dnsName: `zt-dns-${hex(8)}.example.com`,
      dnsServers: ['10.0.2.3', '1.1.1.1', '8.8.8.8'],
    };
    adapter = new LocalQemuAdapter({
      profileDir,
      stateDir,
      runtimeDir,
      accelerator: (process.env.ZT_ACCEL ?? 'auto') as AcceleratorRequest,
    });
  });

  afterAll(async () => {
    loopback?.server.close();
    lan?.server.close();
    if (envName) delete process.env[envName];
    const out = process.env.ZT_EVIDENCE_OUT;
    if (out && adapter)
      fs.writeFileSync(
        out,
        `${JSON.stringify(
          {
            accelerator: adapter.accelerator,
            timings,
            held: evidence?.held ?? false,
            violations: evidence?.violations ?? ['evaluation did not run'],
            coverage: evidence?.coverage ?? {},
            attempts: evidence?.attempts ?? 0,
            listenerConnections: (loopback?.connections ?? 0) + (lan?.connections ?? 0),
            brokerChecks,
            reports: reports.map((r) => ({ probe: r.probe, phase: r.phase, records: r.records })),
          },
          null,
          2
        )}\n`
      );
    for (const dir of [hostHome, stateDir, runtimeDir])
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await work();
    } finally {
      timings[label] = Date.now() - started;
    }
  }

  async function upload(vm: VmHandle, fixture: string): Promise<void> {
    for (const name of fs.readdirSync(path.join(FIXTURES, fixture)))
      await adapter.putFile(
        vm,
        `${fixture}/${name}`,
        fs.readFileSync(path.join(FIXTURES, fixture, name))
      );
    await adapter.putFile(vm, `${fixture}/targets.json`, Buffer.from(JSON.stringify(targets)));
  }

  async function run(
    label: string,
    vm: VmHandle,
    profile: ContainerProfile,
    argv: string[],
    cwd: string
  ): Promise<void> {
    const result = await timed(label, () => adapter.exec(vm, { profile, argv, cwd }));
    guestOutputs.push(result.stdout, result.stderr);
    malformedReports += parseReports(`${result.stdout}\n${result.stderr}`).malformed;
    expect(result.timedOut, `${label} timed out`).toBe(false);
    expect(result.exitCode, `${label} failed:\n${result.stderr.slice(-2000)}`).toBe(0);
  }

  /** Report files are read back through the broker; their bytes are guest output too. */
  async function collect(vm: VmHandle, fixture: string, keep?: (category: string) => boolean) {
    for (const phase of CONTAINER_PHASES[fixture]) {
      const bytes = (await adapter.getFile(vm, `${fixture}/results/${phase}.json`)).toString(
        'utf8'
      );
      guestOutputs.push(bytes);
      let report: ProbeReport;
      try {
        report = parseReport(JSON.parse(bytes));
      } catch {
        malformedReports++;
        continue;
      }
      reports.push(
        keep ? { ...report, records: report.records.filter((r) => keep(r.category)) } : report
      );
    }
  }

  async function rejected(attempt: string, work: () => unknown): Promise<void> {
    let outcome = false;
    try {
      await work();
    } catch (error) {
      outcome = error instanceof BrokerError;
    }
    brokerChecks.push({ attempt, rejected: outcome });
  }

  it(
    'denies every attack category in the worker container',
    async () => {
      const runId = `gate-${hex(4)}`;
      const vm = await timed('containerBootMs', () =>
        adapter.create({ runId, limits: LIMITS, scope: 'container' })
      );
      try {
        // Broker abuse from the controller side: nothing outside the fixed
        // operation set or the size caps may reach the guest.
        await rejected('op-outside-set', () => validateRequest({ op: 'shell' } as never));
        await rejected('put-traversal', () => adapter.putFile(vm, '../escape', Buffer.from('x')));
        await rejected('put-absolute', () => adapter.putFile(vm, '/etc/passwd', Buffer.from('x')));
        await rejected('put-oversize', () =>
          adapter.putFile(vm, 'big.bin', Buffer.alloc(1024 * 1024 + 1))
        );
        await rejected('get-traversal', () => adapter.getFile(vm, '../../etc/shadow'));
        await rejected('exec-unknown-profile', () =>
          adapter.exec(vm, { profile: 'host' as ContainerProfile, argv: ['true'] })
        );
        await rejected('exec-oversize-argv', () =>
          adapter.exec(vm, { profile: 'node', argv: Array(9).fill('a'.repeat(8000)) })
        );
        await upload(vm, 'npm-lifecycle');
        await upload(vm, 'pip-setup');
        await run(
          'npmInstallMs',
          vm,
          'node',
          ['npm', 'install', '--offline', '--no-audit', '--no-fund', '--foreground-scripts'],
          'npm-lifecycle'
        );
        await run('npmTestMs', vm, 'node', ['npm', 'test'], 'npm-lifecycle');
        await run(
          'pipInstallMs',
          vm,
          'python',
          [
            'sh',
            '-c',
            'python3 -m venv --system-site-packages /tmp/venv && /tmp/venv/bin/pip install -v --no-index --no-deps --no-build-isolation .',
          ],
          'pip-setup'
        );
        await run(
          'pipTestMs',
          vm,
          'python',
          ['python3', '-m', 'unittest', '-v', 'test_witness'],
          'pip-setup'
        );
        await collect(vm, 'npm-lifecycle');
        await collect(vm, 'pip-setup');
      } finally {
        await timed('containerDestroyMs', () => adapter.destroy(vm));
      }
      expect(await adapter.listByRun(runId)).toEqual([]);
    },
    3 * 3600_000
  );

  it(
    'holds the host-side boundary for root inside the VM (assumed container escape)',
    async () => {
      const runId = `gate-root-${hex(4)}`;
      const vm = await timed('vmRootBootMs', () =>
        adapter.create({ runId, limits: LIMITS, scope: 'vm-root' })
      );
      try {
        await upload(vm, 'npm-lifecycle');
        // vm-root runs argv as root on the VM itself; the node image supplies the
        // runtime and --network host puts the probe on the VM's own network stack.
        const result = await timed('vmRootProbeMs', () =>
          adapter.exec(vm, {
            profile: 'node',
            argv: [
              'docker',
              'run',
              '--rm',
              '--network',
              'host',
              '--user',
              '0:0',
              '--mount',
              'type=bind,src=/var/lib/zt/workspace,dst=/workspace',
              '--workdir',
              '/workspace/npm-lifecycle',
              'zt-node:profile',
              'node',
              'probe.js',
              'vm-root',
            ],
          })
        );
        guestOutputs.push(result.stdout, result.stderr);
        const parsed = parseReports(result.stdout);
        malformedReports += parsed.malformed;
        expect(result.exitCode, result.stderr.slice(-2000)).toBe(0);
        expect(parsed.reports).toHaveLength(1);
        // Root in the VM is root by design: only host-enforced categories are judged here.
        for (const report of parsed.reports)
          reports.push({
            ...report,
            phase: 'vm-root',
            records: report.records.filter((r) => HOST_ENFORCED.has(r.category)),
          });
      } finally {
        await timed('vmRootDestroyMs', () => adapter.destroy(vm));
      }
    },
    3 * 3600_000
  );

  it('evaluates the evidence on the host and requires the boundary to hold', () => {
    evidence = evaluateBoundary({
      reports,
      guestOutputs,
      canaries,
      listenerConnections: loopback.connections + lan.connections,
      brokerChecks,
      malformedReports,
    });
    expect(reports.map((r) => `${r.probe}-${r.phase}`).sort()).toEqual([
      'node-postinstall',
      'node-preinstall',
      'node-test',
      'node-vm-root',
      'python-install',
      'python-test',
    ]);
    expect(evidence.violations).toEqual([]);
    assertBoundaryHeld(evidence);
  });
});
