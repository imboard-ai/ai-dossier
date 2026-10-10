/** Cross-checks the user guide against the CLI and lifecycle it documents (#1116). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { RUN_STATES } from '../dist/state.js';
import { DEFAULT_LIMITS } from '../dist/vm/adapter.js';
import { main, USAGE } from './zt-run-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '..');
const repo = path.resolve(pkg, '../..');
const guidePath = path.join(repo, 'docs/guides/zero-trust-contributions.md');
const guide = fs.readFileSync(guidePath, 'utf8');

/** First-column code spans of the table rows under a heading, up to the next heading. */
function tableKeys(heading) {
  const start = guide.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, `missing heading ${heading}`);
  const rest = guide.slice(start + heading.length + 2);
  const end = rest.search(/\n#{1,6} /u);
  const section = end === -1 ? rest : rest.slice(0, end);
  return [...section.matchAll(/^\| `([^`]+)` \|/gmu)].map((m) => m[1]);
}

test('the command summary lists exactly the zt-run subcommands', () => {
  const commands = USAGE.match(/<([a-z|-]+)>/u)[1].split('|');
  assert.deepEqual([...tableKeys('## Command summary')].sort(), [...commands].sort());
});

test('every flag in zt-run --help is in its command summary row', async () => {
  const out = [];
  assert.equal(await main(['--help'], { out: (line) => out.push(line), err: () => {} }), 0);
  const rows = out.join('\n').split('\n').slice(1);
  assert.ok(rows.length > 0);
  for (const row of rows) {
    const [command, ...rest] = row.split(' ');
    const line = guide.split('\n').find((l) => l.startsWith(`| \`${command}\` |`));
    assert.ok(line, `no summary row for ${command}`);
    for (const flag of rest.join(' ').match(/--[a-z-]+/gu) ?? [])
      assert.ok(line.includes(`\`${flag}`), `${command} row lacks ${flag}`);
  }
});

test('the state table covers exactly RUN_STATES', () => {
  assert.deepEqual([...tableKeys('## States and hand-offs')].sort(), [...RUN_STATES].sort());
});

test('every closed run-config key and limit is documented', () => {
  const source = fs.readFileSync(path.join(pkg, 'src/controller/config.ts'), 'utf8');
  const lists = [...source.matchAll(/object\(\s*[\w.]+,\s*\[([^\]]+)\]/gu)];
  const keys = new Set(
    lists.flatMap((m) => [...m[1].matchAll(/'([A-Za-z]+)'/gu)].map((k) => k[1]))
  );
  for (const key of Object.keys(DEFAULT_LIMITS)) keys.add(key);
  // The cross-check must actually see the schema, not an empty parse.
  for (const key of ['issueUrl', 'proxyEndpointsFile', 'apiKeyEnv', 'cleanupAllowanceMinor', 'fx'])
    assert.ok(keys.has(key), `parser missed ${key}`);
  for (const key of keys) assert.ok(guide.includes(`\`${key}\``), `guide lacks config key ${key}`);
});

function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /gu, '-');
}
function anchors(text) {
  return new Set([...text.matchAll(/^#{1,6} (.+)$/gmu)].map((m) => slug(m[1])));
}

test('relative links in the guide and its index entries resolve', () => {
  const files = [guidePath, path.join(repo, 'docs/guides/README.md'), path.join(pkg, 'README.md')];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/gu)) {
      if (/^[a-z]+:/u.test(target)) continue;
      const [link, anchor] = target.split('#');
      const resolved = link ? path.resolve(path.dirname(file), link) : file;
      assert.ok(fs.existsSync(resolved), `${path.basename(file)}: broken link ${target}`);
      if (anchor && resolved === guidePath)
        assert.ok(anchors(guide).has(anchor), `broken anchor ${target}`);
    }
  }
  assert.match(
    fs.readFileSync(path.join(pkg, 'README.md'), 'utf8'),
    /zero-trust-contributions\.md/u
  );
  assert.match(
    fs.readFileSync(path.join(repo, 'docs/guides/README.md'), 'utf8'),
    /\(zero-trust-contributions\.md\)/u
  );
});

test('the guide names no IP address or home directory', () => {
  assert.doesNotMatch(guide, /\b\d{1,3}(?:\.\d{1,3}){3}\b/u);
  assert.doesNotMatch(guide, /\/home\/|\/Users\/|~\//u);
});
