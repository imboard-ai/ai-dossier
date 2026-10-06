/** Host side of the provisioning channel (#1010). The VM's only forward is a QEMU
 * `hostfwd` from a host loopback port to the guest relay, so the guest can never open
 * a connection: this connector keeps a small pool of connections dialed INTO the guest
 * and, once the guest sends the first bytes on one, opens a connection to the one
 * package-proxy target and splices the two. Bytes are never parsed; the only place
 * guest traffic can go is that target.
 *
 * Every connection starts with the per-boot relay key (sent to the guest over the
 * broker, never on a command line), so the relay pairs worker connections only with
 * connections this controller dialed, not with anything else on host loopback. */
import net from 'node:net';
import type { ProxyTarget } from './adapter';

/** Length of the relay key preamble, in bytes. */
export const RELAY_KEY_BYTES = 32;
export const DEFAULT_POOL_SIZE = 8;
export const DEFAULT_MAX_CONNECTIONS = 64;
export const DEFAULT_MAX_PENDING_BYTES = 64 * 1024;
/** Back-off before refilling the pool after idle connections closed unused. */
const REDIAL_MS = 250;

export interface ProvisionChannelOptions {
  /** Host loopback port of the VM's provisioning forward. */
  readonly forwardPort: number;
  readonly target: ProxyTarget;
  /** Sent first on every connection; the guest relay drops a connection without it. */
  readonly relayKey: Buffer;
  /** Idle connections kept open into the guest. */
  readonly poolSize?: number;
  /** Ceiling on simultaneous connections, guest and upstream together. */
  readonly maxConnections?: number;
  /** Bytes a guest may send before the upstream is connected. */
  readonly maxPendingBytes?: number;
  readonly connect?: (port: number, host: string) => net.Socket;
}

export interface ProvisionChannelStats {
  dialed: number;
  spliced: number;
  upstreamFailures: number;
  /** Error code of the last failed upstream connection (e.g. `ECONNREFUSED`). */
  lastUpstreamError: string | null;
  bytesToTarget: number;
  bytesFromTarget: number;
}

export function assertProxyTarget(target: ProxyTarget): ProxyTarget {
  if (
    !target ||
    typeof target.host !== 'string' ||
    !net.isIPv4(target.host) ||
    !Number.isSafeInteger(target.port) ||
    target.port < 1 ||
    target.port > 65535
  )
    throw new Error('Invalid provisioning proxy target');
  return Object.freeze({ host: target.host, port: target.port });
}

export class ProvisionChannel {
  readonly stats: ProvisionChannelStats = {
    dialed: 0,
    spliced: 0,
    upstreamFailures: 0,
    lastUpstreamError: null,
    bytesToTarget: 0,
    bytesFromTarget: 0,
  };
  private readonly target: ProxyTarget;
  private readonly relayKey: Buffer;
  private readonly poolSize: number;
  private readonly maxConnections: number;
  private readonly maxPending: number;
  private readonly connect: (port: number, host: string) => net.Socket;
  private readonly sockets = new Set<net.Socket>();
  private idle = 0;
  private closed = false;
  private redial: NodeJS.Timeout | null = null;

  constructor(private readonly options: ProvisionChannelOptions) {
    if (!Number.isSafeInteger(options.forwardPort) || options.forwardPort < 1)
      throw new Error('Invalid forward port');
    if (!Buffer.isBuffer(options.relayKey) || options.relayKey.length !== RELAY_KEY_BYTES)
      throw new Error('Invalid relay key');
    this.target = assertProxyTarget(options.target);
    this.relayKey = Buffer.from(options.relayKey);
    this.poolSize = options.poolSize ?? DEFAULT_POOL_SIZE;
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.maxPending = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
    // Half-open so one side's end() is forwarded instead of closing both directions.
    this.connect =
      options.connect ?? ((port, host) => net.connect({ port, host, allowHalfOpen: true }));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  start(): void {
    this.fill();
  }

  /** Destroys every guest and upstream connection and stops dialing. Idempotent. */
  close(): void {
    this.closed = true;
    if (this.redial) clearTimeout(this.redial);
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  private fill(): void {
    this.redial = null;
    while (!this.closed && this.idle < this.poolSize && this.sockets.size < this.maxConnections)
      this.dial();
  }

  private scheduleFill(): void {
    if (!this.closed && !this.redial) this.redial = setTimeout(() => this.fill(), REDIAL_MS);
  }

  private track(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
  }

  private dial(): void {
    const guest = this.connect(this.options.forwardPort, '127.0.0.1');
    this.stats.dialed++;
    this.idle++;
    this.track(guest);
    guest.write(this.relayKey);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let isIdle = true;
    const leaveIdle = (used: boolean) => {
      if (!isIdle) return;
      isIdle = false;
      this.idle--;
      // A used connection is replaced at once. An idle one that closed means the
      // relay is not listening yet (slirp drops each dial): back off, then refill.
      if (used) this.fill();
      else this.scheduleFill();
    };
    guest.on('error', () => guest.destroy());
    guest.once('close', () => leaveIdle(false));
    const onFirstData = (chunk: Buffer) => {
      pending.push(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes > this.maxPending) {
        guest.destroy();
        return;
      }
      if (pending.length > 1) return; // upstream dial already under way
      leaveIdle(true);
      const upstream = this.connect(this.target.port, this.target.host);
      this.track(upstream);
      upstream.on('error', (error: NodeJS.ErrnoException) => {
        this.stats.upstreamFailures++;
        this.stats.lastUpstreamError = error.code ?? 'error';
        upstream.destroy();
        guest.destroy();
      });
      upstream.once('connect', () => {
        guest.off('data', onFirstData);
        this.splice(guest, upstream, pending);
        pending = [];
      });
      upstream.once('close', () => guest.destroy());
      guest.once('close', () => upstream.destroy());
    };
    guest.on('data', onFirstData);
  }

  /** Byte-for-byte both ways with backpressure; an end on one side ends the other. */
  private splice(guest: net.Socket, upstream: net.Socket, buffered: Buffer[]): void {
    this.stats.spliced++;
    for (const chunk of buffered) {
      this.stats.bytesToTarget += chunk.length;
      upstream.write(chunk);
    }
    guest.on('data', (data: Buffer) => {
      this.stats.bytesToTarget += data.length;
      if (!upstream.write(data)) guest.pause();
    });
    upstream.on('drain', () => guest.resume());
    upstream.on('data', (data: Buffer) => {
      this.stats.bytesFromTarget += data.length;
      if (!guest.write(data)) upstream.pause();
    });
    guest.on('drain', () => upstream.resume());
    guest.once('end', () => upstream.end());
    upstream.once('end', () => guest.end());
  }
}
