import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerGetCommand } from '../../commands/get';
import * as registryClient from '../../registry-client';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('../../registry-client');

describe('get command', () => {
  const mockClient = { getDossier: vi.fn() };

  beforeEach(() => {
    vi.mocked(registryClient.getClient).mockReturnValue(mockClient as any);
    vi.mocked(registryClient.parseNameVersion).mockImplementation((name: string) => {
      if (name.includes('@')) {
        const idx = name.lastIndexOf('@');
        return [name.slice(0, idx), name.slice(idx + 1)];
      }
      return [name, null];
    });
  });

  it('should display dossier metadata from registry', async () => {
    mockClient.getDossier.mockResolvedValue({
      name: 'deploy-app',
      title: 'Deploy Application',
      version: '1.0.0',
      status: 'stable',
      category: ['devops'],
      objective: 'Deploy to production',
      authors: [{ name: 'Alice' }],
      tags: ['deploy', 'ci'],
    });

    const program = createTestProgram();
    registerGetCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'get', 'deploy-app'])).rejects.toThrow(
      'process.exit(0)'
    );

    expect(mockClient.getDossier).toHaveBeenCalledWith('deploy-app', null);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('deploy-app'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Deploy Application'));
  });

  it('should pass version when using name@version', async () => {
    mockClient.getDossier.mockResolvedValue({
      name: 'deploy-app',
      title: 'Deploy Application',
      version: '2.0.0',
    });

    const program = createTestProgram();
    registerGetCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'get', 'deploy-app@2.0.0'])
    ).rejects.toThrow('process.exit(0)');

    expect(mockClient.getDossier).toHaveBeenCalledWith('deploy-app', '2.0.0');
  });

  it('should output JSON with --json', async () => {
    mockClient.getDossier.mockResolvedValue({
      name: 'test',
      title: 'Test',
      version: '1.0.0',
    });

    const program = createTestProgram();
    registerGetCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'get', 'test', '--json'])).rejects.toThrow(
      'process.exit(0)'
    );

    const jsonCalls = vi
      .mocked(console.log)
      .mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('"name"'));
    expect(jsonCalls.length).toBeGreaterThan(0);
  });

  it('should exit 1 on 404', async () => {
    const err = new Error('Not found');
    (err as any).statusCode = 404;
    mockClient.getDossier.mockRejectedValue(err);

    const program = createTestProgram();
    registerGetCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'get', 'nonexistent'])).rejects.toThrow(
      'process.exit(1)'
    );

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Not found in registry'));
  });

  it('should exit 1 on other errors', async () => {
    mockClient.getDossier.mockRejectedValue(new Error('Network error'));

    const program = createTestProgram();
    registerGetCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'get', 'some-dossier'])).rejects.toThrow(
      'process.exit(1)'
    );

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Registry error'));
  });
});
