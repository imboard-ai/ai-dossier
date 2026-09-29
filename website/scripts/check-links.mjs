// Post-build check: every internal href/src in dist/ must resolve to a built file.
// Usage: node scripts/check-links.mjs [distDir]
import fs from 'node:fs';
import path from 'node:path';

const dist = path.resolve(process.argv[2] || 'dist');
const htmlFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.html')) htmlFiles.push(p);
  }
})(dist);

const ids = new Map(); // file -> Set of ids
const idsOf = (file) => {
  if (!ids.has(file)) {
    const html = fs.readFileSync(file, 'utf8');
    ids.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  }
  return ids.get(file);
};

const resolve = (urlPath) => {
  const rel = decodeURI(urlPath).replace(/^\//, '');
  for (const c of [rel, path.join(rel, 'index.html'), `${rel}.html`]) {
    const abs = path.join(dist, c);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  }
  return null;
};

const problems = [];
for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');
  const page = `/${path.relative(dist, file)}`;
  for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const url = m[1];
    if (!url.startsWith('/') || url.startsWith('//')) continue;
    const [p, hash] = url.split('#');
    const target = resolve(p.split('?')[0] || '/');
    if (!target) problems.push(`${page}: broken link ${url}`);
    else if (hash && target.endsWith('.html') && !idsOf(target).has(hash))
      problems.push(`${page}: missing anchor ${url}`);
  }
}
if (problems.length) {
  console.error([...new Set(problems)].join('\n'));
  console.error(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`link check ok: ${htmlFiles.length} pages`);
