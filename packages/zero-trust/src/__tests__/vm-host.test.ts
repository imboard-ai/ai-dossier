import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReasonCode } from '../state';
import { UnsupportedEnvironmentError } from '../vm/adapter';
import { type HostProbe, preflightHost, systemProbe } from '../vm/host';

const ALL_TOOLS = ['qemu-system-x86_64', 'qemu-img', 'genisoimage'];

function fakeProbe(
  options: {
    platform?: NodeJS.Platform;
    arch?: string;
    tools?: readonly string[];
    kvm?: boolean;
  } = {}
): HostProbe & { asked: string[] } {
  const tools = new Set(options.tools ?? ALL_TOOLS);
  const asked: string[] = [];
  return {
    platform: options.platform ?? 'linux',
    arch: options.arch ?? 'x64',
    asked,
    which(binary) {
      asked.push(binary);
      return tools.has(binary) ? `/usr/bin/${binary}` : null;
    },
    kvmUsable: () => options.kvm ?? true,
  };
}

function refusal(fn: () => unknown): UnsupportedEnvironmentError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(UnsupportedEnvironmentError);
    return error as UnsupportedEnvironmentError;
  }
  throw new Error('expected preflight refusal');
}

describe('preflightHost — refuses closed', () => {
  it.each(['darwin', 'win32'] as const)('refuses %s as unsupported_os', (platform) => {
    const error = refusal(() => preflightHost('auto', fakeProbe({ platform })));
    expect(error.detail).toBe('unsupported_os');
    expect(error.reasonCode).toBe(ReasonCode.UnsupportedEnvironment);
    expect(error.reasonCode).toBe('unsupported_environment');
    expect(error.message).toContain(platform);
  });

  it.each(['arm64', 'ia32'])('refuses arch %s as unsupported_arch', (arch) => {
    const error = refusal(() => preflightHost('auto', fakeProbe({ arch })));
    expect(error.detail).toBe('unsupported_arch');
    expect(error.reasonCode).toBe(ReasonCode.UnsupportedEnvironment);
  });

  it('refuses when qemu-system-x86_64 is missing', () => {
    const error = refusal(() =>
      preflightHost('auto', fakeProbe({ tools: ['qemu-img', 'genisoimage'] }))
    );
    expect(error.detail).toBe('qemu_missing');
  });

  it('refuses when qemu-img is missing', () => {
    const error = refusal(() =>
      preflightHost('auto', fakeProbe({ tools: ['qemu-system-x86_64', 'genisoimage'] }))
    );
    expect(error.detail).toBe('qemu_img_missing');
  });

  it('refuses when no ISO tool is present', () => {
    const error = refusal(() =>
      preflightHost('auto', fakeProbe({ tools: ['qemu-system-x86_64', 'qemu-img'] }))
    );
    expect(error.detail).toBe('iso_tool_missing');
  });

  it.each(['genisoimage', 'mkisofs', 'xorrisofs'])('accepts %s as the ISO tool', (tool) => {
    const tools = preflightHost(
      'auto',
      fakeProbe({ tools: ['qemu-system-x86_64', 'qemu-img', tool] })
    );
    expect(tools.isoTool).toBe(`/usr/bin/${tool}`);
    expect(tools.qemu).toBe('/usr/bin/qemu-system-x86_64');
    expect(tools.qemuImg).toBe('/usr/bin/qemu-img');
    expect(Object.isFrozen(tools)).toBe(true);
  });

  it('auto on a KVM host selects kvm', () => {
    expect(preflightHost('auto', fakeProbe({ kvm: true })).accelerator).toBe('kvm');
  });

  it('auto without KVM selects tcg', () => {
    expect(preflightHost('auto', fakeProbe({ kvm: false })).accelerator).toBe('tcg');
  });

  it('defaults the request to auto', () => {
    expect(preflightHost(undefined, fakeProbe({ kvm: false })).accelerator).toBe('tcg');
  });

  it('explicit tcg on a KVM host selects tcg', () => {
    expect(preflightHost('tcg', fakeProbe({ kvm: true })).accelerator).toBe('tcg');
  });

  it('explicit kvm with KVM selects kvm', () => {
    expect(preflightHost('kvm', fakeProbe({ kvm: true })).accelerator).toBe('kvm');
  });

  it('explicit kvm without KVM is refused, never downgraded to tcg', () => {
    const error = refusal(() => preflightHost('kvm', fakeProbe({ kvm: false })));
    expect(error.detail).toBe('kvm_unavailable');
    expect(error.reasonCode).toBe(ReasonCode.UnsupportedEnvironment);
  });

  it('never probes for a host container runtime (no docker/podman fallback)', () => {
    const probes = [
      fakeProbe(),
      fakeProbe({ kvm: false }),
      fakeProbe({ tools: ['qemu-system-x86_64', 'qemu-img'] }),
      fakeProbe({ tools: [] }),
      fakeProbe({ tools: ['qemu-system-x86_64', 'qemu-img', 'xorrisofs'] }),
    ];
    for (const probe of probes) {
      try {
        preflightHost('auto', probe);
      } catch {
        // refusals are expected for some probes
      }
      for (const runtime of ['docker', 'podman', 'nerdctl', 'containerd'])
        expect(probe.asked).not.toContain(runtime);
    }
  });
});

