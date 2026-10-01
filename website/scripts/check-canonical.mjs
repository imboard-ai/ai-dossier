// Post-build check: every canonical / og:url in dist/ (and the sitemap and robots.txt) must use
// the host of SITE_URL (default matches astro.config.mjs). Usage: node scripts/check-canonical.mjs [distDir]
import fs from 'node:fs';
import path from 'node:path';

const expected = new URL(process.env.SITE_URL || 'https://ai-dossier.dev').host;
const dist = path.resolve(process.argv[2] || 'dist');
const bad = [];
let checked = 0;

const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return `(invalid: ${u})`;
  }
};
const flag = (file, u) => {
  checked++;
  if (hostOf(u) !== expected) bad.push(`${path.relative(dist, file)}: ${u}`);
};

(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.html')) {
      const html = fs.readFileSync(p, 'utf8');
      for (const m of html.matchAll(/<link[^>]*rel="canonical"[^>]*href="([^"]+)"/g)) flag(p, m[1]);
      for (const m of html.matchAll(/<meta[^>]*property="og:url"[^>]*content="([^"]+)"/g))
        flag(p, m[1]);
    } else if (/^sitemap.*\.xml$/.test(e.name)) {
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)) flag(p, m[1]);
    } else if (e.name === 'robots.txt') {
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/^Sitemap:\s*(\S+)/gm)) flag(p, m[1]);
    }
  }
})(dist);

if (checked === 0) {
  console.error('check-canonical: found no canonical/sitemap URLs to check');
  process.exit(1);
}
if (bad.length) {
  console.error(
    `check-canonical: ${bad.length} URL(s) not on ${expected}:\n${bad.slice(0, 20).join('\n')}`
  );
  process.exit(1);
}
console.log(`check-canonical: ${checked} URLs all on ${expected}`);
