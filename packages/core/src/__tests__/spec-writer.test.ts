import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calculateChecksum } from '../checksum';
import { formatDossierContent } from '../formatter';
import { lintDossier } from '../linter';
import { parseDossierContent } from '../parser';
import { Ed25519Signer, Ed25519Verifier } from '../signers/ed25519';
import { buildSignedPayload, buildVerificationPayload } from '../signing-payload';
import { SpecShapeError } from '../spec-shape';
import {
  buildSpecFrontmatter,
  deriveSkillName,
  foreignMetadata,
  renderSpecDossier,
  serializeSpecDossier,
  withSkillIdentity,
} from '../spec-writer';

const FIXTURES = join(__dirname, 'fixtures', 'spec-shape');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

describe('deriveSkillName', () => {
  it.each([
    ['imboard-ai/git/full-cycle-issue', 'full-cycle-issue'],
    ['imboard-ai/git/full-cycle-issue@3.8.0', 'full-cycle-issue'],
    ['/some/dir/Hello_World.ds.md', 'hello-world'],
    ['C:\\docs\\setup.md', 'setup'],
    ['Context Engineering: Best Practices!', 'context-engineering-best-practices'],
    ['--a--b--', 'a-b'],
  ])('%s -> %s', (source, expected) => {
    expect(deriveSkillName(source)).toBe(expected);
  });

  it('caps the name at 64 characters without a trailing hyphen', () => {
    const name = deriveSkillName(`${'a'.repeat(63)}-bcd`) as string;
    expect(name).toBe('a'.repeat(63));
  });

  it('names an installed SKILL.md after its directory', () => {
    expect(deriveSkillName('/home/x/.claude/skills/my-skill/SKILL.md')).toBe('my-skill');
  });

  it('returns undefined when nothing usable is left', () => {
    expect(deriveSkillName('---.ds.md')).toBeUndefined();
    expect(deriveSkillName('')).toBeUndefined();
  });
});

describe('withSkillIdentity', () => {
  it('fills name from the source and description from objective', () => {
    const out = withSkillIdentity({ title: 'T', objective: 'Do it' }, 'ns/my-dossier');
    expect(out).toMatchObject({ name: 'my-dossier', description: 'Do it' });
  });

  it('falls back to the title for the name', () => {
    expect(withSkillIdentity({ title: 'Setup Tracing' }).name).toBe('setup-tracing');
  });

  it('keeps present values, even invalid ones, and does not mutate its input', () => {
    const input = { name: 'Bad Name', description: 'kept', objective: 'other' };
    const out = withSkillIdentity(input, 'ns/x');
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });
});

