/** Host side of the narrow worker broker (virtio-serial, JSON lines). The guest
 * is untrusted: every frame is size-capped and schema-checked, and any protocol
 * violation taints the VM permanently — the caller must destroy it. */
import type { Duplex } from 'node:stream';
import { assertNoSecrets } from '../redaction';
import { isRecord } from '../state';
import {
  BrokerError,
  type ContainerProfile,
  type ExecNetwork,
  type ExecResult,
  type ExecScope,
  MAX_REPORT_BYTES,
  type NetworkPhase,
} from './adapter';

export const BROKER_PROTOCOL = 'zt-broker-v1';
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_STREAM_BYTES = 1024 * 1024;
/** Two capped streams and a capped report in base64, plus envelope. */
export const MAX_FRAME_BYTES = 4 * MAX_STREAM_BYTES;
const MAX_ARGV = 256;
const MAX_ARG_BYTES = 8192;
const MAX_ARGV_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 512;
const PROFILES: readonly ContainerProfile[] = ['node', 'python'];
/** Worker environment limits; `vm-guest/agent.py` enforces the same. */
export const MAX_ENV_VARS = 32;
export const MAX_ENV_NAME_BYTES = 64;
export const MAX_ENV_VALUE_BYTES = 4096;
const ENV_NAME = new RegExp(`^[A-Za-z_][A-Za-z0-9_]{0,${MAX_ENV_NAME_BYTES - 1}}$`);
const NETWORKS: readonly ExecNetwork[] = ['none', 'package_proxy'];
const PHASES: readonly NetworkPhase[] = ['provisioning', 'verification'];
const isNetworkPhase = (value: unknown): value is NetworkPhase =>
  PHASES.includes(value as NetworkPhase);
const isExecNetwork = (value: unknown): value is ExecNetwork =>
  NETWORKS.includes(value as ExecNetwork);
const MIN_EXEC_TIMEOUT_MS = 1000;
const MAX_EXEC_TIMEOUT_MS = 6 * 3600 * 1000;

export type BrokerRequest =
  | {
      op: 'exec';
      profile: ContainerProfile;
      argv: string[];
      cwd: string;
      timeoutMs: number;
      network: ExecNetwork;
      env: Record<string, string>;
      report: boolean;
    }
  | { op: 'put'; path: string; data: string; executable: boolean }
  | { op: 'get'; path: string }
  /** Sync and power off; the controller then restarts the VM in the next phase. */
  | { op: 'shutdown' };

/** Worker environment from controller policy: bounded, plain names, no dynamic
 * loader variables, and no secret-shaped values. */
export function validateExecEnv(env: unknown): Record<string, string> {
  if (env === undefined) return {};
  if (env === null || typeof env !== 'object' || Array.isArray(env))
    throw new BrokerError('invalid_env');
  const entries = Object.entries(env as Record<string, unknown>);
  if (entries.length > MAX_ENV_VARS) throw new BrokerError('invalid_env');
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (
      !ENV_NAME.test(name) ||
      name.startsWith('LD_') ||
      typeof value !== 'string' ||
      /[\0\n\r]/.test(value) ||
      Buffer.byteLength(value) > MAX_ENV_VALUE_BYTES
    )
      throw new BrokerError('invalid_env');
    assertNoSecrets(value);
    out[name] = value;
  }
  return out;
}

/** Workspace-relative POSIX path; no traversal, absolute, empty or dot segments. */
export function assertWorkspacePath(value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string') throw new BrokerError('invalid_path');
  if (value === '' && allowEmpty) return value;
  const segments = value.split('/');
  if (
    !value ||
    Buffer.byteLength(value) > MAX_PATH_BYTES ||
    /[\0\\]/.test(value) ||
    segments.length > 32 ||
    segments.some((s) => s === '' || s === '.' || s === '..')
  )
    throw new BrokerError('invalid_path');
  return value;
}

/** Container profile and argv of an exec, from untrusted input (a broker request
 * or a model proposal). Secret-shaped arguments are refused. */
export function validateExecArgv(
  profile: unknown,
  argv: unknown
): { profile: ContainerProfile; argv: string[] } {
  if (!PROFILES.includes(profile as ContainerProfile)) throw new BrokerError('invalid_profile');
  if (
    !Array.isArray(argv) ||
    argv.length < 1 ||
    argv.length > MAX_ARGV ||
    argv.some(
      (a) => typeof a !== 'string' || /\0/.test(a) || Buffer.byteLength(a) > MAX_ARG_BYTES
    ) ||
    argv.reduce((n, a) => n + Buffer.byteLength(a), 0) > MAX_ARGV_BYTES
  )
    throw new BrokerError('invalid_argv');
  for (const arg of argv) assertNoSecrets(arg);
  return { profile: profile as ContainerProfile, argv: [...argv] };
}

