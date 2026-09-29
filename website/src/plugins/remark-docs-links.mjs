// Remark plugin: rewrites relative links/images in docs/*.md to site routes or GitHub URLs
// so the markdown under `docs/` renders unmodified (no forked content).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { visit } from 'unist-util-visit';
import { rewriteLink } from '../lib/docs-links.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const docsDir = path.join(repoRoot, 'docs');
const exists = (p) => fs.existsSync(p);

export default function remarkDocsLinks() {
  return (tree, file) => {
    const fromAbs = file.path;
    if (!fromAbs || !path.resolve(fromAbs).startsWith(docsDir + path.sep)) return;
    visit(tree, ['link', 'image'], (node) => {
      node.url = rewriteLink(node.url, {
        fromAbs,
        docsDir,
        repoRoot,
        exists,
        image: node.type === 'image',
        onMissing: (href, repoRel) =>
          console.warn(
            `[docs] broken link in ${path.relative(repoRoot, fromAbs)}: ${href} (${repoRel} does not exist)`
          ),
      });
    });
  };
}
