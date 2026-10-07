import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// website/src/lib/registry.mjs ports core's parser because the site cannot depend on
// @ai-dossier/core. Its own test (website/src/lib/registry.test.mjs) checks the port
// against these expected files; this one checks core against the same files, so the
// two parsers cannot drift apart without one side failing.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(REPO_ROOT, 'website/src/lib/__fixtures__/registry');
const core = createRequire(import.meta.url)(join(REPO_ROOT, 'packages/core/dist/index.js'));

const names = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.ds.md'))
  .map((f) => f.slice(0, -'.ds.md'.length));

function coreLogical(text) {
  try {
    return core.parseDossierContent(text).frontmatter;
  } catch {
    return null;
  }
}

describe('website registry fixtures match core parseDossierContent', () => {
  it('covers legacy, spec-shaped and refused headers', () => {
    expect(names.some((n) => n.startsWith('legacy-'))).toBe(true);
    expect(names.some((n) => n.startsWith('spec-'))).toBe(true);
  });

  for (const name of names) {
    it(name, () => {
      const text = readFileSync(join(FIXTURES, `${name}.ds.md`), 'utf8');
      const expected = JSON.parse(readFileSync(join(FIXTURES, `${name}.expected.json`), 'utf8'));
      expect(coreLogical(text)).toEqual(expected);
    });
  }
});
