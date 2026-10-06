/** Local, rootless QEMU implementation of the VM adapter. Linux hosts only. */
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { privateDir, readPrivate, replacePrivate } from '../durable-fs';
import type { Journal } from '../journal';
import { processStartToken } from '../lock';
import { assertNoSecrets } from '../redaction';
import {
  type Accelerator,
  type AcceleratorRequest,
  appendVmEvent,
  BrokerError,
  type ExecRequest,
  type ExecResult,
  type ExecScope,
  type NetworkPhase,
  type ProxyTarget,
  UnsupportedEnvironmentError,
  type VmAdapter,
  VmCleanupError,
  type VmHandle,
  type VmLimits,
  type VmListing,
  type VmSpec,
} from './adapter';
import { BrokerClient } from './broker';
import { type HostTools, preflightHost } from './host';
import {
  assertStandaloneQcow2,
  BAKED_DISK_GIB,
  parseManifest,
  profileDigest,
  sha256File,
  type VmProfileManifest,
} from './profile';
import { assertProxyTarget, ProvisionChannel } from './provision-channel';
import {
  BOOT_TIMEOUT_MS,
  buildOverlayArgs,
  buildRunArgs,
  MAX_SOCKET_PATH_BYTES,
  QEMU_ENV,
  TIMEOUT_SCALE,
} from './qemu-args';

export const AGENT_SOURCE_PATH = path.join(__dirname, '..', '..', 'vm-guest', 'agent.py');
export const KILL_SWITCH_FILE = 'KILL_SWITCH';
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const VM_ID = /^zt-[a-f0-9]{12}$/;
/** Base wall clock for put/get and the grace added to an exec, before TCG scaling. */
const BROKER_RPC_TIMEOUT_MS = 60_000;
/** How long QEMU gets to create the broker socket after start. */
const SOCKET_WAIT_MS = 30_000;
const POLL_MS = 100;
/** Wait after SIGTERM, then after SIGKILL, before a PID is reported as left behind. */
const KILL_GRACE_MS = 5000;
/** How long a guest gets to power off cleanly at the end of provisioning (before TCG scaling). */
const SHUTDOWN_WAIT_MS = 60_000;
const RUN_TOOL_TIMEOUT_MS = 30 * 60_000;
const STDERR_TAIL_BYTES = 2000;

/** Everything that touches processes or sockets; replaced in unit tests. */
export interface Launched {
  readonly pid: number;
  /** Settles with QEMU's own stderr tail when the process exits. */
  readonly exited: Promise<string>;
  /** Signals the spawned child itself; a no-op once it has exited (never a reused PID). */
  readonly kill?: () => void;
}

export interface HostOps {
  run(binary: string, args: readonly string[], env: Record<string, string>): Promise<void>;
  /** Start a long-lived process in its own session; it survives controller exit. */
  launch(
    binary: string,
    args: readonly string[],
    env: Record<string, string>,
    stderrFile: string
  ): Promise<Launched>;
  connect(socketPath: string): Promise<Duplex>;
  /** A currently free TCP port on host loopback, for the provisioning forward. */
  freePort(): Promise<number>;
  startToken(pid: number): string | null;
  /** False for exited or zombie processes. */
  alive(pid: number): boolean;
  kill(pid: number, signal: NodeJS.Signals): void;
  rm(target: string): void;
  sleep(ms: number): Promise<void>;
}

