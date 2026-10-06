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
import { ReasonCode, type RunRecord, transitionRun } from '../state';
import {
  type Accelerator,
  type AcceleratorRequest,
  appendVmEvent,
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
import {
  assertStandaloneQcow2,
  BAKED_DISK_GIB,
  parseManifest,
  profileDigest,
  sha256File,
  type VmProfileManifest,
} from './profile';
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
  startToken(pid: number): string | null;
  /** argv of a process, or null when it does not exist; throws when it cannot be read. */
  cmdline(pid: number): string[] | null;
  /** PIDs of every visible process. */
  listProcesses(): number[];
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
  startToken: processStartToken,
  cmdline(pid) {
    let raw: string;
    try {
      raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return raw.split('\0').filter((arg, i, all) => arg !== '' || i < all.length - 1);
  },
  listProcesses() {
    return fs
      .readdirSync('/proc')
      .filter((name) => /^[0-9]+$/.test(name))
      .map(Number);
  },
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
    // Integrity only holds while nobody else can replace the image.
    const stat = fs.lstatSync(image);
    if (!stat.isFile() || stat.uid !== os.userInfo().uid || (stat.mode & 0o022) !== 0)
      throw new UnsupportedEnvironmentError(
        'profile_image_mismatch',
        `baked profile image ${image} must be a regular file owned by this user and not writable by group or others`
      );
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
    let launched: Launched | null = null;
    try {
      await this.ops.run(
        this.tools.qemuImg,
        buildOverlayArgs(this.imagePath(), disk, spec.limits.diskGiB),
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
      launched = await this.ops.launch(
        this.tools.qemu,
        args,
        { ...QEMU_ENV },
        path.join(vmDir, 'qemu.err')
      );
      const pid = launched.pid;
      // Record the PID before anything else can fail: a PID without a start
      // token is never signalled and never treated as cleaned up.
      record = { ...record, pid };
      this.writeRecord(record);
      record = { ...record, startToken: this.ops.startToken(pid) };
      this.writeRecord(record);
      this.refuseIfKillSwitchEngaged();
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
      const exited = (launched as Launched).exited.then((tail) => {
        throw new Error(`QEMU exited during boot: ${tail.trim().slice(-500)}`);
      });
      const client = new BrokerClient(await this.connectWhenListening(socket, exited), (code) =>
        this.journal({ type: 'vm_broker_tainted', runId: spec.runId, vmId, code })
      );
      this.clients.set(vmId, client);
      const scope = await Promise.race([
        client.waitReady(BOOT_TIMEOUT_MS[this.accelerator]),
        exited,
      ]);
      if (scope !== spec.scope) {
        client.taint('scope_mismatch');
        throw new BrokerError('scope_mismatch');
      }
      // A kill-all that started during boot may have missed this VM.
      this.refuseIfKillSwitchEngaged();
      return handle;
    } catch (error) {
      // The child handle is the one reference that survives a failed record write.
      launched?.kill?.();
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
    const base = request.timeoutMs ?? record.limits.commandTimeoutMs;
    return this.client(handle).exec(
      {
        profile: request.profile,
        argv: request.argv,
        cwd: request.cwd,
        timeoutMs: this.scaled(base, handle),
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

  /** One attempt. Never signals a PID whose start token (or, without a recorded
   * PID, whose own command line) does not prove it is this VM's QEMU. */
  async destroy(handle: Pick<VmHandle, 'vmId' | 'runId'>): Promise<void> {
    if (!VM_ID.test(handle.vmId)) throw new Error('Invalid VM ID');
    this.clients.get(handle.vmId)?.close();
    this.clients.delete(handle.vmId);
    const record = this.readRecord(handle.vmId);
    const vmDir = path.join(this.vmsDir, handle.vmId);
    const leftoverPids: number[] = [];
    const { pid, ownership } = this.resolveProcess(handle.vmId, record);
    if (ownership === 'unknown' && pid) leftoverPids.push(pid);
    if (ownership === 'owned' && pid && (await this.stop(pid))) leftoverPids.push(pid);
    const leftoverPaths: string[] = [];
    if (!leftoverPids.length) this.keepDiagnostics(handle.vmId, vmDir);
    const socket = record?.socket ?? this.socketPath(handle.vmId);
    // Keep the record while the process may still be running, so a retry can find it.
    const targets = leftoverPids.length ? [socket] : [socket, vmDir];
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
      throw new VmCleanupError(leftoverPids, leftoverPaths, handle.vmId);
    this.journal({ type: 'vm_destroyed', runId: handle.runId, vmId: handle.vmId });
  }

  /** SIGTERM, then SIGKILL; true when the process is still alive afterwards. */
  private async stop(pid: number): Promise<boolean> {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      if (!this.ops.alive(pid)) break;
      try {
        this.ops.kill(pid, signal);
      } catch {
        // ESRCH races are rechecked below; EPERM leaves it alive and reported.
      }
      for (let waited = 0; waited < KILL_GRACE_MS && this.ops.alive(pid); waited += POLL_MS)
        await this.ops.sleep(POLL_MS);
    }
    return this.ops.alive(pid);
  }

  private socketPath(vmId: string): string {
    const runtime = this.options.runtimeDir ?? defaultRuntimeDir();
    return path.join(runtime, `${vmId}.sock`);
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

  /** The pidfile QEMU itself writes; its argv names it, which ties a process to
   * exactly one VM directory of this state dir. */
  private pidFilePath(vmId: string): string {
    return path.join(this.vmsDir, vmId, 'qemu.pid');
  }

  /** Whether a live process is this VM's QEMU, judged by its own argv. */
  private processIsVm(pid: number, vmId: string): 'owned' | 'gone' | 'unknown' {
    try {
      const argv = this.ops.cmdline(pid);
      if (argv === null) return 'gone';
      return argv.includes(this.pidFilePath(vmId)) ? 'owned' : 'gone';
    } catch {
      return 'unknown';
    }
  }

  /** The VM's QEMU process. A record with a PID decides by start token; without
   * one (the controller crashed between launch and the record write, or the
   * record is unusable) QEMU's own pidfile and argv decide. */
  private resolveProcess(
    vmId: string,
    record: VmRecord | null
  ): { pid: number | null; ownership: 'owned' | 'gone' | 'unknown' } {
    if (record?.pid) return { pid: record.pid, ownership: this.ownership(record) };
    let pid: number;
    try {
      pid = Number(fs.readFileSync(this.pidFilePath(vmId), 'utf8').trim());
    } catch {
      return { pid: null, ownership: 'gone' };
    }
    if (!Number.isSafeInteger(pid) || pid <= 1) return { pid: null, ownership: 'gone' };
    return { pid, ownership: this.processIsVm(pid, vmId) };
  }

  /** QEMU processes whose argv names a pidfile in this state dir, by VM ID. */
  private vmProcesses(): Map<number, string> {
    const found = new Map<number, string>();
    const prefix = `${this.vmsDir}${path.sep}`;
    for (const pid of this.ops.listProcesses()) {
      let argv: string[] | null;
      try {
        argv = this.ops.cmdline(pid);
      } catch {
        continue;
      }
      const pidFile = argv?.find(
        (arg) => arg.startsWith(prefix) && arg.endsWith(`${path.sep}qemu.pid`)
      );
      const vmId = pidFile?.slice(prefix.length, -`${path.sep}qemu.pid`.length);
      if (vmId && VM_ID.test(vmId)) found.set(pid, vmId);
    }
    return found;
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
        const { pid, ownership } = this.resolveProcess(record.vmId, record);
        const alive =
          ownership === 'unknown' || (ownership === 'owned' && pid !== null && this.ops.alive(pid));
        return {
          vmId: record.vmId,
          runId: record.runId,
          pid,
          alive,
          paths: [record.vmDir, record.socket].filter((p) => fs.existsSync(p)),
        };
      });
  }

  /** Incident kill switch: stop admissions first, then attempt every VM, whatever
   * fails on the way. A run whose VM is not confirmed dead moves to
   * `blocked_cleanup` through `observeRun` when the caller can look it up. */
  async killAll(
    reason: string,
    options: KillAllOptions = {}
  ): Promise<{ destroyed: string[]; failed: VmCleanupError[]; blockedRuns: string[] }> {
    assertNoSecrets(reason);
    privateDir(this.options.stateDir);
    replacePrivate(
      path.join(this.options.stateDir, KILL_SWITCH_FILE),
      Buffer.from(JSON.stringify({ reason, at: this.now().toISOString() }))
    );
    this.journal({ type: 'vm_kill_switch', reason });
    const destroyed: string[] = [];
    const failed: VmCleanupError[] = [];
    const blockedRuns: string[] = [];
    for (const vmId of this.vmDirNames()) {
      const vmDir = path.join(this.vmsDir, vmId);
      // A VM directory without a trustworthy record cannot be proven clean, so it
      // stays for reconcile; its QEMU is still stopped when its own argv proves it.
      const record = this.readRecord(vmId);
      if (!record) {
        const { pid, ownership } = this.resolveProcess(vmId, null);
        const alive =
          pid !== null &&
          ownership !== 'gone' &&
          (ownership === 'unknown' || (await this.stop(pid)));
        failed.push(new VmCleanupError(alive && pid !== null ? [pid] : [], [vmDir], vmId));
        continue;
      }
      try {
        await this.destroy(record);
        destroyed.push(vmId);
      } catch (error) {
        failed.push(
          error instanceof VmCleanupError ? error : new VmCleanupError([], [vmDir], vmId)
        );
        if (this.blockRun(record.runId, options)) blockedRuns.push(record.runId);
      }
    }
    // QEMU processes of this state dir whose directory is already gone.
    for (const [pid, vmId] of this.vmProcesses()) {
      if (fs.existsSync(path.join(this.vmsDir, vmId))) continue;
      if (await this.stop(pid)) failed.push(new VmCleanupError([pid], [], vmId));
      else destroyed.push(vmId);
    }
    return { destroyed, failed, blockedRuns };
  }

  private blockRun(runId: string, options: KillAllOptions): boolean {
    const run = options.lookupRun?.(runId);
    if (!run || run.state === 'blocked_cleanup') return false;
    try {
      const blocked = transitionRun(run, ReasonCode.CleanupFailed, this.now().toISOString());
      options.observeRun?.(blocked);
      return true;
    } catch (error) {
      this.journal({ type: 'vm_run_block_failed', runId, cause: (error as Error).name });
      return false;
    }
  }

  /** Lifts the kill switch. Refused while any VM directory or QEMU process of
   * this state dir remains: kill-all or reconcile --destroy must finish first. */
  releaseKillSwitch(reason: string): boolean {
    assertNoSecrets(reason);
    const file = path.join(this.options.stateDir, KILL_SWITCH_FILE);
    if (!fs.existsSync(file)) return false;
    const remaining = [...new Set([...this.vmDirNames(), ...this.vmProcesses().values()])];
    if (remaining.length)
      throw new Error(
        `The kill switch stays engaged: ${remaining.length} VM(s) remain (${remaining.join(', ')}); run kill-all or reconcile --destroy first`
      );
    let engaged: { reason?: unknown; at?: unknown } = {};
    try {
      engaged = JSON.parse(readPrivate(file).toString('utf8'));
    } catch {
      // an unreadable marker is still released, and the release is still journaled
    }
    this.journal({
      type: 'vm_kill_switch_released',
      reason,
      engagedReason: typeof engaged.reason === 'string' ? engaged.reason : null,
      engagedAt: typeof engaged.at === 'string' ? engaged.at : null,
    });
    fs.rmSync(file);
    return true;
  }

  /** Finds VMs that outlived their bookkeeping: directories whose QEMU is gone,
   * directories without a trustworthy record, and QEMU processes of this state
   * dir with no directory. With `destroy`, cleans each one up. */
  async reconcile(options: { destroy?: boolean } = {}): Promise<ReconcileReport> {
    const processes = this.vmProcesses();
    const report: ReconcileReport = {
      live: [],
      staleDirs: [],
      untrustedDirs: [],
      orphanProcesses: [],
      destroyed: [],
      failed: [],
    };
    for (const vmId of this.vmDirNames()) {
      const record = this.readRecord(vmId);
      const { pid, ownership } = this.resolveProcess(vmId, record);
      const running = ownership !== 'gone' && pid !== null && this.ops.alive(pid);
      if (!record) report.untrustedDirs.push(vmId);
      else if (running && ownership === 'owned') report.live.push(vmId);
      else report.staleDirs.push(vmId);
    }
    for (const [pid, vmId] of processes)
      if (!fs.existsSync(path.join(this.vmsDir, vmId))) report.orphanProcesses.push({ pid, vmId });
    if (options.destroy) {
      for (const vmId of [...report.staleDirs, ...report.untrustedDirs]) {
        try {
          await this.destroy({ vmId, runId: this.readRecord(vmId)?.runId ?? 'reconcile' });
          report.destroyed.push(vmId);
        } catch (error) {
          report.failed.push(
            error instanceof VmCleanupError
              ? error
              : new VmCleanupError([], [path.join(this.vmsDir, vmId)], vmId)
          );
        }
      }
      for (const { pid, vmId } of report.orphanProcesses) {
        if (await this.stop(pid)) report.failed.push(new VmCleanupError([pid], [], vmId));
        else report.destroyed.push(vmId);
      }
    }
    this.journal({
      type: 'vm_reconcile',
      destroy: options.destroy === true,
      staleDirs: report.staleDirs,
      untrustedDirs: report.untrustedDirs,
      orphanProcesses: report.orphanProcesses.map((o) => o.vmId),
    });
    return report;
  }
}

export interface KillAllOptions {
  /** The run a VM belongs to, from the controller's run store. */
  readonly lookupRun?: (runId: string) => RunRecord | null | undefined;
  /** Persists a run moved to `blocked_cleanup`, e.g. `IntentDriver.observeRun`. */
  readonly observeRun?: (run: RunRecord) => void;
}

export interface ReconcileReport {
  /** VMs with a trustworthy record and a running QEMU. */
  live: string[];
  /** Directories whose QEMU is gone (or never recorded and not running). */
  staleDirs: string[];
  /** Directories without a trustworthy record. */
  untrustedDirs: string[];
  /** QEMU processes of this state dir whose directory is gone. */
  orphanProcesses: { pid: number; vmId: string }[];
  destroyed: string[];
  failed: VmCleanupError[];
}
