/**
 * Restart never discards work (#945 ask 3, #940 ask 1).
 *
 * Before the engine respawns an agent onto a worktree that already exists (a
 * tail, a batch member, a takeover), whatever the dead agent left there is
 * preserved: a WIP commit under `refs/sched-rescue/<unit>-<ts>` (a NON-branch
 * ref namespace: pushing it triggers no CI and appears in no branch list),
 * pushed to origin, journaled `work-preserved`, and the respawned agent is told
 * to resume from it instead of resetting to the last pushed head (#920 lost 16
 * gated-but-uncommitted files to exactly that).
 *
 * SECURITY: a rescue ref that reaches origin is world-readable on a PUBLIC repo,
 * and deleting a ref does NOT unpublish it (GitHub keeps objects reachable by
 * SHA), so the TTL below is housekeeping, not privacy. Therefore:
 *   - only tracked changes (`git add -u`, deletions included) and unpushed
 *     commits are ever PUSHED. A rescue whose tree also holds untracked /
 *     staged-new files stays LOCAL (`refs/sched-rescue/*` in the local repo; the
 *     worktree and its .git survive a respawn anyway);
 *   - as defence in depth the FINAL tree is filtered: any path new relative to
 *     HEAD that matches a secret pattern (`.env*`, `*.pem`, `*.key`, `*token*`,
 *     `*.tfstate`, `kubeconfig`, `.docker/config.json`, …) is dropped, and
 *     untracked files are size/count capped, tracked changes over
 *     {@link RESCUE_MAX_TRACKED_BYTES} are left out. Skips are counted in the
 *     journal and told to the respawned agent.
 * Submodule / nested-repo contents are NOT captured (one commit of the outer repo).
 *
 * TTL: rescue refs are disposable. `pruneRescueRefs` deletes those whose NAME
 * timestamp is older than {@link RESCUE_REF_TTL_MS} (14 days) locally and on
 * origin (listed with `ls-remote`), plus their pushed markers; `sched start`
 * runs it, and the engine repeats it daily outside the state lock.
 *
 * The commit is built with a THROWAWAY index (`GIT_INDEX_FILE`, seeded from the
 * real index), so the worktree, its index and its HEAD are untouched —
 * preservation can never be the thing that loses work. Idempotent: an existing
 * rescue ref for the same unit whose tree equals the current tree is reused, so
 * a respawn loop does not mint (or re-push) a ref per tick. Everything goes
 * through the injected `ExecFn` (never throws), so tests use a real temp repo
 * and the engine's own bounded-timeout exec.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectRootFor } from './dossier-root';
import type { ExecFn } from './project';
import { isSafeWorktree } from './teardown';
import type { SchedState } from './types';

export const RESCUE_REF_PREFIX = 'refs/sched-rescue/';
/** Rescue refs older than this are pruned (locally and on origin). */
export const RESCUE_REF_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Untracked-file caps: anything beyond stays in the worktree and is reported, never pushed. */
export const RESCUE_MAX_FILE_BYTES = 1024 * 1024;
export const RESCUE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const RESCUE_MAX_FILES = 500;
/** A tracked change larger than this is left out of the rescue (the worktree keeps it). */
export const RESCUE_MAX_TRACKED_BYTES = 50 * 1024 * 1024;

export interface WorktreeProbe {
  /** Entries of `git status --porcelain -z` (tracked changes and untracked files). */
  dirty_files: number;
  /** The tracked-change subset of {@link dirty_files} (stray untracked logs excluded). */
  tracked_dirty_files: number;
  /** Commits reachable from HEAD that no remote-tracking ref has. */
  unpushed_commits: number;
  head: string;
  /** git could not report the state (corrupt index, ...): counted dirty, never "clean". */
  unknown?: boolean;
}

const realpath = (p: string): string | null => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

