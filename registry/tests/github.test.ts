import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock config before importing github
vi.mock('../lib/config', () => ({
  default: {
    content: {
      org: 'test-org',
      repo: 'test-repo',
      branch: 'main',
      botToken: 'fake-token',
    },
    auth: {
      github: {
        apiUrl: 'https://api.github.com',
      },
    },
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

describe('getFileContent', () => {
  it('should include response body in error message on non-404 failure', async () => {
    const { getFileContent } = await import('../lib/github');
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error: rate limit exceeded'),
    });

    await expect(getFileContent('some/path')).rejects.toThrow(/500.*rate limit exceeded/);
  });

  it('should return null on 404', async () => {
    const { getFileContent } = await import('../lib/github');
    mockFetch.mockResolvedValue({ ok: false, status: 404 });
    const result = await getFileContent('missing/path');
    expect(result).toBeNull();
  });
});

describe('githubRequest - network error wrapping', () => {
  it('should wrap fetch network errors with URL context', async () => {
    const { getFileContent } = await import('../lib/github');
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    await expect(getFileContent('some/path')).rejects.toThrow(
      /GitHub API request failed.*fetch failed/
    );
  });
});

describe('deleteFile', () => {
  it('should parse response body once and return data on success', async () => {
    const { deleteFile } = await import('../lib/github');
    const responseData = { commit: { sha: 'abc123' } };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(responseData),
    });

    const result = await deleteFile('valid/path', 'delete message', 'sha123');
    expect(result).toEqual(responseData);
  });

  it('should include error details from response body on failure', async () => {
    const { deleteFile } = await import('../lib/github');
    mockFetch.mockResolvedValue({
      ok: false,
      status: 422,
      json: () => Promise.resolve({ message: 'Validation Failed' }),
    });

    await expect(deleteFile('valid/path', 'msg', 'sha')).rejects.toThrow(/422.*Validation Failed/);
  });
});

describe('createOrUpdateFile', () => {
  it('should parse response body once and return data on success', async () => {
    const { createOrUpdateFile } = await import('../lib/github');
    const responseData = { content: { sha: 'def456' } };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(responseData),
    });

    const result = await createOrUpdateFile('valid/path', 'content', 'msg');
    expect(result).toEqual(responseData);
  });

  it('should include error details from response body on failure', async () => {
    const { createOrUpdateFile } = await import('../lib/github');
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ message: 'Conflict: sha mismatch' }),
    });

    await expect(createOrUpdateFile('valid/path', 'content', 'msg', 'old-sha')).rejects.toThrow(
      /409.*Conflict/
    );
  });
});

describe('getManifest', () => {
  it('should throw descriptive error on malformed JSON', async () => {
    const { getManifest } = await import('../lib/github');
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          content: Buffer.from('not valid json').toString('base64'),
          sha: 'abc',
        }),
    });

    await expect(getManifest()).rejects.toThrow(/Failed to parse manifest/);
  });
});

describe('PathTraversalError', () => {
  it('should be an instance of Error with name PathTraversalError', async () => {
    const { PathTraversalError } = await import('../lib/github');
    const err = new PathTraversalError('../etc/passwd');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PathTraversalError');
    expect(err.message).toContain('../etc/passwd');
  });

  it('should be thrown by sanitizePath via getFileContent', async () => {
    const { getFileContent, PathTraversalError } = await import('../lib/github');
    await expect(getFileContent('../etc/passwd')).rejects.toThrow(PathTraversalError);
  });
});

describe('githubRequest - non-OK response logging', () => {
  it('should log non-OK responses to console.error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getFileContent } = await import('../lib/github');
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: () => Promise.resolve('rate limit'),
    });

    try {
      await getFileContent('some/path');
    } catch {
      // expected
    }

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('GitHub API request failed'));
    consoleSpy.mockRestore();
  });
});

describe('deleteFile - non-JSON error response', () => {
  it('should handle non-JSON error responses gracefully', async () => {
    const { deleteFile } = await import('../lib/github');
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: () => Promise.reject(new Error('not json')),
      text: () => Promise.resolve('plain text error'),
    });

    await expect(deleteFile('valid/path', 'msg', 'sha')).rejects.toThrow(
      /GitHub API error: 500 - plain text error/
    );
  });
});
