import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Journal } from '../journal';
import { createRun, ReasonCode, type RunRecord, transitionRun } from '../state';
import {
  BrokerError,
  type ExecScope,
  UnsupportedEnvironmentError,
  VmCleanupError,
  type VmHandle,
  type VmLimits,
} from '../vm/adapter';
import type { HostTools } from '../vm/host';
import {
  findQemuProcesses,
  type HostOps,
  KILL_SWITCH_FILE,
  LocalQemuAdapter,
  type LocalQemuOptions,
  qemuPidFile,
  systemOps,
} from '../vm/local-qemu';
import { PROFILE_PINS, profileDigest } from '../vm/profile';
import {
  BROKER_PORT_NAME,
  GUEST_RELAY_PORT,
  PHASE_OEM_PREFIX,
  SCOPE_OEM_PREFIX,
  TIMEOUT_SCALE,
  WORKER_RELAY,
} from '../vm/qemu-args';

const AGENT = 'print("fake guest agent")\n';
/** A minimal standalone qcow2 v3 header: magic, version 3, no backing file, no
 * incompatible features. */
const IMAGE_BYTES = (() => {
  const header = Buffer.alloc(104);
  header.writeUInt32BE(0x514649fb, 0);
  header.writeUInt32BE(3, 4);
  return header;
})();
const LIMITS: VmLimits = { vcpus: 2, memoryMiB: 2048, diskGiB: 16, commandTimeoutMs: 5000 };
const PID = 4242;
const CANARY = 'ZT_TEST_CANARY_SECRET';

type Frame = Record<string, unknown>;
type Responder = (frame: Frame) => Frame | null;

/** Guest end of a broker socket: answers hello with `scope` and `phase`, then `respond`. */
function fakeGuest(scope: string | null, phase: string, respond: Responder, seen: Frame[]): Duplex {
  let buffer = '';
  const stream: Duplex = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const frame = JSON.parse(buffer.slice(0, end)) as Frame;
        buffer = buffer.slice(end + 1);
        seen.push(frame);
        const reply =
          frame.op === 'hello'
            ? scope === null
              ? null
              : { v: 1, id: 0, hello: 'zt-broker-v1', scope, phase }
            : respond(frame);
        if (reply) setImmediate(() => stream.push(`${JSON.stringify(reply)}\n`));
      }
      callback();
    },
  });
  return stream;
}

const defaultResponder: Responder = (frame) => {
  if (frame.op === 'exec')
    return {
      v: 1,
      id: frame.id,
      ok: true,
      exitCode: 0,
      timedOut: false,
      truncated: false,
      stdout: Buffer.from('hi').toString('base64'),
      stderr: '',
    };
  if (frame.op === 'put') return { v: 1, id: frame.id, ok: true };
  if (frame.op === 'get')
    return { v: 1, id: frame.id, ok: true, data: Buffer.from('file').toString('base64') };
  return null;
};

interface FakeHost {
  ops: HostOps;
  calls: {
    run: { binary: string; args: readonly string[]; env: Record<string, string> }[];
    launch: {
      binary: string;
      args: readonly string[];
      env: Record<string, string>;
      stderrFile: string;
    }[];
    kill: [number, NodeJS.Signals][];
    /** PIDs whose Launched.kill() handle was invoked. */
    childKill: number[];
    connect: string[];
  };
  seen: Frame[];
  alive: Set<number>;
  tokens: Map<number, string | null | Error>;
  /** argv per PID (an Error is thrown by cmdline); only live PIDs are visible. */
  argv: Map<number, string[] | Error>;
  state: {
    nextPid: number;
    /** Overrides the scope the guest announces; null = never answer hello. */
    guestScope?: string | null;
    /** Overrides the phase the guest announces. */
    guestPhase?: string;
    respond: Responder;
    exitTail?: string;
    connectFails?: boolean;
    dieOn?: NodeJS.Signals | null;
    rmFails?: boolean;
    startTokenAtLaunch?: string | null;
  };
}

function fakeHost(): FakeHost {
  const host: FakeHost = {
    calls: { run: [], launch: [], kill: [], childKill: [], connect: [] },
    seen: [],
    alive: new Set(),
    tokens: new Map(),
    argv: new Map(),
    state: { nextPid: PID, respond: defaultResponder, dieOn: 'SIGTERM' },
    ops: undefined as unknown as HostOps,
  };
  let scope: string | null = null;
  let phase = 'verification';
  host.ops = {
    async run(binary, args, env) {
      host.calls.run.push({ binary, args, env });
    },
    async launch(binary, args, env, stderrFile) {
      host.calls.launch.push({ binary, args, env, stderrFile });
      const oem = String(args[args.indexOf('-smbios') + 1]);
      scope = new RegExp(`${SCOPE_OEM_PREFIX}([a-z-]+)`).exec(oem)?.[1] ?? null;
      phase = new RegExp(`${PHASE_OEM_PREFIX}([a-z-]+)`).exec(oem)?.[1] ?? 'verification';
      const pid = host.state.nextPid++;
      host.alive.add(pid);
      host.argv.set(pid, [binary, ...args]);
      host.tokens.set(
        pid,
        host.state.startTokenAtLaunch === undefined ? `tok-${pid}` : host.state.startTokenAtLaunch
      );
      const tail = host.state.exitTail;
      return {
        pid,
        exited: tail === undefined ? new Promise<string>(() => undefined) : Promise.resolve(tail),
        kill: () => {
          host.calls.childKill.push(pid);
        },
      };
    },
    async connect(socketPath) {
      host.calls.connect.push(socketPath);
      if (host.state.connectFails) throw new Error('ECONNREFUSED');
      const announced = host.state.guestScope === undefined ? scope : host.state.guestScope;
      return fakeGuest(
        announced,
        host.state.guestPhase ?? phase,
        (f) => host.state.respond(f),
        host.seen
      );
    },
    async freePort() {
      return 40123;
    },
    startToken(pid) {
      const token = host.tokens.get(pid);
      if (token instanceof Error) throw token;
      return token ?? null;
    },
    cmdline(pid) {
      const argv = host.argv.get(pid);
      if (argv instanceof Error) throw argv;
      return host.alive.has(pid) ? (argv ?? null) : null;
    },
    listProcesses: () => [...host.alive],
    alive: (pid) => host.alive.has(pid),
    kill(pid, signal) {
      host.calls.kill.push([pid, signal]);
      if (host.state.dieOn === signal || (host.state.dieOn === 'SIGTERM' && signal === 'SIGKILL'))
        host.alive.delete(pid);
      if (signal === 'SIGTERM' && host.state.dieOn === null) throw new Error('EPERM');
    },
    rm(target) {
      if (host.state.rmFails) throw new Error('EBUSY');
      fs.rmSync(target, { recursive: true, force: true });
    },
    async sleep() {},
  };
  return host;
}

const tools = (accelerator: 'kvm' | 'tcg' = 'kvm'): HostTools => ({
  qemu: '/opt/fake/qemu-system-x86_64',
  qemuImg: '/opt/fake/qemu-img',
  isoTool: '/opt/fake/genisoimage',
  accelerator,
});

/** Writes the image with an explicit mode: verifyImage refuses group/other write
 * bits, and the umask decides what writeFileSync leaves. */
function writeImage(profileDir: string, bytes: Buffer | string, mode = 0o644): void {
  const image = path.join(profileDir, 'image.qcow2');
  fs.writeFileSync(image, bytes);
  fs.chmodSync(image, mode);
}

function writeManifest(profileDir: string, over: Record<string, unknown> = {}): void {
  writeImage(profileDir, IMAGE_BYTES);
  const manifest = path.join(profileDir, 'manifest.json');
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      schema: 'zt-vm-profile-v1',
      profileDigest: profileDigest(AGENT),
      baseImageSha256: PROFILE_PINS.baseImage.sha256,
      workerProfiles: {
        node: PROFILE_PINS.containerProfiles.node.profileId,
        python: PROFILE_PINS.containerProfiles.python.profileId,
      },
      imageSha256: createHash('sha256').update(IMAGE_BYTES).digest('hex'),
      imageFile: 'image.qcow2',
      containerImages: { node: `sha256:${'a'.repeat(64)}`, python: `sha256:${'b'.repeat(64)}` },
      bakedAt: '2026-10-01T00:00:00.000Z',
      ...over,
    })
  );
  // The adapter reads the manifest with readPrivate: no group/other bits.
  fs.chmodSync(manifest, 0o600);
}

let root: string;
let stateDir: string;
let profileDir: string;
let runtimeDir: string;
let host: FakeHost;
const journals: Journal[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-lq-'));
  stateDir = path.join(root, 'state');
  profileDir = path.join(root, 'profile');
  runtimeDir = path.join(root, 'rt');
  fs.mkdirSync(profileDir);
  writeManifest(profileDir);
  host = fakeHost();
  process.env[CANARY] = 'ghp_should_never_reach_qemu';
});

afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  delete process.env[CANARY];
  fs.rmSync(root, { recursive: true, force: true });
});

function adapter(over: Partial<LocalQemuOptions> = {}): LocalQemuAdapter {
  return new LocalQemuAdapter({
    stateDir,
    profileDir,
    runtimeDir,
    tools: tools(),
    ops: host.ops,
    agentSource: AGENT,
    now: () => new Date('2026-10-06T00:00:00.000Z'),
    ...over,
  });
}

function journal(): Journal {
  const j = new Journal(path.join(root, 'journal'));
  journals.push(j);
  return j;
}

const spec = (runId = 'run-1', scope: ExecScope = 'container') => ({
  runId,
  limits: LIMITS,
  scope,
});

async function rejects<T extends Error>(
  promise: Promise<unknown>,
  type: new (...args: never[]) => T
): Promise<T> {
  const error = await promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(type);
  return error as T;
}

function refusal(read: () => unknown): UnsupportedEnvironmentError {
  try {
    read();
  } catch (error) {
    expect(error).toBeInstanceOf(UnsupportedEnvironmentError);
    return error as UnsupportedEnvironmentError;
  }
  throw new Error('expected refusal');
}

