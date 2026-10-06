// Last-modified date for a docs page, from git history of its source markdown. Returns undefined
// when git or the file is unavailable (e.g. a tarball build), so callers can omit the field
// instead of inventing a date. In a shallow clone (Vercel builds from depth 10) every file last
// changed before the clone window reports the graft-boundary commit, whose date is the clone's,
// not the file's, so those files are reported as unknown rather than given a wrong date.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cache = new Map();
const boundaryCache = new Map();

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/** Hashes of the graft-boundary commits when `cwd` is a shallow clone, else an empty set. */
export function shallowBoundaries(cwd = repoRoot) {
  if (boundaryCache.has(cwd)) return boundaryCache.get(cwd);
  let hashes = new Set();
  try {
    if (git(cwd, ['rev-parse', '--is-shallow-repository']) === 'true') {
      const file = path.resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'shallow']));
      hashes = new Set(readFileSync(file, 'utf8').split(/\s+/).filter(Boolean));
    }
  } catch {
    hashes = new Set();
  }
  boundaryCache.set(cwd, hashes);
  return hashes;
}

export function gitLastmod(repoRelPath, cwd = repoRoot) {
  const key = `${cwd}\0${repoRelPath}`;
  if (cache.has(key)) return cache.get(key);
  let iso;
  try {
    const [hash, date] = git(cwd, ['log', '-1', '--format=%H %cI', '--', repoRelPath]).split(' ');
    iso = hash && date && !shallowBoundaries(cwd).has(hash) ? date : undefined;
  } catch {
    iso = undefined;
  }
  cache.set(key, iso);
  return iso;
}

/** Sitemap page URL (`.../docs/a/b/`) -> lastmod of the markdown file behind it. */
export function docsPageLastmod(pathname) {
  const m = pathname.match(/^\/docs\/(.*?)\/?$/);
  if (!m) return undefined;
  const id = m[1];
  const candidates = id
    ? [`docs/${id}.md`, `docs/${id}/README.md`, `docs/${id}/index.md`]
    : ['docs/index.md', 'docs/README.md'];
  for (const c of candidates) {
    const d = gitLastmod(c);
    if (d) return d;
  }
  return undefined;
}
