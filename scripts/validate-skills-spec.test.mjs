import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  asWritten,
  errorKeys,
  errorLines,
  findDossiers,
  skillName,
  summarize,
} from './validate-skills-spec.mjs';

describe('skillName', () => {
  it('reads the name from YAML frontmatter', () => {
    expect(skillName('---\nname: git-sync\ndescription: x\n---\nbody')).toBe('git-sync');
  });
  it('handles a quoted name', () => {
    expect(skillName('---\nname: "git-sync"\n---\nbody')).toBe('git-sync');
  });
  it('returns null for raw ---dossier JSON', () => {
    expect(skillName('---dossier\n{"name": "x"}\n---\nbody')).toBeNull();
  });
});

describe('errorLines', () => {
  it('keeps only the bullet lines of validator output', () => {
    const out =
      'Validation failed for /tmp/x:\n  - Unexpected fields in frontmatter: a, b.\n  - Other.\n';
    expect(errorLines(out)).toEqual(['Unexpected fields in frontmatter: a, b.', 'Other.']);
  });
  it('is empty for a clean pass', () => {
    expect(errorLines('')).toEqual([]);
  });
});

describe('errorKeys', () => {
  it('explodes the unexpected-fields error into one key per field', () => {
    const e = "Unexpected fields in frontmatter: a, b. Only ['name'] are allowed.";
    expect(errorKeys(e)).toEqual(['Unexpected top-level key: a', 'Unexpected top-level key: b']);
  });
  it('passes other errors through, first line only', () => {
    expect(errorKeys('Missing required field in frontmatter: name\nmore')).toEqual([
      'Missing required field in frontmatter: name',
    ]);
  });
});

describe('summarize', () => {
  it('tallies files per key, most common first', () => {
    const only = (f) => `Unexpected fields in frontmatter: ${f}. Only ['name'] are allowed.`;
    const s = summarize([
      { file: 'a.ds.md', errors: [only('x, y')] },
      { file: 'b.ds.md', errors: [only('x'), 'Other'] },
      { file: 'c.ds.md', errors: [] },
    ]);
    expect(s.total).toBe(3);
    expect(s.failed).toBe(2);
    expect(s.byError.get('Unexpected top-level key: x')).toEqual(['a.ds.md', 'b.ds.md']);
    expect(s.byError.get('Unexpected top-level key: y')).toEqual(['a.ds.md']);
    expect([...s.byError.keys()][0]).toBe('Unexpected top-level key: x');
  });
});

describe('findDossiers', () => {
  const root = mkdtempSync(join(tmpdir(), 'vss-test-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('finds nested .ds.md files only, sorted', () => {
    mkdirSync(join(root, 'a/b'), { recursive: true });
    writeFileSync(join(root, 'z.ds.md'), '');
    writeFileSync(join(root, 'a/b/y.ds.md'), '');
    writeFileSync(join(root, 'a/readme.md'), '');
    expect(findDossiers(root)).toEqual([join(root, 'a/b/y.ds.md'), join(root, 'z.ds.md')]);
  });
});

describe('asWritten', () => {
  it('renders the logical frontmatter minus its signature, naming it from the file', () => {
    const calls = [];
    const parsed = {
      frontmatter: { title: 'T', signature: { covers: 'frontmatter+body' } },
      body: '# B\n',
    };
    const core = {
      parseDossierContent: () => parsed,
      withSkillIdentity: (fm, source) => ({ ...fm, name: source }),
      renderSpecDossier: (fm, body, original) => {
        calls.push({ fm, body, original });
        return 'rendered';
      },
    };
    expect(asWritten('content', 'examples/x.ds.md', core)).toBe('rendered');
    expect(calls).toEqual([
      { fm: { title: 'T', name: 'examples/x.ds.md' }, body: '# B\n', original: parsed },
    ]);
  });
});
