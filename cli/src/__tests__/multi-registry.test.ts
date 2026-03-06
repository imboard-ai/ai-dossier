import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as config from '../config';
import * as credentials from '../credentials';
import {
  multiRegistryGetContent,
  multiRegistryGetDossier,
  multiRegistryList,
} from '../multi-registry';
import * as registryClient from '../registry-client';

vi.mock('../config');
vi.mock('../credentials');
vi.mock('../registry-client');

describe('multi-registry', () => {
  const mockClient = {
    listDossiers: vi.fn(),
    getDossier: vi.fn(),
    getDossierContent: vi.fn(),
  };

  beforeEach(() => {
    vi.mocked(config.resolveRegistries).mockReturnValue([
      { name: 'public', url: 'https://public.example.com' },
    ]);
    vi.mocked(credentials.loadCredentials).mockReturnValue(null);
    vi.mocked(registryClient.getClientForRegistry).mockReturnValue(mockClient as any);
    mockClient.listDossiers.mockReset();
    mockClient.getDossier.mockReset();
    mockClient.getDossierContent.mockReset();
  });

  describe('multiRegistryList', () => {
    it('should list dossiers from all registries', async () => {
      mockClient.listDossiers.mockResolvedValue({
        dossiers: [{ name: 'test', title: 'Test' }],
        total: 1,
      });

      const result = await multiRegistryList();
      expect(result.dossiers).toHaveLength(1);
      expect(result.dossiers[0]._registry).toBe('public');
      expect(result.errors).toHaveLength(0);
    });

    it('should collect errors from failing registries', async () => {
      vi.mocked(config.resolveRegistries).mockReturnValue([
        { name: 'public', url: 'https://public.example.com' },
        { name: 'internal', url: 'https://internal.example.com' },
      ]);

      let callCount = 0;
      mockClient.listDossiers.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ dossiers: [{ name: 'test' }], total: 1 });
        }
        return Promise.reject(new Error('Connection refused'));
      });

      const result = await multiRegistryList();
      expect(result.dossiers).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].registry).toBe('internal');
    });

    it('should merge dossiers from multiple registries', async () => {
      vi.mocked(config.resolveRegistries).mockReturnValue([
        { name: 'public', url: 'https://public.example.com' },
        { name: 'internal', url: 'https://internal.example.com' },
      ]);

      mockClient.listDossiers
        .mockResolvedValueOnce({ dossiers: [{ name: 'pub-dossier' }], total: 1 })
        .mockResolvedValueOnce({ dossiers: [{ name: 'int-dossier' }], total: 1 });

      const result = await multiRegistryList();
      expect(result.dossiers).toHaveLength(2);
      expect(result.total).toBe(2);
    });
  });

  describe('multiRegistryGetDossier', () => {
    it('should return dossier from first succeeding registry', async () => {
      mockClient.getDossier.mockResolvedValue({ name: 'test', version: '1.0.0' });

      const result = await multiRegistryGetDossier('test');
      expect(result).toBeDefined();
      expect(result?._registry).toBe('public');
      expect(result?.version).toBe('1.0.0');
    });

    it('should return null when not found in any registry', async () => {
      mockClient.getDossier.mockRejectedValue(
        Object.assign(new Error('Not found'), { statusCode: 404 })
      );

      const result = await multiRegistryGetDossier('missing');
      expect(result).toBeNull();
    });

    it('should pass version to getDossier', async () => {
      mockClient.getDossier.mockResolvedValue({ name: 'test', version: '2.0.0' });

      await multiRegistryGetDossier('test', '2.0.0');
      expect(mockClient.getDossier).toHaveBeenCalledWith('test', '2.0.0');
    });
  });

  describe('multiRegistryGetContent', () => {
    it('should return content from first succeeding registry', async () => {
      mockClient.getDossierContent.mockResolvedValue({
        content: '# Test content',
        digest: 'sha256:abc',
      });

      const result = await multiRegistryGetContent('test');
      expect(result).toBeDefined();
      expect(result?.content).toBe('# Test content');
      expect(result?._registry).toBe('public');
    });

    it('should return null when not found', async () => {
      mockClient.getDossierContent.mockRejectedValue(
        Object.assign(new Error('Not found'), { statusCode: 404 })
      );

      const result = await multiRegistryGetContent('missing');
      expect(result).toBeNull();
    });
  });
});
