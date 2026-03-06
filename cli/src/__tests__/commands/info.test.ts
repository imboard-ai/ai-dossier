import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerInfoCommand } from '../../commands/info';
import * as config from '../../config';
import * as multiRegistry from '../../multi-registry';
import * as registryClient from '../../registry-client';
import { createTestProgram, parseNameVersionImpl } from '../helpers/test-utils';

vi.mock('node:fs');
vi.mock('../../multi-registry');
vi.mock('../../registry-client');
vi.mock('../../config');

const mockedFs = vi.mocked(fs);

describe('info command', () => {
  beforeEach(() => {
    vi.mocked(config.resolveRegistries).mockReturnValue([
      { name: 'public', url: 'https://test.registry.com' },
    ]);
    vi.mocked(registryClient.parseNameVersion).mockImplementation(parseNameVersionImpl);
  });

  it('should display info for local file with JSON frontmatter', async () => {
    const content =
      '---dossier\n{"title":"Test","version":"1.0.0","risk_level":"low","status":"stable"}\n---\nBody content';
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);

    const program = createTestProgram();
    registerInfoCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'info', 'test.ds.md'])).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Dossier Info'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Test'));
  });

  it('should display info for local file with YAML frontmatter', async () => {
    const content = '---\ntitle: My Dossier\nversion: 2.0.0\nrisk_level: medium\n---\nBody';
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);

    const program = createTestProgram();
    registerInfoCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'info', 'test.ds.md'])).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('My Dossier'));
  });

  it('should fetch info from registry when not a local file', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    vi.mocked(multiRegistry.multiRegistryGetDossier).mockResolvedValue({
      result: {
        name: 'org/dossier',
        title: 'Registry Dossier',
        version: '1.0.0',
        _registry: 'public',
      },
      errors: [],
    });

    const program = createTestProgram();
    registerInfoCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'info', 'org/dossier'])).rejects.toThrow();

    expect(multiRegistry.multiRegistryGetDossier).toHaveBeenCalledWith('org/dossier', null);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Registry Dossier'));
  });

  it('should output JSON with --json', async () => {
    const content = '---dossier\n{"title":"Test","version":"1.0.0"}\n---\nBody';
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(content);

    const program = createTestProgram();
    registerInfoCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'info', 'test.ds.md', '--json'])
    ).rejects.toThrow();

    const jsonCalls = vi
      .mocked(console.log)
      .mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('"title"'));
    expect(jsonCalls.length).toBeGreaterThan(0);
  });

  it('should exit 1 on registry 404', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    vi.mocked(multiRegistry.multiRegistryGetDossier).mockResolvedValue({
      result: null,
      errors: [],
    });

    const program = createTestProgram();
    registerInfoCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'info', 'missing/dossier'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Not found'));
  });

  it('should exit 1 on invalid frontmatter format', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('No frontmatter at all');

    const program = createTestProgram();
    registerInfoCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'info', 'test.ds.md'])).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Invalid dossier format'));
  });
});
