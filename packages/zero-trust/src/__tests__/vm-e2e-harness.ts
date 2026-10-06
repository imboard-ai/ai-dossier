/** Shared harness for the real-VM gate suites (gate 1 `vm-gate.e2e.test.ts`, gate 2
 * `vm-proxy.e2e.test.ts`): VM limits, freshly planted host canaries and listeners,
 * the probe targets, timings and host-side broker-rejection checks. */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { BrokerError, type VmLimits } from '../vm/adapter';
import { BAKED_DISK_GIB } from '../vm/profile';

export const E2E_LIMITS: VmLimits = {
  vcpus: 2,
  memoryMiB: 4096,
  diskGiB: BAKED_DISK_GIB,
  commandTimeoutMs: 10 * 60_000,
};

/** Categories whose denial must hold even for root inside the VM: they are
 * enforced by QEMU on the host, not by the container runtime. */
export const HOST_ENFORCED = new Set([
  'host-env',
  'host-file',
  'host-loopback',
  'lan',
  'metadata',
  'direct-egress',
  'dns',
]);

export const hex = (n: number) => randomBytes(n).toString('hex');

export interface Listener {
  readonly server: net.Server;
  readonly port: number;
  connections: number;
}

/** A host TCP listener that counts (and drops) every connection it receives. */
export async function listen(host: string): Promise<Listener> {
  const listener = { connections: 0 } as Listener;
  const server = net.createServer((socket) => {
    listener.connections++;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
  return Object.assign(listener, { server, port: (server.address() as net.AddressInfo).port });
}

export function lanAddress(): string {
  for (const list of Object.values(os.networkInterfaces()))
    for (const entry of list ?? [])
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  throw new Error('No non-loopback IPv4 address to plant the LAN listener on');
}

export interface PlantedCanaries {
  /** Canary values no guest byte may contain. */
  readonly canaries: readonly string[];
  /** `targets.json` for the hostile probe. */
  readonly targets: Record<string, unknown>;
  readonly loopback: Listener;
  readonly lan: Listener;
  connections(): number;
  /** Closes the listeners, unsets the variable and removes the planted home. */
  cleanup(): void;
}

/** Plants fresh canaries: a variable in QEMU's parent environment, a secret file in a
 * temporary host home, and listeners on host loopback and a LAN address. */
export async function plantCanaries(): Promise<PlantedCanaries> {
  const envName = `ZT_CANARY_${hex(8).toUpperCase()}`;
  const envCanary = `zt-env-${hex(16)}`;
  process.env[envName] = envCanary;
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-gate-home-'));
  const hostFile = path.join(hostHome, '.zt-canary-secret');
  const fileCanary = `zt-file-${hex(16)}`;
  fs.writeFileSync(hostFile, fileCanary, { mode: 0o600 });
  const loopback = await listen('127.0.0.1');
  const lanHost = lanAddress();
  const lan = await listen(lanHost);
  return {
    canaries: [envCanary, fileCanary],
    targets: {
      envName,
      hostFile,
      gateway: '10.0.2.2',
      loopbackPort: loopback.port,
      lanHost,
      lanPort: lan.port,
      metadata: [
        ['169.254.169.254', 80],
        ['fd00:ec2::254', 80],
      ],
      egress: [
        ['1.1.1.1', 443],
        ['8.8.8.8', 53],
      ],
      dnsName: `zt-dns-${hex(8)}.example.com`,
      dnsServers: ['10.0.2.3', '1.1.1.1', '8.8.8.8'],
    },
    loopback,
    lan,
    connections: () => loopback.connections + lan.connections,
    cleanup() {
      loopback.server.close();
      lan.server.close();
      delete process.env[envName];
      fs.rmSync(hostHome, { recursive: true, force: true });
    },
  };
}

/** Records how long each labelled step took. */
export function timer(timings: Record<string, number>) {
  return async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await work();
    } finally {
      timings[label] = Date.now() - started;
    }
  };
}

/** Runs a request that must be refused host-side, before reaching the guest. */
export async function rejectedByBroker(work: () => unknown): Promise<boolean> {
  try {
    await work();
  } catch (error) {
    return error instanceof BrokerError;
  }
  return false;
}

/** vm-root argv for the npm probe: the node image supplies the runtime and
 * `--network host` puts the probe on the VM's own network stack. */
export function rootProbeArgv(phase: string): string[] {
  return [
    'docker',
    'run',
    '--rm',
    '--network',
    'host',
    '--user',
    '0:0',
    '--mount',
    'type=bind,src=/var/lib/zt/workspace,dst=/workspace',
    '--workdir',
    '/workspace/npm-lifecycle',
    'zt-node:profile',
    'node',
    'probe.js',
    phase,
  ];
}