/** Controller-side allowlist. Nothing reaches the guest that fails here. */
export function validateRequest(request: BrokerRequest): BrokerRequest {
  switch (request?.op) {
    case 'exec': {
      const { profile, argv } = validateExecArgv(request.profile, request.argv);
      const { timeoutMs } = request;
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < MIN_EXEC_TIMEOUT_MS ||
        timeoutMs > MAX_EXEC_TIMEOUT_MS
      )
        throw new BrokerError('invalid_timeout');
      // No network unless one is named: the restrictive value is the default.
      const network = request.network ?? 'none';
      if (!isExecNetwork(network)) throw new BrokerError('invalid_network');
      return {
        op: 'exec',
        profile,
        argv,
        cwd: assertWorkspacePath(request.cwd, true),
        timeoutMs,
        network,
        env: validateExecEnv(request.env),
        report: request.report === true,
      };
    }
    case 'put': {
      decodeBase64Strict(request.data, MAX_FILE_BYTES, 'invalid_data');
      return {
        op: 'put',
        path: assertWorkspacePath(request.path),
        data: request.data,
        executable: request.executable === true,
      };
    }
    case 'get':
      return { op: 'get', path: assertWorkspacePath(request.path) };
    case 'shutdown':
      return { op: 'shutdown' };
    default:
      throw new BrokerError('invalid_op');
  }
}

/** Canonical base64 only (a round trip must reproduce it), capped at `max` bytes. */
function decodeBase64Strict(value: unknown, max: number, code: string): Buffer {
  if (typeof value !== 'string') throw new BrokerError(code);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || bytes.length > max) throw new BrokerError(code);
  return bytes;
}

