import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** LOCAL Linux controller storage. Persist directory entries before admission. */
export function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** A 0700 directory owned by this user, never reached through a symlink. */
export function privateDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== os.userInfo().uid)
    throw new Error(
      `Controller directory ${dir} is not private: it must be a real directory (not a symlink) owned by this user`
    );
  fs.chmodSync(dir, 0o700);
  return dir;
}

export function readPrivate(file: string): Buffer {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
      throw new Error('Controller storage unavailable');
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Caller owns the directory or its permanent kernel guard. Reuse only exact
 * existing evidence; publish a fully fsynced single-link file atomically. */
export function publishPrivate(file: string, bytes: Buffer): void {
  try {
    if (!readPrivate(file).equals(bytes)) throw new Error('Controller storage unavailable');
    const existing = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      fs.fsyncSync(existing);
    } finally {
      fs.closeSync(existing);
    }
    syncDirectory(path.dirname(file));
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  replacePrivate(file, bytes);
}

/** Atomic replacement under the caller's guard. Temporary basenames are fixed
 * length, independent of the final filename's component length. */
export function replacePrivate(file: string, bytes: Buffer): void {
  const tmp = path.join(path.dirname(file), `.zt-write-${randomUUID()}`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.renameSync(tmp, file);
  } finally {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
  }
  syncDirectory(path.dirname(file));
}
