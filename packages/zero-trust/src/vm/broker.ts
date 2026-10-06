/** Host side of the narrow worker broker (virtio-serial, JSON lines). The guest
 * is untrusted: every frame is size-capped and schema-checked, and any protocol
 * violation taints the VM permanently — the caller must destroy it. */
import type { Duplex } from 'node:stream';
import { assertNoSecrets } from '../redaction';
import { BrokerError, type ContainerProfile, type ExecResult } from './adapter';

export const BROKER_PROTOCOL = 'zt-broker-v1';
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_STREAM_BYTES = 1024 * 1024;
/** Two capped streams in base64 plus envelope. */
export const MAX_FRAME_BYTES = 4 * MAX_STREAM_BYTES;
const MAX_ARGV = 256;
const MAX_ARG_BYTES = 8192;
const MAX_ARGV_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 512;
const PROFILES: readonly ContainerProfile[] = ['node', 'python'];

export type BrokerRequest =
  | {
      op: 'exec';
      profile: ContainerProfile;
      argv: string[];
      cwd: string;
      timeoutMs: number;
    }
  | { op: 'put'; path: string; data: string; executable: boolean }
  | { op: 'get'; path: string };

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

/** Controller-side allowlist. Nothing reaches the guest that fails here. */
export function validateRequest(request: BrokerRequest): BrokerRequest {
  switch (request?.op) {
    case 'exec': {
      const { argv, profile, timeoutMs } = request;
      if (!PROFILES.includes(profile)) throw new BrokerError('invalid_profile');
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
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 6 * 3600 * 1000)
        throw new BrokerError('invalid_timeout');
      return {
        op: 'exec',
        profile,
        argv: [...argv],
        cwd: assertWorkspacePath(request.cwd, true),
        timeoutMs,
      };
    }
    case 'put': {
      const bytes = Buffer.from(String(request.data), 'base64');
      if (bytes.toString('base64') !== request.data || bytes.length > MAX_FILE_BYTES)
        throw new BrokerError('invalid_data');
      return {
        op: 'put',
        path: assertWorkspacePath(request.path),
        data: request.data,
        executable: request.executable === true,
      };
    }
    case 'get':
      return { op: 'get', path: assertWorkspacePath(request.path) };
    default:
      throw new BrokerError('invalid_op');
  }
}

function decodeStream(value: unknown): Buffer {
  if (typeof value !== 'string') throw new BrokerError('malformed_response');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || bytes.length > MAX_STREAM_BYTES)
    throw new BrokerError('malformed_response');
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  scope: string | null = null;

  constructor(private readonly stream: Duplex) {
    stream.on('data', (chunk: Buffer) => this.onData(chunk));
    stream.on('error', () => this.taint('stream_error'));
    stream.on('close', () => this.taint('stream_closed'));
  }

  get tainted(): BrokerError | null {
    return this.failure;
  }

  taint(code: string): void {
    if (this.failure) return;
    this.failure = new BrokerError(code);
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
        !this.helloWaiter
      ) {
        this.taint('unexpected_hello');
        return;
      }
      this.ready = true;
      this.scope = frame.scope;
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
   * Data written before the guest opens its port stays queued in the socket. */
  waitReady(timeoutMs: number): Promise<string> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.ready) return Promise.resolve(this.scope as string);
    if (this.helloWaiter) return Promise.reject(new BrokerError('hello_pending'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.taint('boot_timeout'), timeoutMs);
      this.helloWaiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve(this.scope as string);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.stream.write(`${JSON.stringify({ v: 1, id: 0, op: 'hello' })}\n`);
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
    },
    graceMs: number
  ): Promise<ExecResult> {
    const started = Date.now();
    const frame = await this.send(
      {
        op: 'exec',
        profile: request.profile,
        argv: [...request.argv],
        cwd: request.cwd ?? '',
        timeoutMs: request.timeoutMs,
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
    try {
      stdout = decodeStream(frame.stdout);
      stderr = decodeStream(frame.stderr);
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
    };
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
    if (typeof frame.data !== 'string') {
      this.taint('malformed_response');
      throw this.failure;
    }
    const bytes = Buffer.from(frame.data, 'base64');
    if (bytes.toString('base64') !== frame.data || bytes.length > MAX_FILE_BYTES) {
      this.taint('malformed_response');
      throw this.failure;
    }
    return bytes;
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
