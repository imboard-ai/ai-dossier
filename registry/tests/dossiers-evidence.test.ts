import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockReq, createMockRes } from './helpers/mocks';

vi.mock('../lib/auth', () => ({
  authorizePublish: vi.fn().mockResolvedValue(true),
}));

vi.mock('../lib/github', async () => {
  const actual = await vi.importActual<typeof import('../lib/github')>('../lib/github');
  return {
    ...actual,
    getManifest: vi.fn(),
    getFileContent: vi.fn(),
    publishDossier: vi.fn(),
  };
});

import { authorizePublish } from '../lib/auth';
import * as github from '../lib/github';
import type { VercelRequest, VercelResponse } from '../lib/types';

const mockGetManifest = vi.mocked(github.getManifest);
const mockGetFileContent = vi.mocked(github.getFileContent);
const mockPublishDossier = vi.mocked(github.publishDossier);
const mockAuthorizePublish = vi.mocked(authorizePublish);

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const manifestEntry = {
  name: 'ns/test-dossier',
  title: 'Test',
  version: '1.0.0',
  path: 'ns/test-dossier.ds.md',
};

function makeReq(overrides: Parameters<typeof createMockReq>[0] = {}) {
  return createMockReq(overrides) as unknown as VercelRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthorizePublish.mockResolvedValue(true);
});

describe('GET .../evidence', () => {
  it('returns the sidecar when it exists', async () => {
    const { default: handler } = await import('../api/v1/dossiers/[...name]');
    mockGetManifest.mockResolvedValue({ dossiers: [manifestEntry], sha: 'manifest-sha' });
    const evidenceRecord = {
      evidence_schema_version: '1.0.0',
      dossier: 'ns/test-dossier',
      version: '1.0.0',
      checksum: { algorithm: 'sha256', hash: HASH_A },
      entries: [],
    };
    const stored = JSON.stringify(evidenceRecord);
    mockGetFileContent.mockResolvedValue({ content: stored, sha: 'evidence-sha' });

    const req = makeReq({ method: 'GET', query: { name: ['ns', 'test-dossier', 'evidence'] } });
    const { res, getStatus, getBody, headers } = createMockRes();

    await handler(req, res as unknown as VercelResponse);

    expect(getStatus()).toBe(200);
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Evidence-Checksum']).toBe(`sha256:${HASH_A}`);
    expect(getBody()).toBe(stored);
    expect(mockGetFileContent).toHaveBeenCalledWith('ns/test-dossier.evidence.json');
  });

  it('returns 404 EVIDENCE_NOT_FOUND when the sidecar is missing', async () => {
    const { default: handler } = await import('../api/v1/dossiers/[...name]');
    mockGetManifest.mockResolvedValue({ dossiers: [manifestEntry], sha: 'manifest-sha' });
    mockGetFileContent.mockResolvedValue(null);

    const req = makeReq({ method: 'GET', query: { name: ['ns', 'test-dossier', 'evidence'] } });
    const { res, getStatus, getBody } = createMockRes();

    await handler(req, res as unknown as VercelResponse);

    expect(getStatus()).toBe(404);
    expect((getBody() as { error: { code: string } }).error.code).toBe('EVIDENCE_NOT_FOUND');
  });

  it('returns 502 EVIDENCE_CORRUPT when the stored sidecar does not parse', async () => {
    const { default: handler } = await import('../api/v1/dossiers/[...name]');
    mockGetManifest.mockResolvedValue({ dossiers: [manifestEntry], sha: 'manifest-sha' });
    mockGetFileContent.mockResolvedValue({ content: 'not json', sha: 'evidence-sha' });

    const req = makeReq({ method: 'GET', query: { name: ['ns', 'test-dossier', 'evidence'] } });
    const { res, getStatus, getBody } = createMockRes();

    await handler(req, res as unknown as VercelResponse);

    expect(getStatus()).toBe(502);
    expect((getBody() as { error: { code: string } }).error.code).toBe('EVIDENCE_CORRUPT');
  });

  it('returns 502 EVIDENCE_CORRUPT when the stored sidecar binds a different dossier/version', async () => {
    const { default: handler } = await import('../api/v1/dossiers/[...name]');
    mockGetManifest.mockResolvedValue({ dossiers: [manifestEntry], sha: 'manifest-sha' });
    const staleRecord = JSON.stringify({
      evidence_schema_version: '1.0.0',
      dossier: 'ns/test-dossier',
      version: '0.9.0', // stale — manifestEntry.version is 1.0.0
      checksum: { algorithm: 'sha256', hash: HASH_A },
      entries: [],
    });
    mockGetFileContent.mockResolvedValue({ content: staleRecord, sha: 'evidence-sha' });

    const req = makeReq({ method: 'GET', query: { name: ['ns', 'test-dossier', 'evidence'] } });
    const { res, getStatus, getBody } = createMockRes();

    await handler(req, res as unknown as VercelResponse);

    expect(getStatus()).toBe(502);
    expect((getBody() as { error: { code: string } }).error.code).toBe('EVIDENCE_CORRUPT');
  });

  it('returns 404 VERSION_NOT_FOUND for a mismatched version, same as content', async () => {
    const { default: handler } = await import('../api/v1/dossiers/[...name]');
    mockGetManifest.mockResolvedValue({ dossiers: [manifestEntry], sha: 'manifest-sha' });

    const req = makeReq({
      method: 'GET',
      query: { name: ['ns', 'test-dossier', 'evidence'], version: '9.9.9' },
    });
    const { res, getStatus, getBody } = createMockRes();

    await handler(req, res as unknown as VercelResponse);

    expect(getStatus()).toBe(404);
    expect((getBody() as { error: { code: string } }).error.code).toBe('VERSION_NOT_FOUND');
    expect(mockGetFileContent).not.toHaveBeenCalled();
  });

  it('returns 405 for DELETE on .../evidence', async () => {
    const { default: handler } = await import('../api/v1/dossiers/[...name]');

    const req = makeReq({ method: 'DELETE', query: { name: ['ns', 'test-dossier', 'evidence'] } });
    const { res, getStatus } = createMockRes();

    await handler(req, res as unknown as VercelResponse);

    expect(getStatus()).toBe(405);
  });

  it('leaves GET .../content unaffected: still 200 with X-Dossier-Digest', async () => {
    const { default: handler } = await import('../api/v1/dossiers/[...name]');
    mockGetManifest.mockResolvedValue({ dossiers: [manifestEntry], sha: 'manifest-sha' });
    mockGetFileContent.mockResolvedValue({ content: '# Hello', sha: 'content-sha' });

    const req = makeReq({ method: 'GET', query: { name: ['ns', 'test-dossier', 'content'] } });
    const { res, getStatus, headers } = createMockRes();

    await handler(req, res as unknown as VercelResponse);

    expect(getStatus()).toBe(200);
    expect(headers['X-Dossier-Digest']).toMatch(/^sha256:/);
    expect(mockGetFileContent).toHaveBeenCalledWith('ns/test-dossier.ds.md');
  });
});

