import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import rootSchemaCopy from '../../../../dossier-schema.json';
import { lintDossier } from '../linter';
import { parseDossierContent } from '../parser';
import dossierSchema from '../schema/dossier-schema.json';
import type { SignatureResult } from '../signers';
import { Ed25519Signer, Ed25519Verifier } from '../signers/ed25519';
import {
  buildSignedPayload,
  buildVerificationPayload,
  canonicalizeSpecFrontmatter,
  signatureCoverage,
} from '../signing-payload';
import {
  decodeSpecValue,
  encodeSpecValue,
  fromSpecFrontmatter,
  isSpecShapedFrontmatter,
  SpecShapeError,
  toSpecFrontmatter,
} from '../spec-shape';
import type { ParsedDossier } from '../types';
import { compileSchema } from '../utils/ajv';

const FIXTURES = join(__dirname, 'fixtures', 'spec-shape');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

/** Render frontmatter + body as a YAML-frontmatter dossier file. */
function render(frontmatter: Record<string, unknown>, body: string): string {
  return matter.stringify(body, frontmatter);
}

const verifier = new Ed25519Verifier();
const verifySignature = (payload: string, signature: SignatureResult) =>
  verifier.verify(payload, signature);

async function verifyParsed(parsed: ParsedDossier): Promise<boolean> {
  const result = await verifySignature(
    buildVerificationPayload(parsed),
    parsed.frontmatter.signature as SignatureResult
  );
  return result.valid;
}

// ---------------------------------------------------------------------------
// Value encoding
// ---------------------------------------------------------------------------

describe('spec value encoding', () => {
  const cases: [string, unknown][] = [
    ['plain string', 'hello world'],
    ['empty string', ''],
    ['JSON-looking "true"', 'true'],
    ['JSON-looking "false"', 'false'],
    ['JSON-looking "null"', 'null'],
    ['JSON-looking "123"', '123'],
    ['JSON-looking " 123 " (JSON allows surrounding whitespace)', ' 123 '],
    ['JSON-looking "[1]"', '[1]'],
    ['JSON-looking "{}"', '{}'],
    ['JSON-looking quoted string', '"x"'],
    ['string with quotes inside', 'say "hi"'],
    ['boolean true', true],
    ['boolean false', false],
    ['integer', 42],
    ['negative float', -3.25],
    ['null', null],
    ['array', [1, 'two', false, null]],
    ['empty array', []],
    ['object', { b: 1, a: { c: ['x'] } }],
    ['empty object', {}],
  ];

  for (const [label, value] of cases) {
    it(`round-trips ${label}`, () => {
      const encoded = encodeSpecValue(value);
      expect(typeof encoded).toBe('string');
      expect(decodeSpecValue(encoded)).toEqual(value);
    });
  }

  it('stores a non-JSON string as-is and JSON-quotes one that would parse', () => {
    expect(encodeSpecValue('high')).toBe('high');
    expect(encodeSpecValue('true')).toBe('"true"');
    expect(encodeSpecValue('"x"')).toBe('"\\"x\\""');
  });

  it('stores non-strings as canonical JSON (sorted keys, no whitespace)', () => {
    expect(encodeSpecValue({ b: 1, a: [true] })).toBe('{"a":[true],"b":1}');
    expect(encodeSpecValue(false)).toBe('false');
  });

  it.each([
    ['a Date', new Date('2026-10-07')],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a nested Date', { at: new Date(0) }],
    ['an undefined array slot', [1, undefined]],
    ['a function', () => 1],
  ])('refuses %s instead of encoding it lossily', (_label, value) => {
    expect(() => encodeSpecValue(value)).toThrow(SpecShapeError);
  });
});

// ---------------------------------------------------------------------------
// Property test: fromSpec(toSpec(x)) == x
// ---------------------------------------------------------------------------

