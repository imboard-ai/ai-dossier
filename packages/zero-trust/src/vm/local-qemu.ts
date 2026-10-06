/** Local, rootless QEMU implementation of the VM adapter. Linux hosts only. */
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { replacePrivate } from '../durable-fs';
import type { Journal } from '../journal';
import { processStartToken } from '../lock';
import { assertNoSecrets } from '../redaction';
import {
  type Accelerator,
  type AcceleratorRequest,
  BrokerError,
  type ExecRequest,
  type ExecResult,
  type ExecScope,
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
import { type ProfileManifest, parseManifest, profileDigest, sha256File } from './profile';
import { BOOT_TIMEOUT_MS, buildRunArgs, MAX_SOCKET_PATH_BYTES, TIMEOUT_SCALE } from './qemu-args';

export const AGENT_SOURCE_PATH = path.join(__dirname, '..', '..', 'vm-guest', 'agent.py');
export const KILL_SWITCH_FILE = 'KILL_SWITCH';
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const VM_ID = /^zt-[a-f0-9]{12}$/;
/** QEMU never needs the controller's environment; secrets in it must not reach it. */
const QEMU_ENV = Object.freeze({ PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C' });

/** Everything that touches processes or sockets; replaced in unit tests. */
export interface Launched {
  readonly pid: number;
  /** Settles with QEMU's own stderr tail when the process exits. */
  readonly exited: Promise<string>;
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
      execFile(binary, [...args], { env, timeout: 30 * 60_000 }, (error, _stdout, stderr) => {
        if (error)
          reject(new Error(`${path.basename(binary)} failed: ${String(stderr).slice(0, 2000)}`));
        else resolve();
      });
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
            tail = fs.readFileSync(stderrFile, 'utf8').slice(-2000);
          } catch {
            // missing log is reported as empty
          }
          done(tail);
        });
      });
      child.once('spawn', () => {
        child.unref();
        resolve({ pid: child.pid as number, exited });
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
}

export interface LocalQemuOptions {
  /** Controller-owned state; VM records and overlay disks live here. */
  readonly stateDir: string;
  /** Holds manifest.json and the baked image. */
  readonly profileDir: string;
  readonly accelerator?: AcceleratorRequest;
  /** Short directory for broker sockets (sun_path limit). */
  readonly runtimeDir?: string;
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

/** A 0700 directory we own, never reached through a symlink. */
function privateDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== os.userInfo().uid)
    throw new Error('Controller directory is not private');
  fs.chmodSync(dir, 0o700);
  return dir;
}

export class LocalQemuAdapter implements VmAdapter {
  readonly tools: HostTools;
  readonly manifest: ProfileManifest;
  private readonly ops: HostOps;
  private readonly clients = new Map<string, BrokerClient>();
  private imageVerified: boolean;
  private readonly now: () => Date;

