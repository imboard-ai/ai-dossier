import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { replacePrivate, syncDirectory } from './durable-fs';
import { Journal } from './journal';
import {
  isLockOwner,
  isLockRecovery,
  isProcessStartToken,
  isTailRecovery,
  type LockOwner,
  type LockRecovery,
} from './recovery';
import { parseStrictUtf8Json } from './strict-utf8';

export class StoreLockedError extends Error {
  constructor() {
    super('Store owner unavailable or lock held');
    this.name = 'StoreLockedError';
  }
}
export class StorePersistenceError extends Error {
  constructor() {
    super('Store finalization uncertain; stop owner and reconcile before reopening');
    this.name = 'StorePersistenceError';
  }
}

/** Acquire on the inherited open description; caller owns inode checks and lifetime. */
export function lockDescriptor(fd: number, timeoutMs: number): void {
  const result = spawnSync('/usr/bin/flock', ['-x', '-w', String(timeoutMs / 1000), '3'], {
    stdio: ['ignore', 'ignore', 'ignore', fd],
    timeout: timeoutMs + 1000,
  });
  if (result.error || result.status !== 0) throw new StoreLockedError();
}

/** Shared private permanent-inode acquisition. Caller owns the returned fd;
 * each protocol selects its own guard path, creation policy and wait bound. */
export function acquirePrivateGuard(file: string, create: boolean, timeoutMs: number): number {
  if (process.platform !== 'linux') throw new StoreLockedError();
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      file,
      (create ? fs.constants.O_CREAT : 0) |
        fs.constants.O_RDWR |
        fs.constants.O_NOFOLLOW |
        fs.constants.O_NONBLOCK,
      0o600
    );
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600
    )
      throw new StoreLockedError();
    lockDescriptor(fd, timeoutMs);
    const named = fs.lstatSync(file);
    if (named.dev !== stat.dev || named.ino !== stat.ino) throw new StoreLockedError();
    fs.fsyncSync(fd);
    syncDirectory(path.dirname(file));
    return fd;
  } catch {
    if (fd !== undefined) fs.closeSync(fd);
    throw new StoreLockedError();
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
      // establishes absence only in the SAME recorded PID namespace. EPERM and
      // every other error block. A foreign namespace must never prove death.
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
  if (!isProcessStartToken(token)) throw new StoreLockedError();
  return token;
}

function privateFile(fd: number): void {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) throw new StoreLockedError();
}

/** Reporting acquires only an existing guard, never publishes/reclaims an owner.
 * An unresolved owner (live or dead) denies facts until mutation recovery completes. */
export function withReadOnlyStoreLock<T>(file: string, work: () => T): T {
  const guard = fs.openSync(
    `${file}.guard`,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    privateFile(guard);
    if (fs.fstatSync(guard).uid !== process.getuid?.()) throw new StoreLockedError();
    lockDescriptor(guard, 0);
    const opened = fs.fstatSync(guard);
    const named = fs.lstatSync(`${file}.guard`);
    if (opened.ino !== named.ino || opened.dev !== named.dev) throw new StoreLockedError();
    try {
      fs.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return work();
      throw error;
    }
    throw new StorePersistenceError();
  } finally {
    fs.closeSync(guard);
  }
}

/** Called only with the store's permanent guard held. */
export function lockRecoveries(directory: string): LockRecovery[] {
  const exists = fs.existsSync(directory);
  if (!exists || !fs.existsSync(path.join(directory, 'events.jsonl'))) throw new StoreLockedError();
  const journal = new Journal(directory);
  try {
    const result: LockRecovery[] = [];
    for (const event of journal.read()) {
      if (isLockRecovery(event)) result.push(event);
      else if (!isTailRecovery(event)) throw new StoreLockedError();
    }
    if (result.length === 0) throw new StoreLockedError();
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
  const exists = fs.existsSync(directory);
  const prior = exists
    ? lockRecoveries(directory).find((event) => event.owner.id === owner.id)
    : undefined;
  if (prior) {
    if (prior.lock !== path.basename(lock) || JSON.stringify(prior.owner) !== JSON.stringify(owner))
      throw new StoreLockedError();
    return;
  }
  // A first audit is published as a COMPLETE directory. Crash debris stays in
  // an unpublished unique staging directory, never masquerading as lost history.
  const staging = exists
    ? directory
    : path.join(path.dirname(directory), `.zt-audit-${randomUUID()}`);
  const journal = new Journal(staging);
  try {
    const event: LockRecovery = {
      v: 1,
      type: 'lock_reclaimed',
      lock: path.basename(lock),
      owner,
      at: new Date().toISOString(),
      pendingReservations,
    };
    if (!isLockRecovery(event)) throw new StoreLockedError();
    journal.append(event);
  } finally {
    journal.close();
  }
  if (!exists) {
    syncDirectory(staging);
    fs.renameSync(staging, directory);
  }
  syncDirectory(path.dirname(directory));
}

function pidNamespace(): string {
  const namespace = fs.readlinkSync('/proc/self/ns/pid');
  const self = fs.readFileSync('/proc/self/stat', 'utf8');
  if (!/^pid:\[\d+\]$/.test(namespace) || Number(self.slice(0, self.indexOf(' '))) !== process.pid)
    throw new StoreLockedError();
  return namespace;
}

function publishOwner(file: string, owner: LockOwner): void {
  replacePrivate(file, Buffer.from(`${JSON.stringify(owner)}\n`));
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
  let retain = false;
  let published = false;
  let keepGuard = false;
  let owner: LockOwner | undefined;
  try {
    privateFile(guard);
    lockDescriptor(guard, timeoutMs);
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
      const owner = parseStrictUtf8Json(fs.readFileSync(ownerFd));
      if (!isLockOwner(owner)) throw new StoreLockedError();
      if (owner.pidNamespace !== pidNamespace()) throw new StoreLockedError();
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
    owner = {
      pid: process.pid,
      startToken,
      createdAt: new Date().toISOString(),
      id: randomUUID(),
      pidNamespace: pidNamespace(),
    };
    // Publish only a fully fsynced owner record. A crash never leaves an empty
    // lock whose missing identity would prevent automatic recovery forever.
    publishOwner(file, owner);
    published = true;
    try {
      return work();
    } catch (error) {
      retain = retainOnError(error);
      throw error;
    }
  } finally {
    try {
      if (published && !retain && owner) {
        try {
          fs.rmSync(file, { force: true });
          syncDirectory(path.dirname(file));
        } catch {
          // Work may already have committed. Restore the SAME live owner while
          // still holding the guard. If storage will not persist the fence, keep
          // the kernel guard open until process death, denying every contender.
          try {
            publishOwner(file, owner);
          } catch {
            keepGuard = true;
          }
          // biome-ignore lint/correctness/noUnsafeFinally: Failed durable finalization MUST override a successful authorization return.
          throw new StorePersistenceError();
        }
      }
    } finally {
      if (!keepGuard) fs.closeSync(guard);
    }
  }
}
