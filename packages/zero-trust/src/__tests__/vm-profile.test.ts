import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReasonCode } from '../state';
import {
  BrokerError,
  DEFAULT_LIMITS,
  UnsupportedEnvironmentError,
  VmCleanupError,
} from '../vm/adapter';
import {
  BAKE_FAILED_MARKER,
  BAKE_RESULT_MARKER,
  bakeMetaData,
  bakeUserData,
} from '../vm/cloud-init';
import {
  assertStandaloneQcow2,
  DOCKER_ID,
  PROFILE_PINS,
  parseManifest,
  profileDigest,
  sha256File,
  type VmProfileManifest,
} from '../vm/profile';

const AGENT = 'print("zt agent")\n';
const DIGEST = profileDigest(AGENT);
const IMAGE_ID = `sha256:${'1'.repeat(64)}`;

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const valid: VmProfileManifest = {
    schema: 'zt-vm-profile-v1',
    profileDigest: DIGEST,
    baseImageSha256: PROFILE_PINS.baseImage.sha256,
    containerBaseDigest: PROFILE_PINS.containerBase.digest,
    imageSha256: 'f'.repeat(64),
    imageFile: 'profile-v1.qcow2',
    containerImages: { node: IMAGE_ID, python: `sha256:${'2'.repeat(64)}` },
    bakedAt: '2026-10-06T00:00:00.000Z',
  };
  return { ...valid, ...overrides };
}

function mismatch(value: unknown): UnsupportedEnvironmentError {
  try {
    parseManifest(value, DIGEST);
  } catch (error) {
    expect(error).toBeInstanceOf(UnsupportedEnvironmentError);
    return error as UnsupportedEnvironmentError;
  }
  throw new Error('expected manifest refusal');
}

describe('parseManifest', () => {
  it('accepts a valid manifest', () => {
    const value = manifest();
    expect(parseManifest(value, DIGEST)).toBe(value);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['string', 'manifest'],
    ['number', 7],
  ])('rejects a non-object (%s)', (_label, value) => {
    expect(mismatch(value).detail).toBe('profile_image_mismatch');
  });

  it.each<[string, Record<string, unknown>]>([
    ['schema', { schema: 'zt-vm-profile-v2' }],
    ['profileDigest', { profileDigest: profileDigest('other agent') }],
    ['baseImageSha256', { baseImageSha256: '0'.repeat(64) }],
    ['containerBaseDigest', { containerBaseDigest: `sha256:${'0'.repeat(64)}` }],
    ['imageSha256 short', { imageSha256: 'f'.repeat(63) }],
    ['imageSha256 upper', { imageSha256: 'F'.repeat(64) }],
    ['imageSha256 missing', { imageSha256: undefined }],
    ['imageFile non-string', { imageFile: 42 }],
    ['imageFile traversal', { imageFile: '../profile.qcow2' }],
    ['imageFile slash', { imageFile: 'dir/profile.qcow2' }],
    ['imageFile empty', { imageFile: '' }],
    ['containerImages missing', { containerImages: undefined }],
    ['node image', { containerImages: { node: 'zt-node:profile', python: IMAGE_ID } }],
    ['python image', { containerImages: { node: IMAGE_ID, python: `sha256:${'g'.repeat(64)}` } }],
    ['python missing', { containerImages: { node: IMAGE_ID } }],
  ])('rejects a corrupted %s', (_label, overrides) => {
    const error = mismatch(manifest(overrides));
    expect(error.detail).toBe('profile_image_mismatch');
    expect(error.reasonCode).toBe(ReasonCode.UnsupportedEnvironment);
  });
});

describe('profileDigest', () => {
  it('is stable for the same agent and changes with agent source', () => {
    expect(profileDigest(AGENT)).toBe(DIGEST);
    expect(DIGEST).toMatch(/^[a-f0-9]{64}$/);
    expect(profileDigest(`${AGENT} `)).not.toBe(DIGEST);
  });

  it('pins are frozen', () => {
    expect(Object.isFrozen(PROFILE_PINS)).toBe(true);
    expect(Object.isFrozen(PROFILE_PINS.baseImage)).toBe(true);
    expect(Object.isFrozen(PROFILE_PINS.containerProfiles.node)).toBe(true);
  });
});

describe('sha256File', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-profile-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('hashes a file, including one larger than the read buffer', () => {
    const small = path.join(dir, 'small');
    fs.writeFileSync(small, 'hello');
    expect(sha256File(small)).toBe(createHash('sha256').update('hello').digest('hex'));
    const empty = path.join(dir, 'empty');
    fs.writeFileSync(empty, '');
    expect(sha256File(empty)).toBe(createHash('sha256').digest('hex'));
    const big = Buffer.alloc(4 * 1024 * 1024 + 123, 7);
    const bigFile = path.join(dir, 'big');
    fs.writeFileSync(bigFile, big);
    expect(sha256File(bigFile)).toBe(createHash('sha256').update(big).digest('hex'));
  });

  it('refuses to follow a symlink', () => {
    const target = path.join(dir, 'target');
    fs.writeFileSync(target, 'data');
    const link = path.join(dir, 'link');
    fs.symlinkSync(target, link);
    expect(() => sha256File(link)).toThrow(/ELOOP|EMLINK/);
  });

  it('throws for a missing file', () => {
    expect(() => sha256File(path.join(dir, 'missing'))).toThrow(/ENOENT/);
  });
});

