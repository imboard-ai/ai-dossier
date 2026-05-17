import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { highestCachedSemver, listResolutions, resolveCachedVersion } from '../cache-resolver';
import * as config from '../config';
import * as multiRegistry from '../multi-registry';

vi.mock('node:fs');
vi.mock('../config');
vi.mock('../multi-registry');

const mockedFs = vi.mocked(fs);

function makeRegistryResult(version: string, registry = 'public') {
  return {
    result: {
      name: 'org/x',
      version,
      _registry: registry,
    } as any,
    errors: [],
  };
}

describe('cache-resolver', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(config.getConfig).mockReturnValue(300);
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.readFileSync.mockReturnValue('');
    mockedFs.writeFileSync.mockReturnValue(undefined);
    mockedFs.mkdirSync.mockReturnValue(undefined);
    mockedFs.readdirSync.mockReturnValue([] as any);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    vi.clearAllMocks();
  });

  describe('resolveCachedVersion', () => {
    it('calls registry and writes resolution file when no cache exists', async () => {
      mockedFs.existsSync.mockReturnValue(false);
      vi.mocked(multiRegistry.multiRegistryGetDossier).mockResolvedValue(
        makeRegistryResult('1.2.3')
      );

      const result = await resolveCachedVersion('org/x');

      expect(result).toEqual({ version: '1.2.3', source: 'registry', registry: 'public' });
      expect(multiRegistry.multiRegistryGetDossier).toHaveBeenCalledWith('org/x');
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.resolution/org/x.json'),
        expect.stringContaining('"resolved_version": "1.2.3"'),
        expect.any(Object)
      );
    });

    it('returns cached resolution within TTL without calling registry', async () => {
      const recentTimestamp = new Date(Date.now() - 60_000).toISOString();
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({
          resolved_version: '1.0.0',
          resolved_at: recentTimestamp,
          source_registry: 'public',
        })
      );

      const result = await resolveCachedVersion('org/x');

      expect(result).toEqual({ version: '1.0.0', source: 'cache', registry: 'public' });
      expect(multiRegistry.multiRegistryGetDossier).not.toHaveBeenCalled();
    });

    it('re-resolves when resolution is past TTL', async () => {
      const oldTimestamp = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 min ago
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({
          resolved_version: '1.0.0',
          resolved_at: oldTimestamp,
          source_registry: 'public',
        })
      );
      vi.mocked(multiRegistry.multiRegistryGetDossier).mockResolvedValue(
        makeRegistryResult('1.1.0')
      );

      const result = await resolveCachedVersion('org/x');

      expect(result.version).toBe('1.1.0');
      expect(result.source).toBe('registry');
      expect(multiRegistry.multiRegistryGetDossier).toHaveBeenCalled();
    });

    it('skips resolution cache entirely when fresh=true', async () => {
      const recentTimestamp = new Date(Date.now() - 10_000).toISOString();
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ resolved_version: '1.0.0', resolved_at: recentTimestamp })
      );
      vi.mocked(multiRegistry.multiRegistryGetDossier).mockResolvedValue(
        makeRegistryResult('2.0.0')
      );

      const result = await resolveCachedVersion('org/x', { fresh: true });

      expect(result.version).toBe('2.0.0');
      expect(multiRegistry.multiRegistryGetDossier).toHaveBeenCalled();
    });

    it('forces re-resolution when maxAgeSeconds=0', async () => {
      const veryRecent = new Date().toISOString();
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ resolved_version: '1.0.0', resolved_at: veryRecent })
      );
      vi.mocked(multiRegistry.multiRegistryGetDossier).mockResolvedValue(
        makeRegistryResult('1.5.0')
      );

      const result = await resolveCachedVersion('org/x', { maxAgeSeconds: 0 });

      expect(result.version).toBe('1.5.0');
      expect(multiRegistry.multiRegistryGetDossier).toHaveBeenCalled();
    });

    it('falls back to highest cached semver with stderr warning when registry unreachable', async () => {
      // No resolution file. Content cache has versions on disk.
      mockedFs.existsSync.mockImplementation((p: any) => {
        const ps = String(p);
        // resolution file: missing. content cache dir + version files: present.
        if (ps.includes('.resolution/')) return false;
        return true;
      });
      mockedFs.readdirSync.mockReturnValue([
        '1.0.0.meta.json',
        '1.1.0.meta.json',
        '1.2.0.meta.json',
      ] as any);
      vi.mocked(multiRegistry.multiRegistryGetDossier).mockResolvedValue({
        result: null,
        errors: [{ registry: 'public', error: 'network unreachable' }],
      } as any);

      const result = await resolveCachedVersion('org/x');

      expect(result.version).toBe('1.2.0');
      expect(result.source).toBe('stale-cache');
      expect(result.warning).toContain('Registry unreachable');
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Registry unreachable'));
    });

    it('throws when registry unreachable and nothing is cached', async () => {
      mockedFs.existsSync.mockReturnValue(false);
      vi.mocked(multiRegistry.multiRegistryGetDossier).mockResolvedValue({
        result: null,
        errors: [{ registry: 'public', error: 'network down' }],
      } as any);

      await expect(resolveCachedVersion('org/x')).rejects.toThrow(/registry unreachable/i);
    });

    it('throws when registry throws and nothing is cached', async () => {
      mockedFs.existsSync.mockReturnValue(false);
      vi.mocked(multiRegistry.multiRegistryGetDossier).mockRejectedValue(new Error('ETIMEDOUT'));

      await expect(resolveCachedVersion('org/x')).rejects.toThrow(/ETIMEDOUT/);
    });
  });

  describe('highestCachedSemver', () => {
    it('returns null when cache dir does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(highestCachedSemver('org/x')).toBeNull();
    });

    it('returns highest semver from .meta.json files (matched by .ds.md)', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockReturnValue([
        '0.9.0.meta.json',
        '1.10.0.meta.json', // 1.10.0 > 1.2.0 (numeric, not lexicographic)
        '1.2.0.meta.json',
      ] as any);

      expect(highestCachedSemver('org/x')).toBe('1.10.0');
    });

    it('ignores versions where .ds.md is missing', () => {
      mockedFs.existsSync.mockImplementation((p: any) => {
        const ps = String(p);
        // Cache dir exists; only 1.0.0 has both .meta and .ds.md
        if (ps.endsWith('org/x')) return true;
        if (ps.endsWith('1.0.0.ds.md')) return true;
        if (ps.endsWith('2.0.0.ds.md')) return false;
        return true;
      });
      mockedFs.readdirSync.mockReturnValue(['1.0.0.meta.json', '2.0.0.meta.json'] as any);

      expect(highestCachedSemver('org/x')).toBe('1.0.0');
    });
  });

  describe('listResolutions', () => {
    it('returns [] when resolution dir does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(listResolutions()).toEqual([]);
    });

    it('walks and parses resolution files', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockImplementation(
        (_dir: any, opts: any) =>
          (opts?.withFileTypes
            ? [{ name: 'foo.json', isDirectory: () => false }]
            : ['foo.json']) as any
      );
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({
          resolved_version: '1.0.0',
          resolved_at: '2026-05-17T10:00:00Z',
          source_registry: 'public',
        })
      );

      const entries = listResolutions();
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe('foo');
      expect(entries[0].record.resolved_version).toBe('1.0.0');
    });
  });
});