const dossierContent = (checksumHash: string) =>
  `---\nname: test-dossier\ntitle: Test\nversion: 1.0.0\nchecksum:\n  algorithm: sha256\n  hash: ${checksumHash}\n---\n# Body`;

function publishReq(body: Record<string, unknown>) {
  return makeReq({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { namespace: 'ns', content: dossierContent(HASH_A), ...body },
  });
}

describe('POST /dossiers (publish) with evidence', () => {
  it('rejects a checksum mismatch with 400 EVIDENCE_MISMATCH; publishDossier not called', async () => {
    const { default: handler } = await import('../api/v1/dossiers/index');
    const evidence = JSON.stringify({
      evidence_schema_version: '1.0.0',
      dossier: 'ns/test-dossier',
      version: '1.0.0',
      checksum: { algorithm: 'sha256', hash: HASH_B },
      entries: [],
    });

    const req = publishReq({ evidence });
    const { res, getStatus, getBody } = createMockRes();

    await handler(req, res as unknown as VercelResponse);

    expect(getStatus()).toBe(400);
    expect((getBody() as { error: { code: string } }).error.code).toBe('EVIDENCE_MISMATCH');
    expect(mockPublishDossier).not.toHaveBeenCalled();
  });

  it('rejects unparsable evidence with 400 INVALID_EVIDENCE', async () => {
    const { default: handler } = await import('../api/v1/dossiers/index');

    const req = publishReq({ evidence: 'not json' });
    const { res, getStatus, getBody } = createMockRes();

    await handler(req, res as unknown as VercelResponse);

    expect(getStatus()).toBe(400);
    expect((getBody() as { error: { code: string } }).error.code).toBe('INVALID_EVIDENCE');
    expect(mockPublishDossier).not.toHaveBeenCalled();
  });

  it('publishes with matching evidence: 201, evidence_url present, publishDossier called with evidence string', async () => {
    const { default: handler } = await import('../api/v1/dossiers/index');
    mockPublishDossier.mockResolvedValue({
      file: { content: { sha: 'file-sha' }, commit: { sha: 'commit-sha' } } as never,
      manifest: { content: { sha: 'manifest-sha' }, commit: { sha: 'commit-sha' } } as never,
    });

    const evidence = JSON.stringify({
      evidence_schema_version: '1.0.0',
      dossier: 'ns/test-dossier',
      version: '1.0.0',
      checksum: { algorithm: 'sha256', hash: HASH_A },
      entries: [],
    });

    const req = publishReq({ evidence });
    const { res, getStatus, getBody } = createMockRes();

    await handler(req, res as unknown as VercelResponse);

    expect(getStatus()).toBe(201);
    const body = getBody() as { evidence_url?: string };
    expect(body.evidence_url).toMatch(/\.evidence\.json$/);
    expect(mockPublishDossier).toHaveBeenCalledWith(
      'ns/test-dossier',
      expect.any(String),
      expect.any(Object),
      expect.any(String),
      evidence
    );
  });

  it('publishes without evidence: 201, no evidence_url key', async () => {
    const { default: handler } = await import('../api/v1/dossiers/index');
    mockPublishDossier.mockResolvedValue({
      file: { content: { sha: 'file-sha' }, commit: { sha: 'commit-sha' } } as never,
      manifest: { content: { sha: 'manifest-sha' }, commit: { sha: 'commit-sha' } } as never,
    });

    const req = publishReq({});
    const { res, getStatus, getBody } = createMockRes();

    await handler(req, res as unknown as VercelResponse);

    expect(getStatus()).toBe(201);
    const body = getBody() as Record<string, unknown>;
    expect('evidence_url' in body).toBe(false);
    expect(mockPublishDossier).toHaveBeenCalledWith(
      'ns/test-dossier',
      expect.any(String),
      expect.any(Object),
      expect.any(String),
      null
    );
  });
});
