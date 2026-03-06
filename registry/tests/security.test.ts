import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
    expect(headers['Vary']).toBe('Origin');
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

describe('JWT token expiry', () => {
  it('should use 7-day expiry instead of 30-day', async () => {
    process.env.JWT_SECRET = 'test-secret-for-jwt-expiry';
    const { signJwt, verifyJwt } = await import('../lib/auth');

    const token = signJwt({ sub: 'testuser', email: null, orgs: [] });
    const decoded = verifyJwt(token);

    const expiryDays = (decoded.exp! - decoded.iat!) / (24 * 60 * 60);
    expect(expiryDays).toBe(7);
  });
});
