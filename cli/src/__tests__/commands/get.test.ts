import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerGetCommand } from '../../commands/get';
import * as config from '../../config';
import * as multiRegistry from '../../multi-registry';
import * as registryClient from '../../registry-client';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('../../multi-registry');
vi.mock('../../registry-client');
vi.mock('../../config');

describe('get command', () => {
  beforeEach(() => {
    vi.mocked(registryClient.parseNameVersion).mockImplementation((name: string) => {
      if (name.includes('@')) {
        const idx = name.lastIndexOf('@');
        return [name.slice(0, idx), name.slice(idx + 1)];
      }
      return [name, null];
    });
    vi.mocked(config.resolveRegistries).mockReturnValue([
      { name: 'public', url: 'https://test.com' },
    ]);
  });

  it('should display dossier metadata from registry', async () => {
    vi.mocked(multiRegistry.multiRegistryGetDossier).mockResolvedValue({
      name: 'deploy-app',
      title: 'Deploy Application',
      version: '1.0.0',
      status: 'stable',
      category: ['devops'],
      objective: 'Deploy to production',
      authors: [{ name: 'Alice' }],
      tags: ['deploy', 'ci'],
      _registry: 'public',
    });

    const program = createTestProgram();
    registerGetCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'get', 'deploy-app'])).rejects.toThrow();

    expect(multiRegistry.multiRegistryGetDossier).toHaveBeenCalledWith('deploy-app', null);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('deploy-app'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Deploy Application'));
  });

  it('should pass version when using name@version', async () => {
    vi.mocked(multiRegistry.multiRegistryGetDossier).mockResolvedValue({
      name: 'deploy-app',
      title: 'Deploy Application',
      version: '2.0.0',
      _registry: 'public',
    });

    const program = createTestProgram();
    registerGetCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'get', 'deploy-app@2.0.0'])
    ).rejects.toThrow();

    expect(multiRegistry.multiRegistryGetDossier).toHaveBeenCalledWith('deploy-app', '2.0.0');
  });

  it('should output JSON with --json', async () => {
    vi.mocked(multiRegistry.multiRegistryGetDossier).mockResolvedValue({
      name: 'test',
      title: 'Test',
      version: '1.0.0',
      _registry: 'public',
    });

    const program = createTestProgram();
    registerGetCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'get', 'test', '--json'])
    ).rejects.toThrow();

    const jsonCalls = vi
      .mocked(console.log)
      .mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('"name"'));
    expect(jsonCalls.length).toBeGreaterThan(0);
  });

  it('should exit 1 on not found', async () => {
    vi.mocked(multiRegistry.multiRegistryGetDossier).mockResolvedValue(null);

    const program = createTestProgram();
    registerGetCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'get', 'nonexistent'])).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Not found'));
  });
});
