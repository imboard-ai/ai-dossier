/** Host preflight. Refuses closed; there is deliberately no container-on-host
 * fallback, so the container runtime is never probed here. */
import fs from 'node:fs';
import path from 'node:path';
import { type Accelerator, type AcceleratorRequest, UnsupportedEnvironmentError } from './adapter';

export interface HostProbe {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** Absolute path of an executable on PATH, or null. */
  which(binary: string): string | null;
  /** True only when /dev/kvm can be opened read-write by this (unprivileged) user. */
  kvmUsable(): boolean;
}

export interface HostTools {
  readonly qemu: string;
  readonly qemuImg: string;
  /** genisoimage-compatible CLI used to build NoCloud seeds. */
  readonly isoTool: string;
  readonly accelerator: Accelerator;
}

const ISO_TOOLS = ['genisoimage', 'mkisofs', 'xorrisofs'] as const;

export function systemProbe(env: NodeJS.ProcessEnv = process.env): HostProbe {
  return {
    platform: process.platform,
    arch: process.arch,
    which(binary) {
      for (const dir of (env.PATH ?? '').split(path.delimiter)) {
        if (!path.isAbsolute(dir)) continue; // never resolve through relative PATH entries
        const candidate = path.join(dir, binary);
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
          // keep searching
        }
      }
      return null;
    },
    kvmUsable() {
      try {
        fs.closeSync(fs.openSync('/dev/kvm', fs.constants.O_RDWR));
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function preflightHost(
  request: AcceleratorRequest = 'auto',
  probe: HostProbe = systemProbe()
): HostTools {
  if (probe.platform !== 'linux')
    throw new UnsupportedEnvironmentError(
      'unsupported_os',
      `host OS "${probe.platform}" is not supported yet; only Linux hosts can run the local VM profile`
    );
  if (probe.arch !== 'x64')
    throw new UnsupportedEnvironmentError(
      'unsupported_arch',
      `host architecture "${probe.arch}" is not supported; the pinned profile image is x86_64`
    );
  const qemu = probe.which('qemu-system-x86_64');
  if (!qemu)
    throw new UnsupportedEnvironmentError(
      'qemu_missing',
      'qemu-system-x86_64 was not found on PATH; install QEMU (e.g. the qemu-system-x86 package)'
    );
  const qemuImg = probe.which('qemu-img');
  if (!qemuImg)
    throw new UnsupportedEnvironmentError(
      'qemu_img_missing',
      'qemu-img was not found on PATH; install the qemu-utils package'
    );
  const isoTool = ISO_TOOLS.map((tool) => probe.which(tool)).find(Boolean);
  if (!isoTool)
    throw new UnsupportedEnvironmentError(
      'iso_tool_missing',
      `none of ${ISO_TOOLS.join(', ')} was found on PATH; install genisoimage`
    );
  const kvm = probe.kvmUsable();
  if (request === 'kvm' && !kvm)
    throw new UnsupportedEnvironmentError(
      'kvm_unavailable',
      'KVM was requested but /dev/kvm is not usable by this user; request "auto" or "tcg"'
    );
  const accelerator: Accelerator = request === 'tcg' ? 'tcg' : kvm ? 'kvm' : 'tcg';
  return Object.freeze({ qemu, qemuImg, isoTool, accelerator });
}