describe('LocalQemuAdapter construction', () => {
  it('refuses a missing manifest on first use, naming the file', async () => {
    fs.rmSync(path.join(profileDir, 'manifest.json'));
    const a = adapter();
    const error = refusal(() => a.manifest);
    expect(error.detail).toBe('profile_image_missing');
    expect(error.message).toContain(path.join(profileDir, 'manifest.json'));
    expect(error.message).toContain('run the bake');
    // verifyImage: false — with image verification on, verifyImage() currently
    // masks the manifest refusal as "baked profile image is missing".
    const created = await rejects(
      adapter({ verifyImage: false }).create(spec()),
      UnsupportedEnvironmentError
    );
    expect(created.detail).toBe('profile_image_missing');
    expect(created.message).toContain(path.join(profileDir, 'manifest.json'));
    expect(host.calls.run).toEqual([]);
    expect(host.calls.launch).toEqual([]);
  });

  it('refuses a manifest for a different profile on first use', () => {
    writeManifest(profileDir, { profileDigest: 'f'.repeat(64) });
    const a = adapter();
    expect(() => a.manifest).toThrow(/profile_image_mismatch/);
    writeManifest(profileDir);
    expect(() => adapter({ agentSource: 'another agent' }).manifest).toThrow(
      /profile_image_mismatch/
    );
  });

  it('defaults the agent source to the shipped guest agent', () => {
    // The fixture manifest is digested over AGENT, so the real agent mismatches.
    expect(() => adapter({ agentSource: undefined }).manifest).toThrow(/profile_image_mismatch/);
  });

  it('falls back to host preflight when no tools are injected, lazily', () => {
    fs.rmSync(path.join(profileDir, 'manifest.json'));
    // Construction never probes the host or reads the profile.
    const a = adapter({ tools: undefined, ops: undefined, now: undefined, accelerator: 'auto' });
    let tools: HostTools | null = null;
    try {
      tools = a.tools;
    } catch (error) {
      // A host without QEMU refuses closed on first access.
      expect(error).toBeInstanceOf(UnsupportedEnvironmentError);
    }
    if (tools) {
      expect(path.isAbsolute(tools.qemu)).toBe(true);
      expect(a.accelerator).toBe(tools.accelerator);
      // Loaded once.
      expect(a.tools).toBe(tools);
    }
    expect(refusal(() => a.manifest).detail).toBe('profile_image_missing');
  });

  it('works without a manifest or tools for teardown, listing and the kill switch', async () => {
    fs.rmSync(path.join(profileDir, 'manifest.json'));
    const a = adapter({ tools: undefined, accelerator: 'kvm' });
    expect(a.killSwitchEngaged()).toBe(false);
    expect(await a.listByRun('run-1')).toEqual([]);
    await expect(a.destroy({ vmId: 'zt-0123456789ab', runId: 'run-1' })).resolves.toBeUndefined();
    expect(await a.killAll('incident')).toEqual({ destroyed: [], failed: [], blockedRuns: [] });
    expect(a.killSwitchEngaged()).toBe(true);
  });

  it('cleans up VMs created by an earlier adapter after the profile is gone', async () => {
    const handle = await adapter().create(spec());
    fs.rmSync(path.join(profileDir, 'manifest.json'));
    const a = adapter({ tools: undefined });
    expect(await a.listByRun('run-1')).toHaveLength(1);
    const result = await a.killAll('incident');
    expect(result).toEqual({ destroyed: [handle.vmId], failed: [], blockedRuns: [] });
    expect(host.calls.kill).toEqual([[PID, 'SIGTERM']]);
  });

  it('resolves relative state and profile directories', async () => {
    const cwd = process.cwd();
    try {
      process.chdir(root);
      const a = adapter({ stateDir: 'state', profileDir: 'profile' });
      expect(a.manifest.imageFile).toBe('image.qcow2');
      await a.killAll('incident');
      expect(fs.existsSync(path.join(root, 'state', KILL_SWITCH_FILE))).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });

  it('exposes the accelerator and manifest', () => {
    const a = adapter({ tools: tools('tcg') });
    expect(a.accelerator).toBe('tcg');
    expect(a.manifest.imageFile).toBe('image.qcow2');
    expect(a.manifest).toBe(a.manifest);
    expect(a.killSwitchEngaged()).toBe(false);
  });
});

describe('LocalQemuAdapter.create', () => {
  it('builds the overlay, launches QEMU with a scrubbed env and records the VM', async () => {
    const j = journal();
    const a = adapter({ journal: j, verifyImage: true });
    const handle = await a.create(spec());
    expect(handle).toMatchObject({
      runId: 'run-1',
      accelerator: 'kvm',
      scope: 'container',
      profileDigest: profileDigest(AGENT),
    });
    expect(handle.vmId).toMatch(/^zt-[a-f0-9]{12}$/);
    expect(Object.isFrozen(handle)).toBe(true);

    const [img] = host.calls.run;
    expect(img?.binary).toBe('/opt/fake/qemu-img');
    expect(img?.args).toContain('-b');
    expect(img?.args[img.args.indexOf('-b') + 1]).toBe(path.join(profileDir, 'image.qcow2'));
    expect(img?.args.at(-1)).toBe('16G');

    const [launch] = host.calls.launch;
    expect(launch?.binary).toBe('/opt/fake/qemu-system-x86_64');
    expect(launch?.args).toContain('user,id=net0,restrict=on');
    expect(launch?.args).toContain(
      `type=11,value=${SCOPE_OEM_PREFIX}container,value=${PHASE_OEM_PREFIX}verification`
    );
    expect(launch?.args.join(' ')).not.toContain('hostfwd');
    expect(launch?.args.join(' ')).toContain(BROKER_PORT_NAME);
    const vmDir = path.join(stateDir, 'vms', handle.vmId);
    expect(launch?.stderrFile).toBe(path.join(vmDir, 'qemu.err'));
    for (const env of [img?.env, launch?.env]) {
      expect(Object.keys(env ?? {}).sort()).toEqual(['LANG', 'PATH']);
      expect(JSON.stringify(env)).not.toContain(CANARY);
      expect(JSON.stringify(env)).not.toContain('ghp_');
    }
    expect(host.calls.connect).toEqual([path.join(runtimeDir, `${handle.vmId}.sock`)]);

    const recordFile = path.join(vmDir, 'vm.json');
    expect(fs.statSync(recordFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(vmDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(runtimeDir).mode & 0o777).toBe(0o700);
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    expect(record).toMatchObject({
      vmId: handle.vmId,
      runId: 'run-1',
      pid: PID,
      startToken: `tok-${PID}`,
      limits: LIMITS,
      createdAt: '2026-10-06T00:00:00.000Z',
    });

    const events = j.read() as Record<string, unknown>[];
    expect(events.find((e) => e.type === 'vm_created')).toMatchObject({
      runId: 'run-1',
      vmId: handle.vmId,
      provider: 'local-qemu',
      accelerator: 'kvm',
      pid: PID,
      vcpus: 2,
      memoryMiB: 2048,
      diskGiB: 16,
    });
  });

  it('retries connect until QEMU listens', async () => {
    let attempts = 0;
    const connect = host.ops.connect;
    host.ops.connect = async (socket) => {
      if (++attempts < 3) throw new Error('ENOENT');
      return connect(socket);
    };
    await adapter().create(spec());
    expect(attempts).toBe(3);
  });

  it('gives up with socket_unavailable when the socket never appears', async () => {
    host.state.connectFails = true;
    const error = await rejects(adapter().create(spec()), BrokerError);
    expect(error.code).toBe('socket_unavailable');
    expect(fs.readdirSync(path.join(stateDir, 'vms'))).toEqual([]);
  });

  it('fails and destroys the VM on a guest scope mismatch', async () => {
    host.state.guestScope = 'vm-root';
    const error = await rejects(adapter().create(spec()), BrokerError);
    expect(error.code).toBe('scope_mismatch');
    expect(host.calls.kill).toEqual([[PID, 'SIGTERM']]);
    expect(fs.readdirSync(path.join(stateDir, 'vms'))).toEqual([]);
  });

  it('kills the launched child before cleanup when create fails', async () => {
    host.state.guestScope = 'vm-root';
    await rejects(adapter().create(spec()), BrokerError);
    expect(host.calls.childKill).toEqual([PID]);
  });

  it('does not need a child kill handle (Launched.kill is optional)', async () => {
    const launch = host.ops.launch;
    host.ops.launch = async (...args) => {
      const { pid, exited } = await launch(...args);
      return { pid, exited };
    };
    host.state.guestScope = 'vm-root';
    const error = await rejects(adapter().create(spec()), BrokerError);
    expect(error.code).toBe('scope_mismatch');
    expect(host.calls.childKill).toEqual([]);
  });

  it('journals the leftovers when cleanup after a failed create is incomplete', async () => {
    const j = journal();
    host.state.guestScope = 'vm-root';
    host.state.dieOn = null; // QEMU survives SIGTERM and SIGKILL
    const error = await rejects(adapter({ journal: j }).create(spec()), BrokerError);
    // The caller still sees the boot error, not the cleanup error.
    expect(error.code).toBe('scope_mismatch');
    const [vmId] = fs.readdirSync(path.join(stateDir, 'vms'));
    const events = j.read() as Record<string, unknown>[];
    expect(events.find((e) => e.type === 'vm_cleanup_attempt_failed')).toEqual(
      expect.objectContaining({
        runId: 'run-1',
        vmId,
        attempt: 1,
        leftoverPids: [PID],
        leftoverPaths: [path.join(stateDir, 'vms', vmId as string)],
      })
    );
    expect(events.some((e) => e.type === 'vm_destroyed')).toBe(false);
  });

  it('keeps the boot error when cleanup fails unexpectedly, without journaling', async () => {
    const j = journal();
    host.state.guestScope = 'vm-root';
    host.ops.alive = () => {
      throw new TypeError('proc unavailable');
    };
    const error = await rejects(adapter({ journal: j }).create(spec()), BrokerError);
    expect(error.code).toBe('scope_mismatch');
    const events = j.read() as Record<string, unknown>[];
    expect(events.some((e) => e.type === 'vm_cleanup_attempt_failed')).toBe(false);
  });

  it('passes vm-root scope through the SMBIOS OEM string', async () => {
    const handle = await adapter().create(spec('run-1', 'vm-root'));
    expect(handle.scope).toBe('vm-root');
    expect(host.calls.launch[0]?.args).toContain(
      `type=11,value=${SCOPE_OEM_PREFIX}vm-root,value=${PHASE_OEM_PREFIX}verification`
    );
  });

  it('rejects with the stderr tail when QEMU exits before the socket opens', async () => {
    host.state.connectFails = true;
    host.state.exitTail = 'qemu-system-x86_64: could not open disk\n';
    host.state.dieOn = 'SIGTERM';
    const promise = adapter().create(spec());
    await expect(promise).rejects.toThrow(/QEMU exited during boot: .*could not open disk/);
    expect(fs.readdirSync(path.join(stateDir, 'vms'))).toEqual([]);
  });

  it('rejects when QEMU exits while waiting for the hello', async () => {
    host.state.guestScope = null;
    host.state.exitTail = 'guest kernel panic';
    await expect(adapter().create(spec())).rejects.toThrow(/guest kernel panic/);
  });

  it('refuses a socket path over the UNIX limit', async () => {
    const error = await rejects(
      adapter({ runtimeDir: path.join(root, 'r'.repeat(110)) }).create(spec()),
      UnsupportedEnvironmentError
    );
    expect(error.detail).toBe('socket_path_too_long');
    expect(host.calls.run).toEqual([]);
  });

  it('refuses while the kill switch is engaged', async () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, KILL_SWITCH_FILE), '{}');
    const error = await rejects(adapter().create(spec()), UnsupportedEnvironmentError);
    expect(error.detail).toBe('kill_switch_engaged');
  });

  it.each(['', 'bad id', '../x', 'a'.repeat(129)])('rejects run ID %j', async (runId) => {
    await expect(adapter().create(spec(runId))).rejects.toThrow('Invalid run ID');
  });

  it.each([
    8, 15.5,
  ])('refuses a disk limit below the baked image size (%j GiB)', async (diskGiB) => {
    await expect(adapter().create({ ...spec(), limits: { ...LIMITS, diskGiB } })).rejects.toThrow(
      /baked image size/
    );
    expect(host.calls.run).toEqual([]);
  });

  it('rejects a secret-shaped run ID', async () => {
    await expect(adapter().create(spec('ghp_abc'))).rejects.toThrow(/credential/);
  });

  it('verifies the image digest once before the first VM', async () => {
    fs.writeFileSync(path.join(profileDir, 'image.qcow2'), 'tampered');
    const a = adapter({ verifyImage: true });
    const error = await rejects(a.create(spec()), UnsupportedEnvironmentError);
    expect(error.detail).toBe('profile_image_mismatch');
    fs.rmSync(path.join(profileDir, 'image.qcow2'));
    const missing = await rejects(a.create(spec()), UnsupportedEnvironmentError);
    expect(missing.detail).toBe('profile_image_missing');
    expect(host.calls.run).toEqual([]);
  });

  it('refuses a group-readable manifest as unreadable', async () => {
    fs.chmodSync(path.join(profileDir, 'manifest.json'), 0o640);
    const error = await rejects(
      adapter({ verifyImage: false }).create(spec()),
      UnsupportedEnvironmentError
    );
    expect(error.detail).toBe('profile_image_missing');
    expect(error.message).toContain('unreadable or not private');
    expect(error.message).toContain(path.join(profileDir, 'manifest.json'));
    expect(host.calls.run).toEqual([]);
  });

  it('refuses an image that names a backing file even when its digest matches', async () => {
    const backed = Buffer.from(IMAGE_BYTES);
    backed.writeBigUInt64BE(0x200n, 8);
    writeManifest(profileDir, {
      imageSha256: createHash('sha256').update(backed).digest('hex'),
    });
    writeImage(profileDir, backed);
    const error = await rejects(
      adapter({ verifyImage: true }).create(spec()),
      UnsupportedEnvironmentError
    );
    expect(error.detail).toBe('profile_image_mismatch');
    expect(host.calls.run).toEqual([]);
  });

  it('re-checks the kill switch after QEMU launches and destroys the VM', async () => {
    const launch = host.ops.launch;
    host.ops.launch = async (...args) => {
      const launched = await launch(...args);
      fs.writeFileSync(path.join(stateDir, KILL_SWITCH_FILE), '{}');
      return launched;
    };
    const error = await rejects(adapter().create(spec()), UnsupportedEnvironmentError);
    expect(error.detail).toBe('kill_switch_engaged');
    expect(host.calls.connect).toEqual([]);
    expect(host.calls.kill).toEqual([[PID, 'SIGTERM']]);
    expect(fs.readdirSync(path.join(stateDir, 'vms'))).toEqual([]);
  });

  it('re-checks the kill switch after the guest hello and destroys the VM', async () => {
    const connect = host.ops.connect;
    host.ops.connect = async (socket) => {
      fs.writeFileSync(path.join(stateDir, KILL_SWITCH_FILE), '{}');
      return connect(socket);
    };
    const error = await rejects(adapter().create(spec()), UnsupportedEnvironmentError);
    expect(error.detail).toBe('kill_switch_engaged');
    expect(host.calls.connect).toHaveLength(1);
    expect(host.seen.some((f) => f.op === 'hello')).toBe(true);
    expect(host.calls.kill).toEqual([[PID, 'SIGTERM']]);
    expect(fs.readdirSync(path.join(stateDir, 'vms'))).toEqual([]);
  });

  it('records the pid before reading its start token, so a failure there is reported', async () => {
    host.ops.startToken = () => {
      throw new Error('EACCES');
    };
    const a = adapter();
    await expect(a.create(spec())).rejects.toThrow('EACCES');
    const [vmId] = fs.readdirSync(path.join(stateDir, 'vms'));
    if (!vmId) throw new Error('expected the VM record to be kept');
    const record = JSON.parse(fs.readFileSync(path.join(stateDir, 'vms', vmId, 'vm.json'), 'utf8'));
    expect(record).toMatchObject({ pid: PID, startToken: null });
    expect(host.calls.kill).toEqual([]);
    const error = await rejects(a.destroy({ vmId, runId: 'run-1' }), VmCleanupError);
    expect(error.leftoverPids).toEqual([PID]);
    expect(error.leftoverPaths).toEqual([path.join(stateDir, 'vms', vmId)]);
    // Even once /proc is readable again, a record without a start token is never signalled.
    host.ops.startToken = () => `tok-${PID}`;
    const again = await rejects(a.destroy({ vmId, runId: 'run-1' }), VmCleanupError);
    expect(again.leftoverPids).toEqual([PID]);
    expect(host.calls.kill).toEqual([]);
  });

  it('skips the digest check when verifyImage is false', async () => {
    fs.writeFileSync(path.join(profileDir, 'image.qcow2'), 'tampered');
    await expect(adapter({ verifyImage: false }).create(spec())).resolves.toBeDefined();
  });

  it('refuses a runtime directory reached through a symlink', async () => {
    fs.mkdirSync(path.join(root, 'real'));
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
    await expect(adapter({ runtimeDir: path.join(root, 'link') }).create(spec())).rejects.toThrow(
      /is not private/
    );
  });

  it('defaults the runtime dir to XDG_RUNTIME_DIR, else the temp dir', async () => {
    const saved = { xdg: process.env.XDG_RUNTIME_DIR, tmp: process.env.TMPDIR };
    try {
      process.env.XDG_RUNTIME_DIR = path.join(root, 'xdg');
      await adapter({ runtimeDir: undefined }).create(spec());
      expect(host.calls.connect[0]).toContain(path.join(root, 'xdg', 'ai-dossier-zt'));
      process.env.XDG_RUNTIME_DIR = 'relative';
      process.env.TMPDIR = path.join(root, 'tmp');
      await adapter({ runtimeDir: undefined }).create(spec());
      expect(host.calls.connect[1]).toContain(
        path.join(root, 'tmp', `ai-dossier-zt-${os.userInfo().uid}`)
      );
    } finally {
      if (saved.xdg === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = saved.xdg;
      if (saved.tmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved.tmp;
    }
  });
});

describe('LocalQemuAdapter provisioning phase', () => {
  const target = { host: '172.31.250.3', port: 4873 };
  const provisioning = (runId = 'run-1') => ({
    ...spec(runId),
    phase: 'provisioning' as const,
    proxyTarget: target,
  });
  /** The guest powers off when asked: its QEMU process exits. */
  const poweroffOnShutdown = () => {
    host.state.respond = (frame) => {
      if (frame.op !== 'shutdown') return defaultResponder(frame);
      for (const pid of [...host.alive]) host.alive.delete(pid);
      return { v: 1, id: frame.id, ok: true };
    };
  };

  it('requires a proxy target in, and only in, the provisioning phase', async () => {
    const a = adapter();
    await expect(a.create({ ...spec(), phase: 'provisioning' })).rejects.toThrow('proxy target');
    await expect(a.create({ ...spec(), proxyTarget: target })).rejects.toThrow('proxy target');
    await expect(
      a.create({ ...provisioning(), proxyTarget: { host: 'mirror.local', port: 4873 } })
    ).rejects.toThrow('Invalid provisioning proxy target');
    expect(host.calls.launch).toEqual([]);
  });

  it('launches with exactly one loopback host forward to the relay and the provisioning flag', async () => {
    const j = journal();
    const a = adapter({ journal: j });
    const handle = await a.create(provisioning());
    try {
      const args = host.calls.launch[0]?.args ?? [];
      const netdev = String(args[args.indexOf('-netdev') + 1]);
      expect(netdev).toBe(
        `user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:40123-:${GUEST_RELAY_PORT}`
      );
      expect(args.join(' ')).not.toContain('guestfwd');
      expect(args).toContain(
        `type=11,value=${SCOPE_OEM_PREFIX}container,value=${PHASE_OEM_PREFIX}provisioning`
      );
      const record = JSON.parse(
        fs.readFileSync(path.join(stateDir, 'vms', handle.vmId, 'vm.json'), 'utf8')
      );
      expect(record).toMatchObject({ phase: 'provisioning', proxyTarget: target });
      expect(j.read().at(-1)).toMatchObject({
        type: 'vm_created',
        phase: 'provisioning',
        hostForwards: 1,
      });
    } finally {
      await a.destroy(handle);
    }
  });

  it('destroys a VM whose guest announces a different phase', async () => {
    host.state.guestPhase = 'verification';
    const a = adapter();
    const error = await rejects(a.create(provisioning()), BrokerError);
    expect(error.code).toBe('phase_mismatch');
    expect(await a.listByRun('run-1')).toEqual([]);
  });

  it('refuses the package proxy network outside provisioning, before the guest', async () => {
    const a = adapter();
    const handle = await a.create(spec());
    const error = await rejects(
      a.exec(handle, { profile: 'node', argv: ['npm', 'ci'], network: 'package_proxy' }),
      BrokerError
    );
    expect(error.code).toBe('network_not_allowed');
    expect(host.seen.filter((f) => f.op === 'exec')).toEqual([]);
  });

  it('passes network, environment and report request through to the guest', async () => {
    const a = adapter();
    const handle = await a.create(provisioning());
    try {
      await a.exec(handle, {
        profile: 'node',
        argv: ['npm', 'ci'],
        network: 'package_proxy',
        env: { npm_config_registry: `http://${WORKER_RELAY.host}:${WORKER_RELAY.port}/` },
      });
      expect(host.seen.find((f) => f.op === 'exec')).toMatchObject({
        network: 'package_proxy',
        env: { npm_config_registry: `http://${WORKER_RELAY.host}:${WORKER_RELAY.port}/` },
        report: false,
      });
    } finally {
      await a.destroy(handle);
    }
  });

  it('ends provisioning: guest shutdown, then a relaunch on the same disk with no forward', async () => {
    poweroffOnShutdown();
    const j = journal();
    const a = adapter({ journal: j });
    const handle = await a.create(provisioning());
    try {
      await a.endProvisioning(handle);
      expect(host.seen.filter((f) => f.op === 'shutdown')).toHaveLength(1);
      expect(host.calls.kill).toEqual([]);
      expect(host.calls.launch).toHaveLength(2);
      const relaunch = host.calls.launch[1]?.args ?? [];
      expect(relaunch.join(' ')).not.toContain('hostfwd');
      expect(relaunch).toContain('user,id=net0,restrict=on');
      expect(relaunch).toContain(
        `type=11,value=${SCOPE_OEM_PREFIX}container,value=${PHASE_OEM_PREFIX}verification`
      );
      // The overlay is reused, not recreated.
      expect(host.calls.run).toHaveLength(1);
      const disk = path.join(stateDir, 'vms', handle.vmId, 'disk.qcow2');
      expect(relaunch).toContain(`file=${disk},if=virtio,format=qcow2,discard=unmap`);
      const events = j.read() as Record<string, unknown>[];
      // The powered-off guest's broker stream closing is journaled too, in any order.
      expect(events.find((e) => e.type === 'vm_phase_changed')).toMatchObject({
        type: 'vm_phase_changed',
        phase: 'verification',
        hostForwards: 0,
        pid: PID + 1,
      });
      // The connector's traffic and how the guest stopped are on record.
      expect(events.find((e) => e.type === 'vm_provisioning_channel_closed')).toMatchObject({
        reason: 'end_of_provisioning',
        spliced: 0,
      });
      expect(events.find((e) => e.type === 'vm_provisioning_stopped')).toMatchObject({
        shutdown: 'acknowledged',
        ended: 'exited',
      });
      // Each phase keeps its own QEMU stderr log.
      expect(host.calls.launch.map((l) => path.basename(l.stderrFile))).toEqual([
        'qemu.provisioning.err',
        'qemu.err',
      ]);
      const refused = await rejects(
        a.exec(handle, { profile: 'node', argv: ['true'], network: 'package_proxy' }),
        BrokerError
      );
      expect(refused.code).toBe('network_not_allowed');
      expect((await rejects(a.endProvisioning(handle), BrokerError)).code).toBe('not_provisioning');
    } finally {
      await a.destroy(handle);
    }
    expect(host.alive.size).toBe(0);
  });

  it('kills a guest that does not power off, and still relaunches without the forward', async () => {
    // The guest claims success but keeps running.
    host.state.respond = (frame) =>
      frame.op === 'shutdown' ? { v: 1, id: frame.id, ok: true } : defaultResponder(frame);
    const j = journal();
    const a = adapter({ journal: j });
    const handle = await a.create(provisioning());
    try {
      await a.endProvisioning(handle);
      expect(host.calls.kill[0]).toEqual([PID, 'SIGTERM']);
      expect(
        (j.read() as Record<string, unknown>[]).find((e) => e.type === 'vm_provisioning_stopped')
      ).toMatchObject({ ended: 'killed' });
      expect(host.calls.launch[1]?.args.join(' ')).not.toContain('hostfwd');
    } finally {
      await a.destroy(handle);
    }
  });

  it('hands the guest a fresh relay key in the provisioning hello only', async () => {
    const a = adapter();
    const prov = await a.create(provisioning());
    const plain = await a.create(spec('run-2'));
    try {
      const hellos = host.seen.filter((f) => f.op === 'hello');
      expect(hellos[0]?.relayKey).toMatch(/^[a-f0-9]{64}$/);
      expect(hellos[1]).not.toHaveProperty('relayKey');
      // The key never reaches QEMU's command line.
      expect(host.calls.launch[0]?.args.join(' ')).not.toContain(String(hellos[0]?.relayKey));
    } finally {
      await a.destroy(prov);
      await a.destroy(plain);
    }
  });

  it('runs one phase switch per VM at a time', async () => {
    poweroffOnShutdown();
    const a = adapter();
    const handle = await a.create(provisioning());
    try {
      const first = a.endProvisioning(handle);
      const second = await rejects(a.endProvisioning(handle), BrokerError);
      expect(second.code).toBe('phase_switch_in_progress');
      await first;
      expect(host.calls.launch).toHaveLength(2);
    } finally {
      await a.destroy(handle);
    }
  });

  it('journals a failed phase switch and leaves the VM to the caller', async () => {
    poweroffOnShutdown();
    const j = journal();
    const a = adapter({ journal: j });
    const handle = await a.create(provisioning());
    host.state.guestPhase = 'provisioning'; // the relaunched guest claims the wrong phase
    try {
      expect((await rejects(a.endProvisioning(handle), BrokerError)).code).toBe('phase_mismatch');
      expect(
        (j.read() as Record<string, unknown>[]).find((e) => e.type === 'vm_phase_change_failed')
      ).toMatchObject({ stage: 'relaunch', error: 'phase_mismatch' });
      expect(await a.listByRun('run-1')).toHaveLength(1);
    } finally {
      await a.destroy(handle);
    }
  });

  it('refuses to end provisioning for a VM that was never in it', async () => {
    const a = adapter();
    const handle = await a.create(spec());
    expect((await rejects(a.endProvisioning(handle), BrokerError)).code).toBe('not_provisioning');
    expect(host.calls.launch).toHaveLength(1);
  });
});

describe('LocalQemuAdapter broker operations', () => {
  it('caps accelerator-scaled command time at the controller wall deadline', async () => {
    const a = adapter({ tools: tools('tcg') });
    const handle = await a.create(spec());
    await a.exec(handle, {
      profile: 'node',
      argv: ['true'],
      timeoutMs: 60_000,
      wallTimeoutMs: 60_000,
    });
    expect(host.seen.find((f) => f.op === 'exec')).toMatchObject({ timeoutMs: 60_000 });
    const before = host.seen.length;
    for (const wallTimeoutMs of [0, 999, NaN, 6 * 3600 * 1000 + 1])
      await expect(
        a.exec(handle, { profile: 'node', argv: ['true'], wallTimeoutMs })
      ).rejects.toThrow('invalid_timeout');
    expect(host.seen).toHaveLength(before);
  });
  it('scales exec timeouts by TIMEOUT_SCALE under TCG', async () => {
    const a = adapter({ tools: tools('tcg') });
    const handle = await a.create(spec());
    const result = await a.exec(handle, { profile: 'node', argv: ['node', '-v'] });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'hi', stderr: '' });
    expect(host.seen.find((f) => f.op === 'exec')).toMatchObject({
      timeoutMs: TIMEOUT_SCALE.tcg * 5000,
      cwd: '',
    });
    await a.exec(handle, { profile: 'python', argv: ['python3'], cwd: 'src', timeoutMs: 2000 });
    expect(host.seen.filter((f) => f.op === 'exec')[1]).toMatchObject({
      timeoutMs: TIMEOUT_SCALE.tcg * 2000,
      cwd: 'src',
      profile: 'python',
    });
  });

  it('does not scale under KVM', async () => {
    const a = adapter();
    const handle = await a.create(spec());
    await a.exec(handle, { profile: 'node', argv: ['true'] });
    expect(host.seen.find((f) => f.op === 'exec')).toMatchObject({ timeoutMs: 5000 });
  });

  it('puts and gets files', async () => {
    const a = adapter();
    const handle = await a.create(spec());
    await a.putFile(handle, 'bin/run.sh', Buffer.from('#!/bin/sh'), true);
    await a.putFile(handle, 'data.txt', Buffer.from('x'));
    const puts = host.seen.filter((f) => f.op === 'put');
    expect(puts.map((f) => f.executable)).toEqual([true, false]);
    expect((await a.getFile(handle, 'out.txt')).toString()).toBe('file');
  });

  it('reports unknown_vm for handles it does not own', async () => {
    const a = adapter();
    const ghost: VmHandle = {
      vmId: 'zt-000000000000',
      runId: 'run-1',
      accelerator: 'kvm',
      profileDigest: 'x',
      scope: 'container',
    };
    for (const call of [
      a.exec(ghost, { profile: 'node', argv: ['x'] }),
      a.exec(ghost, { profile: 'node', argv: ['x'], timeoutMs: 1000 }),
      a.exec({ ...ghost, vmId: 'not-a-vm-id' }, { profile: 'node', argv: ['x'] }),
    ]) {
      const error = await rejects(call, BrokerError);
      expect(error.code).toBe('unknown_vm');
    }
    expect(() => a.putFile(ghost, 'a', Buffer.from(''))).toThrow(BrokerError);
    expect(() => a.getFile(ghost, 'a')).toThrow(/unknown_vm/);
  });

  it('reports unknown_vm when the record is gone, even with an explicit timeout', async () => {
    const a = adapter();
    const handle = await a.create(spec());
    fs.rmSync(path.join(stateDir, 'vms', handle.vmId, 'vm.json'));
    const error = await rejects(
      a.exec(handle, { profile: 'node', argv: ['x'], timeoutMs: 2000 }),
      BrokerError
    );
    expect(error.code).toBe('unknown_vm');
    expect(host.seen.some((f) => f.op === 'exec')).toBe(false);
  });

  it('rethrows the taint for a broken guest', async () => {
    host.state.respond = (f) => ({ v: 1, id: f.id, ok: true, exitCode: 999 });
    const a = adapter();
    const handle = await a.create(spec());
    const first = await rejects(a.exec(handle, { profile: 'node', argv: ['x'] }), BrokerError);
    expect(first.code).toBe('malformed_response');
    expect(() => a.getFile(handle, 'a')).toThrow(first);
  });
});