describe('serializeSpecDossier', () => {
  const body = '\n# Body\n\ntext\n';

  it('quotes every scalar so typed-looking strings stay strings', () => {
    const logical = {
      name: 'n',
      description: 'd',
      title: 'true',
      version: '1.0',
      last_updated: '2026-10-07',
      requires_approval: true,
      count: 3,
      nothing: null,
    };
    const content = renderSpecDossier(logical, body);
    expect(content).toMatch(/^name: 'n'$/m);
    expect(content).toMatch(/^ {2}dossier\.requires_approval: 'true'$/m);
    expect(content).toMatch(/^ {2}dossier\.last_updated: '2026-10-07'$/m);
    expect(content).not.toMatch(/: [^'"\n]+$/m);
    const parsed = parseDossierContent(content);
    expect(parsed.shape).toBe('spec');
    expect(parsed.frontmatter).toEqual(logical);
    expect(parsed.body).toBe(body);
  });

  it.each([
    ['apostrophes and colons', "it's a: test # not a comment"],
    ['line breaks', 'line one\n\nline two\n'],
    ['separator characters and tabs', 'a\u2028b\u2029c\td\u00a0e'],
    ['leading and trailing spaces', '  padded  '],
    ['an empty string', ''],
    ['JSON-looking text', '{"a":[1,2]}'],
  ])('round-trips %s', (_label, value) => {
    const logical = { name: 'n', description: value, objective: value, extra: [value] };
    expect(parseDossierContent(renderSpecDossier(logical, body)).frontmatter).toEqual(logical);
  });

  it.each([
    ['DEL', '\u007f'],
    ['NEL', '\u0085'],
    ['a C1 control', '\u0080'],
  ])('refuses %s, which strict YAML readers reject or alter', (_label, ch) => {
    expect(() =>
      renderSpecDossier({ name: 'n', description: `a${ch}b`, title: 'T' }, body)
    ).toThrow(/C1 control/);
  });

  it('quotes keys a YAML 1.1 reader would not read as the same string', () => {
    const original = parseDossierContent(
      "---\nname: 'n'\ndescription: 'd'\nmetadata:\n  'yes': 'x'\n  'a b': 'y'\n  dossier.title: 'T'\n---\n# B\n"
    );
    const content = renderSpecDossier(original.frontmatter, '# B\n', original);
    expect(content).toContain("  'yes': 'x'");
    expect(content).toContain("  'a b': 'y'");
    expect(content).toContain("  dossier.title: 'T'");
  });

  it('never emits an empty metadata map', () => {
    expect(buildSpecFrontmatter({ name: 'n', description: 'd' })).not.toHaveProperty('metadata');
  });

  it('refuses frontmatter that would not read back as spec-shaped', () => {
    expect(() => serializeSpecDossier({ name: 'n', description: 'd' }, body)).toThrow(
      SpecShapeError
    );
  });

  it('refuses a top-level value the spec shape cannot hold', () => {
    const spec = buildSpecFrontmatter({ name: 'n', description: 'd', title: 'T' });
    expect(() => serializeSpecDossier({ ...spec, name: 1 }, body)).toThrow(SpecShapeError);
  });
});

describe('buildSpecFrontmatter', () => {
  it('carries over metadata that belongs to other tools', () => {
    const original = parseDossierContent(
      "---\nname: 'n'\ndescription: 'd'\nmetadata:\n  other.tool: 'x'\n  dossier.title: 'T'\n---\n# B\n"
    );
    expect(foreignMetadata(original.rawFrontmatter)).toEqual({ 'other.tool': 'x' });
    const spec = buildSpecFrontmatter({ ...original.frontmatter, title: 'U' }, original);
    expect(spec.metadata).toEqual({ 'dossier.title': 'U', 'other.tool': 'x' });
  });

  it('ignores the foreign-metadata carry-over for legacy originals', () => {
    const original = {
      rawFrontmatter: { metadata: { 'other.tool': 'x' } },
      shape: 'legacy' as const,
    };
    expect(buildSpecFrontmatter({ title: 'T' }, original).metadata).toEqual({
      'dossier.title': 'T',
    });
  });
});

describe('formatDossierContent writes the spec shape', () => {
  const legacy = fixture('legacy-twin.ds.md');

  it('converts an unsigned legacy dossier, deriving name and description', () => {
    const { formatted } = formatDossierContent(legacy, { nameSource: 'ns/legacy-twin' });
    const parsed = parseDossierContent(formatted);
    const before = parseDossierContent(legacy).frontmatter;
    expect(parsed.shape).toBe('spec');
    expect(parsed.frontmatter.name).toBe(before.name ?? 'legacy-twin');
    expect(parsed.frontmatter.description).toBe(before.description ?? before.objective);
    expect(formatDossierContent(formatted).changed).toBe(false);
  });

  it('keeps a signed legacy dossier legacy rather than orphaning its signature', () => {
    const signed = fixture('legacy-v2-signed.ds.md');
    const { formatted } = formatDossierContent(signed);
    expect(formatted.startsWith('---dossier\n')).toBe(true);
    expect(parseDossierContent(formatted).shape).toBe('legacy');
  });

  it('rewrites a spec-shaped file without re-encoding values a v3 signature covers', () => {
    const file = [
      '---dossier',
      '{"name": "n", "description": "d", "metadata": {',
      '  "dossier.title": "T",',
      '  "dossier.tags": "[\\"b\\", \\"a\\"]",',
      '  "dossier.checksum": "{\\"algorithm\\": \\"sha256\\", \\"hash\\": \\"0\\"}",',
      '  "dossier.signature": "{\\"covers\\": \\"spec-frontmatter+body\\"}"}}',
      '---',
      '# Body',
      '',
    ].join('\n');
    const before = parseDossierContent(file);
    const { formatted } = formatDossierContent(file, { updateChecksum: false });
    const after = parseDossierContent(formatted);
    expect(formatted.startsWith('---\nname:')).toBe(true);
    expect(after.rawFrontmatter).toEqual(before.rawFrontmatter);
    expect(buildVerificationPayload(after)).toBe(buildVerificationPayload(before));
    const blockStyle = (c: string) =>
      lintDossier(c).diagnostics.filter((d) => /block-style/.test(d.message));
    expect(blockStyle(file)).toHaveLength(1);
    expect(blockStyle(formatted)).toEqual([]);
  });

  it('only replaces the checksum field of a spec-shaped file', () => {
    const original = parseDossierContent(
      '---\nname: \'n\'\ndescription: \'d\'\nmetadata:\n  dossier.tags: \'["b", "a"]\'\n  dossier.checksum: \'{"algorithm": "sha256", "hash": "0"}\'\n---\n# Body\n'
    );
    const { formatted } = formatDossierContent(original.raw);
    const meta = parseDossierContent(formatted).rawFrontmatter.metadata as Record<string, string>;
    expect(meta['dossier.tags']).toBe('["b", "a"]');
    expect(JSON.parse(meta['dossier.checksum']).hash).toBe(calculateChecksum('# Body'));
  });

  it('honors toSpec: false for legacy input', () => {
    const { formatted } = formatDossierContent(legacy, { toSpec: false });
    expect(formatted.startsWith('---dossier\n')).toBe(true);
  });

  it('lints the converted dossier without spec-shape errors', () => {
    const { formatted } = formatDossierContent(legacy, { nameSource: 'legacy-twin.ds.md' });
    const errors = lintDossier(formatted).diagnostics.filter(
      (d) => d.ruleId === 'spec-shape' && d.severity === 'error'
    );
    expect(errors).toEqual([]);
  });
});

describe('a v3 signature over the written object verifies', () => {
  let tempDir: string;
  let signer: Ed25519Signer;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dossier-spec-writer-'));
    const keyPath = join(tempDir, 'k.pem');
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
    signer = new Ed25519Signer(keyPath);
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('sign the spec object, embed the signature, verify the written file', async () => {
    const { frontmatter, body } = parseDossierContent(fixture('legacy-twin.ds.md'));
    const logical = withSkillIdentity(
      { ...frontmatter, checksum: { algorithm: 'sha256', hash: calculateChecksum(body) } },
      'legacy-twin'
    );
    const sig = await signer.sign(
      buildSignedPayload(buildSpecFrontmatter(logical), body, 'spec-frontmatter+body')
    );
    const content = renderSpecDossier(
      { ...logical, signature: { ...sig, covers: 'spec-frontmatter+body' } },
      body
    );

    const parsed = parseDossierContent(content);
    const result = await new Ed25519Verifier().verify(buildVerificationPayload(parsed), sig);
    expect(result.valid).toBe(true);
    expect(parsed.frontmatter.signature?.covers).toBe('spec-frontmatter+body');
  });
});

describe('spec-shape and legacy-layout lint rules', () => {
  const byRule = (content: string, ruleId: string) =>
    lintDossier(content).diagnostics.filter((d) => d.ruleId === ruleId);
  const spec = (extra: Record<string, unknown> = {}) =>
    renderSpecDossier(
      {
        name: 'good-name',
        description: 'Does a thing.',
        ...parseDossierContent(fixture('legacy-twin.ds.md')).frontmatter,
        ...extra,
      },
      '# Body\n'
    );

  it('passes a spec-shaped dossier that follows the Agent Skills layout', () => {
    expect(byRule(spec(), 'spec-shape')).toEqual([]);
    expect(byRule(spec(), 'legacy-layout')).toEqual([]);
  });

  it('reports an invalid Agent Skills name', () => {
    const [d] = byRule(spec({ name: 'Bad_Name' }), 'spec-shape');
    expect(d).toMatchObject({ severity: 'error', field: 'name' });
    expect(d.message).toMatch(/lowercase letters, digits and single hyphens/);
  });

  it('reports an over-long description and a missing required Dossier field', () => {
    const { checksum: _dropped, ...noChecksum } = parseDossierContent(
      fixture('legacy-twin.ds.md')
    ).frontmatter;
    const content = renderSpecDossier(
      { ...noChecksum, name: 'n', description: 'x'.repeat(1025) },
      '# Body\n'
    );
    const messages = byRule(content, 'spec-shape').map((d) => d.message);
    expect(messages).toContainEqual(expect.stringMatching(/^description: /));
    expect(messages).toContain('Missing required field: metadata.dossier.checksum');
  });

  it('reports flow-style (JSON) spec frontmatter, which strict YAML readers reject', () => {
    const flow =
      '---dossier\n{"name": "good-name", "description": "d", "metadata": {"dossier.title": "T"}}\n---\n# B\n';
    expect(byRule(flow, 'spec-shape').map((d) => d.message)).toContainEqual(
      expect.stringMatching(/block-style YAML/)
    );
    expect(byRule(spec(), 'spec-shape')).toEqual([]);
  });

  it('flags the legacy layout as info, plus anything its conversion would trip on', () => {
    const legacy = fixture('legacy-twin.ds.md');
    expect(byRule(legacy, 'legacy-layout')).toEqual([
      expect.objectContaining({ severity: 'info', message: expect.stringMatching(/Legacy/) }),
    ]);

    const fm = { ...parseDossierContent(legacy).frontmatter, name: 'Not Valid' };
    const bad = `---dossier\n${JSON.stringify(fm)}\n---\n# Body\n`;
    expect(byRule(bad, 'legacy-layout').map((d) => d.field)).toContain('name');
    expect(byRule(bad, 'spec-shape')).toEqual([]);
  });
});
