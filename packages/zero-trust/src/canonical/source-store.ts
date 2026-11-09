/** Git-backed held source (#1275).
 *
 * A held source manifest used to be persisted with every file's bytes inline as base64, beside
 * the base64 object pack, inside one JSON artifact; a repository with a large tree pushed that
 * past the 96 MiB artifact cap. Git already holds those bytes: the acquired pack contains every
 * base blob. The pack is therefore persisted once as a digest-named private file, and each
 * persisted manifest entry keeps only `path`, `mode`, `gitOid`, `sha256` and `size`. Blobs a
 * candidate or contributor edit adds go into a small digest-named pack of their own.
 *
 * Decoding is the one verifying accessor. It reads each referenced pack file through
 * `SourcePackStore.read` (digest-named, no-follow, private single-link regular file, re-hashed
 * on every read), indexes the packs in a fresh `TrustedGit` repository, reads the blobs with
 * `cat-file --batch`, and re-checks every entry's object id, SHA-256 and size. It rebuilds
 * exactly the previous inline record, so `validateManifest` recomputes the identical manifest
 * digest and candidate SHAs are unchanged. Any mismatch fails closed with
 * `CanonicalError('invalid_manifest')`. Records written before #1275 pass through unchanged. */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lstatIfPresent, privateDir, syncDirectory } from '../durable-fs';
import { CanonicalError, sha256 } from './export';
import { MAX_GIT_PACK_BYTES, TrustedGit } from './trusted-git';

/** The directory, under a run's `artifacts/`, that holds its source packs. Being under
 * `artifacts/` makes retention sweep count, digest and delete them like any artifact. */
export const SOURCE_PACK_DIRECTORY = 'source-packs';
/** Marker distinguishing a git-backed manifest record from the legacy inline one. */
export const SOURCE_STORAGE = 'git-packs-v1';
export const MAX_PACK_FILE_BYTES = MAX_GIT_PACK_BYTES;
const DIGEST = /^[a-f0-9]{64}$/u;
const OID = /^[a-f0-9]{40}$/u;
const EMPTY = sha256('');

export interface PackRef {
  readonly sha256: string;
  readonly size: number;
}

export function sourcePackDirectory(store: { storeDirectory(name: 'artifacts'): string }): string {
  return path.join(store.storeDirectory('artifacts'), SOURCE_PACK_DIRECTORY);
}
export function sourcePackStore(store: { storeDirectory(name: 'artifacts'): string }) {
  return new SourcePackStore(sourcePackDirectory(store));
}
/** Git's object id for blob content, computed without Git. */
export function gitBlobOid(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function refuse(): never {
  throw new CanonicalError('invalid_manifest');
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>): string {
  return Object.keys(value).sort().join(',');
}
function isRef(value: unknown): value is PackRef {
  return (
    isRecord(value) &&
    keys(value) === 'sha256,size' &&
    typeof value.sha256 === 'string' &&
    DIGEST.test(value.sha256) &&
    Number.isSafeInteger(value.size) &&
    (value.size as number) > 0 &&
    (value.size as number) <= MAX_PACK_FILE_BYTES
  );
}
/** Canonical base64 only: Node's decoder is permissive and is not a validator. */
function decodeBase64(text: string): Buffer | null {
  if (text.length > 4 * Math.ceil(MAX_PACK_FILE_BYTES / 3)) return null;
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? bytes : null;
}

export class SourcePackStore {
  constructor(readonly directory: string) {}

  private file(hash: string): string {
    if (typeof hash !== 'string' || !DIGEST.test(hash)) refuse();
    return path.join(this.directory, hash);
  }

  /** Digest-named, no-follow, private single-link regular inode of the exact size, read on
   * that descriptor and re-hashed on every call. */
  read(ref: PackRef): Buffer {
    if (!isRef(ref)) refuse();
    const name = this.file(ref.sha256);
    let fd: number;
    try {
      // Pin the blob directory itself without following a symlink, then open the leaf
      // relative to that descriptor, also without following.
      const dir = fs.openSync(
        this.directory,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
      );
      try {
        const stat = fs.fstatSync(dir);
        if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) refuse();
        fd = fs.openSync(
          `/proc/self/fd/${dir}/${path.basename(name)}`,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
        );
      } finally {
        fs.closeSync(dir);
      }
    } catch {
      return refuse();
    }
    try {
      const stat = fs.fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size !== ref.size
      )
        refuse();
      const bytes = Buffer.alloc(ref.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) refuse();
        offset += count;
      }
      if (fs.readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) refuse();
      if (sha256(bytes) !== ref.sha256) refuse();
      return bytes;
    } catch (error) {
      if (error instanceof CanonicalError) throw error;
      return refuse();
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Durably writes every distinct pack before returning, so a record that references them
   * can be published afterwards. An existing file is reused only when it verifies exactly;
   * a mismatching one fails closed rather than being trusted or overwritten. */
  write(chunks: readonly Buffer[]): PackRef[] {
    const refs = chunks.map((bytes) => ({ sha256: sha256(bytes), size: bytes.length }));
    const pending = new Map<string, Buffer>();
    refs.forEach((ref, i) => {
      if (ref.size > MAX_PACK_FILE_BYTES) refuse();
      if (ref.size) pending.set(ref.sha256, chunks[i]);
    });
    if (!pending.size) return refs;
    const created = lstatIfPresent(this.directory) === null;
    privateDir(this.directory);
    if (created) syncDirectory(path.dirname(this.directory));
    // Only this controller writes here, under its exclusive store guard; a temporary file
    // left by an interrupted write is never referenced and is removed before writing.
    for (const name of fs.readdirSync(this.directory))
      if (/^\.zt-write-[0-9a-f-]{36}$/u.test(name))
        fs.rmSync(path.join(this.directory, name), { force: true });
    for (const [hash, bytes] of pending) {
      const file = this.file(hash);
      if (lstatIfPresent(file) !== null) {
        this.read({ sha256: hash, size: bytes.length });
        continue;
      }
      const tmp = path.join(this.directory, `.zt-write-${randomUUID()}`);
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      // Absence was checked under the guard; rename leaves exactly one link at any crash point.
      fs.renameSync(tmp, file);
    }
    // One directory fsync covers every name (including ones an interrupted earlier write
    // created but may not have made durable), before any referencing record exists.
    syncDirectory(this.directory);
    return refs;
  }
}

