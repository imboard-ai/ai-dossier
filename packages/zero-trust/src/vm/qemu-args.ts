/** Pure QEMU argv construction. Everything here is controller policy; nothing is
 * derived from repository, worker or model input. */
import type { Accelerator, ExecScope, NetworkPhase, VmLimits } from './adapter';

export const BROKER_PORT_NAME = 'org.ai-dossier.zt.broker';
/** SMBIOS type 11 OEM string carrying the controller-set scope. fw_cfg would need
 * `qemu_fw_cfg`, which the cloud image kernel does not ship; `dmi_sysfs` it does. */
export const SCOPE_OEM_PREFIX = 'org.ai-dossier.zt.scope:';
/** Second OEM string: the controller-set network phase. The guest announces it back;
 * it only selects guest-side behaviour, the forward itself is host policy. */
export const PHASE_OEM_PREFIX = 'org.ai-dossier.zt.phase:';
/** Guest TCP port of the provisioning relay; the one host forward lands here. */
export const GUEST_RELAY_PORT = 7480;
/** Where provisioning workers reach the package mirror: the relay on the gateway of
 * the VM's internal provisioning network (`vm-guest/agent.py`). */
export const WORKER_RELAY = Object.freeze({ host: '172.30.255.1', port: 7481 });
/** sun_path is 108 bytes including the terminator. */
export const MAX_SOCKET_PATH_BYTES = 107;
/** QEMU and qemu-img never need the controller's environment; secrets in it must not reach them. */
export const QEMU_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: '/usr/local/bin:/usr/bin:/bin',
  LANG: 'C',
});

/** Host-side egress policy (PRD §5.5): user-mode networking with `restrict=on`
 * isolates the guest from the host, LAN, metadata services and the internet
 * no matter what runs as root inside the VM. This is the verification (build and
 * test) policy: no forwards at all. Only the provisioning phase adds one, see
 * `provisioningNetworkPolicy`. */
export const RUN_NETWORK_POLICY = Object.freeze({
  backend: 'qemu-user-mode',
  restrict: true,
  guestForwards: Object.freeze([] as string[]),
  hostForwards: Object.freeze([] as string[]),
  hostFilesystemSharing: 'none',
});

/** Provisioning policy (#1010): the verification policy plus exactly one host
 * forward, from a loopback port on the host to the guest relay. The guest still
 * cannot open any connection; the controller's connector dials in through this
 * forward and splices each connection to the package proxy. A `guestfwd` cannot do
 * this: QEMU gives it either one shared chardev stream or a spawned process per
 * connection, which `-sandbox spawn=deny` forbids. */
export function provisioningNetworkPolicy(hostPort: number): typeof RUN_NETWORK_POLICY {
  if (!Number.isSafeInteger(hostPort) || hostPort < 1024 || hostPort > 65535)
    throw new Error('Invalid forward port');
  return Object.freeze({
    ...RUN_NETWORK_POLICY,
    hostForwards: Object.freeze([`tcp:127.0.0.1:${hostPort}-:${GUEST_RELAY_PORT}`]),
  });
}

/** TCG is software emulation: same image and isolation, longer clocks. Measured on
 * GitHub-hosted runners, TCG ran short container commands 8.8–15× slower than KVM
 * (#1009) and the npm fixture's install, rebuild and test 10–15× slower (#1010), so
 * the scale covers the worst observed ratio. ×4 would time out a command that takes
 * more than a quarter of its budget under KVM and report it inconclusive. */
export const TIMEOUT_SCALE: Readonly<Record<Accelerator, number>> = Object.freeze({
  kvm: 1,
  tcg: 16,
});
export const BOOT_TIMEOUT_MS: Readonly<Record<Accelerator, number>> = Object.freeze({
  kvm: 3 * 60 * 1000,
  tcg: 20 * 60 * 1000,
});

interface CommonArgs {
  readonly name: string;
  readonly accelerator: Accelerator;
  readonly limits: Pick<VmLimits, 'vcpus' | 'memoryMiB'>;
  readonly disk: string;
  readonly pidFile: string;
}

export interface RunArgs extends CommonArgs {
  readonly brokerSocket: string;
  readonly scope: ExecScope;
  /** Default `verification`: no forwards. */
  readonly phase?: NetworkPhase;
  /** Host loopback port of the provisioning forward; required in, and only in, provisioning. */
  readonly forwardHostPort?: number;
}

export interface BakeArgs extends CommonArgs {
  readonly seedIso: string;
  readonly consoleLog: string;
}

