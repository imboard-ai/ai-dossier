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
import { MAX_FILE_BYTES, validateRequest } from './broker';
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

/** Controller-defined context only: never an underlying guest/OS error message. */
export class BoundaryOperationError extends Error {
  constructor(
    readonly stage: string,
    readonly code: string
  ) {
    super(`Boundary operation failed (${stage}/${code})`);
    this.name = 'BoundaryOperationError';
  }
}

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
    let failed = false;
    for (const listener of [loopback, lan]) {
      try {
        if (listener?.server.listening) listener.server.close();
      } catch {
        failed = true;
      }
    }
    delete process.env[envName];
    try {
      if (hostHome) fs.rmSync(hostHome, { recursive: true, force: true });
    } catch {
      failed = true;
    }
    if (failed) throw new BoundaryOperationError('cleanup', 'resources_remaining');
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

const HOST_REJECTIONS = [
  'invalid_op',
  'invalid_path',
  'invalid_data',
  'invalid_profile',
  'invalid_argv',
];
export async function rejectedByBroker(
  work: () => unknown,
  expectedCode?: string
): Promise<boolean> {
  try {
    await work();
  } catch (error) {
    return (
      error instanceof BrokerError &&
      (expectedCode === undefined
        ? HOST_REJECTIONS.includes(error.code)
        : error.code === expectedCode)
    );
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
  cleaned: boolean;
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
      cleaned: false,
      finished: false,
    };
    const session: BoundarySession = Object.freeze({
      artifactPath: path.join(directory, `boundary-${hex(16)}.json`),
      cleanup() {
        state.closed = true;
        if (!state.cleaned) {
          planted.cleanup();
          state.cleaned = true;
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
export const BOUNDARY_PHASES: Record<string, readonly string[]> = {
  'npm-lifecycle': ['node-preinstall', 'node-postinstall', 'node-test'],
  'pip-setup': ['python-install', 'python-test'],
};

/** Shared by production and the assumed-escape gate, from trusted fixture files. */
export async function uploadBoundaryFixture(
  adapter: VmAdapter,
  vm: VmHandle,
  fixture: string,
  targets: Record<string, unknown>
) {
  if (!Object.hasOwn(BOUNDARY_PHASES, fixture))
    throw new BoundaryOperationError('upload', 'unknown_fixture');
  for (const name of fs.readdirSync(path.join(FIXTURES, fixture)))
    await adapter.putFile(
      vm,
      `${fixture}/${name}`,
      fs.readFileSync(path.join(FIXTURES, fixture, name))
    );
  await adapter.putFile(vm, `${fixture}/targets.json`, Buffer.from(JSON.stringify(targets)));
}

const BROKER_ATTEMPTS = [
  'op-outside-set',
  'put-traversal',
  'put-absolute',
  'put-oversize',
  'get-traversal',
  'exec-unknown-profile',
  'exec-oversize-argv',
];

/** Host refusal must have the exact validation code; guest/transport errors fail. */
export async function boundaryBrokerChecks(
  adapter: VmAdapter,
  vm: VmHandle,
  capture: (value: unknown) => void = () => {}
) {
  const attempts: [string, () => unknown][] = [
    ['invalid_op', () => validateRequest({ op: 'shell' } as never)],
    ['invalid_path', () => adapter.putFile(vm, '../escape', Buffer.from('x'))],
    ['invalid_path', () => adapter.putFile(vm, '/etc/passwd', Buffer.from('x'))],
    ['invalid_data', () => adapter.putFile(vm, 'big.bin', Buffer.alloc(MAX_FILE_BYTES + 1))],
    ['invalid_path', () => adapter.getFile(vm, '../../etc/shadow')],
    [
      'invalid_profile',
      () => adapter.exec(vm, { profile: 'host' as ContainerProfile, argv: ['true'] }),
    ],
    [
      'invalid_argv',
      () => adapter.exec(vm, { profile: 'node', argv: Array(9).fill('a'.repeat(8000)) }),
    ],
  ];
  const checks: { attempt: string; rejected: boolean }[] = [];
  for (const [index, [code, work]] of attempts.entries())
    checks.push({
      attempt: BROKER_ATTEMPTS[index],
      rejected: await rejectedByBroker(async () => capture(await work()), code),
    });
  return checks;
}

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
  let stage = 'upload';
  async function upload(fixture: string) {
    stage = `upload-${fixture}`;
    await uploadBoundaryFixture(adapter, vm, fixture, state.planted.targets);
  }
  async function run(container: ContainerProfile, fixture: string, argv: string[]) {
    stage = `exec-${fixture}`;
    const result = await adapter.exec(vm, {
      profile: container,
      argv,
      cwd: fixture,
      network: 'none',
    });
    state.output.append(result.stdout);
    state.output.append(result.stderr);
    state.output.append(result.report);
    if (result.exitCode !== 0 || result.timedOut || result.truncated)
      throw new BoundaryOperationError(
        stage,
        result.truncated ? 'truncated' : result.timedOut ? 'timeout' : 'command_failed'
      );
  }
  async function collect(fixture: string, probe: string) {
    stage = `collect-${fixture}`;
    for (const phase of BOUNDARY_PHASES[fixture]) {
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
  function capture(value: unknown) {
    if (Buffer.isBuffer(value)) state.output.append(value);
    else if (value && typeof value === 'object' && 'stdout' in value && 'stderr' in value) {
      const result = value as Awaited<ReturnType<VmAdapter['exec']>>;
      state.output.append(result.stdout);
      state.output.append(result.stderr);
      state.output.append(result.report);
    }
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
    stage = 'broker';
    state.brokerChecks = await boundaryBrokerChecks(adapter, vm, capture);
    state.complete = true;
  } catch (error) {
    state.malformed++;
    session.cleanup();
    throw error instanceof BoundaryOperationError
      ? error
      : new BoundaryOperationError(stage, 'unavailable');
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
    const markers = parseReports(outputs.join(''));
    const reports = [
      ...new Map(
        [...state.reports, ...markers.reports].map((report) => [JSON.stringify(report), report])
      ).values(),
    ];
    // Also scan consecutive chunks: a guest can split an encoding between reads.
    const input: BoundaryInput = {
      reports,
      guestOutputs: [...outputs, outputs.join('')],
      canaries: state.planted.canaries,
      listenerConnections: state.planted.connections(),
      brokerChecks: state.brokerChecks,
      malformedReports:
        state.malformed +
        markers.malformed +
        (!state.complete || state.closed || !runId || state.vm?.runId !== runId ? 1 : 0),
      runId,
    };
    // Scan strings before JSON escapes whitespace. Raw secret-bearing evidence
    // cannot be persisted; the controller must block rather than lose bytes.
    assertSecretFree(input);
    const bytes = Buffer.from(`${JSON.stringify(input)}\n`);
    // No clean authoritative artifact exists until all host resources are removed.
    session.cleanup();
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
        (Number.isSafeInteger(input.malformedReports) && input.malformedReports >= 0
          ? input.malformedReports
          : 1) +
        (input.runId !== runId ||
        !runId ||
        input.canaries.length !== 2 ||
        input.canaries.some((canary) => canary.length < 16) ||
        new Set(input.canaries).size !== 2 ||
        input.brokerChecks.length !== BROKER_ATTEMPTS.length ||
        BROKER_ATTEMPTS.some(
          (attempt) =>
            input.brokerChecks.filter(
              (check) => check.attempt === attempt && check.rejected === true
            ).length !== 1
        ) ||
        !Number.isSafeInteger(input.listenerConnections) ||
        input.listenerConnections < 0 ||
        !evaluateBoundary({ ...input, requiredCategories: undefined }).held
          ? 1
          : 0),
      inputs.length === 0 ? 1 : 0
    ),
    runId,
  });
}
