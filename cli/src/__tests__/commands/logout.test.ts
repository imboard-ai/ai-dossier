import { describe, expect, it, vi } from 'vitest';
import { registerLogoutCommand } from '../../commands/logout';
import * as credentials from '../../credentials';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('../../credentials');

describe('logout command', () => {
  it('should show success when credentials exist', async () => {
    vi.mocked(credentials.listCredentialRegistries).mockReturnValue(['public']);
    vi.mocked(credentials.deleteCredentials).mockReturnValue(true);
    const program = createTestProgram();
    registerLogoutCommand(program);

    await program.parseAsync(['node', 'dossier', 'logout']);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Logged out'));
  });

  it('should show not-logged-in when no credentials', async () => {
    vi.mocked(credentials.listCredentialRegistries).mockReturnValue([]);
    vi.mocked(credentials.deleteCredentials).mockReturnValue(false);
    const program = createTestProgram();
    registerLogoutCommand(program);

    await program.parseAsync(['node', 'dossier', 'logout']);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Not logged in'));
  });
});
