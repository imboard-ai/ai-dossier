import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildLlmsTxt,
  docDescription,
  firstParagraph,
  jsonLd,
  softwareApplicationSchema,
  techArticleSchema,
  trimTo,
} from './seo.mjs';

test('firstParagraph skips headings, TOC lists, code and short lines', () => {
  const body = `# Title

## Table of Contents
- [A](#a)
- [B](#b)

\`\`\`bash
npm i something long enough to look like prose but it is code
\`\`\`

Short.

A **dossier** is a [signed skill](x.md) that everyone can \`verify\` before they run it.

Second paragraph.`;
  assert.equal(
    firstParagraph(body),
    'A dossier is a signed skill that everyone can verify before they run it.'
  );
});

test('trimTo cuts on a word boundary within the limit', () => {
  const t = trimTo('word '.repeat(60), 155);
  assert.ok(t.length <= 155);
  assert.ok(t.endsWith('…'));
  assert.equal(trimTo('short text'), 'short text');
});

test('docDescription prefers frontmatter, then paragraph, then title', () => {
  assert.equal(
    docDescription({ data: { description: 'From **frontmatter**.' }, body: 'x' }),
    'From frontmatter.'
  );
  const para = 'This paragraph is comfortably longer than forty characters in total.';
  assert.equal(docDescription({ body: `# T\n\n${para}` }), para);
  assert.equal(docDescription({ body: '# T', title: 'T' }), 'T: AI Dossier documentation.');
});

test('jsonLd round-trips and escapes script-closing sequences', () => {
  const s = jsonLd([{ '@type': 'Thing', name: '</script><b>' }]);
  assert.ok(!s.includes('</script>'));
  assert.equal(JSON.parse(s)['@graph'][0].name, '</script><b>');
});

test('software schema carries the required fields', () => {
  const s = softwareApplicationSchema('https://x.dev/', 'd');
  assert.equal(s.applicationCategory, 'DeveloperApplication');
  assert.equal(s.offers.price, '0');
  assert.equal(s.sameAs.length, 3);
});

test('llms.txt follows llmstxt.org shape', () => {
  const t = buildLlmsTxt({
    site: 'https://x.dev/',
    core: [{ title: 'A', url: 'https://x.dev/docs/a/', description: 'about a' }],
    optional: [],
    registryUrl: 'https://x.dev/registry/',
  });
  assert.match(t, /^# AI Dossier\n\n> /);
  assert.match(t, /## Docs\n\n- \[A\]\(https:\/\/x\.dev\/docs\/a\/\): about a/);
  assert.match(t, /## Registry/);
  assert.match(t, /## Install/);
});

test('metadata paragraphs are skipped and purpose labels dropped', () => {
  assert.equal(
    firstParagraph(
      '# T\n\nVersion: 1.0 Status: Stable Last Updated: 2025-01-05 and more words here\n\nPurpose: Experience firsthand why verification matters for dossiers.'
    ),
    'Experience firsthand why verification matters for dossiers.'
  );
});

test('code spans keep underscores and paired emphasis is unwrapped', () => {
  assert.equal(
    docDescription({
      body: '# T\n\nSee `GITHUB_ISSUES_PROPOSAL.md` for the **bold** and _quiet_ and snake_case_name details.',
    }),
    'See GITHUB_ISSUES_PROPOSAL.md for the bold and quiet and snake_case_name details.'
  );
});

test('paragraphs that only introduce a list are skipped', () => {
  assert.equal(
    firstParagraph(
      '# T\n\nYou can use either approach, and most teams use both:\n\n- one\n- two\n\nThis is the real summary paragraph, long enough to qualify.'
    ),
    'This is the real summary paragraph, long enough to qualify.'
  );
});

test('autolinks become plain urls', () => {
  assert.equal(
    firstParagraph(
      '# T\n\nDownload the installer from <https://example.com/install> to get going.'
    ),
    'Download the installer from https://example.com/install to get going.'
  );
});

test('only label: metadata lines are dropped, prose starting with Time or Date is kept', () => {
  const prose = 'Time to first verified run is under a minute on a clean machine.';
  assert.equal(firstParagraph(`# T\n\n${prose}`), prose);
  const prose2 = 'Dates in the registry are always UTC and never localised for readers.';
  assert.equal(firstParagraph(`# T\n\n${prose2}`), prose2);
  assert.equal(
    firstParagraph('# T\n\nTime: 10 minutes Difficulty: easy and some more filler words here'),
    ''
  );
});

test('JSON-LD references the organization and carries the og image', () => {
  const site = 'https://x.dev/';
  const s = softwareApplicationSchema(site, 'd');
  assert.deepEqual(s.author, { '@id': `${site}#organization` });
  assert.deepEqual(s.publisher, { '@id': `${site}#organization` });
  assert.match(s.downloadUrl, /npmjs\.com/);
  const a = techArticleSchema({ url: `${site}docs/a/`, headline: 'h', description: 'd', site });
  assert.deepEqual(a.author, { '@id': `${site}#organization` });
  assert.equal(a.image, `${site}og-image.png`);
  assert.equal('datePublished' in a, false);
  assert.equal('dateModified' in a, false);
});

test('inner-word emphasis markers and globs are content, not markup', () => {
  const t = (body) => firstParagraph(`# T\n\n${body}`);
  assert.equal(
    t('Edit __init__.py and compute 2**3**4 before the release goes out today.'),
    'Edit __init__.py and compute 2**3**4 before the release goes out today.'
  );
  assert.equal(
    t('Match src/*.md, lib/*.ts files when you configure the docs build step.'),
    'Match src/*.md, lib/*.ts files when you configure the docs build step.'
  );
  assert.equal(
    t('Paired __strong__ and **bold** and *em*. still unwrap in the summary text here.'),
    'Paired strong and bold and em. still unwrap in the summary text here.'
  );
});

test('code spans pair their backtick runs and stray placeholders are dropped', () => {
  assert.equal(
    firstParagraph('# T\n\nUse ``a ` b`` literally, and `x_y_z` too, for the full details here.'),
    'Use a ` b literally, and x_y_z too, for the full details here.'
  );
  assert.equal(
    firstParagraph(
      '# T\n\nA stray \uE0009\uE000 marker should not print undefined anywhere in text.'
    ),
    'A stray marker should not print undefined anywhere in text.'
  );
});