  constructor(private readonly options: LocalQemuOptions) {
    this.tools = options.tools ?? preflightHost(options.accelerator ?? 'auto');
    this.ops = options.ops ?? systemOps;
    this.now = options.now ?? (() => new Date());
    const agent = options.agentSource ?? fs.readFileSync(AGENT_SOURCE_PATH, 'utf8');
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(options.profileDir, 'manifest.json'), 'utf8'));
    } catch {
      throw new UnsupportedEnvironmentError(
        'profile_image_missing',
        'no baked profile image found; run the bake (scripts/zt-vm.mjs bake) first'
      );
    }
    this.manifest = parseManifest(raw, profileDigest(agent));
    this.imageVerified = options.verifyImage === false;
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
    let digest: string;
    try {
      digest = sha256File(this.imagePath());
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
    this.imageVerified = true;
  }

  killSwitchEngaged(): boolean {
    return fs.existsSync(path.join(this.options.stateDir, KILL_SWITCH_FILE));
  }

  private writeRecord(record: VmRecord): void {
    replacePrivate(path.join(record.vmDir, 'vm.json'), Buffer.from(JSON.stringify(record)));
  }

  private readRecord(vmId: string): VmRecord | null {
    if (!VM_ID.test(vmId)) return null;
    try {
      const record = JSON.parse(
        fs.readFileSync(path.join(this.vmsDir, vmId, 'vm.json'), 'utf8')
      ) as VmRecord;
      return record.vmId === vmId ? record : null;
    } catch {
      return null;
    }
  }

  private journal(event: Record<string, unknown>): void {
    if (!this.options.journal) return;
    for (const value of Object.values(event)) if (typeof value === 'string') assertNoSecrets(value);
    this.options.journal.append({ v: 1, at: this.now().toISOString(), ...event });
  }

  async create(spec: VmSpec): Promise<VmHandle> {
    if (this.killSwitchEngaged())
      throw new UnsupportedEnvironmentError(
        'kill_switch_engaged',
        'the incident kill switch is engaged; no new VMs are admitted'
      );
    if (!ID.test(spec.runId)) throw new Error('Invalid run ID');
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
    const disk = path.join(vmDir, 'disk.qcow2');
    const pidFile = path.join(vmDir, 'qemu.pid');
    let record: VmRecord = {
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
        [
          'create',
          '-q',
          '-f',
          'qcow2',
          '-F',
          'qcow2',
          '-b',
          this.imagePath(),
          disk,
          `${spec.limits.diskGiB}G`,
        ],
        { ...QEMU_ENV }
      );
      const args = buildRunArgs({
        name: vmId,
        accelerator: this.accelerator,
        limits: spec.limits,
        disk,
        pidFile,
        brokerSocket: socket,
        scope: spec.scope,
      });
      const launched = await this.ops.launch(
        this.tools.qemu,
        args,
        { ...QEMU_ENV },
        path.join(vmDir, 'qemu.err')
      );
      const pid = launched.pid;
      record = { ...record, pid, startToken: this.ops.startToken(pid) };
      this.writeRecord(record);
      this.journal({
        type: 'vm_created',
        runId: spec.runId,
        vmId,
        provider: 'local-qemu',
        accelerator: this.accelerator,
        scope: spec.scope,
        profileDigest: this.manifest.profileDigest,
        imageSha256: this.manifest.imageSha256,
        pid,
        vcpus: spec.limits.vcpus,
        memoryMiB: spec.limits.memoryMiB,
        diskGiB: spec.limits.diskGiB,
      });
      const exited = launched.exited.then((tail) => {
        throw new Error(`QEMU exited during boot: ${tail.trim().slice(-500)}`);
      });
      const client = new BrokerClient(await this.connectWhenListening(socket, exited));
      this.clients.set(vmId, client);
      const scope = await Promise.race([
        client.waitReady(BOOT_TIMEOUT_MS[this.accelerator]),
        exited,
      ]);
      if (scope !== spec.scope) {
        client.taint('scope_mismatch');
        throw new BrokerError('scope_mismatch');
      }
      return handle;
    } catch (error) {
      await this.destroy(handle).catch(() => undefined);
      throw error;
    }
  }

  /** QEMU creates the listening socket shortly after start. */
  private async connectWhenListening(socket: string, exited: Promise<never>): Promise<Duplex> {
    let failure: unknown = null;
    exited.catch((error) => {
      failure = error;
    });
    for (let waited = 0; waited < 30_000; waited += 100) {
      if (failure) throw failure;
      try {
        return await this.ops.connect(socket);
      } catch {
        await this.ops.sleep(100);
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
    const base = request.timeoutMs ?? record?.limits.commandTimeoutMs;
    if (!base) throw new BrokerError('unknown_vm');
    return this.client(handle).exec(
      {
        profile: request.profile,
        argv: request.argv,
        cwd: request.cwd,
        timeoutMs: this.scaled(base, handle),
      },
      this.scaled(60_000, handle)
    );
  }

  putFile(
    handle: VmHandle,
    relativePath: string,
    bytes: Buffer,
    executable = false
  ): Promise<void> {
    return this.client(handle).put(relativePath, bytes, executable, this.scaled(60_000, handle));
  }

  getFile(handle: VmHandle, relativePath: string): Promise<Buffer> {
    return this.client(handle).get(relativePath, this.scaled(60_000, handle));
  }

  /** One attempt. Never signals a PID whose start token no longer matches. */
  async destroy(handle: Pick<VmHandle, 'vmId' | 'runId'>): Promise<void> {
    this.clients.get(handle.vmId)?.close();
    this.clients.delete(handle.vmId);
    const record = this.readRecord(handle.vmId);
    const vmDir = path.join(this.vmsDir, handle.vmId);
    const leftoverPids: number[] = [];
    const ownership = record ? this.ownership(record) : 'gone';
    if (ownership === 'unknown' && record?.pid) leftoverPids.push(record.pid);
    if (ownership === 'owned' && record?.pid) {
      for (const [signal, waitMs] of [
        ['SIGTERM', 5000],
        ['SIGKILL', 5000],
      ] as const) {
        if (!this.ops.alive(record.pid)) break;
        try {
          this.ops.kill(record.pid, signal);
        } catch {
          // ESRCH races are rechecked below; EPERM leaves it alive and reported.
        }
        for (let waited = 0; waited < waitMs && this.ops.alive(record.pid); waited += 100)
          await this.ops.sleep(100);
      }
      if (this.ops.alive(record.pid)) leftoverPids.push(record.pid);
    }
    const leftoverPaths: string[] = [];
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
    let names: string[];
    try {
      names = fs.readdirSync(this.vmsDir);
    } catch {
      return [];
    }
    return names.map((name) => this.readRecord(name)).filter((r): r is VmRecord => r !== null);
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
    for (const record of this.records()) {
      try {
        await this.destroy(record);
        destroyed.push(record.vmId);
      } catch (error) {
        if (error instanceof VmCleanupError) failed.push(error);
        else throw error;
      }
    }
    return { destroyed, failed };
  }
}
