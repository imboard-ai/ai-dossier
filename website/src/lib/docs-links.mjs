// Pure helpers that map the repo's `docs/` markdown onto site URLs. Kept free of Astro
// imports so they can be unit tested with `node --test`.
import path from 'node:path';

export const REPO_URL = 'https://github.com/imboard-ai/ai-dossier';
export const RAW_URL = 'https://raw.githubusercontent.com/imboard-ai/ai-dossier/main';

// Paths under docs/ that are internal working notes, not user documentation.
const EXCLUDED = [/^planning(\/|$)/, /^reports\/evidence(\/|$)/];

export function isExcluded(docRelPath) {
  return EXCLUDED.some((re) => re.test(docRelPath));
}

/** docs-relative markdown path -> content id: `guides/README.md` -> `guides`, `index.md` -> ``. */
export function docId(docRelPath) {
  let id = docRelPath.replace(/\\/g, '/').replace(/\.md$/i, '');
  id = id.replace(/(^|\/)README$/i, '');
  if (id === 'index') return '';
  return id.replace(/\/index$/, '');
}

export function docUrl(id) {
  return id ? `/docs/${id}/` : '/docs/';
}

const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/|#)/i;

/**
 * Rewrite a link found in `docs/<fromRel>` (absolute filesystem layout described by
 * `docsDir` and `repoRoot`). `exists(absPath)` reports whether a path is a file or
 * directory. Returns the href to emit.
 */
export function rewriteLink(href, { fromAbs, docsDir, repoRoot, exists, image = false }) {
  if (!href || EXTERNAL.test(href)) return href;
  const hashAt = href.search(/[?#]/);
  const target = decodeURI(hashAt === -1 ? href : href.slice(0, hashAt));
  const suffix = hashAt === -1 ? '' : href.slice(hashAt);
  const abs = target.startsWith('/')
    ? path.join(repoRoot, target)
    : path.resolve(path.dirname(fromAbs), target);
  const repoRel = path.relative(repoRoot, abs).split(path.sep).join('/');
  if (repoRel.startsWith('..')) return href;

  const docRel = path.relative(docsDir, abs).split(path.sep).join('/');
  const insideDocs = !docRel.startsWith('..');

  if (insideDocs && !isExcluded(docRel)) {
    if (/\.md$/i.test(docRel)) return docUrl(docId(docRel)) + suffix;
    // A directory link like `getting-started/` resolves to its README.
    if (exists(abs) && exists(path.join(abs, 'README.md'))) return docUrl(docId(docRel)) + suffix;
  }
  // Anything else (source files, excluded notes, repo-root docs, assets) lives on GitHub.
  const isDir = exists(abs) && !path.extname(abs);
  const base = image ? RAW_URL : `${REPO_URL}/${isDir ? 'tree' : 'blob'}/main`;
  return `${base}/${repoRel}${suffix}`;
}
