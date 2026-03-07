import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  badRequest,
  generateErrorRef,
  getRequestId,
  invalidNamespaceError,
  invalidPathError,
  jsonError,
  methodNotAllowed,
  normalizeError,
  notFound,
  serverError,
} from '../lib/responses';
import type { VercelRequest } from '../lib/types';
import { createViMockRes } from './helpers/mocks';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('methodNotAllowed', () => {
  const mockReq = { method: 'POST', url: '/api/v1/test', headers: {} } as unknown as VercelRequest;

  it('returns 405 with single method', () => {
    const res = createViMockRes();

    methodNotAllowed(mockReq, res, 'GET');

    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is allowed' },
    });
  });

  it('returns 405 with two methods', () => {
    const res = createViMockRes();

    methodNotAllowed(mockReq, res, 'GET', 'POST');

    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET and POST are allowed' },
    });
  });

  it('returns 405 with three methods using Oxford comma', () => {
    const res = createViMockRes();

    methodNotAllowed(mockReq, res, 'GET', 'HEAD', 'DELETE');

    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET, HEAD, and DELETE are allowed' },
    });
  });

  it('logs rejected method and path (without query string)', () => {
    const res = createViMockRes();
    const warnSpy = vi.mocked(console.warn);
    const req = {
      method: 'DELETE',
      url: '/api/v1/search?q=sensitive',
      headers: {},
    } as unknown as VercelRequest;

    methodNotAllowed(req, res, 'GET');

    expect(warnSpy).toHaveBeenCalledOnce();
    const loggedJson = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(loggedJson.level).toBe('warn');
    expect(loggedJson.context).toBe('responses');
    expect(loggedJson.message).toBe('method-not-allowed');
    expect(loggedJson.method).toBe('DELETE');
    expect(loggedJson.path).toBe('/api/v1/search');
    expect(loggedJson.allowed).toEqual(['GET']);
  });
});

describe('serverError', () => {
  it('returns 502 with request_id and logs structured JSON', () => {
    const res = createViMockRes();
    const errorSpy = vi.mocked(console.error);

    serverError(res, {
      operation: 'dossier.list',
      error: new Error('upstream timeout'),
      code: 'UPSTREAM_ERROR',
      message: 'Failed to fetch dossier list',
    });

    expect(res.status).toHaveBeenCalledWith(502);
    const jsonArg = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(jsonArg.error.code).toBe('UPSTREAM_ERROR');
    expect(jsonArg.error.message).toBe('Failed to fetch dossier list');
    expect(jsonArg.error.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(jsonArg.error.error_type).toBeUndefined();

    const loggedJson = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(loggedJson.level).toBe('error');
    expect(loggedJson.context).toBe('responses');
    expect(loggedJson.message).toBe('dossier.list');
    expect(loggedJson.requestId).toBe(jsonArg.error.request_id);
    expect(loggedJson.errorType).toBe('Error');
    expect(loggedJson.error).toBe('upstream timeout');
    expect(loggedJson.stack).toBeDefined();
  });

  it('supports custom status code', () => {
    const res = createViMockRes();

    serverError(res, {
      operation: 'test',
      error: 'string error',
      code: 'TEST',
      message: 'test',
      status: 500,
    });

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('uses provided requestId instead of generating one', () => {
    const res = createViMockRes();
    const errorSpy = vi.mocked(console.error);

    serverError(res, {
      operation: 'test',
      error: new Error('fail'),
      code: 'TEST',
      message: 'test',
      requestId: 'my-request-id-123',
    });

    const jsonArg = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(jsonArg.error.request_id).toBe('my-request-id-123');

    const loggedJson = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(loggedJson.requestId).toBe('my-request-id-123');
  });

  it('includes context fields in log output', () => {
    const res = createViMockRes();
    const errorSpy = vi.mocked(console.error);

    serverError(res, {
      operation: 'dossier.publish',
      error: new Error('GitHub API error'),
      code: 'PUBLISH_ERROR',
      message: 'Failed to publish dossier',
      requestId: 'req-123',
      context: { namespace: 'my-org', path: 'my-org/my-dossier' },
    });

    const loggedJson = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(loggedJson.namespace).toBe('my-org');
    expect(loggedJson.path).toBe('my-org/my-dossier');
    expect(loggedJson.requestId).toBe('req-123');
  });

  it('includes errorType in log but not in response', () => {
    const res = createViMockRes();
    const errorSpy = vi.mocked(console.error);

    serverError(res, {
      operation: 'test',
      error: 'string error',
      code: 'TEST',
      message: 'test',
    });

    const jsonArg = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(jsonArg.error.error_type).toBeUndefined();

    const loggedJson = JSON.parse(errorSpy.mock.calls[0][0] as string);
    // normalizeError wraps strings into Error objects, so errorType is always 'Error'
    expect(loggedJson.errorType).toBe('Error');
  });
});

describe('invalidPathError', () => {
  it('returns 400 with INVALID_PATH code and logs warning', () => {
    const res = createViMockRes();
    const warnSpy = vi.mocked(console.warn);

    invalidPathError(res, 'req-abc', 'my-org/evil-dossier');

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'INVALID_PATH',
        message: 'Path traversal is not allowed',
        request_id: 'req-abc',
      },
    });

    const loggedJson = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(loggedJson.level).toBe('warn');
    expect(loggedJson.message).toBe('Path traversal detected');
    expect(loggedJson.requestId).toBe('req-abc');
    expect(loggedJson.identifier).toBe('my-org/evil-dossier');
  });
});

