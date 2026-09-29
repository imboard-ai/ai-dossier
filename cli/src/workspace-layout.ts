/**
 * Workspace layout of a target repo, read from its own workspace config (#801) instead of guessed
 * from path shapes. `batch compose` ranks backfill by "shares a workspace package"; the old path
 * heuristic (`…/packages/<x>/…` → `packages/<x>`, else the first path segment) collapsed every path
 * outside `packages/` on imboard's nested layout (`main/packages/…`, `main/scripts/…`) into a
 * pseudo-package `main` that nearly every issue "shared".
 *
 * Pure and dependency-light (only `yaml`): no `gh`, network or fs. The command layer supplies a
 * {@link WorkspaceFileReader} over `gh api repos/<r>/contents/…` (target repo not local) or the
 * local checkout, so discovery is unit-testable with an in-memory reader.
 */

import { parse as parseYaml } from 'yaml';

/** One workspace root: where a package manager's workspace config lives and the globs it declares. */
export interface WorkspaceRoot {
  /** Repo-relative directory holding the config; `''` when it is the repo root, `'main'` on imboard. */
  prefix: string;
  /** Config file the globs came from (`pnpm-workspace.yaml`, `package.json`, `lerna.json`). */
  file: string;
  /** Include globs, e.g. `packages/*`. */
  globs: string[];
  /** `!`-negated globs, without the `!`. */
  excludes: string[];
}

export interface WorkspaceLayout {
  roots: WorkspaceRoot[];
}

/** Config files probed in each candidate directory, in precedence order. */
const CONFIG_FILES = ['pnpm-workspace.yaml', 'package.json', 'lerna.json'] as const;

/** Top-level directories never probed for a nested workspace root — docs/tooling, not code roots. */
const SKIP_DIRS = new Set([
  'node_modules',
  'docs',
  'doc',
  'scripts',
  'test',
  'tests',
  'examples',
  'vendor',
  'dist',
  'build',
  'terraform',
  'infra',
]);

/** Nested roots probed at most (each costs up to three `gh api` reads: pnpm, package.json, lerna). */
const MAX_PROBED_DIRS = 8;
/** Globs kept per root — the config is untrusted-ish network text, keep the output bounded. */
const MAX_GLOBS = 64;

/** Read side of discovery; every method returns null when the thing does not exist or cannot be read. */
export interface WorkspaceFileReader {
  /** Top-level directory names of the repo (no files). */
  topLevelDirs(): string[] | null;
  /** Text of a repo-relative file, or null when absent/unreadable. */
  readFile(path: string): string | null;
}

