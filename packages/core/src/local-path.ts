/**
 * Keep local filesystem paths out of public GitHub comments (#1085).
 *
 * Runstate milestones, plan artifacts and sched alerts are issue comments, and in a public
 * repository every byte of them is published. An absolute path such as a worktree under the
 * operator's home directory leaks the user name and directory layout. So every writer
 * rewrites a local path into a PORTABLE form before posting, and every reader resolves that
 * form back against the machine it runs on — never against the posted string:
 *
 * - `<repo>/<relative>` — inside the repository's main checkout, or in the `worktrees/`
 *   directory beside it (the `<project>/main` + `<project>/worktrees/<x>` layout gives
 *   `<repo>/../worktrees/<x>`);
 * - `<local>/<basename>` — anywhere else; resolvable only by matching a local worktree.
 *
 * {@link redactHomePaths} is the generic backstop: whatever a caller forgot to rewrite, a
 * home-directory path never reaches a posted body.
 *
 * Pure apart from `os.homedir()` as a default: callers run the git commands that find the
 * anchor (the main checkout root) and the worktree list, so this stays unit-testable.
 */

import * as os from 'node:os';
import * as path from 'node:path';

/** Prefix of a path recorded relative to the repository's main checkout. */
export const REPO_PATH_TOKEN = '<repo>';
/** Prefix of a path outside the repository; only its basename is kept. */
export const LOCAL_PATH_TOKEN = '<local>';

/** Characters that may appear in a path embedded in free text (stops at quotes, brackets, `,`, `;`). */
const PATH_CHAR = String.raw`[^\s'"\x60<>()\[\]{}|,;]`;
/** A path segment (no separator). */
const SEGMENT = String.raw`[^\s'"\x60<>()\[\]{}|,;/\\]`;

/**
 * Home-directory paths matched on any machine. Each pattern captures (group 1, when it has
 * one) the rest of the path after the user name:
 * - `/home/<user>`, `/Users/<user>`, plus the WSL / git-bash / ostree spellings
 *   `/mnt/c/Users/<user>`, `/c/Users/<user>`, `/var/home/<user>`;
 * - `C:\Users\<user>` (either slash);
 * - a UNC path whose share contains `home\<user>` or `Users\<user>` (`\\wsl.localhost\…`);
 * - a dash-encoded directory name carrying the path, `-home-<user>-…` (agent tools name
 *   per-project directories that way). It has no group: the whole name becomes `<local>`,
 *   since where the user name ends inside it is unknowable.
 *
 * The lookbehinds keep a URL (`example.com/home/x`) and an already-portable value
 * (`<repo>/home/x`) from matching, which is what makes redaction idempotent.
 */
const HOME_PATTERNS: readonly string[] = [
  String.raw`(?<![\w.~>-])(?:/mnt/[A-Za-z]|/[A-Za-z]|/var)?/(?:home|Users)/${SEGMENT}+((?:/${PATH_CHAR}*)?)`,
  String.raw`(?<![\w])[A-Za-z]:[\\/]+[Uu]sers[\\/]+${SEGMENT}+((?:[\\/]${PATH_CHAR}*)?)`,
  String.raw`(?<![\w])\\\\[^\\\s'"]+\\(?:[^\\\s'"]+\\)*?(?:home|[Uu]sers)\\${SEGMENT}+((?:\\${PATH_CHAR}*)?)`,
  String.raw`(?<![\w.])-(?:home|Users)-${SEGMENT}+`,
];

/** The directory beside the main checkout that holds its worktrees (`<project>/worktrees`). */
const SIBLING_WORKTREES_DIR = 'worktrees';

/** Directories whose children are user names. */
const HOME_ROOTS: ReadonlySet<string> = new Set(['/home', '/Users']);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The current user's home, when it is a real directory path worth matching. */
function defaultHomes(): string[] {
  try {
    const home = os.homedir();
    return home && home !== '/' && home.length > 1 ? [home] : [];
  } catch {
    return [];
  }
}

function homeRegex(homes: readonly string[]): RegExp {
  const extra = homes
    .filter((h) => h.length > 1 && h !== '/')
    .map(
      (h) =>
        String.raw`(?<![\w./-])${escapeRegExp(h.replace(/[\\/]+$/, ''))}((?:[\\/]${PATH_CHAR}*)?)(?=$|[^\w.-])`
    );
  return new RegExp([...HOME_PATTERNS, ...extra].join('|'), 'g');
}

export interface LocalPathOptions {
  /**
   * The repository's main checkout root — `dirname(git rev-parse --git-common-dir)`, the
   * one directory every worktree of the repo agrees on. `null` when not in a repository.
   */
  anchor?: string | null;
  /** Extra home directories to treat as private (default: the current user's home). */
  homes?: readonly string[];
}

/** True when `text` contains a home-directory path. */
export function containsHomePath(text: string, opts: LocalPathOptions = {}): boolean {
  return homeRegex(opts.homes ?? defaultHomes()).test(text);
}

function lastSegment(rest: string): string {
  const parts = rest.split(/[\\/]+/).filter((p) => p.length > 0);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : '';
}

function localToken(rest: string): string {
  const name = lastSegment(rest);
  return name ? `${LOCAL_PATH_TOKEN}/${name}` : LOCAL_PATH_TOKEN;
}

