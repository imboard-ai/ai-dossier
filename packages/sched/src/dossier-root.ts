/**
 * Shared `.dossier/` root resolution (#759).
 *
 * `sched` and `cap` used to resolve `.dossier/automation/manifest.yaml` and the
 * `worktrees/` directory from `process.cwd()` with no upward search, which
 * breaks in nested layouts (`.dossier/` at the project root, source under
 * `main/`). This walks up from a start directory the way git finds `.git`, so
 * every consumer agrees on one root.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface FindDossierRootOptions {
  /** Directory the upward walk never enters (default: the user's home — `~/.dossier` is CLI config, not a project). */
  home?: string;
  /** Existence probe (test seam). */
  exists?: (p: string) => boolean;
}

/**
 * The nearest ancestor of `start` (inclusive) containing a `.dossier/`
 * directory, or `null` when none is found. The walk stops before the home
 * directory and at the filesystem root.
 */
export function findDossierRoot(start: string, opts: FindDossierRootOptions = {}): string | null {
  const home = path.resolve(opts.home ?? os.homedir());
  const exists =
    opts.exists ??
    ((p: string) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  let dir = path.resolve(start);
  for (;;) {
    if (dir === home) return null;
    if (exists(path.join(dir, '.dossier'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The project root for `repoDir`: its `.dossier/` root, falling back to `repoDir` itself. */
export function projectRootFor(repoDir: string, opts?: FindDossierRootOptions): string {
  return findDossierRoot(repoDir, opts) ?? path.resolve(repoDir);
}

/** The `<project root>/worktrees` directory batch worktrees are created under. */
export function worktreesDirFor(repoDir: string, opts?: FindDossierRootOptions): string {
  return path.join(projectRootFor(repoDir, opts), 'worktrees');
}