// Counts of NUL-terminated entries, never listings (a huge dirty tree must not overflow the
// exec's output buffer). git's exit status is checked BEFORE counting: a failing `git status`
// piped straight into `wc` would read as "0 dirty files" and a corrupt index as clean.
const STATUS_COUNT_SCRIPT =
  't="$(mktemp)" || exit 1; trap \'rm -f "$t"\' EXIT; ' +
  'git --no-optional-locks status --porcelain -z "$@" > "$t" || exit 1; tr -cd \'\\0\' < "$t" | wc -c';

/** Null when `worktree` is not its own git work tree root (or has no HEAD); `unknown` when git cannot report its state. */
export function probeWorktree(exec: ExecFn, worktree: string): WorktreeProbe | null {
  const toplevel = exec('git', ['rev-parse', '--show-toplevel'], worktree);
  if (toplevel === null) return null;
  const a = realpath(toplevel);
  if (a === null || a !== realpath(worktree)) return null;
  const head = exec('git', ['rev-parse', 'HEAD'], worktree);
  if (head === null) return null;
  const all = exec('sh', ['-c', STATUS_COUNT_SCRIPT, 'sh'], worktree);
  const tracked = exec('sh', ['-c', STATUS_COUNT_SCRIPT, 'sh', '--untracked-files=no'], worktree);
  const unpushed = exec('git', ['rev-list', '--count', 'HEAD', '--not', '--remotes'], worktree);
  const n = (s: string | null) => (s === null ? Number.NaN : Number.parseInt(s.trim(), 10));
  if (Number.isNaN(n(all)) || Number.isNaN(n(tracked)) || Number.isNaN(n(unpushed))) {
    return {
      dirty_files: 1,
      tracked_dirty_files: 1,
      unpushed_commits: 0,
      head: head.trim(),
      unknown: true,
    };
  }
  return {
    dirty_files: n(all),
    tracked_dirty_files: n(tracked),
    unpushed_commits: n(unpushed),
    head: head.trim(),
  };
}

/** Paths new to the tree (untracked / staged-new) that must never be part of a rescue commit. */
const SECRET_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env/i,
  /\.env$/i,
  /\.(pem|key|p12|pfx|jks|keystore|gpg|kdbx|ppk)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)/i,
  /credential/i,
  /secret/i,
  /(^|\/)\.(npmrc|netrc|pgpass|git-credentials)$/i,
  /(^|\/)\.(ssh|aws|gnupg|kube)\//i,
  /\.env\./i,
  /\.(key|pem)\./i,
  /token/i,
  /\.tfstate(\.|$)/i,
  /\.tfvars(\.|$)/i,
  /kubeconfig/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)\.(pypirc|vault-token|htpasswd|s3cfg)$/i,
];

export function isSecretPath(rel: string): boolean {
  return SECRET_PATH_PATTERNS.some((re) => re.test(rel));
}

export interface UntrackedSelection {
  /** Safe to include in the rescue commit. */
  allowed: string[];
  /** Left out of the rescue commit (they stay in the worktree). */
  excluded: string[];
  skipped: { secret: number; large: number; over_limit: number; not_a_file: number };
}

/** Apply the secret-pattern exclusion and the size/count caps to candidate untracked paths. */
export function selectRescuableUntracked(
  worktree: string,
  candidates: string[]
): UntrackedSelection {
  const sel: UntrackedSelection = {
    allowed: [],
    excluded: [],
    skipped: { secret: 0, large: 0, over_limit: 0, not_a_file: 0 },
  };
  let total = 0;
  for (const rel of [...new Set(candidates)].sort()) {
    if (rel === '' || rel.endsWith('/')) {
      // A nested repository / submodule directory: contents are not captured.
      if (rel !== '') {
        sel.excluded.push(rel);
        sel.skipped.not_a_file++;
      }
      continue;
    }
    if (isSecretPath(rel)) {
      sel.excluded.push(rel);
      sel.skipped.secret++;
      continue;
    }
    let size: number;
    try {
      const st = fs.lstatSync(path.join(worktree, rel));
      if (!st.isFile() && !st.isSymbolicLink()) {
        sel.excluded.push(rel);
        sel.skipped.not_a_file++;
        continue;
      }
      size = st.isSymbolicLink() ? 0 : st.size;
    } catch {
      continue; // vanished between listing and stat
    }
    if (size > RESCUE_MAX_FILE_BYTES) {
      sel.excluded.push(rel);
      sel.skipped.large++;
      continue;
    }
    if (sel.allowed.length >= RESCUE_MAX_FILES || total + size > RESCUE_MAX_TOTAL_BYTES) {
      sel.excluded.push(rel);
      sel.skipped.over_limit++;
      continue;
    }
    total += size;
    sel.allowed.push(rel);
  }
  return sel;
}

