import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSignedPayload,
  buildSpecFrontmatter,
  buildVerificationPayload,
  calculateChecksum,
  Ed25519Signer,
  parseDossierContent,
  renderSpecDossier,
  signatureCoverage,
  verifyIntegrity,
  verifySignature,
} from '@ai-dossier/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toSkillFrontmatter } from '../skill-frontmatter';

const BODY = '# Review\n\nDo the review.\n\n## Steps\n\n1. Look at the diff.\n';

function dossier(fm: Record<string, unknown>, body = BODY): string {
  return `---dossier\n${JSON.stringify(fm, null, 2)}\n---\n${body}`;
}

describe('toSkillFrontmatter', () => {
  it('emits YAML frontmatter with name and description first', () => {
    const out = toSkillFrontmatter(
      dossier({
        dossier_schema_version: '1.0.0',
        title: 'PR Review',
        name: 'pr-review',
        description: 'Review the current PR diff.',
        version: '1.0.0',
      })
    );

    const lines = out.split('\n');
    expect(lines[0]).toBe('---');
    expect(lines[1]).toBe('name: pr-review');
    expect(lines[2]).toContain('description:');
    expect(out.startsWith('---dossier')).toBe(false);
  });

  it('falls back to objective when description is absent', () => {
    const out = toSkillFrontmatter(
      dossier({ name: 'x', title: 'X', objective: 'Do the thing well.' })
    );
    expect(parseDossierContent(out).frontmatter.description).toBe('Do the thing well.');
  });

  it('leaves an already-YAML dossier untouched', () => {
    const yaml = `---\nname: already\ntitle: Already\n---\n${BODY}`;
    expect(toSkillFrontmatter(yaml)).toBe(yaml);
  });

  it('returns unparseable input unchanged rather than corrupting it', () => {
    const junk = '---dossier\n{ not json\n---\nbody';
    expect(toSkillFrontmatter(junk)).toBe(junk);
  });

  it('preserves the body byte-for-byte', () => {
    const out = toSkillFrontmatter(dossier({ name: 'x', title: 'X' }));
    expect(parseDossierContent(out).body).toBe(BODY);
  });
});