export const systemOps: HostOps = {
  run(binary, args, env) {
    return new Promise((resolve, reject) => {
      execFile(
        binary,
        [...args],
        { env, timeout: RUN_TOOL_TIMEOUT_MS },
        (error, _stdout, stderr) => {
          if (!error) return resolve();
          const status = error.killed
            ? `killed after ${RUN_TOOL_TIMEOUT_MS / 60_000} min`
            : `exit ${error.code ?? 'unknown'}${error.signal ? ` (${error.signal})` : ''}`;
          reject(
            new Error(
              `${path.basename(binary)} failed, ${status}: ${String(stderr).slice(0, STDERR_TAIL_BYTES)}`
            )
          );
        }
      );
    });
  },
  launch(binary, args, env, stderrFile) {
    return new Promise((resolve, reject) => {
      const errFd = fs.openSync(stderrFile, 'w', 0o600);
      const child = spawn(binary, [...args], {
        env,
        detached: true,
        stdio: ['ignore', 'ignore', errFd],
      });
      fs.closeSync(errFd);
      child.once('error', reject);
      const exited = new Promise<string>((done) => {
        child.once('exit', () => {
          let tail = '';
          try {
            tail = fs.readFileSync(stderrFile, 'utf8').slice(-STDERR_TAIL_BYTES);
          } catch {
            // missing log is reported as empty
          }
          done(tail);
        });
      });
      child.once('spawn', () => {
        child.unref();
        resolve({
          pid: child.pid as number,
          exited,
          kill: () => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          },
        });
      });
    });
  },
  connect(socketPath) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    });
  },
  freePort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as net.AddressInfo;
        server.close(() => resolve(port));
      });
    });
  },
  startToken: processStartToken,
  alive(pid) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
    } catch {
      return false;
    }
  },
  kill(pid, signal) {
    process.kill(pid, signal);
  },
  rm(target) {
    fs.rmSync(target, { recursive: true, force: true });
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

interface VmRecord {
  readonly vmId: string;
  readonly runId: string;
  readonly accelerator: Accelerator;
  readonly scope: ExecScope;
  readonly profileDigest: string;
  readonly vmDir: string;
  readonly socket: string;
  readonly pid: number | null;
  readonly startToken: string | null;
  readonly limits: VmLimits;
  readonly createdAt: string;
  /** Absent in records written before phases existed: verification. */
  readonly phase?: NetworkPhase;
  readonly proxyTarget?: ProxyTarget | null;
}

export interface LocalQemuOptions {
  /** Controller-owned state; VM records and overlay disks live here. */
  readonly stateDir: string;
  /** Holds manifest.json and the baked image. */
  readonly profileDir: string;
  readonly accelerator?: AcceleratorRequest;
  /** Short directory for broker sockets (sun_path limit). */
  readonly runtimeDir?: string;
  /** A journal dedicated to VM lifecycle events. Not the run's intent journal:
   * intent replay rejects event types it does not know. */
  readonly journal?: Journal;
  readonly tools?: HostTools;
  readonly ops?: HostOps;
  readonly agentSource?: string;
  /** Re-hash the baked image before the first VM (default true). */
  readonly verifyImage?: boolean;
  readonly now?: () => Date;
}

function defaultRuntimeDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  return xdg && path.isAbsolute(xdg)
    ? path.join(xdg, 'ai-dossier-zt')
    : path.join(os.tmpdir(), `ai-dossier-zt-${os.userInfo().uid}`);
}

export class LocalQemuAdapter implements VmAdapter {
  private readonly options: LocalQemuOptions;
  private readonly ops: HostOps;
  private readonly clients = new Map<string, BrokerClient>();
  private readonly channels = new Map<string, ProvisionChannel>();
  private imageVerified: boolean;
  private readonly now: () => Date;
  private loadedTools: HostTools | null;
  private loadedManifest: VmProfileManifest | null = null;

  /** Host tools and the profile are loaded on first use, so teardown, listing and
   * the kill switch keep working when QEMU or a current profile is missing. */
  constructor(options: LocalQemuOptions) {
    this.options = {
      ...options,
      stateDir: path.resolve(options.stateDir),
      profileDir: path.resolve(options.profileDir),
    };
    this.ops = options.ops ?? systemOps;
    this.now = options.now ?? (() => new Date());
    this.loadedTools = options.tools ?? null;
    this.imageVerified = options.verifyImage === false;
  }

  get tools(): HostTools {
    this.loadedTools ??= preflightHost(this.options.accelerator ?? 'auto');
    return this.loadedTools;
  }

  get manifest(): VmProfileManifest {
    if (this.loadedManifest) return this.loadedManifest;
    const file = path.join(this.options.profileDir, 'manifest.json');
    const agent = this.options.agentSource ?? fs.readFileSync(AGENT_SOURCE_PATH, 'utf8');
    let raw: unknown;
    try {
      raw = JSON.parse(readPrivate(file).toString('utf8'));
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      throw new UnsupportedEnvironmentError(
        'profile_image_missing',
        missing
          ? `no baked profile at ${file}; run the bake (scripts/zt-vm.mjs bake) first`
          : `${file} is unreadable or not private (mode 0600, owned by this user): ${(error as Error).message}`
      );
    }
    this.loadedManifest = parseManifest(raw, profileDigest(agent));
    return this.loadedManifest;
  }

  get accelerator(): Accelerator {
    return this.tools.accelerator;
  }

  private get vmsDir(): string {
    return path.join(this.options.stateDir, 'vms');
  }