describe('invalidNamespaceError', () => {
  it('returns 400 with INVALID_NAMESPACE code and logs warning', () => {
    const res = createViMockRes();
    const warnSpy = vi.mocked(console.warn);

    invalidNamespaceError(res, 'req-123', 'Namespace is required');

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'INVALID_NAMESPACE', message: 'Namespace is required', request_id: 'req-123' },
    });

    const loggedJson = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(loggedJson.level).toBe('warn');
    expect(loggedJson.message).toBe('Invalid namespace');
    expect(loggedJson.requestId).toBe('req-123');
    expect(loggedJson.detail).toBe('Namespace is required');
  });

  it('passes through the error message', () => {
    const res = createViMockRes();

    invalidNamespaceError(res, 'req-456', 'Invalid namespace segment: UPPER');

    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'INVALID_NAMESPACE',
        message: 'Invalid namespace segment: UPPER',
        request_id: 'req-456',
      },
    });
  });
});

describe('normalizeError', () => {
  it('returns the same Error instance when given an Error', () => {
    const err = new Error('test');
    expect(normalizeError(err)).toBe(err);
  });

  it('wraps a string into an Error', () => {
    const result = normalizeError('string failure');
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('string failure');
  });

  it('wraps null into an Error', () => {
    const result = normalizeError(null);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('null');
  });
});

describe('generateErrorRef', () => {
  it('returns a hex string of the expected length', () => {
    const ref = generateErrorRef();
    // ERROR_REF_BYTES = 4, so hex string is 8 characters
    expect(ref).toMatch(/^[0-9a-f]{8}$/);
  });

  it('returns different values on successive calls', () => {
    const refs = new Set(Array.from({ length: 10 }, () => generateErrorRef()));
    expect(refs.size).toBeGreaterThan(1);
  });
});

describe('jsonError', () => {
  it('sets the status and returns the standard error shape', () => {
    const res = createViMockRes();
    jsonError(res, 418, 'TEAPOT', 'I am a teapot');

    expect(res.status).toHaveBeenCalledWith(418);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'TEAPOT', message: 'I am a teapot' },
    });
  });

  it('includes request_id when provided', () => {
    const res = createViMockRes();
    jsonError(res, 400, 'BAD', 'bad request', 'req-123');

    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'BAD', message: 'bad request', request_id: 'req-123' },
    });
  });
});

describe('badRequest', () => {
  it('returns 400 with the standard error shape', () => {
    const res = createViMockRes();
    badRequest(res, 'MISSING_FIELD', 'name is required');

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'MISSING_FIELD', message: 'name is required' },
    });
  });

  it('includes request_id when provided', () => {
    const res = createViMockRes();
    badRequest(res, 'MISSING_FIELD', 'name is required', 'req-456');

    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'MISSING_FIELD', message: 'name is required', request_id: 'req-456' },
    });
  });
});

describe('notFound', () => {
  it('returns 404 with the standard error shape', () => {
    const res = createViMockRes();
    notFound(res, 'DOSSIER_NOT_FOUND', "Dossier 'foo' not found");

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'DOSSIER_NOT_FOUND', message: "Dossier 'foo' not found" },
    });
  });

  it('includes request_id when provided', () => {
    const res = createViMockRes();
    notFound(res, 'DOSSIER_NOT_FOUND', "Dossier 'foo' not found", 'req-789');

    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'DOSSIER_NOT_FOUND',
        message: "Dossier 'foo' not found",
        request_id: 'req-789',
      },
    });
  });
});

describe('getRequestId', () => {
  it('returns existing X-Request-Id header when valid', () => {
    const req = { headers: { 'x-request-id': 'existing-id' } } as never;
    expect(getRequestId(req)).toBe('existing-id');
  });

  it('returns first element if header is an array', () => {
    const req = { headers: { 'x-request-id': ['id-1', 'id-2'] } } as never;
    expect(getRequestId(req)).toBe('id-1');
  });

  it('generates UUID when no header present', () => {
    const req = { headers: {} } as never;
    const id = getRequestId(req);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('rejects request IDs longer than 64 characters and logs warning', () => {
    const warnSpy = vi.mocked(console.warn);
    const req = { headers: { 'x-request-id': 'a'.repeat(65) } } as never;
    const id = getRequestId(req);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const loggedJson = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(loggedJson.message).toBe('Rejected invalid X-Request-Id');
  });

  it('rejects request IDs with invalid characters and logs warning', () => {
    const warnSpy = vi.mocked(console.warn);
    const req = { headers: { 'x-request-id': '<script>alert(1)</script>' } } as never;
    const id = getRequestId(req);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const loggedJson = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(loggedJson.message).toBe('Rejected invalid X-Request-Id');
  });

  it('accepts alphanumeric IDs with hyphens', () => {
    const req = { headers: { 'x-request-id': 'abc-123-DEF' } } as never;
    expect(getRequestId(req)).toBe('abc-123-DEF');
  });
});
