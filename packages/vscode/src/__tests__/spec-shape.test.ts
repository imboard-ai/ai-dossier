/**
 * Spec-shaped dossiers (Agent Skills layout, #1088) in the editor: Dossier fields live under
 * `metadata` as `dossier.<field>` strings, so diagnostics, hover and completion point there,
 * and Verify checks the v3 signature over the on-disk frontmatter.
 */
import { sign as cryptoSign, generateKeyPairSync } from 'node:crypto';
import {
  buildSignedPayload,
  calculateChecksum,
  encodeSpecValue,
  parseDossierContent,
  toSpecFrontmatter,
} from '@ai-dossier/core';
import { describe, expect, it } from 'vitest';
import { completionsAt, hoverAt } from '../completion';
import { computeDiagnostics } from '../diagnostics';
import {
  findFieldRange,
  isSpecShapedBlock,
  locateFrontmatter,
  specKeyOnLine,
} from '../frontmatter';
import { verifyContent } from '../verify';

const BODY = '\n# Spec dossier\n\n## Steps\n\nDo the thing.\n';

const LOGICAL = {
  name: 'spec-dossier',
  description: 'Exercises the spec shape in the editor.',
  dossier_schema_version: '1.0.0',
  protocol_version: '1.0',
  title: 'Spec Dossier',
  version: '1.0.0',
  status: 'Stable',
  objective: 'Prove the extension handles spec-shaped dossiers.',
  risk_level: 'low',
  requires_approval: false,
  checksum: { algorithm: 'sha256', hash: calculateChecksum(BODY) },
};

/** Renders spec-shaped YAML; JSON string syntax is valid YAML double-quoted syntax. */
function renderSpec(spec: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(spec)) {
    if (key !== 'metadata') lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push('metadata:');
  for (const [key, value] of Object.entries(spec.metadata as Record<string, string>)) {
    lines.push(`  ${key}: ${JSON.stringify(value)}`);
  }
  lines.push('---');
  return `${lines.join('\n')}\n${BODY}`;
}

function signedSpec(covers = 'spec-frontmatter+body'): string {
  const spec = toSpecFrontmatter(LOGICAL);
  const unsigned = parseDossierContent(renderSpec(spec));
  const payload = buildSignedPayload(
    unsigned.rawFrontmatter,
    unsigned.body,
    'spec-frontmatter+body'
  );
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signature = {
    algorithm: 'ed25519',
    signature: cryptoSign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64'),
    public_key: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    signed_by: 'Test Signer',
    covers,
  };
  const metadata = {
    ...(spec.metadata as Record<string, string>),
    'dossier.signature': encodeSpecValue(signature),
  };
  return renderSpec({ ...spec, metadata });
}

const SPEC = renderSpec(toSpecFrontmatter(LOGICAL));
const lineOf = (content: string, needle: string) =>
  content.split('\n').findIndex((l) => l.includes(needle));

describe('spec-shaped frontmatter', () => {
  it('is recognised and its dossier.* keys are located', () => {
    const block = locateFrontmatter(SPEC);
    if (!block) throw new Error('no block');
    expect(isSpecShapedBlock(block)).toBe(true);
    expect(isSpecShapedBlock(locateFrontmatter('---\ntitle: x\n---\n') as never)).toBe(false);

    const line = lineOf(SPEC, 'dossier.risk_level');
    expect(specKeyOnLine(block, line)).toEqual({
      field: 'risk_level',
      startCol: 2,
      endCol: 2 + 'dossier.risk_level'.length,
    });
    expect(findFieldRange(block, 'risk_level')?.line).toBe(line);
    // Nested paths land on the key carrying the encoded value.
    expect(findFieldRange(block, 'checksum.hash')?.line).toBe(lineOf(SPEC, 'dossier.checksum'));
    // Agent Skills fields stay at the top level.
    expect(findFieldRange(block, 'name')?.line).toBe(1);
  });

  it('ignores folded continuation lines of a long metadata value', () => {
    const content =
      '---\nname: x\nmetadata:\n  dossier.title: x\n  dossier.objective: >-\n    dossier.fake: no\n---\n';
    const block = locateFrontmatter(content);
    if (!block) throw new Error('no block');
    expect(specKeyOnLine(block, 5)).toBeNull();
    expect(specKeyOnLine(block, 4)?.field).toBe('objective');
  });
});