export interface PreservedWork {
  /** `refs/sched-rescue/<unit>-<ts>` — the (non-branch) ref holding the WIP commit. */
  ref: string;
  sha: string;
  /** Whether the ref reached origin. False is not fatal: the ref exists locally and the worktree is untouched. */
  pushed: boolean;
  /** An existing rescue ref for the same tree was reused. */
  reused: boolean;
  /** The tree holds untracked / staged-new files, so the ref is deliberately NOT pushed (public-repo exposure). */
  local_only: boolean;
  /** Untracked / staged-new files captured in the (local) rescue commit. */
  untracked_included: number;
  worktree: string;
  head: string;
  dirty_files: number;
  unpushed_commits: number;
  /** Untracked files left OUT of the rescue (secret pattern / size caps) — still in the worktree. */
  skipped: UntrackedSelection['skipped'];
}

export type PreserveOutcome =
  | { kind: 'clean'; probe: WorktreeProbe }
  | { kind: 'skipped'; reason: string }
  | { kind: 'preserved'; work: PreservedWork; probe: WorktreeProbe }
  | { kind: 'failed'; reason: string; probe: WorktreeProbe };

/** `batch:b-20260929-01#601` → `batch-b-20260929-01-601` — safe as a ref component and a path. */
export function rescueUnitSlug(unit: string): string {
  // `..`, a leading `.` and `.lock` are invalid in a ref name (`git check-ref-format`).
  return (
    unit
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/^[-.]+|[-.]+$/g, '') || 'unit'
  );
}

/** The ref name below {@link RESCUE_REF_PREFIX}: `<slug>-<UTC timestamp>`. */
export function rescueRefName(unit: string, now: Date): string {
  const ts = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `${rescueUnitSlug(unit)}-${ts}`;
}

// Step 1 builds a throwaway index at $1 seeded from the REAL index ($src is resolved BEFORE
// GIT_INDEX_FILE is exported, or it would point at the throwaway itself and every staged
// rename / intent-to-add would be lost), then applies `add -u`, the allowed untracked list
// ($2), the reset list ($3: over-large tracked changes back to HEAD) and the exclude list
// ($4: secret / capped new files). Lists are NUL-separated pathspec files; GIT_LITERAL_PATHSPECS
// stops a filename containing glob characters from matching other files.
const INDEX_SCRIPT = `
set -e
src="$(git rev-parse --git-path index)"
if [ -f "$src" ]; then cp "$src" "$1"; else GIT_INDEX_FILE="$1" git read-tree HEAD; fi
export GIT_INDEX_FILE="$1"
git add -u
if [ -s "$2" ]; then GIT_LITERAL_PATHSPECS=1 git add --pathspec-from-file="$2" --pathspec-file-nul; fi
if [ -s "$3" ]; then GIT_LITERAL_PATHSPECS=1 git reset -q HEAD --pathspec-from-file="$3" --pathspec-file-nul; fi
if [ -s "$4" ]; then GIT_LITERAL_PATHSPECS=1 git rm --cached -q -f --ignore-unmatch --pathspec-from-file="$4" --pathspec-file-nul; fi
`;

// Step 2 lists the paths NEW to the final index relative to HEAD (A/C/R; renames split so a
// rename INTO a secret name shows up as an add).
const NEW_PATHS_SCRIPT =
  'GIT_INDEX_FILE="$1" git diff-index --cached --no-renames --name-only -z --diff-filter=ACR HEAD';

