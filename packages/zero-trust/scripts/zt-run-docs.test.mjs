/** Cross-checks the user guide against the CLI and lifecycle it documents (#1116).
 * Links inside docs/ are checked by the website build's link check in CI; this test
 * checks the package README, which that build does not render. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { WITHDRAWAL_REASONS } from '../dist/github/track.js';
import { RUN_STATES } from '../dist/state.js';
import { DEFAULT_LIMITS } from '../dist/vm/adapter.js';
import { COMMANDS } from './zt-run-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '..');
const repo = path.resolve(pkg, '../..');
const guide = fs.readFileSync(path.join(repo, 'docs/guides/zero-trust-contributions.md'), 'utf8');
// Headings and table rows outside fenced code blocks only.
const prose = guide.replace(/^```[\s\S]*?^```/gmu, '');

/** Text under a heading, up to the next heading of level 2 or 3. */
function section(heading) {
  const start = prose.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, `missing heading ${heading}`);
  const rest = prose.slice(start + heading.length + 2);
  const end = rest.search(/\n#{2,3} /u);
  return end === -1 ? rest : rest.slice(0, end);
}
/** Table rows under a heading, keyed by their first-column code span. */
function tableRows(heading) {
  return new Map([...section(heading).matchAll(/^\| `([^`]+)` \|.*$/gmu)].map((m) => [m[1], m[0]]));
}
const sorted = (values) => [...values].sort();

test('the command summary lists exactly the zt-run subcommands and their flags', () => {
  const rows = tableRows('## Command summary');
  assert.deepEqual(sorted(rows.keys()), sorted(Object.keys(COMMANDS)));
  for (const [command, spec] of Object.entries(COMMANDS)) {
    const flags = [...rows.get(command).matchAll(/`(--[a-z-]+)/gu)].map((m) => m[1]);
    const expected = [...spec.required, ...spec.optional]
      .filter((flag) => flag !== 'root')
      .map((flag) => `--${flag}`);
    assert.deepEqual(sorted(flags), sorted(expected), `${command} row flags`);
  }
  for (const reason of WITHDRAWAL_REASONS) assert.match(rows.get('withdraw'), new RegExp(reason));
  for (const command of ['approve', 'reject'])
    assert.match(rows.get(command), /<plan\\\|patch\\\|verification>/u, `${command} checkpoints`);
  assert.match(section('## Command summary'), /`--root <stateDir>\/runs`/u);
});

test('the state table covers exactly RUN_STATES', () => {
  assert.deepEqual(sorted(tableRows('## States and hand-offs').keys()), sorted(RUN_STATES));
});

/** Where each closed object in config.ts is documented, by its first argument
 * (`raw` objects by their first key). An unmapped object fails the test. */
const CONFIG_SECTIONS = {
  snapshot: '### Top-level fields',
  'raw:userId': '### Top-level fields',
  'r.executionProfile': '### `executionProfile`',
  'r.modelProfile': '### `modelProfile`',
  'm.phases': '### `modelProfile`',
  'raw:adapter': '### `modelProfile`',
  rate: '### `modelProfile`',
  'rate.fx': '### `modelProfile`',
  'r.budget': '### `budget`',
  'r.limits === undefined ? {} : r.limits': '### `limits`',
  'r.githubApp': '### `githubApp`',
};

test('every closed run-config key is documented in its section', () => {
  const source = fs.readFileSync(path.join(pkg, 'src/controller/config.ts'), 'utf8');
  const calls = [...source.matchAll(/\bobject\(\s*([^,]+?),\s*(\[[^\]]*\]|Object\.keys\(\w+\))/gu)];
  // Every call except the helper's own definition must be parsed.
  assert.equal(calls.length, source.match(/\bobject\(/gu).length - 1, 'unparsed object() call');
  for (const [, arg, list] of calls) {
    const keys = list.startsWith('[')
      ? [...list.matchAll(/'([^'\s]+)'/gu)].map((m) => m[1])
      : [...Object.keys(DEFAULT_LIMITS), 'activeMinutes'];
    const where = CONFIG_SECTIONS[arg === 'raw' ? `raw:${keys[0]}` : arg];
    assert.ok(where, `config.ts object ${arg} has no guide section`);
    const text = section(where);
    for (const key of keys) assert.ok(text.includes(`\`${key}\``), `${where} lacks ${key}`);
  }
});

test('the limits table states the default limits', () => {
  const rows = tableRows('### `limits`');
  for (const [key, value] of Object.entries(DEFAULT_LIMITS))
    assert.match(rows.get(key), new RegExp(`\\| ${value}\\b`, 'u'), `limits ${key}`);
});

test('the package README links resolve and the guide is linked from both indexes', () => {
  const readme = path.join(pkg, 'README.md');
  const text = fs.readFileSync(readme, 'utf8');
  let checked = 0;
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/gu)) {
    if (/^[a-z]+:|^#/u.test(target)) continue;
    const resolved = path.resolve(path.dirname(readme), target.split('#')[0]);
    assert.ok(fs.existsSync(resolved), `README: broken link ${target}`);
    checked++;
  }
  assert.ok(checked > 0, 'no README links checked');
  assert.match(text, /\(\.\.\/\.\.\/docs\/guides\/zero-trust-contributions\.md\)/u);
  assert.match(
    fs.readFileSync(path.join(repo, 'docs/guides/README.md'), 'utf8'),
    /\(zero-trust-contributions\.md\)/u
  );
});

test('the guide names no IP address or home directory', () => {
  assert.doesNotMatch(guide, /\b\d{1,3}(?:\.\d{1,3}){3}\b/u);
  assert.doesNotMatch(guide, /\/home\/|\/Users\/|~\//u);
});
