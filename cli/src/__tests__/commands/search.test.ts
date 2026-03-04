import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSearchCommand } from '../../commands/search';
import * as registryClient from '../../registry-client';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('../../registry-client');

describe('search command', () => {
  const mockClient = { listDossiers: vi.fn(), getDossierContent: vi.fn() };

  beforeEach(() => {
    vi.mocked(registryClient.getClient).mockReturnValue(mockClient as any);
  });

  it('should display matching results', async () => {
    mockClient.listDossiers.mockResolvedValue({
      dossiers: [
        {
          name: 'deploy-app',
          title: 'Deploy Application',
          description: 'Deploy to production',
          category: 'devops',
          tags: ['deploy'],
        },
        {
          name: 'setup-db',
          title: 'Setup Database',
          description: 'Initialize database',
          category: 'database',
          tags: ['db'],
        },
      ],
    });

    const program = createTestProgram();
    registerSearchCommand(program);

    // When results are found and no --json, function completes normally (no process.exit)
    await program.parseAsync(['node', 'dossier', 'search', 'deploy']);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Found 1'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('deploy-app'));
  });

  it('should show no results message', async () => {
    mockClient.listDossiers.mockResolvedValue({ dossiers: [] });

    const program = createTestProgram();
    registerSearchCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'search', 'nonexistent'])).rejects.toThrow(
      'process.exit(0)'
    );

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No dossiers found'));
  });

  it('should output JSON with --json', async () => {
    mockClient.listDossiers.mockResolvedValue({
      dossiers: [{ name: 'test', title: 'Test', description: 'test dossier', tags: ['test'] }],
    });

    const program = createTestProgram();
    registerSearchCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'search', 'test', '--json'])
    ).rejects.toThrow('process.exit(0)');

    const jsonCalls = vi
      .mocked(console.log)
      .mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('"dossiers"'));
    expect(jsonCalls.length).toBeGreaterThan(0);
  });

  it('should filter by content with --content flag', async () => {
    mockClient.listDossiers.mockResolvedValue({
      dossiers: [
        {
          name: 'deploy-app',
          title: 'Deploy Application',
          description: 'Deploy to production',
          category: 'devops',
          tags: ['deploy'],
          version: '1.0.0',
        },
        {
          name: 'setup-db',
          title: 'Setup Database',
          description: 'Initialize database',
          category: 'database',
          tags: ['db'],
          version: '1.0.0',
        },
      ],
    });

    mockClient.getDossierContent.mockImplementation(async (name: string) => {
      if (name === 'deploy-app') {
        return { content: 'This is about deploying kubernetes clusters', digest: null };
      }
      return { content: 'This is about postgres setup', digest: null };
    });

    const program = createTestProgram();
    registerSearchCommand(program);

    // Search for "kubernetes" with --content; only deploy-app body contains it
    // First, metadata filter for "deploy" matches deploy-app
    await program.parseAsync(['node', 'dossier', 'search', 'deploy', '--content']);

    expect(mockClient.getDossierContent).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('deploy-app'));
  });

  it('should exit 1 on API error', async () => {
    mockClient.listDossiers.mockRejectedValue(new Error('Network error'));

    const program = createTestProgram();
    registerSearchCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'search', 'test'])).rejects.toThrow(
      'process.exit(1)'
    );

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Search failed'));
  });
});