describe('systemProbe', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-host-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports the real platform and arch', () => {
    const probe = systemProbe({ PATH: dir });
    expect(probe.platform).toBe(process.platform);
    expect(probe.arch).toBe(process.arch);
  });

  it('finds only absolute-PATH, executable, regular files', () => {
    const bin = path.join(dir, 'bin');
    const other = path.join(dir, 'other');
    fs.mkdirSync(bin);
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(bin, 'good-tool'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'not-exec'), 'data', { mode: 0o644 });
    fs.mkdirSync(path.join(bin, 'a-dir'), { mode: 0o755 });
    // A relative PATH entry pointing at a directory that would resolve from cwd.
    const relDir = path.relative(process.cwd(), other);
    fs.writeFileSync(path.join(other, 'rel-tool'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(other, 'good-tool'), '#!/bin/sh\n', { mode: 0o755 });

    const probe = systemProbe({ PATH: [relDir, 'relative/bin', bin, other].join(path.delimiter) });
    expect(probe.which('good-tool')).toBe(path.join(bin, 'good-tool'));
    expect(probe.which('not-exec')).toBeNull();
    expect(probe.which('a-dir')).toBeNull();
    // Found via the absolute entry only, never through the relative one.
    expect(probe.which('rel-tool')).toBe(path.join(other, 'rel-tool'));
    expect(systemProbe({ PATH: relDir }).which('rel-tool')).toBeNull();
    expect(probe.which('missing-tool')).toBeNull();
  });

  it('returns null when PATH is unset', () => {
    expect(systemProbe({}).which('sh')).toBeNull();
  });

  it('defaults to process.env', () => {
    expect(typeof systemProbe().which).toBe('function');
  });

  it('kvmUsable returns a boolean', () => {
    expect(typeof systemProbe({}).kvmUsable()).toBe('boolean');
  });

  it('kvmUsable is true only when /dev/kvm opens read-write', () => {
    const file = path.join(dir, 'kvm');
    fs.writeFileSync(file, '');
    const realOpen = fs.openSync;
    const spy = vi.spyOn(fs, 'openSync');
    try {
      spy.mockImplementation((p, flags) => {
        expect(p).toBe('/dev/kvm');
        expect(flags).toBe(fs.constants.O_RDWR);
        return realOpen(file, 'r+');
      });
      expect(systemProbe({}).kvmUsable()).toBe(true);
      spy.mockImplementation(() => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      });
      expect(systemProbe({}).kvmUsable()).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