const INLINE_ENTRY = 'bytes,mode,path,sha256';
const STORED_ENTRY = 'gitOid,mode,path,sha256,size';
const INLINE_MANIFEST = 'digest,entries,totalBytes,version';
const STORED_MANIFEST = 'digest,entries,packs,storage,totalBytes,version';

/** A fresh trusted repository holding exactly the referenced packs, each read through the
 * verifying pack accessor. Packs were strictly verified when produced; this index is
 * non-strict because a shallow base pack omits its parents, and every blob read from it is
 * re-verified below. */
function withPacks<T>(
  store: SourcePackStore,
  refs: readonly PackRef[],
  work: (git: TrustedGit) => T
): T {
  const git = new TrustedGit();
  try {
    for (const ref of refs) {
      const result = git.exec(['index-pack', '--stdin'], { input: store.read(ref) });
      if (result.status !== 0) refuse();
    }
    return work(git);
  } finally {
    git.close();
  }
}
/** `cat-file --batch` output for distinct ids, each required to be a blob. */
function readBlobs(git: TrustedGit, oids: readonly string[]): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  if (!oids.length) return found;
  const result = git.exec(['cat-file', '--batch'], { input: `${oids.join('\n')}\n` });
  if (result.status !== 0) refuse();
  const out = result.stdout;
  let offset = 0;
  for (const oid of oids) {
    const newline = out.indexOf(10, offset);
    if (newline < 0) refuse();
    const header = out.subarray(offset, newline).toString('ascii');
    const match = /^([a-f0-9]{40}) blob (\d+)$/u.exec(header);
    if (!match || match[1] !== oid) refuse();
    const size = Number(match[2]);
    const start = newline + 1;
    if (!Number.isSafeInteger(size) || start + size + 1 > out.length || out[start + size] !== 10)
      refuse();
    found.set(oid, Buffer.from(out.subarray(start, start + size)));
    offset = start + size + 1;
  }
  if (offset !== out.length) refuse();
  return found;
}
function packRefs(value: unknown): PackRef[] {
  if (!Array.isArray(value) || value.length > 64 || !value.every(isRef)) refuse();
  return value as PackRef[];
}