function assertSafeValue(value: string): void {
  // QEMU option values are comma-separated; a comma would smuggle extra options.
  if (!value || value.includes(',') || /[\0\n\r]/.test(value))
    throw new Error('Unsafe QEMU option value');
}

function common(args: CommonArgs): string[] {
  for (const value of [args.name, args.disk, args.pidFile]) assertSafeValue(value);
  const { vcpus, memoryMiB } = args.limits;
  if (!Number.isSafeInteger(vcpus) || vcpus < 1 || vcpus > 64)
    throw new Error('Invalid vCPU limit');
  if (!Number.isSafeInteger(memoryMiB) || memoryMiB < 512 || memoryMiB > 262144)
    throw new Error('Invalid memory limit');
  return [
    '-name',
    `${args.name},process=${args.name}`,
    '-machine',
    `q35,accel=${args.accelerator}`,
    '-cpu',
    args.accelerator === 'kvm' ? 'host' : 'max',
    '-smp',
    String(vcpus),
    '-m',
    String(memoryMiB),
    '-nodefaults',
    '-no-user-config',
    '-display',
    'none',
    '-no-reboot',
    // QEMU's own seccomp filter: no privilege elevation, no spawning helpers.
    // Incompatible with -daemonize (setsid/fork), so the controller detaches it.
    '-sandbox',
    'on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny',
    '-pidfile',
    args.pidFile,
    '-drive',
    `file=${args.disk},if=virtio,format=qcow2,discard=unmap`,
    '-device',
    'virtio-rng-pci',
  ];
}

/** The user-mode `-netdev` value that enforces a network policy. */
export function netdevValue(
  policy: Pick<
    typeof RUN_NETWORK_POLICY,
    'restrict' | 'guestForwards' | 'hostForwards'
  > = RUN_NETWORK_POLICY
): string {
  return [
    'user',
    'id=net0',
    `restrict=${policy.restrict ? 'on' : 'off'}`,
    ...policy.guestForwards.map((rule) => `guestfwd=${rule}`),
    ...policy.hostForwards.map((rule) => `hostfwd=${rule}`),
  ].join(',');
}

/** `qemu-img create` argv for a copy-on-write overlay on a qcow2 base. */
export function buildOverlayArgs(base: string, disk: string, sizeGiB: number): string[] {
  for (const value of [base, disk]) assertSafeValue(value);
  if (!Number.isSafeInteger(sizeGiB) || sizeGiB < 1) throw new Error('Invalid disk size');
  return ['create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', base, disk, `${sizeGiB}G`];
}

/** Untrusted run: restricted network, broker port, no console, no shared files. */
export function buildRunArgs(args: RunArgs): string[] {
  assertSafeValue(args.brokerSocket);
  if (Buffer.byteLength(args.brokerSocket) > MAX_SOCKET_PATH_BYTES)
    throw new Error('Broker socket path too long');
  if (args.scope !== 'container' && args.scope !== 'vm-root') throw new Error('Invalid scope');
  const phase = args.phase ?? 'verification';
  if (phase !== 'provisioning' && phase !== 'verification') throw new Error('Invalid phase');
  if ((phase === 'provisioning') !== (args.forwardHostPort !== undefined))
    throw new Error('A forward port is required in, and only in, the provisioning phase');
  const policy =
    phase === 'provisioning'
      ? provisioningNetworkPolicy(args.forwardHostPort as number)
      : RUN_NETWORK_POLICY;
  return [
    ...common(args),
    '-serial',
    'none',
    '-netdev',
    netdevValue(policy),
    '-device',
    'virtio-net-pci,netdev=net0',
    '-device',
    'virtio-serial-pci',
    '-chardev',
    `socket,id=broker,path=${args.brokerSocket},server=on,wait=off`,
    '-device',
    `virtserialport,chardev=broker,name=${BROKER_PORT_NAME}`,
    '-smbios',
    `type=11,value=${SCOPE_OEM_PREFIX}${args.scope},value=${PHASE_OEM_PREFIX}${phase}`,
  ];
}

/** Trusted bake: pinned inputs only, no untrusted code, ordinary user-mode
 * networking for the package archive and image registry. */
export function buildBakeArgs(args: BakeArgs): string[] {
  for (const value of [args.seedIso, args.consoleLog]) assertSafeValue(value);
  return [
    ...common(args),
    '-serial',
    `file:${args.consoleLog}`,
    '-drive',
    `file=${args.seedIso},if=virtio,format=raw,readonly=on`,
    '-netdev',
    'user,id=net0',
    '-device',
    'virtio-net-pci,netdev=net0',
  ];
}
