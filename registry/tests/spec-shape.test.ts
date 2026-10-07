/**
 * Spec-shaped (Agent Skills layout, #1088) dossiers in the registry: publish accepts
 * them, indexes the logical frontmatter, stores the submitted bytes unchanged, and
 * checks signatures under the scheme each shape allows (v1/v2 legacy, v3 spec).
 */
import { sign as cryptoSign, generateKeyPairSync } from 'node:crypto';
import {
  buildSignedPayload,
  calculateChecksum,
  encodeSpecValue,
  parseDossierContent,
  type SignatureCoverage,
  toSpecFrontmatter,
} from '@ai-dossier/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockReq, createMockRes } from './helpers/mocks';

vi.mock('../lib/auth', () => ({
  authorizePublish: vi.fn().mockResolvedValue({ sub: 'alice', email: null, orgs: [] }),
}));

vi.mock('../lib/github', async () => {
  const actual = await vi.importActual<typeof import('../lib/github')>('../lib/github');
  return { ...actual, publishDossier: vi.fn() };
});

import * as github from '../lib/github';
import { checkPublishSignature } from '../lib/signature';
import type { VercelRequest, VercelResponse } from '../lib/types';

const mockPublishDossier = vi.mocked(github.publishDossier);

const BODY = '\n# Spec dossier\n\n## Steps\n\nDo the thing.\n';

const LOGICAL = {
  name: 'spec-dossier',
  description: 'Exercises the spec shape end to end.',
  dossier_schema_version: '1.0.0',
  title: 'Spec Dossier',
  version: '1.2.0',
  objective: 'Prove the registry accepts spec-shaped dossiers.',
  risk_level: 'low',
  requires_approval: false,
  tags: ['spec', 'v3'],
  checksum: { algorithm: 'sha256', hash: calculateChecksum(BODY) },
};

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string;

function signatureBlock(payload: string, covers?: string): Record<string, unknown> {
  return {
    algorithm: 'ed25519',
    signature: cryptoSign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64'),
    public_key: PUBLIC_KEY_PEM,
    signed_by: 'Test Signer',
    ...(covers === undefined ? {} : { covers }),
  };
}

/** A legacy (flat, JSON) dossier, optionally signed under v1 or v2. */
function legacyDossier(coverage?: Exclude<SignatureCoverage, 'spec-frontmatter+body'>): string {
  const render = (fm: Record<string, unknown>) =>
    `---dossier\n${JSON.stringify(fm, null, 2)}\n---\n${BODY}`;
  if (!coverage) return render(LOGICAL);
  const unsigned = parseDossierContent(render(LOGICAL));
  const payload = buildSignedPayload(
    unsigned.frontmatter as Record<string, unknown>,
    unsigned.body,
    coverage
  );
  return render({
    ...LOGICAL,
    signature: signatureBlock(payload, coverage === 'body' ? undefined : coverage),
  });
}

/**
 * A hand-rendered spec-shaped YAML file, the way an author or a writer lays it out.
 * JSON string syntax is valid YAML double-quoted syntax, so `JSON.stringify` quotes
 * every value without a YAML dependency.
 */
function renderSpec(spec: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'metadata') continue;
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push('metadata:');
  for (const [key, value] of Object.entries(spec.metadata as Record<string, string>)) {
    lines.push(`  ${key}: ${JSON.stringify(value)}`);
  }
  lines.push('---');
  return `${lines.join('\n')}\n${BODY}`;
}

/** A spec-shaped dossier signed under `covers` with a payload built for `payloadCoverage`. */
function specDossier(
  covers: string | null = 'spec-frontmatter+body',
  payloadCoverage: SignatureCoverage = 'spec-frontmatter+body'
): string {
  const spec = toSpecFrontmatter(LOGICAL);
  if (covers === null) return renderSpec(spec);
  const unsigned = parseDossierContent(renderSpec(spec));
  const payload = buildSignedPayload(
    payloadCoverage === 'spec-frontmatter+body'
      ? unsigned.rawFrontmatter
      : (unsigned.frontmatter as Record<string, unknown>),
    unsigned.body,
    payloadCoverage
  );
  const metadata = {
    ...(spec.metadata as Record<string, string>),
    'dossier.signature': encodeSpecValue(signatureBlock(payload, covers)),
  };
  return renderSpec({ ...spec, metadata });
}

