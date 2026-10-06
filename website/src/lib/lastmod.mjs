// Last-modified date for a docs page, from git history of its source markdown. Returns undefined
// when git or the file is unavailable (e.g. a tarball build), so callers can omit the field
// instead of inventing a date. On a shallow clone every file reports the clone's tip commit.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cache = new Map();

export function gitLastmod(repoRelPath) {
  if (cache.has(repoRelPath)) return cache.get(repoRelPath);
  let iso;
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', repoRelPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    iso = out || undefined;
  } catch {
    iso = undefined;
  }
  cache.set(repoRelPath, iso);
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