describe('LocalQemuAdapter.destroy', () => {
  async function created(a = adapter(), runId = 'run-1') {
    const handle = await a.create(spec(runId));
    return { a, handle, vmDir: path.join(stateDir, 'vms', handle.vmId) };
  }

  it('terminates an owned QEMU with SIGTERM and removes its files', async () => {
    const j = journal();
    const { a, handle, vmDir } = await created(adapter({ journal: j }));
    await a.destroy(handle);
    expect(host.calls.kill).toEqual([[PID, 'SIGTERM']]);
    expect(fs.existsSync(vmDir)).toBe(false);
    expect(j.read()).toContainEqual(expect.objectContaining({ type: 'vm_destroyed' }));
    await expect(a.exec(handle, { profile: 'node', argv: ['x'] })).rejects.toThrow(/unknown_vm/);
  });

  it("keeps QEMU's stderr as a diagnostic after removing the VM dir", async () => {
    const { a, handle, vmDir } = await created();
    fs.writeFileSync(path.join(vmDir, 'qemu.err'), 'qemu: warning\n');
    await a.destroy(handle);
    expect(fs.existsSync(vmDir)).toBe(false);
    const copy = path.join(stateDir, 'diagnostics', `${handle.vmId}.qemu.err`);
    expect(fs.readFileSync(copy, 'utf8')).toBe('qemu: warning\n');
    expect(fs.statSync(path.join(stateDir, 'diagnostics')).mode & 0o777).toBe(0o700);
  });

  it('treats a missing qemu.err as best effort, and skips the copy while QEMU survives', async () => {
    const { a, handle } = await created();
    await a.destroy(handle);
    expect(fs.existsSync(path.join(stateDir, 'diagnostics', `${handle.vmId}.qemu.err`))).toBe(
      false
    );
    host.state.dieOn = null;
    const stuck = await created(a);
    fs.writeFileSync(path.join(stuck.vmDir, 'qemu.err'), 'still running');
    await rejects(a.destroy(stuck.handle), VmCleanupError);
    expect(fs.existsSync(path.join(stateDir, 'diagnostics', `${stuck.handle.vmId}.qemu.err`))).toBe(
      false
    );
  });

  it.each([
    ['a pid of 1', { pid: 1 }],
    ['a pid of 0', { pid: 0 }],
    ['a fractional pid', { pid: 4242.5 }],
    ['a string pid', { pid: '4242' }],
    ['a numeric start token', { startToken: 7 }],
    ['a numeric run ID', { runId: 7 }],
    ['a zero command timeout', { limits: { ...LIMITS, commandTimeoutMs: 0 } }],
    ['a fractional command timeout', { limits: { ...LIMITS, commandTimeoutMs: 1.5 } }],
    ['no limits', { limits: null }],
    ['a non-string socket', { socket: 5 }],
  ])('distrusts a record with %s', async (_label, patch) => {
    const { a, handle, vmDir } = await created();
    const recordFile = path.join(vmDir, 'vm.json');
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    fs.writeFileSync(recordFile, JSON.stringify({ ...record, ...patch }));
    fs.chmodSync(recordFile, 0o600);
    expect(await a.listByRun('run-1')).toEqual([]);
    await expect(a.exec(handle, { profile: 'node', argv: ['x'] })).rejects.toThrow(/unknown_vm/);
    const result = await a.killAll('incident');
    expect(result.destroyed).toEqual([]);
    expect(result.failed.map((f) => f.leftoverPaths)).toEqual([[vmDir]]);
    expect(host.calls.kill).toEqual([]);
  });

  it('strictly decodes VM record bytes without discarding valid Unicode', async () => {
    const { a, handle, vmDir } = await created();
    const file = path.join(vmDir, 'vm.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bytes = Buffer.from(JSON.stringify({ ...record, note: 'Unicode café' }));
    fs.writeFileSync(file, bytes);
    expect(await a.listByRun('run-1')).toHaveLength(1);
    bytes[bytes.indexOf(Buffer.from('café'))] = 0xff;
    fs.writeFileSync(file, bytes);
    expect(await a.listByRun('run-1')).toEqual([]);
    await expect(a.exec(handle, { profile: 'node', argv: ['x'] })).rejects.toThrow(/unknown_vm/);
    expect(host.calls.kill).toEqual([]);
    expect(fs.existsSync(vmDir)).toBe(true);
  });

  it('accepts a record whose pid is null', async () => {
    const { a, handle, vmDir } = await created();
    const recordFile = path.join(vmDir, 'vm.json');
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    fs.writeFileSync(recordFile, JSON.stringify({ ...record, pid: null, startToken: null }));
    fs.chmodSync(recordFile, 0o600);
    expect(await a.listByRun('run-1')).toEqual([
      expect.objectContaining({ vmId: handle.vmId, pid: null, alive: false }),
    ]);
    await a.destroy(handle);
    expect(host.calls.kill).toEqual([]);
    expect(fs.existsSync(vmDir)).toBe(false);
  });

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    host.state.dieOn = 'SIGKILL';
    const { a, handle, vmDir } = await created();
    await a.destroy(handle);
    expect(host.calls.kill).toEqual([
      [PID, 'SIGTERM'],
      [PID, 'SIGKILL'],
    ]);
    expect(fs.existsSync(vmDir)).toBe(false);
  });

  it('keeps the VM dir and reports the pid while QEMU survives SIGKILL', async () => {
    host.state.dieOn = null;
    const { a, handle, vmDir } = await created();
    const error = await rejects(a.destroy(handle), VmCleanupError);
    expect(error.leftoverPids).toEqual([PID]);
    expect(error.leftoverPaths).toEqual([vmDir]);
    expect(host.calls.kill).toEqual([
      [PID, 'SIGTERM'],
      [PID, 'SIGKILL'],
    ]);
    expect(fs.existsSync(path.join(vmDir, 'vm.json'))).toBe(true);
  });

  it('never signals a recycled PID', async () => {
    const { a, handle, vmDir } = await created();
    host.tokens.set(PID, 'someone-else');
    await a.destroy(handle);
    expect(host.calls.kill).toEqual([]);
    expect(fs.existsSync(vmDir)).toBe(false);
  });

  it('treats a vanished process as gone', async () => {
    const { a, handle } = await created();
    host.tokens.set(PID, null);
    await a.destroy(handle);
    expect(host.calls.kill).toEqual([]);
  });

  it('reports an unknown owner when the start token cannot be read', async () => {
    const { a, handle, vmDir } = await created();
    host.tokens.set(PID, new Error('EACCES'));
    const error = await rejects(a.destroy(handle), VmCleanupError);
    expect(error.leftoverPids).toEqual([PID]);
    expect(error.leftoverPaths).toEqual([vmDir]);
    expect(host.calls.kill).toEqual([]);
    expect(fs.existsSync(vmDir)).toBe(true);
  });

  it('reports an unknown owner when the record has no start token', async () => {
    host.state.startTokenAtLaunch = null;
    const { a, handle } = await created();
    host.tokens.set(PID, 'tok-now');
    const error = await rejects(a.destroy(handle), VmCleanupError);
    expect(error.leftoverPids).toEqual([PID]);
    expect(host.calls.kill).toEqual([]);
  });

  it('reports leftover paths when removal fails', async () => {
    const { a, handle, vmDir } = await created();
    host.state.rmFails = true;
    const error = await rejects(a.destroy(handle), VmCleanupError);
    expect(error.leftoverPids).toEqual([]);
    expect(error.leftoverPaths).toEqual([vmDir]);
  });

  it('reports a leftover socket file', async () => {
    const { a, handle } = await created();
    const socket = path.join(runtimeDir, `${handle.vmId}.sock`);
    fs.writeFileSync(socket, '');
    host.state.rmFails = true;
    const error = await rejects(a.destroy(handle), VmCleanupError);
    expect(error.leftoverPaths).toContain(socket);
  });

  it.each([
    'zt-0123',
    '../zt-0123456789ab',
    'zt-0123456789AB',
    'vm-1',
    '',
  ])('refuses invalid VM ID %j', async (vmId) => {
    await expect(adapter().destroy({ vmId, runId: 'run-1' })).rejects.toThrow('Invalid VM ID');
    expect(host.calls.kill).toEqual([]);
  });

  it('ignores a tampered record whose vmDir points elsewhere', async () => {
    const { a, handle, vmDir } = await created();
    const recordFile = path.join(vmDir, 'vm.json');
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    fs.writeFileSync(recordFile, JSON.stringify({ ...record, vmDir: elsewhere }));
    fs.chmodSync(recordFile, 0o600);
    expect(await a.listByRun('run-1')).toEqual([]);
    await a.destroy(handle);
    // No record: the PID is never signalled and the foreign directory survives.
    expect(host.calls.kill).toEqual([]);
    expect(fs.existsSync(elsewhere)).toBe(true);
    expect(fs.existsSync(vmDir)).toBe(false);
  });

  it('ignores a tampered record whose socket names another VM', async () => {
    const { a, handle, vmDir } = await created();
    const recordFile = path.join(vmDir, 'vm.json');
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    const foreign = path.join(root, 'victim');
    fs.writeFileSync(foreign, 'keep');
    fs.writeFileSync(recordFile, JSON.stringify({ ...record, socket: foreign }));
    fs.chmodSync(recordFile, 0o600);
    await a.destroy(handle);
    expect(host.calls.kill).toEqual([]);
    expect(fs.readFileSync(foreign, 'utf8')).toBe('keep');
  });

  it('ignores a group-readable record', async () => {
    const { a, handle, vmDir } = await created();
    fs.chmodSync(path.join(vmDir, 'vm.json'), 0o644);
    expect(await a.listByRun('run-1')).toEqual([]);
    await a.destroy(handle);
    expect(host.calls.kill).toEqual([]);
  });

  it('is a no-op for a VM without a record', async () => {
    await expect(
      adapter().destroy({ vmId: 'zt-0123456789ab', runId: 'run-1' })
    ).resolves.toBeUndefined();
    expect(host.calls.kill).toEqual([]);
  });

  it('treats a record without a pid as gone', async () => {
    host.ops.launch = async () => {
      throw new Error('spawn ENOENT');
    };
    await expect(adapter().create(spec())).rejects.toThrow('spawn ENOENT');
    expect(fs.readdirSync(path.join(stateDir, 'vms'))).toEqual([]);
  });
});

