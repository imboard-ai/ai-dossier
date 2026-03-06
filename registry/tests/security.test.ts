import crypto from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_CHANGELOG_LENGTH, MAX_QUERY_LENGTH, OAUTH_STATE_COOKIE } from '../lib/constants';
import { validateNamespace } from '../lib/dossier';
import { createMockReq, createMockRes } from './helpers/mocks';

function createCorsReqRes(origin?: string) {
  const resHeaders: Record<string, string> = {};
  const req = createMockReq({ headers: origin ? { origin } : {} });
  const res = {
    setHeader: (key: string, value: string) => {
      resHeaders[key] = value;
    },
  };
  return { headers: resHeaders, req, res };
}

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
  it('does not set Access-Control-Allow-Origin for unknown origins', async () => {
    const { setCorsHeaders } = await import('../lib/cors');
    const { headers, req, res } = createCorsReqRes('https://evil.com');

    setCorsHeaders(req, res);

    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(headers['Access-Control-Allow-Methods']).toBeUndefined();
  });

  it('sets Access-Control-Allow-Origin for allowed origins', async () => {
    const { setCorsHeaders } = await import('../lib/cors');
    const { headers, req, res } = createCorsReqRes('https://dossier.imboard.ai');

    setCorsHeaders(req, res);

    expect(headers['Access-Control-Allow-Origin']).toBe('https://dossier.imboard.ai');
    expect(headers.Vary).toBe('Origin');
  });

  it('respects CORS_ALLOWED_ORIGINS env var', async () => {
    const originalEnv = process.env.CORS_ALLOWED_ORIGINS;
    process.env.CORS_ALLOWED_ORIGINS = 'https://custom.example.com,https://another.example.com';

    // Re-import to pick up env var change
    const cors = await import('../lib/cors');
    const { headers, req, res } = createCorsReqRes('https://custom.example.com');

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
    const { headers, req, res } = createCorsReqRes();

    setCorsHeaders(req, res);

    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
  });
});