// Step 3 drops paths ($2 list) from the final index.
const DROP_SCRIPT =
  'GIT_INDEX_FILE="$1" GIT_LITERAL_PATHSPECS=1 git rm --cached -q -f --ignore-unmatch --pathspec-from-file="$2" --pathspec-file-nul';

// Step 4 ($1 index, $2 ref name, $3 slug, $4 message): write the tree, reuse an existing rescue
// for the same unit and tree, else commit-tree + update-ref (must-not-exist, suffix on clash).
const COMMIT_SCRIPT = `
set -e
export GIT_INDEX_FILE="$1"
tree="$(git write-tree)"
existing="$(git for-each-ref --sort=-creatordate --format='%(objectname) %(tree) %(refname)' "refs/sched-rescue/$3-*" | awk -v t="$tree" -v p="refs/sched-rescue/$3-" '$2 == t && index($3, p) == 1 { r = substr($3, length(p) + 1); if (r ~ /^[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z(-[0-9]+)?$/) { print $1 " " $3; exit } }')"
if [ -n "$existing" ]; then
  echo "reused $existing"
  exit 0
fi
commit="$(git -c user.name='ai-dossier sched' -c user.email='sched@ai-dossier.invalid' commit-tree "$tree" -p HEAD -m "$4")"
ref="refs/sched-rescue/$2"
n=1
while ! git update-ref "$ref" "$commit" "" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -gt 20 ]; then exit 1; fi
  ref="refs/sched-rescue/$2-$n"
done
echo "created $commit $ref"
`;

const announced = new WeakMap<object, Set<string>>();
/**
 * True the first time `key` is seen for `scope` (e.g. the journal): a respawn loop that
 * fails the same way every tick journals ONCE per (unit, reason), not once per tick
 * (#610/#630 pattern).
 */
export function firstOccurrence(scope: object, key: string): boolean {
  const set = announced.get(scope) ?? new Set<string>();
  announced.set(scope, set);
  if (set.has(key)) return false;
  set.add(key);
  return true;
}

const splitNul = (s: string | null): string[] => (s ?? '').split('\0').filter((f) => f !== '');

