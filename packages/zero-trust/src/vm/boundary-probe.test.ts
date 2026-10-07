import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutputCollector } from '../controller/output-collector';
import type { ContainerProfile, ExecRequest, ExecResult, VmAdapter, VmHandle } from './adapter';
import {
  finishBoundary,
  lanAddress,
  listen,
  plantCanaries,
  prepareBoundary,
  probeBoundary,
  rejectedByBroker,
  rootProbeArgv,
  runBoundaryVerdict,
} from './boundary-probe';
import { assertWorkspacePath, validateExecArgv, validateRequest } from './broker';
import {
  ATTACK_CATEGORIES,
  type BoundaryInput,
  isCleanHeldVerdict,
  REPORT_MARKER,
} from './evidence';

const VM: VmHandle = {
  vmId: 'vm-one',
  runId: 'run-one',
  scope: 'container',
  accelerator: 'kvm',
  profileDigest: 'digest',
};
const RESULT: ExecResult = {
  exitCode: 0,
  timedOut: false,
  stdout: '',
  stderr: '',
  truncated: false,
  durationMs: 1,
};
const dirs: string[] = [];
const sessions: { cleanup(): void }[] = [];
function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-boundary-test-'));
  dirs.push(dir);
  return dir;
}
function report(probe = 'node', phase = 'test') {
  return {
    probe,
    phase,
    records: ATTACK_CATEGORIES.map((category) => ({
      category,
      attempt: 'attempt',
      outcome: 'denied',
    })),
  };
}

/** Recording adapter, with production request validation; no guest or external network. */
class ProbeFake implements VmAdapter {
  targets: Record<string, string> = {};
  calls: ExecRequest[] = [];
  files = new Map<string, Buffer>();
  acceptAbuse = false;
  result = { ...RESULT };
  reportText: (probe: string, phase: string) => string = (probe, phase) =>
    JSON.stringify(report(probe, phase));
  async create() {
    return VM;
  }
  async endProvisioning() {}
  async destroy() {}
  async listByRun() {
    return [];
  }
  async putFile(_vm: VmHandle, name: string, bytes: Buffer) {
    if (!this.acceptAbuse)
      validateRequest({ op: 'put', path: name, data: bytes.toString('base64'), executable: false });
    this.files.set(name, bytes);
    if (name.endsWith('targets.json')) this.targets = JSON.parse(bytes.toString('utf8'));
  }
  async getFile(_vm: VmHandle, name: string) {
    if (!this.acceptAbuse) assertWorkspacePath(name);
    const match = /\/(node|python)-(.*)\.json$/.exec(name);
    return match ? Buffer.from(this.reportText(match[1], match[2])) : Buffer.from('accepted');
  }
  async exec(_vm: VmHandle, request: ExecRequest) {
    if (!this.acceptAbuse) validateExecArgv(request.profile, request.argv);
    this.calls.push(request);
    return this.result;
  }
}

