import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutputCollector } from '../controller/output-collector';
import {
  BrokerError,
  type ContainerProfile,
  type ExecRequest,
  type ExecResult,
  type VmAdapter,
  type VmHandle,
} from './adapter';
import {
  boundaryBrokerChecks,
  boundaryCommands,
  finishBoundary,
  lanAddress,
  listen,
  plantCanaries,
  prepareBoundary,
  probeBoundary,
  rejectedByBroker,
  rootProbeArgv,
  runBoundaryVerdict,
  uploadBoundaryFixture,
} from './boundary-probe';
import {
  assertWorkspacePath,
  BROKER_PROTOCOL,
  BrokerClient,
  validateExecArgv,
  validateRequest,
} from './broker';
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
  return { input: await finishBoundary(session, output, VM.runId), session, fake };
}

describe('production boundary lifecycle', () => {
  it('retains indexed per-VM diagnostics even when another VM masks missing coverage', async () => {
    const clean = (await input()).input;
    const incomplete = {
      ...clean,
      reports: clean.reports.map((report) => ({
        ...report,
        records: report.records.filter((record) => record.category !== 'dns'),
      })),
    };
    const verdict = runBoundaryVerdict([clean, incomplete], VM.runId);
    expect(verdict.held).toBe(false);
    expect(verdict.violations.join(' ')).toContain('input-1: missing coverage: dns');
    expect(
      runBoundaryVerdict([clean, { ...clean, runId: 'other' }], VM.runId).violations.join(' ')
    ).toContain('input-1: wrong run identity');
  });

  it('returns detached trusted command descriptors for the gate and both profiles', () => {
    const node = boundaryCommands('node');
    expect(node.map((command) => command.timing)).toEqual(['npmInstallMs', 'npmTestMs']);
    node[0].argv[0] = 'mutated';
    expect(boundaryCommands('node')[0].argv[0]).toBe('npm');
    expect(boundaryCommands('python').map((command) => command.timing)).toEqual([
      'npmInstallMs',
      'npmTestMs',
      'pipInstallMs',
      'pipTestMs',
    ]);
  });
  it.each([1, 2])('records a queued child handshake before finalizing %i VM(s)', async (count) => {
    const inputs: BoundaryInput[] = [];
    for (let index = 0; index < count; index++) {
      const fake = new ProbeFake();
      const session = await prepared();
      await probeBoundary(session, fake, VM, 'node');
      if (index === count - 1) {
        // Block the parent's event loop while the real child completes the handshake.
        const child = spawnSync(
          process.execPath,
          [
            '-e',
            "const s=require('node:net').connect(Number(process.argv[1]),'127.0.0.1');s.on('connect',()=>{process.stdout.write('CONNECTED');s.destroy()});s.on('error',()=>process.exit(1));",
            fake.targets.loopbackPort,
          ],
          { timeout: 3000 }
        );
        expect(child.status).toBe(0);
        expect(child.stdout.toString()).toBe('CONNECTED');
      }
      const evidence = await finishBoundary(session, new OutputCollector(), VM.runId);
      inputs.push(evidence);
      if (index === count - 1) expect(evidence.listenerConnections).toBeGreaterThan(0);
    }
    expect(runBoundaryVerdict(inputs, VM.runId)).toMatchObject({ held: false, runId: VM.runId });
  });

  it('fails closed when listener close does not acknowledge shutdown', async () => {
    const fake = new ProbeFake();
    const session = await prepared();
    await probeBoundary(session, fake, VM, 'node');
    const original = net.Server.prototype.close;
    vi.spyOn(net.Server.prototype, 'close').mockImplementation(function (this: net.Server) {
      return original.call(this); // Actually release sockets, but withhold acknowledgement.
    });
    const evidence = await finishBoundary(session, new OutputCollector(), VM.runId, {
      timeoutMs: 30,
    });
    expect(runBoundaryVerdict([evidence], VM.runId).held).toBe(false);
  });

  it.each([
    'quiesce-error',
    'quiesce-timeout',
    'connections-error',
    'connections-timeout',
    'close-error',
    'invalid-timeout',
  ] as const)('fails closed with a controller reason on %s', async (fault) => {
    const fake = new ProbeFake();
    const session = await prepared();
    await probeBoundary(session, fake, VM, 'node');
    if (fault === 'quiesce-error')
      vi.spyOn(fake, 'destroy').mockRejectedValue(new Error('untrusted failure'));
    if (fault === 'quiesce-timeout')
      vi.spyOn(fake, 'destroy').mockImplementation(() => new Promise(() => {}));
    if (fault === 'connections-error')
      vi.spyOn(net.Server.prototype, 'getConnections').mockImplementation(function (
        this: net.Server,
        callback
      ) {
        callback(new Error('untrusted failure'), 0);
        return this;
      });
    if (fault === 'connections-timeout')
      vi.spyOn(net.Server.prototype, 'getConnections').mockImplementation(function (
        this: net.Server
      ) {
        return this;
      });
    if (fault === 'close-error') {
      const original = net.Server.prototype.close;
      vi.spyOn(net.Server.prototype, 'close').mockImplementation(function (
        this: net.Server,
        callback
      ) {
        return original.call(this, () => callback?.(new Error('untrusted failure')));
      });
    }
    const evidence = await finishBoundary(session, new OutputCollector(), VM.runId, {
      timeoutMs: fault === 'invalid-timeout' ? 0 : 30,
    });
    const verdict = runBoundaryVerdict([evidence], VM.runId);
    expect(verdict.held).toBe(false);
    expect(verdict.violations.join(' ')).toMatch(/controller\/finalize/);
    expect(JSON.stringify(evidence)).not.toContain('untrusted failure');
    expect(fs.existsSync(fake.targets.hostFile)).toBe(false);
  });

  it('awaits guest exit and both native counts and close acknowledgements before publication', async () => {
    const fake = new ProbeFake();
    const session = await prepared();
    await probeBoundary(session, fake, VM, 'node');
    const events: string[] = [];
    let exit: () => void = () => {};
    vi.spyOn(fake, 'destroy').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          events.push('stop-request');
          exit = () => {
            events.push('exit');
            resolve();
          };
        })
    );
    const getConnections = net.Server.prototype.getConnections;
    vi.spyOn(net.Server.prototype, 'getConnections').mockImplementation(function (
      this: net.Server,
      callback
    ) {
      events.push('count');
      return getConnections.call(this, callback);
    });
    const close = net.Server.prototype.close;
    const acknowledgements: (() => void)[] = [];
    vi.spyOn(net.Server.prototype, 'close').mockImplementation(function (
      this: net.Server,
      callback
    ) {
      events.push('close');
      return close.call(this, (error) =>
        acknowledgements.push(() => {
          events.push('ack');
          callback?.(error);
        })
      );
    });
    const finishing = finishBoundary(session, new OutputCollector(), VM.runId);
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(['stop-request']);
    expect(fs.existsSync(session.artifactPath)).toBe(false);
    exit();
    for (let n = 0; n < 10 && acknowledgements.length < 2; n++)
      await new Promise((resolve) => setImmediate(resolve));
    expect(acknowledgements).toHaveLength(2);
    expect(events.indexOf('count')).toBeGreaterThan(events.indexOf('exit'));
    expect(fs.existsSync(session.artifactPath)).toBe(false);
    acknowledgements[0]();
    await new Promise((resolve) => setImmediate(resolve));
    expect(fs.existsSync(session.artifactPath)).toBe(false);
    acknowledgements[1]();
    expect(runBoundaryVerdict([await finishing], VM.runId).held).toBe(true);
    expect(fs.existsSync(session.artifactPath)).toBe(true);
    expect(events.filter((event) => event === 'count')).toHaveLength(2);
    expect(events.filter((event) => event === 'ack')).toHaveLength(2);
  });

  it.each([
    'collector',
    'report-buffer',
    'split-collector',
  ] as const)('parses malformed and adverse markers from %s', async (channel) => {
    for (const bad of [
      '{bad',
      JSON.stringify({
        ...report(),
        records: [{ category: 'lan', attempt: 'connect', outcome: 'succeeded' }],
      }),
    ]) {
      const fake = new ProbeFake();
      const collector = new OutputCollector();
      const marker = `${REPORT_MARKER}${bad}\n`;
      if (channel === 'report-buffer') Object.assign(fake.result, { report: Buffer.from(marker) });
      else if (channel === 'split-collector') {
        collector.append(marker.slice(0, 9));
        collector.append(marker.slice(9));
      } else collector.append(marker);
      expect(
        runBoundaryVerdict([(await input(fake, 'node', collector)).input], VM.runId).held
      ).toBe(false);
    }
    const collector = new OutputCollector();
    collector.append(`${REPORT_MARKER}${JSON.stringify(report())}\n`);
    expect(
      runBoundaryVerdict([(await input(new ProbeFake(), 'node', collector)).input], VM.runId).held
    ).toBe(true);
  });

  it('refuses guest-origin broker errors after observable forbidden forwarding', async () => {
    const fake = new ProbeFake();
    const forwarded: string[] = [];
    vi.spyOn(fake, 'putFile').mockImplementation(async (_vm, name, bytes) => {
      try {
        validateRequest({
          op: 'put',
          path: name,
          data: bytes.toString('base64'),
          executable: false,
        });
      } catch {
        forwarded.push(name);
        throw new BrokerError('guest_invalid_path');
      }
    });
    const checks = await boundaryBrokerChecks(fake, VM);
    expect(forwarded).toHaveLength(3);
    expect(checks.filter((check) => !check.rejected).map((check) => check.attempt)).toEqual([
      'put-traversal',
      'put-absolute',
      'put-oversize',
    ]);
  });

  it.each([
    'home',
    'listener',
  ] as const)('attempts all cleanup resources and retries failed %s removal without publishing a pass', async (fault) => {
    const fake = new ProbeFake();
    const session = await prepared();
    await probeBoundary(session, fake, VM, 'node');
    const originalRm = fs.rmSync;
    const originalClose = net.Server.prototype.close;
    const hostHome = path.dirname(fake.targets.hostFile);
    let failing = true;
    const attemptedCloses: net.Server[] = [];
    const close = vi.spyOn(net.Server.prototype, 'close').mockImplementation(function (
      this: net.Server,
      ...args: Parameters<net.Server['close']>
    ) {
      attemptedCloses.push(this);
      if (fault === 'listener' && failing) throw new Error('close denied');
      return originalClose.apply(this, args);
    });
    const rm = vi.spyOn(fs, 'rmSync').mockImplementation((name, options) => {
      if (fault === 'home' && name === hostHome && failing) throw new Error('remove denied');
      return originalRm(name, options);
    });
    await expect(finishBoundary(session, new OutputCollector(), VM.runId)).rejects.toThrow(
      'resources_remaining'
    );
    expect(fs.existsSync(session.artifactPath)).toBe(false);
    expect(process.env[fake.targets.envName]).toBeUndefined();
    expect(new Set(attemptedCloses).size).toBe(2);
    if (fault === 'home') expect(fs.existsSync(fake.targets.hostFile)).toBe(true);
    else expect(fs.existsSync(fake.targets.hostFile)).toBe(false);
    failing = false;
    session.cleanup();
    expect(fs.existsSync(fake.targets.hostFile)).toBe(false);
    expect(attemptedCloses.every((server) => !server.listening)).toBe(true);
    close.mockRestore();
    rm.mockRestore();
  });

  it('requires both distinct canaries and the entire unique host-check set when recomputing', async () => {
    const clean = (await input()).input;
    const corruptions: BoundaryInput[] = [
      { ...clean, canaries: [] },
      { ...clean, canaries: ['short', 'short'] },
      { ...clean, canaries: [clean.canaries[0], clean.canaries[0]] },
      { ...clean, brokerChecks: [] },
      { ...clean, brokerChecks: clean.brokerChecks.slice(1) },
      { ...clean, brokerChecks: clean.brokerChecks.map(() => clean.brokerChecks[0]) },
      { ...clean, malformedReports: -1 },
      { ...clean, malformedReports: Number.NaN },
      { ...clean, listenerConnections: -1 },
    ];
    for (const corrupted of corruptions)
      expect(runBoundaryVerdict([clean, corrupted], VM.runId).held).toBe(false);
  });

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
    await expect(finishBoundary(session, new OutputCollector(), VM.runId)).rejects.toThrow(
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
    const evidence = await finishBoundary(session, collector, VM.runId);
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
    const evidence = await finishBoundary(session, new OutputCollector(), VM.runId);
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
    await expect(probeBoundary(session, fake, VM, 'node')).rejects.toThrow(
      'Boundary operation failed'
    );
    expect(Object.keys(process.env).filter((key) => key.startsWith('ZT_CANARY_'))).toEqual([]);
    expect(
      runBoundaryVerdict([await finishBoundary(session, new OutputCollector(), VM.runId)], VM.runId)
        .held
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
      await expect(finishBoundary(session, collector, VM.runId)).rejects.toThrow();
      expect(fs.existsSync(fake.targets.hostFile)).toBe(false);
      expect(process.env[fake.targets.envName]).toBeUndefined();
    }
  });

  it('rejects reuse, wrong profile/scope, wrong run, unprobed and early closed sessions', async () => {
    const fake = new ProbeFake();
    const session = await prepared();
    await probeBoundary(session, fake, VM, 'node');
    expect(
      runBoundaryVerdict([await finishBoundary(session, new OutputCollector(), 'wrong')], VM.runId)
        .held
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
      runBoundaryVerdict(
        [await finishBoundary(unprobed, new OutputCollector(), VM.runId)],
        VM.runId
      ).held
    ).toBe(false);
    const closed = await prepared();
    await probeBoundary(closed, fake, VM, 'node');
    closed.cleanup();
    expect(
      runBoundaryVerdict([await finishBoundary(closed, new OutputCollector(), VM.runId)], VM.runId)
        .held
    ).toBe(false);
    await expect(
      finishBoundary({ artifactPath: '', cleanup() {} }, new OutputCollector(), VM.runId)
    ).rejects.toThrow('Unknown');
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
  it('refuses an unrecognized fixture rather than reading an arbitrary path', async () => {
    await expect(uploadBoundaryFixture(new ProbeFake(), VM, '../escape', {})).rejects.toThrow(
      'unknown_fixture'
    );
  });

  it('records zero guest frames for all real broker rejections, with forwarded positive controls', async () => {
    const frames: Record<string, unknown>[] = [];
    const stream = new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        const frame = JSON.parse(String(chunk)) as Record<string, unknown>;
        frames.push(frame);
        if (frame.op === 'hello')
          this.push(
            `${JSON.stringify({ v: 1, id: 0, hello: BROKER_PROTOCOL, scope: 'container', phase: 'verification' })}\n`
          );
        else
          this.push(
            `${JSON.stringify({ v: 1, id: frame.id, ok: false, error: 'invalid_path' })}\n`
          );
        callback();
      },
    });
    const client = new BrokerClient(stream);
    try {
      await client.waitReady(1000);
      frames.length = 0;
      const wire: VmAdapter = {
        ...new ProbeFake(),
        create: async () => VM,
        destroy: async () => {},
        endProvisioning: async () => {},
        listByRun: async () => [],
        putFile: async (_vm, name, bytes) => client.put(name, bytes, false, 1000),
        getFile: async (_vm, name) => client.get(name, 1000),
        exec: async (_vm, request) => client.exec({ ...request, timeoutMs: 1000 }, 0),
      };
      expect((await boundaryBrokerChecks(wire, VM)).every((check) => check.rejected)).toBe(true);
      expect(frames).toEqual([]);
      // The transport and guest-origin prefix are real, not fabricated constants.
      expect(await rejectedByBroker(() => client.get('valid-file', 1000))).toBe(false);
      expect(frames).toHaveLength(1);
      client.taint('stream_error');
      expect(
        (await boundaryBrokerChecks(wire, VM)).filter((check) => !check.rejected).length
      ).toBeGreaterThan(0);
    } finally {
      client.close();
    }
  });
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
