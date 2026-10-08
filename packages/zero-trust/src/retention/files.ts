import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../canonical/export';
import { assertNoSecrets, assertSecretFree } from '../redaction';
import { type MaintenanceCode, MaintenanceError, type MaintenanceStage } from './errors';

export const digest = sha256;
export const RECORD_BYTES = 1024 * 1024;
export const SUMMARY_BYTES = 4 * RECORD_BYTES;
export const JOURNAL_BYTES = 16 * RECORD_BYTES;
export function refuse(
  code: MaintenanceCode = 'invalid-evidence',
  stage: MaintenanceStage = 'evidence'
): never {
  throw new MaintenanceError(code, stage);
}
export function sameInode(a: fs.Stats, b: fs.Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
/** Cap before allocation, pin a regular private inode, detect growth/replacement. */
export function boundedRead(file: string, limit = RECORD_BYTES): Buffer {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o777) !== 0o600
    )
      refuse();
    if (before.size > limit) refuse('size-limit', 'read');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) refuse();
      offset += count;
    }
    if (
      fs.readSync(fd, Buffer.alloc(1), 0, 1, offset) ||
      !sameInode(before, fs.fstatSync(fd)) ||
      !sameInode(before, fs.lstatSync(file))
    )
      refuse();
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}
/** Bulk data never enters a whole-file allocation. */
export function fileDigest(file: string, expected: fs.Stats, limit: number): string {
  if (expected.size > limit) refuse('size-limit', 'inventory');
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || !sameInode(before, expected))
      refuse('stale-plan', 'inventory');
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(64 * 1024);
    let offset = 0;
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, limit - offset + 1), offset);
      if (!count) break;
      offset += count;
      if (offset > limit) refuse('size-limit', 'inventory');
      hash.update(chunk.subarray(0, count));
    }
    if (
      offset !== before.size ||
      !sameInode(before, fs.fstatSync(fd)) ||
      !sameInode(before, fs.lstatSync(file))
    )
      refuse('stale-plan', 'inventory');
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}
export function* directoryEntries(directory: string): Generator<string> {
  const dir = fs.opendirSync(directory);
  try {
    for (;;) {
      const entry = dir.readSync();
      if (!entry) break;
      yield entry.name;
    }
  } finally {
    dir.closeSync();
  }
}
/** Descend relative components using O_NOFOLLOW directory descriptors. */
export function inDirectory<T>(root: string, relative: string, work: (dir: string) => T): T {
  const components = relative.split('/');
  if (components.some((c) => !c || c === '.' || c === '..' || c.includes('\\'))) refuse();
  const fds: number[] = [];
  try {
    let directory = root;
    for (const component of components) {
      const fd = fs.openSync(
        path.join(directory, component),
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
      );
      fds.push(fd);
      directory = `/proc/self/fd/${fd}`;
    }
    return work(directory);
  } finally {
    for (const fd of fds.reverse()) fs.closeSync(fd);
  }
}
export function optionalBytes(root: string, relative: string, limit = RECORD_BYTES): Buffer | null {
  const parent = path.posix.dirname(relative);
  const read = (dir: string) => {
    const file = path.join(dir, path.posix.basename(relative));
    let before: fs.Stats;
    try {
      before = fs.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const bytes = boundedRead(file, limit);
    const after = fs.lstatSync(file);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes.length !== after.size
    )
      refuse();
    return bytes;
  };
  return parent === '.' ? read(root) : inDirectory(root, parent, read);
}
export function jsonRecord(bytes: Buffer, limit = RECORD_BYTES): unknown {
  if (bytes.length > limit) refuse('size-limit', 'read');
  if (!bytes.equals(Buffer.from(bytes.toString('utf8')))) refuse();
  const text = bytes.toString('utf8');
  assertNoSecrets(text);
  const parse = (source: string): unknown => {
    try {
      return JSON.parse(source);
    } catch {
      return refuse();
    }
  };
  // Scan every JSON string token, including duplicate-key values JSON.parse would
  // discard. Decoding each token also catches escaped credential prefixes.
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"/gu)) {
    assertNoSecrets(parse(match[0]) as string);
  }
  const raw = parse(text);
  assertSecretFree(raw);
  return raw;
}
/** Strict maintenance JSONL; never use scheduler/journal tail recovery. */
export function strictJsonLines(bytes: Buffer): unknown[] {
  if (bytes.length > JOURNAL_BYTES) refuse('size-limit', 'read');
  const text = bytes.toString('utf8');
  if (!text || !bytes.equals(Buffer.from(text)) || !text.endsWith('\n')) refuse();
  const records: unknown[] = [];
  let start = 0;
  for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
    if (records.length >= 10000) refuse('size-limit', 'read');
    const line = text.slice(start, end);
    if (Buffer.byteLength(line) > RECORD_BYTES) refuse('size-limit', 'read');
    records.push(jsonRecord(Buffer.from(line)));
    start = end + 1;
  }
  return records;
}