describe('LocalQemuAdapter listing and kill switch', () => {
  it('lists VMs of one run with liveness and paths', async () => {
    const a = adapter();
    expect(await a.listByRun('run-a')).toEqual([]);
    const one = await a.create(spec('run-a'));
    const two = await a.create(spec('run-b'));
    fs.mkdirSync(path.join(stateDir, 'vms', 'junk'));
    fs.mkdirSync(path.join(stateDir, 'vms', 'zt-ffffffffffff'));
    fs.writeFileSync(path.join(stateDir, 'vms', 'zt-ffffffffffff', 'vm.json'), '{"vmId":"x"}');
    const listA = await a.listByRun('run-a');
    expect(listA).toEqual([
      {
        vmId: one.vmId,
        runId: 'run-a',
        pid: PID,
        alive: true,
        paths: [path.join(stateDir, 'vms', one.vmId)],
      },
    ]);
    host.alive.delete(PID + 1);
    expect((await a.listByRun('run-b'))[0]).toMatchObject({ vmId: two.vmId, alive: false });
    host.tokens.set(PID, new Error('EACCES'));
    host.alive.delete(PID);
    expect((await a.listByRun('run-a'))[0]?.alive).toBe(true);
    host.tokens.set(PID, 'recycled');
    expect((await a.listByRun('run-a'))[0]?.alive).toBe(false);
  });

  it('engages the kill switch, destroys every VM and collects failures', async () => {
    const j = journal();
    const a = adapter({ journal: j });
    const ok = await a.create(spec('run-a'));
    const stuck = await a.create(spec('run-b'));
    host.tokens.set(PID + 1, new Error('EACCES'));
    const result = await a.killAll('incident 42');
    expect(result.destroyed).toEqual([ok.vmId]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.leftoverPids).toEqual([PID + 1]);
    expect(a.killSwitchEngaged()).toBe(true);
    const switchFile = path.join(stateDir, KILL_SWITCH_FILE);
    expect(JSON.parse(fs.readFileSync(switchFile, 'utf8'))).toEqual({
      reason: 'incident 42',
      at: '2026-10-06T00:00:00.000Z',
    });
    expect(fs.statSync(switchFile).mode & 0o777).toBe(0o600);
    expect(j.read()).toContainEqual(
      expect.objectContaining({ type: 'vm_kill_switch', reason: 'incident 42' })
    );
    const refused = await rejects(a.create(spec('run-c')), UnsupportedEnvironmentError);
    expect(refused.detail).toBe('kill_switch_engaged');
    expect(stuck.vmId).toMatch(/^zt-/);
  });

  it('records unexpected destroy errors as failures, continues, and refuses secret reasons', async () => {
    const a = adapter();
    const first = await a.create(spec('run-a'));
    const second = await a.create(spec('run-b'));
    await expect(a.killAll('Bearer abc')).rejects.toThrow(/credential/);
    expect(a.killSwitchEngaged()).toBe(false);
    const alive = host.ops.alive;
    let calls = 0;
    // The first VM's teardown hits an unexpected error; the second must still be destroyed.
    host.ops.alive = (pid) => {
      if (calls++ === 0) throw new TypeError('proc unavailable');
      return alive(pid);
    };
    const result = await a.killAll('incident');
    expect(a.killSwitchEngaged()).toBe(true);
    expect(result.failed).toHaveLength(1);
    const [failure] = result.failed;
    expect(failure).toBeInstanceOf(VmCleanupError);
    expect(failure?.leftoverPids).toEqual([]);
    const ids = [first.vmId, second.vmId];
    const failedDir = failure?.leftoverPaths[0] ?? '';
    expect(failure?.leftoverPaths).toHaveLength(1);
    expect(ids.map((id) => path.join(stateDir, 'vms', id))).toContain(failedDir);
    expect(result.destroyed).toEqual(
      ids.filter((id) => path.join(stateDir, 'vms', id) !== failedDir)
    );
  });

  it('reports VM directories without a trustworthy record as failed', async () => {
    const a = adapter();
    const ok = await a.create(spec());
    const vms = path.join(stateDir, 'vms');
    const missing = path.join(vms, 'zt-aaaaaaaaaaaa');
    fs.mkdirSync(missing);
    const garbled = path.join(vms, 'zt-bbbbbbbbbbbb');
    fs.mkdirSync(garbled);
    fs.writeFileSync(path.join(garbled, 'vm.json'), '{"vmId":"zt-bbbbbbbbbbbb"}', { mode: 0o600 });
    const readable = path.join(vms, 'zt-cccccccccccc');
    fs.mkdirSync(readable);
    fs.writeFileSync(path.join(readable, 'vm.json'), '{}', { mode: 0o644 });
    // Not a VM directory name: ignored entirely.
    fs.mkdirSync(path.join(vms, 'junk'));
    const result = await a.killAll('incident');
    expect(result.destroyed).toEqual([ok.vmId]);
    expect(result.failed.map((f) => f.leftoverPaths).sort()).toEqual(
      [[missing], [garbled], [readable]].sort()
    );
    for (const f of result.failed) {
      expect(f).toBeInstanceOf(VmCleanupError);
      expect(f.leftoverPids).toEqual([]);
    }
    // Untrustworthy directories are left for an operator, never removed blindly.
    for (const dir of [missing, garbled, readable]) expect(fs.existsSync(dir)).toBe(true);
  });
});

