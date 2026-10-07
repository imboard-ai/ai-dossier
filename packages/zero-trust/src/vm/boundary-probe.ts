/** Per-VM host measurements. Guest reports can only worsen the host verdict. */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { OutputCollector } from '../controller/output-collector';
import { assertDirectoryAncestors, privateDir, publishPrivate } from '../durable-fs';
import { assertSecretFree } from '../redaction';
import { BrokerError, type ContainerProfile, type VmAdapter, type VmHandle } from './adapter';
import { validateRequest } from './broker';
import { type BoundaryInput, evaluateBoundary, parseReport, parseReports } from './evidence';

export const HOST_ENFORCED = new Set([
  'host-env',
  'host-file',
  'host-loopback',
  'lan',
  'metadata',
  'direct-egress',
  'dns',
]);
export const hex = (n: number) => randomBytes(n).toString('hex');

export interface Listener {
  readonly server: net.Server;
  readonly port: number;
  connections: number;
}

export async function listen(host: string): Promise<Listener> {
  const listener = { connections: 0 } as Listener;
  const server = net.createServer((socket) => {
    listener.connections++;
    socket.destroy();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, resolve);
    });
    return Object.assign(listener, { server, port: (server.address() as net.AddressInfo).port });
  } catch {
    server.close();
    throw new Error('Boundary listener unavailable');
  }
}

export function lanAddress(): string {
  for (const list of Object.values(os.networkInterfaces()))
    for (const entry of list ?? [])
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  throw new Error('No LAN interface for boundary measurement');
}

export interface PlantedCanaries {
  readonly canaries: readonly string[];
  readonly targets: Record<string, unknown>;
  readonly loopback: Listener;
  readonly lan: Listener;
  connections(): number;
  cleanup(): void;
}

/** Transactional setup: even a failed second listener leaves no first listener,
 * environment variable or planted home. Values never travel into guest targets. */
export async function plantCanaries(): Promise<PlantedCanaries> {
  const envName = `ZT_CANARY_${hex(8).toUpperCase()}`;
  const envCanary = `zt-env-${hex(16)}`;
  const fileCanary = `zt-file-${hex(16)}`;
  let hostHome: string | undefined;
  let loopback: Listener | undefined;
  let lan: Listener | undefined;
  const cleanup = () => {
    loopback?.server.close();
    lan?.server.close();
    delete process.env[envName];
    if (hostHome) fs.rmSync(hostHome, { recursive: true, force: true });
  };
  try {
    process.env[envName] = envCanary;
    hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-boundary-home-'));
    const hostFile = path.join(hostHome, '.zt-canary-secret');
    fs.writeFileSync(hostFile, fileCanary, { mode: 0o600 });
    loopback = await listen('127.0.0.1');
    const lanHost = lanAddress();
    lan = await listen(lanHost);
    const listeners = [loopback, lan];
    return {
      canaries: [envCanary, fileCanary],
      targets: {
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
      },
      loopback,
      lan,
      connections: () => listeners.reduce((n, listener) => n + listener.connections, 0),
      cleanup,
    };
  } catch {
    cleanup();
    throw new Error('Boundary preparation failed');
  }
}

export async function rejectedByBroker(work: () => unknown): Promise<boolean> {
  try {
    await work();
  } catch (error) {
    return error instanceof BrokerError;
  }
  return false;
}

export function rootProbeArgv(phase: string): string[] {
  return [
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
    phase,
  ];
}

/** Opaque, one-shot session. artifactPath is local controller storage, not guest data. */
export interface BoundarySession {
  readonly artifactPath: string;
  /** Call in the controller's finally even when adapter.create fails. */
  cleanup(): void;
}
interface SessionState {
  planted: PlantedCanaries;
  output: OutputCollector;
  reports: ReturnType<typeof parseReports>['reports'];
  brokerChecks: { attempt: string; rejected: boolean }[];
  malformed: number;
  started: boolean;
  complete: boolean;
  closed: boolean;
  finished: boolean;
  vm?: VmHandle;
}
const SESSIONS = new WeakMap<BoundarySession, SessionState>();

