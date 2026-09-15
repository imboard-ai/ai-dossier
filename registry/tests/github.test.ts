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

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

function contentResponse(content: string, sha: string) {
  return jsonResponse({ content: Buffer.from(content).toString('base64'), sha });
}

const NOT_FOUND = { ok: false, status: 404 };

function bodyOf(callIndex: number) {
  return JSON.parse(mockFetch.mock.calls[callIndex][1].body as string);
}

describe('publishDossier', () => {
  const metadata = { name: 'test-dossier', title: 'Test', version: '1.0.0' } as never;

  it('with evidence: writes content, sidecar, then manifest — sidecar body and message match', async () => {
    const { publishDossier } = await import('../lib/github');
    mockFetch
      .mockResolvedValueOnce(NOT_FOUND) // GET content (no existing)
      .mockResolvedValueOnce(jsonResponse({ content: { sha: 'file-sha' } })) // PUT content
      .mockResolvedValueOnce(NOT_FOUND) // GET sidecar (none)
      .mockResolvedValueOnce(jsonResponse({ content: { sha: 'evidence-sha' } })) // PUT sidecar
      .mockResolvedValueOnce(NOT_FOUND) // GET index.json (empty manifest)
      .mockResolvedValueOnce(jsonResponse({ content: { sha: 'manifest-sha' } })); // PUT index.json

    const evidence = '{"evidence_schema_version":"1.0.0"}';
    await publishDossier('ns/test-dossier', '# content', metadata, 'changelog', evidence);

    const puts = mockFetch.mock.calls
      .map((call, i) => ({
        i,
        url: call[0] as string,
        method: (call[1]?.method as string) || 'GET',
      }))
      .filter((c) => c.method === 'PUT');

    expect(puts.map((p) => p.url)).toEqual([
      expect.stringContaining('ns/test-dossier.ds.md'),
      expect.stringContaining('ns/test-dossier.evidence.json'),
      expect.stringContaining('index.json'),
    ]);

    const sidecarPutIndex = puts[1].i;
    const sidecarBody = bodyOf(sidecarPutIndex);
    expect(Buffer.from(sidecarBody.content, 'base64').toString('utf-8')).toBe(evidence);
    expect(sidecarBody.message).toMatch(/^Evidence for/);
  });

  it('without evidence when a sidecar exists: deletes the sidecar before the manifest PUT', async () => {
    const { publishDossier } = await import('../lib/github');
    mockFetch
      .mockResolvedValueOnce(NOT_FOUND) // GET content
      .mockResolvedValueOnce(jsonResponse({ content: { sha: 'file-sha' } })) // PUT content
      .mockResolvedValueOnce(contentResponse('{}', 'existing-evidence-sha')) // GET sidecar (exists)
      .mockResolvedValueOnce(jsonResponse({ commit: { sha: 'delete-sha' } })) // DELETE sidecar
      .mockResolvedValueOnce(NOT_FOUND) // GET index.json
      .mockResolvedValueOnce(jsonResponse({ content: { sha: 'manifest-sha' } })); // PUT index.json

    await publishDossier('ns/test-dossier', '# content', metadata, 'changelog', null);

    const methods = mockFetch.mock.calls.map((call) => (call[1]?.method as string) || 'GET');
    expect(methods).toEqual(['GET', 'PUT', 'GET', 'DELETE', 'GET', 'PUT']);

    const deleteBody = bodyOf(3);
    expect(deleteBody.sha).toBe('existing-evidence-sha');
  });

  it('without evidence and no sidecar: no DELETE, exactly two PUTs', async () => {
    const { publishDossier } = await import('../lib/github');
    mockFetch
      .mockResolvedValueOnce(NOT_FOUND) // GET content
      .mockResolvedValueOnce(jsonResponse({ content: { sha: 'file-sha' } })) // PUT content
      .mockResolvedValueOnce(NOT_FOUND) // GET sidecar (none)
      .mockResolvedValueOnce(NOT_FOUND) // GET index.json
      .mockResolvedValueOnce(jsonResponse({ content: { sha: 'manifest-sha' } })); // PUT index.json

    await publishDossier('ns/test-dossier', '# content', metadata, 'changelog', null);

    const methods = mockFetch.mock.calls.map((call) => (call[1]?.method as string) || 'GET');
    expect(methods).toEqual(['GET', 'PUT', 'GET', 'GET', 'PUT']);
    expect(methods.filter((m) => m === 'DELETE')).toHaveLength(0);
    expect(methods.filter((m) => m === 'PUT')).toHaveLength(2);
  });

  it('with evidence: a sidecar write failure aborts the publish before the manifest PUT', async () => {
    const { publishDossier } = await import('../lib/github');
    mockFetch
      .mockResolvedValueOnce(NOT_FOUND) // GET content
      .mockResolvedValueOnce(jsonResponse({ content: { sha: 'file-sha' } })) // PUT content
      .mockResolvedValueOnce(NOT_FOUND) // GET sidecar (none)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ message: 'internal error' }),
      }); // PUT sidecar fails

    await expect(
      publishDossier('ns/test-dossier', '# content', metadata, 'changelog', '{"entries":[]}')
    ).rejects.toThrow(/500.*internal error/);

    const methods = mockFetch.mock.calls.map((call) => (call[1]?.method as string) || 'GET');
    expect(methods).toEqual(['GET', 'PUT', 'GET', 'PUT']);
    // The manifest step (a further GET+PUT against index.json) never ran.
    expect(mockFetch.mock.calls.some((call) => (call[0] as string).includes('index.json'))).toBe(
      false
    );
  });
});

