import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Journal } from './journal';
import {
  isLockOwner,
  isLockRecovery,
  isTailRecovery,
  type LockOwner,
  type LockRecovery,
} from './recovery';

export class StoreLockedError extends Error {
  constructor() {
    super('Store owner unavailable or lock held');
    this.name = 'StoreLockedError';
  }
}

/** Linux-local identity includes the boot ID: start ticks alone repeat after reboot. */
export function processStartToken(pid: number): string | null {
  if (process.platform !== 'linux') throw new StoreLockedError();
  const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Missing proc entries alone may reflect restricted proc visibility. ESRCH
      // independently establishes absence; EPERM and every other error block.
      try {
        process.kill(pid, 0);
      } catch (signalError) {
        if ((signalError as NodeJS.ErrnoException).code === 'ESRCH') return null;
      }
    }
    throw new StoreLockedError();
  }
  // comm may contain spaces and parentheses; fields after its LAST ')' start at 3.
  const ticks = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/)[19];
  const token = `${boot}:${ticks}`;
  if (!/^[a-f0-9-]{36}:\d+$/.test(token)) throw new StoreLockedError();
  return token;
}

function privateFile(fd: number): void {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) throw new StoreLockedError();
}
export function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Called only with the store's permanent guard held. */
export function lockRecoveries(directory: string): LockRecovery[] {
  const journal = new Journal(directory);
  try {
    const result: LockRecovery[] = [];
    for (const event of journal.read()) {
      if (isLockRecovery(event)) result.push(event);
      else if (!isTailRecovery(event)) throw new StoreLockedError();
    }
    return result;
  } finally {
    journal.close();
  }
}
export function recordLockReclaim(
  directory: string,
  lock: string,
  owner: LockOwner,
  pendingReservations: string[]
): void {
  const prior = lockRecoveries(directory).find((event) => event.owner.id === owner.id);
  if (prior) {
    if (prior.lock !== path.basename(lock) || JSON.stringify(prior.owner) !== JSON.stringify(owner))
      throw new StoreLockedError();
    return;
  }
  const journal = new Journal(directory);
  try {
    journal.append({
      v: 1,
      type: 'lock_reclaimed',
      lock: path.basename(lock),
      owner,
      at: new Date().toISOString(),
      pendingReservations,
    });
  } finally {
    journal.close();
  }
}

/** The permanent guard must NEVER be unlinked. Kernel flock protects the entire
 * transaction, including dead-owner proof, audit, unlink and lock publication.
 * flock(1) receives the SAME open file description on fd 3; after it exits the
 * parent holds the kernel lock until close. SIGKILL releases it automatically.
 * LOCAL Linux filesystem + util-linux flock required; failures deny admission. */
export function withStoreLock<T>(
  file: string,
  timeoutMs: number,
  reclaim: (owner: LockOwner) => void,
  work: () => T,
  retainOnError: (error: unknown) => boolean = () => false
): T {
  const guard = fs.openSync(
    `${file}.guard`,
    fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    0o600
  );
  let fd: number | undefined;
  let retain = false;
  let published = false;
  try {
    privateFile(guard);
    const result = spawnSync('/usr/bin/flock', ['-x', '-w', String(timeoutMs / 1000), '3'], {
      stdio: ['ignore', 'ignore', 'ignore', guard],
      timeout: timeoutMs + 1000,
    });
    if (result.error || result.status !== 0) throw new StoreLockedError();
    const opened = fs.fstatSync(guard);
    const named = fs.lstatSync(`${file}.guard`);
    if (opened.ino !== named.ino || opened.dev !== named.dev) throw new StoreLockedError();
    let ownerFd: number | undefined;
    try {
      ownerFd = fs.openSync(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
      );
      privateFile(ownerFd);
      if (fs.fstatSync(ownerFd).size > 4096) throw new StoreLockedError();
      const owner: unknown = JSON.parse(fs.readFileSync(ownerFd, 'utf8'));
      if (!isLockOwner(owner)) throw new StoreLockedError();
      const token = processStartToken(owner.pid);
      if (token === owner.startToken) throw new StoreLockedError();
      reclaim(owner); // Must fsync its audit before removing the old lock.
      fs.unlinkSync(file);
      syncDirectory(path.dirname(file));
    } catch (error) {
      if (ownerFd !== undefined || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    } finally {
      if (ownerFd !== undefined) fs.closeSync(ownerFd);
    }
    const startToken = processStartToken(process.pid);
    if (!startToken) throw new StoreLockedError();
    const owner: LockOwner = {
      pid: process.pid,
      startToken,
      createdAt: new Date().toISOString(),
      id: randomUUID(),
    };
    // Publish only a fully fsynced owner record. A crash never leaves an empty
    // lock whose missing identity would prevent automatic recovery forever.
    const tmp = `${file}.owner-${owner.id}`;
    fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`);
      fs.fsyncSync(fd);
      fs.linkSync(tmp, file);
      published = true;
    } finally {
      fs.unlinkSync(tmp);
    }
    syncDirectory(path.dirname(file));
    try {
      return work();
    } catch (error) {
      retain = retainOnError(error);
      throw error;
    }
  } finally {
    try {
      if (fd !== undefined) {
        fs.closeSync(fd);
        if (published && !retain) {
          // A failed owner publication may not have created the named lock.
          fs.rmSync(file, { force: true });
          syncDirectory(path.dirname(file));
        }
      }
    } finally {
      fs.closeSync(guard);
    }
  }
}
