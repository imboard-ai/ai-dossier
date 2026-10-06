/** Pure QEMU argv construction. Everything here is controller policy; nothing is
 * derived from repository, worker or model input. */
import type { Accelerator, ExecScope, VmLimits } from './adapter';

export const BROKER_PORT_NAME = 'org.ai-dossier.zt.broker';
/** SMBIOS type 11 OEM string carrying the controller-set scope. fw_cfg would need
 * `qemu_fw_cfg`, which the cloud image kernel does not ship; `dmi_sysfs` it does. */
export const SCOPE_OEM_PREFIX = 'org.ai-dossier.zt.scope:';
/** sun_path is 108 bytes including the terminator. */
export const MAX_SOCKET_PATH_BYTES = 107;

/** Host-side egress policy (PRD §5.5): user-mode networking with `restrict=on`
 * isolates the guest from the host, LAN, metadata services and the internet
 * no matter what runs as root inside the VM. Forwards are added only by the
 * provisioning proxy (#1010); build/test phases have none. */
export const RUN_NETWORK_POLICY = Object.freeze({
  backend: 'qemu-user-mode',
  restrict: true,
  guestForwards: Object.freeze([] as string[]),
  hostForwards: Object.freeze([] as string[]),
  hostFilesystemSharing: 'none',
});

/** TCG is software emulation: same image and isolation, longer clocks. */
export const TIMEOUT_SCALE: Readonly<Record<Accelerator, number>> = Object.freeze({
  kvm: 1,
  tcg: 4,
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

/** Untrusted run: restricted network, broker port, no console, no shared files. */
export function buildRunArgs(args: RunArgs): string[] {
  assertSafeValue(args.brokerSocket);
  if (Buffer.byteLength(args.brokerSocket) > MAX_SOCKET_PATH_BYTES)
    throw new Error('Broker socket path too long');
  if (args.scope !== 'container' && args.scope !== 'vm-root') throw new Error('Invalid scope');
  return [
    ...common(args),
    '-serial',
    'none',
    '-netdev',
    'user,id=net0,restrict=on',
    '-device',
    'virtio-net-pci,netdev=net0',
    '-device',
    'virtio-serial-pci',
    '-chardev',
    `socket,id=broker,path=${args.brokerSocket},server=on,wait=off`,
    '-device',
    `virtserialport,chardev=broker,name=${BROKER_PORT_NAME}`,
    '-smbios',
    `type=11,value=${SCOPE_OEM_PREFIX}${args.scope}`,
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