  private imagePath(): string {
    return path.join(this.options.profileDir, this.manifest.imageFile);
  }

  private verifyImage(): void {
    if (this.imageVerified) return;
    const image = this.imagePath(); // manifest refusals surface with their own reason
    let digest: string;
    try {
      digest = sha256File(image);
    } catch {
      throw new UnsupportedEnvironmentError(
        'profile_image_missing',
        'baked profile image is missing'
      );
    }
    if (digest !== this.manifest.imageSha256)
      throw new UnsupportedEnvironmentError(
        'profile_image_mismatch',
        'baked profile image does not match its manifest digest'
      );
    assertStandaloneQcow2(image);
    this.imageVerified = true;
  }

  killSwitchEngaged(): boolean {
    return fs.existsSync(path.join(this.options.stateDir, KILL_SWITCH_FILE));
  }

  private writeRecord(record: VmRecord): void {
    replacePrivate(path.join(record.vmDir, 'vm.json'), Buffer.from(JSON.stringify(record)));
  }

  /** The record decides which PID is signalled and which paths are removed, so
   * it must live where this adapter put it and name only its own paths. */
  private readRecord(vmId: string): VmRecord | null {
    if (!VM_ID.test(vmId)) return null;
    const vmDir = path.join(this.vmsDir, vmId);
    try {
      const record = JSON.parse(
        readPrivate(path.join(vmDir, 'vm.json')).toString('utf8')
      ) as VmRecord;
      const valid =
        record.vmId === vmId &&
        record.vmDir === vmDir &&
        typeof record.socket === 'string' &&
        path.basename(record.socket) === `${vmId}.sock` &&
        typeof record.runId === 'string' &&
        (record.pid === null || (Number.isSafeInteger(record.pid) && record.pid > 1)) &&
        (record.startToken === null || typeof record.startToken === 'string') &&
        Number.isSafeInteger(record.limits?.commandTimeoutMs) &&
        record.limits.commandTimeoutMs > 0;
      return valid ? record : null;
    } catch {
      return null;
    }
  }

  private journal(event: Record<string, unknown>): void {
    appendVmEvent(this.options.journal, this.now(), event);
  }

  private refuseIfKillSwitchEngaged(): void {
    if (this.killSwitchEngaged())
      throw new UnsupportedEnvironmentError(
        'kill_switch_engaged',
        `the incident kill switch is engaged (${path.join(this.options.stateDir, KILL_SWITCH_FILE)}); no new VMs are admitted until an operator removes it`
      );
  }

  async create(spec: VmSpec): Promise<VmHandle> {
    this.refuseIfKillSwitchEngaged();
    if (!ID.test(spec.runId)) throw new Error('Invalid run ID');
    if (!Number.isSafeInteger(spec.limits.diskGiB) || spec.limits.diskGiB < BAKED_DISK_GIB)
      throw new Error(`Disk limit must be at least the baked image size (${BAKED_DISK_GIB} GiB)`);
    const phase = spec.phase ?? 'verification';
    if (phase !== 'provisioning' && phase !== 'verification') throw new Error('Invalid phase');
    if ((phase === 'provisioning') !== (spec.proxyTarget !== undefined))
      throw new Error('A proxy target is required in, and only in, the provisioning phase');
    const proxyTarget = spec.proxyTarget ? assertProxyTarget(spec.proxyTarget) : null;
    assertNoSecrets(spec.runId);
    this.verifyImage();
    const vmId = `zt-${randomBytes(6).toString('hex')}`;
    const runtimeDir = privateDir(this.options.runtimeDir ?? defaultRuntimeDir());
    const socket = path.join(runtimeDir, `${vmId}.sock`);
    if (Buffer.byteLength(socket) > MAX_SOCKET_PATH_BYTES)
      throw new UnsupportedEnvironmentError(
        'socket_path_too_long',
        'broker socket path exceeds the UNIX socket limit; set a shorter runtime directory'
      );
    privateDir(this.vmsDir);
    const vmDir = privateDir(path.join(this.vmsDir, vmId));
    const record: VmRecord = {
      vmId,
      runId: spec.runId,
      accelerator: this.accelerator,
      scope: spec.scope,
      profileDigest: this.manifest.profileDigest,
      vmDir,
      socket,
      pid: null,
      startToken: null,
      limits: spec.limits,
      createdAt: this.now().toISOString(),
      phase,
      proxyTarget,
    };
    this.writeRecord(record);
    const handle: VmHandle = Object.freeze({
      vmId,
      runId: spec.runId,
      accelerator: this.accelerator,
      profileDigest: this.manifest.profileDigest,
      scope: spec.scope,
    });
    try {
      await this.ops.run(
        this.tools.qemuImg,
        buildOverlayArgs(this.imagePath(), path.join(vmDir, 'disk.qcow2'), spec.limits.diskGiB),
        { ...QEMU_ENV }
      );
      await this.boot(record, 'vm_created');
      return handle;
    } catch (error) {
      await this.destroy(handle).catch((cleanup: unknown) => {
        // The caller only sees the boot error; keep the leftovers on record.
        if (cleanup instanceof VmCleanupError)
          this.journal({
            type: 'vm_cleanup_attempt_failed',
            runId: spec.runId,
            vmId,
            attempt: 1,
            leftoverPids: cleanup.leftoverPids,
            leftoverPaths: cleanup.leftoverPaths,
          });
      });
      throw error;
    }
  }

