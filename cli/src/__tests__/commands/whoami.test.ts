import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerWhoamiCommand } from '../../commands/whoami';
import * as config from '../../config';
import * as credentials from '../../credentials';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('../../credentials');
vi.mock('../../config');

describe('whoami command', () => {
  beforeEach(() => {
    vi.mocked(config.resolveRegistries).mockReturnValue([
      { name: 'public', url: 'https://test.registry.com' },
    ]);
  });

  it('should display username when logged in', async () => {
    vi.mocked(credentials.listCredentialRegistries).mockReturnValue(['public']);
    vi.mocked(credentials.loadCredentials).mockReturnValue({
      token: 'tok',
      username: 'testuser',
      orgs: ['org1'],
      expiresAt: null,
    });
    vi.mocked(credentials.isExpired).mockReturnValue(false);

    const program = createTestProgram();
    registerWhoamiCommand(program);
    await program.parseAsync(['node', 'dossier', 'whoami']);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('testuser'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('org1'));
  });

  it('should exit 1 when not logged in', async () => {
    vi.mocked(credentials.listCredentialRegistries).mockReturnValue([]);
    vi.mocked(credentials.loadCredentials).mockReturnValue(null);

    const program = createTestProgram();
    registerWhoamiCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'whoami'])).rejects.toThrow();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Not logged in'));
  });

  it('should exit 1 when credentials expired', async () => {
    vi.mocked(credentials.listCredentialRegistries).mockReturnValue(['public']);
    vi.mocked(credentials.loadCredentials).mockReturnValue({
      token: 'tok',
      username: 'user',
      orgs: [],
      expiresAt: '2020-01-01',
    });
    vi.mocked(credentials.isExpired).mockReturnValue(true);

    const program = createTestProgram();
    registerWhoamiCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'whoami'])).rejects.toThrow();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('expired'));
  });

  it('should output JSON when logged in with --json flag', async () => {
    vi.mocked(credentials.listCredentialRegistries).mockReturnValue(['public']);
    vi.mocked(credentials.loadCredentials).mockReturnValue({
      token: 'tok',
      username: 'testuser',
      orgs: ['org1', 'org2'],
      expiresAt: null,
    });
    vi.mocked(credentials.isExpired).mockReturnValue(false);

    const program = createTestProgram();
    registerWhoamiCommand(program);
    await program.parseAsync(['node', 'dossier', 'whoami', '--json']);

    const jsonCall = vi.mocked(console.log).mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.logged_in === true;
      } catch {
        return false;
      }
    });
    expect(jsonCall).toBeDefined();
    const output = JSON.parse(jsonCall?.[0] as string);
    expect(output.username).toBe('testuser');
    expect(output.orgs).toEqual(['org1', 'org2']);
  });

  it('should output JSON when not logged in with --json flag', async () => {
    vi.mocked(credentials.listCredentialRegistries).mockReturnValue([]);
    vi.mocked(credentials.loadCredentials).mockReturnValue(null);

    const program = createTestProgram();
    registerWhoamiCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'whoami', '--json'])).rejects.toThrow();

    const jsonCall = vi.mocked(console.log).mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.logged_in === false;
      } catch {
        return false;
      }
    });
    expect(jsonCall).toBeDefined();
    const output = JSON.parse(jsonCall?.[0] as string);
    expect(output.error).toBe('Not logged in');
    expect(output.code).toBe('not_logged_in');
  });

  it('should show all registries when multiple credentials exist', async () => {
    vi.mocked(credentials.listCredentialRegistries).mockReturnValue(['public', 'internal']);
    vi.mocked(credentials.loadCredentials).mockImplementation((name) => {
      if (name === 'public') {
        return { token: 'tok1', username: 'user1', orgs: ['org1'], expiresAt: null };
      }
      return { token: 'tok2', username: 'user2', orgs: [], expiresAt: null };
    });
    vi.mocked(credentials.isExpired).mockReturnValue(false);

    const program = createTestProgram();
    registerWhoamiCommand(program);
    await program.parseAsync(['node', 'dossier', 'whoami']);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Registry Credentials'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('user1'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('user2'));
  });

  it('should show expired registry in multi-registry view', async () => {
    vi.mocked(credentials.listCredentialRegistries).mockReturnValue(['public', 'internal']);
    vi.mocked(credentials.loadCredentials).mockImplementation((name) => {
      if (name === 'public') {
        return { token: 'tok1', username: 'user1', orgs: [], expiresAt: null };
      }
      return { token: 'tok2', username: 'user2', orgs: [], expiresAt: '2020-01-01' };
    });
    vi.mocked(credentials.isExpired).mockImplementation(
      (creds) => creds.expiresAt === '2020-01-01'
    );

    const program = createTestProgram();
    registerWhoamiCommand(program);
    await program.parseAsync(['node', 'dossier', 'whoami']);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('expired'));
  });

  it('should output JSON for multiple registries', async () => {
    vi.mocked(credentials.listCredentialRegistries).mockReturnValue(['public', 'internal']);
    vi.mocked(credentials.loadCredentials).mockImplementation((name) => {
      if (name === 'public') {
        return { token: 'tok1', username: 'user1', orgs: ['org1'], expiresAt: null };
      }
      return { token: 'tok2', username: 'user2', orgs: [], expiresAt: null };
    });
    vi.mocked(credentials.isExpired).mockReturnValue(false);

    const program = createTestProgram();
    registerWhoamiCommand(program);
    await program.parseAsync(['node', 'dossier', 'whoami', '--json']);

    const jsonCall = vi.mocked(console.log).mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.registries !== undefined;
      } catch {
        return false;
      }
    });
    expect(jsonCall).toBeDefined();
    const output = JSON.parse(jsonCall?.[0] as string);
    expect(output.registries).toHaveLength(2);
  });

  it('should show specific registry with --registry flag', async () => {
    vi.mocked(credentials.loadCredentials).mockReturnValue({
      token: 'tok',
      username: 'reguser',
      orgs: ['org1'],
      expiresAt: null,
    });
    vi.mocked(credentials.isExpired).mockReturnValue(false);

    const program = createTestProgram();
    registerWhoamiCommand(program);
    await program.parseAsync(['node', 'dossier', 'whoami', '--registry', 'public']);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('reguser'));
  });

  it('should exit 1 for specific registry not logged in', async () => {
    vi.mocked(credentials.loadCredentials).mockReturnValue(null);

    const program = createTestProgram();
    registerWhoamiCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'whoami', '--registry', 'internal'])
    ).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Not logged in'));
  });

  it('should exit 1 for specific registry with expired credentials', async () => {
    vi.mocked(credentials.loadCredentials).mockReturnValue({
      token: 'tok',
      username: 'user',
      orgs: [],
      expiresAt: '2020-01-01',
    });
    vi.mocked(credentials.isExpired).mockReturnValue(true);

    const program = createTestProgram();
    registerWhoamiCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'whoami', '--registry', 'internal'])
    ).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('expired'));
  });

  it('should output JSON for specific registry when logged in', async () => {
    vi.mocked(credentials.loadCredentials).mockReturnValue({
      token: 'tok',
      username: 'jsonuser',
      orgs: ['org1'],
      expiresAt: null,
    });
    vi.mocked(credentials.isExpired).mockReturnValue(false);

    const program = createTestProgram();
    registerWhoamiCommand(program);
    await program.parseAsync(['node', 'dossier', 'whoami', '--registry', 'public', '--json']);

    const jsonCall = vi.mocked(console.log).mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.logged_in === true && parsed.registry === 'public';
      } catch {
        return false;
      }
    });
    expect(jsonCall).toBeDefined();
  });

  it('should output JSON for specific registry not logged in', async () => {
    vi.mocked(credentials.loadCredentials).mockReturnValue(null);

    const program = createTestProgram();
    registerWhoamiCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'whoami', '--registry', 'internal', '--json'])
    ).rejects.toThrow();

    const jsonCall = vi.mocked(console.log).mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.logged_in === false && parsed.registry === 'internal';
      } catch {
        return false;
      }
    });
    expect(jsonCall).toBeDefined();
  });

  it('should output JSON for specific registry with expired credentials', async () => {
    vi.mocked(credentials.loadCredentials).mockReturnValue({
      token: 'tok',
      username: 'user',
      orgs: [],
      expiresAt: '2020-01-01',
    });
    vi.mocked(credentials.isExpired).mockReturnValue(true);

    const program = createTestProgram();
    registerWhoamiCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'whoami', '--registry', 'internal', '--json'])
    ).rejects.toThrow();

    const jsonCall = vi.mocked(console.log).mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.code === 'expired';
      } catch {
        return false;
      }
    });
    expect(jsonCall).toBeDefined();
  });

  it('should not show orgs when empty', async () => {
    vi.mocked(credentials.listCredentialRegistries).mockReturnValue(['public']);
    vi.mocked(credentials.loadCredentials).mockReturnValue({
      token: 'tok',
      username: 'user',
      orgs: [],
      expiresAt: null,
    });
    vi.mocked(credentials.isExpired).mockReturnValue(false);

    const program = createTestProgram();
    registerWhoamiCommand(program);
    await program.parseAsync(['node', 'dossier', 'whoami']);

    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Organizations'));
  });
});
