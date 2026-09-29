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

describe('publisher recording (#971)', () => {
  const metadata = { name: 'test-dossier', title: 'Test', version: '1.0.0' } as never;

  function writeMessages() {
    return mockFetch.mock.calls
      .filter((call) => ['PUT', 'DELETE'].includes(call[1]?.method as string))
      .map((call) => JSON.parse(call[1].body as string).message as string);
  }

  it('withActorTrailer appends a trailer, strips control chars, and is a no-op without a login', async () => {
    const { withActorTrailer } = await import('../lib/github');
    expect(withActorTrailer('Publish x v1', 'Published-By', 'alice')).toBe(
      'Publish x v1\n\nPublished-By: alice'
    );
    expect(withActorTrailer('Publish x v1', 'Published-By', null)).toBe('Publish x v1');
    expect(withActorTrailer('Publish x v1', 'Published-By', '\n\x07 ')).toBe('Publish x v1');
    expect(withActorTrailer('Publish x v1', 'Published-By', 'eve\nPublished-By: mallory')).toBe(
      'Publish x v1\n\nPublished-By: evePublished-By: mallory'
    );
  });

  it('content, evidence and manifest commits carry Published-By; manifest entry records the publisher', async () => {
    const { publishDossier } = await import('../lib/github');
    mockFetch
      .mockResolvedValueOnce(NOT_FOUND) // GET content
      .mockResolvedValueOnce(jsonResponse({ content: { sha: 'file-sha' } })) // PUT content
      .mockResolvedValueOnce(NOT_FOUND) // GET sidecar
      .mockResolvedValueOnce(jsonResponse({ content: { sha: 'evidence-sha' } })) // PUT sidecar
      .mockResolvedValueOnce(NOT_FOUND) // GET index.json
      .mockResolvedValueOnce(jsonResponse({ content: { sha: 'manifest-sha' } })); // PUT index.json

    await publishDossier(
      'ns/test-dossier',
      '# content',
      metadata,
      'changelog',
      '{"evidence_schema_version":"1.0.0"}',
      'alice',
      '2026-09-29T00:00:00.000Z'
    );

    const messages = writeMessages();
    expect(messages).toHaveLength(3);
    for (const message of messages) {
      expect(message.endsWith('\n\nPublished-By: alice')).toBe(true);
    }
    expect(messages[0]).toMatch(
      /^Publish test-dossier v1\.0\.0: changelog\n\nPublished-By: alice$/
    );

    const manifestBody = bodyOf(5);
    const manifest = JSON.parse(Buffer.from(manifestBody.content, 'base64').toString('utf-8'));
    expect(manifest.dossiers[0]).toMatchObject({
      name: 'ns/test-dossier',
      published_by: 'alice',
      published_at: '2026-09-29T00:00:00.000Z',
    });
  });

  it('frontmatter cannot supply published_by; an injected login is sanitized in commit and manifest', async () => {
    const { publishDossier } = await import('../lib/github');
    mockFetch
      .mockResolvedValueOnce(NOT_FOUND) // GET content
      .mockResolvedValueOnce(jsonResponse({ content: { sha: 'file-sha' } })) // PUT content
      .mockResolvedValueOnce(NOT_FOUND) // GET sidecar
      .mockResolvedValueOnce(NOT_FOUND) // GET index.json
      .mockResolvedValueOnce(jsonResponse({ content: { sha: 'manifest-sha' } })); // PUT index.json

    const spoofing = { ...(metadata as object), published_by: 'mallory' } as never;
    await publishDossier(
      'ns/test-dossier',
      '# content',
      spoofing,
      'changelog',
      null,
      'eve\r\nSigned-off-by: mallory'
    );

    const [contentMessage] = writeMessages();
    expect(contentMessage.split('\n')).toEqual([
      'Publish test-dossier v1.0.0: changelog',
      '',
      'Published-By: eveSigned-off-by: mallory',
    ]);
    const manifest = JSON.parse(Buffer.from(bodyOf(4).content, 'base64').toString('utf-8'));
    expect(manifest.dossiers[0].published_by).toBe('eveSigned-off-by: mallory');
  });

  it('without a login: no trailer and no published_by on the entry', async () => {
    const { publishDossier } = await import('../lib/github');
    mockFetch
      .mockResolvedValueOnce(NOT_FOUND)
      .mockResolvedValueOnce(jsonResponse({ content: { sha: 'file-sha' } }))
      .mockResolvedValueOnce(NOT_FOUND)
      .mockResolvedValueOnce(NOT_FOUND)
      .mockResolvedValueOnce(jsonResponse({ content: { sha: 'manifest-sha' } }));

    await publishDossier('ns/test-dossier', '# content', metadata, 'changelog', null);

    for (const message of writeMessages()) {
      expect(message).not.toMatch(/Published-By/);
    }
    const manifest = JSON.parse(Buffer.from(bodyOf(4).content, 'base64').toString('utf-8'));
    expect(manifest.dossiers[0]).not.toHaveProperty('published_by');
  });

  it('delete commits (content, sidecar, manifest) carry Removed-By', async () => {
    const { deleteDossier } = await import('../lib/github');
    const manifestJson = JSON.stringify({
      dossiers: [
        { name: 'ns/test-dossier', title: 'Test', version: '1.0.0', path: 'ns/test-dossier.ds.md' },
      ],
    });
    mockFetch
      .mockResolvedValueOnce(contentResponse('---\nname: test-dossier\n---', 'content-sha'))
      .mockResolvedValueOnce(contentResponse(manifestJson, 'manifest-sha'))
      .mockResolvedValueOnce(jsonResponse({ commit: { sha: 'delete-content-sha' } }))
      .mockResolvedValueOnce(contentResponse('{}', 'evidence-sha'))
      .mockResolvedValueOnce(jsonResponse({ commit: { sha: 'delete-evidence-sha' } }))
      .mockResolvedValueOnce(jsonResponse({ content: { sha: 'manifest-sha-2' } }));

    await deleteDossier('ns/test-dossier', null, 'bob');

    const messages = writeMessages();
    expect(messages).toEqual([
      'Delete ns/test-dossier v1.0.0\n\nRemoved-By: bob',
      'Delete evidence for ns/test-dossier\n\nRemoved-By: bob',
      'Remove from manifest: ns/test-dossier\n\nRemoved-By: bob',
    ]);
  });
});
