import { describe, expect, it, vi } from 'vitest';
import { methodNotAllowed, serverError } from '../lib/responses';

function createMockRes() {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('methodNotAllowed', () => {
  it('returns 405 with single method', () => {
    const res = createMockRes();
    methodNotAllowed(res as never, 'GET');

    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is allowed' },
    });
  });

  it('returns 405 with two methods', () => {
    const res = createMockRes();
    methodNotAllowed(res as never, 'GET', 'POST');

    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET and POST are allowed' },
    });
  });

  it('returns 405 with three methods using Oxford comma', () => {
    const res = createMockRes();
    methodNotAllowed(res as never, 'GET', 'HEAD', 'DELETE');

    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET, HEAD, and DELETE are allowed' },
    });
  });
});

describe('serverError', () => {
  it('returns 502 with request_id and logs structured JSON', () => {
    const res = createMockRes();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    serverError(res as never, {
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

    const loggedJson = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(loggedJson.level).toBe('error');
    expect(loggedJson.operation).toBe('dossier.list');
    expect(loggedJson.requestId).toBe(jsonArg.error.request_id);
    expect(loggedJson.error).toBe('upstream timeout');
    expect(loggedJson.stack).toBeDefined();

    consoleSpy.mockRestore();
  });

  it('supports custom status code', () => {
    const res = createMockRes();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    serverError(res as never, {
      operation: 'test',
      error: 'string error',
      code: 'TEST',
      message: 'test',
      status: 500,
    });

    expect(res.status).toHaveBeenCalledWith(500);
    vi.restoreAllMocks();
  });
});
