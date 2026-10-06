/** Durable controller-owned JSONL. Corruption and uncertain writes fail closed. */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import * as path from 'node:path';
import { assertDirectoryAncestors, publishPrivate, readPrivate, syncDirectory } from './durable-fs';
import { isTailRecovery, type TailRecovery } from './recovery';

const openPaths = new Set<string>();

export class JournalError extends Error {
  constructor() {
    super('Zero-trust journal unavailable or corrupt');
    this.name = 'JournalError';
  }
}

/** One trusted controller owns a journal directory; never place it in worker storage. */
export class Journal {
  readonly filePath: string;
  private fd: number;
  private poisoned = false;
  private size = 0;

  constructor(directory: string) {
    this.filePath = path.join(path.resolve(directory), 'events.jsonl');
    if (openPaths.has(this.filePath)) throw new JournalError();
    let fd: number | undefined;
    try {
      const dir = path.dirname(this.filePath);
      // Check every existing ancestor before recursive creation (no symlink traversal).
      assertDirectoryAncestors(dir);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      fd = fs.openSync(
        this.filePath,
        fs.constants.O_CREAT |
          fs.constants.O_APPEND |
          fs.constants.O_RDWR |
          fs.constants.O_NOFOLLOW,
        0o600
      );
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new JournalError();
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
      // Persist the file's directory entry, including newly created ancestor entries.
      for (let current = dir; ; current = path.dirname(current)) {
        const dirFd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
        try {
          fs.fsyncSync(dirFd);
        } finally {
          fs.closeSync(dirFd);
        }
        if (current === path.dirname(current)) break;
      }
      this.fd = fd;
      this.size = stat.size;
      this.recoverTail();
      this.read();
      openPaths.add(this.filePath);
    } catch {
      if (fd !== undefined) fs.closeSync(fd);
      throw new JournalError();
    }
  }

  private bytes(): Buffer {
    this.check();
    const bytes = Buffer.alloc(this.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(this.fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new JournalError();
      offset += count;
    }
    return bytes;
  }

  /** The fsynced sidecar is a write-ahead recovery intent, not a new admission.
   * Quarantine -> marker -> truncate -> recovery event -> remove marker. A crash
   * at ANY boundary replays this exact event instead of losing/duplicating it. */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Called during constructor recovery before read/admission.
  private recoverTail(): void {
    const markerPath = `${this.filePath}.recovery`;
    let marker: TailRecovery | undefined;
    try {
      const value: unknown = JSON.parse(readPrivate(markerPath).toString('utf8'));
      if (!isTailRecovery(value)) throw new JournalError();
      marker = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const bytes = this.bytes();
    if (!marker) {
      if (!bytes.length || bytes.at(-1) === 10) return;
      const offset = bytes.lastIndexOf(10) + 1;
      const prefix = bytes.subarray(0, offset);
      parseComplete(prefix); // Validate ALL prior lines before creating evidence.
      const tail = bytes.subarray(offset);
      let parsed = false;
      try {
        JSON.parse(tail.toString('utf8'));
        parsed = true;
      } catch {
        // Only an unparseable, unterminated final line qualifies.
      }
      if (parsed) throw new JournalError();
      const sha256 = hash(tail);
      marker = {
        v: 1,
        type: 'journal_tail_recovered',
        offset,
        bytes: tail.length,
        sha256,
        prefixSha256: hash(prefix),
        quarantine: `events.jsonl.quarantine-${offset}-${sha256}`,
      };
      publishPrivate(path.join(path.dirname(this.filePath), marker.quarantine), tail);
      publishPrivate(markerPath, Buffer.from(`${JSON.stringify(marker)}\n`));
    }
    const prefix = bytes.subarray(0, marker.offset);
    if (prefix.length !== marker.offset || hash(prefix) !== marker.prefixSha256)
      throw new JournalError();
    parseComplete(prefix);
    const tail = readPrivate(path.join(path.dirname(this.filePath), marker.quarantine));
    if (tail.length !== marker.bytes || hash(tail) !== marker.sha256) throw new JournalError();
    const event = Buffer.from(`${JSON.stringify(marker)}\n`);
    const remainder = bytes.subarray(marker.offset);
    // Only original tail, clean prefix, or our own interrupted recovery append.
    if (!remainder.equals(tail) && !event.subarray(0, remainder.length).equals(remainder))
      throw new JournalError();
    if (!remainder.equals(event)) {
      fs.ftruncateSync(this.fd, marker.offset);
      fs.fsyncSync(this.fd);
      this.size = marker.offset;
      this.append(marker);
    }
    fs.unlinkSync(markerPath);
    syncDirectory(path.dirname(this.filePath));
  }

  private check(): void {
    if (this.poisoned || this.fd < 0) throw new JournalError();
    const opened = fs.fstatSync(this.fd);
    const named = fs.lstatSync(this.filePath);
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      opened.ino !== named.ino ||
      opened.dev !== named.dev ||
      opened.nlink !== 1 ||
      opened.size !== this.size ||
      (named.mode & 0o077) !== 0
    )
      throw new JournalError();
  }

  read(): unknown[] {
    try {
      return parseComplete(this.bytes());
    } catch {
      this.poisoned = true;
      throw new JournalError();
    }
  }

  append(event: unknown): void {
    try {
      this.check();
      const json = JSON.stringify(event);
      if (json === undefined) throw new JournalError();
      const bytes = Buffer.from(`${json}\n`, 'utf8');
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(this.fd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new JournalError();
        offset += written;
      }
      fs.fsyncSync(this.fd);
      this.size += bytes.length;
    } catch {
      // A full line may exist even if fsync failed. No more admissions on this writer.
      this.poisoned = true;
      throw new JournalError();
    }
  }

  close(): void {
    if (this.fd >= 0) {
      fs.closeSync(this.fd);
      this.fd = -1;
      openPaths.delete(this.filePath);
    }
  }
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function parseComplete(bytes: Buffer): unknown[] {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes) || (text && !text.endsWith('\n'))) throw new JournalError();
  return text
    ? text
        .slice(0, -1)
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];
}
