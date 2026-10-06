import { describe, expect, it } from 'vitest';
import {
  type BakeArgs,
  BOOT_TIMEOUT_MS,
  BROKER_PORT_NAME,
  buildBakeArgs,
  buildOverlayArgs,
  buildRunArgs,
  GUEST_RELAY_PORT,
  MAX_SOCKET_PATH_BYTES,
  netdevValue,
  PHASE_OEM_PREFIX,
  provisioningNetworkPolicy,
  QEMU_ENV,
  RUN_NETWORK_POLICY,
  type RunArgs,
  SCOPE_OEM_PREFIX,
  TIMEOUT_SCALE,
} from '../vm/qemu-args';

const RUN: RunArgs = {
  name: 'zt-run-1',
  accelerator: 'kvm',
  limits: { vcpus: 4, memoryMiB: 8192 },
  disk: '/var/lib/zt/run-1/overlay.qcow2',
  pidFile: '/var/lib/zt/run-1/qemu.pid',
  brokerSocket: '/run/zt/run-1/broker.sock',
  scope: 'container',
};

const BAKE: BakeArgs = {
  name: 'zt-bake',
  accelerator: 'tcg',
  limits: { vcpus: 2, memoryMiB: 4096 },
  disk: '/var/lib/zt/bake/disk.qcow2',
  pidFile: '/var/lib/zt/bake/qemu.pid',
  seedIso: '/var/lib/zt/bake/seed.iso',
  consoleLog: '/var/lib/zt/bake/console.log',
};

function valuesOf(argv: readonly string[], flag: string): string[] {
  return argv.flatMap((value, i) => (value === flag ? [argv[i + 1]] : []));
}

