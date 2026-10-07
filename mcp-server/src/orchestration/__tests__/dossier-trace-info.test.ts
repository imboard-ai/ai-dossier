/**
 * Spec-shaped dossiers (Agent Skills layout, #1088) keep their Dossier fields under
 * `metadata` as `dossier.*` strings. The trace metadata is read from the logical
 * frontmatter core's parser returns, so it must come out the same for both shapes.
 */
import { calculateChecksum, encodeSpecValue, parseDossierContent } from '@ai-dossier/core';
import { describe, expect, it } from 'vitest';
import { extractDossierTraceInfo } from '../dossier-trace-info';

const BODY = '\n# Deploy\n\n## Steps\n\nShip it.\n';
const HASH = calculateChecksum(BODY);
const SIGNATURE = {
  algorithm: 'ed25519',
  signature: 'c2ln',
  public_key: 'cHVi',
  signed_by: 'Release Bot',
  signed_at: '2026-01-01T00:00:00Z',
  covers: 'spec-frontmatter+body',
};

const SPEC = `---
name: deploy
description: Deploys the service.
metadata:
  dossier.dossier_schema_version: 1.0.0
  dossier.title: Deploy
  dossier.version: 2.1.0
  dossier.checksum: '${encodeSpecValue({ algorithm: 'sha256', hash: HASH })}'
  dossier.signature: '${encodeSpecValue(SIGNATURE)}'
---
${BODY}`;

const LEGACY = `---dossier
${JSON.stringify(
  {
    name: 'deploy',
    description: 'Deploys the service.',
    dossier_schema_version: '1.0.0',
    title: 'Deploy',
    version: '2.1.0',
    checksum: { algorithm: 'sha256', hash: HASH },
    signature: SIGNATURE,
  },
  null,
  2
)}
---
${BODY}`;

describe('extractDossierTraceInfo on a spec-shaped dossier', () => {
  it('records title, version, checksum and signer from the metadata map', () => {
    const parsed = parseDossierContent(SPEC);
    expect(parsed.shape).toBe('spec');
    expect(extractDossierTraceInfo('fallback', parsed.frontmatter)).toEqual({
      title: 'Deploy',
      version: '2.1.0',
      checksum: { algorithm: 'sha256', hash: HASH },
      signature: {
        algorithm: 'ed25519',
        signed_by: 'Release Bot',
        signed_at: '2026-01-01T00:00:00Z',
      },
    });
  });

  it('matches its legacy-shaped twin', () => {
    const legacy = parseDossierContent(LEGACY);
    expect(legacy.shape).toBe('legacy');
    expect(extractDossierTraceInfo('fallback', parseDossierContent(SPEC).frontmatter)).toEqual(
      extractDossierTraceInfo('fallback', legacy.frontmatter)
    );
  });

  it('returns the same body for both shapes', () => {
    expect(parseDossierContent(SPEC).body).toBe(parseDossierContent(LEGACY).body);
  });
});
