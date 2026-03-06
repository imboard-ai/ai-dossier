import { describe, expect, it, vi } from 'vitest';

vi.mock('jsonwebtoken', () => ({
  default: {
    sign: () => 'mock-token',
    verify: () => ({ sub: 'test', email: null, orgs: [] }),
  },
}));

vi.mock('../lib/config', () => ({
  default: {
    auth: {
      github: {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        scopes: 'read:user read:org',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        apiUrl: 'https://api.github.com',
      },
      jwt: {
        secret: 'test-secret',
      },
    },
  },
}));

vi.mock('../lib/constants', () => ({
  USER_AGENT: 'Dossier-Registry-Test',
  JWT_EXPIRY_SECONDS: 604800,
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('exchangeGitHubCode', () => {
  it('should include response body when response is not ok', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: () => Promise.resolve('GitHub is down'),
    });

    const { exchangeGitHubCode } = await import('../lib/auth');
    await expect(exchangeGitHubCode('bad-code')).rejects.toThrow(
      /GitHub OAuth token exchange failed: 503 Service Unavailable — GitHub is down/
    );
  });

  it('should throw on OAuth error in response body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          error: 'bad_verification_code',
          error_description: 'The code passed is incorrect or expired.',
        }),
    });

    const { exchangeGitHubCode } = await import('../lib/auth');
    await expect(exchangeGitHubCode('expired')).rejects.toThrow(
      /GitHub OAuth error: The code passed is incorrect or expired/
    );
  });
});

describe('fetchGitHubUser', () => {
  it('should include response body in error message', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: () => Promise.resolve('Bad credentials'),
    });

    const { fetchGitHubUser } = await import('../lib/auth');
    await expect(fetchGitHubUser('bad-token')).rejects.toThrow(
      /GitHub API error fetching user: 401 Unauthorized — Bad credentials/
    );
  });
});

describe('fetchGitHubOrgs', () => {
  it('should include response body in error message', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: () => Promise.resolve('API rate limit exceeded'),
    });

    const { fetchGitHubOrgs } = await import('../lib/auth');
    await expect(fetchGitHubOrgs('rate-limited')).rejects.toThrow(
      /GitHub API error fetching orgs: 403 Forbidden — API rate limit exceeded/
    );
  });
});
