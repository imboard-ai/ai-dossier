/**
 * Integration test: authentication flow
 *
 * Tests the login → whoami → logout credential lifecycle
 * using mocked filesystem for credential storage.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerLogoutCommand } from '../../commands/logout';
import { registerWhoamiCommand } from '../../commands/whoami';
import * as credentials from '../../credentials';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('node:fs');
vi.mock('../../credentials');

describe('auth flow integration', () => {
  beforeEach(() => {
    vi.mocked(credentials.loadCredentials).mockReset();
    vi.mocked(credentials.isExpired).mockReset();
    vi.mocked(credentials.deleteCredentials).mockReset();
  });

  it('should show not logged in, then logged in after credentials exist, then logged out', async () => {
    // Step 1: Not logged in
    vi.mocked(credentials.loadCredentials).mockReturnValue(null);

    const whoami1 = createTestProgram();
    registerWhoamiCommand(whoami1);

    await expect(whoami1.parseAsync(['node', 'dossier', 'whoami'])).rejects.toThrow(
      'process.exit(1)'
    );
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Not logged in'));

    // Step 2: Simulate credentials being stored (post-login)
    vi.mocked(credentials.loadCredentials).mockReturnValue({
      token: 'tok-abc',
      username: 'testuser',
      orgs: ['myorg'],
      expiresAt: null,
    });
    vi.mocked(credentials.isExpired).mockReturnValue(false);

    const whoami2 = createTestProgram();
    registerWhoamiCommand(whoami2);

    await whoami2.parseAsync(['node', 'dossier', 'whoami']);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('testuser'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('myorg'));

    // Step 3: Logout
    vi.mocked(credentials.deleteCredentials).mockReturnValue(true as any);

    const logout = createTestProgram();
    registerLogoutCommand(logout);

    await logout.parseAsync(['node', 'dossier', 'logout']);

    expect(credentials.deleteCredentials).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Logged out'));
  });

  it('should detect expired credentials', async () => {
    vi.mocked(credentials.loadCredentials).mockReturnValue({
      token: 'expired-tok',
      username: 'user',
      orgs: [],
      expiresAt: '2020-01-01',
    });
    vi.mocked(credentials.isExpired).mockReturnValue(true);

    const program = createTestProgram();
    registerWhoamiCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'whoami'])).rejects.toThrow(
      'process.exit(1)'
    );
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('expired'));
  });
});
