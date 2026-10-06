// Post-build guard: internal operator docs (INTERNAL_DOC_PATHS) must not appear in any discovery
// surface — llms.txt, llms-full.txt or the sitemap. Usage: node scripts/check-discovery.mjs [distDir]
import fs from 'node:fs';
import path from 'node:path';
import { INTERNAL_DOC_PATHS, isInternalDocUrl } from '../src/lib/docs-links.mjs';

const dist = path.resolve(process.argv[2] || 'dist');
const bad = [];
let checked = 0;

const check = (file, text, urlPattern) => {
  checked++;
  for (const m of text.matchAll(urlPattern)) {
    let pathname = m[1];
    try {
      pathname = new URL(m[1], 'https://x.invalid').pathname;
    } catch {}
    if (isInternalDocUrl(pathname)) bad.push(`${file}: ${m[1]}`);
  }
};

for (const name of ['llms.txt', 'llms-full.txt']) {
  const file = path.join(dist, name);
  if (!fs.existsSync(file)) {
    console.error(`check-discovery: ${name} missing from ${dist}`);
    process.exit(1);
  }
  check(name, fs.readFileSync(file, 'utf8'), /(?:https?:\/\/[^\s)>"']+)?(\/docs\/[^\s)>"'#?]*)/g);
}
for (const e of fs.readdirSync(dist)) {
  if (/^sitemap.*\.xml$/.test(e)) {
    check(e, fs.readFileSync(path.join(dist, e), 'utf8'), /<loc>[^<]*?(\/docs\/[^<]*)<\/loc>/g);
  }
}

if (checked < 3) {
  console.error('check-discovery: expected llms.txt, llms-full.txt and a sitemap to check');
  process.exit(1);
}
if (bad.length) {
  console.error(
    `check-discovery: ${bad.length} internal doc URL(s) in discovery surfaces:\n${bad.slice(0, 20).join('\n')}`
  );
  process.exit(1);
}
console.log(
  `check-discovery: ${checked} files clean against ${INTERNAL_DOC_PATHS.length} internal paths`
);
