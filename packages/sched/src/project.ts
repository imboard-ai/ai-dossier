/**
 * Project identity for the scheduler state directory
 * (`~/.dossier/sched/<project>/`).
 *
 * `<project>` follows fleet-cycle's convention exactly: the repo slug
 * `<owner>-<repo>` from `gh repo view --json owner,name`; when that fails (no
 * remote, no `gh`), the basename of `git rev-parse --show-toplevel`.
 *
 * The exec function is injectable so tests (and any non-CLI consumer) never
 * spawn processes. Since #464 these are no longer the package's only
 * subprocesses (dispatch.ts spawns the configured agent; groundtruth.ts execs
 * runstate/gh/git), but all process I/O in the package is injectable, and
 * none of it is an LLM call the scheduler makes itself (AC7).
 */

import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Run a command and return trimmed stdout, or null when it fails (non-zero
 * exit, missing binary). Never throws — callers degrade to their fallback.
 */
export type ExecFn = (file: string, args: string[], cwd?: string) => string | null;

/** Build an `ExecFn` via `execFileSync` (never throws), optionally with a hard timeout and a failure observer. */
export function createExecFn(
  timeoutMs?: number,
  opts?: { onError?: (file: string, args: string[], err: Error) => void }
): ExecFn {
  return (file, args, cwd) => {
    try {
      return String(
        execFileSync(file, args, {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
          ...(cwd ? { cwd } : {}),
        })
      ).trim();
    } catch (err) {
      opts?.onError?.(file, args, err as Error);
      return null;
    }
  };
}

/** Default exec: no timeout. */
export const defaultExec: ExecFn = createExecFn();

/** Characters permitted in a project directory name. */
const SLUG_SAFE = /[^A-Za-z0-9._-]/g;

/**
 * Filesystem-safe form of an arbitrary identifier: everything outside
 * `[A-Za-z0-9._-]` becomes `-`. `.` and `..` survive the character allowlist
 * but are path components that would escape `~/.dossier/sched/` (e.g.
 * `--project ..` → `~/.dossier` itself, overwriting the global CLI config via
 * saveConfig) — those collapse to `default`.
 */
export function sanitizeSlug(slug: string): string {
  const out = slug.replace(SLUG_SAFE, '-');
  if (out === '.' || out === '..') return 'default';
  return out;
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