describe('cloud-init', () => {
  const userData = bakeUserData(AGENT);

  function writeFiles(): Map<string, { mode: string; content: string }> {
    const files = new Map<string, { mode: string; content: string }>();
    const re =
      /^ {2}- path: (\S+)\n {4}permissions: '(\d{4})'\n {4}encoding: b64\n {4}content: (\S+)$/gm;
    for (const m of userData.matchAll(re))
      files.set(m[1], { mode: m[2], content: Buffer.from(m[3], 'base64').toString('utf8') });
    return files;
  }

  it('is a cloud-config with no users, passwords or SSH', () => {
    const lines = userData.split('\n');
    expect(lines[0]).toBe('#cloud-config');
    expect(lines).toContain('users: []');
    expect(lines).toContain('ssh_pwauth: false');
    expect(lines).toContain('disable_root: true');
    expect(userData).not.toMatch(/ssh_authorized_keys|passwd:|plain_text_passwd/);
    expect(userData).toContain('runcmd:\n  - [/usr/local/lib/zt/bake.sh]');
  });

  it('writes the guest agent base64-encoded with mode 0700', () => {
    const agent = writeFiles().get('/usr/local/lib/zt/agent.py');
    expect(agent).toEqual({ mode: '0700', content: AGENT });
    expect(userData).toContain(Buffer.from(AGENT).toString('base64'));
    // Agent text never appears raw, so it cannot inject YAML.
    expect(bakeUserData('evil: [\n')).not.toContain('evil: [');
  });

  it('writes all expected files', () => {
    expect([...writeFiles().keys()]).toEqual([
      '/usr/local/lib/zt/agent.py',
      '/etc/systemd/system/zt-agent.service',
      '/etc/modules-load.d/zt-dmi-sysfs.conf',
      '/var/lib/zt/build/node/Dockerfile',
      '/var/lib/zt/build/python/Dockerfile',
      '/usr/local/lib/zt/bake.sh',
    ]);
    expect(writeFiles().get('/etc/modules-load.d/zt-dmi-sysfs.conf')?.content).toBe('dmi_sysfs\n');
  });

  it.each([
    ['node', PROFILE_PINS.containerProfiles.node],
    ['python', PROFILE_PINS.containerProfiles.python],
  ] as const)('%s Dockerfile is pinned by digest, purges sudo and strips setuid', (name, pkgs) => {
    const dockerfile = writeFiles().get(`/var/lib/zt/build/${name}/Dockerfile`)?.content ?? '';
    expect(dockerfile.split('\n')[0]).toBe(
      `FROM ${PROFILE_PINS.containerBase.image}@${PROFILE_PINS.containerBase.digest}`
    );
    expect(dockerfile).toContain(pkgs.join(' '));
    expect(dockerfile).toContain('apt-get purge -y sudo');
    expect(dockerfile).toContain('rm -rf /etc/sudoers /etc/sudoers.d');
    expect(dockerfile).toContain('-perm /6000 -exec chmod ug-s {} +');
    expect(dockerfile).toContain('USER 1000:1000');
    expect(dockerfile).not.toContain(`:${PROFILE_PINS.containerBase.tag}`);
    expect(dockerfile.match(/^FROM /gm)).toHaveLength(1);
  });

  it('bake script reports result/failed markers and disables ssh', () => {
    const script = writeFiles().get('/usr/local/lib/zt/bake.sh')?.content ?? '';
    expect(script.startsWith('#!/bin/bash\nset -euo pipefail\n')).toBe(true);
    expect(script).toContain(BAKE_FAILED_MARKER);
    expect(script).toContain(BAKE_RESULT_MARKER);
    expect(script).toContain('systemctl mask ssh.socket ssh.service');
    expect(script).toContain('passwd -l root');
    expect(script).toContain('touch /etc/cloud/cloud-init.disabled');
  });

  it('bakeMetaData sets the instance id', () => {
    expect(bakeMetaData('zt-bake-123')).toBe('instance-id: zt-bake-123\nlocal-hostname: zt-bake\n');
  });
});

