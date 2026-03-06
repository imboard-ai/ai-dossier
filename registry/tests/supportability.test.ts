import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { authenticateRequest } from '../lib/auth';
import { OAUTH_STATE_COOKIE } from '../lib/constants';

describe('successful mutation logging', () => {
  it('logs successful publish with structured data', async () => {
    vi.resetModules();

    vi.doMock('jsonwebtoken', () => ({
      default: {
        verify: () => ({ sub: 'testuser', email: null, orgs: ['testorg'] }),
      },
    }));
    vi.doMock('../lib/config', () => ({
      default: {
        auth: { jwt: { secret: 'test-secret' } },
        getCdnUrl: (path: string) => `https://cdn.example.com/${path}`,
      },
    }));
    vi.doMock('../lib/github', () => ({
      publishDossier: vi.fn().mockResolvedValue(undefined),
      PathTraversalError: class extends Error {},
    }));
    vi.doMock('../lib/dossier', () => ({
      validateNamespace: () => ({ valid: true }),
      parseFrontmatter: () => ({
        frontmatter: { name: 'my-dossier', version: '1.0.0', title: 'My Dossier' },
        content: '# Hello',
      }),
      validateDossier: () => ({ valid: true, errors: [] }),
      buildFullName: (ns: string, name: string) => `${ns}/${name}`,
      getRootNamespace: (ns: string) => ns.split('/')[0],
    }));
    vi.doMock('../lib/manifest', () => ({
      fetchManifestDossiers: vi.fn(),
      normalizeDossier: vi.fn(),
    }));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const handlerModule = await import('../api/v1/dossiers/index');
    const handler = handlerModule.default;

    const req = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer valid-token',
        'x-request-id': 'req-123',
      },
      body: {
        namespace: 'testorg',
        content: '---\nname: my-dossier\nversion: 1.0.0\n---\n# Hello',
      },
    } as any;

    let statusCode = 0;
    let body: any = {};
    const res = {
      status: (code: number) => {
        statusCode = code;
        return {
          json: (b: any) => {
            body = b;
          },
        };
      },
      setHeader: () => {},
    } as any;

    await handler(req, res);

    expect(statusCode).toBe(201);

    const publishLog = consoleSpy.mock.calls
      .map((call) => {
        try {
          return JSON.parse(call[0] as string);
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.message === 'Dossier published');

    expect(publishLog).toBeDefined();
    expect(publishLog).toMatchObject({
      level: 'info',
      namespace: 'testorg',
      name: 'testorg/my-dossier',
      version: '1.0.0',
    });

    consoleSpy.mockRestore();
    vi.doUnmock('jsonwebtoken');
    vi.doUnmock('../lib/config');
    vi.doUnmock('../lib/github');
    vi.doUnmock('../lib/dossier');
    vi.doUnmock('../lib/manifest');
  });

  it('logs successful delete with structured data', async () => {
    vi.resetModules();

    vi.doMock('jsonwebtoken', () => ({
      default: {
        verify: () => ({ sub: 'testuser', email: null, orgs: ['testorg'] }),
      },
    }));
    vi.doMock('../lib/config', () => ({
      default: {
        auth: { jwt: { secret: 'test-secret' } },
      },
    }));
    vi.doMock('../lib/github', () => ({
      deleteDossier: vi.fn().mockResolvedValue({ found: true, versionMismatch: false }),
      getManifest: vi.fn(),
      PathTraversalError: class extends Error {},
    }));
    vi.doMock('../lib/dossier', () => ({
      validateNamespace: () => ({ valid: true }),
      getRootNamespace: (ns: string) => ns.split('/')[0],
    }));

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const handlerModule = await import('../api/v1/dossiers/[...name]');
    const handler = handlerModule.default;

    const req = {
      method: 'DELETE',
      query: { name: ['testorg', 'my-dossier'], version: '1.0.0' },
      headers: { authorization: 'Bearer valid-token', 'x-request-id': 'req-456' },
    } as any;

    let statusCode = 0;
    let body: any = {};
    const res = {
      status: (code: number) => {
        statusCode = code;
        return {
          json: (b: any) => {
            body = b;
          },
        };
      },
      setHeader: () => {},
    } as any;

    await handler(req, res);

    expect(statusCode).toBe(200);

    const deleteLog = consoleSpy.mock.calls
      .map((call) => {
        try {
          return JSON.parse(call[0] as string);
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.message === 'Dossier deleted');

    expect(deleteLog).toBeDefined();
    expect(deleteLog).toMatchObject({
      level: 'info',
      dossier: 'testorg/my-dossier',
      version: '1.0.0',
    });

    consoleSpy.mockRestore();
    vi.doUnmock('jsonwebtoken');
    vi.doUnmock('../lib/config');
    vi.doUnmock('../lib/github');
    vi.doUnmock('../lib/dossier');
  });
});

describe('auth error response includes namespace', () => {
  it('403 response body includes namespace field', async () => {
    vi.resetModules();

    vi.doMock('jsonwebtoken', () => ({
      default: {
        verify: () => ({ sub: 'testuser', email: null, orgs: [] }),
      },
    }));
    vi.doMock('../lib/config', () => ({
      default: {
        auth: { jwt: { secret: 'test-secret' } },
      },
    }));
    vi.doMock('../lib/dossier', () => ({
      getRootNamespace: (ns: string) => ns.split('/')[0],
    }));

    const authModule = await import('../lib/auth');
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const req = {
      headers: { authorization: 'Bearer valid-token' },
    } as any;

    let statusCode = 0;
    let body: any = {};
    const res = {
      status: (code: number) => {
        statusCode = code;
        return {
          json: (b: any) => {
            body = b;
          },
        };
      },
    } as any;

    const result = await authModule.authorizePublish(req, res, 'other-org/some-dossier');

    expect(result).toBe(false);
    expect(statusCode).toBe(403);
    expect(body.error.namespace).toBe('other-org/some-dossier');
    expect(body.error.code).toBe('FORBIDDEN');

    consoleSpy.mockRestore();
    vi.doUnmock('jsonwebtoken');
    vi.doUnmock('../lib/config');
  });
});

describe('error correlation IDs', () => {
  it('callback handler includes error ref in 500 response and log', async () => {
    const callbackModule = await import('../api/auth/callback');
    const handler = callbackModule.default;

    // Provide valid state so we reach the try/catch block (code exchange will fail)
    const state = crypto.randomBytes(32).toString('hex');
    const req = {
      method: 'GET',
      query: { code: 'bad-code', state },
      headers: { cookie: `${OAUTH_STATE_COOKIE}=${state}` },
    } as any;

    let statusCode = 0;
    let body = '';
    const res = {
      status: (code: number) => {
        statusCode = code;
        return {
          send: (b: string) => {
            body = b;
          },
          json: (b: any) => {
            body = JSON.stringify(b);
          },
        };
      },
      setHeader: () => {},
    } as any;

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await handler(req, res);

    expect(statusCode).toBe(500);

    // Error page should contain a reference code (8 hex chars)
    const refMatch = body.match(/Reference:\s*([a-f0-9]{8})/);
    expect(refMatch).not.toBeNull();
    const errorRef = refMatch![1];

    // Console log should contain the same ref
    const logCall = consoleSpy.mock.calls.find((call) =>
      String(call[0]).includes(`ref=${errorRef}`)
    );
    expect(logCall).toBeDefined();

    consoleSpy.mockRestore();
  });

  it('login handler includes error ref in 500 response when login fails', async () => {
    // Mock config to cause a failure (missing clientId)
    const originalEnv = process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_ID;

    // Force re-import to get fresh module
    vi.resetModules();

    // Mock config to throw on clientId access
    vi.doMock('../lib/config', () => ({
      default: {
        auth: {
          github: {
            get clientId(): string {
              throw new Error('GITHUB_CLIENT_ID is not set');
            },
            clientSecret: 'test',
            scopes: 'read:user',
            tokenUrl: 'https://github.com/login/oauth/access_token',
            apiUrl: 'https://api.github.com',
          },
          jwt: { secret: 'test' },
        },
        baseUrl: 'https://test.example.com',
      },
    }));

    const loginModule = await import('../api/auth/login');
    const handler = loginModule.default;

    const req = { method: 'GET' } as any;

    let statusCode = 0;
    let body: any = {};
    const res = {
      status: (code: number) => {
        statusCode = code;
        return {
          json: (b: any) => {
            body = b;
          },
        };
      },
      setHeader: () => {},
      redirect: () => {},
    } as any;

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    handler(req, res);

    expect(statusCode).toBe(500);
    expect(body.error.ref).toMatch(/^[a-f0-9]{8}$/);

    // Console log should contain the same ref
    const logCall = consoleSpy.mock.calls.find((call) =>
      String(call[0]).includes(`ref=${body.error.ref}`)
    );
    expect(logCall).toBeDefined();

    consoleSpy.mockRestore();
    vi.doUnmock('../lib/config');

    if (originalEnv !== undefined) {
      process.env.GITHUB_CLIENT_ID = originalEnv;
    }
  });
});

describe('auth failure logging', () => {
  it('logs missing token attempts', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const req = { method: 'POST', url: '/api/v1/dossiers', headers: {} } as any;
    let statusCode = 0;
    const res = {
      status: (code: number) => {
        statusCode = code;
        return { json: () => {} };
      },
    } as any;

    await authenticateRequest(req, res);

    expect(statusCode).toBe(401);
    const loggedJson = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(loggedJson).toMatchObject({
      level: 'warn',
      event: 'auth.missing_token',
      method: 'POST',
      url: '/api/v1/dossiers',
    });

    consoleSpy.mockRestore();
  });

  it('logs invalid token attempts', async () => {
    vi.resetModules();
    vi.doMock('jsonwebtoken', () => ({
      default: {
        verify: () => {
          throw new Error('invalid signature');
        },
      },
    }));
    vi.doMock('../lib/config', () => ({
      default: {
        auth: { jwt: { secret: 'test-secret' } },
      },
    }));

    const authModule = await import('../lib/auth');
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const req = {
      method: 'DELETE',
      url: '/api/v1/dossiers/foo/bar',
      headers: { authorization: 'Bearer bad-token' },
    } as any;
    let statusCode = 0;
    const res = {
      status: (code: number) => {
        statusCode = code;
        return { json: () => {} };
      },
    } as any;

    await authModule.authenticateRequest(req, res);

    expect(statusCode).toBe(401);
    const loggedJson = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(loggedJson).toMatchObject({
      level: 'warn',
      event: 'auth.invalid_token',
      method: 'DELETE',
      url: '/api/v1/dossiers/foo/bar',
    });

    consoleSpy.mockRestore();
    vi.doUnmock('jsonwebtoken');
    vi.doUnmock('../lib/config');
  });
});
