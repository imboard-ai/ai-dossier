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

/** Controller-held baseline and delta; VM reads never enter this map. Model actions
 * only write files; trusted contributor exports also admit deletion/exec-bit changes. */
export class WorkspaceOverlay {
  readonly base: SourceManifest;
  private entries: Map<string, SourceEntry>;
  private readonly written = new Set<string>();
  private readonly removed = new Set<string>();

  /** Controller-exported source only. Retain deletions and exec-bit changes in the delta. */
  replaceSource(source: SourceManifest, touched: readonly string[]): void {
    const manifest = validateManifest(source);
    const entries = new Map(manifest.entries.map((e) => [e.path, e]));
    for (const file of touched) {
      assertWorkspacePath(file);
      if (entries.get(file)?.mode === '040000') throw new CanonicalError('path_collision');
    }
    const touchedSet = new Set(touched);
    const baseline = new Map(
      this.base.entries.filter((e) => e.mode !== '040000').map((e) => [e.path, e])
    );
    for (const file of new Set([...baseline.keys(), ...entries.keys()])) {
      const old = baseline.get(file);
      const next = entries.get(file);
      if (next?.mode === '040000') continue;
      if ((old?.sha256 !== next?.sha256 || old?.mode !== next?.mode) && !touchedSet.has(file))
        throw new CanonicalError('tree_mismatch');
    }
    this.entries = entries;
    for (const file of touched) {
      this.written.add(file);
      if (!entries.has(file)) this.removed.add(file);
      else this.removed.delete(file);
    }
  }
  touchedPaths(): readonly string[] {
    return Object.freeze([...this.written].sort(comparePaths));
  }

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
    this.removed.delete(name);
  }

  executable(file: string): boolean {
    return this.entries.get(assertWorkspacePath(file))?.mode === '100755';
  }

  testFiles(): readonly string[] {
    return Object.freeze([...this.written].filter(isTestPath).sort(comparePaths));
  }

  /** Surviving writes, including byte-identical writes. Use touchedPaths() for the
   * complete delta (including deletions) and conservative drift conflict checks. */
  writtenEntries(): readonly SourceEntry[] {
    return Object.freeze(
      [...this.written]
        .filter((file) => !this.removed.has(file))
        .sort(comparePaths)
        .map((file) => this.entries.get(file) as SourceEntry)
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
    for (const file of this.removed) next.removed.add(file);
    return next;
  }

  /** Replay the held delta in bulk after the caller's upstream conflict check. */
  onBase(base: SourceManifest): WorkspaceOverlay {
    const next = new WorkspaceOverlay(base);
    next.applyEntries(this.writtenEntries());
    for (const file of this.removed) {
      next.entries.delete(file);
      next.removed.add(file);
      next.written.add(file);
    }
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
      next.set(entry.path, Object.freeze({ ...entry }));
    }
    const manifest = createManifest([...next.values()]);
    this.entries = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    for (const entry of writes) {
      this.written.add(entry.path);
      this.removed.delete(entry.path);
    }
  }

  /** Compose a repair workspace into the cumulative contribution delta. The repair
   * must start at our exact candidate; inherited and byte-identical writes remain touched. */
  applyRepair(repair: WorkspaceOverlay): void {
    if (repair.base.digest !== this.manifest().digest) throw new CanonicalError('tree_mismatch');
    const next = this.snapshot();
    next.applyEntries(repair.writtenEntries());
    this.entries = next.entries;
    this.removed.clear();
    for (const file of next.removed) this.removed.add(file);
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
