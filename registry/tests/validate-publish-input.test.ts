import { describe, expect, it } from 'vitest';
import { validatePublishInput } from '../api/v1/dossiers/index';
import { MAX_CHANGELOG_LENGTH, MAX_CONTENT_SIZE } from '../lib/constants';
import type { VercelRequest, VercelResponse } from '../lib/types';
import { createMockReq, createMockRes } from './helpers/mocks';

const validBody = {
  namespace: 'test-org',
  content: '---\nname: test\ntitle: Test\nversion: 1.0.0\n---\n# Body',
};

function makeReq(overrides: Parameters<typeof createMockReq>[0] = {}) {
  return createMockReq({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...overrides.headers },
    body: { ...validBody, ...((overrides.body ?? {}) as Record<string, unknown>) },
    ...overrides,
  }) as unknown as VercelRequest;
}

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

describe('validatePublishInput', () => {
  it('returns validated fields for a valid request', () => {
    const req = makeReq();
    const { res } = createMockRes();
    const result = validatePublishInput(req, res as unknown as VercelResponse, 'test-req-id');
    expect(result).toEqual({
      namespace: 'test-org',
      content: validBody.content,
      changelog: undefined,
    });
  });

  it('returns changelog when provided', () => {
    const body = { ...validBody, changelog: 'Updated docs' };
    const req = makeReq({ body });
    const { res } = createMockRes();
    const result = validatePublishInput(req, res as unknown as VercelResponse, 'test-req-id');
    expect(result).not.toBeNull();
    expect(result?.changelog).toBe('Updated docs');
  });

  it('rejects missing content-type', () => {
    const req = makeReq({ headers: {} });
    const { res, getStatus, getBody } = createMockRes();
    const result = validatePublishInput(req, res as unknown as VercelResponse, 'test-req-id');
    expect(result).toBeNull();
    expect(getStatus()).toBe(415);
    expect(errorCode(getBody())).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects wrong content-type', () => {
    const req = makeReq({ headers: { 'content-type': 'text/plain' } });
    const { res, getStatus } = createMockRes();
    const result = validatePublishInput(req, res as unknown as VercelResponse, 'test-req-id');
    expect(result).toBeNull();
    expect(getStatus()).toBe(415);
  });

  it('rejects missing namespace', () => {
    const req = makeReq({ body: { content: 'x' } });
    const { res, getStatus, getBody } = createMockRes();
    const result = validatePublishInput(req, res as unknown as VercelResponse, 'test-req-id');
    expect(result).toBeNull();
    expect(getStatus()).toBe(400);
    expect(errorCode(getBody())).toBe('MISSING_FIELD');
  });

  it('rejects non-string namespace', () => {
    const req = makeReq({ body: { namespace: 123, content: 'x' } });
    const { res, getStatus } = createMockRes();
    const result = validatePublishInput(req, res as unknown as VercelResponse, 'test-req-id');
    expect(result).toBeNull();
    expect(getStatus()).toBe(400);
  });

  it('rejects missing content', () => {
    const req = makeReq({ body: { namespace: 'test-org' } });
    const { res, getStatus, getBody } = createMockRes();
    const result = validatePublishInput(req, res as unknown as VercelResponse, 'test-req-id');
    expect(result).toBeNull();
    expect(getStatus()).toBe(400);
    expect(errorCode(getBody())).toBe('MISSING_FIELD');
  });

  it('rejects non-string changelog', () => {
    const req = makeReq({ body: { ...validBody, changelog: 42 } });
    const { res, getStatus, getBody } = createMockRes();
    const result = validatePublishInput(req, res as unknown as VercelResponse, 'test-req-id');
    expect(result).toBeNull();
    expect(getStatus()).toBe(400);
    expect(errorCode(getBody())).toBe('INVALID_FIELD');
  });

  it('rejects changelog exceeding max length', () => {
    const req = makeReq({
      body: { ...validBody, changelog: 'a'.repeat(MAX_CHANGELOG_LENGTH + 1) },
    });
    const { res, getStatus, getBody } = createMockRes();
    const result = validatePublishInput(req, res as unknown as VercelResponse, 'test-req-id');
    expect(result).toBeNull();
    expect(getStatus()).toBe(400);
    expect(errorCode(getBody())).toBe('CHANGELOG_TOO_LONG');
  });

  it('rejects content exceeding max size', () => {
    const req = makeReq({
      body: { namespace: 'test-org', content: 'x'.repeat(MAX_CONTENT_SIZE + 1) },
    });
    const { res, getStatus, getBody } = createMockRes();
    const result = validatePublishInput(req, res as unknown as VercelResponse, 'test-req-id');
    expect(result).toBeNull();
    expect(getStatus()).toBe(413);
    expect(errorCode(getBody())).toBe('CONTENT_TOO_LARGE');
  });

  it('rejects invalid namespace format', () => {
    const req = makeReq({ body: { namespace: '../../etc/passwd', content: 'x' } });
    const { res, getStatus, getBody } = createMockRes();
    const result = validatePublishInput(req, res as unknown as VercelResponse, 'test-req-id');
    expect(result).toBeNull();
    expect(getStatus()).toBe(400);
    expect(errorCode(getBody())).toBe('INVALID_NAMESPACE');
  });

  it('handles empty body gracefully', () => {
    const req = createMockReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }) as unknown as VercelRequest;
    const { res, getStatus } = createMockRes();
    const result = validatePublishInput(req, res as unknown as VercelResponse, 'test-req-id');
    expect(result).toBeNull();
    expect(getStatus()).toBe(400);
  });
});
