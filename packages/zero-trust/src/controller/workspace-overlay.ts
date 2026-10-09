import fs from 'node:fs';
import path from 'node:path';
import { admitWorkspaceWrite } from '../authority';
import {
  CanonicalError,
  comparePaths,
  createManifest,
  exportSource,
  parentPaths,
  type SourceEntry,
  type SourceManifest,
  sha256,
  validateManifest,
} from '../canonical/export';
import { isTestPath } from '../review/integrity';
import { assertWorkspacePath } from '../vm/broker';

/** Exact controller-held baseline plus admitted writes. VM reads never enter this map.
 * No deletion or mode-changing action exists in the MVP. */
export class WorkspaceOverlay {
  readonly base: SourceManifest;
  private entries: Map<string, SourceEntry>;
  private readonly written = new Set<string>();

  constructor(base: SourceManifest) {
    this.base = validateManifest(base);
    this.entries = new Map(this.base.entries.map((entry) => [entry.path, entry]));
  }

  /** Validates the combined candidate before publishing the write to controller state. */
  write(file: string, content: string): void {
    const admitted = admitWorkspaceWrite(file, content);
    const name = admitted.path;
    const bytes = Buffer.from(admitted.content, 'utf8');
    const next = new Map(this.entries);
    const old = next.get(name);
    if (old?.mode === '040000') throw new CanonicalError('path_collision');
    for (const parent of parentPaths(name))
      if (!next.has(parent))
        next.set(parent, { path: parent, mode: '040000', bytes: '', sha256: sha256('') });
    next.set(name, {
      path: name,
      mode: old?.mode ?? '100644',
      bytes: bytes.toString('base64'),
      sha256: sha256(bytes),
    });
    const manifest = createManifest([...next.values()]);
    this.entries = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    this.written.add(name);
  }

  executable(file: string): boolean {
    return this.entries.get(assertWorkspacePath(file))?.mode === '100755';
  }

  testFiles(): readonly string[] {
    return Object.freeze([...this.written].filter(isTestPath).sort(comparePaths));
  }

  /** Immutable admitted delta, including writes byte-identical to the baseline.
   * Drift must check every touched path, not just the final diff. */
  writtenEntries(): readonly SourceEntry[] {
    return Object.freeze(
      [...this.written].sort(comparePaths).map((file) => this.entries.get(file) as SourceEntry)
    );
  }

  /** Validated immutable source snapshot; no filesystem or VM reads. */
  manifest(): SourceManifest {
    return createManifest([...this.entries.values()]);
  }

  /** Detached controller snapshot sharing only already frozen source entries. */
  snapshot(): WorkspaceOverlay {
    const next = new WorkspaceOverlay(this.base);
    next.entries = new Map(this.entries);
    for (const file of this.written) next.written.add(file);
    return next;
  }

  /** Replay the held delta in bulk after the caller's upstream conflict check. */
  onBase(base: SourceManifest): WorkspaceOverlay {
    const next = new WorkspaceOverlay(base);
    next.applyEntries(this.writtenEntries());
    return next;
  }

  /** Entries come only from another controller-held overlay, never worker JSON.
   * Validate the combined source once, without rehashing it per admitted write. */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Called on detached instances by onBase and applyRepair; Biome only tracks this.member references.
  private applyEntries(writes: readonly SourceEntry[]): void {
    const next = new Map(this.entries);
    for (const entry of writes) {
      const old = next.get(entry.path);
      if (old?.mode === '040000') throw new CanonicalError('path_collision');
      for (const parent of parentPaths(entry.path))
        if (!next.has(parent))
          next.set(parent, { path: parent, mode: '040000', bytes: '', sha256: sha256('') });
      next.set(entry.path, Object.freeze({ ...entry, mode: old?.mode ?? '100644' }));
    }
    const manifest = createManifest([...next.values()]);
    this.entries = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    for (const entry of writes) this.written.add(entry.path);
  }

  /** Compose a repair workspace into the cumulative contribution delta. The repair
   * must start at our exact candidate; inherited and byte-identical writes remain touched. */
  applyRepair(repair: WorkspaceOverlay): void {
    if (repair.base.digest !== this.manifest().digest) throw new CanonicalError('tree_mismatch');
    const next = this.snapshot();
    next.applyEntries(repair.writtenEntries());
    this.entries = next.entries;
    for (const file of next.written) this.written.add(file);
  }

  /** `directory` must be absent under a controller-owned parent. Never merge into an
   * existing tree (including a symlink). Returns the freshly exported candidate. */
  materialize(directory: string): SourceManifest {
    const manifest = this.manifest();
    fs.mkdirSync(directory, { mode: 0o700 });
    for (const entry of manifest.entries) {
      const target = path.join(directory, entry.path);
      if (entry.mode === '040000') fs.mkdirSync(target, { mode: 0o700 });
      else {
        const fd = fs.openSync(
          target,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
          entry.mode === '100755' ? 0o700 : 0o600
        );
        try {
          fs.writeFileSync(fd, Buffer.from(entry.bytes, 'base64'));
          fs.fchmodSync(fd, entry.mode === '100755' ? 0o700 : 0o600);
        } finally {
          fs.closeSync(fd);
        }
      }
    }
    const exported = exportSource(directory);
    if (exported.digest !== manifest.digest) throw new CanonicalError('source_changed');
    return exported;
  }
}
