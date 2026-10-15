import { sha256Hex } from '@ai-dossier/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as config from '../config';
import * as credentials from '../credentials';
import {
  multiRegistryGetContent,
  multiRegistryGetDossier,
  multiRegistryGetEvidence,
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
    getDossierEvidence: vi.fn(),
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
    mockClient.getDossierEvidence.mockReset();
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

      const { result } = await multiRegistryGetDossier('test');
      expect(result).toBeDefined();
      expect(result?._registry).toBe('public');
      expect(result?.version).toBe('1.0.0');
    });

    it('should return null with errors when not found in any registry', async () => {
      mockClient.getDossier.mockRejectedValue(
        Object.assign(new Error('Not found'), { statusCode: 404 })
      );

      const { result, errors } = await multiRegistryGetDossier('missing');
      expect(result).toBeNull();
      expect(errors).toHaveLength(1);
      expect(errors[0].registry).toBe('public');
      expect(errors[0].error).toBe('Not found');
    });

    it('should return empty errors on success', async () => {
      mockClient.getDossier.mockResolvedValue({ name: 'test', version: '1.0.0' });

      const { errors } = await multiRegistryGetDossier('test');
      expect(errors).toHaveLength(0);
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
        digest: `sha256:${sha256Hex('# Test content')}`,
      });

      const { result } = await multiRegistryGetContent('test');
      expect(result).toBeDefined();
      expect(result?.content).toBe('# Test content');
      expect(result?._registry).toBe('public');
    });

    it('should return null with errors when not found', async () => {
      mockClient.getDossierContent.mockRejectedValue(
        Object.assign(new Error('Not found'), { statusCode: 404 })
      );

      const { result, errors } = await multiRegistryGetContent('missing', null, {
        retryDelayMs: 0,
      });
      expect(result).toBeNull();
      expect(errors).toHaveLength(1);
      expect(errors[0].registry).toBe('public');
    });

    // #1240: transient not-found / digest mismatch on content fetch
    const content = '# Dossier body';
    const goodDigest = `sha256:${sha256Hex(content)}`;

    it('retries once and succeeds after a transient not-found', async () => {
      mockClient.getDossierContent
        .mockRejectedValueOnce(Object.assign(new Error('Not found'), { statusCode: 404 }))
        .mockResolvedValueOnce({ content, digest: goodDigest });

      const { result, errors } = await multiRegistryGetContent('org/x', '1.0.0', {
        retryDelayMs: 0,
      });
      expect(result?.content).toBe(content);
      expect(errors).toEqual([]);
      expect(mockClient.getDossierContent).toHaveBeenCalledTimes(2);
    });

    it('retries once and succeeds after a transient digest mismatch', async () => {
      mockClient.getDossierContent
        .mockResolvedValueOnce({ content: '# truncated', digest: goodDigest })
        .mockResolvedValueOnce({ content, digest: goodDigest });

      const { result } = await multiRegistryGetContent('org/x', '1.0.0', { retryDelayMs: 0 });
      expect(result?.content).toBe(content);
      expect(mockClient.getDossierContent).toHaveBeenCalledTimes(2);
    });

    it('reports url, status, expected and actual digest on a persistent mismatch', async () => {
      mockClient.getDossierContent.mockResolvedValue({
        content: '# truncated',
        digest: goodDigest,
        status: 200,
        url: 'https://public.example.com/api/v1/dossiers/org/x/content?version=1.0.0',
      });

      const { result, errors } = await multiRegistryGetContent('org/x', '1.0.0', {
        retryDelayMs: 0,
      });
      expect(result).toBeNull();
      expect(mockClient.getDossierContent).toHaveBeenCalledTimes(2);
      expect(errors).toHaveLength(1);
      expect(errors[0].registry).toBe('public');
      expect(errors[0].error).toContain('checksum mismatch');
      expect(errors[0].error).toContain('url: https://public.example.com/api/v1/dossiers/org/x');
      expect(errors[0].error).toContain('status: 200');
      expect(errors[0].error).toContain(`expected sha256: ${sha256Hex(content)}`);
      expect(errors[0].error).toContain(`actual sha256: ${sha256Hex('# truncated')}`);
    });

    it('does not retry a non-transient failure', async () => {
      mockClient.getDossierContent.mockRejectedValue(
        Object.assign(new Error('Internal error'), { statusCode: 500 })
      );

      const { result } = await multiRegistryGetContent('org/x', '1.0.0', { retryDelayMs: 0 });
      expect(result).toBeNull();
      expect(mockClient.getDossierContent).toHaveBeenCalledTimes(1);
    });

    it('reports every registry queried and its result when all fail', async () => {
      vi.mocked(config.resolveRegistries).mockReturnValue([
        { name: 'public', url: 'https://public.example.com' },
        { name: 'private', url: 'https://private.example.com' },
      ]);
      mockClient.getDossierContent.mockRejectedValue(
        Object.assign(new Error('Not found'), { statusCode: 404 })
      );

      const { result, errors } = await multiRegistryGetContent('org/x', '1.0.0', {
        retryDelayMs: 0,
      });
      expect(result).toBeNull();
      expect(errors).toEqual([
        { registry: 'public', error: 'Not found' },
        { registry: 'private', error: 'Not found' },
      ]);
    });
  });

  describe('multiRegistryGetEvidence', () => {
    it('should return evidence from first succeeding registry', async () => {
      mockClient.getDossierEvidence.mockResolvedValue({
        evidence: '{"evidence_schema_version":"1.0.0"}',
        checksum: 'sha256:abc',
      });

      const { result, errors } = await multiRegistryGetEvidence('test');
      expect(errors).toHaveLength(0);
      expect(result?.evidence).toBe('{"evidence_schema_version":"1.0.0"}');
      expect(result?.checksum).toBe('sha256:abc');
      expect(result?._registry).toBe('public');
    });

    it('should return null with errors when not found', async () => {
      mockClient.getDossierEvidence.mockRejectedValue(
        Object.assign(new Error('Not found'), { statusCode: 404 })
      );

      const { result, errors } = await multiRegistryGetEvidence('missing');
      expect(result).toBeNull();
      expect(errors).toHaveLength(1);
      expect(errors[0].registry).toBe('public');
    });
  });
});