export function preserveWork(
  exec: ExecFn,
  opts: { worktree: string; unit: string; now: Date; push?: boolean }
): PreserveOutcome {
  const probe = probeWorktree(exec, opts.worktree);
  if (probe === null) return { kind: 'skipped', reason: 'not-a-worktree-or-unreadable' };
  if (probe.unknown) {
    return {
      kind: 'failed',
      reason: 'git could not report the worktree state (treated as dirty)',
      probe,
    };
  }
  if (probe.dirty_files === 0 && probe.unpushed_commits === 0) return { kind: 'clean', probe };

  const gitdirOut = exec('git', ['rev-parse', '--absolute-git-dir'], opts.worktree);
  if (gitdirOut === null) return { kind: 'failed', reason: 'could not locate the git dir', probe };
  const gitdir = gitdirOut.trim();
  const candidates = [
    ...splitNul(exec('git', ['ls-files', '-z', '--others', '--exclude-standard'], opts.worktree)),
    ...splitNul(
      exec('git', ['diff', '--cached', '--name-only', '-z', '--diff-filter=A'], opts.worktree)
    ),
  ];
  const sel = selectRescuableUntracked(opts.worktree, candidates);
  // Tracked changes are captured by `add -u`, but a huge one is left out (reset to HEAD's version).
  const largeTracked = splitNul(
    exec('git', ['diff', 'HEAD', '--name-only', '-z', '--diff-filter=MT'], opts.worktree)
  ).filter((rel) => {
    try {
      return fs.lstatSync(path.join(opts.worktree, rel)).size > RESCUE_MAX_TRACKED_BYTES;
    } catch {
      return false;
    }
  });
  const skipped = { ...sel.skipped, large: sel.skipped.large + largeTracked.length };

  const tag = `${process.pid}-${opts.now.getTime()}`;
  const idx = path.join(gitdir, `sched-rescue-index-${tag}`);
  const files = {
    add: path.join(gitdir, `sched-rescue-add-${tag}`),
    reset: path.join(gitdir, `sched-rescue-reset-${tag}`),
    exclude: path.join(gitdir, `sched-rescue-exclude-${tag}`),
    drop: path.join(gitdir, `sched-rescue-drop-${tag}`),
  };
  const nul = (l: string[]) => l.map((f) => `${f}\0`).join('');
  const refName = rescueRefName(opts.unit, opts.now);
  const message = `WIP rescue: ${opts.unit} (${probe.dirty_files} uncommitted file(s), ${probe.unpushed_commits} unpushed commit(s)) preserved by sched before respawn`;
  let out: string | null;
  let newPaths: string[];
  try {
    try {
      fs.writeFileSync(files.add, nul(sel.allowed), { mode: 0o600 });
      fs.writeFileSync(files.reset, nul(largeTracked), { mode: 0o600 });
      fs.writeFileSync(files.exclude, nul(sel.excluded), { mode: 0o600 });
    } catch {
      return { kind: 'failed', reason: 'could not write the rescue pathspec lists', probe };
    }
    const built = exec(
      'sh',
      [
        '-c',
        `${INDEX_SCRIPT}\necho ok`,
        'sched-rescue',
        idx,
        files.add,
        files.reset,
        files.exclude,
      ],
      opts.worktree
    );
    if (built === null)
      return { kind: 'failed', reason: 'could not build the rescue index', probe };
    // Final-tree filter: whatever reached the index (renames, `add -N`, staged-new) is re-checked.
    const listed = exec('sh', ['-c', NEW_PATHS_SCRIPT, 'sched-rescue', idx], opts.worktree);
    if (listed === null) return { kind: 'failed', reason: 'could not list the rescue tree', probe };
    newPaths = splitNul(listed);
    const dropped = newPaths.filter(isSecretPath);
    if (dropped.length > 0) {
      fs.writeFileSync(files.drop, nul(dropped), { mode: 0o600 });
      const rm = exec('sh', ['-c', DROP_SCRIPT, 'sched-rescue', idx, files.drop], opts.worktree);
      if (rm === null) return { kind: 'failed', reason: 'could not filter the rescue tree', probe };
      skipped.secret += dropped.length;
      newPaths = newPaths.filter((p) => !isSecretPath(p));
    }
    out = exec(
      'sh',
      ['-c', COMMIT_SCRIPT, 'sched-rescue', idx, refName, rescueUnitSlug(opts.unit), message],
      opts.worktree
    );
  } finally {
    // Also runs after an exec timeout: the throwaway index is never left behind.
    for (const f of [idx, ...Object.values(files)]) fs.rmSync(f, { force: true });
  }
  const line = out?.split('\n').find((l) => /^(created|reused) /.test(l));
  const parts = line?.split(' ');
  if (!parts || parts.length < 3) {
    return { kind: 'failed', reason: 'could not create the rescue commit', probe };
  }
  const reused = parts[0] === 'reused';
  const sha = parts[1] ?? '';
  const ref = parts[2] ?? '';
  if (!ref.startsWith(RESCUE_REF_PREFIX)) {
    return { kind: 'failed', reason: `unexpected rescue ref '${ref}'`, probe };
  }
  // Only tracked changes + unpushed commits may leave the machine: a tree with untracked /
  // staged-new files stays local (a pushed ref is world-readable on a public repo forever).
  const localOnly = newPaths.length > 0;
  // A reused rescue was pushed (or attempted) on an earlier tick: only push again when no
  // success marker exists, so a respawn loop is not a push per tick.
  const marker = path.join(gitdir, `sched-rescue-pushed-${sha}`);
  let pushed = !localOnly && fs.existsSync(marker);
  if (opts.push !== false && !localOnly && !pushed) {
    pushed = exec('git', ['push', 'origin', `${ref}:${ref}`], opts.worktree) !== null;
    if (pushed) {
      try {
        fs.writeFileSync(marker, `${ref}\n`, { mode: 0o600 });
      } catch {
        // marker is an optimisation only
      }
    }
  }
  return {
    kind: 'preserved',
    probe,
    work: {
      ref,
      sha,
      pushed,
      reused,
      local_only: localOnly,
      untracked_included: newPaths.length,
      worktree: opts.worktree,
      head: probe.head,
      dirty_files: probe.dirty_files,
      unpushed_commits: probe.unpushed_commits,
      skipped,
    },
  };
}