/** Structural check of a git-backed record without reading any pack. */
export function assertStoredManifest(value: unknown): void {
  if (!isRecord(value) || keys(value) !== STORED_MANIFEST) refuse();
  if (value.version !== 1 || value.storage !== SOURCE_STORAGE) refuse();
  packRefs(value.packs);
  if (!Array.isArray(value.entries)) refuse();
  for (const entry of value.entries) {
    if (
      !isRecord(entry) ||
      keys(entry) !== STORED_ENTRY ||
      typeof entry.path !== 'string' ||
      typeof entry.mode !== 'string' ||
      typeof entry.sha256 !== 'string' ||
      !DIGEST.test(entry.sha256) ||
      !Number.isSafeInteger(entry.size) ||
      (entry.size as number) < 0 ||
      (entry.size as number) > MAX_PACK_FILE_BYTES ||
      (entry.mode === '040000'
        ? entry.gitOid !== null || entry.size !== 0
        : typeof entry.gitOid !== 'string' || !OID.test(entry.gitOid))
    )
      refuse();
  }
}
export function isStoredManifest(value: unknown): boolean {
  return isRecord(value) && value.storage === SOURCE_STORAGE;
}

/** Exactly the persisted inline shape, with canonical base64 bound to its SHA-256. */
function inlineFiles(manifest: unknown): Buffer[] | null {
  if (!isRecord(manifest) || keys(manifest) !== INLINE_MANIFEST || manifest.version !== 1)
    return null;
  if (!Array.isArray(manifest.entries)) return null;
  const files: Buffer[] = [];
  for (const entry of manifest.entries) {
    if (
      !isRecord(entry) ||
      keys(entry) !== INLINE_ENTRY ||
      typeof entry.path !== 'string' ||
      typeof entry.mode !== 'string' ||
      typeof entry.bytes !== 'string' ||
      typeof entry.sha256 !== 'string'
    )
      return null;
    const bytes = decodeBase64(entry.bytes);
    if (!bytes || sha256(bytes) !== entry.sha256) return null;
    if (entry.mode === '040000' && bytes.length) return null;
    files.push(bytes);
  }
  return files;
}

/** The git-backed record for a persisted manifest. Blobs already in `basePacks` are
 * referenced there; any other blob goes into one new digest-named pack, durable before this
 * returns. Input that is not exactly a well-formed inline manifest is returned unchanged, so
 * the legacy reader and validators decide as before. */
export function storeManifest(
  manifest: unknown,
  store: SourcePackStore,
  basePacks: readonly PackRef[]
): unknown {
  const files = inlineFiles(manifest);
  if (!files || !isRecord(manifest)) return manifest;
  basePacks = [...new Map(basePacks.map((ref) => [ref.sha256, ref])).values()];
  const entries = manifest.entries as Record<string, unknown>[];
  const oids = files.map((bytes, i) => (entries[i].mode === '040000' ? null : gitBlobOid(bytes)));
  const wanted = new Map<string, Buffer>();
  oids.forEach((oid, i) => {
    if (oid && files[i].length) wanted.set(oid, files[i]);
  });
  const packs = [...basePacks];
  if (wanted.size)
    withPacks(store, basePacks, (git) => {
      const ids = [...wanted.keys()];
      const check = git.exec(['cat-file', '--batch-check'], { input: `${ids.join('\n')}\n` });
      if (check.status !== 0) refuse();
      const lines = check.stdout.toString('ascii').split('\n');
      const missing = ids.filter((id, i) => lines[i] !== `${id} blob ${wanted.get(id)?.length}`);
      if (!missing.length) return;
      // One hash-object over controller-written temporary files, named by index only.
      const scratch = path.join(git.directory, 'blobs');
      fs.mkdirSync(scratch, { mode: 0o700 });
      const files = missing.map((id, i) => {
        const file = path.join(scratch, String(i));
        fs.writeFileSync(file, wanted.get(id) as Buffer, { mode: 0o600, flag: 'wx' });
        return file;
      });
      const written = git
        .run(['hash-object', '-w', '--no-filters', '--stdin-paths'], `${files.join('\n')}\n`)
        .toString()
        .trim()
        .split('\n');
      if (written.length !== missing.length || written.some((id, i) => id !== missing[i])) refuse();
      const pack = git.run(['pack-objects', '--stdout'], `${missing.join('\n')}\n`);
      packs.push(...store.write([pack]));
    });
  return {
    version: 1,
    storage: SOURCE_STORAGE,
    packs: [...new Map(packs.map((ref) => [ref.sha256, ref])).values()],
    entries: entries.map((entry, i) => ({
      path: entry.path,
      mode: entry.mode,
      gitOid: oids[i],
      sha256: entry.sha256,
      size: files[i].length,
    })),
    totalBytes: manifest.totalBytes,
    digest: manifest.digest,
  };
}

/** The exact inline record a git-backed one stands for; legacy inline input passes through.
 * The caller still runs `validateManifest`, which recomputes the manifest digest. */