describe('adapter errors', () => {
  it('UnsupportedEnvironmentError carries detail and reason code', () => {
    const error = new UnsupportedEnvironmentError('kill_switch_engaged', 'operator stop');
    expect(error.name).toBe('UnsupportedEnvironmentError');
    expect(error.detail).toBe('kill_switch_engaged');
    expect(error.reasonCode).toBe(ReasonCode.UnsupportedEnvironment);
    expect(error.message).toBe(
      'Execution profile refused (unsupported_environment/kill_switch_engaged): operator stop'
    );
    expect(error).toBeInstanceOf(Error);
  });

  it('VmCleanupError carries leftovers', () => {
    const error = new VmCleanupError([1, 2], ['/a']);
    expect(error.name).toBe('VmCleanupError');
    expect(error.message).toBe(
      'VM teardown incomplete: 2 process(es) [1, 2], 1 path(s) [/a] left behind'
    );
    expect(new VmCleanupError([], []).message).toBe(
      'VM teardown incomplete: 0 process(es) [], 0 path(s) [] left behind'
    );
    expect(error.leftoverPids).toEqual([1, 2]);
    expect(error.leftoverPaths).toEqual(['/a']);
  });

  it('BrokerError carries its code', () => {
    const error = new BrokerError('invalid_path');
    expect(error.name).toBe('BrokerError');
    expect(error.code).toBe('invalid_path');
    expect(error.message).toBe('Worker broker rejected: invalid_path');
  });

  it('DEFAULT_LIMITS match PRD defaults and are frozen', () => {
    expect(DEFAULT_LIMITS).toEqual({
      vcpus: 4,
      memoryMiB: 8192,
      diskGiB: 20,
      commandTimeoutMs: 1_200_000,
    });
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
  });
});

describe('assertStandaloneQcow2', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-qcow2-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function image(
    over: { magic?: number; version?: number; backing?: bigint; incompatible?: bigint } = {},
    length = 104
  ): string {
    const header = Buffer.alloc(length);
    const full = Buffer.alloc(Math.max(length, 104));
    full.writeUInt32BE(over.magic ?? 0x514649fb, 0);
    full.writeUInt32BE(over.version ?? 3, 4);
    full.writeBigUInt64BE(over.backing ?? 0n, 8);
    full.writeBigUInt64BE(over.incompatible ?? 0n, 72);
    full.copy(header, 0, 0, length);
    const file = path.join(dir, `img-${Math.random().toString(16).slice(2)}.qcow2`);
    fs.writeFileSync(file, header);
    return file;
  }

  function detail(file: string): string | undefined {
    try {
      assertStandaloneQcow2(file);
      return undefined;
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedEnvironmentError);
      return (error as UnsupportedEnvironmentError).detail;
    }
  }

  it('accepts a standalone v2 or v3 image', () => {
    expect(detail(image({ version: 3 }))).toBeUndefined();
    expect(detail(image({ version: 2 }))).toBeUndefined();
    // v2 has no incompatible-features field; bytes there are not interpreted.
    expect(detail(image({ version: 2, incompatible: 4n }))).toBeUndefined();
    expect(detail(image({ version: 2 }, 72))).toBeUndefined();
    // v3 tolerates incompatible-feature bits other than the external data file.
    expect(detail(image({ version: 3, incompatible: 1n }))).toBeUndefined();
  });

  it('refuses an image that names a backing file', () => {
    expect(detail(image({ backing: 0x1000n }))).toBe('profile_image_mismatch');
    expect(detail(image({ version: 2, backing: 1n }))).toBe('profile_image_mismatch');
  });

  it('refuses a v3 image with an external data file', () => {
    expect(detail(image({ incompatible: 4n }))).toBe('profile_image_mismatch');
    expect(detail(image({ incompatible: 0x7n }))).toBe('profile_image_mismatch');
  });

  it('refuses a bad magic or an unknown version', () => {
    expect(detail(image({ magic: 0x7f454c46 }))).toBe('profile_image_mismatch');
    expect(detail(image({ version: 1 }))).toBe('profile_image_mismatch');
    expect(detail(image({ version: 4 }))).toBe('profile_image_mismatch');
  });

  it('refuses a short file', () => {
    expect(detail(image({}, 0))).toBe('profile_image_mismatch');
    expect(detail(image({ version: 2 }, 71))).toBe('profile_image_mismatch');
    // v3 needs the incompatible-features field at offset 72.
    expect(detail(image({ version: 3 }, 76))).toBe('profile_image_mismatch');
  });

  it('refuses to follow a symlink and throws for a missing file', () => {
    const link = path.join(dir, 'link');
    fs.symlinkSync(image(), link);
    expect(() => assertStandaloneQcow2(link)).toThrow(/ELOOP|EMLINK/);
    expect(() => assertStandaloneQcow2(path.join(dir, 'missing'))).toThrow(/ENOENT/);
  });
});

describe('DOCKER_ID', () => {
  it('matches only sha256 image IDs', () => {
    expect(DOCKER_ID.test(IMAGE_ID)).toBe(true);
    expect(DOCKER_ID.test('1'.repeat(64))).toBe(false);
    expect(DOCKER_ID.test(`sha256:${'A'.repeat(64)}`)).toBe(false);
  });
});