interface Pending {
  id: number;
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class BrokerClient {
  private buffer = Buffer.alloc(0);
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Incremented inside the queued send closure.
  private nextId = 1;
  private pending: Pending | null = null;
  private helloWaiter: { resolve(): void; reject(e: Error): void } | null = null;
  private ready = false;
  private queue: Promise<unknown> = Promise.resolve();
  private failure: BrokerError | null = null;
  private announcedScope: ExecScope | null = null;
  private announcedPhase: NetworkPhase | null = null;

  /** `onTaint` hears the code once, when the VM is tainted (e.g. to journal it). */
  constructor(
    private readonly stream: Duplex,
    private readonly onTaint?: (code: string) => void
  ) {
    stream.on('data', (chunk: Buffer) => this.onData(chunk));
    stream.on('error', () => this.taint('stream_error'));
    stream.on('close', () => this.taint('stream_closed'));
  }

  /** The scope the guest announced in its hello; null before it. */
  get scope(): ExecScope | null {
    return this.announcedScope;
  }

  /** The network phase the guest announced in its hello; null before it. */
  get phase(): NetworkPhase | null {
    return this.announcedPhase;
  }

  get tainted(): BrokerError | null {
    return this.failure;
  }

  taint(code: string): void {
    if (this.failure) return;
    this.failure = new BrokerError(code);
    try {
      this.onTaint?.(code);
    } catch {
      // reporting a taint must never keep the VM usable
    }
    this.helloWaiter?.reject(this.failure);
    this.helloWaiter = null;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(this.failure);
      this.pending = null;
    }
    this.stream.destroy();
  }

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Bound as the stream data listener in the constructor.
  private onData(chunk: Buffer): void {
    if (this.failure) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf(10);
      if (end < 0) break;
      const line = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      this.onFrame(line);
      if (this.failure) return;
    }
    if (this.buffer.length > MAX_FRAME_BYTES) this.taint('frame_too_large');
  }

  private onFrame(line: Buffer): void {
    if (line.length > MAX_FRAME_BYTES) {
      this.taint('frame_too_large');
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(line.toString('utf8'));
    } catch {
      this.taint('malformed_frame');
      return;
    }
    if (!isRecord(frame) || frame.v !== 1) {
      this.taint('malformed_frame');
      return;
    }
    if (!this.ready) {
      if (
        frame.id !== 0 ||
        frame.hello !== BROKER_PROTOCOL ||
        (frame.scope !== 'container' && frame.scope !== 'vm-root') ||
        !isNetworkPhase(frame.phase) ||
        !this.helloWaiter
      ) {
        this.taint('unexpected_hello');
        return;
      }
      this.ready = true;
      this.announcedScope = frame.scope;
      this.announcedPhase = frame.phase;
      this.helloWaiter.resolve();
      this.helloWaiter = null;
      return;
    }
    const pending = this.pending;
    if (!pending) {
      this.taint('unsolicited_frame');
      return;
    }
    if (frame.id !== pending.id) {
      this.taint('id_mismatch');
      return;
    }
    clearTimeout(pending.timer);
    this.pending = null;
    pending.resolve(frame);
  }

  /** Sends the protocol hello and resolves with the guest's announced scope.
   * Data written before the guest opens its port stays queued in the socket. In the
   * provisioning phase the hello also hands the guest its per-boot relay key. */
  waitReady(timeoutMs: number, relayKey?: Buffer): Promise<ExecScope> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.ready) return Promise.resolve(this.announcedScope as ExecScope);
    if (this.helloWaiter) return Promise.reject(new BrokerError('hello_pending'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.taint('boot_timeout'), timeoutMs);
      this.helloWaiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve(this.announcedScope as ExecScope);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const hello = relayKey ? { relayKey: relayKey.toString('hex') } : {};
      this.stream.write(`${JSON.stringify({ v: 1, id: 0, op: 'hello', ...hello })}\n`);
    });
  }

  private send(request: BrokerRequest, timeoutMs: number): Promise<Record<string, unknown>> {
    const run = async () => {
      if (this.failure) throw this.failure;
      if (!this.ready) throw new BrokerError('not_ready');
      const valid = validateRequest(request);
      const id = this.nextId++;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => this.taint('request_timeout'), timeoutMs);
        this.pending = { id, resolve, reject, timer };
        this.stream.write(`${JSON.stringify({ v: 1, id, ...valid })}\n`);
      });
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async exec(
    request: {
      profile: ContainerProfile;
      argv: readonly string[];
      cwd?: string;
      timeoutMs: number;
      network?: ExecNetwork;
      env?: Readonly<Record<string, string>>;
      report?: boolean;
    },
    graceMs: number
  ): Promise<ExecResult> {
    const started = Date.now();
    const wantReport = request.report === true;
    const frame = await this.send(
      {
        op: 'exec',
        profile: request.profile,
        argv: [...request.argv],
        cwd: request.cwd ?? '',
        timeoutMs: request.timeoutMs,
        network: request.network ?? 'none',
        env: { ...(request.env ?? {}) },
        report: wantReport,
      },
      request.timeoutMs + graceMs
    );
    if (frame.ok !== true) throw new BrokerError(this.errorCode(frame));
    const exitCode = frame.exitCode;
    if (
      !(
        exitCode === null ||
        (Number.isSafeInteger(exitCode) && (exitCode as number) >= 0 && (exitCode as number) < 256)
      ) ||
      typeof frame.timedOut !== 'boolean' ||
      typeof frame.truncated !== 'boolean'
    ) {
      this.taint('malformed_response');
      throw this.failure;
    }
    let stdout: Buffer;
    let stderr: Buffer;
    let report: Buffer | null = null;
    try {
      stdout = decodeBase64Strict(frame.stdout, MAX_STREAM_BYTES, 'malformed_response');
      stderr = decodeBase64Strict(frame.stderr, MAX_STREAM_BYTES, 'malformed_response');
      // A report only when one was asked for; never an unsolicited field.
      if (wantReport) {
        if (frame.report !== null)
          report = decodeBase64Strict(frame.report, MAX_REPORT_BYTES, 'malformed_response');
      } else if (frame.report !== undefined) throw new BrokerError('malformed_response');
    } catch (error) {
      this.taint('malformed_response');
      throw error;
    }
    return {
      exitCode: exitCode as number | null,
      timedOut: frame.timedOut,
      truncated: frame.truncated,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
      durationMs: Date.now() - started,
      ...(wantReport ? { report } : {}),
    };
  }

  /** Asks the guest to sync and power off. Its answer is not trusted: the
   * controller still waits for QEMU to exit and kills it if it does not. */
  async shutdown(timeoutMs: number): Promise<void> {
    const frame = await this.send({ op: 'shutdown' }, timeoutMs);
    if (frame.ok !== true) throw new BrokerError(this.errorCode(frame));
  }

  async put(
    relativePath: string,
    bytes: Buffer,
    executable: boolean,
    timeoutMs: number
  ): Promise<void> {
    if (bytes.length > MAX_FILE_BYTES) throw new BrokerError('invalid_data');
    const frame = await this.send(
      { op: 'put', path: relativePath, data: bytes.toString('base64'), executable },
      timeoutMs
    );
    if (frame.ok !== true) throw new BrokerError(this.errorCode(frame));
  }

  async get(relativePath: string, timeoutMs: number): Promise<Buffer> {
    const frame = await this.send({ op: 'get', path: relativePath }, timeoutMs);
    if (frame.ok !== true) throw new BrokerError(this.errorCode(frame));
    try {
      return decodeBase64Strict(frame.data, MAX_FILE_BYTES, 'malformed_response');
    } catch {
      this.taint('malformed_response');
      throw this.failure;
    }
  }

  /** Guest error codes are untrusted text: accept only a short slug. */
  private errorCode(frame: Record<string, unknown>): string {
    const code = frame.error;
    if (frame.ok === false && typeof code === 'string' && /^[a-z_]{1,40}$/.test(code))
      return `guest_${code}`;
    this.taint('malformed_response');
    return 'malformed_response';
  }

  close(): void {
    this.stream.destroy();
  }
}