/** mulberry32 — a small seeded PRNG so failures reproduce. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TRICKY_STRINGS = [
  'true',
  'false',
  'null',
  '123',
  '-1.5e3',
  '[1]',
  '[]',
  '{}',
  '{"a":1}',
  '"x"',
  '""',
  ' 7 ',
  '',
  'high',
  'with "quotes"',
  "it's",
  'multi\nline',
  'tab\there',
  'unicode ✓ ünïcödé',
  '# not a comment',
  'key: value',
  '- dash',
  '2026-10-07',
  '1.0',
  'yes',
  '~',
];

function arbitraryString(rand: () => number): string {
  if (rand() < 0.6) {
    return TRICKY_STRINGS[Math.floor(rand() * TRICKY_STRINGS.length)];
  }
  const alphabet = 'abcXYZ019 -_:"\'{}[],.#\\/\n';
  let out = '';
  const len = Math.floor(rand() * 12);
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
  return out;
}

function arbitraryValue(rand: () => number, depth: number): unknown {
  const pick = Math.floor(rand() * (depth > 2 ? 6 : 8));
  switch (pick) {
    case 0:
      return arbitraryString(rand);
    case 1:
      return rand() < 0.5;
    case 2:
      return Math.floor(rand() * 2000) - 1000 || 1;
    case 3:
      return Math.round((rand() - 0.5) * 1e6) / 1000 || 0.5;
    case 4:
      return null;
    case 5:
      return arbitraryString(rand);
    case 6: {
      const len = Math.floor(rand() * 4);
      return Array.from({ length: len }, () => arbitraryValue(rand, depth + 1));
    }
    default: {
      const obj: Record<string, unknown> = {};
      const len = Math.floor(rand() * 4);
      for (let i = 0; i < len; i++)
        obj[`k${i}_${arbitraryString(rand)}`] = arbitraryValue(rand, depth + 1);
      return obj;
    }
  }
}

function arbitraryLogical(rand: () => number): Record<string, unknown> {
  const logical: Record<string, unknown> = {
    name: 'prop-dossier',
    description: arbitraryString(rand) || 'd',
  };
  const fields = Math.floor(rand() * 8) + 1;
  for (let i = 0; i < fields; i++) {
    logical[`field_${i}`] = arbitraryValue(rand, 0);
  }
  return logical;
}

describe('toSpecFrontmatter / fromSpecFrontmatter round trip (property)', () => {
  const RUNS = 500;

  it(`fromSpec(toSpec(x)) == x over ${RUNS} generated frontmatters`, () => {
    const rand = prng(1122);
    for (let run = 0; run < RUNS; run++) {
      const logical = arbitraryLogical(rand);
      const spec = toSpecFrontmatter(logical);
      for (const value of Object.values(spec.metadata as Record<string, unknown>)) {
        expect(typeof value).toBe('string');
      }
      expect(fromSpecFrontmatter(spec), `run ${run}`).toEqual(logical);
    }
  });

  it('survives a YAML render + parseDossierContent, not only the in-memory round trip', () => {
    const rand = prng(88);
    for (let run = 0; run < 100; run++) {
      const logical = arbitraryLogical(rand);
      const parsed = parseDossierContent(render(toSpecFrontmatter(logical), '# Body\n'));
      expect(parsed.shape, `run ${run}`).toBe('spec');
      expect(parsed.frontmatter, `run ${run}`).toEqual(logical);
    }
  });

  it('round-trips every value kind named in the design', () => {
    const logical = {
      name: 'kinds',
      description: 'every kind',
      s_true: 'true',
      s_num: '123',
      s_arr: '[1]',
      s_quoted: '"x"',
      b: false,
      n: 0,
      arr: [1, [2, []]],
      obj: { nested: {} },
      nil: null,
      empty_arr: [],
      empty_obj: {},
    };
    expect(fromSpecFrontmatter(toSpecFrontmatter(logical))).toEqual(logical);
  });

  it('omits metadata entirely when no Dossier field needs it', () => {
    expect(toSpecFrontmatter({ name: 'n', description: 'd' })).toEqual({
      name: 'n',
      description: 'd',
    });
  });
});

// ---------------------------------------------------------------------------
// Parsing both shapes
// ---------------------------------------------------------------------------

describe('parseDossierContent with both shapes', () => {
  const legacy = parseDossierContent(fixture('legacy-twin.ds.md'));
  const spec = parseDossierContent(fixture('spec-twin.ds.md'));

  it('detects the shape of each twin', () => {
    expect(legacy.shape).toBe('legacy');
    expect(spec.shape).toBe('spec');
  });

  it('parses the spec-shaped twin to the same logical object as its legacy twin', () => {
    expect(spec.frontmatter).toEqual(legacy.frontmatter);
    expect(spec.body).toBe(legacy.body);
    expect(spec.frontmatter.requires_approval).toBe(true);
    expect(spec.frontmatter.protocol_version).toBe('1.0');
    expect(spec.frontmatter.custom_flag).toBe('true');
  });

  it('keeps the on-disk frontmatter as rawFrontmatter', () => {
    expect(legacy.rawFrontmatter).toEqual(legacy.frontmatter);
    expect((spec.rawFrontmatter.metadata as Record<string, string>)['dossier.risk_level']).toBe(
      'high'
    );
    expect(spec.rawFrontmatter).not.toHaveProperty('risk_level');
  });

  it('encodes the legacy twin to exactly the hand-written spec twin', () => {
    expect(toSpecFrontmatter(legacy.frontmatter as Record<string, unknown>)).toEqual(
      spec.rawFrontmatter
    );
  });

  it('lints the spec twin the same way as its legacy twin', () => {
    const strip = (r: ReturnType<typeof lintDossier>) =>
      r.diagnostics.map((d) => `${d.ruleId}:${d.field ?? ''}:${d.message}`).sort();
    expect(strip(lintDossier(fixture('spec-twin.ds.md')))).toEqual(
      strip(lintDossier(fixture('legacy-twin.ds.md')))
    );
  });

  it('treats a legacy file without dossier.* metadata keys as legacy', () => {
    const parsed = parseDossierContent(
      '---\ntitle: T\nversion: 1.0.0\nmetadata:\n  author: someone\n---\nbody\n'
    );
    expect(parsed.shape).toBe('legacy');
    expect(parsed.frontmatter.metadata).toEqual({ author: 'someone' });
  });

  it('keeps foreign metadata keys on disk but out of the logical object', () => {
    const parsed = parseDossierContent(
      '---\nname: n\ndescription: d\nmetadata:\n  author: someone\n  dossier.title: T\n---\nbody\n'
    );
    expect(parsed.frontmatter).toEqual({ name: 'n', description: 'd', title: 'T' });
    expect((parsed.rawFrontmatter.metadata as Record<string, string>).author).toBe('someone');
  });
});

// ---------------------------------------------------------------------------
// Adversarial parsing: smuggling, duplicates, types
// ---------------------------------------------------------------------------

describe('spec-shape parsing rejects ambiguity', () => {
  const specFile = (frontmatterYaml: string) => `---\n${frontmatterYaml}---\n# Body\n`;

  it('rejects the same logical field at the top level and under metadata.dossier.*', () => {
    expect(() =>
      parseDossierContent(
        specFile(
          'name: n\ndescription: d\nrisk_level: low\nmetadata:\n  dossier.risk_level: high\n'
        )
      )
    ).toThrow(/Unexpected top-level field "risk_level"/);
  });

  it('rejects a Dossier field at the top level even with no metadata twin', () => {
    expect(() =>
      parseDossierContent(
        specFile(
          'name: n\ndescription: d\nrequires_approval: false\nmetadata:\n  dossier.title: T\n'
        )
      )
    ).toThrow(/Unexpected top-level field "requires_approval"/);
  });

  it('rejects a top-level signature block on a spec-shaped file', () => {
    expect(() =>
      parseDossierContent(
        specFile(
          'name: n\ndescription: d\nsignature:\n  covers: body\nmetadata:\n  dossier.title: T\n'
        )
      )
    ).toThrow(/Unexpected top-level field "signature"/);
  });

  it.each([
    'name',
    'description',
    'license',
    'compatibility',
    'allowed-tools',
  ])('rejects dossier.%s (an Agent Skills field may only sit at the top level)', (field) => {
    expect(() =>
      parseDossierContent(
        specFile(`name: n\ndescription: d\nmetadata:\n  dossier.${field}: smuggled\n`)
      )
    ).toThrow(/may only appear at the top level/);
  });

  it('rejects an empty field name and __proto__', () => {
    expect(() =>
      fromSpecFrontmatter({ name: 'n', metadata: { 'dossier.': 'x', 'dossier.title': 'T' } })
    ).toThrow(SpecShapeError);
    expect(() =>
      fromSpecFrontmatter(JSON.parse('{"name":"n","metadata":{"dossier.__proto__":"{}"}}'))
    ).toThrow(SpecShapeError);
  });

  it('rejects duplicate keys in YAML frontmatter', () => {
    expect(() =>
      parseDossierContent(
        specFile(
          'name: n\ndescription: d\nmetadata:\n  dossier.risk_level: low\n  dossier.risk_level: high\n'
        )
      )
    ).toThrow(/duplicate|duplicated/i);
    expect(() =>
      parseDossierContent(
        specFile('name: n\nname: m\ndescription: d\nmetadata:\n  dossier.title: T\n')
      )
    ).toThrow(/duplicate|duplicated/i);
  });

  it('rejects duplicate keys in JSON (---dossier) frontmatter', () => {
    expect(() =>
      parseDossierContent(
        '---dossier\n{"name":"n","description":"d","metadata":{"dossier.risk_level":"low","dossier.risk_level":"high"}}\n---\nbody\n'
      )
    ).toThrow(/duplicate|duplicated/i);
  });

  it('rejects a non-string metadata value instead of guessing its type', () => {
    expect(() =>
      parseDossierContent(
        specFile('name: n\ndescription: d\nmetadata:\n  dossier.requires_approval: false\n')
      )
    ).toThrow(/must be a string/);
    // An unquoted YAML date is a Date object, which canonical JSON cannot represent.
    expect(() =>
      parseDossierContent(
        specFile('name: n\ndescription: d\nmetadata:\n  dossier.last_updated: 2026-10-07\n')
      )
    ).toThrow(/must be a string/);
  });

  it('rejects a non-string Agent Skills top-level value', () => {
    expect(() =>
      parseDossierContent(specFile('name: 12\ndescription: d\nmetadata:\n  dossier.title: T\n'))
    ).toThrow(/must be a string/);
  });

  it('rejects dossier.metadata that would make the logical object look spec-shaped', () => {
    const file = specFile(
      `name: n\ndescription: d\nmetadata:\n  dossier.metadata: '{"dossier.title":"T"}'\n`
    );
    expect(() => parseDossierContent(file)).toThrow(/must not itself carry/);
    // A plain map under dossier.metadata is still an ordinary field.
    const plain = parseDossierContent(
      specFile(`name: n\ndescription: d\nmetadata:\n  dossier.metadata: '{"author":"a"}'\n`)
    );
    expect(plain.frontmatter.metadata).toEqual({ author: 'a' });
  });

  it('rejects YAML merge keys in spec-shaped front matter', () => {
    expect(() =>
      parseDossierContent(
        specFile(
          'base: &base\n  description: from-merge\nname: n\n<<: *base\nmetadata:\n  dossier.title: T\n'
        )
      )
    ).toThrow(/merge keys/);
    expect(() =>
      parseDossierContent(
        specFile(
          'name: n\ndescription: d\nmetadata:\n  <<: { dossier.risk_level: low }\n  dossier.title: T\n'
        )
      )
    ).toThrow(/merge keys/);
  });
});

// ---------------------------------------------------------------------------
// Signatures: v1 / v2 unchanged, v3 new
// ---------------------------------------------------------------------------

describe('signatureCoverage', () => {
  it('maps each known covers value and defaults to body-only when absent', () => {
    expect(signatureCoverage(undefined)).toBe('body');
    expect(signatureCoverage({})).toBe('body');
    expect(signatureCoverage({ covers: 'body' })).toBe('body');
    expect(signatureCoverage({ covers: 'frontmatter+body' })).toBe('frontmatter+body');
    expect(signatureCoverage({ covers: 'spec-frontmatter+body' })).toBe('spec-frontmatter+body');
  });

  it.each([
    'spec-frontmatter+body+extras',
    'FRONTMATTER+BODY',
    '',
    'v4',
    42,
    null,
  ])('fails closed on unknown covers %j', (covers) => {
    expect(() => signatureCoverage({ covers })).toThrow(/Unsupported signature coverage/);
  });
});

describe('signature verification across v1, v2 and v3', () => {
  let tempDir: string;
  let signer: Ed25519Signer;
  let otherSigner: Ed25519Signer;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dossier-spec-shape-'));
    const keyFile = (name: string) => {
      const { privateKey } = generateKeyPairSync('ed25519');
      const path = join(tempDir, name);
      writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
      return path;
    };
    signer = new Ed25519Signer(keyFile('test.pem'));
    otherSigner = new Ed25519Signer(keyFile('other.pem'));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const legacyTwin = parseDossierContent(fixture('legacy-twin.ds.md'));
  const specRaw = parseDossierContent(fixture('spec-twin.ds.md')).rawFrontmatter;
  const body = legacyTwin.body;

  /** Sign a spec-shaped on-disk object under v3 and render it as a file. */
  async function signV3(raw: Record<string, unknown>, fileBody = body, by = signer) {
    const sig = await by.sign(buildSignedPayload(raw, fileBody, 'spec-frontmatter+body'));
    const signature = { ...sig, covers: 'spec-frontmatter+body' };
    const metadata = { ...(raw.metadata as Record<string, string>) };
    metadata['dossier.signature'] = encodeSpecValue(signature);
    return render({ ...raw, metadata }, fileBody);
  }

  /** Sign legacy flat frontmatter under v1 (body) or v2 and render it as a JSON-frontmatter file. */
  async function signLegacy(coverage: 'body' | 'frontmatter+body') {
    const fm = { ...(legacyTwin.frontmatter as Record<string, unknown>) };
    const sig = await signer.sign(buildSignedPayload(fm, body, coverage));
    const signature = coverage === 'body' ? sig : { ...sig, covers: coverage };
    return `---dossier\n${JSON.stringify({ ...fm, signature }, null, 2)}\n---\n${body}`;
  }

  /** Rewrite one metadata string in a rendered spec file, keeping the signature. */
  function editMetadata(file: string, mutate: (m: Record<string, string>) => void): string {
    const parsed = parseDossierContent(file);
    const metadata = { ...(parsed.rawFrontmatter.metadata as Record<string, string>) };
    mutate(metadata);
    return render({ ...parsed.rawFrontmatter, metadata }, parsed.body);
  }

  describe('legacy signatures verify unchanged', () => {
    it('a real published v1 (body-only) dossier verifies', async () => {
      const parsed = parseDossierContent(fixture('legacy-v1-signed.ds.md'));
      expect(parsed.shape).toBe('legacy');
      expect(signatureCoverage(parsed.frontmatter.signature)).toBe('body');
      expect(await verifyParsed(parsed)).toBe(true);
    });

    it('a real published v2 (frontmatter+body) dossier verifies', async () => {
      const parsed = parseDossierContent(fixture('legacy-v2-signed.ds.md'));
      expect(parsed.shape).toBe('legacy');
      expect(signatureCoverage(parsed.frontmatter.signature)).toBe('frontmatter+body');
      expect(await verifyParsed(parsed)).toBe(true);
    });

    it('buildVerificationPayload gives the same bytes the v1/v2 path always built', () => {
      for (const name of ['legacy-v1-signed.ds.md', 'legacy-v2-signed.ds.md']) {
        const parsed = parseDossierContent(fixture(name));
        expect(buildVerificationPayload(parsed)).toBe(
          buildSignedPayload(
            parsed.frontmatter as unknown as Record<string, unknown>,
            parsed.body,
            signatureCoverage(parsed.frontmatter.signature)
          )
        );
      }
    });

    it('freshly signed v1 and v2 legacy files verify', async () => {
      expect(await verifyParsed(parseDossierContent(await signLegacy('body')))).toBe(true);
      expect(await verifyParsed(parseDossierContent(await signLegacy('frontmatter+body')))).toBe(
        true
      );
    });
  });

  describe('v3 over the on-disk spec shape', () => {
    it('verifies a v3-signed spec-shaped file', async () => {
      const parsed = parseDossierContent(await signV3(specRaw));
      expect(parsed.shape).toBe('spec');
      expect(parsed.frontmatter.signature?.covers).toBe('spec-frontmatter+body');
      expect(await verifyParsed(parsed)).toBe(true);
    });

    it('signs with the dossier-signature-v3 tag over the frontmatter minus the signature', async () => {
      const parsed = parseDossierContent(await signV3(specRaw));
      const payload = buildVerificationPayload(parsed);
      expect(payload.startsWith('dossier-signature-v3\n')).toBe(true);
      expect(payload).not.toContain('dossier.signature');
      expect(payload).toBe(
        `dossier-signature-v3\n${canonicalizeSpecFrontmatter(specRaw)}\n${body}`
      );
    });

    it('fails when a top-level Agent Skills field changes', async () => {
      const file = await signV3(specRaw);
      const parsed = parseDossierContent(file);
      const tampered = render(
        { ...parsed.rawFrontmatter, description: 'Totally harmless now' },
        parsed.body
      );
      expect(await verifyParsed(parseDossierContent(tampered))).toBe(false);
    });

    it.each([
      ['dossier.risk_level', 'low'],
      ['dossier.requires_approval', 'false'],
      ['dossier.destructive_operations', '["rm -rf /"]'],
      ['dossier.checksum', '{"algorithm":"sha256","hash":"0000"}'],
    ])('fails when %s changes', async (key, value) => {
      const tampered = editMetadata(await signV3(specRaw), (m) => {
        m[key] = value;
      });
      expect(await verifyParsed(parseDossierContent(tampered))).toBe(false);
    });

    it('fails when a Dossier field is removed', async () => {
      const tampered = editMetadata(await signV3(specRaw), (m) => {
        delete m['dossier.requires_approval'];
      });
      expect(await verifyParsed(parseDossierContent(tampered))).toBe(false);
    });

    it('fails when a field is added, including a foreign metadata key', async () => {
      const signed = await signV3(specRaw);
      for (const [key, value] of [
        ['dossier.extra', 'x'],
        ['author', 'someone else'],
      ]) {
        const tampered = editMetadata(signed, (m) => {
          m[key] = value;
        });
        expect(await verifyParsed(parseDossierContent(tampered)), key).toBe(false);
      }
    });

    it('fails when a value is re-encoded to the same logical meaning (the signature covers bytes, not meaning)', async () => {
      const signed = await signV3(specRaw);
      const tampered = editMetadata(signed, (m) => {
        m['dossier.requires_approval'] = ' true';
      });
      const parsed = parseDossierContent(tampered);
      expect(parsed.frontmatter).toEqual(parseDossierContent(signed).frontmatter);
      expect(await verifyParsed(parsed)).toBe(false);
    });

    it('fails when the body changes by one byte', async () => {
      const parsed = parseDossierContent(await signV3(specRaw));
      const tampered = render(parsed.rawFrontmatter, `${parsed.body} `);
      expect(await verifyParsed(parseDossierContent(tampered))).toBe(false);
    });

    it('fails when the signature names a different public key', async () => {
      const other = parseDossierContent(await signV3(specRaw, body, otherSigner));
      const tampered = editMetadata(await signV3(specRaw), (m) => {
        const sig = JSON.parse(m['dossier.signature']);
        sig.public_key = (other.frontmatter.signature as { public_key: string }).public_key;
        m['dossier.signature'] = JSON.stringify(sig);
      });
      expect(await verifyParsed(parseDossierContent(tampered))).toBe(false);
    });

    it('refuses to build a v3 payload from the logical view', () => {
      expect(() =>
        buildSignedPayload(
          legacyTwin.frontmatter as unknown as Record<string, unknown>,
          body,
          'spec-frontmatter+body'
        )
      ).toThrow(/on-disk spec-shaped frontmatter/);
    });
  });

  describe('cross-version replay', () => {
    it('a v3 signature does not verify as v2 or v1 over the same content', async () => {
      const parsed = parseDossierContent(await signV3(specRaw));
      const sig = parsed.frontmatter.signature as SignatureResult;
      const logical = parsed.frontmatter as unknown as Record<string, unknown>;
      expect((await verifySignature(buildSignedPayload(logical, body), sig)).valid).toBe(false);
      expect((await verifySignature(buildSignedPayload(logical, body, 'body'), sig)).valid).toBe(
        false
      );
    });

    it('a v3 signature relabelled as v2 or v1 on the spec file is refused', async () => {
      for (const covers of ['frontmatter+body', 'body', undefined]) {
        const tampered = editMetadata(await signV3(specRaw), (m) => {
          const sig = JSON.parse(m['dossier.signature']);
          if (covers === undefined) delete sig.covers;
          else sig.covers = covers;
          m['dossier.signature'] = JSON.stringify(sig);
        });
        expect(
          () => buildVerificationPayload(parseDossierContent(tampered)),
          String(covers)
        ).toThrow(/only spec-frontmatter\+body \(v3\) covers this shape/);
      }
    });

    it('a legacy v2 signature carried onto the spec-shaped twin is refused', async () => {
      // Same logical fields, so the v2 payload would match — the shape binding is what stops it.
      const legacy = parseDossierContent(await signLegacy('frontmatter+body'));
      const metadata = {
        ...(specRaw.metadata as Record<string, string>),
        'dossier.signature': encodeSpecValue(legacy.frontmatter.signature),
      };
      const transplanted = parseDossierContent(render({ ...specRaw, metadata }, body));
      expect(transplanted.frontmatter).toEqual(legacy.frontmatter);
      expect(() => buildVerificationPayload(transplanted)).toThrow(/carries a frontmatter\+body/);
    });

    it('a legacy v1 signature carried onto the spec-shaped twin is refused', async () => {
      const legacy = parseDossierContent(await signLegacy('body'));
      const metadata = {
        ...(specRaw.metadata as Record<string, string>),
        'dossier.signature': encodeSpecValue(legacy.frontmatter.signature),
      };
      const transplanted = parseDossierContent(render({ ...specRaw, metadata }, body));
      expect(() => buildVerificationPayload(transplanted)).toThrow(/carries a body signature/);
    });

    it('a v3 signature carried onto the legacy twin is refused', async () => {
      const v3 = parseDossierContent(await signV3(specRaw));
      const file = `---dossier\n${JSON.stringify(
        {
          ...(legacyTwin.frontmatter as Record<string, unknown>),
          signature: v3.frontmatter.signature,
        },
        null,
        2
      )}\n---\n${body}`;
      expect(() => buildVerificationPayload(parseDossierContent(file))).toThrow(
        /Legacy-shaped dossier carries a spec-frontmatter\+body/
      );
    });

    it('a v2 signature relabelled as v3 on its legacy file is refused', async () => {
      const file = (await signLegacy('frontmatter+body')).replace(
        '"covers": "frontmatter+body"',
        '"covers": "spec-frontmatter+body"'
      );
      expect(() => buildVerificationPayload(parseDossierContent(file))).toThrow(
        /Legacy-shaped dossier/
      );
    });

    it('unknown covers fails closed on both shapes', async () => {
      const legacyFile = (await signLegacy('body')).replace(
        '"public_key"',
        '"covers": "spec-frontmatter+body+v4",\n    "public_key"'
      );
      expect(() => buildVerificationPayload(parseDossierContent(legacyFile))).toThrow(
        /Unsupported signature coverage/
      );

      const specFile = editMetadata(await signV3(specRaw), (m) => {
        const sig = JSON.parse(m['dossier.signature']);
        sig.covers = 'spec-frontmatter+body-v4';
        m['dossier.signature'] = JSON.stringify(sig);
      });
      expect(() => buildVerificationPayload(parseDossierContent(specFile))).toThrow(
        /Unsupported signature coverage/
      );
    });

    it('an unsigned dossier has no verification payload', () => {
      expect(() => buildVerificationPayload(legacyTwin)).toThrow(/not signed/);
    });
  });
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe('dossier schema accepts the spec shape', () => {
  const validate = compileSchema(dossierSchema);
  const specRaw = parseDossierContent(fixture('spec-twin.ds.md')).rawFrontmatter;
  const legacy = parseDossierContent(fixture('legacy-twin.ds.md')).frontmatter;
  const errorsOf = (value: unknown) => (validate(value) ? [] : validate.errors);

  it('keeps the root copy and the bundled copy identical', () => {
    expect(rootSchemaCopy).toEqual(dossierSchema);
  });

  it('accepts the on-disk spec-shaped twin and the legacy twin', () => {
    expect(errorsOf(specRaw)).toEqual([]);
    expect(errorsOf(legacy)).toEqual([]);
  });

  it('accepts a v3 covers value on the signature block', () => {
    const signed = {
      ...legacy,
      signature: {
        algorithm: 'ed25519',
        signature: 'c2ln',
        public_key: `${'A'.repeat(43)}=`,
        signed_by: 'Test',
        covers: 'spec-frontmatter+body',
      },
    };
    expect(errorsOf(signed)).toEqual([]);
  });

  it('rejects a spec-shaped object with a Dossier field at the top level', () => {
    expect(validate({ ...specRaw, risk_level: 'low' })).toBe(false);
  });

  it('rejects a non-string metadata value', () => {
    const metadata = { ...(specRaw.metadata as Record<string, unknown>), 'dossier.extra': true };
    expect(validate({ ...specRaw, metadata })).toBe(false);
  });

  it('rejects dossier.<agent-skills-field> under metadata', () => {
    const metadata = { ...(specRaw.metadata as Record<string, unknown>), 'dossier.name': 'x' };
    expect(validate({ ...specRaw, metadata })).toBe(false);
  });

  it('requires the legacy required fields under metadata', () => {
    const { 'dossier.title': _dropped, ...metadata } = specRaw.metadata as Record<string, unknown>;
    expect(validate({ ...specRaw, metadata })).toBe(false);
  });

  it('still requires the legacy fields on a legacy-shaped object', () => {
    const { title: _dropped, ...rest } = legacy;
    expect(validate(rest)).toBe(false);
  });

  it('isSpecShapedFrontmatter agrees with the schema detection', () => {
    expect(isSpecShapedFrontmatter(specRaw)).toBe(true);
    expect(isSpecShapedFrontmatter(legacy)).toBe(false);
  });
});
