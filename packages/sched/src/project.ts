/**
 * Project identity for the scheduler state directory
 * (`~/.dossier/sched/<project>/`).
 *
 * `<project>` follows fleet-cycle's convention exactly: the repo slug
 * `<owner>-<repo>` from `gh repo view --json owner,name`; when that fails (no
 * remote, no `gh`), the basename of `git rev-parse --show-toplevel`.
 *
 * The exec function is injectable so tests (and any non-CLI consumer) never
 * spawn processes. These are the ONLY subprocesses in this package — and they
 * are `gh`/`git`, never an LLM (AC7).
 */

import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Run a command and return trimmed stdout, or null when it fails (non-zero
 * exit, missing binary). Never throws — slug resolution degrades to the
 * fallback.
 */
export type ExecFn = (file: string, args: string[], cwd?: string) => string | null;

/** Default exec via `execFileSync`, swallowing failures. */
export const defaultExec: ExecFn = (file, args, cwd) => {
  // Lazy import so pure-logic consumers of this module never load child_process.
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  try {
    return String(
      execFileSync(file, args, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(cwd ? { cwd } : {}),
      })
    ).trim();
  } catch {
    return null;
  }
};

/** Characters permitted in a project directory name. */
const SLUG_SAFE = /[^A-Za-z0-9._-]/g;

function sanitizeSlug(slug: string): string {
  return slug.replace(SLUG_SAFE, '-');
}

/**
 * Resolve the project slug for `cwd` (default: process cwd). `gh` first, git
 * basename as fallback; a final sanitized non-empty string otherwise.
 */
export function resolveProjectSlug(exec: ExecFn = defaultExec, cwd?: string): string {
  const ghOut = exec('gh', ['repo', 'view', '--json', 'owner,name'], cwd);
  if (ghOut !== null) {
    try {
      const parsed = JSON.parse(ghOut) as { owner?: { login?: unknown }; name?: unknown };
      const owner = parsed.owner?.login;
      if (typeof owner === 'string' && typeof parsed.name === 'string') {
        const slug = sanitizeSlug(`${owner}-${parsed.name}`);
        if (slug.length > 0) return slug;
      }
    } catch {
      // fall through to git
    }
  }
  const root = exec('git', ['rev-parse', '--show-toplevel'], cwd);
  if (root !== null && root.length > 0) {
    const slug = sanitizeSlug(path.basename(root));
    if (slug.length > 0) return slug;
  }
  return 'default';
}

/** State directory for one project under the dossier home (testable via `home`). */
export function schedStateDir(project: string, home: string = os.homedir()): string {
  return path.join(home, '.dossier', 'sched', sanitizeSlug(project));
}