  /** Launches QEMU on the record's overlay with its phase's network policy, waits for
   * the guest hello, and checks that the guest announces the scope and phase the
   * controller set. In provisioning, starts the connector for the one forward. */
  private async boot(initial: VmRecord, event: 'vm_created' | 'vm_phase_changed'): Promise<void> {
    let record = initial;
    const phase = record.phase ?? 'verification';
    const forwardPort = phase === 'provisioning' ? await this.ops.freePort() : undefined;
    const args = buildRunArgs({
      name: record.vmId,
      accelerator: record.accelerator,
      limits: record.limits,
      disk: path.join(record.vmDir, 'disk.qcow2'),
      pidFile: path.join(record.vmDir, 'qemu.pid'),
      brokerSocket: record.socket,
      scope: record.scope,
      phase,
      forwardHostPort: forwardPort,
    });
    let launched: Launched | null = null;
    try {
      launched = await this.ops.launch(
        this.tools.qemu,
        args,
        { ...QEMU_ENV },
        path.join(record.vmDir, 'qemu.err')
      );
      const pid = launched.pid;
      // Record the PID before anything else can fail: a PID without a start
      // token is never signalled and never treated as cleaned up.
      record = { ...record, pid, startToken: null };
      this.writeRecord(record);
      record = { ...record, startToken: this.ops.startToken(pid) };
      this.writeRecord(record);
      this.refuseIfKillSwitchEngaged();
      this.journal({
        type: event,
        runId: record.runId,
        vmId: record.vmId,
        provider: 'local-qemu',
        accelerator: record.accelerator,
        scope: record.scope,
        phase,
        hostForwards: forwardPort === undefined ? 0 : 1,
        profileDigest: this.manifest.profileDigest,
        imageSha256: this.manifest.imageSha256,
        pid,
        vcpus: record.limits.vcpus,
        memoryMiB: record.limits.memoryMiB,
        diskGiB: record.limits.diskGiB,
      });
      const exited = launched.exited.then((tail) => {
        throw new Error(`QEMU exited during boot: ${tail.trim().slice(-500)}`);
      });
      const client = new BrokerClient(await this.connectWhenListening(record.socket, exited));
      this.clients.set(record.vmId, client);
      const scope = await Promise.race([
        client.waitReady(BOOT_TIMEOUT_MS[record.accelerator]),
        exited,
      ]);
      if (scope !== record.scope) {
        client.taint('scope_mismatch');
        throw new BrokerError('scope_mismatch');
      }
      if (client.phase !== phase) {
        client.taint('phase_mismatch');
        throw new BrokerError('phase_mismatch');
      }
      // A kill-all that started during boot may have missed this VM.
      this.refuseIfKillSwitchEngaged();
      if (forwardPort !== undefined && record.proxyTarget) {
        const channel = new ProvisionChannel({ forwardPort, target: record.proxyTarget });
        this.channels.set(record.vmId, channel);
        channel.start();
      }
    } catch (error) {
      // The child handle is the one reference that survives a failed record write.
      launched?.kill?.();
      throw error;
    }
  }

