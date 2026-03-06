import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { authenticateRequest } from '../lib/auth';
import { OAUTH_STATE_COOKIE } from '../lib/constants';

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
