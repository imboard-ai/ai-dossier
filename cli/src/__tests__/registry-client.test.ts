import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseNameVersion, RegistryClient, RegistryError } from '../registry-client';

describe('parseNameVersion', () => {
  it('should parse name without version', () => {
    expect(parseNameVersion('my-dossier')).toEqual(['my-dossier', null]);
  });

  it('should parse name@version', () => {
    expect(parseNameVersion('my-dossier@1.0.0')).toEqual(['my-dossier', '1.0.0']);
  });

  it('should handle scoped names with version', () => {
    expect(parseNameVersion('org/dossier@2.0.0')).toEqual(['org/dossier', '2.0.0']);
  });

  it('should use last @ for version split', () => {
    expect(parseNameVersion('name@with@signs@1.0')).toEqual(['name@with@signs', '1.0']);
  });
});

describe('RegistryError', () => {
  it('should have correct name and properties', () => {
    const err = new RegistryError('test error', 404, 'NOT_FOUND');
    expect(err.name).toBe('RegistryError');
    expect(err.message).toBe('test error');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('should default statusCode and code to null', () => {
    const err = new RegistryError('fail');
    expect(err.statusCode).toBeNull();
    expect(err.code).toBeNull();
  });
});

describe('RegistryClient', () => {
  let client: RegistryClient;

  beforeEach(() => {
    client = new RegistryClient('https://test.registry.com', 'test-token');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: 'ok' }),
        text: () => Promise.resolve('content'),
        headers: new Map([['X-Dossier-Digest', 'sha256:abc']]),
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('listDossiers', () => {
    it('should call fetch with correct URL and params', async () => {
      await client.listDossiers({ page: 2, perPage: 10, category: 'deploy' });

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      const url = fetchCall[0] as string;
      expect(url).toContain('/api/v1/dossiers');
      expect(url).toContain('page=2');
      expect(url).toContain('per_page=10');
      expect(url).toContain('category=deploy');
    });

    it('should use default pagination', async () => {
      await client.listDossiers();

      const url = vi.mocked(fetch).mock.calls[0][0] as string;
      expect(url).toContain('page=1');
      expect(url).toContain('per_page=20');
    });
  });

  describe('getDossier', () => {
    it('should call correct endpoint', async () => {
      await client.getDossier('my-dossier');

      const url = vi.mocked(fetch).mock.calls[0][0] as string;
      expect(url).toContain('/api/v1/dossiers/my-dossier');
    });

    it('should include version parameter', async () => {
      await client.getDossier('my-dossier', '1.0.0');

      const url = vi.mocked(fetch).mock.calls[0][0] as string;
      expect(url).toContain('version=1.0.0');
    });
  });

  describe('getDossierContent', () => {
    it('should return content and digest', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        text: () => Promise.resolve('dossier content'),
        headers: { get: (key: string) => (key === 'X-Dossier-Digest' ? 'sha256:abc' : null) },
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

      const result = await client.getDossierContent('my-dossier');
      expect(result.content).toBe('dossier content');
      expect(result.digest).toBe('sha256:abc');
    });

    it('should throw RegistryError on failure', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.resolve({ error: { message: 'Not found' } }),
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

      await expect(client.getDossierContent('missing')).rejects.toThrow(RegistryError);
    });
  });

  describe('searchDossiers', () => {
    it('should include query parameter', async () => {
      await client.searchDossiers('deploy workflow');

      const url = vi.mocked(fetch).mock.calls[0][0] as string;
      expect(url).toContain('q=deploy+workflow');
    });
  });

  describe('publishDossier', () => {
    it('should POST with correct body', async () => {
      await client.publishDossier('my-ns', 'content', 'changelog msg');

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      const opts = fetchCall[1] as RequestInit;
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body as string);
      expect(body.namespace).toBe('my-ns');
      expect(body.content).toBe('content');
      expect(body.changelog).toBe('changelog msg');
    });

    it('should omit changelog when null', async () => {
      await client.publishDossier('my-ns', 'content');

      const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
      expect(body.changelog).toBeUndefined();
    });
  });

  describe('removeDossier', () => {
    it('should send DELETE request', async () => {
      await client.removeDossier('my-dossier', '1.0.0');

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      const opts = fetchCall[1] as RequestInit;
      expect(opts.method).toBe('DELETE');
      const url = fetchCall[0] as string;
      expect(url).toContain('version=1.0.0');
    });
  });

  describe('getMe', () => {
    it('should call /me endpoint', async () => {
      await client.getMe();
      const url = vi.mocked(fetch).mock.calls[0][0] as string;
      expect(url).toContain('/api/v1/me');
    });
  });

  describe('exchangeCode', () => {
    it('should POST code and redirect URI', async () => {
      await client.exchangeCode('auth-code', 'http://localhost');

      const opts = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body as string);
      expect(body.code).toBe('auth-code');
      expect(body.redirect_uri).toBe('http://localhost');
    });
  });

  describe('error handling', () => {
    it('should throw RegistryError with parsed error body', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          json: () => Promise.resolve({ error: { message: 'Access denied', code: 'FORBIDDEN' } }),
        })
      );

      try {
        await client.listDossiers();
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RegistryError);
        expect((err as RegistryError).message).toBe('Access denied');
        expect((err as RegistryError).statusCode).toBe(403);
        expect((err as RegistryError).code).toBe('FORBIDDEN');
      }
    });

    it('should handle unparseable error body', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          json: () => Promise.reject(new Error('bad json')),
        })
      );

      try {
        await client.listDossiers();
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RegistryError);
        expect((err as RegistryError).statusCode).toBe(500);
      }
    });

    it('should include auth header when token is set', async () => {
      await client.listDossiers();

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      const opts = fetchCall[1] as RequestInit;
      const headers = opts.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-token');
    });

    it('should not include auth header without token', async () => {
      const noAuthClient = new RegistryClient('https://test.registry.com');
      await noAuthClient.listDossiers();

      const headers = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers.Authorization).toBeUndefined();
    });
  });
});