/** Whether `p` is `dir` or below it. */
function isWithin(dir: string, p: string): boolean {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

/** True for a value already in portable form. */
export function isPortablePath(value: string): boolean {
  return (
    value === REPO_PATH_TOKEN ||
    value.startsWith(`${REPO_PATH_TOKEN}/`) ||
    value === LOCAL_PATH_TOKEN ||
    value.startsWith(`${LOCAL_PATH_TOKEN}/`)
  );
}

/**
 * Rewrite a local path into its portable, publishable form.
 *
 * A relative `value` is resolved against `cwd` first (when given; otherwise it is returned
 * unchanged — it carries no absolute prefix to leak). An already-portable value is returned
 * as is. The result never contains a home-directory path.
 */
export function toPortablePath(
  value: string,
  opts: LocalPathOptions & { cwd?: string } = {}
): string {
  if (isPortablePath(value)) return value;
  if (!path.isAbsolute(value)) {
    if (opts.cwd === undefined) return value;
    value = path.resolve(opts.cwd, value);
  }
  const abs = path.resolve(value);
  const homes = opts.homes ?? defaultHomes();
  const anchor = opts.anchor ? path.resolve(opts.anchor) : null;
  if (anchor !== null) {
    let candidate: string | null = null;
    if (isWithin(anchor, abs)) {
      const rel = path.relative(anchor, abs);
      candidate = rel === '' ? REPO_PATH_TOKEN : `${REPO_PATH_TOKEN}/${toPosix(rel)}`;
    } else {
      // Only the sibling `worktrees/` directory (the layout `isSafeWorktree` in sched also
      // accepts): any other neighbour of the checkout would publish that folder's name.
      const siblings = path.join(path.dirname(anchor), SIBLING_WORKTREES_DIR);
      if (isWithin(siblings, abs)) {
        candidate = `${REPO_PATH_TOKEN}/../${toPosix(path.relative(path.dirname(anchor), abs))}`;
      }
    }
    if (candidate !== null && !containsHomePath(candidate, { homes })) return candidate;
  }
  // Outside the repository: keep only the basename — and never a user name, which is
  // what the basename of a home directory itself would be.
  for (const home of homes) {
    if (abs === path.resolve(home)) return LOCAL_PATH_TOKEN;
  }
  if (HOME_ROOTS.has(path.dirname(abs))) return LOCAL_PATH_TOKEN;
  return localToken(abs);
}

/**
 * Resolve a recorded path (portable or legacy absolute) against THIS machine.
 *
 * `<repo>/…` resolves against `anchor`; `<local>/<name>` matches the one local worktree
 * whose basename is `<name>` (none or several → `null`); a legacy absolute path is returned
 * normalized; any other relative value resolves against `anchor`. A `<repo>/…` value that
 * lands outside the checkout and its sibling `worktrees/` directory is refused (`null`) —
 * the recorded string comes from an issue comment and must not steer a caller anywhere.
 */
export function resolvePortablePath(
  value: string,
  opts: { anchor?: string | null; worktrees?: readonly string[] } = {}
): string | null {
  if (value.length === 0 || value.includes('\0')) return null;
  const anchor = opts.anchor ? path.resolve(opts.anchor) : null;
  if (value === LOCAL_PATH_TOKEN || value.startsWith(`${LOCAL_PATH_TOKEN}/`)) {
    const name = value.slice(LOCAL_PATH_TOKEN.length + 1);
    if (!name || /[\\/]/.test(name) || name === '.' || name === '..') return null;
    const matches = (opts.worktrees ?? []).filter((w) => path.basename(w) === name);
    return matches.length === 1 ? path.resolve(matches[0] as string) : null;
  }
  if (path.isAbsolute(value)) return path.resolve(value);
  if (anchor === null) return null;
  const rel =
    value === REPO_PATH_TOKEN
      ? ''
      : value.startsWith(`${REPO_PATH_TOKEN}/`)
        ? value.slice(REPO_PATH_TOKEN.length + 1)
        : value;
  const resolved = path.resolve(anchor, rel);
  const siblings = path.join(path.dirname(anchor), SIBLING_WORKTREES_DIR);
  return isWithin(anchor, resolved) || isWithin(siblings, resolved) ? resolved : null;
}

/**
 * Replace every home-directory path in `text` with its portable form: `<repo>/…` when it is
 * inside the repository (`opts.anchor`), otherwise `<local>/<basename>`. Trailing sentence
 * punctuation stays outside the replacement. Idempotent.
 */
export function redactHomePaths(text: string, opts: LocalPathOptions = {}): string {
  const homes = opts.homes ?? defaultHomes();
  return text.replace(homeRegex(homes), (match: string, ...groups: unknown[]) => {
    const trail = /[.:!?]+$/.exec(match)?.[0] ?? '';
    const core = trail ? match.slice(0, -trail.length) : match;
    // `groups` is the capture groups, then the offset and the whole input (no named groups
    // are used). At most one alternative matched, so the first string group is its rest.
    const rest = groups.slice(0, -2).find((g): g is string => typeof g === 'string') ?? '';
    const restCore = trail && rest.endsWith(trail) ? rest.slice(0, -trail.length) : rest;
    if (core.startsWith('/') && opts.anchor) {
      return toPortablePath(core, { anchor: opts.anchor, homes }) + trail;
    }
    return localToken(restCore) + trail;
  });
}

/**
 * The `<repo>` anchor from `git rev-parse --path-format=absolute --git-common-dir` output:
 * the common dir's parent for an ordinary repository, the common dir itself for a bare one.
 * `null` for a failed or non-absolute answer.
 */
export function anchorFromCommonDir(stdout: string | null | undefined): string | null {
  const common = stdout?.trim() ?? '';
  if (!path.isAbsolute(common)) return null;
  return path.basename(common) === '.git' ? path.dirname(common) : common;
}

/** Worktree paths listed by `git worktree list --porcelain` output (`[]` for none/failure). */
export function parseWorktreePorcelain(stdout: string | null | undefined): string[] {
  return (stdout ?? '')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}
