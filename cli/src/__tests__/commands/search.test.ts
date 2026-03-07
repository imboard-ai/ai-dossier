import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSearchCommand } from '../../commands/search';
import * as config from '../../config';
import * as multiRegistry from '../../multi-registry';
import * as registryClient from '../../registry-client';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('../../multi-registry');
vi.mock('../../registry-client');
vi.mock('../../config');
vi.mock('../../credentials');

describe('search command', () => {
  beforeEach(() => {
    vi.mocked(config.resolveRegistries).mockReturnValue([
      { name: 'public', url: 'https://test.registry.com' },
    ]);
  });

  it('should display matching results', async () => {
    vi.mocked(multiRegistry.multiRegistrySearch).mockResolvedValue({
      dossiers: [
        {
          name: 'deploy-app',
          title: 'Deploy Application',
          description: 'Deploy to production',
          category: 'devops',
          tags: ['deploy'],
          _registry: 'public',
        },
      ] as any,
      total: 1,
      errors: [],
    });

    const program = createTestProgram();
    registerSearchCommand(program);

    await program.parseAsync(['node', 'dossier', 'search', 'deploy']);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Found 1'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('deploy-app'));
  });

  it('should show no results message', async () => {
    vi.mocked(multiRegistry.multiRegistrySearch).mockResolvedValue({
      dossiers: [],
      total: 0,
      errors: [],
    });

    const program = createTestProgram();
    registerSearchCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'search', 'nonexistent'])
    ).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No dossiers found'));
  });

  it('should output JSON with --json', async () => {
    vi.mocked(multiRegistry.multiRegistrySearch).mockResolvedValue({
      dossiers: [
        {
          name: 'test',
          title: 'Test',
          description: 'test dossier',
          tags: ['test'],
          _registry: 'public',
        },
      ] as any,
      total: 1,
      errors: [],
    });

    const program = createTestProgram();
    registerSearchCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'search', 'test', '--json'])
    ).rejects.toThrow();

    const jsonCalls = vi
      .mocked(console.log)
      .mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('"dossiers"'));
    expect(jsonCalls.length).toBeGreaterThan(0);
  });

  it('should filter by content with --content flag', async () => {
    vi.mocked(multiRegistry.multiRegistrySearch).mockResolvedValue({
      dossiers: [
        {
          name: 'deploy-app',
          title: 'Deploy Application',
          description: 'Deploy to production',
          category: 'devops',
          tags: ['deploy'],
          version: '1.0.0',
          _registry: 'public',
        },
        {
          name: 'setup-db',
          title: 'Setup Database',
          description: 'Initialize database',
          category: 'database',
          tags: ['db'],
          version: '1.0.0',
          _registry: 'public',
        },
      ] as any,
      total: 2,
      errors: [],
    });

    const mockContentClient = {
      getDossierContent: vi.fn().mockImplementation(async (name: string) => {
        if (name === 'deploy-app') {
          return { content: 'This is about deploying kubernetes clusters', digest: null };
        }
        return { content: 'This is about postgres setup', digest: null };
      }),
    };
    vi.mocked(registryClient.getClientForRegistry).mockReturnValue(mockContentClient as any);

    const program = createTestProgram();
    registerSearchCommand(program);

    await program.parseAsync(['node', 'dossier', 'search', 'deploy', '--content']);

    expect(mockContentClient.getDossierContent).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('deploy-app'));
  });

  it('should exit 1 on API error with registry context', async () => {
    vi.mocked(multiRegistry.multiRegistrySearch).mockRejectedValue(new Error('Network error'));

    const program = createTestProgram();
    registerSearchCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'search', 'test'])).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Search failed across registries [public]')
    );
  });

  it('should clamp page to minimum of 1', async () => {
    vi.mocked(multiRegistry.multiRegistrySearch).mockResolvedValue({
      dossiers: [
        {
          name: 'test',
          title: 'Test',
          description: 'test dossier',
          tags: ['test'],
          _registry: 'public',
        },
      ] as any,
      total: 1,
      errors: [],
    });

    const program = createTestProgram();
    registerSearchCommand(program);

    await program.parseAsync(['node', 'dossier', 'search', 'test', '--page', '-5']);

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Page'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Found 1'));
  });

  it('should clamp perPage to maximum of 1000', async () => {
    vi.mocked(multiRegistry.multiRegistrySearch).mockResolvedValue({
      dossiers: [
        {
          name: 'test',
          title: 'Test',
          description: 'test dossier',
          tags: ['test'],
          _registry: 'public',
        },
      ] as any,
      total: 1,
      errors: [],
    });

    const program = createTestProgram();
    registerSearchCommand(program);

    await program.parseAsync(['node', 'dossier', 'search', 'test', '--per-page', '99999']);

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Per-page'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Found 1'));
  });

  it('should clamp perPage to minimum of 1', async () => {
    vi.mocked(multiRegistry.multiRegistrySearch).mockResolvedValue({
      dossiers: [
        {
          name: 'test',
          title: 'Test',
          description: 'test dossier',
          tags: ['test'],
          _registry: 'public',
        },
      ] as any,
      total: 1,
      errors: [],
    });

    const program = createTestProgram();
    registerSearchCommand(program);

    await program.parseAsync(['node', 'dossier', 'search', 'test', '--per-page', '0']);

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Per-page'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Found 1'));
  });

  it('should log warning when content fetch fails for a dossier', async () => {
    vi.mocked(multiRegistry.multiRegistrySearch).mockResolvedValue({
      dossiers: [
        {
          name: 'fail-dossier',
          title: 'Fail',
          description: 'will fail content fetch',
          category: 'test',
          tags: ['fail'],
          version: '1.0.0',
          _registry: 'public',
        },
      ] as any,
      total: 1,
      errors: [],
    });

    const mockClient = {
      getDossierContent: vi.fn().mockRejectedValue(new Error('connection refused')),
    };
    vi.mocked(registryClient.getClientForRegistry).mockReturnValue(mockClient as any);

    const program = createTestProgram();
    registerSearchCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'search', 'fail', '--content'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to fetch content for 'fail-dossier' from 'public'")
    );
  });
});
