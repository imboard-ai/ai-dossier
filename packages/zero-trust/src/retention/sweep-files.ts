import fs from 'node:fs';
import path from 'node:path';
import { syncDirectory } from '../durable-fs';
import { digest, directoryEntries, fileDigest, inDirectory, refuse, sameInode } from './files';
import type { SweepFile } from './retention';

export const QUARANTINE = '.retention-quarantine';
export const INVENTORY_LIMITS = Object.freeze({
  entries: 20000,
  depth: 64,
  bytes: 1024 * 1024 * 1024,
  fileBytes: 256 * 1024 * 1024,
});
export function heldName(file: SweepFile): string {
  return `.zt-retention-${digest(`${file.path}:${file.dev}:${file.ino}`)}`;
}
function privateDirectory(stat: fs.Stats): void {
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
    refuse('stale-plan', 'delete');
}
export function inventory(root: string, pending: readonly SweepFile[] = []) {
  const artifacts: SweepFile[] = [];
  const protectedFiles = new Map<string, string>();
  const paths = new Set<string>();
  let activity = 0,
    entries = 0,
    bytes = 0;
  function walk(directory: string, prefix: string, depth: number): void {
    if (depth > INVENTORY_LIMITS.depth) refuse('size-limit', 'inventory');
    for (const name of directoryEntries(directory)) {
      if (++entries > INVENTORY_LIMITS.entries) refuse('size-limit', 'inventory');
      if (!prefix && ['summary.json', '.snapshot-expired'].includes(name)) continue;
      if (!prefix && /^\.retention-(generation|completed)-[a-f0-9]{64}\.json$/u.test(name))
        continue;
      const named = prefix ? `${prefix}/${name}` : name;
      const held =
        prefix === QUARANTINE ? pending.find((file) => heldName(file) === name) : undefined;
      if (prefix === QUARANTINE && !held) refuse('stale-plan', 'inventory');
      const relative = held?.path ?? named;
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) {
        if (named === QUARANTINE) privateDirectory(stat);
        inDirectory(directory, name, (pinned) => walk(pinned, relative, depth + 1));
      } else {
        if (!stat.isFile() || stat.nlink !== 1) refuse('stale-plan', 'inventory');
        bytes += stat.size;
        if (bytes > INVENTORY_LIMITS.bytes) refuse('size-limit', 'inventory');
        const sha256 = fileDigest(file, stat, INVENTORY_LIMITS.fileBytes);
        if (!name.endsWith('.guard') && !name.endsWith('.lock'))
          activity = Math.max(activity, stat.mtimeMs);
        if (relative.startsWith('artifacts/')) {
          if (paths.has(relative)) refuse('stale-plan', 'inventory');
          paths.add(relative);
          artifacts.push({
            path: relative,
            dev: stat.dev,
            ino: stat.ino,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            sha256,
          });
        } else protectedFiles.set(relative, sha256);
      }
    }
  }
  walk(root, '', 0);
  artifacts.sort((a, b) => a.path.localeCompare(b.path));
  return {
    artifacts,
    protectedDigest: digest(
      JSON.stringify(Object.fromEntries([...protectedFiles].sort(([a], [b]) => a.localeCompare(b))))
    ),
    activity,
  };
}
function exists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
/** Directory is controller-owned, outside artifacts and never mounted in a worker.
 * This is not isolation against an arbitrary same-UID controller adversary. */
export function withQuarantine<T>(root: string, work: (directory: string) => T): T {
  const named = path.join(root, QUARANTINE);
  if (!exists(named)) {
    fs.mkdirSync(named, { mode: 0o700 });
    syncDirectory(root);
  }
  privateDirectory(fs.lstatSync(named));
  return inDirectory(root, QUARANTINE, (pinned) => {
    privateDirectory(fs.statSync(pinned));
    return work(pinned);
  });
}
/** ENOENT is success only on a published crash replay and only before isolation.
 * A mismatched moved inode is preserved in quarantine for controller recovery. */
export function deleteArtifact(
  root: string,
  quarantine: string,
  file: SweepFile,
  replay: boolean,
  isolated: () => void
): void {
  inDirectory(root, path.posix.dirname(file.path), (parent) => {
    const source = path.join(parent, path.posix.basename(file.path));
    const held = path.join(quarantine, heldName(file));
    if (exists(held)) {
      if (exists(source)) refuse('stale-plan', 'delete');
    } else {
      if (!exists(source)) {
        if (replay) return;
        refuse('stale-plan', 'delete');
      }
      fs.renameSync(source, held);
      syncDirectory(parent);
      syncDirectory(quarantine);
      isolated();
    }
    const current = fs.lstatSync(held);
    if (
      !current.isFile() ||
      current.nlink !== 1 ||
      current.dev !== file.dev ||
      current.ino !== file.ino ||
      current.size !== file.size ||
      current.mtimeMs !== file.mtimeMs ||
      fileDigest(held, current, INVENTORY_LIMITS.fileBytes) !== file.sha256
    )
      refuse('stale-plan', 'delete');
    // Last identity check after digest, immediately before unlink. POSIX has no
    // unlink-by-fd; exclusive controller authority over the pinned parent is essential.
    privateDirectory(fs.statSync(quarantine));
    if (!sameInode(current, fs.lstatSync(held))) refuse('stale-plan', 'delete');
    fs.unlinkSync(held);
    syncDirectory(quarantine);
  });
}
