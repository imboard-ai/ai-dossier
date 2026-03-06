import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerLoginCommand } from '../../commands/login';
import * as config from '../../config';
import * as credentials from '../../credentials';
import * as oauth from '../../oauth';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('../../oauth');
vi.mock('../../credentials');
vi.mock('../../config');

describe('login command', () => {
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    vi.mocked(config.resolveRegistries).mockReturnValue([
      { name: 'public', url: 'https://test.registry.com' },
    ]);
    vi.mocked(config.resolveRegistryByName).mockReturnValue({
      name: 'public',
      url: 'https://test.registry.com',
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
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

    expect(credentials.saveCredentials).toHaveBeenCalledWith(
      {
        token: 'test-token',
        username: 'testuser',
        orgs: ['org1'],
        expiresAt: null,
      },
      'public'
    );
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

    await expect(program.parseAsync(['node', 'dossier', 'login'])).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Login failed'));
  });
});
