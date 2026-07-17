import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerInstallSkillCommand } from '../../commands/install-skill';
import * as multiRegistry from '../../multi-registry';
import { OPENCODE_CONFIG_DIR, OPENCODE_SKILLS_DIR } from '../../opencode-sync';
import * as registryClient from '../../registry-client';
import { createTestProgram, parseNameVersionImpl } from '../helpers/test-utils';

vi.mock('node:fs');
vi.mock('../../multi-registry');
vi.mock('../../registry-client');

const mockedFs = vi.mocked(fs);

/** Compact dossier content used by install tests — has both name & description. */
const DOSSIER_CONTENT = [
  '---dossier',
  '{',
  '  "dossier_schema_version": "1.0.0",',
  '  "name": "my-skill",',
  '  "description": "A skill",',
  '  "objective": "Do the thing"',
  '}',
  '---',
  '',
  '# Body',
  '',
  'Run: ai-dossier run org/my-skill --pull',
  '',
].join('\n');

describe('install-skill command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(registryClient.parseNameVersion).mockImplementation(parseNameVersionImpl);
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

  it('--list badges skills also present in opencode', async () => {
    // claude skill dir + opencode wrapper dir both exist; both contain 'my-skill'.
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readdirSync.mockImplementation(((p: any) => {
      // Called for the claude skills dir and for the opencode skills dir.
      return [{ name: 'my-skill', isDirectory: () => true }] as any;
    }) as any);
    mockedFs.readFileSync.mockReturnValue('---\ndescription: A skill\n---\nContent');

    const program = createTestProgram();
    registerInstallSkillCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'install-skill', '--list'])
    ).rejects.toThrow();

    // Badge appears next to the name.
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[claude, opencode]'));
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

  it('--remove cleans both claude and opencode', async () => {
    mockedFs.existsSync.mockReturnValue(true);

    const program = createTestProgram();
    registerInstallSkillCommand(program);

    await expect(
      program.parseAsync(['node', 'dossier', 'install-skill', '--remove', 'old-skill'])
    ).rejects.toThrow();

    // Two rmSync calls — one per location.
    expect(mockedFs.rmSync).toHaveBeenCalledTimes(2);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('claude, opencode'));
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
      result: { version: '1.0.0', _registry: 'public' },
      errors: [],
    } as any);
    vi.mocked(multiRegistry.multiRegistryGetContent).mockResolvedValue({
      result: { content: '# Skill content', _registry: 'public' },
      errors: [],
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

  it('auto-writes opencode wrapper when ~/.config/opencode exists', async () => {
    // existsSync returns true only for OPENCODE_CONFIG_DIR (auto-detect) — nothing
    // else exists, so install proceeds and wrapper writes go through.
    mockedFs.existsSync.mockImplementation(((p: any) => {
      const s = String(p);
      return s === OPENCODE_CONFIG_DIR;
    }) as any);
    vi.mocked(multiRegistry.multiRegistryGetContent).mockResolvedValue({
      result: { content: DOSSIER_CONTENT, _registry: 'public' },
      errors: [],
    } as any);

    const program = createTestProgram();
    registerInstallSkillCommand(program);
    await program.parseAsync(['node', 'dossier', 'install-skill', 'org/my-skill']);

    // Wrapper was written under OPENCODE_SKILLS_DIR.
    const writes = mockedFs.writeFileSync.mock.calls.map((c) => String(c[0]));
    expect(writes.some((p) => p.startsWith(OPENCODE_SKILLS_DIR))).toBe(true);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(
        `opencode: created at ${path.join(OPENCODE_SKILLS_DIR, 'my-skill', 'SKILL.md')}`
      )
    );
  });

  it('does NOT auto-write opencode wrapper when ~/.config/opencode is absent', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    vi.mocked(multiRegistry.multiRegistryGetContent).mockResolvedValue({
      result: { content: DOSSIER_CONTENT, _registry: 'public' },
      errors: [],
    } as any);

    const program = createTestProgram();
    registerInstallSkillCommand(program);
    await program.parseAsync(['node', 'dossier', 'install-skill', 'org/my-skill']);

    const writes = mockedFs.writeFileSync.mock.calls.map((c) => String(c[0]));
    expect(writes.some((p) => p.startsWith(OPENCODE_SKILLS_DIR))).toBe(false);
  });

  it('--for claude skips opencode wrapper even when opencode dir exists', async () => {
    mockedFs.existsSync.mockImplementation(((p: any) => String(p) === OPENCODE_CONFIG_DIR) as any);
    vi.mocked(multiRegistry.multiRegistryGetContent).mockResolvedValue({
      result: { content: DOSSIER_CONTENT, _registry: 'public' },
      errors: [],
    } as any);

    const program = createTestProgram();
    registerInstallSkillCommand(program);
    await program.parseAsync([
      'node',
      'dossier',
      'install-skill',
      '--for',
      'claude',
      'org/my-skill',
    ]);

    const writes = mockedFs.writeFileSync.mock.calls.map((c) => String(c[0]));
    expect(writes.some((p) => p.startsWith(OPENCODE_SKILLS_DIR))).toBe(false);
  });

  it('--for both forces opencode wrapper even when opencode dir is absent', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    vi.mocked(multiRegistry.multiRegistryGetContent).mockResolvedValue({
      result: { content: DOSSIER_CONTENT, _registry: 'public' },
      errors: [],
    } as any);

    const program = createTestProgram();
    registerInstallSkillCommand(program);
    await program.parseAsync(['node', 'dossier', 'install-skill', '--for', 'both', 'org/my-skill']);

    const writes = mockedFs.writeFileSync.mock.calls.map((c) => String(c[0]));
    expect(writes.some((p) => p.startsWith(OPENCODE_SKILLS_DIR))).toBe(true);
  });

  it('rejects invalid --for value', async () => {
    const program = createTestProgram();
    registerInstallSkillCommand(program);
    await expect(
      program.parseAsync(['node', 'dossier', 'install-skill', '--for', 'bogus', 'org/my-skill'])
    ).rejects.toThrow();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Invalid --for value'));
  });

  it('YAML-native source is not wrapped (opencode reads source directly)', async () => {
    // opencode dir exists → auto-detect fires. But the source is YAML, so wrapper
    // generation returns 'skipped' and no file is written under OPENCODE_SKILLS_DIR.
    mockedFs.existsSync.mockImplementation(((p: any) => String(p) === OPENCODE_CONFIG_DIR) as any);
    vi.mocked(multiRegistry.multiRegistryGetContent).mockResolvedValue({
      result: {
        content: '---\nname: my-skill\ndescription: A skill\n---\n\n# Body\n',
        _registry: 'public',
      },
      errors: [],
    } as any);

    const program = createTestProgram();
    registerInstallSkillCommand(program);
    await program.parseAsync(['node', 'dossier', 'install-skill', 'org/my-skill']);

    const writes = mockedFs.writeFileSync.mock.calls.map((c) => String(c[0]));
    expect(writes.some((p) => p.startsWith(OPENCODE_SKILLS_DIR))).toBe(false);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('opencode: source is YAML'));
  });
});