// The whole approach rests on this: a v2 signature covers the PARSED frontmatter,
// not the bytes of the frontmatter block. If that ever stops holding, installing a
// skill would silently strip its verifiability.
describe('toSkillFrontmatter preserves verifiability', () => {
  let dir: string;
  let keyPath: string;

  beforeEach(() => {
    dir = join(tmpdir(), `skill-fm-${Date.now()}-${process.pid}`);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const { privateKey } = generateKeyPairSync('ed25519');
    keyPath = join(dir, 'k.pem');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps checksum and v2 signature valid after conversion', async () => {
    const fm: Record<string, unknown> = {
      dossier_schema_version: '1.0.0',
      name: 'pr-review',
      title: 'PR Review',
      version: '1.0.0',
      risk_level: 'high',
      requires_approval: false,
      checksum: { algorithm: 'sha256', hash: calculateChecksum(BODY) },
    };

    const signer = new Ed25519Signer(keyPath);
    const sig = await signer.sign(buildSignedPayload(fm, BODY));
    fm.signature = { ...sig, covers: 'frontmatter+body' };

    const converted = toSkillFrontmatter(dossier(fm));
    const parsed = parseDossierContent(converted);

    expect(verifyIntegrity(parsed.body, parsed.frontmatter.checksum?.hash).status).toBe('valid');

    const result = await verifySignature(
      buildSignedPayload(
        parsed.frontmatter as unknown as Record<string, unknown>,
        parsed.body,
        signatureCoverage(parsed.frontmatter.signature)
      ),
      parsed.frontmatter.signature as never
    );
    expect(result.valid).toBe(true);
  });

  it('adds no field a v2 signature covers, so it still verifies (#1136)', async () => {
    for (const extra of [{ description: 'Review it.' }, { objective: 'Review it.' }]) {
      const fm: Record<string, unknown> = {
        name: 'pr-review',
        title: 'PR Review',
        version: '1.0.0',
        last_updated: '2026-09-29',
        created_at: '2026-09-29T10:00:00Z',
        enabled: 'yes',
        checksum: { algorithm: 'sha256', hash: calculateChecksum(BODY) },
        ...extra,
      };
      const sig = await new Ed25519Signer(keyPath).sign(buildSignedPayload(fm, BODY));
      fm.signature = { ...sig, covers: 'frontmatter+body' };

      const parsed = parseDossierContent(toSkillFrontmatter(dossier(fm)));
      expect(Object.keys(parsed.frontmatter).sort()).toEqual(Object.keys(fm).sort());
      const result = await verifySignature(
        buildVerificationPayload(parsed),
        parsed.frontmatter.signature as never
      );
      expect(result.valid).toBe(true);
    }
  });

  it('still fills description from objective under a body-only (v1) signature', async () => {
    const fm: Record<string, unknown> = { name: 'x', title: 'X', objective: 'Do X.' };
    const sig = await new Ed25519Signer(keyPath).sign(buildSignedPayload(fm, BODY, 'body'));
    fm.signature = sig;

    const parsed = parseDossierContent(toSkillFrontmatter(dossier(fm)));
    expect(parsed.frontmatter.description).toBe('Do X.');
    const result = await verifySignature(
      buildVerificationPayload(parsed),
      parsed.frontmatter.signature as never
    );
    expect(result.valid).toBe(true);
  });

  // A key YAML 1.1 reads as a merge (`<<`) cannot be rendered so it reads back the
  // same; the dossier is installed unconverted rather than unverifiable.
  it('leaves a dossier unconverted when no rendering reads back as the same object', () => {
    const raw = dossier({ name: 'x', title: 'X', '<<': { risk_level: 'low' } });
    expect(toSkillFrontmatter(raw)).toBe(raw);
  });

  it('still detects tampering after conversion', async () => {
    const fm: Record<string, unknown> = {
      dossier_schema_version: '1.0.0',
      name: 'x',
      title: 'X',
      version: '1.0.0',
      risk_level: 'high',
      checksum: { algorithm: 'sha256', hash: calculateChecksum(BODY) },
    };
    const signer = new Ed25519Signer(keyPath);
    const sig = await signer.sign(buildSignedPayload(fm, BODY));
    fm.signature = { ...sig, covers: 'frontmatter+body' };

    const parsed = parseDossierContent(toSkillFrontmatter(dossier(fm)));
    (parsed.frontmatter as Record<string, unknown>).risk_level = 'low';

    const result = await verifySignature(
      buildSignedPayload(
        parsed.frontmatter as unknown as Record<string, unknown>,
        parsed.body,
        signatureCoverage(parsed.frontmatter.signature)
      ),
      parsed.frontmatter.signature as never
    );
    expect(result.valid).toBe(false);
  });

  // A spec-shaped dossier is what a runtime reads already, and v3 covers every
  // frontmatter field — so install copies it rather than re-rendering.
  async function signedSpec(): Promise<string> {
    const fm: Record<string, unknown> = {
      name: 'x',
      description: 'Do X.',
      dossier_schema_version: '1.0.0',
      title: 'X',
      version: '1.0.0',
      risk_level: 'high',
      checksum: { algorithm: 'sha256', hash: calculateChecksum(BODY) },
    };
    const signer = new Ed25519Signer(keyPath);
    const sig = await signer.sign(
      buildSignedPayload(buildSpecFrontmatter(fm), BODY, 'spec-frontmatter+body')
    );
    return renderSpecDossier(
      { ...fm, signature: { ...sig, covers: 'spec-frontmatter+body' } },
      BODY
    );
  }

  it('copies a spec-shaped dossier byte-for-byte', async () => {
    const spec = await signedSpec();
    expect(toSkillFrontmatter(spec)).toBe(spec);
  });

  it('only rewrites a ---dossier fence on a spec-shaped dossier, and v3 still verifies', async () => {
    const spec = await signedSpec();
    for (const fence of ['---dossier', '---json', '---yaml']) {
      expect(toSkillFrontmatter(spec.replace(/^---\n/, `${fence}\n`))).toBe(spec);
    }
    const out = toSkillFrontmatter(spec.replace(/^---\n/, '---dossier\n'));

    const parsed = parseDossierContent(out);
    const result = await verifySignature(
      buildVerificationPayload(parsed),
      parsed.frontmatter.signature as never
    );
    expect(result.valid).toBe(true);
  });
});
