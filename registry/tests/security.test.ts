import crypto from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OAUTH_STATE_COOKIE } from '../lib/constants';
import { validateNamespace } from '../lib/dossier';

describe('path traversal defense (sanitizePath)', () => {
  // We test via the exported getFileContent which internally calls sanitizePath.
  // Since getFileContent makes network calls, we test sanitizePath logic directly
  // by importing the module and testing the validation patterns.

  it('validateNamespace rejects path traversal with ..', () => {
    const result = validateNamespace('../../etc/passwd');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('..');
  });

  it('validateNamespace rejects namespace with ..', () => {
    const result = validateNamespace('foo/../bar');
    expect(result.valid).toBe(false);
  });

  it('validateNamespace accepts valid namespace', () => {
    const result = validateNamespace('imboard-ai/my-dossier');
    expect(result.valid).toBe(true);
  });

  it('validateNamespace rejects deeply nested namespaces', () => {
    const result = validateNamespace('a/b/c/d/e/f');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('max 5 levels');
  });
});

describe('path.posix.normalize behavior for sanitizePath', () => {
  it('normalizes ../etc/passwd to ../etc/passwd (still starts with ..)', () => {
    const result = path.posix.normalize('../etc/passwd');
    expect(result).toBe('../etc/passwd');
    expect(result.startsWith('..')).toBe(true);
  });

  it('normalizes foo/../../bar to ../bar', () => {
    const result = path.posix.normalize('foo/../../bar');
    expect(result.startsWith('..')).toBe(true);
  });

  it('normalizes valid path correctly', () => {
    const result = path.posix.normalize('imboard-ai/my-dossier.ds.md');
    expect(result).toBe('imboard-ai/my-dossier.ds.md');
    expect(result.startsWith('..')).toBe(false);
    expect(result.startsWith('/')).toBe(false);
  });

  it('normalizes /etc/passwd (absolute path starts with /)', () => {
    const result = path.posix.normalize('/etc/passwd');
    expect(result.startsWith('/')).toBe(true);
  });
});

describe('CORS restriction', () => {
  function createMockReqRes(origin?: string) {
    const headers: Record<string, string> = {};
    const req = { headers: origin ? { origin } : {} } as any;
    const res = {
      setHeader: (key: string, value: string) => {
        headers[key] = value;
      },
    } as any;
    return { headers, req, res };
  }

  it('does not set Access-Control-Allow-Origin for unknown origins', async () => {
    const { setCorsHeaders } = await import('../lib/cors');
    const { headers, req, res } = createMockReqRes('https://evil.com');

    setCorsHeaders(req, res);

    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(headers['Access-Control-Allow-Methods']).toBeDefined();
  });

  it('sets Access-Control-Allow-Origin for allowed origins', async () => {
    const { setCorsHeaders } = await import('../lib/cors');
    const { headers, req, res } = createMockReqRes('https://dossier.imboard.ai');

    setCorsHeaders(req, res);

    expect(headers['Access-Control-Allow-Origin']).toBe('https://dossier.imboard.ai');
    expect(headers.Vary).toBe('Origin');
  });

  it('respects CORS_ALLOWED_ORIGINS env var', async () => {
    const originalEnv = process.env.CORS_ALLOWED_ORIGINS;
    process.env.CORS_ALLOWED_ORIGINS = 'https://custom.example.com,https://another.example.com';

    // Re-import to pick up env var change
    const cors = await import('../lib/cors');
    const { headers, req, res } = createMockReqRes('https://custom.example.com');

    cors.setCorsHeaders(req, res);

    expect(headers['Access-Control-Allow-Origin']).toBe('https://custom.example.com');

    // Cleanup
    if (originalEnv === undefined) {
      delete process.env.CORS_ALLOWED_ORIGINS;
    } else {
      process.env.CORS_ALLOWED_ORIGINS = originalEnv;
    }
  });

  it('does not set origin header when no origin in request', async () => {
    const { setCorsHeaders } = await import('../lib/cors');
    const { headers, req, res } = createMockReqRes();

    setCorsHeaders(req, res);

    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
  });
});

