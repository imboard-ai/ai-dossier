import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { privateDir, readPrivate } from '../durable-fs';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-durable-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('privateDir', () => {
  it('creates missing parents and returns the directory with mode 0700', () => {
    const target = path.join(dir, 'a', 'b');
    expect(privateDir(target)).toBe(target);
    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(fs.statSync(target).mode & 0o777).toBe(0o700);
  });

  it('tightens an existing group- or world-accessible directory to 0700', () => {
    const target = path.join(dir, 'open');
    fs.mkdirSync(target, { mode: 0o755 });
    fs.chmodSync(target, 0o777);
    privateDir(target);
    expect(fs.statSync(target).mode & 0o777).toBe(0o700);
  });

  it('refuses a directory reached through a symlink and leaves its target alone', () => {
    const real = path.join(dir, 'real');
    fs.mkdirSync(real, { mode: 0o755 });
    fs.chmodSync(real, 0o755);
    const link = path.join(dir, 'link');
    fs.symlinkSync(real, link);
    expect(() => privateDir(link)).toThrow(/is not private/);
    expect(fs.statSync(real).mode & 0o777).toBe(0o755);
  });

  it('refuses a path that is a regular file', () => {
    const file = path.join(dir, 'file');
    fs.writeFileSync(file, '');
    expect(() => privateDir(file)).toThrow();
  });
});

describe('readPrivate', () => {
  it('reads a 0600 single-link file', () => {
    const file = path.join(dir, 'ok');
    fs.writeFileSync(file, 'data', { mode: 0o600 });
    expect(readPrivate(file).toString()).toBe('data');
  });

  it.each([0o640, 0o604, 0o644])('refuses mode %s', (mode) => {
    const file = path.join(dir, 'open');
    fs.writeFileSync(file, 'data');
    fs.chmodSync(file, mode);
    expect(() => readPrivate(file)).toThrow('Controller storage unavailable');
  });

  it('refuses a hard-linked file and a symlink', () => {
    const file = path.join(dir, 'f');
    fs.writeFileSync(file, 'data', { mode: 0o600 });
    fs.linkSync(file, path.join(dir, 'hard'));
    expect(() => readPrivate(file)).toThrow('Controller storage unavailable');
    const target = path.join(dir, 't');
    fs.writeFileSync(target, 'data', { mode: 0o600 });
    fs.symlinkSync(target, path.join(dir, 'sym'));
    expect(() => readPrivate(path.join(dir, 'sym'))).toThrow(/ELOOP|EMLINK/);
  });
});