describe('diagnostics on a spec-shaped dossier', () => {
  it('reports no errors for a valid file', () => {
    expect(computeDiagnostics(SPEC).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('places an invalid enum on its dossier.* key, not the opener', () => {
    const bad = SPEC.replace('dossier.risk_level: "low"', 'dossier.risk_level: "bogus"');
    const d = computeDiagnostics(bad).find((x) => x.message.includes('risk_level'));
    expect(d?.range.line).toBe(lineOf(bad, 'dossier.risk_level'));
  });

  it('reports a Dossier field written at the top level as a parse error', () => {
    const bad = SPEC.replace('---\n', '---\ntitle: "Smuggled"\n');
    const d = computeDiagnostics(bad);
    expect(d[0]?.code).toBe('parse');
    expect(d[0]?.message).toMatch(/Unexpected top-level field "title"/);
  });
});

describe('hover and completion on a spec-shaped dossier', () => {
  it('describes a dossier.* key', () => {
    const line = lineOf(SPEC, 'dossier.risk_level');
    const h = hoverAt(SPEC, line, 5);
    expect(h?.markdown).toContain('**risk_level**');
    expect(h?.startCol).toBe(2);
  });

  it('offers dossier.* keys under metadata, minus those present', () => {
    const doc = SPEC.replace('metadata:\n', 'metadata:\n  dossier.ta\n');
    const line = lineOf(doc, 'dossier.ta');
    const labels = completionsAt(doc, line, '  dossier.ta'.length).map((c) => c.label);
    expect(labels).toContain('dossier.tags');
    expect(labels).not.toContain('dossier.title');
    expect(labels).not.toContain('dossier.license');
    expect(labels.every((l) => l.startsWith('dossier.'))).toBe(true);
  });

  it('offers enum values and quotes booleans so metadata stays string-valued', () => {
    const status = SPEC.replace('dossier.status: "Stable"', 'dossier.status: ');
    const sLine = lineOf(status, 'dossier.status');
    const sItems = completionsAt(status, sLine, status.split('\n')[sLine].length);
    expect(sItems.map((c) => c.insertText)).toContain('Draft');

    const bool = SPEC.replace('dossier.requires_approval: "false"', 'dossier.requires_approval: ');
    const bLine = lineOf(bool, 'dossier.requires_approval');
    const bItems = completionsAt(bool, bLine, bool.split('\n')[bLine].length);
    expect(bItems.map((c) => c.insertText)).toEqual(["'true'", "'false'"]);
  });

  it('offers only Agent Skills fields at the top level of a spec-shaped file', () => {
    const doc = SPEC.replace('---\n', '---\nli\n');
    const labels = completionsAt(doc, 1, 2).map((c) => c.label);
    expect(labels).toContain('license');
    expect(labels).not.toContain('title');
    expect(labels).not.toContain('risk_level');
  });
});

describe('verify on a spec-shaped dossier', () => {
  it('verifies a v3 signature over the on-disk frontmatter', async () => {
    const r = await verifyContent(signedSpec(), new Map());
    expect(r.title).toBe('Spec Dossier');
    expect(r.checks.find((c) => c.name === 'Signature')?.status).toBe('warn'); // valid, untrusted
    expect(r.ok).toBe(true);
  });

  it('fails when signed metadata was tampered with', async () => {
    const tampered = signedSpec().replace(
      'dossier.risk_level: "low"',
      'dossier.risk_level: "high"'
    );
    const r = await verifyContent(tampered, new Map());
    expect(r.checks.find((c) => c.name === 'Signature')?.status).toBe('fail');
    expect(r.ok).toBe(false);
  });

  it('fails an unknown covers value instead of throwing', async () => {
    const r = await verifyContent(signedSpec('spec-frontmatter+body+future'), new Map());
    const sig = r.checks.find((c) => c.name === 'Signature');
    expect(sig?.status).toBe('fail');
    expect(sig?.message).toMatch(/Unsupported signature coverage/);
  });
});
