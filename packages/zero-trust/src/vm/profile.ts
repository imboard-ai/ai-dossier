/** Pinned execution-profile inputs and the baked-profile manifest. Changing any
 * pin changes the profile digest, which invalidates cached images and receipts. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { canonicalJson } from '../receipt/schema';
import { UnsupportedEnvironmentError } from './adapter';

export const PROFILE_PINS = Object.freeze({
  schema: 'zt-vm-profile-v1',
  baseImage: Object.freeze({
    name: 'ubuntu-24.04-server-cloudimg-amd64',
    release: '20260926',
    url: 'https://cloud-images.ubuntu.com/releases/noble/release-20260926/ubuntu-24.04-server-cloudimg-amd64.img',
    sha256: '6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2',
  }),
  /** Multi-arch index digest of mcr.microsoft.com/devcontainers/base:ubuntu24.04. */
  containerBase: Object.freeze({
    image: 'mcr.microsoft.com/devcontainers/base',
    tag: 'ubuntu24.04',
    digest: 'sha256:d7c468679f45a52ad3673d06656b5bf16e488990b17216a1fa295d9e1f89d724',
  }),
  containerProfiles: Object.freeze({
    node: Object.freeze(['nodejs', 'npm']),
    python: Object.freeze(['python3', 'python3-pip', 'python3-venv', 'python3-setuptools']),
  }),
});

/** Bumped whenever cloud-init, the guest agent or the hardening changes. */
export const BAKE_RECIPE_VERSION = 1;

/** Virtual size of the baked disk. A run overlay may not be smaller: the guest
 * kernel rejects a GPT whose partitions end past the disk and cannot find root. */
export const BAKED_DISK_GIB = 16;

export interface VmProfileManifest {
  readonly schema: 'zt-vm-profile-v1';
  /** Digest over pins + recipe version + guest agent source. */
  readonly profileDigest: string;
  readonly baseImageSha256: string;
  readonly containerBaseDigest: string;
  /** SHA-256 of the flattened, baked qcow2 that run overlays are built on. */
  readonly imageSha256: string;
  readonly imageFile: string;
  readonly containerImages: Readonly<Record<'node' | 'python', string>>;
  readonly bakedAt: string;
}

export function sha256File(file: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(4 * 1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function profileDigest(agentSource: string): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        pins: PROFILE_PINS,
        recipe: BAKE_RECIPE_VERSION,
        agent: createHash('sha256').update(agentSource).digest('hex'),
      })
    )
    .digest('hex');
}

const HEX64 = /^[a-f0-9]{64}$/;
const DOCKER_ID = /^sha256:[a-f0-9]{64}$/;

export function parseManifest(value: unknown, expectedDigest: string): VmProfileManifest {
  const m = value as VmProfileManifest;
  if (
    typeof value !== 'object' ||
    value === null ||
    m.schema !== 'zt-vm-profile-v1' ||
    m.profileDigest !== expectedDigest ||
    m.baseImageSha256 !== PROFILE_PINS.baseImage.sha256 ||
    m.containerBaseDigest !== PROFILE_PINS.containerBase.digest ||
    !HEX64.test(m.imageSha256 ?? '') ||
    typeof m.imageFile !== 'string' ||
    !/^[A-Za-z0-9._-]+$/.test(m.imageFile) ||
    !DOCKER_ID.test(m.containerImages?.node ?? '') ||
    !DOCKER_ID.test(m.containerImages?.python ?? '')
  )
    throw new UnsupportedEnvironmentError(
      'profile_image_mismatch',
      'the baked profile manifest does not match the pinned profile; re-run the bake'
    );
  return m;
}
