/**
 * Integration test: registry flow
 *
 * Tests the publish → search → info → export → remove lifecycle
 * using mocked registry client and filesystem.
 */

import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerExportCommand } from '../../commands/export';
import { registerInfoCommand } from '../../commands/info';
import { registerPublishCommand } from '../../commands/publish';
import { registerRemoveCommand } from '../../commands/remove';
import { registerSearchCommand } from '../../commands/search';
import * as config from '../../config';
import * as credentials from '../../credentials';
import * as multiRegistry from '../../multi-registry';
import * as registryClient from '../../registry-client';
import { createTestProgram, parseNameVersionImpl } from '../helpers/test-utils';

vi.mock('node:fs');
vi.mock('node:readline');
vi.mock('../../credentials');
vi.mock('../../registry-client');
vi.mock('../../multi-registry');
vi.mock('../../config');

const mockedFs = vi.mocked(fs);

const dossierContent = `---dossier
{
  "dossier_schema_version": "1.0.0",
  "title": "My Workflow",
  "version": "1.0.0",
  "name": "my-workflow",
  "risk_level": "medium",
  "status": "stable",
  "objective": "Automate deployment"
}
---
# My Workflow

Deploy the application.
`;

describe('registry flow integration', () => {
  const mockClient = {
    publishDossier: vi.fn(),
    getDossier: vi.fn(),
    removeDossier: vi.fn(),
  };

  beforeEach(() => {
    for (const fn of Object.values(mockClient)) {
      fn.mockReset();
    }
    mockedFs.existsSync.mockReset();
    mockedFs.readFileSync.mockReset();
    mockedFs.writeFileSync.mockReset();

    vi.mocked(config.resolveWriteRegistry).mockReturnValue({
      name: 'public',
      url: 'https://test.registry.com',
    });
    vi.mocked(config.resolveRegistries).mockReturnValue([
      { name: 'public', url: 'https://test.registry.com' },
    ]);
    vi.mocked(credentials.loadCredentials).mockReturnValue({
      token: 'tok',
      username: 'user',
      orgs: ['org'],
      expiresAt: null,
    });
    vi.mocked(credentials.isExpired).mockReturnValue(false);
    vi.mocked(registryClient.getClientForRegistry).mockReturnValue(mockClient as any);
    vi.mocked(registryClient.parseNameVersion).mockImplementation(parseNameVersionImpl);
  });

  it('should publish, search, info, export, then remove', async () => {
    // Step 1: Publish
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(dossierContent);
    mockClient.getDossier.mockRejectedValue(
      Object.assign(new Error('Not found'), { statusCode: 404 })
    );
    mockClient.publishDossier.mockResolvedValue({
      name: 'org/my-workflow',
      content_url: 'https://registry.example.com/org/my-workflow',
    });

    const publish = createTestProgram();
    registerPublishCommand(publish);
    await publish.parseAsync(['node', 'dossier', 'publish', 'workflow.ds.md', '--yes']);

    expect(mockClient.publishDossier).toHaveBeenCalledWith('org', dossierContent, null);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Published'));

    // Step 2: Search
    vi.mocked(multiRegistry.multiRegistryList).mockResolvedValue({
      dossiers: [
        {
          name: 'org/my-workflow',
          title: 'My Workflow',
          description: 'Automate deployment',
          tags: ['deploy'],
          _registry: 'public',
        },
      ] as any,
      total: 1,
      errors: [],
    });

    const search = createTestProgram();
    registerSearchCommand(search);
    await search.parseAsync(['node', 'dossier', 'search', 'workflow']);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Found 1'));

    // Step 3: Info from registry
    mockedFs.existsSync.mockReturnValue(false); // Not a local file
    vi.mocked(multiRegistry.multiRegistryGetDossier).mockResolvedValue({
      result: {
        name: 'org/my-workflow',
        title: 'My Workflow',
        version: '1.0.0',
        _registry: 'public',
      },
      errors: [],
    });

    const info = createTestProgram();
    registerInfoCommand(info);
    await expect(info.parseAsync(['node', 'dossier', 'info', 'org/my-workflow'])).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('My Workflow'));

    // Step 4: Export
    mockedFs.existsSync.mockReturnValue(true); // Output dir exists
    vi.mocked(multiRegistry.multiRegistryGetContent).mockResolvedValue({
      result: { content: dossierContent, digest: null, _registry: 'public' },
      errors: [],
    });

    const exp = createTestProgram();
    registerExportCommand(exp);
    await exp.parseAsync(['node', 'dossier', 'export', 'org/my-workflow']);

    expect(mockedFs.writeFileSync).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Exported'));

    // Step 5: Remove
    mockClient.removeDossier.mockResolvedValue({});

    const remove = createTestProgram();
    registerRemoveCommand(remove);
    await remove.parseAsync(['node', 'dossier', 'remove', 'org/my-workflow', '--yes']);

    expect(mockClient.removeDossier).toHaveBeenCalledWith('org/my-workflow', null);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Removed'));
  });

  it('should handle publish then 409 conflict on re-publish', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(dossierContent);
    mockClient.getDossier.mockRejectedValue(
      Object.assign(new Error('Not found'), { statusCode: 404 })
    );

    // First publish succeeds
    mockClient.publishDossier.mockResolvedValue({ name: 'org/my-workflow' });
    const pub1 = createTestProgram();
    registerPublishCommand(pub1);
    await pub1.parseAsync(['node', 'dossier', 'publish', 'workflow.ds.md', '--yes']);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Published'));

    // Second publish: 409 conflict
    mockClient.publishDossier.mockRejectedValue(
      Object.assign(new Error('Version 1.0.0 already exists'), { statusCode: 409 })
    );
    const pub2 = createTestProgram();
    registerPublishCommand(pub2);
    await expect(
      pub2.parseAsync(['node', 'dossier', 'publish', 'workflow.ds.md', '--yes'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Version conflict'));
  });
});