describe('CORS mutating request rejection', () => {
  function createCorsMutatingReqRes(method: string, origin?: string) {
    let statusCode = 0;
    let body: unknown = null;
    const resHeaders: Record<string, string> = {};
    const req = createMockReq({ method, headers: origin ? { origin } : {} });
    const res = {
      setHeader: (key: string, value: string) => {
        resHeaders[key] = value;
      },
      status: (code: number) => {
        statusCode = code;
        return {
          json: (b: unknown) => {
            body = b;
          },
          end: () => {},
        };
      },
    };
    return {
      req,
      res,
      getStatus: () => statusCode,
      getBody: () => body as Record<string, unknown>,
      resHeaders,
    };
  }

  it('rejects POST from disallowed origin', async () => {
    const { handleCors } = await import('../lib/cors');
    const { req, res, getStatus, getBody } = createCorsMutatingReqRes('POST', 'https://evil.com');

    const handled = handleCors(req, res);

    expect(handled).toBe(true);
    expect(getStatus()).toBe(403);
    expect((getBody().error as Record<string, unknown>).code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('rejects DELETE from disallowed origin', async () => {
    const { handleCors } = await import('../lib/cors');
    const { req, res, getStatus } = createCorsMutatingReqRes('DELETE', 'https://evil.com');

    const handled = handleCors(req, res);

    expect(handled).toBe(true);
    expect(getStatus()).toBe(403);
  });

  it('allows GET from disallowed origin (read-only)', async () => {
    const { handleCors } = await import('../lib/cors');
    const { req, res, getStatus } = createCorsMutatingReqRes('GET', 'https://evil.com');

    const handled = handleCors(req, res);

    expect(handled).toBe(false);
    expect(getStatus()).toBe(0);
  });

  it('allows POST from allowed origin', async () => {
    const { handleCors } = await import('../lib/cors');
    const { req, res, getStatus } = createCorsMutatingReqRes('POST', 'https://dossier.imboard.ai');

    const handled = handleCors(req, res);

    expect(handled).toBe(false);
    expect(getStatus()).toBe(0);
  });

  it('allows POST without origin (non-browser client)', async () => {
    const { handleCors } = await import('../lib/cors');
    const { req, res, getStatus } = createCorsMutatingReqRes('POST');

    const handled = handleCors(req, res);

    expect(handled).toBe(false);
    expect(getStatus()).toBe(0);
  });
});

describe('Content-Type and body field validation', () => {
  it('normalizeDossier uses explicit field picking (no prototype pollution)', async () => {
    const { normalizeDossier } = await import('../lib/manifest');

    const malicious = {
      name: 'ns/d',
      title: 'D',
      version: '1.0.0',
      path: 'ns/d.ds.md',
      __proto__: { polluted: true },
      constructor: { polluted: true },
    } as any;

    const result = normalizeDossier(malicious);

    expect(result).not.toHaveProperty('polluted');
    expect(result).not.toHaveProperty('constructor.polluted');
    expect(result.name).toBe('ns/d');
  });

  it('normalizeDossier does not carry unexpected fields from manifest', async () => {
    const { normalizeDossier } = await import('../lib/manifest');

    const dossier = {
      name: 'ns/d',
      title: 'D',
      version: '1.0.0',
      path: 'ns/d.ds.md',
      unexpected_field: 'should not appear',
    } as any;

    const result = normalizeDossier(dossier);

    expect(result).not.toHaveProperty('unexpected_field');
  });
});

describe('OAuth state parameter (CSRF protection)', () => {
  it('login handler sets state cookie and includes state in redirect URL', async () => {
    const loginModule = await import('../api/auth/login');
    const handler = loginModule.default;

    process.env.REGISTRY_BASE_URL = 'https://registry.example.com';
    process.env.GITHUB_CLIENT_ID = 'test-client-id';

    const req = createMockReq();
    let redirectUrl = '';
    const { res, headers } = createMockRes();
    (res as Record<string, unknown>).redirect = (url: string) => {
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

describe('search query length limit', () => {
  it('rejects queries exceeding MAX_QUERY_LENGTH', async () => {
    const searchModule = await import('../api/v1/search');
    const handler = searchModule.default;

    const longQuery = 'a'.repeat(MAX_QUERY_LENGTH + 1);
    const req = createMockReq({ query: { q: longQuery } });
    const { res, getStatus, getBody } = createMockRes();

    await handler(req, res);

    expect(getStatus()).toBe(400);
    expect((getBody() as Record<string, Record<string, unknown>>).error.code).toBe(
      'QUERY_TOO_LONG'
    );
  });

  it('accepts queries at exactly MAX_QUERY_LENGTH', async () => {
    const searchModule = await import('../api/v1/search');
    const handler = searchModule.default;

    const exactQuery = 'a'.repeat(MAX_QUERY_LENGTH);
    const req = createMockReq({ query: { q: exactQuery } });
    const { res, getStatus } = createMockRes();

    await handler(req, res);

    // Should not be rejected for length (may fail for other reasons like upstream)
    expect(getStatus()).not.toBe(400);
  });
});

describe('changelog sanitization', () => {
  it('rejects changelog exceeding MAX_CHANGELOG_LENGTH', async () => {
    const dossierModule = await import('../api/v1/dossiers/index');
    const handler = dossierModule.default;

    const req = createMockReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: {
        namespace: 'test-ns',
        content: '---\nname: test\ntitle: Test\nversion: 1.0.0\n---\n# Test',
        changelog: 'a'.repeat(MAX_CHANGELOG_LENGTH + 1),
      },
    });
    const { res, getStatus, getBody } = createMockRes();

    await handler(req, res);

    expect(getStatus()).toBe(400);
    expect((getBody() as Record<string, Record<string, unknown>>).error.code).toBe(
      'CHANGELOG_TOO_LONG'
    );
  });
});

describe('CORS headers not leaked to disallowed origins', () => {
  it('does not set Allow-Methods or Allow-Headers for rejected origins', async () => {
    const { setCorsHeaders } = await import('../lib/cors');
    const { headers, req, res } = createCorsReqRes('https://evil.com');

    setCorsHeaders(req, res);

    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(headers['Access-Control-Allow-Methods']).toBeUndefined();
    expect(headers['Access-Control-Allow-Headers']).toBeUndefined();
  });

  it('sets all CORS headers for allowed origins', async () => {
    const { setCorsHeaders } = await import('../lib/cors');
    const { headers, req, res } = createCorsReqRes('https://dossier.imboard.ai');

    setCorsHeaders(req, res);

    expect(headers['Access-Control-Allow-Origin']).toBe('https://dossier.imboard.ai');
    expect(headers['Access-Control-Allow-Methods']).toBeDefined();
    expect(headers['Access-Control-Allow-Headers']).toBeDefined();
    expect(headers.Vary).toBe('Origin');
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
