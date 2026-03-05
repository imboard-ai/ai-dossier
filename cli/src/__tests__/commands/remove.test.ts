import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRemoveCommand } from '../../commands/remove';
import * as credentials from '../../credentials';
import * as registryClient from '../../registry-client';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('node:readline');
vi.mock('../../credentials');
vi.mock('../../registry-client');

describe('remove command', () => {
  const mockClient = { removeDossier: vi.fn() };

  beforeEach(() => {
    vi.mocked(credentials.loadCredentials).mockReturnValue({
      token: 'tok',
      username: 'user',
      orgs: ['org'],
      expiresAt: null,
    });
    vi.mocked(credentials.isExpired).mockReturnValue(false);
    vi.mocked(registryClient.getClient).mockReturnValue(mockClient as any);
    vi.mocked(registryClient.parseNameVersion).mockImplementation((name: string) => {
      if (name.includes('@')) {
        const idx = name.lastIndexOf('@');
        return [name.slice(0, idx), name.slice(idx + 1)];
      }
      return [name, null];
    });
  });

  it('should exit 1 when not logged in', async () => {
    vi.mocked(credentials.loadCredentials).mockReturnValue(null);

    const program = createTestProgram();
    registerRemoveCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'remove', 'my-dossier'])).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Not logged in'));
  });

  it('should exit 1 when credentials expired', async () => {
    vi.mocked(credentials.isExpired).mockReturnValue(true);

    const program = createTestProgram();
    registerRemoveCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'remove', 'my-dossier'])).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('expired'));
  });

  it('should remove with --yes flag and show CDN warning', async () => {
    mockClient.removeDossier.mockResolvedValue({});

    const program = createTestProgram();
    registerRemoveCommand(program);

    await program.parseAsync(['node', 'dossier', 'remove', 'my-dossier', '--yes']);

    expect(mockClient.removeDossier).toHaveBeenCalledWith('my-dossier', null);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Removed'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('CDN propagation'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('dossier info my-dossier'));
  });

  it('should output JSON with verification field after remove', async () => {
    mockClient.removeDossier.mockResolvedValue({});

    const program = createTestProgram();
    registerRemoveCommand(program);

    await program.parseAsync(['node', 'dossier', 'remove', 'my-dossier', '--yes', '--json']);

    const jsonCall = vi.mocked(console.log).mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.success === true;
      } catch {
        return false;
      }
    });
    expect(jsonCall).toBeDefined();
    const output = JSON.parse(jsonCall?.[0] as string);
    expect(output.verification).toBeDefined();
    expect(output.verification.verify_command).toBe('dossier info my-dossier');
    expect(output.verification.cdn_delay_seconds).toBe(30);
  });

  it('should output JSON error on remove failure with --json flag', async () => {
    mockClient.removeDossier.mockRejectedValue(
      Object.assign(new Error('Not found'), { statusCode: 404 })
    );

    const program = createTestProgram();
    registerRemoveCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'remove', 'missing', '--yes', '--json'])
    ).rejects.toThrow();

    const jsonCall = vi.mocked(console.log).mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.success === false;
      } catch {
        return false;
      }
    });
    expect(jsonCall).toBeDefined();
    const output = JSON.parse(jsonCall?.[0] as string);
    expect(output.success).toBe(false);
    expect(output.statusCode).toBe(404);
  });

  it('should remove specific version with --yes', async () => {
    mockClient.removeDossier.mockResolvedValue({});

    const program = createTestProgram();
    registerRemoveCommand(program);

    await program.parseAsync(['node', 'dossier', 'remove', 'my-dossier@1.0.0', '--yes']);

    expect(mockClient.removeDossier).toHaveBeenCalledWith('my-dossier', '1.0.0');
  });

  it('should exit 1 on 404', async () => {
    mockClient.removeDossier.mockRejectedValue(
      Object.assign(new Error('Not found'), { statusCode: 404 })
    );

    const program = createTestProgram();
    registerRemoveCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'remove', 'missing', '--yes'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Not found'));
  });

  it('should exit 1 on 403', async () => {
    mockClient.removeDossier.mockRejectedValue(
      Object.assign(new Error('Forbidden'), { statusCode: 403 })
    );

    const program = createTestProgram();
    registerRemoveCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'remove', 'forbidden', '--yes'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Permission denied'));
  });
});
