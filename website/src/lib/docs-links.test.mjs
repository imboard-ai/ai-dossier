import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  docId,
  docUrl,
  INTERNAL_DOC_PATHS,
  isExcluded,
  isInternalDoc,
  isInternalDocUrl,
  rewriteLink,
} from './docs-links.mjs';

const repoRoot = '/r';
const docsDir = '/r/docs';
const files = new Set([
  '/r/docs/guides/README.md',
  '/r/docs/guides/signing-dossiers.md',
  '/r/docs/planning/roadmap.md',
  '/r/README.md',
]);
const exists = (p) => files.has(p) || p === '/r/docs/guides' || p === '/r/cli';
const ctx = (from) => ({ fromAbs: from, docsDir, repoRoot, exists });

test('docId maps README and index to directory routes', () => {
  assert.equal(docId('guides/README.md'), 'guides');
  assert.equal(docId('index.md'), '');
  assert.equal(docId('reference/schema.md'), 'reference/schema');
  assert.equal(docUrl(''), '/docs/');
});

test('excludes planning internals', () => {
  assert.ok(isExcluded('planning/roadmap.md'));
  assert.ok(!isExcluded('reports/model-scorecard.md'));
});

test('internal docs match by id and by site URL, including nested paths', () => {
  for (const p of INTERNAL_DOC_PATHS) {
    assert.ok(isInternalDoc(p), p);
    assert.ok(isInternalDocUrl(`/docs/${p}/`), p);
    assert.ok(isInternalDocUrl(`/docs/${p}/child/`), p);
  }
  assert.ok(isInternalDoc('reports/evidence/agent-logs-summary'));
  assert.ok(!isInternalDoc('reports-overview'));
  assert.ok(!isInternalDoc('how-to/autonomous-pipelines'));
  assert.ok(!isInternalDoc('guides/signing-dossiers'));
  assert.ok(!isInternalDocUrl('/docs/'));
  assert.ok(!isInternalDocUrl('/docs/contributing/'));
  assert.ok(!isInternalDocUrl('/'));
});

test('relative md links become docs routes and keep anchors', () => {
  const from = '/r/docs/guides/README.md';
  assert.equal(
    rewriteLink('signing-dossiers.md#keys', ctx(from)),
    '/docs/guides/signing-dossiers/#keys'
  );
  assert.equal(rewriteLink('guides/', ctx('/r/docs/index.md')), '/docs/guides/');
});

test('external, anchor and out-of-docs links', () => {
  const from = '/r/docs/guides/README.md';
  assert.equal(rewriteLink('https://x.dev/a', ctx(from)), 'https://x.dev/a');
  assert.equal(rewriteLink('#top', ctx(from)), '#top');
  assert.equal(
    rewriteLink('../../README.md', ctx(from)),
    'https://github.com/imboard-ai/ai-dossier/blob/main/README.md'
  );
  assert.equal(
    rewriteLink('../../cli', ctx(from)),
    'https://github.com/imboard-ai/ai-dossier/tree/main/cli'
  );
  assert.equal(
    rewriteLink('../planning/roadmap.md', ctx(from)),
    'https://github.com/imboard-ai/ai-dossier/blob/main/docs/planning/roadmap.md'
  );
  assert.equal(
    rewriteLink('../../a.png', { ...ctx(from), image: true }),
    'https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/a.png'
  );
});
