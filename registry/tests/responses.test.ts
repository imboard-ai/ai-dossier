import { describe, expect, it, vi } from 'vitest';
import { getRequestId, methodNotAllowed, serverError } from '../lib/responses';
import type { VercelRequest } from '../lib/types';
import { createViMockRes } from './helpers/mocks';

describe('methodNotAllowed', () => {
  const mockReq = { method: 'POST', url: '/api/v1/test', headers: {} } as unknown as VercelRequest;

  it('returns 405 with single method', () => {
    const res = createViMockRes();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    methodNotAllowed(mockReq, res, 'GET');

    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is allowed' },
    });
    vi.restoreAllMocks();
  });

  it('returns 405 with two methods', () => {
    const res = createViMockRes();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    methodNotAllowed(mockReq, res, 'GET', 'POST');

    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET and POST are allowed' },
    });
    vi.restoreAllMocks();
  });

  it('returns 405 with three methods using Oxford comma', () => {
    const res = createViMockRes();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    methodNotAllowed(mockReq, res, 'GET', 'HEAD', 'DELETE');

    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET, HEAD, and DELETE are allowed' },
    });
    vi.restoreAllMocks();
  });

  it('logs rejected method and URL', () => {
    const res = createViMockRes();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const req = {
      method: 'DELETE',
      url: '/api/v1/search',
      headers: {},
    } as unknown as VercelRequest;

    methodNotAllowed(req, res, 'GET');

    expect(warnSpy).toHaveBeenCalledOnce();
    const loggedJson = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(loggedJson.level).toBe('warn');
    expect(loggedJson.context).toBe('responses');
    expect(loggedJson.message).toBe('method-not-allowed');
    expect(loggedJson.method).toBe('DELETE');
    expect(loggedJson.url).toBe('/api/v1/search');
    expect(loggedJson.allowed).toEqual(['GET']);

    warnSpy.mockRestore();
  });
});

describe('serverError', () => {
  it('returns 502 with request_id and logs structured JSON', () => {
    const res = createViMockRes();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

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

    const loggedJson = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(loggedJson.level).toBe('error');
    expect(loggedJson.context).toBe('responses');
    expect(loggedJson.message).toBe('dossier.list');
    expect(loggedJson.requestId).toBe(jsonArg.error.request_id);
    expect(loggedJson.errorType).toBe('Error');
    expect(loggedJson.error).toBe('upstream timeout');
    expect(loggedJson.stack).toBeDefined();

    consoleSpy.mockRestore();
  });

  it('supports custom status code', () => {
    const res = createViMockRes();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    serverError(res, {
      operation: 'test',
      error: 'string error',
      code: 'TEST',
      message: 'test',
      status: 500,
    });

    expect(res.status).toHaveBeenCalledWith(500);
    vi.restoreAllMocks();
  });

  it('uses provided requestId instead of generating one', () => {
    const res = createViMockRes();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    serverError(res, {
      operation: 'test',
      error: new Error('fail'),
      code: 'TEST',
      message: 'test',
      requestId: 'my-request-id-123',
    });

    const jsonArg = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(jsonArg.error.request_id).toBe('my-request-id-123');

    const loggedJson = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(loggedJson.requestId).toBe('my-request-id-123');

    consoleSpy.mockRestore();
  });

  it('includes errorType in log but not in response', () => {
    const res = createViMockRes();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    serverError(res, {
      operation: 'test',
      error: 'string error',
      code: 'TEST',
      message: 'test',
    });

    const jsonArg = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(jsonArg.error.error_type).toBeUndefined();

    const loggedJson = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(loggedJson.errorType).toBe('string');

    consoleSpy.mockRestore();
  });
});

describe('getRequestId', () => {
  it('returns existing X-Request-Id header', () => {
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
});