describe('buildRunArgs — untrusted run boundary', () => {
  const argv = buildRunArgs(RUN);
  const joined = argv.join(' ');

  it('uses restricted user-mode networking with no forwards', () => {
    expect(valuesOf(argv, '-netdev')).toEqual(['user,id=net0,restrict=on']);
    expect(joined).not.toMatch(/hostfwd|guestfwd/);
  });

  it('derives the -netdev value from RUN_NETWORK_POLICY', () => {
    const expected = [
      'user',
      'id=net0',
      `restrict=${RUN_NETWORK_POLICY.restrict ? 'on' : 'off'}`,
      ...RUN_NETWORK_POLICY.guestForwards.map((rule) => `guestfwd=${rule}`),
      ...RUN_NETWORK_POLICY.hostForwards.map((rule) => `hostfwd=${rule}`),
    ].join(',');
    expect(valuesOf(argv, '-netdev')).toEqual([expected]);
    // The policy is the only source: with no forwards and restrict on, the value is fixed.
    expect(expected).toBe('user,id=net0,restrict=on');
  });

  it('shares no host filesystem and exposes only the broker chardev', () => {
    expect(joined).not.toMatch(/-virtfs|-fsdev|virtiofs|9p|vhost-user-fs|-mount/);
    expect(valuesOf(argv, '-chardev')).toEqual([
      `socket,id=broker,path=${RUN.brokerSocket},server=on,wait=off`,
    ]);
    expect(valuesOf(argv, '-device')).toContain(
      `virtserialport,chardev=broker,name=${BROKER_PORT_NAME}`
    );
  });

  it('has no serial console and no default devices', () => {
    expect(valuesOf(argv, '-serial')).toEqual(['none']);
    expect(argv).toContain('-nodefaults');
    expect(argv).toContain('-no-user-config');
    expect(valuesOf(argv, '-display')).toEqual(['none']);
  });

  it('enables QEMU seccomp without privilege elevation or spawning', () => {
    const [sandbox] = valuesOf(argv, '-sandbox');
    expect(sandbox.split(',')[0]).toBe('on');
    expect(sandbox).toContain('elevateprivileges=deny');
    expect(sandbox).toContain('spawn=deny');
    expect(argv).not.toContain('-daemonize');
  });

  it('kvm uses -cpu host, tcg uses -cpu max', () => {
    expect(valuesOf(argv, '-cpu')).toEqual(['host']);
    expect(valuesOf(argv, '-machine')).toEqual(['q35,accel=kvm']);
    const tcg = buildRunArgs({ ...RUN, accelerator: 'tcg' });
    expect(valuesOf(tcg, '-cpu')).toEqual(['max']);
    expect(valuesOf(tcg, '-machine')).toEqual(['q35,accel=tcg']);
  });

  it('takes -smp and -m from the limits', () => {
    expect(valuesOf(argv, '-smp')).toEqual(['4']);
    expect(valuesOf(argv, '-m')).toEqual(['8192']);
    const custom = buildRunArgs({ ...RUN, limits: { vcpus: 64, memoryMiB: 512 } });
    expect(valuesOf(custom, '-smp')).toEqual(['64']);
    expect(valuesOf(custom, '-m')).toEqual(['512']);
    expect(
      valuesOf(buildRunArgs({ ...RUN, limits: { vcpus: 1, memoryMiB: 262144 } }), '-m')
    ).toEqual(['262144']);
  });

  it('passes the scope through an SMBIOS OEM string', () => {
    expect(valuesOf(argv, '-smbios')).toEqual([
      `type=11,value=${SCOPE_OEM_PREFIX}container,value=${PHASE_OEM_PREFIX}verification`,
    ]);
    expect(valuesOf(buildRunArgs({ ...RUN, scope: 'vm-root' }), '-smbios')).toEqual([
      'type=11,value=org.ai-dossier.zt.scope:vm-root,value=org.ai-dossier.zt.phase:verification',
    ]);
  });

  it('provisioning adds exactly one loopback host forward to the relay, and nothing else', () => {
    const prov = buildRunArgs({ ...RUN, phase: 'provisioning', forwardHostPort: 40123 });
    expect(valuesOf(prov, '-netdev')).toEqual([
      `user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:40123-:${GUEST_RELAY_PORT}`,
    ]);
    expect(valuesOf(prov, '-smbios')).toEqual([
      `type=11,value=${SCOPE_OEM_PREFIX}container,value=${PHASE_OEM_PREFIX}provisioning`,
    ]);
    expect(prov.join(' ')).not.toContain('guestfwd');
    // Every other argument is the verification argv's.
    const strip = (a: string[]) =>
      a.filter((v) => !v.startsWith('user,') && !v.startsWith('type=11'));
    expect(strip(prov)).toEqual(strip(argv));
  });

  it('requires a forward port in, and only in, provisioning', () => {
    expect(() => buildRunArgs({ ...RUN, phase: 'provisioning' })).toThrow('forward port');
    expect(() => buildRunArgs({ ...RUN, forwardHostPort: 40123 })).toThrow('forward port');
    expect(() => buildRunArgs({ ...RUN, phase: 'build' as never })).toThrow('Invalid phase');
    for (const port of [0, 80, 65536, 1.5])
      expect(() => buildRunArgs({ ...RUN, phase: 'provisioning', forwardHostPort: port })).toThrow(
        'Invalid forward port'
      );
  });

  it('provisioningNetworkPolicy keeps restrict=on and only adds the forward', () => {
    const policy = provisioningNetworkPolicy(40123);
    expect(policy).toMatchObject({
      restrict: true,
      guestForwards: [],
      hostFilesystemSharing: 'none',
    });
    expect(policy.hostForwards).toEqual([`tcp:127.0.0.1:40123-:${GUEST_RELAY_PORT}`]);
    expect(Object.isFrozen(policy.hostForwards)).toBe(true);
    expect(RUN_NETWORK_POLICY.hostForwards).toEqual([]);
  });

  it('includes disk and pidfile', () => {
    expect(valuesOf(argv, '-pidfile')).toEqual([RUN.pidFile]);
    expect(valuesOf(argv, '-drive')).toEqual([
      `file=${RUN.disk},if=virtio,format=qcow2,discard=unmap`,
    ]);
    expect(valuesOf(argv, '-name')).toEqual([`${RUN.name},process=${RUN.name}`]);
  });

  it.each([
    'name',
    'disk',
    'pidFile',
    'brokerSocket',
  ] as const)('rejects unsafe %s values', (field) => {
    for (const bad of ['', 'a,b', 'a\nb', 'a\rb', 'a\0b'])
      expect(() => buildRunArgs({ ...RUN, [field]: bad })).toThrow('Unsafe QEMU option value');
  });

  it('rejects a broker socket path longer than sun_path allows', () => {
    const ok = `/${'s'.repeat(MAX_SOCKET_PATH_BYTES - 1)}`;
    expect(Buffer.byteLength(ok)).toBe(107);
    expect(() => buildRunArgs({ ...RUN, brokerSocket: ok })).not.toThrow();
    expect(() => buildRunArgs({ ...RUN, brokerSocket: `${ok}x` })).toThrow(
      'Broker socket path too long'
    );
    // Byte length, not character length.
    const multibyte = `/${'é'.repeat(54)}`;
    expect(multibyte.length).toBeLessThanOrEqual(107);
    expect(() => buildRunArgs({ ...RUN, brokerSocket: multibyte })).toThrow(
      'Broker socket path too long'
    );
  });

  it('rejects an invalid scope', () => {
    expect(() => buildRunArgs({ ...RUN, scope: 'host' as never })).toThrow('Invalid scope');
  });

  it.each([0, 65, 1.5, Number.NaN, -1])('rejects vcpus %s', (vcpus) => {
    expect(() => buildRunArgs({ ...RUN, limits: { vcpus, memoryMiB: 8192 } })).toThrow(
      'Invalid vCPU limit'
    );
  });

  it.each([511, 262145, 1024.5, 0, Number.POSITIVE_INFINITY])('rejects memory %s', (memoryMiB) => {
    expect(() => buildRunArgs({ ...RUN, limits: { vcpus: 4, memoryMiB } })).toThrow(
      'Invalid memory limit'
    );
  });
});

