/**
 * Restart never discards work (#945 ask 3, #940 ask 1).
 *
 * Before the engine respawns an agent onto a worktree that already exists (a
 * tail, a batch member, a takeover), whatever the dead agent left there is
 * preserved: a WIP commit on `rescue/<unit>-<ts>`, pushed to origin, journaled
 * `work-preserved`, and the respawned agent is told to resume from it instead
 * of resetting to the last pushed head (#920 lost 16 gated-but-uncommitted
 * files to exactly that).
 *
 * The rescue commit is built with a THROWAWAY index (`GIT_INDEX_FILE`), so the
 * worktree, its index and its HEAD are untouched — preservation can never be
 * the thing that loses work, and the respawned agent still finds the files in
 * place. Idempotent: an existing rescue ref for the same unit whose tree equals
 * the current tree is reused, so a respawn loop does not mint a ref per tick.
 * Everything goes through the injected `ExecFn` (never throws), so tests use a
 * real temp repo and the engine's own bounded-timeout exec.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExecFn } from './project';

export interface WorktreeProbe {
  /** Lines of `git status --porcelain` (tracked changes and untracked files). */
  dirty_files: number;
  /** Commits reachable from HEAD that no remote-tracking ref has. */
  unpushed_commits: number;
  head: string;
}

/** Null when `worktree` is not its own git work tree root or git could not be read. */
export function probeWorktree(exec: ExecFn, worktree: string): WorktreeProbe | null {
  const toplevel = exec('git', ['rev-parse', '--show-toplevel'], worktree);
  if (toplevel === null) return null;
  try {
    if (fs.realpathSync(toplevel) !== fs.realpathSync(worktree)) return null;
  } catch {
    return null;
  }
  const head = exec('git', ['rev-parse', 'HEAD'], worktree);
  const status = exec('git', ['--no-optional-locks', 'status', '--porcelain'], worktree);
  const unpushed = exec('git', ['log', 'HEAD', '--not', '--remotes', '--oneline'], worktree);
  if (head === null || status === null || unpushed === null) return null;
  const count = (s: string) => s.split('\n').filter((l) => l.trim().length > 0).length;
  return { dirty_files: count(status), unpushed_commits: count(unpushed), head: head.trim() };
}

export interface PreservedWork {
  /** `rescue/<unit>-<ts>` — the branch holding the WIP commit. */
  ref: string;
  sha: string;
  /** Whether the ref reached origin. False is not fatal: the ref exists locally and the worktree is untouched. */
  pushed: boolean;
  /** An existing rescue ref for the same tree was reused. */
  reused: boolean;
  worktree: string;
  head: string;
  dirty_files: number;
  unpushed_commits: number;
}

export type PreserveOutcome =
  | { kind: 'clean'; probe: WorktreeProbe }
  | { kind: 'skipped'; reason: string }
  | { kind: 'preserved'; work: PreservedWork; probe: WorktreeProbe }
  | { kind: 'failed'; reason: string; probe: WorktreeProbe };

/** `batch:b-20260929-01#601` → `batch-b-20260929-01-601` — safe as a ref component and a path. */
export function rescueUnitSlug(unit: string): string {
  return unit.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unit';
}

export function rescueRefName(unit: string, now: Date): string {
  const ts = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `rescue/${rescueUnitSlug(unit)}-${ts}`;
}

// Positional params ($1 ref, $2 slug, $3 message) — no value is interpolated into the script.
const RESCUE_SCRIPT = `
set -e
idx="$(git rev-parse --git-dir)/sched-rescue-index-$$"
trap 'rm -f "$idx"' EXIT
export GIT_INDEX_FILE="$idx"
git read-tree HEAD
git add -A
tree="$(git write-tree)"
existing="$(git for-each-ref --sort=-creatordate --format='%(objectname) %(tree) %(refname)' "refs/heads/rescue/$2-*" | awk -v t="$tree" '$2 == t { print $1 " " $3; exit }')"
if [ -n "$existing" ]; then
  echo "reused $existing"
  exit 0
fi
commit="$(git -c user.name='ai-dossier sched' -c user.email='sched@ai-dossier.invalid' commit-tree "$tree" -p HEAD -m "$3")"
git update-ref "refs/heads/$1" "$commit"
echo "created $commit refs/heads/$1"
`;