beforeEach(() => {
  // Use real local sockets but never depend on the host's LAN identity.
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    test: [
      { address: '127.0.0.1', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null },
    ],
  });
});
afterEach(() => {
  for (const session of sessions.splice(0)) session.cleanup();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
async function prepared() {
  const session = await prepareBoundary(directory());
  sessions.push(session);
  return session;
}
async function input(
  fake = new ProbeFake(),
  profile: ContainerProfile = 'node',
  output = new OutputCollector()
) {
  const session = await prepared();
  await probeBoundary(session, fake, VM, profile);
  return { input: finishBoundary(session, output, VM.runId), session, fake };
}

describe('production boundary lifecycle', () => {
  it.each([
    'node',
    'python',
  ] as const)('probes %s offline and persists recomputable private evidence', async (profile) => {
    const { input: evidence, session, fake } = await input(new ProbeFake(), profile);
    const verdict = runBoundaryVerdict([evidence], VM.runId);
    expect(isCleanHeldVerdict(verdict)).toBe(true);
    expect(verdict.runId).toBe(VM.runId);
    expect(fake.calls.every((call) => call.network === 'none')).toBe(true);
    expect(fake.calls.map((call) => call.profile)).toEqual(
      profile === 'node' ? ['node', 'node'] : ['node', 'node', 'python', 'python']
    );
    expect(fake.files.has('npm-lifecycle/probe.js')).toBe(true);
    expect(fake.files.has('pip-setup/witness.py')).toBe(profile === 'python');
    expect(evidence.brokerChecks).toHaveLength(7);
    const persisted = JSON.parse(fs.readFileSync(session.artifactPath, 'utf8')) as BoundaryInput;
    expect(runBoundaryVerdict([persisted], VM.runId)).toEqual(verdict);
    expect(fs.statSync(session.artifactPath).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(fake.targets.hostFile)).toBe(false);
    expect(process.env[fake.targets.envName]).toBeUndefined();
    expect(() => finishBoundary(session, new OutputCollector(), VM.runId)).toThrow(
      'already finished'
    );
  });

  it.each([
    'raw',
    'hex',
    'base64',
    'split',
  ] as const)('fails on %s canary bytes in later collector output', async (form) => {
    const fake = new ProbeFake();
    const session = await prepared();
    await probeBoundary(session, fake, VM, 'node');
    const canary = process.env[fake.targets.envName] as string;
    const collector = new OutputCollector();
    const text =
      form === 'hex'
        ? Buffer.from(canary).toString('hex')
        : form === 'base64'
          ? Buffer.from(canary).toString('base64')
          : canary;
    if (form === 'split') {
      collector.append(text.slice(0, 15));
      collector.append(text.slice(15));
    } else collector.append(text);
    const evidence = finishBoundary(session, collector, VM.runId);
    expect(runBoundaryVerdict([evidence], VM.runId).held).toBe(false);
    expect(runBoundaryVerdict([evidence, { ...evidence, runId: 'other' }], VM.runId).held).toBe(
      false
    );
  });

  it('fails the run when only its second VM leaks and preserves the run ID', async () => {
    const first = (await input()).input;
    const second = { ...first, guestOutputs: [first.canaries[0]] };
    expect(runBoundaryVerdict([first, second], VM.runId)).toMatchObject({
      held: false,
      runId: VM.runId,
    });
  });

  it('measures listener connections and removes host resources', async () => {
    const fake = new ProbeFake();
    const session = await prepared();
    await probeBoundary(session, fake, VM, 'node');
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(Number(fake.targets.loopbackPort), '127.0.0.1');
      socket.on('error', reject);
      socket.on('close', () => resolve());
    });
    const evidence = finishBoundary(session, new OutputCollector(), VM.runId);
    expect(evidence.listenerConnections).toBe(1);
    expect(runBoundaryVerdict([evidence], VM.runId).held).toBe(false);
  });

  it.each([
    'non-denied',
    'malformed',
    'missing-category',
    'wrong-phase',
    'stdout-breach',
    'stderr-malformed',
    'accepted-broker',
  ])('fails closed on %s', async (fault) => {
    const fake = new ProbeFake();
    if (fault === 'accepted-broker') fake.acceptAbuse = true;
    if (fault === 'stdout-breach')
      fake.result.stdout = `${REPORT_MARKER}${JSON.stringify({ ...report(), records: [{ category: 'lan', attempt: 'connect', outcome: 'succeeded' }] })}`;
    if (fault === 'stderr-malformed') fake.result.stderr = `${REPORT_MARKER}{bad`;
    fake.reportText = (probe, phase) => {
      const value = report(probe, phase);
      if (fault === 'malformed') return 'not json';
      if (fault === 'non-denied') value.records[0].outcome = 'succeeded';
      if (fault === 'missing-category')
        value.records = value.records.filter((record) => record.category !== 'dns');
      if (fault === 'wrong-phase') value.phase = 'other';
      return JSON.stringify(value);
    };
    expect(runBoundaryVerdict([(await input(fake)).input], VM.runId).held).toBe(false);
  });

  it.each([
    'exit',
    'timeout',
    'truncated',
    'file',
    'upload',
  ] as const)('cleans up on probe %s failure', async (fault) => {
    const fake = new ProbeFake();
    if (fault === 'exit') fake.result.exitCode = 1;
    if (fault === 'timeout') fake.result.timedOut = true;
    if (fault === 'truncated') fake.result.truncated = true;
    if (fault === 'file') vi.spyOn(fake, 'getFile').mockRejectedValue(new Error('guest failure'));
    if (fault === 'upload') vi.spyOn(fake, 'putFile').mockRejectedValue(new Error('guest failure'));
    const session = await prepared();
    await expect(probeBoundary(session, fake, VM, 'node')).rejects.toThrow('Boundary probe failed');
    expect(Object.keys(process.env).filter((key) => key.startsWith('ZT_CANARY_'))).toEqual([]);
    expect(
      runBoundaryVerdict([finishBoundary(session, new OutputCollector(), VM.runId)], VM.runId).held
    ).toBe(false);
  });

  it('cleans up even if collector truncation, secret output or persistence prevents finishing', async () => {
    for (const fault of ['collector', 'secret', 'storage']) {
      const fake = new ProbeFake();
      const session = await prepared();
      await probeBoundary(session, fake, VM, 'node');
      const collector = new OutputCollector(fault === 'collector' ? 1 : 1000);
      collector.append(fault === 'secret' ? `ghp_${'x'.repeat(40)}` : 'hello');
      if (fault === 'storage')
        fs.writeFileSync(session.artifactPath, 'conflicting input', { mode: 0o600 });
      expect(() => finishBoundary(session, collector, VM.runId)).toThrow();
      expect(fs.existsSync(fake.targets.hostFile)).toBe(false);
      expect(process.env[fake.targets.envName]).toBeUndefined();
    }
  });

  it('rejects reuse, wrong profile/scope, wrong run, unprobed and early closed sessions', async () => {
    const fake = new ProbeFake();
    const session = await prepared();
    await probeBoundary(session, fake, VM, 'node');
    expect(
      runBoundaryVerdict([finishBoundary(session, new OutputCollector(), 'wrong')], VM.runId).held
    ).toBe(false);
    await expect(probeBoundary(session, fake, VM, 'node')).rejects.toThrow('not probeable');
    for (const vm of [{ ...VM, scope: 'vm-root' as const }, VM]) {
      const other = await prepared();
      await expect(probeBoundary(other, fake, vm, 'host' as ContainerProfile)).rejects.toThrow(
        'not probeable'
      );
    }
    const unprobed = await prepared();
    expect(
      runBoundaryVerdict([finishBoundary(unprobed, new OutputCollector(), VM.runId)], VM.runId).held
    ).toBe(false);
    const closed = await prepared();
    await probeBoundary(closed, fake, VM, 'node');
    closed.cleanup();
    expect(
      runBoundaryVerdict([finishBoundary(closed, new OutputCollector(), VM.runId)], VM.runId).held
    ).toBe(false);
    expect(() =>
      finishBoundary({ artifactPath: '', cleanup() {} }, new OutputCollector(), VM.runId)
    ).toThrow('Unknown');
  });

  it('does not let clean coverage mask an incomplete second VM or weaker categories', async () => {
    const first = (await input()).input;
    const second = { ...first, reports: [], brokerChecks: [], requiredCategories: [] };
    expect(runBoundaryVerdict([first, second], VM.runId).held).toBe(false);
    expect(runBoundaryVerdict([], VM.runId).held).toBe(false);
    expect(runBoundaryVerdict([first], '').held).toBe(false);
  });
});

