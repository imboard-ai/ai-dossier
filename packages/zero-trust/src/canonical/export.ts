import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { resolve } from 'node:path';

export type CanonicalReason =
  | 'unsupported'
  | 'invalid_path'
  | 'path_collision'
  | 'limit_exceeded'
  | 'source_changed'
  | 'invalid_manifest'
  | 'wrong_parent'
  | 'altered_identity'
  | 'tree_mismatch'
  | 'commit_mismatch'
  | 'git_failed';
export class CanonicalError extends Error {
  constructor(readonly reason: CanonicalReason) {
    super(`Canonical source rejected: ${reason}`);
    this.name = 'CanonicalError';
  }
}
export interface SourceLimits {
  readonly fileBytes: number;
  readonly totalBytes: number;
  readonly entries: number;
  readonly depth: number;
}
export const DEFAULT_SOURCE_LIMITS: SourceLimits = Object.freeze({
  fileBytes: 10 * 1024 * 1024,
  totalBytes: 100 * 1024 * 1024,
  entries: 10000,
  depth: 64,
});
export interface SourceEntry {
  readonly path: string;
  readonly mode: '040000' | '100644' | '100755';
  /** Immutable encoding, not a mutable Buffer shared with the worker. */
  readonly bytes: string;
  readonly sha256: string;
}
export interface SourceManifest {
  readonly version: 1;
  readonly entries: readonly SourceEntry[];
  readonly totalBytes: number;
  readonly digest: string;
}
export function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function sourceLimits(overrides: Partial<SourceLimits> = {}): SourceLimits {
  const result = { ...DEFAULT_SOURCE_LIMITS, ...overrides };
  for (const value of Object.values(result))
    if (!Number.isSafeInteger(value) || value <= 0) throw new CanonicalError('limit_exceeded');
  return Object.freeze(result);
}
/** Git's HFS+ ignorable set (utf8.c:is_hfs_dotgit); used for comparisons only. */
function stripHfsIgnorables(value: string): string {
  return value.replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu, '');
}
function isGitComponent(part: string): boolean {
  // NTFS trims ASCII spaces/dots and resolves 8.3 short names. Reject the
  // combined HFS/NTFS aliases too, without changing the captured path bytes.
  const name = stripHfsIgnorables(part)
    .replace(/[ .]+$/u, '')
    .toLowerCase();
  return name === '.git' || /^git~[0-9]$/u.test(name);
}
/** Reject rather than normalize. Windows separators/drive paths are unsafe on Linux too. */
export function validateSourcePath(path: string): void {
  if (
    typeof path !== 'string' ||
    Buffer.byteLength(path) > 4096 ||
    path.includes('\\') ||
    path.includes(':') ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject tree/commit delimiters and filesystem controls.
    /[\u0000-\u001f\u007f]/u.test(path) ||
    Buffer.from(path).toString('utf8') !== path ||
    path.split('/').some((part) => !part || part === '.' || part === '..' || isGitComponent(part))
  )
    throw new CanonicalError('invalid_path');
}
export function comparePaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
function manifestDigest(entries: readonly SourceEntry[], totalBytes: number): string {
  return sha256(JSON.stringify({ version: 1, entries, totalBytes }));
}
/** The ancestor directories of a manifest path, outermost first (`a/b/c` → `a`, `a/b`). */
export function parentPaths(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(1).map((_, depth) => parts.slice(0, depth + 1).join('/'));
}
/** Revalidate persisted/untrusted JSON; returns a new deep-frozen primitive snapshot. */
export function validateManifest(
  raw: SourceManifest,
  overrides: Partial<SourceLimits> = {}
): SourceManifest {
  const limits = sourceLimits(overrides);
  if (!raw || typeof raw !== 'object') throw new CanonicalError('invalid_manifest');
  const { version, entries: input, totalBytes: claimedTotal, digest } = raw;
  if (version !== 1 || !Array.isArray(input) || input.length > limits.entries)
    throw new CanonicalError('invalid_manifest');
  const entries: SourceEntry[] = [];
  const seen = new Map<string, string>();
  const modes = new Map<string, string>();
  let totalBytes = 0;
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') throw new CanonicalError('invalid_manifest');
    const { path, mode, bytes, sha256: hash } = entry;
    validateSourcePath(path);
    if (path.split('/').length > limits.depth) throw new CanonicalError('limit_exceeded');
    // Expanding folds (ß/SS, final sigma) and compatibility aliases are unsafe too.
    const key = stripHfsIgnorables(path)
      .normalize('NFKC')
      .toUpperCase()
      .toLowerCase()
      .normalize('NFKC');
    if (seen.has(key)) throw new CanonicalError('path_collision');
    seen.set(key, path);
    if (!['040000', '100644', '100755'].includes(mode) || typeof bytes !== 'string')
      throw new CanonicalError('unsupported');
    // Bound allocation before decoding; permissive Node base64 is not a validator.
    if (bytes.length > 4 * Math.ceil(limits.fileBytes / 3))
      throw new CanonicalError('limit_exceeded');
    const blob = Buffer.from(bytes, 'base64');
    if (blob.toString('base64') !== bytes || sha256(blob) !== hash)
      throw new CanonicalError('invalid_manifest');
    if (mode === '040000' && blob.length) throw new CanonicalError('invalid_manifest');
    totalBytes += blob.length;
    if (blob.length > limits.fileBytes || totalBytes > limits.totalBytes)
      throw new CanonicalError('limit_exceeded');
    modes.set(path, mode);
    entries.push(Object.freeze({ path, mode, bytes, sha256: hash }));
  }
  for (const entry of entries) {
    const parts = entry.path.split('/');
    parts.pop();
    while (parts.length) {
      if (modes.get(parts.join('/')) !== '040000') throw new CanonicalError('invalid_manifest');
      parts.pop();
    }
  }
  entries.sort((a, b) => comparePaths(a.path, b.path));
  const computed = manifestDigest(entries, totalBytes);
  if (claimedTotal !== totalBytes || digest !== computed)
    throw new CanonicalError('invalid_manifest');
  return Object.freeze({
    version: 1,
    entries: Object.freeze(entries),
    totalBytes,
    digest: computed,
  });
}
export function createManifest(
  entries: readonly SourceEntry[],
  limits: Partial<SourceLimits> = {}
): SourceManifest {
  const cap = sourceLimits(limits);
  if (!Array.isArray(entries)) throw new CanonicalError('invalid_manifest');
  if (entries.length > cap.entries) throw new CanonicalError('limit_exceeded');
  let totalBytes = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') throw new CanonicalError('invalid_manifest');
    if (typeof entry.bytes !== 'string') throw new CanonicalError('invalid_manifest');
    if (entry.bytes.length > 4 * Math.ceil(cap.fileBytes / 3))
      throw new CanonicalError('limit_exceeded');
    totalBytes += Buffer.from(entry.bytes, 'base64').length;
    if (totalBytes > cap.totalBytes) throw new CanonicalError('limit_exceeded');
  }
  const sorted = [...entries].sort((a, b) => comparePaths(a.path, b.path));
  return validateManifest(
    { version: 1, entries: sorted, totalBytes, digest: manifestDigest(sorted, totalBytes) },
    limits
  );
}
function unchanged(a: fs.Stats, b: fs.Stats): boolean {
  return ['dev', 'ino', 'mode', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].every(
    (key) => a[key as keyof fs.Stats] === b[key as keyof fs.Stats]
  );
}
/**
 * Linux descriptor-anchored walk. Caller supplies a source-only directory, NOT a
 * checkout with .git stripped implicitly. All ancestor opens are no-follow too.
 * Concurrent mutation is rejected; captured bytes never get re-read at shipping.
 */