/** Split declared patterns into includes and `!` excludes; drops non-strings, blanks, and `./` prefixes. */
function toPatterns(value: unknown): { globs: string[]; excludes: string[] } | null {
  if (!Array.isArray(value)) return null;
  const globs: string[] = [];
  const excludes: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim().replace(/^\.\//, '').replace(/\/+$/, '');
    if (trimmed === '' || trimmed === '!') continue;
    if (trimmed.startsWith('!')) excludes.push(trimmed.slice(1).replace(/^\.\//, ''));
    else globs.push(trimmed);
  }
  return globs.length > 0
    ? { globs: globs.slice(0, MAX_GLOBS), excludes: excludes.slice(0, MAX_GLOBS) }
    : null;
}

/**
 * Workspace patterns declared by one config file's text, or null when it declares none.
 * `package.json` accepts both `workspaces: [...]` and the Yarn `workspaces: { packages: [...] }` shape.
 */
export function parseWorkspaceConfig(
  file: (typeof CONFIG_FILES)[number],
  text: string
): { globs: string[]; excludes: string[] } | null {
  try {
    if (file === 'pnpm-workspace.yaml') {
      const doc = parseYaml(text) as { packages?: unknown } | null;
      return toPatterns(doc?.packages);
    }
    const doc = JSON.parse(text) as { workspaces?: unknown; packages?: unknown } | null;
    if (file === 'lerna.json') return toPatterns(doc?.packages);
    const ws = doc?.workspaces;
    return toPatterns(
      Array.isArray(ws) ? ws : (ws as { packages?: unknown } | undefined)?.packages
    );
  } catch {
    return null;
  }
}

function probeRoot(prefix: string, reader: WorkspaceFileReader): WorkspaceRoot | null {
  for (const file of CONFIG_FILES) {
    const text = reader.readFile(prefix === '' ? file : `${prefix}/${file}`);
    if (text === null) continue;
    const patterns = parseWorkspaceConfig(file, text);
    if (patterns !== null) return { prefix, file, ...patterns };
  }
  return null;
}

/**
 * Find the workspace root(s) of a repo: the repo root when it declares workspaces, otherwise each
 * top-level directory that does (imboard's `main/`). Null when no config is found anywhere — the
 * caller then falls back to path heuristics and says so.
 */
export function discoverWorkspaceLayout(reader: WorkspaceFileReader): WorkspaceLayout | null {
  const root = probeRoot('', reader);
  if (root !== null) return { roots: [root] };
  const dirs = (reader.topLevelDirs() ?? [])
    .filter((d) => !d.startsWith('.') && !SKIP_DIRS.has(d))
    .sort()
    .slice(0, MAX_PROBED_DIRS);
  const roots = dirs.map((d) => probeRoot(d, reader)).filter((r): r is WorkspaceRoot => r !== null);
  return roots.length > 0 ? { roots } : null;
}

// --- path → package ----------------------------------------------------------------------------

/** One glob segment as a regex: `*` matches within the segment, everything else literally. */
function segmentMatches(pattern: string, segment: string): boolean {
  if (pattern === segment) return true;
  if (!pattern.includes('*')) return false;
  const re = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${re}$`).test(segment);
}

/**
 * Number of leading path segments a glob claims as the package directory, or null when the path
 * is not under it. A trailing `**` claims the first segment beneath its literal prefix; a `**`
 * elsewhere is treated as `*` (package dirs are one level per pattern segment).
 */
function globMatch(glob: string, segments: string[]): number | null {
  const parts = glob.split('/').filter((p) => p !== '');
  let claimed = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i >= segments.length) return null;
    if (parts[i] === '**') {
      if (i === parts.length - 1) return segments.length > i ? i + 1 : null;
      claimed = i + 1;
      continue;
    }
    if (!segmentMatches(parts[i], segments[i])) return null;
    claimed = i + 1;
  }
  return claimed;
}

/** A trailing segment that looks like a file, so `packages/README.md` is not read as package `README.md`. */
const FILE_LIKE_RE = /\.[A-Za-z0-9]{1,6}$/;

function packageDirIn(root: WorkspaceRoot, relative: string[]): string | null {
  let best: number | null = null;
  for (const glob of root.globs) {
    const n = globMatch(glob, relative);
    if (n === null || (n === relative.length && FILE_LIKE_RE.test(relative[n - 1]))) continue;
    if (best === null || n > best) best = n;
  }
  if (best === null) return null;
  const dir = relative.slice(0, best);
  for (const glob of root.excludes) {
    if (globMatch(glob, dir) === dir.length) return null;
  }
  return dir.join('/');
}

/**
 * The declared workspace package a repo-relative path belongs to, or null when it is outside every
 * declared workspace (root scripts, docs, CI — deliberately NOT a pseudo-package). A path may name
 * the workspace root's directory (`main/packages/x/…`) or omit it (`packages/x/…`, how issue text
 * usually spells it). With more than one root the package is prefixed with its root's directory.
 */
export function packageOfPath(path: string, layout: WorkspaceLayout): string | null {
  const segments = path
    .replace(/^\.\//, '')
    .split('/')
    .filter((s) => s !== '');
  const qualify = (root: WorkspaceRoot, dir: string) =>
    layout.roots.length > 1 && root.prefix !== '' ? `${root.prefix}/${dir}` : dir;
  // Pass 1: a root whose directory the path names. This wins outright, so root ORDER never
  // matters (`main/packages/x` is `main`'s, even when another root's glob would also match it).
  for (const root of layout.roots) {
    const prefixSegments = root.prefix === '' ? [] : root.prefix.split('/');
    if (prefixSegments.length === 0 || !prefixSegments.every((p, i) => segments[i] === p)) continue;
    const dir = packageDirIn(root, segments.slice(prefixSegments.length));
    if (dir !== null) return qualify(root, dir);
  }
  // Pass 2: a root-relative spelling (`packages/x/…`, how issue text usually writes it). Ambiguous
  // across roots (`a` and `b` both declare `packages/*`) means unknown, not "the first root".
  const hits = layout.roots
    .map((root) => [root, packageDirIn(root, segments)] as const)
    .filter((h): h is readonly [WorkspaceRoot, string] => h[1] !== null);
  return hits.length === 1 ? qualify(hits[0][0], hits[0][1]) : null;
}
