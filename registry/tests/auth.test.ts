import { describe, expect, it, vi } from 'vitest';
import * as auth from '../lib/auth';
import type { VercelRequest, VercelResponse } from '../lib/types';

vi.mock('jsonwebtoken', () => ({
  default: {
    sign: vi.fn(),
    verify: vi.fn(),
  },
}));

import jwt from 'jsonwebtoken';

function mockRequest(headers: Record<string, string> = {}): VercelRequest {
  return { headers } as unknown as VercelRequest;
}

function mockResponse() {
  const res = {
    statusCode: 0,
    body: null as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.body = data;
      return res;
    },
  };
  return res as unknown as VercelResponse & { statusCode: number; body: unknown };
}

describe('requireAuth', () => {
  it('should return 401 MISSING_TOKEN when no authorization header', () => {
    const req = mockRequest();
    const res = mockResponse();

    const result = auth.requireAuth(req, res);

    expect(result).toBeNull();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      error: {
        code: 'MISSING_TOKEN',
        message: 'Authorization header required. Use: Bearer <token>',
      },
    });
  });

  it('should return 401 MISSING_TOKEN when authorization header is not Bearer', () => {
    const req = mockRequest({ authorization: 'Basic abc123' });
    const res = mockResponse();

    const result = auth.requireAuth(req, res);

    expect(result).toBeNull();
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('MISSING_TOKEN');
  });

  it('should return 401 TOKEN_EXPIRED for expired tokens', () => {
    const req = mockRequest({ authorization: 'Bearer expired-token' });
    const res = mockResponse();

    const err = new Error('jwt expired');
    err.name = 'TokenExpiredError';
    vi.mocked(jwt.verify).mockImplementation(() => {
      throw err;
    });

    const result = auth.requireAuth(req, res);

    expect(result).toBeNull();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'TOKEN_EXPIRED', message: 'Token has expired. Please login again.' },
    });
  });

  it('should return 401 INVALID_TOKEN for invalid tokens', () => {
    const req = mockRequest({ authorization: 'Bearer bad-token' });
    const res = mockResponse();

    const err = new Error('jwt malformed');
    err.name = 'JsonWebTokenError';
    vi.mocked(jwt.verify).mockImplementation(() => {
      throw err;
    });

    const result = auth.requireAuth(req, res);

    expect(result).toBeNull();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'INVALID_TOKEN', message: 'Invalid token. Please login again.' },
    });
  });

  it('should return JwtPayload for valid tokens', () => {
    const req = mockRequest({ authorization: 'Bearer valid-token' });
    const res = mockResponse();

    const mockPayload = { sub: 'testuser', email: 'test@example.com', orgs: ['org1'] };
    vi.mocked(jwt.verify).mockReturnValue(mockPayload as any);

    const result = auth.requireAuth(req, res);

    expect(result).toEqual(mockPayload);
    expect(res.statusCode).toBe(0);
  });
});
