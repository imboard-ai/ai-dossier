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

  /** `directory` must be absent under a controller-owned parent. Never merge into an
   * existing tree (including a symlink). Returns the freshly exported candidate. */
  materialize(directory: string): SourceManifest {
    const manifest = createManifest([...this.entries.values()]);
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
