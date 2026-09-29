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
 * SECURITY: the rescue commit is pushed to a shared remote and bypasses the
 * pre-commit secret scan, so it captures only
 *   - tracked changes (`git add -u`, including deletions), and
 *   - untracked / staged-new files that do NOT match a secret pattern
 *     (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `*credentials*`,
 *     `*.p12`, `*.pfx`, `*secret*`, …) and fit the size caps.
 * Everything skipped stays in the worktree untouched and is reported (count by
 * reason) in the journal and to the respawned agent. Submodule / nested-repo
 * contents are NOT captured (the rescue is one commit of the outer repo).
 *
 * TTL: rescue refs are disposable. `pruneRescueRefs` deletes those older than
 * {@link RESCUE_REF_TTL_MS} (14 days) locally and on origin; `sched start` runs
 * it at startup.
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

export interface WorktreeProbe {
  /** Lines of `git status --porcelain` (tracked changes and untracked files). */
  dirty_files: number;
  /** Commits reachable from HEAD that no remote-tracking ref has. */
  unpushed_commits: number;
  head: string;
}

const realpath = (p: string): string | null => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

/** Null when `worktree` is not its own git work tree root or git could not be read. */
export function probeWorktree(exec: ExecFn, worktree: string): WorktreeProbe | null {
  const toplevel = exec('git', ['rev-parse', '--show-toplevel'], worktree);
  if (toplevel === null) return null;
  const a = realpath(toplevel);
  if (a === null || a !== realpath(worktree)) return null;
  const head = exec('git', ['rev-parse', 'HEAD'], worktree);
  // Counts, not listings: a huge dirty tree or history must not overflow the exec's output buffer.
  const status = exec('sh', ['-c', 'git --no-optional-locks status --porcelain | wc -l'], worktree);
  const unpushed = exec('git', ['rev-list', '--count', 'HEAD', '--not', '--remotes'], worktree);
  if (head === null || status === null || unpushed === null) return null;
  const n = (s: string) => Number.parseInt(s.trim(), 10);
  if (Number.isNaN(n(status)) || Number.isNaN(n(unpushed))) return null;
  return { dirty_files: n(status), unpushed_commits: n(unpushed), head: head.trim() };
}

/** Untracked/staged-new paths that must never be pushed in a rescue commit. */
const SECRET_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env/i,
  /\.env$/i,
  /\.(pem|key|p12|pfx|jks|keystore|gpg|kdbx|ppk)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)/i,
  /credential/i,
  /secret/i,
  /(^|\/)\.(npmrc|netrc|pgpass|git-credentials)$/i,
  /(^|\/)\.(ssh|aws|gnupg)\//i,
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
  return unit.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unit';
}

/** The ref name below {@link RESCUE_REF_PREFIX}: `<slug>-<UTC timestamp>`. */
export function rescueRefName(unit: string, now: Date): string {
  const ts = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `${rescueUnitSlug(unit)}-${ts}`;
}

// Positional params ($1 ref name, $2 slug, $3 message, $4 add-list, $5 exclude-list,
// $6 pushed-marker dir) — no value is interpolated into the script. The lists are
// NUL-separated pathspec files; GIT_LITERAL_PATHSPECS stops a filename containing
// glob characters from matching other files.
const RESCUE_SCRIPT = `
set -e
gitdir="$(git rev-parse --absolute-git-dir)"
idx="$gitdir/sched-rescue-index-$$"
trap 'rm -f "$idx"' EXIT
export GIT_INDEX_FILE="$idx"
src="$(git rev-parse --git-path index)"
if [ -f "$src" ]; then cp "$src" "$idx"; else git read-tree HEAD; fi
git add -u
if [ -s "$4" ]; then GIT_LITERAL_PATHSPECS=1 git add --pathspec-from-file="$4" --pathspec-file-nul; fi
if [ -s "$5" ]; then GIT_LITERAL_PATHSPECS=1 git rm --cached -q -f --ignore-unmatch --pathspec-from-file="$5" --pathspec-file-nul; fi
tree="$(git write-tree)"
existing="$(git for-each-ref --sort=-creatordate --format='%(objectname) %(tree) %(refname)' "refs/sched-rescue/$2-*" | awk -v t="$tree" -v p="refs/sched-rescue/$2-" '$2 == t && index($3, p) == 1 { r = substr($3, length(p) + 1); if (r ~ /^[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z(-[0-9]+)?$/) { print $1 " " $3; exit } }')"
if [ -n "$existing" ]; then
  echo "reused $existing"
  exit 0
fi
commit="$(git -c user.name='ai-dossier sched' -c user.email='sched@ai-dossier.invalid' commit-tree "$tree" -p HEAD -m "$3")"
ref="refs/sched-rescue/$1"
n=1
while ! git update-ref "$ref" "$commit" "" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -gt 20 ]; then exit 1; fi
  ref="refs/sched-rescue/$1-$n"
done
echo "created $commit $ref"
`;

