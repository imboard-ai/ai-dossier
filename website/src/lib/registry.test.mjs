import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDossier } from './registry.mjs';

test('parseDossier splits header and body', () => {
  const p = parseDossier('---dossier\n{\n "risk_level": "low"\n}\n---\n# Hi\n');
  assert.equal(p.meta.risk_level, 'low');
  assert.equal(p.body, '# Hi\n');
});

test('parseDossier tolerates junk', () => {
  assert.equal(parseDossier('# no header'), null);
  assert.equal(parseDossier('---dossier\n{oops\n---\n'), null);
});
