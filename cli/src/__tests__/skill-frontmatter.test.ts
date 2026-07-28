import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSignedPayload,
  calculateChecksum,
  Ed25519Signer,
  parseDossierContent,
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
});
