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

  it('throws on non-ok response with URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    await expect(fetchManifestDossiers()).rejects.toThrow(
      'Failed to fetch manifest from https://raw.githubusercontent.com/org/repo/main/index.json: HTTP 500'
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