describe('deleteDossier', () => {
  it('also DELETEs the sidecar when present', async () => {
    const { deleteDossier } = await import('../lib/github');
    const manifestJson = JSON.stringify({
      dossiers: [
        { name: 'ns/test-dossier', title: 'Test', version: '1.0.0', path: 'ns/test-dossier.ds.md' },
      ],
    });
    mockFetch
      .mockResolvedValueOnce(contentResponse('---\nname: test-dossier\n---', 'content-sha')) // GET content
      .mockResolvedValueOnce(contentResponse(manifestJson, 'manifest-sha')) // GET manifest (index.json)
      .mockResolvedValueOnce(jsonResponse({ commit: { sha: 'delete-content-sha' } })) // DELETE content
      .mockResolvedValueOnce(contentResponse('{}', 'evidence-sha')) // GET sidecar (exists)
      .mockResolvedValueOnce(jsonResponse({ commit: { sha: 'delete-evidence-sha' } })) // DELETE sidecar
      .mockResolvedValueOnce(jsonResponse({ content: { sha: 'manifest-sha-2' } })); // PUT index.json

    await deleteDossier('ns/test-dossier');

    const methods = mockFetch.mock.calls.map((call) => (call[1]?.method as string) || 'GET');
    expect(methods).toEqual(['GET', 'GET', 'DELETE', 'GET', 'DELETE', 'PUT']);
    const sidecarDeleteBody = bodyOf(4);
    expect(sidecarDeleteBody.sha).toBe('evidence-sha');
  });

  it('still succeeds and still updates the manifest when the sidecar delete fails', async () => {
    const { deleteDossier } = await import('../lib/github');
    const manifestJson = JSON.stringify({
      dossiers: [
        { name: 'ns/test-dossier', title: 'Test', version: '1.0.0', path: 'ns/test-dossier.ds.md' },
      ],
    });
    mockFetch
      .mockResolvedValueOnce(contentResponse('---\nname: test-dossier\n---', 'content-sha')) // GET content
      .mockResolvedValueOnce(contentResponse(manifestJson, 'manifest-sha')) // GET manifest
      .mockResolvedValueOnce(jsonResponse({ commit: { sha: 'delete-content-sha' } })) // DELETE content
      .mockResolvedValueOnce(contentResponse('{}', 'evidence-sha')) // GET sidecar (exists)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ message: 'internal error' }),
      }) // DELETE sidecar fails
      .mockResolvedValueOnce(jsonResponse({ content: { sha: 'manifest-sha-2' } })); // PUT index.json still runs

    const result = await deleteDossier('ns/test-dossier');

    expect(result.found).toBe(true);
    const methods = mockFetch.mock.calls.map((call) => (call[1]?.method as string) || 'GET');
    expect(methods).toEqual(['GET', 'GET', 'DELETE', 'GET', 'DELETE', 'PUT']);
  });
});

describe('getManifest', () => {
  it('should throw descriptive error on malformed JSON', async () => {
    const { getManifest } = await import('../lib/github');
    mockFetch.mockResolvedValue(contentResponse('not valid json', 'abc'));

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