  /** Provisioning → verification. The guest is asked to sync and power off (its
   * answer is not trusted), QEMU must exit or is killed, and QEMU is relaunched on the
   * same overlay with the forward-free verification argv. Nothing the guest does can
   * keep or add a forward: the new process's arguments are controller policy. */
  async endProvisioning(handle: VmHandle): Promise<void> {
    const record = this.readRecord(handle.vmId);
    if (!record) throw new BrokerError('unknown_vm');
    if ((record.phase ?? 'verification') !== 'provisioning')
      throw new BrokerError('not_provisioning');
    this.channels.get(handle.vmId)?.close();
    this.channels.delete(handle.vmId);
    const client = this.clients.get(handle.vmId);
    if (client && !client.tainted)
      await client.shutdown(this.scaled(BROKER_RPC_TIMEOUT_MS, handle)).catch(() => undefined);
    client?.close();
    this.clients.delete(handle.vmId);
    const leftover = await this.stopProcess(record, this.scaled(SHUTDOWN_WAIT_MS, handle));
    if (leftover !== null) throw new VmCleanupError([leftover], [record.vmDir]);
    this.ops.rm(record.socket);
    const next: VmRecord = {
      ...record,
      pid: null,
      startToken: null,
      phase: 'verification',
      proxyTarget: null,
    };
    this.writeRecord(next);
    await this.boot(next, 'vm_phase_changed');
  }