/** Human text for what `preserveWork` deliberately left out ('' when nothing). */
export function skippedSummary(skipped: UntrackedSelection['skipped']): string {
  const parts = [
    skipped.secret > 0 ? `${skipped.secret} matching a secret pattern` : '',
    skipped.large > 0 ? `${skipped.large} over the size cap` : '',
    skipped.over_limit > 0 ? `${skipped.over_limit} beyond the count/size cap` : '',
    skipped.not_a_file > 0 ? `${skipped.not_a_file} nested repo/non-file` : '',
  ].filter(Boolean);
  return parts.length === 0
    ? ''
    : `${parts.join(', ')} file(s) were NOT captured (still in the worktree)`;
}

/**
 * The instruction appended to a respawned agent's prompt. Refs/paths are
 * engine-derived (rescue names are slugged), never agent- or comment-supplied.
 */
export function preservedWorkInstruction(work: PreservedWork): string {
  const where = work.pushed
    ? `pushed to origin as ${work.ref}`
    : `saved locally as ${work.ref}${work.local_only ? ' (local only: it includes untracked files, which are never pushed)' : ''}`;
  const skipped = skippedSummary(work.skipped);
  return (
    `PRESERVED WORK — the previous agent for this unit exited leaving ${work.dirty_files} ` +
    `uncommitted file(s) and ${work.unpushed_commits} unpushed commit(s) in ${work.worktree}. ` +
    `The scheduler preserved them as commit ${work.sha} (${where}); the ` +
    'worktree still contains them exactly as they were left. RESUME from that state: do not ' +
    'reset, checkout another branch, clean, or re-create the worktree, and never fall back to the ' +
    'last pushed head. Inspect `git status` / `git diff`, commit the work onto your own branch ' +
    `(or \`git merge ${work.sha}\` if the worktree was recreated), and continue.${skipped ? ` Note: ${skipped}.` : ''} If the worktree ` +
    `directory is gone, \`git worktree add <path> ${work.sha}\`.`
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

/** Every worktree path the state's batches hold, with the unit that owns it. */
function batchWorktreeClaims(state: SchedState): Array<{ path: string; owner: string }> {
  const claims: Array<{ path: string; owner: string }> = [];
  for (const b of state.batches) {
    const owner = `batch:${b.id}`;
    if (b.worktree) claims.push({ path: b.worktree, owner });
    if (b.member_worktree) claims.push({ path: b.member_worktree, owner });
    for (const r of b.member_runs ?? []) if (r.worktree) claims.push({ path: r.worktree, owner });
  }
  return claims;
}

/**
 * Why a takeover must NOT preserve (and so must not touch) `worktree`, or null
 * when it is safe. The path comes from an issue COMMENT (the run's setup
 * milestone), so it is untrusted: it must be a registered worktree of this
 * repo, under the sanctioned worktree roots, never the main checkout, and not
 * one a batch (another live unit) holds.
 */
export function takeoverWorktreeRefusal(
  exec: ExecFn,
  opts: { repoDir: string; worktree: string; state: SchedState; unit: string }
): string | null {
  const { repoDir, worktree } = opts;
  if (!isRegisteredWorktree(exec, repoDir, worktree)) return 'not-a-registered-worktree';
  const real = realpath(worktree);
  if (real === null) return 'worktree-missing';
  const top = exec('git', ['rev-parse', '--show-toplevel'], repoDir);
  const mainCheckouts = [repoDir, top ?? ''].map(realpath).filter((p): p is string => p !== null);
  if (mainCheckouts.includes(real)) return 'main-checkout';
  const safeRoots = [top ?? repoDir, repoDir].map((r) => path.resolve(r));
  if (
    !safeRoots.some((r) => isSafeWorktree(r, worktree)) &&
    !isSafeWorktree(projectRootFor(repoDir), worktree)
  ) {
    return 'outside-worktree-roots';
  }
  const claim = batchWorktreeClaims(opts.state).find(
    (c) => c.owner !== opts.unit && realpath(c.path) === real
  );
  if (claim) return `claimed-by-${claim.owner}`;
  return null;
}

/**
 * The newest `caps.jsonl` gate row for this worktree decides (#940 ask 1): a
 * passing `gate.batch` run that started on a DIRTY tree, after the last pushed
 * head, while the worktree still holds local work — i.e. gated code that only
 * ever existed uncommitted and that an unattended respawn could discard.
 *
 * Only rows carrying #941's `git_tree`/`dirty` are considered — a legacy row
 * (no git fields) is ignored: the engine's own post-landing gate rows look
 * exactly like that and are not evidence of lost work. A clean row is never
 * evidence either: its code was a commit, which the rescue ref / history keeps.
 * A `git_probe` failure counts as dirty. Only the NEWEST matching row decides,
 * so an old dirty run cannot block after a newer clean/failed one. Worktree
 * paths compare by realpath; a future-dated `sinceIso` (clock skew) is ignored.
 */
export function findGatedWorkEvidence(opts: {
  capsFile: string;
  worktree: string;
  /** Committer date of the last pushed head (ISO). */
  sinceIso: string;
  /** HEAD's tree: a row gated on exactly this tree was committed since, so it is no evidence. */
  headTree?: string | null;
  /** The worktree holds uncommitted or unpushed work now. */
  hasLocalWork: boolean;
  capability?: string;
  now?: Date;
}): { timestamp: string; dirty: boolean | null } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(opts.capsFile, 'utf8');
  } catch {
    return null;
  }
  if (!opts.hasLocalWork) return null;
  const wantCwd = realpath(opts.worktree) ?? opts.worktree;
  const capability = opts.capability ?? 'gate.batch';
  const parsedSince = Date.parse(opts.sinceIso);
  const nowMs = (opts.now ?? new Date()).getTime();
  const since =
    Number.isNaN(parsedSince) || parsedSince > nowMs + 60_000
      ? Number.NEGATIVE_INFINITY
      : parsedSince;
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
      row.capability !== capability ||
      row.git_tree === undefined ||
      typeof row.cwd !== 'string' ||
      typeof row.timestamp !== 'string' ||
      (realpath(row.cwd) ?? row.cwd) !== wantCwd
    ) {
      continue;
    }
    // The newest matching row decides.
    const at = Date.parse(row.timestamp);
    if (Number.isNaN(at) || at <= since || row.outcome !== 'ok') return null;
    // The gated tree is now HEAD's tree: it was committed since, nothing gated is uncommitted.
    if (opts.headTree && row.git_tree === opts.headTree) return null;
    return row.dirty === true || row.git_probe !== undefined
      ? { timestamp: row.timestamp, dirty: true }
      : null;
  }
  return null;
}