/** Prepare BEFORE adapter.create. Supply RunStore.storeDirectory('artifacts') to
 * retain evidence in the run store; otherwise allocate private temporary storage. */
export async function prepareBoundary(artifactsDir?: string): Promise<BoundarySession> {
  const planted = await plantCanaries();
  try {
    if (artifactsDir) assertDirectoryAncestors(artifactsDir);
    const directory = privateDir(
      artifactsDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'zt-boundary-evidence-'))
    );
    const state: SessionState = {
      planted,
      output: new OutputCollector(),
      reports: [],
      brokerChecks: [],
      malformed: 0,
      started: false,
      complete: false,
      closed: false,
      finished: false,
    };
    const session: BoundarySession = Object.freeze({
      artifactPath: path.join(directory, `boundary-${hex(16)}.json`),
      cleanup() {
        if (!state.closed) {
          state.closed = true;
          planted.cleanup();
        }
      },
    });
    SESSIONS.set(session, state);
    return session;
  } catch {
    planted.cleanup();
    throw new Error('Boundary evidence storage unavailable');
  }
}

function sessionState(session: BoundarySession): SessionState {
  const state = SESSIONS.get(session);
  if (!state) throw new Error('Unknown boundary session');
  return state;
}

const FIXTURES = path.join(__dirname, '..', '..', 'fixtures', 'hostile');
const PHASES: Record<string, readonly string[]> = {
  'npm-lifecycle': ['node-preinstall', 'node-postinstall', 'node-test'],
  'pip-setup': ['python-install', 'python-test'],
};

/** Execute only after endProvisioning. Every command explicitly has no network.
 * The adapter independently refuses package-proxy use after that transition. */
export async function probeBoundary(
  session: BoundarySession,
  adapter: VmAdapter,
  vm: VmHandle,
  profile: ContainerProfile
): Promise<void> {
  const state = sessionState(session);
  if (
    state.started ||
    state.closed ||
    vm.scope !== 'container' ||
    !['node', 'python'].includes(profile)
  ) {
    session.cleanup();
    throw new Error('Boundary session not probeable');
  }
  state.started = true;
  state.vm = { ...vm };
  async function upload(fixture: string) {
    for (const name of fs.readdirSync(path.join(FIXTURES, fixture)))
      await adapter.putFile(
        vm,
        `${fixture}/${name}`,
        fs.readFileSync(path.join(FIXTURES, fixture, name))
      );
    await adapter.putFile(
      vm,
      `${fixture}/targets.json`,
      Buffer.from(JSON.stringify(state.planted.targets))
    );
  }
  async function run(container: ContainerProfile, fixture: string, argv: string[]) {
    const result = await adapter.exec(vm, {
      profile: container,
      argv,
      cwd: fixture,
      network: 'none',
    });
    state.output.append(result.stdout);
    state.output.append(result.stderr);
    state.output.append(result.report);
    const parsed = parseReports(`${result.stdout}\n${result.stderr}`);
    state.malformed += parsed.malformed;
    state.reports.push(...parsed.reports);
    if (result.exitCode !== 0 || result.timedOut || result.truncated)
      throw new Error('Boundary probe incomplete');
  }
  async function collect(fixture: string, probe: string) {
    for (const phase of PHASES[fixture]) {
      const bytes = await adapter.getFile(vm, `${fixture}/results/${phase}.json`);
      state.output.append(bytes);
      try {
        const report = parseReport(JSON.parse(bytes.toString('utf8')));
        if (report.probe !== probe || report.phase !== phase.slice(probe.length + 1))
          throw new Error('Wrong boundary report');
        state.reports.push(report);
      } catch {
        state.malformed++;
      }
    }
  }
  async function rejected(attempt: string, work: () => unknown) {
    state.brokerChecks.push({
      attempt,
      rejected: await rejectedByBroker(async () => {
        const value = await work();
        if (Buffer.isBuffer(value)) state.output.append(value);
        else if (value && typeof value === 'object' && 'stdout' in value && 'stderr' in value) {
          const result = value as Awaited<ReturnType<VmAdapter['exec']>>;
          state.output.append(result.stdout);
          state.output.append(result.stderr);
          state.output.append(result.report);
        }
      }),
    });
  }
  try {
    await upload('npm-lifecycle');
    await run('node', 'npm-lifecycle', [
      'npm',
      'install',
      '--offline',
      '--no-audit',
      '--no-fund',
      '--foreground-scripts',
    ]);
    await run('node', 'npm-lifecycle', ['npm', 'test']);
    await collect('npm-lifecycle', 'node');
    if (profile === 'python') {
      await upload('pip-setup');
      await run('python', 'pip-setup', [
        'sh',
        '-c',
        'python3 -m venv --system-site-packages /tmp/venv && /tmp/venv/bin/pip install -v --no-index --no-deps --no-build-isolation .',
      ]);
      await run('python', 'pip-setup', ['python3', '-m', 'unittest', '-v', 'test_witness']);
      await collect('pip-setup', 'python');
    }
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
    state.complete = true;
  } catch {
    state.malformed++;
    session.cleanup();
    throw new Error('Boundary probe failed');
  }
}

