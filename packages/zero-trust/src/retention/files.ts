import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readPrivate } from '../durable-fs';
import { assertNoSecrets, assertSecretFree } from '../redaction';

export function digest(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function refuse(): never {
  throw new Error('Contribution maintenance refused');
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
export function optionalBytes(root: string, relative: string): Buffer | null {
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
    const bytes = readPrivate(file);
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
export function jsonRecord(bytes: Buffer): unknown {
  if (bytes.length > 1024 * 1024 || bytes.toString('utf8').includes('\ufffd')) refuse();
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
