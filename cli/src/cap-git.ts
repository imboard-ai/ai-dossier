/**
 * Git state of a capability run's working directory (#941).
 *
 * `caps.jsonl` rows record what was verified: the HEAD commit, its tree, and
 * whether the working tree was dirty. A dirty run's verdict describes code
 * that was never committed, so `cap last-ok` refuses to reuse it.
 *
 * The probe is deliberately paranoid: it must not be fooled by repo/user git
 * config (`status.showUntrackedFiles=no`, submodule ignore), by index flags
 * that hide edits (`--assume-unchanged`, `--skip-worktree`), or by an
 * inherited `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` pointing elsewhere. When
 * the probe itself fails it says so (`git_probe`) and reports dirty — an
 * unknown tree is never a reusable one.
 */

import { spawnSync } from 'node:child_process';

export interface CapGitState {
  git_head: string;
  git_tree: string;
  dirty: boolean;
  /** Set when the probe timed out or errored mid-way; `dirty` is then forced true. */
  git_probe?: 'timeout' | 'error';
}

/** Total wall-clock budget for one probe (all git calls together). */
export const GIT_PROBE_BUDGET_MS = 10_000;

/** GIT_* vars redirect git at another repo/index; the probe must see `cwd`'s own. */
function probeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_')) env[k] = v;
  }
  return env;
}

type GitResult =
  | { ok: true; stdout: string }
  | { ok: false; kind: 'timeout' | 'error' | 'exit'; detail: string };

function git(cwd: string, args: string[], deadline: number): GitResult {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { ok: false, kind: 'timeout', detail: 'probe budget exhausted' };
  const res = spawnSync('git', ['--no-optional-locks', ...args], {
    cwd,
    env: probeEnv(),
    encoding: 'utf8',
    timeout: remaining,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      kind: code === 'ETIMEDOUT' ? 'timeout' : 'error',
      detail: res.error.message,
    };
  }
  if (res.status !== 0) {
    return { ok: false, kind: 'exit', detail: (res.stderr ?? '').trim() };
  }
  return { ok: true, stdout: res.stdout ?? '' };
}

/** `ls-files -v` tags: lowercase = assume-unchanged, `S`/`s` = skip-worktree. */
function hasHiddenIndexFlags(lsFilesV: string): boolean {
  return lsFilesV.split('\0').some((entry) => /^[a-zS]/.test(entry));
}

/**
 * Null when `cwd` is not inside a git work tree, has no commit yet, or git is
 * not installed. A probe that fails after the repo was recognised returns the
 * head/tree it has with `dirty: true` and `git_probe` set (plus a stderr note).
 */
export function captureGitState(cwd: string): CapGitState | null {
  const deadline = Date.now() + GIT_PROBE_BUDGET_MS;
  const ids = git(cwd, ['rev-parse', '--is-inside-work-tree', 'HEAD', 'HEAD^{tree}'], deadline);
  if (!ids.ok) {
    if (ids.kind === 'exit') return null;
    if (ids.kind === 'error') return null; // git missing / not spawnable
    process.stderr.write(`cap: git probe ${ids.kind}: ${ids.detail}\n`);
    return null;
  }
  const [inside, git_head, git_tree] = ids.stdout.trim().split('\n');
  if (inside !== 'true' || !git_head || !git_tree) return null;

  const fail = (r: Extract<GitResult, { ok: false }>): CapGitState => {
    const probe = r.kind === 'timeout' ? 'timeout' : 'error';
    process.stderr.write(
      `cap: git dirty check ${probe}: ${r.detail} — recording the run as dirty\n`
    );
    return { git_head, git_tree, dirty: true, git_probe: probe };
  };

  const status = git(
    cwd,
    ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none'],
    deadline
  );
  if (!status.ok) return fail(status);
  if (status.stdout.length > 0) return { git_head, git_tree, dirty: true };

  const flags = git(cwd, ['ls-files', '-v', '-z'], deadline);
  if (!flags.ok) return fail(flags);
  return { git_head, git_tree, dirty: hasHiddenIndexFlags(flags.stdout) };
}

/**
 * Combine the probes taken before and after a run: the row describes the tree
 * the run STARTED on, and is dirty if either probe was, or if the run moved
 * HEAD or changed the tree under test.
 */
export function mergeGitStates(
  before: CapGitState | null,
  after: CapGitState | null
): CapGitState | null {
  if (!before) return null;
  if (!after) return { ...before, dirty: true, git_probe: before.git_probe ?? 'error' };
  const moved = before.git_head !== after.git_head || before.git_tree !== after.git_tree;
  const probe = before.git_probe ?? after.git_probe;
  return {
    git_head: before.git_head,
    git_tree: before.git_tree,
    dirty: before.dirty || after.dirty || moved,
    ...(probe ? { git_probe: probe } : {}),
  };
}
