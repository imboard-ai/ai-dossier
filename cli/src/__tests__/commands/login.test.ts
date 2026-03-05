import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerLoginCommand } from '../../commands/login';
import * as credentials from '../../credentials';
import * as oauth from '../../oauth';
import * as registryClient from '../../registry-client';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('../../oauth');
vi.mock('../../credentials');
vi.mock('../../registry-client');

describe('login command', () => {
  beforeEach(() => {
    // Mocks are reset by global afterEach (setup.ts)
    vi.mocked(registryClient.getRegistryUrl).mockReturnValue('https://test.registry.com');
  });

  it('should save credentials on successful login', async () => {
    vi.mocked(oauth.runOAuthFlow).mockResolvedValue({
      token: 'test-token',
      username: 'testuser',
      orgs: ['org1'],
      email: 'test@example.com',
      expiresAt: null,
    });

    const program = createTestProgram();
    registerLoginCommand(program);
    await program.parseAsync(['node', 'dossier', 'login']);

    expect(credentials.saveCredentials).toHaveBeenCalledWith({
      token: 'test-token',
      username: 'testuser',
      orgs: ['org1'],
      expiresAt: null,
    });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Logged in as testuser'));
  });

  it('should display orgs when present', async () => {
    vi.mocked(oauth.runOAuthFlow).mockResolvedValue({
      token: 'tok',
      username: 'user',
      orgs: ['org1', 'org2'],
      email: null,
    });

    const program = createTestProgram();
    registerLoginCommand(program);
    await program.parseAsync(['node', 'dossier', 'login']);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('org1, org2'));
  });

  it('should exit 1 on OAuth failure', async () => {
    vi.mocked(oauth.runOAuthFlow).mockRejectedValue(new Error('auth failed'));

    const program = createTestProgram();
    registerLoginCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'login'])).rejects.toThrow(
      'process.exit(1)'
    );

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Login failed'));
  });
});
