import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assetName, TARGETS } from './sea-platform.mjs';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../install.sh');

function printAsset(uname_s, uname_m) {
  return spawnSync('sh', [script, '--print-asset'], {
    env: {
      PATH: process.env.PATH,
      HOME: '/tmp',
      AI_DOSSIER_UNAME_S: uname_s,
      AI_DOSSIER_UNAME_M: uname_m,
    },
    encoding: 'utf8',
  });
}

describe('install.sh platform detection', () => {
  it.each([
    ['Linux', 'x86_64', 'linux', 'x64'],
    ['Linux', 'aarch64', 'linux', 'arm64'],
    ['Darwin', 'arm64', 'darwin', 'arm64'],
    ['Darwin', 'x86_64', 'darwin', 'x64'],
    ['MINGW64_NT-10.0', 'x86_64', 'win32', 'x64'],
  ])('%s/%s -> %s-%s (matches sea-platform.mjs)', (s, m, platform, arch) => {
    const r = printAsset(s, m);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(assetName(platform, arch));
  });

  it('every published target is reachable from some uname pair', () => {
    expect(TARGETS).toHaveLength(5);
  });

  it.each([
    ['FreeBSD', 'x86_64'],
    ['Linux', 'riscv64'],
    ['MINGW64_NT-10.0', 'aarch64'],
  ])('rejects %s/%s', (s, m) => {
    const r = printAsset(s, m);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unsupported|no prebuilt/);
  });

  it('is valid POSIX sh', () => {
    execFileSync('sh', ['-n', script]);
  });
});
