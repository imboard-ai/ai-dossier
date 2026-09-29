import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/config', () => ({
  default: {
    getManifestUrl: () => 'https://raw.githubusercontent.com/org/repo/main/index.json',
    getCdnUrl: (path: string) => `https://cdn.jsdelivr.net/gh/org/repo/${path}`,
  },
}));

import { fetchManifestDossiers, normalizeDossier } from '../lib/manifest';

describe('fetchManifestDossiers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches and returns dossiers from manifest', async () => {
    const mockDossiers = [
      { name: 'test/dossier', title: 'Test', version: '1.0.0', path: 'test/dossier.ds.md' },
    ];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ dossiers: mockDossiers }),
      })
    );

    const result = await fetchManifestDossiers();
    expect(result).toEqual(mockDossiers);
  });

  it('throws on non-ok response with URL and statusText', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' })
    );

    await expect(fetchManifestDossiers()).rejects.toThrow(
      'Failed to fetch manifest from https://raw.githubusercontent.com/org/repo/main/index.json: HTTP 500 Internal Server Error'
    );
  });

  it('wraps network errors with context', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    await expect(fetchManifestDossiers()).rejects.toThrow(
      'Failed to fetch manifest from https://raw.githubusercontent.com/org/repo/main/index.json: fetch failed'
    );
  });

  it('throws on malformed manifest without dossiers array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      })
    );

    await expect(fetchManifestDossiers()).rejects.toThrow(
      'Invalid manifest from https://raw.githubusercontent.com/org/repo/main/index.json: missing or malformed "dossiers" array'
    );
  });
});

describe('normalizeDossier', () => {
  it('applies defaults and adds url', () => {
    const dossier = { name: 'ns/d', title: 'D', version: '1.0.0', path: 'ns/d.ds.md' };
    const result = normalizeDossier(dossier);

    expect(result.url).toBe('https://cdn.jsdelivr.net/gh/org/repo/ns/d.ds.md');
    expect(result.description).toBeNull();
    expect(result.tags).toEqual([]);
    expect(result.authors).toEqual([]);
    expect(result.tools_required).toEqual([]);
  });

  it('throws when dossier.path is missing', () => {
    const dossier = { name: 'ns/d', title: 'D', version: '1.0.0', path: '' };
    expect(() => normalizeDossier(dossier)).toThrow(
      'Cannot normalize dossier "ns/d": missing path'
    );
  });

  it('preserves existing fields over defaults', () => {
    const dossier = {
      name: 'ns/d',
      title: 'D',
      version: '1.0.0',
      path: 'ns/d.ds.md',
      description: 'A description',
      tags: ['tag1'],
    };
    const result = normalizeDossier(dossier);

    expect(result.description).toBe('A description');
    expect(result.tags).toEqual(['tag1']);
  });
});

describe('normalizeDossier — publisher provenance (#971)', () => {
  const base = { name: 'ns/d', title: 'D', version: '1.0.0', path: 'ns/d.ds.md' };

  it('legacy entry without published_by/published_at normalizes both to null', () => {
    const result = normalizeDossier(base);
    expect(result.published_by).toBeNull();
    expect(result.published_at).toBeNull();
  });

  it('passes through a recorded publisher', () => {
    const result = normalizeDossier({
      ...base,
      published_by: 'alice',
      published_at: '2026-09-29T00:00:00.000Z',
    });
    expect(result.published_by).toBe('alice');
    expect(result.published_at).toBe('2026-09-29T00:00:00.000Z');
  });

  it('treats a non-string or empty published_by as unrecorded', () => {
    expect(normalizeDossier({ ...base, published_by: '' }).published_by).toBeNull();
    expect(normalizeDossier({ ...base, published_by: 42 as never }).published_by).toBeNull();
  });
});
