import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseDossier, shape, validName } from './registry.mjs';

// Shared with scripts/website-registry-parity.test.mjs, which pins core's
// parseDossierContent to the same expected logical frontmatter (null = refused).
const FIXTURES = new URL('./__fixtures__/registry/', import.meta.url);
const fixture = (name) => readFileSync(new URL(`${name}.ds.md`, FIXTURES), 'utf8');
const fixtureNames = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.ds.md'))
  .map((f) => f.slice(0, -'.ds.md'.length));

test('parseDossier splits header and body', () => {
  const p = parseDossier('---dossier\n{\n "risk_level": "low"\n}\n---\n# Hi\n');
  assert.equal(p.meta.risk_level, 'low');
  assert.equal(p.body, '# Hi\n');
  assert.equal(p.shape, 'legacy');
});

test('parseDossier tolerates junk', () => {
  assert.equal(parseDossier('# no header'), null);
  assert.equal(parseDossier('---dossier\n{oops\n---\n'), null);
  assert.equal(parseDossier('---js\nmodule.exports = {}\n---\n'), null);
});

for (const name of fixtureNames) {
  test(`parseDossier matches core's logical frontmatter: ${name}`, () => {
    const expected = JSON.parse(readFileSync(new URL(`${name}.expected.json`, FIXTURES), 'utf8'));
    assert.deepEqual(parseDossier(fixture(name))?.meta ?? null, expected);
  });
}

const entry = { name: 'imboard-ai/test/fixture', url: 'https://example.com/fixture.ds.md' };

test('a spec-shaped dossier keeps its risk, checksum and v3 signature details', () => {
  const d = shape(entry, parseDossier(fixture('spec-v3')));
  assert.equal(d.detailLoaded, true);
  assert.equal(d.headerShape, 'spec');
  assert.equal(d.objective, 'Exercise the registry page parser');
  assert.equal(d.status, 'Stable');
  assert.equal(d.riskLevel, 'medium');
  assert.deepEqual(d.riskFactors, ['network_access', 'modifies_files']);
  assert.equal(d.requiresApproval, true);
  assert.equal(d.checksum, `sha256:${'0f'.repeat(32)}`);
  assert.equal(d.signature.algorithm, 'ed25519');
  assert.equal(d.signature.keyId, 'fixture-key');
  assert.equal(d.signature.signedBy, 'Fixture Signer');
  assert.equal(d.signature.covers, 'spec-frontmatter+body');
  assert.equal(d.signature.scheme, 'v3');
});

test('legacy dossiers report the v1 and v2 signature schemes', () => {
  const v1 = shape(entry, parseDossier(fixture('legacy-v1')));
  assert.equal(v1.headerShape, 'legacy');
  assert.equal(v1.checksum, `sha256:${'0f'.repeat(32)}`);
  assert.equal(v1.signature.covers, 'body');
  assert.equal(v1.signature.scheme, 'v1');
  const v2 = shape(entry, parseDossier(fixture('legacy-v2')));
  assert.equal(v2.signature.covers, 'frontmatter+body');
  assert.equal(v2.signature.scheme, 'v2');
});

test('an unknown signature scheme is labelled, not guessed', () => {
  const parsed = { meta: { signature: { algorithm: 'ed25519', covers: 'constructor' } } };
  assert.equal(shape(entry, parsed).signature.scheme, 'unrecognized');
  const odd = { meta: { signature: { algorithm: 'ed25519', covers: ['body'] } } };
  assert.equal(shape(entry, odd).signature.scheme, 'unrecognized');
  assert.equal(shape(entry, odd).signature.covers, '["body"]');
});

test('a refused spec-shaped header falls back to the registry entry', () => {
  const d = shape(entry, parseDossier(fixture('spec-stray-field')));
  assert.equal(d.detailLoaded, false);
  assert.equal(d.riskLevel, 'unknown');
  assert.equal(d.signature, null);
});

test('validName rejects traversal and odd characters', () => {
  assert.ok(validName('imboard-ai/devops/provision-arm-vps'));
  assert.ok(!validName('../x'));
  assert.ok(!validName('a/../b'));
  assert.ok(!validName('a b'));
  assert.ok(!validName('/abs'));
});
