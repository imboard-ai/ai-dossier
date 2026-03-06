import { describe, expect, it, vi } from 'vitest';
import { methodNotAllowed } from '../lib/responses';

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