/** The `caps.jsonl` row fields the tail guard reads (`cli/src/cap-log.ts`, #941). */
interface GateRow {
  timestamp?: string;
  capability?: string;
  outcome?: string;
  cwd?: string;
  git_tree?: string;
  dirty?: boolean;
  git_probe?: string;
}

/** Committer date (ISO) of the last pushed head: the upstream when there is one, else HEAD (detached HEAD included). Null when unreadable. */
export function pushedHeadDate(exec: ExecFn, worktree: string): string | null {
  const upstream = exec('git', ['log', '-1', '--format=%cI', '@{u}'], worktree);
  if (upstream !== null && upstream.trim() !== '') return upstream.trim();
  const head = exec('git', ['log', '-1', '--format=%cI', 'HEAD'], worktree);
  return head !== null && head.trim() !== '' ? head.trim() : null;
}

const REF_TS = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-\d+)?$/;

/** The mint time encoded in a rescue ref NAME (`<slug>-<UTC ts>[-n]`), or null when it has none. */
export function rescueRefTime(ref: string): number | null {
  const m = REF_TS.exec(ref);
  if (!m) return null;
  const [y = 0, mo = 1, d = 1, h = 0, mi = 0, se = 0] = m.slice(1).map(Number);
  const t = Date.UTC(y, mo - 1, d, h, mi, se);
  return Number.isNaN(t) ? null : t;
}