describe('OAuth state parameter (CSRF protection)', () => {
  function createMockReq(
    overrides: Partial<{
      method: string;
      query: Record<string, string>;
      headers: Record<string, string>;
    }> = {}
  ) {
    return {
      method: overrides.method ?? 'GET',
      query: overrides.query ?? {},
      headers: overrides.headers ?? {},
    } as any;
  }

  function createMockRes() {
    let statusCode = 0;
    let body = '';
    const headers: Record<string, string> = {};
    const res = {
      status: (code: number) => {
        statusCode = code;
        return {
          json: (b: any) => {
            body = JSON.stringify(b);
          },
          send: (b: string) => {
            body = b;
          },
        };
      },
      setHeader: (key: string, value: string) => {
        headers[key] = value;
      },
    } as any;
    return { res, getStatus: () => statusCode, getBody: () => body, headers };
  }

  it('login handler sets state cookie and includes state in redirect URL', async () => {
    const loginModule = await import('../api/auth/login');
    const handler = loginModule.default;

    process.env.REGISTRY_BASE_URL = 'https://registry.example.com';
    process.env.GITHUB_CLIENT_ID = 'test-client-id';

    const req = createMockReq();
    let redirectUrl = '';
    const { res, headers } = createMockRes();
    res.redirect = (url: string) => {
      redirectUrl = url;
    };

    handler(req, res);

    // Verify state is in the redirect URL
    const url = new URL(redirectUrl);
    const state = url.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(state).toHaveLength(64); // 32 bytes hex-encoded

    // Verify state cookie is set
    const setCookieHeader = headers['Set-Cookie'];
    expect(setCookieHeader).toContain(`${OAUTH_STATE_COOKIE}=`);
    expect(setCookieHeader).toContain('HttpOnly');
    expect(setCookieHeader).toContain('Secure');
    expect(setCookieHeader).toContain('SameSite=Lax');
    expect(setCookieHeader).toContain(state);
  });

  it('callback handler rejects request with missing state', async () => {
    const callbackModule = await import('../api/auth/callback');
    const handler = callbackModule.default;

    const req = createMockReq({ query: { code: 'test-code' } });
    const { res, getStatus, getBody } = createMockRes();

    await handler(req, res);

    expect(getStatus()).toBe(403);
    expect(getBody()).toContain('state mismatch');
  });

  it('callback handler rejects request with mismatched state', async () => {
    const callbackModule = await import('../api/auth/callback');
    const handler = callbackModule.default;

    const req = createMockReq({
      query: {
        code: 'test-code',
        state: 'wrong-state-value-that-is-64-chars-long-aaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      headers: {
        cookie: `${OAUTH_STATE_COOKIE}=correct-state-value-is-64-chars-long-bbbbbbbbbbbbbbbbbbbbbbbbb`,
      },
    });
    const { res, getStatus, getBody } = createMockRes();

    await handler(req, res);

    expect(getStatus()).toBe(403);
    expect(getBody()).toContain('state mismatch');
  });

  it('callback handler clears state cookie on response', async () => {
    const callbackModule = await import('../api/auth/callback');
    const handler = callbackModule.default;

    const state = crypto.randomBytes(32).toString('hex');
    const req = createMockReq({
      query: { code: 'test-code', state },
      headers: { cookie: `${OAUTH_STATE_COOKIE}=${state}` },
    });
    const { res, headers } = createMockRes();

    // This will fail at the GitHub OAuth exchange step, but the cookie
    // should be cleared before that point
    await handler(req, res).catch(() => {});

    expect(headers['Set-Cookie']).toContain('Max-Age=0');
  });
});

describe('JWT token expiry', () => {
  it('should use 7-day expiry instead of 30-day', async () => {
    process.env.JWT_SECRET = 'test-secret-for-jwt-expiry';
    const { signJwt, verifyJwt } = await import('../lib/auth');

    const token = signJwt({ sub: 'testuser', email: null, orgs: [] });
    const decoded = verifyJwt(token);

    const expiryDays = ((decoded.exp ?? 0) - (decoded.iat ?? 0)) / (24 * 60 * 60);
    expect(expiryDays).toBe(7);
  });
});
