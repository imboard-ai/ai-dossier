import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSkillExportCommand } from '../../commands/skill-export';
import * as config from '../../config';
import * as credentials from '../../credentials';
import * as registryClient from '../../registry-client';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('node:fs');
vi.mock('../../credentials');
vi.mock('../../registry-client');
vi.mock('../../config');

const mockedFs = vi.mocked(fs);

describe('skill-export command', () => {
  const mockClient = {
    publishDossier: vi.fn(),
    getDossierContent: vi.fn(),
  };

  const validCredentials = {
    token: 'test-token',
    username: 'testuser',
    orgs: ['myorg'],
    expiresAt: null,
  };

  const skillContent =
    '---dossier\n{"dossier_schema_version":"1.0.0","name":"my-skill","title":"My Skill","version":"1.0.0"}\n---\n# Skill body';

  beforeEach(() => {
    vi.mocked(config.resolveWriteRegistry).mockReturnValue({
      name: 'public',
      url: 'https://test.registry.com',
    });
    vi.mocked(credentials.loadCredentials).mockReturnValue(validCredentials);
    vi.mocked(credentials.isExpired).mockReturnValue(false);
    vi.mocked(registryClient.getClientForRegistry).mockReturnValue(mockClient as any);
    mockClient.publishDossier.mockReset();
    mockClient.getDossierContent.mockReset();
    mockedFs.existsSync.mockReset();
    mockedFs.readFileSync.mockReset();
    mockedFs.writeFileSync.mockReset();
    mockedFs.readdirSync.mockReset();
  });

  it('should export a skill with auto minor version bump', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(skillContent);
    mockClient.publishDossier.mockResolvedValue({
      name: 'myorg/my-skill',
      content_url: 'https://example.com',
    });

    const program = createTestProgram();
    registerSkillExportCommand(program);

    await program.parseAsync(['node', 'dossier', 'skill-export', 'my-skill', '-y']);

    expect(mockClient.publishDossier).toHaveBeenCalledWith(
      'myorg',
      expect.stringContaining('1.1.0'),
      expect.any(String)
    );
    expect(mockedFs.writeFileSync).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Exported'));
  });

  it('should bump major version with --major', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(skillContent);
    mockClient.publishDossier.mockResolvedValue({ name: 'myorg/my-skill' });

    const program = createTestProgram();
    registerSkillExportCommand(program);

    await program.parseAsync(['node', 'dossier', 'skill-export', 'my-skill', '-y', '--major']);

    expect(mockClient.publishDossier).toHaveBeenCalledWith(
      'myorg',
      expect.stringContaining('2.0.0'),
      expect.any(String)
    );
  });

  it('should use explicit version with --version', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(skillContent);
    mockClient.publishDossier.mockResolvedValue({ name: 'myorg/my-skill' });

    const program = createTestProgram();
    registerSkillExportCommand(program);

    await program.parseAsync([
      'node',
      'dossier',
      'skill-export',
      'my-skill',
      '-y',
      '--version',
      '3.0.0',
    ]);

    expect(mockClient.publishDossier).toHaveBeenCalledWith(
      'myorg',
      expect.stringContaining('3.0.0'),
      expect.any(String)
    );
  });

  it('should skip version bump with --no-bump', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(skillContent);
    mockClient.publishDossier.mockResolvedValue({ name: 'myorg/my-skill' });

    const program = createTestProgram();
    registerSkillExportCommand(program);

    await program.parseAsync(['node', 'dossier', 'skill-export', 'my-skill', '-y', '--no-bump']);

    expect(mockClient.publishDossier).toHaveBeenCalledWith(
      'myorg',
      expect.stringContaining('1.0.0'),
      expect.any(String)
    );
    // Should NOT write back to file since version didn't change
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('should exit 1 when not logged in', async () => {
    vi.mocked(credentials.loadCredentials).mockReturnValue(null);

    const program = createTestProgram();
    registerSkillExportCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'skill-export', 'my-skill'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Not logged in'));
  });

  it('should exit 1 when skill not found', async () => {
    mockedFs.existsSync.mockReturnValue(false);

    const program = createTestProgram();
    registerSkillExportCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'skill-export', 'missing-skill'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Skill 'missing-skill' not found")
    );
  });

  it('should output JSON with --json flag', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(skillContent);
    mockClient.publishDossier.mockResolvedValue({
      name: 'myorg/my-skill',
      content_url: 'https://example.com',
    });

    const program = createTestProgram();
    registerSkillExportCommand(program);

    await program.parseAsync(['node', 'dossier', 'skill-export', 'my-skill', '--json']);

    const jsonCall = vi
      .mocked(console.log)
      .mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('"exported"'));
    expect(jsonCall).toBeDefined();
    const parsed = JSON.parse(jsonCall?.[0] as string);
    expect(parsed.exported).toBe(true);
    expect(parsed.version).toBe('1.1.0');
  });

  it('should use custom namespace', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(skillContent);
    mockClient.publishDossier.mockResolvedValue({ name: 'custom-ns/my-skill' });

    const program = createTestProgram();
    registerSkillExportCommand(program);

    await program.parseAsync([
      'node',
      'dossier',
      'skill-export',
      'my-skill',
      '-y',
      '--namespace',
      'custom-ns',
    ]);

    expect(mockClient.publishDossier).toHaveBeenCalledWith(
      'custom-ns',
      expect.any(String),
      expect.any(String)
    );
  });

  it('should handle publish errors', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(skillContent);
    mockClient.publishDossier.mockRejectedValue(
      Object.assign(new Error('Permission denied'), { statusCode: 403 })
    );

    const program = createTestProgram();
    registerSkillExportCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'skill-export', 'my-skill', '-y'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Permission denied'));
  });
});