export function preserveWork(
  exec: ExecFn,
  opts: { worktree: string; unit: string; now: Date; push?: boolean }
): PreserveOutcome {
  const probe = probeWorktree(exec, opts.worktree);
  if (probe === null) return { kind: 'skipped', reason: 'not-a-worktree-or-unreadable' };
  if (probe.dirty_files === 0 && probe.unpushed_commits === 0) return { kind: 'clean', probe };

  const gitdir = exec('git', ['rev-parse', '--absolute-git-dir'], opts.worktree);
  if (gitdir === null) return { kind: 'failed', reason: 'could not locate the git dir', probe };
  const candidates = [
    ...(
      exec('git', ['ls-files', '-z', '--others', '--exclude-standard'], opts.worktree) ?? ''
    ).split('\0'),
    ...(
      exec('git', ['diff', '--cached', '--name-only', '-z', '--diff-filter=A'], opts.worktree) ?? ''
    ).split('\0'),
  ].filter((f) => f !== '');
  const sel = selectRescuableUntracked(opts.worktree, candidates);
  const addList = path.join(gitdir, `sched-rescue-add-${process.pid}`);
  const excludeList = path.join(gitdir, `sched-rescue-exclude-${process.pid}`);
  try {
    fs.writeFileSync(addList, sel.allowed.map((f) => `${f}\0`).join(''), { mode: 0o600 });
    fs.writeFileSync(excludeList, sel.excluded.map((f) => `${f}\0`).join(''), { mode: 0o600 });
  } catch {
    return { kind: 'failed', reason: 'could not write the rescue pathspec lists', probe };
  }

  const refName = rescueRefName(opts.unit, opts.now);
  const message = `WIP rescue: ${opts.unit} (${probe.dirty_files} uncommitted file(s), ${probe.unpushed_commits} unpushed commit(s)) preserved by sched before respawn`;
  let out: string | null;
  try {
    out = exec(
      'sh',
      [
        '-c',
        RESCUE_SCRIPT,
        'sched-rescue',
        refName,
        rescueUnitSlug(opts.unit),
        message,
        addList,
        excludeList,
      ],
      opts.worktree
    );
  } finally {
    fs.rmSync(addList, { force: true });
    fs.rmSync(excludeList, { force: true });
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
  // A reused rescue was pushed (or attempted) on an earlier tick: only push again when no
  // success marker exists, so a respawn loop is not a push per tick.
  const marker = path.join(gitdir, `sched-rescue-pushed-${sha}`);
  let pushed = fs.existsSync(marker);
  if (opts.push !== false && !pushed) {
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
      worktree: opts.worktree,
      head: probe.head,
      dirty_files: probe.dirty_files,
      unpushed_commits: probe.unpushed_commits,
      skipped: sel.skipped,
    },
  };
}

/** Human text for what `preserveWork` deliberately left out ('' when nothing). */
export function skippedSummary(skipped: UntrackedSelection['skipped']): string {
  const parts = [
    skipped.secret > 0 ? `${skipped.secret} matching a secret pattern` : '',
    skipped.large > 0 ? `${skipped.large} over ${RESCUE_MAX_FILE_BYTES} bytes` : '',
    skipped.over_limit > 0 ? `${skipped.over_limit} beyond the count/size cap` : '',
    skipped.not_a_file > 0 ? `${skipped.not_a_file} nested repo/non-file` : '',
  ].filter(Boolean);
  return parts.length === 0
    ? ''
    : `${parts.join(', ')} untracked file(s) were NOT captured (still in the worktree)`;
}

/**
 * The instruction appended to a respawned agent's prompt. Refs/paths are
 * engine-derived (rescue names are slugged), never agent- or comment-supplied.
 */
export function preservedWorkInstruction(work: PreservedWork): string {
  const where = work.pushed ? `pushed to origin as ${work.ref}` : `saved locally as ${work.ref}`;
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
  /** Kept for callers; a clean row is no evidence, so it no longer decides. */
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

/**
 * Delete rescue refs older than `ttlMs`, locally and on origin. A ref whose
 * remote deletion FAILED for a reason other than "already gone" is kept so the
 * next prune retries it. Never throws.
 */
export function pruneRescueRefs(
  exec: ExecFn,
  repoDir: string,
  now: Date,
  ttlMs: number = RESCUE_REF_TTL_MS
): string[] {
  const listing = exec(
    'git',
    ['for-each-ref', `--format=%(refname) %(creatordate:unix)`, RESCUE_REF_PREFIX],
    repoDir
  );
  if (!listing) return [];
  const pruned: string[] = [];
  for (const line of listing.split('\n')) {
    const [ref, unix] = line.trim().split(' ');
    if (!ref || !ref.startsWith(RESCUE_REF_PREFIX) || unix === undefined) continue;
    const ageMs = now.getTime() - Number(unix) * 1000;
    if (!Number.isFinite(ageMs) || ageMs <= ttlMs) continue;
    const hasOrigin = exec('git', ['remote', 'get-url', 'origin'], repoDir) !== null;
    if (hasOrigin && exec('git', ['push', 'origin', '--delete', ref], repoDir) === null) {
      // Failed: only proceed when the remote confirms the ref is already absent.
      const remote = exec('git', ['ls-remote', 'origin', ref], repoDir);
      if (remote === null || remote.trim() !== '') continue;
    }
    if (exec('git', ['update-ref', '-d', ref], repoDir) !== null) pruned.push(ref);
  }
  return pruned;
}
