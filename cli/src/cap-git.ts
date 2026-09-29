/**
 * Git state of a capability run's working directory (#941).
 *
 * `caps.jsonl` rows record what was verified: the HEAD commit, its tree, and
 * whether the working tree was dirty when the run started. A dirty run's
 * verdict describes code that was never committed, so `cap last-ok` refuses
 * to reuse it.
 */

import { execFileSync } from 'node:child_process';

export interface CapGitState {
  git_head: string;
  git_tree: string;
  dirty: boolean;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
  }).trim();
}

/** Null when `cwd` is not inside a git work tree (or has no commit yet). */
export function captureGitState(cwd: string): CapGitState | null {
  try {
    if (git(cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
    const git_head = git(cwd, ['rev-parse', 'HEAD']);
    const git_tree = git(cwd, ['rev-parse', 'HEAD^{tree}']);
    const dirty = git(cwd, ['status', '--porcelain']).length > 0;
    return { git_head, git_tree, dirty };
  } catch {
    return null;
  }
}