export function preserveWork(
  exec: ExecFn,
  opts: { worktree: string; unit: string; now: Date; push?: boolean }
): PreserveOutcome {
  const probe = probeWorktree(exec, opts.worktree);
  if (probe === null) return { kind: 'skipped', reason: 'not-a-worktree-or-unreadable' };
  if (probe.dirty_files === 0 && probe.unpushed_commits === 0) return { kind: 'clean', probe };

  const ref = rescueRefName(opts.unit, opts.now);
  const message = `WIP rescue: ${opts.unit} (${probe.dirty_files} uncommitted file(s), ${probe.unpushed_commits} unpushed commit(s)) preserved by sched before respawn`;
  const out = exec(
    'sh',
    ['-c', RESCUE_SCRIPT, 'sched-rescue', ref, rescueUnitSlug(opts.unit), message],
    opts.worktree
  );
  const line = out?.split('\n').find((l) => /^(created|reused) /.test(l));
  const parts = line?.split(' ');
  if (!parts || parts.length < 3) {
    return { kind: 'failed', reason: 'could not create the rescue commit', probe };
  }
  const reused = parts[0] === 'reused';
  const sha = parts[1] ?? '';
  const refName = (parts[2] ?? '').replace(/^refs\/heads\//, '');
  const pushed =
    opts.push === false
      ? false
      : exec(
          'git',
          ['push', 'origin', `refs/heads/${refName}:refs/heads/${refName}`],
          opts.worktree
        ) !== null;
  return {
    kind: 'preserved',
    probe,
    work: {
      ref: refName,
      sha,
      pushed,
      reused,
      worktree: opts.worktree,
      head: probe.head,
      dirty_files: probe.dirty_files,
      unpushed_commits: probe.unpushed_commits,
    },
  };
}

/**
 * The instruction appended to a respawned agent's prompt. Refs/paths are
 * engine-derived (rescue names are slugged), never agent- or comment-supplied.
 */
export function preservedWorkInstruction(work: PreservedWork): string {
  const where = work.pushed
    ? `pushed to origin/${work.ref}`
    : `saved locally as branch ${work.ref}`;
  return (
    `PRESERVED WORK — the previous agent for this unit exited leaving ${work.dirty_files} ` +
    `uncommitted file(s) and ${work.unpushed_commits} unpushed commit(s) in ${work.worktree}. ` +
    `The scheduler preserved them as commit ${work.sha} on ${work.ref} (${where}); the ` +
    'worktree still contains them exactly as they were left. RESUME from that state: do not ' +
    'reset, checkout another branch, clean, or re-create the worktree, and never fall back to the ' +
    'last pushed head. Inspect `git status` / `git diff`, commit the work onto your own branch ' +
    `(or \`git merge ${work.ref}\` if the worktree was recreated), and continue. If the worktree ` +
    `directory is gone, \`git worktree add <path> ${work.ref}\`.`
  );
}

/** True when `worktree` is registered in `repoDir`'s `git worktree list` — a path taken from an issue comment is never acted on otherwise. */
export function isRegisteredWorktree(exec: ExecFn, repoDir: string, worktree: string): boolean {
  if (!path.isAbsolute(worktree) || worktree.includes('\0')) return false;
  const list = exec('git', ['worktree', 'list', '--porcelain'], repoDir);
  if (list === null) return false;
  return list
    .split('\n')
    .some((l) => l.startsWith('worktree ') && l.slice('worktree '.length) === worktree);
}

/** The `caps.jsonl` row fields the tail guard reads (`cli/src/cap-log.ts`, #941). */
interface GateRow {
  timestamp?: string;
  capability?: string;
  outcome?: string;
  cwd?: string;
  git_tree?: string;
  dirty?: boolean;
}

/**
 * #940 ask 1: a passing `gate.batch` run in `worktree` that happened AFTER the
 * last pushed head and describes code that is not (only) that head — i.e.
 * gated work an unattended respawn could discard. Precise when the row carries
 * #941's `git_tree`/`dirty`; for an older row without them the timestamp alone
 * is used, and only while the worktree still holds local work. Null when none.
 */
export function findGatedWorkEvidence(opts: {
  capsFile: string;
  worktree: string;
  /** Committer date of the last pushed head (ISO). */
  sinceIso: string;
  /** `HEAD^{tree}` of the worktree now. */
  headTree: string | null;
  /** The worktree holds uncommitted or unpushed work now. */
  hasLocalWork: boolean;
  capability?: string;
}): { timestamp: string; dirty: boolean | null } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(opts.capsFile, 'utf8');
  } catch {
    return null;
  }
  const since = Date.parse(opts.sinceIso);
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let row: GateRow;
    try {
      row = JSON.parse(lines[i] as string) as GateRow;
    } catch {
      continue;
    }
    if (
      row.capability !== (opts.capability ?? 'gate.batch') ||
      row.outcome !== 'ok' ||
      row.cwd !== opts.worktree ||
      typeof row.timestamp !== 'string'
    ) {
      continue;
    }
    const at = Date.parse(row.timestamp);
    if (Number.isNaN(at) || (!Number.isNaN(since) && at <= since)) continue;
    const evidence =
      row.dirty === true
        ? true
        : row.git_tree !== undefined
          ? row.git_tree !== opts.headTree
          : opts.hasLocalWork;
    if (evidence) return { timestamp: row.timestamp, dirty: row.dirty ?? null };
  }
  return null;
}

/** Committer date (ISO) of the last pushed head: the upstream when there is one, else HEAD. Null when unreadable. */
export function pushedHeadDate(exec: ExecFn, worktree: string): string | null {
  const upstream = exec('git', ['log', '-1', '--format=%cI', '@{u}'], worktree);
  if (upstream !== null && upstream.trim() !== '') return upstream.trim();
  const head = exec('git', ['log', '-1', '--format=%cI', 'HEAD'], worktree);
  return head !== null && head.trim() !== '' ? head.trim() : null;
}