const check = (content: string) => checkPublishSignature(parseDossierContent(content));

describe('checkPublishSignature', () => {
  it('passes an unsigned dossier through as unsigned', async () => {
    expect(await check(legacyDossier())).toEqual({ status: 'unsigned' });
    expect(await check(specDossier(null))).toEqual({ status: 'unsigned' });
  });

  it('verifies a legacy v1 (body-only) signature', async () => {
    expect(await check(legacyDossier('body'))).toEqual({ status: 'verified', covers: 'body' });
  });

  it('verifies a legacy v2 (frontmatter+body) signature', async () => {
    expect(await check(legacyDossier('frontmatter+body'))).toEqual({
      status: 'verified',
      covers: 'frontmatter+body',
    });
  });

  it('verifies a spec-shaped v3 (spec-frontmatter+body) signature', async () => {
    const content = specDossier();
    expect(parseDossierContent(content).shape).toBe('spec');
    expect(await check(content)).toEqual({ status: 'verified', covers: 'spec-frontmatter+body' });
  });

  it('refuses a v3 dossier whose on-disk metadata was tampered with', async () => {
    const tampered = specDossier().replace(
      'dossier.risk_level: "low"',
      'dossier.risk_level: "critical"'
    );
    expect(tampered).not.toBe(specDossier());
    const result = await check(tampered);
    expect(result.status).toBe('invalid');
  });

  it('refuses a v3 dossier whose body was tampered with', async () => {
    const result = await check(specDossier().replace('Do the thing.', 'Do another thing.'));
    expect(result.status).toBe('invalid');
  });

  it('refuses an unknown covers value instead of throwing', async () => {
    const result = await check(specDossier('spec-frontmatter+body+future'));
    expect(result).toMatchObject({ status: 'invalid' });
    expect(result.status === 'invalid' && result.reason).toMatch(/Unsupported signature coverage/);
  });

  it('refuses a v2 signature carried onto a spec-shaped file', async () => {
    const result = await check(specDossier('frontmatter+body', 'frontmatter+body'));
    expect(result.status === 'invalid' && result.reason).toMatch(/only spec-frontmatter\+body/);
  });

  it('refuses a v3 signature on a legacy-shaped file', async () => {
    const legacy = parseDossierContent(legacyDossier('frontmatter+body'));
    const signature = { ...legacy.frontmatter.signature, covers: 'spec-frontmatter+body' };
    const result = await checkPublishSignature({
      ...legacy,
      frontmatter: { ...legacy.frontmatter, signature } as typeof legacy.frontmatter,
    });
    expect(result.status === 'invalid' && result.reason).toMatch(/only covers the spec shape/);
  });

  it('reports a KMS signature as not checked, without calling AWS', async () => {
    const parsed = parseDossierContent(legacyDossier('frontmatter+body'));
    const signature = {
      algorithm: 'ECDSA-SHA-256',
      signature: 'c2ln',
      key_id: 'arn:aws:kms:us-east-1:000000000000:key/test',
      signed_by: 'KMS Signer',
      covers: 'frontmatter+body',
    };
    const result = await checkPublishSignature({
      ...parsed,
      frontmatter: { ...parsed.frontmatter, signature } as typeof parsed.frontmatter,
    });
    expect(result).toMatchObject({ status: 'not-checked', covers: 'frontmatter+body' });
  });
});