describe('LocalQemuAdapter image ownership', () => {
  it.each([
    ['group-writable', 0o664],
    ['other-writable', 0o646],
  ])('refuses a %s image even when its digest matches', async (_label, mode) => {
    writeImage(profileDir, IMAGE_BYTES, mode);
    const error = await rejects(
      adapter({ verifyImage: true }).create(spec()),
      UnsupportedEnvironmentError
    );
    expect(error.detail).toBe('profile_image_untrusted');
    expect(error.message).toContain('not writable by group or others');
    expect(host.calls.run).toEqual([]);
  });

  it('accepts a read-only image owned by this user', async () => {
    writeImage(profileDir, IMAGE_BYTES, 0o400);
    await expect(adapter({ verifyImage: true }).create(spec())).resolves.toBeDefined();
  });

  it('refuses an image reached through a symlink before hashing it', async () => {
    const image = path.join(profileDir, 'image.qcow2');
    const real = path.join(root, 'real.qcow2');
    fs.renameSync(image, real);
    fs.symlinkSync(real, image);
    const error = await rejects(
      adapter({ verifyImage: true }).create(spec()),
      UnsupportedEnvironmentError
    );
    // The digest is read with O_NOFOLLOW, so a symlink never reaches the ownership check.
    expect(error.detail).toBe('profile_image_missing');
  });

  it.each([
    ['owned by another user', (stat: fs.Stats) => ({ uid: stat.uid + 1 })],
    ['no longer a regular file', () => ({ isFile: () => false })],
  ])('refuses an image %s', async (_label, patch) => {
    const image = path.join(profileDir, 'image.qcow2');
    const lstat = fs.lstatSync;
    const spy = vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike) => {
      const stat = lstat(target);
      if (String(target) !== image) return stat;
      for (const [key, value] of Object.entries(patch(stat)))
        Object.defineProperty(stat, key, { value });
      return stat;
    }) as typeof fs.lstatSync);
    try {
      const error = await rejects(
        adapter({ verifyImage: true }).create(spec()),
        UnsupportedEnvironmentError
      );
      expect(error.detail).toBe('profile_image_untrusted');
      expect(error.message).toContain('must be a regular file owned by this user');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('LocalQemuAdapter taint journaling', () => {
  it('journals a broker taint once, with the run and VM', async () => {
    const j = journal();
    host.state.respond = (f) => ({ v: 1, id: f.id, ok: true, exitCode: 999 });
    const a = adapter({ journal: j });
    const handle = await a.create(spec());
    await rejects(a.exec(handle, { profile: 'node', argv: ['x'] }), BrokerError);
    await rejects(a.exec(handle, { profile: 'node', argv: ['y'] }), BrokerError);
    const tainted = (j.read() as Record<string, unknown>[]).filter(
      (e) => e.type === 'vm_broker_tainted'
    );
    expect(tainted).toEqual([
      expect.objectContaining({
        runId: 'run-1',
        vmId: handle.vmId,
        code: 'malformed_response',
      }),
    ]);
  });
});

/** Rewrites a VM record in place, keeping it private. */
function patchRecord(vmDir: string, patch: Record<string, unknown>): void {
  const recordFile = path.join(vmDir, 'vm.json');
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  fs.writeFileSync(recordFile, JSON.stringify({ ...record, ...patch }));
  fs.chmodSync(recordFile, 0o600);
}

/** The controller crashed after QEMU wrote its pidfile but before the PID reached
 * the record. */
function crashBeforeRecord(vmDir: string, pid = PID): void {
  patchRecord(vmDir, { pid: null, startToken: null });
  fs.writeFileSync(path.join(vmDir, 'qemu.pid'), `${pid}\n`);
}

describe('LocalQemuAdapter.destroy without a recorded PID', () => {
  async function created(a = adapter(), runId = 'run-1') {
    const handle = await a.create(spec(runId));
    return { a, handle, vmDir: path.join(stateDir, 'vms', handle.vmId) };
  }

  it("stops a crash orphan whose own argv names this VM's pidfile", async () => {
    const j = journal();
    const { a, handle, vmDir } = await created(adapter({ journal: j }));
    crashBeforeRecord(vmDir);
    expect(await a.listByRun('run-1')).toEqual([
      expect.objectContaining({ vmId: handle.vmId, pid: PID, alive: true }),
    ]);
    await a.destroy(handle);
    expect(host.calls.kill).toEqual([[PID, 'SIGTERM']]);
    expect(fs.existsSync(vmDir)).toBe(false);
    expect(j.read()).toContainEqual(
      expect.objectContaining({ type: 'vm_destroyed', vmId: handle.vmId })
    );
  });

  it('never signals a pidfile PID whose argv names something else', async () => {
    const { a, handle, vmDir } = await created();
    crashBeforeRecord(vmDir);
    host.argv.set(PID, ['/usr/bin/vim', path.join(stateDir, 'vms', 'zt-ffffffffffff', 'qemu.pid')]);
    expect((await a.listByRun('run-1'))[0]).toMatchObject({ pid: PID, alive: false });
    await a.destroy(handle);
    expect(host.calls.kill).toEqual([]);
    expect(fs.existsSync(vmDir)).toBe(false);
  });

  it('treats a pidfile PID that no longer exists as gone', async () => {
    const { a, handle, vmDir } = await created();
    crashBeforeRecord(vmDir);
    host.alive.delete(PID);
    await a.destroy(handle);
    expect(host.calls.kill).toEqual([]);
    expect(fs.existsSync(vmDir)).toBe(false);
  });

  it('reports a pidfile PID whose argv cannot be read as a leftover, never signalling it', async () => {
    const { a, handle, vmDir } = await created();
    crashBeforeRecord(vmDir);
    host.argv.set(PID, new Error('EACCES'));
    expect((await a.listByRun('run-1'))[0]).toMatchObject({ pid: PID, alive: true });
    const error = await rejects(a.destroy(handle), VmCleanupError);
    expect(error.leftoverPids).toEqual([PID]);
    expect(error.leftoverPaths).toEqual([vmDir]);
    expect(error.vmId).toBe(handle.vmId);
    expect(error.message).toContain(handle.vmId);
    expect(host.calls.kill).toEqual([]);
    expect(fs.existsSync(path.join(vmDir, 'vm.json'))).toBe(true);
  });

  it('kill-all stops the QEMU of a directory whose record is unusable, and leaves the dir', async () => {
    const { a, handle, vmDir } = await created();
    crashBeforeRecord(vmDir);
    fs.writeFileSync(path.join(vmDir, 'vm.json'), '{}', { mode: 0o600 });
    const result = await a.killAll('incident');
    expect(host.calls.kill).toEqual([[PID, 'SIGTERM']]);
    expect(result.failed.map((f) => [f.vmId, f.leftoverPids])).toEqual([[handle.vmId, []]]);
    expect(fs.existsSync(vmDir)).toBe(true);
  });

  it('reports the PID when the QEMU of an unusable directory cannot be judged', async () => {
    const { a, handle, vmDir } = await created();
    crashBeforeRecord(vmDir);
    fs.writeFileSync(path.join(vmDir, 'vm.json'), '{}', { mode: 0o600 });
    host.argv.set(PID, new Error('EACCES'));
    const result = await a.killAll('incident');
    expect(host.calls.kill).toEqual([]);
    expect(result.failed.map((f) => [f.vmId, f.leftoverPids])).toEqual([[handle.vmId, [PID]]]);
  });

  it('reports a crash orphan that survives SIGKILL', async () => {
    host.state.dieOn = null;
    const { a, handle, vmDir } = await created();
    crashBeforeRecord(vmDir);
    const error = await rejects(a.destroy(handle), VmCleanupError);
    expect(error.leftoverPids).toEqual([PID]);
    expect(host.calls.kill).toEqual([
      [PID, 'SIGTERM'],
      [PID, 'SIGKILL'],
    ]);
  });

  it.each([
    ['garbage', 'not a pid'],
    ['pid 1', '1'],
    ['a negative pid', '-5'],
    ['a fractional pid', '4242.5'],
  ])('ignores a pidfile holding %s', async (_label, content) => {
    const { a, handle, vmDir } = await created();
    patchRecord(vmDir, { pid: null, startToken: null });
    fs.writeFileSync(path.join(vmDir, 'qemu.pid'), content);
    await a.destroy(handle);
    expect(host.calls.kill).toEqual([]);
    expect(fs.existsSync(vmDir)).toBe(false);
  });

  it('stops the QEMU of a directory without a record, and removes its default socket', async () => {
    const { a, handle, vmDir } = await created();
    fs.writeFileSync(path.join(vmDir, 'qemu.pid'), String(PID));
    fs.rmSync(path.join(vmDir, 'vm.json'));
    const socket = path.join(runtimeDir, `${handle.vmId}.sock`);
    fs.writeFileSync(socket, '');
    await a.destroy(handle);
    expect(host.calls.kill).toEqual([[PID, 'SIGTERM']]);
    expect(fs.existsSync(vmDir)).toBe(false);
    expect(fs.existsSync(socket)).toBe(false);
  });

  it('falls back to the default runtime dir for the socket of an unrecorded VM', async () => {
    const saved = process.env.XDG_RUNTIME_DIR;
    try {
      process.env.XDG_RUNTIME_DIR = path.join(root, 'xdg');
      const a = adapter({ runtimeDir: undefined });
      const handle = await a.create(spec());
      const socket = path.join(root, 'xdg', 'ai-dossier-zt', `${handle.vmId}.sock`);
      fs.writeFileSync(socket, '');
      fs.rmSync(path.join(stateDir, 'vms', handle.vmId, 'vm.json'));
      host.alive.delete(PID);
      await a.destroy(handle);
      expect(fs.existsSync(socket)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = saved;
    }
  });
});

const T0 = Date.parse('2026-10-05T00:00:00.000Z');
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();

/** A run in gating; `blocked` moves it to a terminal state, `cleanup` to blocked_cleanup. */
function run(runId: string, state: 'gating' | 'blocked' | 'blocked_cleanup' = 'gating'): RunRecord {
  const gating = createRun({ runId, upstreamIssue: 'o/r#1', contributor: 'alice' }, at(0));
  if (state === 'blocked') return transitionRun(gating, ReasonCode.PolicyBlocked, at(1));
  if (state === 'blocked_cleanup') return transitionRun(gating, ReasonCode.CleanupFailed, at(1));
  return gating;
}

describe('LocalQemuAdapter.killAll and blocked runs', () => {
  it('blocks the run of every VM it cannot confirm dead, and still attempts every VM', async () => {
    const j = journal();
    const a = adapter({ journal: j });
    const ids: Record<string, string> = {};
    for (const runId of ['run-a', 'run-b', 'run-c', 'run-d', 'run-e'])
      ids[runId] = (await a.create(spec(runId))).vmId;
    // Every VM except run-b's has an unreadable start token: not confirmed dead.
    for (let pid = PID; pid < PID + 5; pid++)
      if (pid !== PID + 1) host.tokens.set(pid, new Error('EACCES'));
    const runs: Record<string, RunRecord> = {
      'run-a': run('run-a'),
      'run-b': run('run-b'),
      'run-c': run('run-c', 'blocked_cleanup'),
      'run-e': run('run-e', 'blocked'),
    };
    const observed: RunRecord[] = [];
    const looked: string[] = [];
    const result = await a.killAll('incident', {
      lookupRun: (runId) => {
        looked.push(runId);
        return runs[runId];
      },
      observeRun: (blocked) => observed.push(blocked),
    });
    expect(result.destroyed).toEqual([ids['run-b']]);
    expect(result.failed.map((f) => f.vmId).sort()).toEqual(
      [ids['run-a'], ids['run-c'], ids['run-d'], ids['run-e']].sort()
    );
    expect(result.blockedRuns).toEqual(['run-a']);
    expect(looked.sort()).toEqual(['run-a', 'run-c', 'run-d', 'run-e']);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      runId: 'run-a',
      state: 'blocked_cleanup',
      reasonCode: ReasonCode.CleanupFailed,
      updatedAt: '2026-10-06T00:00:00.000Z',
    });
    const events = j.read() as Record<string, unknown>[];
    expect(events.filter((e) => e.type === 'vm_run_block_failed')).toEqual([
      expect.objectContaining({ runId: 'run-e', cause: 'IllegalTransitionError' }),
    ]);
  });

  it('journals a run it could not persist as blocked, and carries on', async () => {
    const j = journal();
    const a = adapter({ journal: j });
    const stuck = await a.create(spec('run-a'));
    const ok = await a.create(spec('run-b'));
    host.tokens.set(PID, new Error('EACCES'));
    const result = await a.killAll('incident', {
      lookupRun: (runId) => run(runId),
      observeRun: () => {
        throw new RangeError('store unavailable');
      },
    });
    expect(result.destroyed).toEqual([ok.vmId]);
    expect(result.failed.map((f) => f.vmId)).toEqual([stuck.vmId]);
    expect(result.blockedRuns).toEqual([]);
    expect(j.read()).toContainEqual(
      expect.objectContaining({ type: 'vm_run_block_failed', runId: 'run-a', cause: 'RangeError' })
    );
  });

  it('blocks nothing without a run lookup, and blocks runs whose destroy failed unexpectedly', async () => {
    const a = adapter();
    await a.create(spec('run-a'));
    host.tokens.set(PID, new Error('EACCES'));
    expect((await a.killAll('incident')).blockedRuns).toEqual([]);
    host.ops.alive = () => {
      throw new TypeError('proc unavailable');
    };
    host.tokens.set(PID, `tok-${PID}`);
    const observed: RunRecord[] = [];
    const result = await a.killAll('incident', {
      lookupRun: (runId) => run(runId),
      observeRun: (blocked) => observed.push(blocked),
    });
    expect(result.failed[0]?.leftoverPids).toEqual([]);
    expect(result.blockedRuns).toEqual(['run-a']);
    expect(observed.map((r) => r.state)).toEqual(['blocked_cleanup']);
  });

  it('names the VM of an untrustworthy directory in its failure', async () => {
    const a = adapter();
    fs.mkdirSync(path.join(stateDir, 'vms', 'zt-aaaaaaaaaaaa'), { recursive: true });
    const result = await a.killAll('incident');
    expect(result.failed.map((f) => f.vmId)).toEqual(['zt-aaaaaaaaaaaa']);
    expect(result.failed[0]?.message).toContain('for zt-aaaaaaaaaaaa');
  });
});

describe('LocalQemuAdapter orphan QEMU processes', () => {
  /** A VM whose directory is gone while its QEMU still runs. */
  async function orphan(a: LocalQemuAdapter): Promise<string> {
    const handle = await a.create(spec());
    fs.rmSync(path.join(stateDir, 'vms', handle.vmId), { recursive: true });
    return handle.vmId;
  }

  /** Processes the adapter must never touch: another state dir, unreadable argv,
   * a pidfile in a directory that is not a VM ID, no pidfile at all. */
  function bystanders(): void {
    const other = path.join(root, 'other-state', 'vms', 'zt-111111111111', 'qemu.pid');
    const entries: [number, string[] | Error][] = [
      [9001, ['qemu-system-x86_64', '-pidfile', other]],
      [9002, new Error('EACCES')],
      [9003, ['qemu-system-x86_64', '-pidfile', path.join(stateDir, 'vms', 'junk', 'qemu.pid')]],
      [9004, ['sleep', '30']],
      [
        9005,
        [
          'qemu-system-x86_64',
          '-pidfile',
          path.join(stateDir, 'vms', 'zt-222222222222', 'qemu.log'),
        ],
      ],
      [9006, ['qemu-system-x86_64', '-pidfile']],
    ];
    for (const [pid, argv] of entries) {
      host.alive.add(pid);
      host.argv.set(pid, argv);
    }
  }

  it('kill-all stops a QEMU of this state dir whose directory is gone', async () => {
    const a = adapter();
    const vmId = await orphan(a);
    bystanders();
    const result = await a.killAll('incident');
    expect(result.destroyed).toEqual([vmId]);
    expect(result.failed).toEqual([]);
    expect(host.calls.kill).toEqual([[PID, 'SIGTERM']]);
  });

  it('kill-all reports an orphan that survives SIGKILL', async () => {
    host.state.dieOn = null;
    const a = adapter();
    const vmId = await orphan(a);
    const result = await a.killAll('incident');
    expect(result.destroyed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ vmId, leftoverPids: [PID], leftoverPaths: [] });
  });

  it('kill-all leaves the QEMU of a directory that still exists to that directory', async () => {
    host.state.dieOn = null;
    const a = adapter();
    const handle = await a.create(spec());
    host.tokens.set(PID, new Error('EACCES'));
    const result = await a.killAll('incident');
    expect(result.failed.map((f) => f.vmId)).toEqual([handle.vmId]);
    expect(host.calls.kill).toEqual([]);
  });
});