describe('buildBakeArgs — trusted bake', () => {
  const argv = buildBakeArgs(BAKE);

  it('logs the serial console to a file', () => {
    expect(valuesOf(argv, '-serial')).toEqual([`file:${BAKE.consoleLog}`]);
  });

  it('attaches the seed ISO read-only', () => {
    expect(valuesOf(argv, '-drive')).toContain(
      `file=${BAKE.seedIso},if=virtio,format=raw,readonly=on`
    );
  });

  it('uses unrestricted user networking (pinned, trusted inputs only)', () => {
    expect(valuesOf(argv, '-netdev')).toEqual(['user,id=net0']);
    expect(argv.join(' ')).not.toMatch(/hostfwd|guestfwd|restrict=on/);
    expect(valuesOf(argv, '-cpu')).toEqual(['max']);
    expect(argv).toContain('-nodefaults');
  });

  it.each([
    'seedIso',
    'consoleLog',
    'disk',
    'name',
    'pidFile',
  ] as const)('rejects unsafe %s', (field) => {
    for (const bad of ['', 'x,y', 'x\ny', 'x\0y'])
      expect(() => buildBakeArgs({ ...BAKE, [field]: bad })).toThrow('Unsafe QEMU option value');
  });

  it('applies the same resource limits', () => {
    expect(() => buildBakeArgs({ ...BAKE, limits: { vcpus: 0, memoryMiB: 4096 } })).toThrow(
      'Invalid vCPU limit'
    );
  });
});

describe('policy constants', () => {
  it('RUN_NETWORK_POLICY is frozen with empty forwards', () => {
    expect(Object.isFrozen(RUN_NETWORK_POLICY)).toBe(true);
    expect(Object.isFrozen(RUN_NETWORK_POLICY.guestForwards)).toBe(true);
    expect(Object.isFrozen(RUN_NETWORK_POLICY.hostForwards)).toBe(true);
    expect(RUN_NETWORK_POLICY.guestForwards).toEqual([]);
    expect(RUN_NETWORK_POLICY.hostForwards).toEqual([]);
    expect(RUN_NETWORK_POLICY.restrict).toBe(true);
    expect(RUN_NETWORK_POLICY.hostFilesystemSharing).toBe('none');
    expect(() => {
      (RUN_NETWORK_POLICY.hostForwards as string[]).push('tcp::2222-:22');
    }).toThrow();
  });

  it('TCG gets longer clocks than KVM', () => {
    expect(TIMEOUT_SCALE.tcg).toBeGreaterThan(TIMEOUT_SCALE.kvm);
    // Covers the TCG/KVM ratio of multi-second steps measured in CI (up to 15×).
    expect(TIMEOUT_SCALE.tcg).toBeGreaterThanOrEqual(15);
    expect(BOOT_TIMEOUT_MS.tcg).toBeGreaterThan(BOOT_TIMEOUT_MS.kvm);
    expect(Object.isFrozen(TIMEOUT_SCALE)).toBe(true);
  });
});

describe('buildOverlayArgs', () => {
  it('builds a qcow2 overlay on a qcow2 base', () => {
    expect(buildOverlayArgs('/p/base.qcow2', '/s/disk.qcow2', 20)).toEqual([
      'create',
      '-q',
      '-f',
      'qcow2',
      '-F',
      'qcow2',
      '-b',
      '/p/base.qcow2',
      '/s/disk.qcow2',
      '20G',
    ]);
  });

  it.each([
    ['/p/base,file.qcow2', '/s/disk.qcow2'],
    ['/p/base.qcow2', '/s/disk\nx.qcow2'],
    ['/p/base.qcow2', '/s/a,b'],
    ['', '/s/disk.qcow2'],
    ['/p/base.qcow2', '/s/d\0'],
  ])('rejects unsafe paths (%j, %j)', (base, disk) => {
    expect(() => buildOverlayArgs(base, disk, 20)).toThrow('Unsafe QEMU option value');
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2 ** 60,
  ])('rejects disk size %j', (size) => {
    expect(() => buildOverlayArgs('/p/base.qcow2', '/s/disk.qcow2', size)).toThrow(
      'Invalid disk size'
    );
  });

  it('accepts the smallest valid size', () => {
    expect(buildOverlayArgs('/b', '/d', 1).at(-1)).toBe('1G');
  });
});

describe('netdevValue', () => {
  it('renders the run policy as restricted user-mode networking with no forwards', () => {
    expect(netdevValue()).toBe('user,id=net0,restrict=on');
  });

  it('renders forwards and an unrestricted policy when one is given', () => {
    expect(
      netdevValue({
        restrict: false,
        guestForwards: ['tcp:10.0.2.100:80-tcp:127.0.0.1:3128'],
        hostForwards: ['tcp::2222-:22'],
      })
    ).toBe(
      'user,id=net0,restrict=off,guestfwd=tcp:10.0.2.100:80-tcp:127.0.0.1:3128,hostfwd=tcp::2222-:22'
    );
  });
});

describe('QEMU_ENV', () => {
  it('carries only PATH and LANG and is frozen', () => {
    expect(Object.keys(QEMU_ENV).sort()).toEqual(['LANG', 'PATH']);
    expect(QEMU_ENV.LANG).toBe('C');
    expect(Object.isFrozen(QEMU_ENV)).toBe(true);
  });
});