export function loadManifest(value: unknown, store: SourcePackStore): unknown {
  if (!isStoredManifest(value)) return value;
  assertStoredManifest(value);
  const stored = value as Record<string, unknown>;
  const entries = stored.entries as Record<string, unknown>[];
  const oids = [
    ...new Set(entries.filter((e) => (e.size as number) > 0).map((e) => e.gitOid as string)),
  ];
  const blobs = oids.length
    ? withPacks(store, packRefs(stored.packs), (git) => readBlobs(git, oids))
    : new Map<string, Buffer>();
  return {
    digest: stored.digest,
    entries: entries.map((entry) => {
      const size = entry.size as number;
      const bytes = size ? blobs.get(entry.gitOid as string) : Buffer.alloc(0);
      // Defense in depth over Git's SHA-1: exact size, object id and SHA-256 per entry.
      if (
        !bytes ||
        bytes.length !== size ||
        (entry.mode !== '040000' && gitBlobOid(bytes) !== entry.gitOid) ||
        (size ? sha256(bytes) : EMPTY) !== entry.sha256
      )
        refuse();
      return {
        bytes: bytes.toString('base64'),
        mode: entry.mode,
        path: entry.path,
        sha256: entry.sha256,
      };
    }),
    totalBytes: stored.totalBytes,
    version: 1,
  };
}

/** `pack` names the field holding a base64 object pack (`pack` for the acquired source,
 * `basePack` for the shipping record), or null when the record carries none. */
export interface HeldSourceOptions {
  readonly pack: 'pack' | 'basePack' | null;
  /** A field holding a nested held candidate (`implementation_basis.candidate`). */
  readonly nested?: 'candidate';
}
const NESTED: HeldSourceOptions = Object.freeze({ pack: null });

/** Persisted form of a held record carrying `manifest` and, optionally, a base64 pack: the
 * pack becomes a pack-file reference and the manifest resolves its blobs in that pack, then
 * in `basePacks`, then in a new pack of its own. Other fields are untouched. */
export function storeHeldSource(
  value: unknown,
  store: SourcePackStore,
  options: HeldSourceOptions,
  basePacks: readonly PackRef[] = []
): unknown {
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = { ...value };
  const packs = [...basePacks];
  const field = options.pack;
  if (field && typeof value[field] === 'string') {
    const bytes = decodeBase64(value[field] as string);
    if (bytes?.length) {
      const [ref] = store.write([bytes]);
      next[field] = ref;
      packs.unshift(ref);
    }
  }
  if ('manifest' in value) next.manifest = storeManifest(value.manifest, store, packs);
  if (options.nested && isRecord(value[options.nested]))
    next[options.nested] = storeHeldSource(value[options.nested], store, NESTED, packs);
  return next;
}

/** Inverse of `storeHeldSource`; legacy inline records are returned unchanged. */
export function loadHeldSource(
  value: unknown,
  store: SourcePackStore,
  options: HeldSourceOptions
): unknown {
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = { ...value };
  if ('manifest' in value) next.manifest = loadManifest(value.manifest, store);
  const field = options.pack;
  if (field && isRecord(value[field])) {
    const ref = value[field];
    if (!isRef(ref)) refuse();
    next[field] = store.read(ref).toString('base64');
  }
  if (options.nested && isRecord(value[options.nested]))
    next[options.nested] = loadHeldSource(value[options.nested], store, NESTED);
  return next;
}

/** Structural check of a persisted held record without reading any pack. */
export function assertHeldSource(value: unknown, options: HeldSourceOptions): void {
  if (!isRecord(value)) return;
  if (isStoredManifest(value.manifest)) assertStoredManifest(value.manifest);
  const field = options.pack;
  if (field && isRecord(value[field]) && !isRef(value[field])) refuse();
  if (options.nested) assertHeldSource(value[options.nested], NESTED);
}

/** The pack files a persisted held record references, for a later record to build on. */
export function heldPacks(value: unknown, options: HeldSourceOptions): PackRef[] {
  if (!isRecord(value)) return [];
  const refs: PackRef[] = [];
  const field = options.pack;
  if (field && isRef(value[field])) refs.push(value[field] as PackRef);
  if (isStoredManifest(value.manifest) && isRecord(value.manifest))
    refs.push(...packRefs(value.manifest.packs));
  if (options.nested) refs.push(...heldPacks(value[options.nested], NESTED));
  return [...new Map(refs.map((ref) => [ref.sha256, ref])).values()];
}