describe('qemuPidFile and findQemuProcesses', () => {
  it.each([
    ['a qemu-system binary by name', ['qemu-system-x86_64', '-pidfile', '/s/p'], '/s/p'],
    [
      'a qemu-system binary by path',
      ['/usr/bin/qemu-system-aarch64', '-a', '-pidfile', '/s/p'],
      '/s/p',
    ],
    ['null argv', null, null],
    ['empty argv', [], null],
    ['a non-QEMU binary', ['tail', '-f', '/s/p'], null],
    ['an editor naming -pidfile', ['/usr/bin/vim', '-pidfile', '/s/p'], null],
    ['plain qemu', ['qemu', '-pidfile', '/s/p'], null],
    ['QEMU without -pidfile', ['qemu-system-x86_64', '/s/p'], null],
    ['-pidfile without an operand', ['qemu-system-x86_64', '-pidfile'], null],
    [
      'a binary path whose directory says qemu-system',
      ['/qemu-system-x/sh', '-pidfile', '/s/p'],
      null,
    ],
  ] as [string, string[] | null, string | null][])('%s', (_label, argv, expected) => {
    expect(qemuPidFile(argv)).toBe(expected);
  });

  it('keeps accepted QEMU processes, skipping unreadable and rejected ones', () => {
    const argv: Record<number, string[] | null | Error> = {
      1: ['qemu-system-x86_64', '-pidfile', '/a/qemu.pid'],
      2: ['qemu-system-x86_64', '-pidfile', '/b/qemu.pid'],
      3: new Error('EACCES'),
      4: null,
      5: ['tail', '-f', '/a/qemu.pid'],
    };
    const ops = {
      listProcesses: () => Object.keys(argv).map(Number),
      cmdline: (pid: number) => {
        const value = argv[pid];
        if (value instanceof Error) throw value;
        return value ?? null;
      },
    };
    expect([...findQemuProcesses(ops, (f) => f.startsWith('/a/'))]).toEqual([[1, '/a/qemu.pid']]);
  });
});