/** Finish AFTER the last guest output for this VM. Always cleans up, including
 * collector truncation, wrong identity, secret detection and publication errors.
 * A failed/unstarted session produces failed evidence, never a clean verdict. */
export function finishBoundary(
  session: BoundarySession,
  collector: OutputCollector,
  runId: string
): BoundaryInput {
  const state = sessionState(session);
  try {
    if (state.finished) throw new Error('Boundary session already finished');
    state.finished = true;
    const outputs = [...state.output.outputs(), ...collector.outputs()];
    // Also scan consecutive chunks: a guest can split an encoding between reads.
    const input: BoundaryInput = {
      reports: state.reports,
      guestOutputs: [...outputs, outputs.join('')],
      canaries: state.planted.canaries,
      listenerConnections: state.planted.connections(),
      brokerChecks: state.brokerChecks,
      malformedReports:
        state.malformed +
        (!state.complete || state.closed || !runId || state.vm?.runId !== runId ? 1 : 0),
      runId,
    };
    // Scan strings before JSON escapes whitespace. Raw secret-bearing evidence
    // cannot be persisted; the controller must block rather than lose bytes.
    assertSecretFree(input);
    const bytes = Buffer.from(`${JSON.stringify(input)}\n`);
    publishPrivate(session.artifactPath, bytes);
    return JSON.parse(bytes.toString('utf8')) as BoundaryInput;
  } finally {
    session.cleanup();
  }
}

/** One bad VM fails the run, even if another VM supplies its missing categories.
 * Recompute from persisted inputs; never fabricate BoundaryEvidence. */
export function runBoundaryVerdict(inputs: readonly BoundaryInput[], runId: string) {
  return evaluateBoundary({
    reports: inputs.flatMap((input) => [...input.reports]),
    guestOutputs: inputs.flatMap((input) => [...input.guestOutputs, input.guestOutputs.join('')]),
    canaries: inputs.flatMap((input) => [...input.canaries]),
    listenerConnections: inputs.reduce((n, input) => n + input.listenerConnections, 0),
    brokerChecks: inputs.flatMap((input) => [...input.brokerChecks]),
    malformedReports: inputs.reduce(
      (n, input) =>
        n +
        input.malformedReports +
        (input.runId !== runId ||
        !runId ||
        !evaluateBoundary({ ...input, requiredCategories: undefined }).held
          ? 1
          : 0),
      inputs.length === 0 ? 1 : 0
    ),
    runId,
  });
}
