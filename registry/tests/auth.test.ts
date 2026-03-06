import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import { authenticateRequest } from '../lib/auth';
import type { VercelRequest } from '../lib/types';

vi.mock('../lib/config', () => ({
  default: {
    auth: { jwt: { secret: 'test-secret' } },
  },
}));

function makeReq(authorization?: string): VercelRequest {
  return { headers: { authorization } } as unknown as VercelRequest;
}

function signToken(payload: Record<string, unknown>, opts?: jwt.SignOptions): string {
  return jwt.sign(payload, 'test-secret', { algorithm: 'HS256', ...opts });
}

describe('authenticateRequest', () => {
  it('returns MISSING_TOKEN when no Authorization header', () => {
    const result = authenticateRequest(makeReq());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MISSING_TOKEN');
      expect(result.status).toBe(401);
    }
  });

  it('returns MISSING_TOKEN when Authorization header is not Bearer', () => {
    const result = authenticateRequest(makeReq('Basic abc'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MISSING_TOKEN');
    }
  });

  it('returns payload on valid token', () => {
    const token = signToken({ sub: 'testuser', email: 'a@b.com', orgs: ['myorg'] });
    const result = authenticateRequest(makeReq(`Bearer ${token}`));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sub).toBe('testuser');
      expect(result.payload.orgs).toEqual(['myorg']);
    }
  });

  it('returns TOKEN_EXPIRED for expired token', () => {
    const token = signToken({ sub: 'u', email: null, orgs: [] }, { expiresIn: -1 });
    const result = authenticateRequest(makeReq(`Bearer ${token}`));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TOKEN_EXPIRED');
      expect(result.status).toBe(401);
    }
  });

  it('returns INVALID_TOKEN for malformed token', () => {
    const result = authenticateRequest(makeReq('Bearer not.a.valid.token'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_TOKEN');
      expect(result.status).toBe(401);
    }
  });
});
