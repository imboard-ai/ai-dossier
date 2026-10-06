import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Journal } from '../journal';
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
  type HostOps,
  KILL_SWITCH_FILE,
  LocalQemuAdapter,
  type LocalQemuOptions,
  systemOps,
} from '../vm/local-qemu';
import { PROFILE_PINS, profileDigest } from '../vm/profile';
import { BROKER_PORT_NAME, SCOPE_OEM_PREFIX } from '../vm/qemu-args';

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

/** Guest end of a broker socket: answers hello with `scope`, then `respond`. */
function fakeGuest(scope: string | null, respond: Responder, seen: Frame[]): Duplex {
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
              : { v: 1, id: 0, hello: 'zt-broker-v1', scope }
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
  state: {
    nextPid: number;
    /** Overrides the scope the guest announces; null = never answer hello. */
    guestScope?: string | null;
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
    state: { nextPid: PID, respond: defaultResponder, dieOn: 'SIGTERM' },
    ops: undefined as unknown as HostOps,
  };
  let scope: string | null = null;
  host.ops = {
    async run(binary, args, env) {
      host.calls.run.push({ binary, args, env });
    },
    async launch(binary, args, env, stderrFile) {
      host.calls.launch.push({ binary, args, env, stderrFile });
      const oem = String(args[args.indexOf('-smbios') + 1]);
      scope = oem.slice(oem.indexOf(SCOPE_OEM_PREFIX) + SCOPE_OEM_PREFIX.length);
      const pid = host.state.nextPid++;
      host.alive.add(pid);
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
      return fakeGuest(announced, (f) => host.state.respond(f), host.seen);
    },
    startToken(pid) {
      const token = host.tokens.get(pid);
      if (token instanceof Error) throw token;
      return token ?? null;
    },
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

function writeManifest(profileDir: string, over: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(profileDir, 'image.qcow2'), IMAGE_BYTES);
  const manifest = path.join(profileDir, 'manifest.json');
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      schema: 'zt-vm-profile-v1',
      profileDigest: profileDigest(AGENT),
      baseImageSha256: PROFILE_PINS.baseImage.sha256,
      containerBaseDigest: PROFILE_PINS.containerBase.digest,
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
    expect(await a.killAll('incident')).toEqual({ destroyed: [], failed: [] });
    expect(a.killSwitchEngaged()).toBe(true);
  });

  it('cleans up VMs created by an earlier adapter after the profile is gone', async () => {
    const handle = await adapter().create(spec());
    fs.rmSync(path.join(profileDir, 'manifest.json'));
    const a = adapter({ tools: undefined });
    expect(await a.listByRun('run-1')).toHaveLength(1);
    const result = await a.killAll('incident');
    expect(result).toEqual({ destroyed: [handle.vmId], failed: [] });
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
    expect(launch?.args).toContain(`type=11,value=${SCOPE_OEM_PREFIX}container`);
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
    expect(host.calls.launch[0]?.args).toContain(`type=11,value=${SCOPE_OEM_PREFIX}vm-root`);
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
    fs.writeFileSync(path.join(profileDir, 'image.qcow2'), backed);
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

describe('LocalQemuAdapter broker operations', () => {
  it('scales exec timeouts by TIMEOUT_SCALE under TCG', async () => {
    const a = adapter({ tools: tools('tcg') });
    const handle = await a.create(spec());
    const result = await a.exec(handle, { profile: 'node', argv: ['node', '-v'] });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'hi', stderr: '' });
    expect(host.seen.find((f) => f.op === 'exec')).toMatchObject({ timeoutMs: 4 * 5000, cwd: '' });
    await a.exec(handle, { profile: 'python', argv: ['python3'], cwd: 'src', timeoutMs: 2000 });
    expect(host.seen.filter((f) => f.op === 'exec')[1]).toMatchObject({
      timeoutMs: 8000,
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