  /** Waits up to `graceMs` for an owned QEMU to exit by itself, then SIGTERM and
   * SIGKILL. Returns the PID when it is still alive (or unverifiable), else null. */
  private async stopProcess(record: VmRecord, graceMs = 0): Promise<number | null> {
    const ownership = this.ownership(record);
    if (ownership === 'unknown' && record.pid) return record.pid;
    if (ownership !== 'owned' || !record.pid) return null;
    for (let waited = 0; waited < graceMs && this.ops.alive(record.pid); waited += POLL_MS)
      await this.ops.sleep(POLL_MS);
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      if (!this.ops.alive(record.pid)) break;
      try {
        this.ops.kill(record.pid, signal);
      } catch {
        // ESRCH races are rechecked below; EPERM leaves it alive and reported.
      }
      for (let waited = 0; waited < KILL_GRACE_MS && this.ops.alive(record.pid); waited += POLL_MS)
        await this.ops.sleep(POLL_MS);
    }
    return this.ops.alive(record.pid) ? record.pid : null;
  }

  /** QEMU creates the listening socket shortly after start. */
  private async connectWhenListening(socket: string, exited: Promise<never>): Promise<Duplex> {
    let failure: unknown = null;
    exited.catch((error) => {
      failure = error;
    });
    for (let waited = 0; waited < SOCKET_WAIT_MS; waited += POLL_MS) {
      if (failure) throw failure;
      try {
        return await this.ops.connect(socket);
      } catch {
        await this.ops.sleep(POLL_MS);
      }
    }
    throw new BrokerError('socket_unavailable');
  }

  private client(handle: VmHandle): BrokerClient {
    const client = this.clients.get(handle.vmId);
    if (!client) throw new BrokerError('unknown_vm');
    if (client.tainted) throw client.tainted;
    return client;
  }

  private scaled(ms: number, handle: VmHandle): number {
    return ms * TIMEOUT_SCALE[handle.accelerator];
  }

  async exec(handle: VmHandle, request: ExecRequest): Promise<ExecResult> {
    const record = this.readRecord(handle.vmId);
    if (!record) throw new BrokerError('unknown_vm');
    const network = request.network ?? 'none';
    // Host-side check first; the guest refuses it too, but must not be relied on.
    if (network === 'package_proxy' && (record.phase ?? 'verification') !== 'provisioning')
      throw new BrokerError('network_not_allowed');
    const base = request.timeoutMs ?? record.limits.commandTimeoutMs;
    return this.client(handle).exec(
      {
        profile: request.profile,
        argv: request.argv,
        cwd: request.cwd,
        timeoutMs: this.scaled(base, handle),
        network,
        env: request.env,
        report: request.report,
      },
      this.scaled(BROKER_RPC_TIMEOUT_MS, handle)
    );
  }

  putFile(
    handle: VmHandle,
    relativePath: string,
    bytes: Buffer,
    executable = false
  ): Promise<void> {
    return this.client(handle).put(
      relativePath,
      bytes,
      executable,
      this.scaled(BROKER_RPC_TIMEOUT_MS, handle)
    );
  }

  getFile(handle: VmHandle, relativePath: string): Promise<Buffer> {
    return this.client(handle).get(relativePath, this.scaled(BROKER_RPC_TIMEOUT_MS, handle));
  }

  /** One attempt. Never signals a PID whose start token no longer matches. */
  async destroy(handle: Pick<VmHandle, 'vmId' | 'runId'>): Promise<void> {
    if (!VM_ID.test(handle.vmId)) throw new Error('Invalid VM ID');
    this.clients.get(handle.vmId)?.close();
    this.clients.delete(handle.vmId);
    const record = this.readRecord(handle.vmId);
    const vmDir = path.join(this.vmsDir, handle.vmId);
    this.channels.get(handle.vmId)?.close();
    this.channels.delete(handle.vmId);
    const leftoverPids: number[] = [];
    const leftover = record ? await this.stopProcess(record) : null;
    if (leftover !== null) leftoverPids.push(leftover);
    const leftoverPaths: string[] = [];
    if (!leftoverPids.length) this.keepDiagnostics(handle.vmId, vmDir);
    // Keep the record while the process may still be running, so a retry can find it.
    const targets = leftoverPids.length ? [record?.socket] : [record?.socket, vmDir];
    for (const target of targets) {
      if (!target) continue;
      try {
        this.ops.rm(target);
      } catch {
        // reported below
      }
      if (fs.existsSync(target)) leftoverPaths.push(target);
    }
    if (leftoverPids.length) leftoverPaths.push(vmDir);
    if (leftoverPids.length || leftoverPaths.length)
      throw new VmCleanupError(leftoverPids, leftoverPaths);
    this.journal({ type: 'vm_destroyed', runId: handle.runId, vmId: handle.vmId });
  }

  /** Run VMs have no console, so QEMU's own stderr is the only boot evidence.
   * It is host-side output (never guest bytes) and outlives the VM directory. */
  private keepDiagnostics(vmId: string, vmDir: string): void {
    try {
      const target = privateDir(path.join(this.options.stateDir, 'diagnostics'));
      fs.copyFileSync(path.join(vmDir, 'qemu.err'), path.join(target, `${vmId}.qemu.err`));
    } catch {
      // best effort: a missing log is not a cleanup failure
    }
  }

  /** `gone` also covers a recycled PID; `unknown` (unreadable /proc) is never
   * signalled and never treated as cleaned up. */
  private ownership(record: VmRecord): 'owned' | 'gone' | 'unknown' {
    if (!record.pid) return 'gone';
    try {
      const token = this.ops.startToken(record.pid);
      if (token === null) return 'gone';
      if (!record.startToken) return 'unknown';
      return token === record.startToken ? 'owned' : 'gone';
    } catch {
      return 'unknown';
    }
  }

  private records(): VmRecord[] {
    return this.vmDirNames()
      .map((name) => this.readRecord(name))
      .filter((r): r is VmRecord => r !== null);
  }

  private vmDirNames(): string[] {
    try {
      return fs.readdirSync(this.vmsDir).filter((name) => VM_ID.test(name));
    } catch {
      return [];
    }
  }

  async listByRun(runId: string): Promise<VmListing[]> {
    return this.records()
      .filter((record) => record.runId === runId)
      .map((record) => {
        const ownership = this.ownership(record);
        const alive =
          ownership === 'unknown' ||
          (ownership === 'owned' && record.pid !== null && this.ops.alive(record.pid));
        return {
          vmId: record.vmId,
          runId: record.runId,
          pid: record.pid,
          alive,
          paths: [record.vmDir, record.socket].filter((p) => fs.existsSync(p)),
        };
      });
  }

  /** Incident kill switch: stop admissions first, then kill and clean every VM. */
  async killAll(reason: string): Promise<{ destroyed: string[]; failed: VmCleanupError[] }> {
    assertNoSecrets(reason);
    privateDir(this.options.stateDir);
    replacePrivate(
      path.join(this.options.stateDir, KILL_SWITCH_FILE),
      Buffer.from(JSON.stringify({ reason, at: this.now().toISOString() }))
    );
    this.journal({ type: 'vm_kill_switch', reason });
    const destroyed: string[] = [];
    const failed: VmCleanupError[] = [];
    for (const vmId of this.vmDirNames()) {
      const vmDir = path.join(this.vmsDir, vmId);
      // A VM directory without a trustworthy record cannot be proven clean.
      const record = this.readRecord(vmId);
      if (!record) {
        failed.push(new VmCleanupError([], [vmDir]));
        continue;
      }
      try {
        await this.destroy(record);
        destroyed.push(vmId);
      } catch (error) {
        failed.push(error instanceof VmCleanupError ? error : new VmCleanupError([], [vmDir]));
      }
    }
    return { destroyed, failed };
  }
}
