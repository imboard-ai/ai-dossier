import { describe, expect, it } from 'vitest';
import type { ValidationFailure } from '../api/v1/dossiers/index';
import { validatePublishInput } from '../api/v1/dossiers/index';
import { MAX_CHANGELOG_LENGTH, MAX_CONTENT_SIZE } from '../lib/constants';
import type { VercelRequest } from '../lib/types';
import { createMockReq } from './helpers/mocks';

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

function expectFailure(result: { ok: boolean }, status: number, code: string) {
  expect(result.ok).toBe(false);
  const failure = result as ValidationFailure;
  expect(failure.status).toBe(status);
  expect(failure.code).toBe(code);
}

describe('validatePublishInput', () => {
  it('returns validated fields for a valid request', () => {
    const req = makeReq();
    const result = validatePublishInput(req);
    expect(result).toEqual({
      ok: true,
      data: {
        namespace: 'test-org',
        content: validBody.content,
        changelog: undefined,
      },
    });
  });

  it('returns changelog when provided', () => {
    const body = { ...validBody, changelog: 'Updated docs' };
    const req = makeReq({ body });
    const result = validatePublishInput(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.changelog).toBe('Updated docs');
    }
  });

  it('rejects missing content-type', () => {
    const req = makeReq({ headers: {} });
    const result = validatePublishInput(req);
    expectFailure(result, 415, 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects wrong content-type', () => {
    const req = makeReq({ headers: { 'content-type': 'text/plain' } });
    const result = validatePublishInput(req);
    expectFailure(result, 415, 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects missing namespace', () => {
    const req = makeReq({ body: { content: 'x' } });
    const result = validatePublishInput(req);
    expectFailure(result, 400, 'MISSING_FIELD');
  });

  it('rejects non-string namespace', () => {
    const req = makeReq({ body: { namespace: 123, content: 'x' } });
    const result = validatePublishInput(req);
    expectFailure(result, 400, 'MISSING_FIELD');
  });

  it('rejects missing content', () => {
    const req = makeReq({ body: { namespace: 'test-org' } });
    const result = validatePublishInput(req);
    expectFailure(result, 400, 'MISSING_FIELD');
  });

  it('rejects non-string changelog', () => {
    const req = makeReq({ body: { ...validBody, changelog: 42 } });
    const result = validatePublishInput(req);
    expectFailure(result, 400, 'INVALID_FIELD');
  });

  it('rejects changelog exceeding max length', () => {
    const req = makeReq({
      body: { ...validBody, changelog: 'a'.repeat(MAX_CHANGELOG_LENGTH + 1) },
    });
    const result = validatePublishInput(req);
    expectFailure(result, 400, 'CHANGELOG_TOO_LONG');
  });

  it('rejects content exceeding max size', () => {
    const req = makeReq({
      body: { namespace: 'test-org', content: 'x'.repeat(MAX_CONTENT_SIZE + 1) },
    });
    const result = validatePublishInput(req);
    expectFailure(result, 413, 'CONTENT_TOO_LARGE');
  });

  it('rejects invalid namespace format', () => {
    const req = makeReq({ body: { namespace: '../../etc/passwd', content: 'x' } });
    const result = validatePublishInput(req);
    expectFailure(result, 400, 'INVALID_NAMESPACE');
  });

  it('handles empty body gracefully', () => {
    const req = createMockReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }) as unknown as VercelRequest;
    const result = validatePublishInput(req);
    expectFailure(result, 400, 'MISSING_FIELD');
  });
});
