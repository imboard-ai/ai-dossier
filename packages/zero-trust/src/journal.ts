/** Durable controller-owned JSONL. Corruption and uncertain writes fail closed. */
import fs from 'node:fs';
import * as path from 'node:path';

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
      for (let current = dir; ; current = path.dirname(current)) {
        if (fs.existsSync(current)) {
          const stat = fs.lstatSync(current);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new JournalError();
        }
        if (current === path.dirname(current)) break;
      }
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
      this.read();
      openPaths.add(this.filePath);
    } catch {
      if (fd !== undefined) fs.closeSync(fd);
      throw new JournalError();
    }
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
      this.check();
      const bytes = Buffer.alloc(this.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(this.fd, bytes, offset, bytes.length - offset, offset);
        if (!count) throw new JournalError();
        offset += count;
      }
      const text = bytes.toString('utf8');
      if (!Buffer.from(text).equals(bytes)) throw new JournalError();
      if (text && !text.endsWith('\n')) throw new JournalError();
      return text
        ? text
            .slice(0, -1)
            .split('\n')
            .map((line) => JSON.parse(line))
        : [];
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
