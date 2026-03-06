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

  it('throws on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    await expect(fetchManifestDossiers()).rejects.toThrow('Failed to fetch manifest: 500');
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