describe('host helpers', () => {
  it('plants fresh secrets without including their values in targets', async () => {
    const planted = await plantCanaries();
    sessions.push(planted);
    expect(
      planted.canaries.every((value) => !JSON.stringify(planted.targets).includes(value))
    ).toBe(true);
    expect(fs.readFileSync(String(planted.targets.hostFile), 'utf8')).toBe(planted.canaries[1]);
    expect(fs.statSync(String(planted.targets.hostFile)).mode & 0o777).toBe(0o600);
    planted.cleanup();
    planted.cleanup();
    expect(planted.loopback.server.listening).toBe(false);
    expect(planted.lan.server.listening).toBe(false);
  });
  it('cleans partial planting after LAN lookup, second listener or file failure', async () => {
    const originalWrite = fs.writeFileSync;
    const originalListen = net.Server.prototype.listen;
    for (const fault of ['lan', 'listener', 'file']) {
      if (fault === 'lan') vi.mocked(os.networkInterfaces).mockReturnValue({ internal: [] });
      if (fault === 'file')
        vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
          throw new Error('write failure');
        });
      if (fault === 'listener') {
        let calls = 0;
        vi.spyOn(net.Server.prototype, 'listen').mockImplementation(function (
          this: net.Server,
          ...args: Parameters<net.Server['listen']>
        ) {
          if (++calls === 2) throw new Error('listen failure');
          return originalListen.apply(this, args);
        });
      }
      await expect(plantCanaries()).rejects.toThrow('Boundary preparation failed');
      expect(Object.keys(process.env).filter((key) => key.startsWith('ZT_CANARY_'))).toEqual([]);
      vi.spyOn(fs, 'writeFileSync').mockImplementation(originalWrite);
      vi.spyOn(net.Server.prototype, 'listen').mockImplementation(originalListen);
      vi.mocked(os.networkInterfaces).mockReturnValue({
        test: [
          {
            address: '127.0.0.1',
            family: 'IPv4',
            internal: false,
            netmask: '',
            mac: '',
            cidr: null,
          },
        ],
      });
    }
  });
  it('refuses unavailable storage and cleans canaries', async () => {
    const dir = directory();
    const file = path.join(dir, 'file');
    fs.writeFileSync(file, 'not a directory');
    await expect(prepareBoundary(file)).rejects.toThrow('storage unavailable');
    expect(Object.keys(process.env).filter((key) => key.startsWith('ZT_CANARY_'))).toEqual([]);
  });
  it('allocates private default artifact storage', async () => {
    const session = await prepareBoundary();
    sessions.push(session);
    dirs.push(path.dirname(session.artifactPath));
    expect(fs.statSync(path.dirname(session.artifactPath)).mode & 0o777).toBe(0o700);
  });
  it('reports only BrokerError as a rejection and keeps root argv fixed', async () => {
    expect(await rejectedByBroker(() => validateRequest({ op: 'shell' } as never))).toBe(true);
    expect(
      await rejectedByBroker(() => {
        throw new Error('transport');
      })
    ).toBe(false);
    expect(await rejectedByBroker(() => 0)).toBe(false);
    expect(rootProbeArgv('vm-root')).toContain('vm-root');
    vi.mocked(os.networkInterfaces).mockReturnValue({
      empty: undefined,
      v6: [
        {
          address: '::1',
          family: 'IPv6',
          internal: true,
          netmask: '',
          mac: '',
          cidr: null,
          scopeid: 0,
        },
      ],
    });
    expect(() => lanAddress()).toThrow('No LAN');
    await expect(listen('not-an-address')).rejects.toThrow('Boundary listener unavailable');
  });
});