describe('LocalQemuAdapter never signals a process that only mentions a pidfile', () => {
  const impostors: [string, (pidFile: string) => string[]][] = [
    ['tail on the pidfile', (pidFile) => ['tail', '-f', pidFile]],
    ['an editor on the pidfile', (pidFile) => ['/usr/bin/vim', pidFile]],
    [
      'a QEMU naming the pidfile outside -pidfile',
      (pidFile) => [
        '/opt/fake/qemu-system-x86_64',
        '-drive',
        `file=${pidFile}`,
        pidFile,
        '-pidfile',
        path.join(root, 'elsewhere', 'qemu.pid'),
      ],
    ],
  ];

  /** A VM whose QEMU is gone, with `argv` holding the PID its pidfile names. */
  async function impostor(a: LocalQemuAdapter, argv: (pidFile: string) => string[]) {
    const handle = await a.create(spec());
    const vmDir = path.join(stateDir, 'vms', handle.vmId);
    crashBeforeRecord(vmDir);
    host.argv.set(PID, argv(path.join(vmDir, 'qemu.pid')));
    return { handle, vmDir };
  }

  it.each(impostors)('destroy: %s', async (_label, argv) => {
    const a = adapter();
    const { handle, vmDir } = await impostor(a, argv);
    await a.destroy(handle);
    expect(host.calls.kill).toEqual([]);
    expect(fs.existsSync(vmDir)).toBe(false);
  });

  it.each(impostors)('kill-all, with and without its directory: %s', async (_label, argv) => {
    const a = adapter();
    const { vmDir } = await impostor(a, argv);
    const kept = await a.create(spec('run-2')); // PID + 1, a real QEMU
    fs.rmSync(path.join(stateDir, 'vms', kept.vmId), { recursive: true });
    host.argv.set(PID + 2, argv(path.join(stateDir, 'vms', 'zt-333333333333', 'qemu.pid')));
    host.alive.add(PID + 2);
    await a.killAll('incident');
    expect(host.calls.kill).toEqual([[PID + 1, 'SIGTERM']]);
    expect(fs.existsSync(vmDir)).toBe(false);
  });

  it.each(impostors)('reconcile, reporting and destroying: %s', async (_label, argv) => {
    const a = adapter();
    const { handle } = await impostor(a, argv);
    // A process naming the pidfile of a directory that no longer exists.
    host.argv.set(PID + 7, argv(path.join(stateDir, 'vms', 'zt-444444444444', 'qemu.pid')));
    host.alive.add(PID + 7);
    const report = await a.reconcile();
    expect(report.live).toEqual([]);
    expect(report.staleDirs).toEqual([handle.vmId]);
    expect(report.orphanProcesses).toEqual([]);
    fs.writeFileSync(path.join(stateDir, KILL_SWITCH_FILE), '{}', { mode: 0o600 });
    const destroyed = await a.reconcile({ destroy: true });
    expect(destroyed.destroyed).toEqual([handle.vmId]);
    expect(host.calls.kill).toEqual([]);
  });
});

describe('LocalQemuAdapter.releaseKillSwitch', () => {
  const marker = () => path.join(stateDir, KILL_SWITCH_FILE);

  it('returns false when the kill switch is not engaged', () => {
    const j = journal();
    expect(adapter({ journal: j }).releaseKillSwitch('all clear')).toBe(false);
    expect(j.read()).toEqual([]);
  });

  it('refuses while a VM directory remains', async () => {
    const a = adapter();
    const handle = await a.create(spec());
    host.tokens.set(PID, new Error('EACCES'));
    await a.killAll('incident');
    expect(() => a.releaseKillSwitch('all clear')).toThrow(
      new RegExp(`stays engaged: 1 VM\\(s\\) remain \\(${handle.vmId}\\)`)
    );
    expect(a.killSwitchEngaged()).toBe(true);
  });

  it('refuses while an orphan QEMU of this state dir runs', async () => {
    host.state.dieOn = null;
    const a = adapter();
    const handle = await a.create(spec());
    fs.rmSync(path.join(stateDir, 'vms', handle.vmId), { recursive: true });
    await a.killAll('incident');
    expect(() => a.releaseKillSwitch('all clear')).toThrow(handle.vmId);
    expect(fs.existsSync(marker())).toBe(true);
  });

  it('releases once nothing remains, journaling who engaged it and when', async () => {
    const j = journal();
    const a = adapter({ journal: j });
    await a.create(spec());
    await a.killAll('incident 42');
    expect(a.releaseKillSwitch('all clear')).toBe(true);
    expect(a.killSwitchEngaged()).toBe(false);
    expect(j.read()).toContainEqual(
      expect.objectContaining({
        type: 'vm_kill_switch_released',
        reason: 'all clear',
        engagedReason: 'incident 42',
        engagedAt: '2026-10-06T00:00:00.000Z',
      })
    );
    await expect(a.create(spec('run-2'))).resolves.toBeDefined();
    expect(a.releaseKillSwitch('again')).toBe(false);
  });

  it.each([
    ['unreadable', '{}', 0o644],
    ['not JSON', 'oops', 0o600],
    ['wrongly typed', '{"reason":7,"at":null}', 0o600],
  ])('releases a marker that is %s, journaling no engagement details', (_label, content, mode) => {
    const j = journal();
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(marker(), content);
    fs.chmodSync(marker(), mode);
    expect(adapter({ journal: j }).releaseKillSwitch('all clear')).toBe(true);
    expect(fs.existsSync(marker())).toBe(false);
    expect(j.read()).toContainEqual(
      expect.objectContaining({
        type: 'vm_kill_switch_released',
        engagedReason: null,
        engagedAt: null,
      })
    );
  });

  it.each([
    ['a new incident replaces it', ['{"reason":"old"}', 0o600], ['{"reason":"new"}', 0o600]],
    ['an unreadable marker is replaced', ['{}', 0o644], ['{"reason":"new"}', 0o600]],
    ['a readable marker becomes unreadable', ['{"reason":"old"}', 0o600], ['{}', 0o644]],
  ] as [
    string,
    [string, number],
    [string, number],
  ][])('stays engaged when the marker changes during release: %s', (_label, [before, beforeMode], [
    after,
    afterMode,
  ]) => {
    const j = journal();
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(marker(), before);
    fs.chmodSync(marker(), beforeMode);
    const rename = fs.renameSync;
    let raced = false;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((
      from: fs.PathLike,
      to: fs.PathLike
    ) => {
      if (!raced && String(from) === marker()) {
        raced = true; // a kill-all for a new incident lands just before the move
        fs.rmSync(marker());
        fs.writeFileSync(marker(), after, { mode: afterMode });
        fs.chmodSync(marker(), afterMode);
      }
      rename(from, to);
    }) as typeof fs.renameSync);
    try {
      expect(() => adapter({ journal: j }).releaseKillSwitch('all clear')).toThrow(
        're-engaged during release'
      );
    } finally {
      spy.mockRestore();
    }
    expect(raced).toBe(true);
    expect(fs.readFileSync(marker(), 'utf8')).toBe(after);
    expect(fs.readdirSync(stateDir).filter((n) => n.includes('.released-'))).toEqual([]);
    expect(j.read()).toEqual([]);
  });

  it('still journals the release when the moved-aside marker cannot be removed', () => {
    const j = journal();
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(marker(), '{"reason":"incident"}', { mode: 0o600 });
    const spy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('EIO');
    });
    try {
      expect(adapter({ journal: j }).releaseKillSwitch('all clear')).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(marker())).toBe(false);
    expect(j.read()).toContainEqual(
      expect.objectContaining({ type: 'vm_kill_switch_released', engagedReason: 'incident' })
    );
  });

  it('works on an adapter with no manifest and no injected tools, as zt-vm teardown builds it', async () => {
    const j = journal();
    const full = adapter();
    const stale = await full.create(spec());
    host.alive.delete(PID);
    fs.rmSync(path.join(profileDir, 'manifest.json'));
    const bare = new LocalQemuAdapter({
      stateDir,
      profileDir: path.join(root, 'no-profile'),
      runtimeDir,
      verifyImage: false,
      ops: host.ops,
      journal: j,
    });
    expect((await bare.reconcile()).staleDirs).toEqual([stale.vmId]);
    fs.writeFileSync(marker(), '{"reason":"incident"}', { mode: 0o600 });
    expect((await bare.reconcile({ destroy: true })).destroyed).toEqual([stale.vmId]);
    expect(bare.releaseKillSwitch('all clear')).toBe(true);
    expect(bare.killSwitchEngaged()).toBe(false);
    expect((j.read() as Record<string, unknown>[]).map((e) => e.type)).toEqual([
      'vm_reconcile',
      'vm_destroyed',
      'vm_reconcile',
      'vm_kill_switch_released',
    ]);
  });

  it('refuses a secret-shaped reason before touching the marker', async () => {
    const a = adapter();
    await a.killAll('incident');
    expect(() => a.releaseKillSwitch('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toThrow(
      /credential/
    );
    expect(a.killSwitchEngaged()).toBe(true);
  });
});