export function exportSource(root: string, overrides: Partial<SourceLimits> = {}): SourceManifest {
  if (process.platform !== 'linux') throw new CanonicalError('unsupported');
  const limits = sourceLimits(overrides);
  const entries: SourceEntry[] = [];
  let total = 0;
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  const dirFlags = flags | fs.constants.O_DIRECTORY;
  // Linux O_PATH pins an inode without opening a device/FIFO for I/O if a
  // regular-file lstat is raced. Node does not expose this Linux-only constant.
  const pathFlags = 0x200000 | fs.constants.O_NOFOLLOW;
  const held: number[] = [];
  try {
    let fd = fs.openSync('/', dirFlags);
    held.push(fd);
    for (const part of resolve(root).split('/').filter(Boolean)) {
      fd = fs.openSync(`/proc/self/fd/${fd}/${part}`, dirFlags);
      held.push(fd);
    }
    const walk = (dir: number, prefix: string, depth: number): void => {
      if (depth > limits.depth) throw new CanonicalError('limit_exceeded');
      const before = fs.fstatSync(dir);
      // Stream bounded batches: readdirSync would allocate the entire hostile
      // directory before the entry cap could reject it. Node supports Buffer
      // dirent names but @types/node models only the string form.
      const listing = fs.opendirSync(`/proc/self/fd/${dir}`, {
        encoding: 'buffer' as BufferEncoding,
        bufferSize: 32,
      });
      try {
        for (let entry = listing.readSync(); entry; entry = listing.readSync()) {
          const nameBytes = entry.name as unknown as Buffer;
          const name = nameBytes.toString('utf8');
          if (!Buffer.from(name).equals(nameBytes)) throw new CanonicalError('invalid_path');
          const path = prefix ? `${prefix}/${name}` : name;
          validateSourcePath(path);
          if (entries.length >= limits.entries) throw new CanonicalError('limit_exceeded');
          const anchored = `/proc/self/fd/${dir}/${name}`;
          const stat = fs.lstatSync(anchored);
          if (!stat.isDirectory() && !stat.isFile()) throw new CanonicalError('unsupported');
          const child = fs.openSync(anchored, stat.isDirectory() ? dirFlags : pathFlags);
          try {
            const opened = fs.fstatSync(child);
            if (!unchanged(stat, opened)) throw new CanonicalError('source_changed');
            if (stat.isDirectory()) {
              entries.push({ path, mode: '040000', bytes: '', sha256: sha256('') });
              walk(child, path, depth + 1);
            } else {
              if (stat.size > limits.fileBytes || total + stat.size > limits.totalBytes)
                throw new CanonicalError('limit_exceeded');
              // Reopen ONLY the verified regular inode through its pinned fd.
              // This magic link is controller-generated, never a worker path.
              const bytes = Buffer.alloc(stat.size);
              const reader = fs.openSync(
                `/proc/self/fd/${child}`,
                fs.constants.O_RDONLY | fs.constants.O_NONBLOCK
              );
              try {
                if (!unchanged(opened, fs.fstatSync(reader)))
                  throw new CanonicalError('source_changed');
                let read = 0;
                while (read < bytes.length) {
                  const count = fs.readSync(reader, bytes, read, bytes.length - read, null);
                  if (!count) throw new CanonicalError('source_changed');
                  read += count;
                }
                if (!unchanged(opened, fs.fstatSync(reader)))
                  throw new CanonicalError('source_changed');
              } finally {
                fs.closeSync(reader);
              }
              total += bytes.length;
              entries.push({
                path,
                mode: stat.mode & 0o111 ? '100755' : '100644',
                bytes: bytes.toString('base64'),
                sha256: sha256(bytes),
              });
            }
            if (!unchanged(opened, fs.fstatSync(child)) || !unchanged(stat, fs.lstatSync(anchored)))
              throw new CanonicalError('source_changed');
          } finally {
            fs.closeSync(child);
          }
        }
      } finally {
        listing.closeSync();
      }
      if (!unchanged(before, fs.fstatSync(dir))) throw new CanonicalError('source_changed');
    };
    walk(fd, '', 0);
    return createManifest(entries, limits);
  } catch (error) {
    if (error instanceof CanonicalError) throw error;
    throw new CanonicalError('source_changed');
  } finally {
    for (const fd of held.reverse()) fs.closeSync(fd);
  }
}
