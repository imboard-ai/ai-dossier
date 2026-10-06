/** Pinned execution-profile inputs and the baked-profile manifest. Changing any
 * pin changes the profile digest, which invalidates cached images and receipts. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { sha256 } from '../canonical/export';
import { PROFILE_MANIFEST } from '../ecosystem/profiles';
import { canonicalJson } from '../receipt/schema';
import { type ContainerProfile, UnsupportedEnvironmentError } from './adapter';

export interface WorkerPin {
  /** The `profiles.json` profile this worker image is built from. */
  readonly profileId: string;
  readonly runtimeVersion: string;
  readonly image: string;
  readonly digest: string;
}

const WORKER_HARDENING = (() => {
  const hardening = PROFILE_MANIFEST.workerHardening;
  if (!hardening) throw new Error('profiles.json has no workerHardening section');
  return hardening;
})();

function workerPin(ecosystem: ContainerProfile): WorkerPin {
  const profile = PROFILE_MANIFEST.profiles.find(
    (p) => p.ecosystem === ecosystem && WORKER_HARDENING.vmProfiles.includes(p.id)
  );
  if (!profile) throw new Error(`profiles.json names no VM profile for ${ecosystem}`);
  return Object.freeze({
    profileId: profile.id,
    runtimeVersion: profile.runtimeVersion,
    image: profile.image,
    digest: profile.imageDigest,
  });
}

export const PROFILE_PINS = Object.freeze({
  schema: 'zt-vm-profile-v1',
  baseImage: Object.freeze({
    name: 'ubuntu-24.04-server-cloudimg-amd64',
    release: '20260926',
    url: 'https://cloud-images.ubuntu.com/releases/noble/release-20260926/ubuntu-24.04-server-cloudimg-amd64.img',
    sha256: '6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2',
  }),
  /** Worker images derive from the ecosystem profile images (`profiles.json`), by
   * digest, with the manifest's hardening recipe; uv comes from its own pinned image. */
  hardening: Object.freeze({
    recipe: WORKER_HARDENING.recipe,
    uv: Object.freeze({ ...WORKER_HARDENING.uv }),
  }),
  containerProfiles: Object.freeze({
    node: workerPin('node'),
    python: workerPin('python'),
  }),
});

/** Bumped whenever cloud-init, the guest agent or the hardening changes. */
export const BAKE_RECIPE_VERSION = 3;

/** Virtual size of the baked disk. A run overlay may not be smaller: the guest
 * kernel rejects a GPT whose partitions end past the disk and cannot find root. */
export const BAKED_DISK_GIB = 16;

export interface VmProfileManifest {
  readonly schema: 'zt-vm-profile-v1';
  /** Digest over pins + recipe version + guest agent source. */
  readonly profileDigest: string;
  readonly baseImageSha256: string;
  /** The `profiles.json` profile each worker image was built from. */
  readonly workerProfiles: Readonly<Record<ContainerProfile, string>>;
  /** SHA-256 of the flattened, baked qcow2 that run overlays are built on. */
  readonly imageSha256: string;
  readonly imageFile: string;
  readonly containerImages: Readonly<Record<ContainerProfile, string>>;
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
  return sha256(
    canonicalJson({ pins: PROFILE_PINS, recipe: BAKE_RECIPE_VERSION, agent: sha256(agentSource) })
  );
}

const QCOW2_MAGIC = 0x514649fb;
/** qcow2 v3 incompatible-feature bit for an external data file. */
const QCOW2_EXTERNAL_DATA_FILE = 4n;

/** The baked image must not reference another file. A qcow2 header can name a
 * backing file or an external data file, and QEMU would open either with the
 * controller's privileges, so a swapped image could expose host files as disk. */
export function assertStandaloneQcow2(file: string): void {
  const header = Buffer.alloc(80);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let read: number;
  try {
    read = fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const version = read >= 72 ? header.readUInt32BE(4) : 0;
  const standalone =
    read >= 72 &&
    header.readUInt32BE(0) === QCOW2_MAGIC &&
    (version === 2 || version === 3) &&
    header.readBigUInt64BE(8) === 0n &&
    (version === 2 ||
      (read >= 80 && (header.readBigUInt64BE(72) & QCOW2_EXTERNAL_DATA_FILE) === 0n));
  if (!standalone)
    throw new UnsupportedEnvironmentError(
      'profile_image_mismatch',
      'the baked profile image is not a standalone qcow2 (it names a backing or data file)'
    );
}

const HEX64 = /^[a-f0-9]{64}$/;
export const DOCKER_ID = /^sha256:[a-f0-9]{64}$/;

export function parseManifest(value: unknown, expectedDigest: string): VmProfileManifest {
  const m = value as VmProfileManifest;
  if (
    typeof value !== 'object' ||
    value === null ||
    m.schema !== 'zt-vm-profile-v1' ||
    m.profileDigest !== expectedDigest ||
    m.baseImageSha256 !== PROFILE_PINS.baseImage.sha256 ||
    m.workerProfiles?.node !== PROFILE_PINS.containerProfiles.node.profileId ||
    m.workerProfiles?.python !== PROFILE_PINS.containerProfiles.python.profileId ||
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

/** A run may only use a profile whose worker image this VM profile carries; any other
 * selection is `unsupported_environment`, never a substitute image. */
export function assertProfileBaked(ecosystem: ContainerProfile, profileId: string): void {
  if (PROFILE_PINS.containerProfiles[ecosystem].profileId !== profileId)
    throw new UnsupportedEnvironmentError(
      'profile_not_baked',
      `the VM profile carries ${PROFILE_PINS.containerProfiles[ecosystem].profileId} for ${ecosystem}, not ${profileId}`
    );
}