/** Every git dir of `repoDir`'s repository (main + linked worktrees) — where `sched-rescue-pushed-*` markers live. */
function repoGitDirs(exec: ExecFn, repoDir: string): string[] {
  const common = exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], repoDir);
  if (common === null || common === '') return [];
  const dirs = [common];
  try {
    for (const w of fs.readdirSync(path.join(common, 'worktrees'))) {
      dirs.push(path.join(common, 'worktrees', w));
    }
  } catch {
    // no linked worktrees
  }
  return dirs;
}

/**
 * Delete rescue refs older than `ttlMs` (by the timestamp in the ref NAME),
 * locally and on origin (listed with `git ls-remote`, so refs pushed from other
 * clones are covered), and the `sched-rescue-pushed-<sha>` markers of refs that
 * no longer exist. A ref whose remote deletion FAILED for a reason other than
 * "already gone" is kept so the next prune retries it. Never throws.
 *
 * Housekeeping only: deleting a pushed ref does not unpublish it.
 */
export function pruneRescueRefs(
  exec: ExecFn,
  repoDir: string,
  now: Date,
  ttlMs: number = RESCUE_REF_TTL_MS
): string[] {
  const shaOf = new Map<string, string>();
  const local = exec(
    'git',
    ['for-each-ref', '--format=%(refname) %(objectname)', RESCUE_REF_PREFIX],
    repoDir
  );
  for (const line of (local ?? '').split('\n')) {
    const [ref, sha] = line.trim().split(' ');
    if (ref?.startsWith(RESCUE_REF_PREFIX)) shaOf.set(ref, sha ?? '');
  }
  const hasOrigin = exec('git', ['remote', 'get-url', 'origin'], repoDir) !== null;
  let remoteRefs: Set<string> | null = null;
  if (hasOrigin) {
    const listing = exec('git', ['ls-remote', 'origin', `${RESCUE_REF_PREFIX}*`], repoDir);
    if (listing !== null) {
      remoteRefs = new Set();
      for (const line of listing.split('\n')) {
        const [sha, ref] = line.trim().split(/\s+/);
        if (ref?.startsWith(RESCUE_REF_PREFIX)) {
          remoteRefs.add(ref);
          if (!shaOf.has(ref)) shaOf.set(ref, sha ?? '');
        }
      }
    }
  }
  const pruned: string[] = [];
  const goneShas = new Set<string>();
  for (const [ref, sha] of shaOf) {
    const at = rescueRefTime(ref);
    if (at === null || now.getTime() - at <= ttlMs) continue;
    const onRemote = remoteRefs === null ? hasOrigin : remoteRefs.has(ref);
    if (onRemote && exec('git', ['push', 'origin', '--delete', ref], repoDir) === null) {
      // Failed: only proceed when the remote confirms the ref is already absent.
      const remote = exec('git', ['ls-remote', 'origin', ref], repoDir);
      if (remote === null || remote.trim() !== '') continue;
    }
    if (!local?.includes(`${ref} `) || exec('git', ['update-ref', '-d', ref], repoDir) !== null) {
      pruned.push(ref);
      goneShas.add(sha);
    }
  }
  // Markers: drop those of pruned refs, and any whose sha no rescue ref points at any more.
  const liveShas = new Set([...shaOf].filter(([r]) => !pruned.includes(r)).map(([, sha]) => sha));
  for (const dir of repoGitDirs(exec, repoDir)) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = /^sched-rescue-pushed-([0-9a-f]+)$/.exec(f);
        const msha = m?.[1] ?? '';
        if (m && (goneShas.has(msha) || !liveShas.has(msha))) {
          fs.rmSync(path.join(dir, f), { force: true });
        }
      }
    } catch {
      // unreadable git dir
    }
  }
  return pruned;
}
