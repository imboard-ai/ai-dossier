import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerInstallSkillCommand } from '../../commands/install-skill';
import * as multiRegistry from '../../multi-registry';
import * as registryClient from '../../registry-client';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('node:fs');
vi.mock('../../multi-registry');
vi.mock('../../registry-client');

const mockedFs = vi.mocked(fs);

describe('install-skill command', () => {
  beforeEach(() => {
    vi.mocked(registryClient.parseNameVersion).mockImplementation((name: string) => {
      if (name.includes('@')) {
        const idx = name.lastIndexOf('@');
        return [name.slice(0, idx), name.slice(idx + 1)];
      }
      return [name, null];
    });
  });

  it('should list installed skills with --list', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readdirSync.mockReturnValue([
      { name: 'my-skill', isDirectory: () => true } as any,
    ] as any);
    mockedFs.readFileSync.mockReturnValue('---\ndescription: A skill\n---\nContent');

    const program = createTestProgram();
    registerInstallSkillCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'install-skill', '--list'])
    ).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Installed skills'));
  });

  it('should show no skills when directory missing', async () => {
    mockedFs.existsSync.mockReturnValue(false);

    const program = createTestProgram();
    registerInstallSkillCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'install-skill', '--list'])
    ).rejects.toThrow();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No installed skills'));
  });

  it('should remove a skill with --remove', async () => {
    mockedFs.existsSync.mockReturnValue(true);

    const program = createTestProgram();
    registerInstallSkillCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'install-skill', '--remove', 'old-skill'])
    ).rejects.toThrow();

    expect(mockedFs.rmSync).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Removed skill'));
  });

  it('should exit 1 when removing non-existent skill', async () => {
    mockedFs.existsSync.mockReturnValue(false);

    const program = createTestProgram();
    registerInstallSkillCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'install-skill', '--remove', 'missing'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Skill not found'));
  });

  it('should exit 1 when no name provided', async () => {
    const program = createTestProgram();
    registerInstallSkillCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'install-skill'])).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('provide a dossier name'));
  });

  it('should install from registry', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    vi.mocked(multiRegistry.multiRegistryGetDossier).mockResolvedValue({
      version: '1.0.0',
      _registry: 'public',
    } as any);
    vi.mocked(multiRegistry.multiRegistryGetContent).mockResolvedValue({
      content: '# Skill content',
      _registry: 'public',
    } as any);

    const program = createTestProgram();
    registerInstallSkillCommand(program);

    await program.parseAsync(['node', 'dossier', 'install-skill', 'org/my-skill']);

    expect(mockedFs.mkdirSync).toHaveBeenCalled();
    expect(mockedFs.writeFileSync).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Installed skill'));
  });

  it('should exit 1 when skill already exists without --force', async () => {
    mockedFs.existsSync.mockReturnValue(true);

    const program = createTestProgram();
    registerInstallSkillCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'install-skill', 'org/my-skill'])
    ).rejects.toThrow();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('already installed'));
  });
});