describe('POST /api/v1/dossiers with spec-shaped content', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublishDossier.mockResolvedValue({
      file: {},
      manifest: {},
      publishedBy: 'alice',
      publishedAt: '2026-01-01T00:00:00.000Z',
    } as never);
  });

  async function publish(content: string) {
    const { default: handler } = await import('../api/v1/dossiers/index');
    const req = createMockReq({
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: { namespace: 'ns', content },
    }) as unknown as VercelRequest;
    const { res, getStatus, getBody } = createMockRes();
    await handler(req, res as unknown as VercelResponse);
    return { status: getStatus(), body: getBody() as Record<string, unknown> };
  }

  it('accepts a v3-signed spec dossier, indexes the logical frontmatter, stores bytes as sent', async () => {
    const content = specDossier();
    const { status, body } = await publish(content);

    expect(status).toBe(201);
    expect(body).toMatchObject({
      name: 'ns/spec-dossier',
      version: '1.2.0',
      title: 'Spec Dossier',
      signature: { status: 'verified', covers: 'spec-frontmatter+body' },
    });

    expect(mockPublishDossier).toHaveBeenCalledTimes(1);
    const [fullPath, stored, metadata] = mockPublishDossier.mock.calls[0];
    expect(fullPath).toBe('ns/spec-dossier');
    // Byte-exact: the v3 signature covers the on-disk spec frontmatter.
    expect(stored).toBe(content);
    expect(metadata).toMatchObject({
      name: 'spec-dossier',
      description: 'Exercises the spec shape end to end.',
      title: 'Spec Dossier',
      version: '1.2.0',
      risk_level: 'low',
      requires_approval: false,
      tags: ['spec', 'v3'],
    });
    expect(metadata).not.toHaveProperty('metadata');
  });

  it('accepts an unsigned spec dossier with signature null', async () => {
    const { status, body } = await publish(specDossier(null));
    expect(status).toBe(201);
    expect(body.signature).toBeNull();
  });

  it('accepts the legacy twin under v2', async () => {
    const { status, body } = await publish(legacyDossier('frontmatter+body'));
    expect(status).toBe(201);
    expect(body.signature).toEqual({ status: 'verified', covers: 'frontmatter+body' });
  });

  it('refuses a tampered v3 dossier with 400 INVALID_SIGNATURE and stores nothing', async () => {
    const { status, body } = await publish(
      specDossier().replace('dossier.risk_level: "low"', 'dossier.risk_level: "critical"')
    );
    expect(status).toBe(400);
    expect((body.error as { code: string }).code).toBe('INVALID_SIGNATURE');
    expect(mockPublishDossier).not.toHaveBeenCalled();
  });

  it('refuses an unknown covers value with 400, not 500', async () => {
    const { status, body } = await publish(specDossier('spec-frontmatter+body+future'));
    expect(status).toBe(400);
    expect((body.error as { code: string; message: string }).message).toMatch(
      /Unsupported signature coverage/
    );
    expect(mockPublishDossier).not.toHaveBeenCalled();
  });

  it('refuses malformed spec shape (a Dossier field at the top level) as INVALID_CONTENT', async () => {
    const content = specDossier(null).replace('---\n', '---\ntitle: "Smuggled"\n');
    const { status, body } = await publish(content);
    expect(status).toBe(400);
    expect((body.error as { code: string }).code).toBe('INVALID_CONTENT');
  });
});

describe('github.publishDossier with spec-shaped content', () => {
  it('writes the content file byte-exact and indexes the logical fields', async () => {
    const actual = await vi.importActual<typeof import('../lib/github')>('../lib/github');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('GITHUB_BOT_TOKEN', 'fake-token');
    const json = (data: unknown) =>
      ({ ok: true, status: 200, json: async () => data, text: async () => '' }) as Response;
    const notFound = { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    fetchMock
      .mockResolvedValueOnce(notFound) // GET content
      .mockResolvedValueOnce(json({ content: { sha: 'file-sha' } })) // PUT content
      .mockResolvedValueOnce(notFound) // GET sidecar
      .mockResolvedValueOnce(notFound) // GET index.json
      .mockResolvedValueOnce(json({ content: { sha: 'manifest-sha' } })); // PUT index.json

    try {
      const content = specDossier();
      const parsed = parseDossierContent(content);
      await actual.publishDossier('ns/spec-dossier', content, parsed.frontmatter, 'changelog');

      const puts = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT');
      const bodyOf = (i: number) => JSON.parse(puts[i][1].body as string);
      expect(Buffer.from(bodyOf(0).content, 'base64').toString('utf8')).toBe(content);

      const manifest = JSON.parse(Buffer.from(bodyOf(1).content, 'base64').toString('utf8'));
      expect(manifest.dossiers[0]).toMatchObject({
        name: 'ns/spec-dossier',
        title: 'Spec Dossier',
        version: '1.2.0',
        description: 'Exercises the spec shape end to end.',
        tags: ['spec', 'v3'],
      });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