describe('LocalQemuAdapter.reconcile', () => {
  /** Engages the kill switch without stopping anything, as an operator's marker. */
  const engage = () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, KILL_SWITCH_FILE), '{}', { mode: 0o600 });
  };

  /** live, stale, crash-orphan (live via pidfile), untrusted, orphan process,
   * unverified (start token unreadable). */
  async function scene(a: LocalQemuAdapter) {
    const live = (await a.create(spec('run-live'))).vmId; // PID
    const stale = (await a.create(spec('run-stale'))).vmId; // PID + 1
    host.alive.delete(PID + 1);
    const crashed = (await a.create(spec('run-crash'))).vmId; // PID + 2
    crashBeforeRecord(path.join(stateDir, 'vms', crashed), PID + 2);
    const untrusted = (await a.create(spec('run-untrusted'))).vmId; // PID + 3
    fs.writeFileSync(path.join(stateDir, 'vms', untrusted, 'qemu.pid'), String(PID + 3));
    fs.rmSync(path.join(stateDir, 'vms', untrusted, 'vm.json'));
    const orphaned = (await a.create(spec('run-orphan'))).vmId; // PID + 4
    fs.rmSync(path.join(stateDir, 'vms', orphaned), { recursive: true });
    const unverified = (await a.create(spec('run-unverified'))).vmId; // PID + 5
    host.tokens.set(PID + 5, new Error('EACCES'));
    return { live, stale, crashed, untrusted, orphaned, unverified };
  }

  it('classifies VM directories and orphan processes without touching anything', async () => {
    const j = journal();
    const a = adapter({ journal: j });
    expect(await a.reconcile()).toEqual({
      live: [],
      staleDirs: [],
      unverifiedDirs: [],
      untrustedDirs: [],
      orphanProcesses: [],
      destroyed: [],
      failed: [],
    });
    const ids = await scene(a);
    const report = await a.reconcile();
    expect(report.live.sort()).toEqual([ids.live, ids.crashed].sort());
    expect(report.staleDirs).toEqual([ids.stale]);
    expect(report.unverifiedDirs).toEqual([ids.unverified]);
    expect(report.untrustedDirs).toEqual([ids.untrusted]);
    expect(report.orphanProcesses).toEqual([{ pid: PID + 4, vmId: ids.orphaned }]);
    expect(report.destroyed).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(host.calls.kill).toEqual([]);
    for (const vmId of [ids.live, ids.stale, ids.crashed, ids.untrusted, ids.unverified])
      expect(fs.existsSync(path.join(stateDir, 'vms', vmId))).toBe(true);
    const events = (j.read() as Record<string, unknown>[]).filter((e) => e.type === 'vm_reconcile');
    expect(events.at(-1)).toMatchObject({
      destroy: false,
      staleDirs: [ids.stale],
      unverifiedDirs: [ids.unverified],
      untrustedDirs: [ids.untrusted],
      orphanProcesses: [ids.orphaned],
    });
  });

  it('counts a directory whose QEMU owner is unknown as unverified, neither live nor stale', async () => {
    const a = adapter();
    const handle = await a.create(spec());
    host.tokens.set(PID, new Error('EACCES'));
    const report = await a.reconcile();
    expect(report.unverifiedDirs).toEqual([handle.vmId]);
    expect(report.staleDirs).toEqual([]);
    expect(report.live).toEqual([]);
  });

  it('counts a record without a start token as unverified', async () => {
    const a = adapter();
    const handle = await a.create(spec());
    patchRecord(path.join(stateDir, 'vms', handle.vmId), { startToken: null });
    expect((await a.reconcile()).unverifiedDirs).toEqual([handle.vmId]);
  });

  it('refuses to destroy unless the kill switch is engaged, touching nothing', async () => {
    const j = journal();
    const a = adapter({ journal: j });
    const ids = await scene(a);
    await expect(a.reconcile({ destroy: true })).rejects.toThrow('needs the kill switch engaged');
    expect(host.calls.kill).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, 'vms', ids.stale))).toBe(true);
    const types = (j.read() as Record<string, unknown>[]).map((e) => e.type);
    expect(types).not.toContain('vm_reconcile');
    expect(types).not.toContain('vm_destroyed');
  });

  it('with destroy, cleans up stale and untrusted directories and stops orphans', async () => {
    const j = journal();
    const a = adapter({ journal: j });
    const ids = await scene(a);
    engage();
    const report = await a.reconcile({ destroy: true });
    expect(report.destroyed.sort()).toEqual([ids.stale, ids.untrusted, ids.orphaned].sort());
    // The unverified directory is attempted: its PID is reported, never signalled.
    expect(report.failed.map((f) => [f.vmId, f.leftoverPids])).toEqual([
      [ids.unverified, [PID + 5]],
    ]);
    expect(host.calls.kill.sort()).toEqual([
      [PID + 3, 'SIGTERM'],
      [PID + 4, 'SIGTERM'],
    ]);
    expect(fs.readdirSync(path.join(stateDir, 'vms')).sort()).toEqual(
      [ids.live, ids.crashed, ids.unverified].sort()
    );
    const events = j.read() as Record<string, unknown>[];
    expect(events.find((e) => e.type === 'vm_reconcile')).toMatchObject({
      destroy: true,
      unverifiedDirs: [ids.unverified],
    });
    const destroyed = events.filter((e) => e.type === 'vm_destroyed');
    expect(destroyed.map((e) => [e.vmId, e.runId]).sort()).toEqual(
      [
        [ids.stale, 'run-stale'],
        [ids.untrusted, null],
        [ids.orphaned, null],
      ].sort()
    );
    expect(destroyed.find((e) => e.vmId === ids.orphaned)).toMatchObject({ orphan: true });
  });

  it('with destroy, reports what it could not clean up', async () => {
    const a = adapter();
    // Untrusted dir whose pidfile PID has unreadable argv: reported, never signalled.
    const unreadable = (await a.create(spec('run-a'))).vmId; // PID
    fs.writeFileSync(path.join(stateDir, 'vms', unreadable, 'qemu.pid'), String(PID));
    fs.rmSync(path.join(stateDir, 'vms', unreadable, 'vm.json'));
    host.argv.set(PID, new Error('EACCES'));
    // Stale dir whose teardown hits an unexpected error.
    const broken = (await a.create(spec('run-b'))).vmId; // PID + 1
    const alive = host.ops.alive;
    let probes = 0;
    host.ops.alive = (pid) => {
      if (pid === PID + 1 && probes++ > 0) throw new TypeError('proc unavailable');
      return pid === PID + 1 ? false : alive(pid);
    };
    // Orphan that survives SIGKILL.
    host.state.dieOn = null;
    const orphaned = (await a.create(spec('run-c'))).vmId; // PID + 2
    fs.rmSync(path.join(stateDir, 'vms', orphaned), { recursive: true });

    engage();
    const report = await a.reconcile({ destroy: true });
    expect(report.untrustedDirs).toEqual([unreadable]);
    expect(report.staleDirs).toEqual([broken]);
    expect(report.destroyed).toEqual([]);
    const byVm = Object.fromEntries(report.failed.map((f) => [f.vmId, f]));
    expect(byVm[unreadable]).toMatchObject({
      leftoverPids: [PID],
      leftoverPaths: [path.join(stateDir, 'vms', unreadable)],
    });
    expect(byVm[broken]).toMatchObject({
      leftoverPids: [],
      leftoverPaths: [path.join(stateDir, 'vms', broken)],
    });
    expect(byVm[orphaned]).toMatchObject({ leftoverPids: [PID + 2], leftoverPaths: [] });
    expect(byVm[broken]).toBeInstanceOf(VmCleanupError);
    expect(host.calls.kill.filter(([pid]) => pid === PID)).toEqual([]);
  });
});

describe('systemOps', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-ops-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const env = { PATH: '/usr/bin:/bin', LANG: 'C' };

  it('run resolves on success and reports the binary on failure', async () => {
    await expect(systemOps.run('/bin/true', [], env)).resolves.toBeUndefined();
    await expect(systemOps.run('/bin/false', [], env)).rejects.toThrow('false failed, exit 1: ');
    await expect(systemOps.run('/bin/sh', ['-c', 'echo boom >&2; exit 3'], env)).rejects.toThrow(
      'sh failed, exit 3: boom'
    );
    await expect(systemOps.run('/bin/sh', ['-c', 'kill -TERM $$'], env)).rejects.toThrow(
      /sh failed, exit (null|unknown) \(SIGTERM\)/
    );
  });

  it('launch returns a kill() that terminates the spawned child', async () => {
    const launched = await systemOps.launch('/bin/sleep', ['30'], env, path.join(dir, 's.log'));
    expect(systemOps.alive(launched.pid)).toBe(true);
    const started = Date.now();
    launched.kill?.();
    await launched.exited;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(systemOps.alive(launched.pid)).toBe(false);
    // A second kill after exit is a no-op, never a signal to a reused PID.
    expect(() => launched.kill?.()).not.toThrow();
  });

  it('launch detaches and reports the stderr tail on exit', async () => {
    const stderrFile = path.join(dir, 'err.log');
    const launched = await systemOps.launch(
      '/bin/sh',
      ['-c', 'echo err >&2; exit 0'],
      env,
      stderrFile
    );
    expect(launched.pid).toBeGreaterThan(0);
    expect(await launched.exited).toBe('err\n');
    expect(fs.statSync(stderrFile).mode & 0o777).toBe(0o600);
  });

  it('launch reports an empty tail when the log vanished', async () => {
    const stderrFile = path.join(dir, 'gone.log');
    const launched = await systemOps.launch('/bin/sh', ['-c', 'sleep 0.2'], env, stderrFile);
    fs.rmSync(stderrFile);
    expect(await launched.exited).toBe('');
  });

  it('launch rejects when the binary cannot be spawned', async () => {
    await expect(
      systemOps.launch(path.join(dir, 'missing'), [], env, path.join(dir, 'e.log'))
    ).rejects.toThrow(/ENOENT/);
  });

  it('connect opens a UNIX socket and rejects a missing one', async () => {
    const socketPath = path.join(dir, 's.sock');
    const server = net.createServer((socket) => socket.end('hello\n'));
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const socket = await systemOps.connect(socketPath);
      const data = await new Promise<string>((resolve) =>
        socket.once('data', (d) => resolve(String(d)))
      );
      expect(data).toBe('hello\n');
      socket.destroy();
      await expect(systemOps.connect(path.join(dir, 'none.sock'))).rejects.toThrow();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('cmdline reads argv from /proc, and listProcesses lists PIDs', () => {
    const argv = systemOps.cmdline(process.pid);
    expect(argv?.length).toBeGreaterThan(0);
    expect(argv?.at(-1)).not.toBe('');
    expect(systemOps.cmdline(2 ** 30)).toBeNull();
    const pids = systemOps.listProcesses();
    expect(pids).toContain(process.pid);
    expect(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0)).toBe(true);
  });

  it('cmdline keeps empty arguments but drops the trailing terminator', () => {
    const read = fs.readFileSync;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((
      file: fs.PathOrFileDescriptor,
      ...rest: unknown[]
    ) => {
      if (file === '/proc/12345/cmdline') return 'qemu\0\0-name\0';
      if (file === '/proc/12346/cmdline') return '';
      if (file === '/proc/12347/cmdline')
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return (read as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync);
    try {
      expect(systemOps.cmdline(12345)).toEqual(['qemu', '', '-name']);
      expect(systemOps.cmdline(12346)).toEqual([]);
      expect(() => systemOps.cmdline(12347)).toThrow('EACCES');
    } finally {
      spy.mockRestore();
    }
  });

  it('alive, kill, startToken, rm and sleep', async () => {
    expect(systemOps.alive(process.pid)).toBe(true);
    expect(systemOps.alive(2 ** 30)).toBe(false);
    expect(typeof systemOps.startToken(process.pid)).toBe('string');
    expect(() => systemOps.kill(2 ** 30, 'SIGTERM')).toThrow();
    const target = path.join(dir, 'a', 'b');
    fs.mkdirSync(target, { recursive: true });
    systemOps.rm(path.join(dir, 'a'));
    expect(fs.existsSync(path.join(dir, 'a'))).toBe(false);
    systemOps.rm(path.join(dir, 'a'));
    const start = Date.now();
    await systemOps.sleep(15);
    expect(Date.now() - start).toBeGreaterThanOrEqual(10);
  });
});
