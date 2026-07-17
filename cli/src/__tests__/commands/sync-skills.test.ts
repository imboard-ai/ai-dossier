import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSyncSkillsCommand } from '../../commands/sync-skills';
import { CLAUDE_SKILLS_DIR, OPENCODE_CONFIG_DIR, OPENCODE_SKILLS_DIR } from '../../opencode-sync';
import { createTestProgram } from '../helpers/test-utils';

vi.mock('node:fs');
const mockedFs = vi.mocked(fs);

const DOSSIER_SRC = [
  '---dossier',
  '{',
  '  "dossier_schema_version": "1.0.0",',
  '  "name": "my-skill",',
  '  "description": "A skill"',
  '}',
  '---',
  '',
  '# Body',
  '',
  'Run: ai-dossier run org/my-skill --pull',
  '',
].join('\n');

const YAML_SRC = '---\nname: yaml-skill\ndescription: A yaml skill\n---\n\n# Body\n';

/** Build an existsSync predicate given a set of paths that should return true. */
function existsIn(paths: Set<string>) {
  return (p: any) => paths.has(String(p));
}

describe('sync-skills command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exits 1 when opencode is not installed', async () => {
    mockedFs.existsSync.mockReturnValue(false);

    const program = createTestProgram();
    registerSyncSkillsCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'sync-skills'])).rejects.toThrow();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('opencode not found'));
  });

  it('reports empty state when opencode present but no claude skills', async () => {
    // Opencode dir exists, claude skills dir does not.
    mockedFs.existsSync.mockImplementation(existsIn(new Set([OPENCODE_CONFIG_DIR])) as any);

    const program = createTestProgram();
    registerSyncSkillsCommand(program);

    await expect(program.parseAsync(['node', 'dossier', 'sync-skills'])).rejects.toThrow(/exit/i);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No claude skills to sync'));
  });

  it('creates wrappers for dossier-frontmatter sources', async () => {
    const skillSource = path.join(CLAUDE_SKILLS_DIR, 'my-skill', 'SKILL.md');
    // Everything the walk needs exists; wrapper target does not (→ create).
    mockedFs.existsSync.mockImplementation(((p: any) => {
      const s = String(p);
      if (s === OPENCODE_CONFIG_DIR) return true;
      if (s === CLAUDE_SKILLS_DIR) return true;
      if (s === skillSource) return true;
      if (s === OPENCODE_SKILLS_DIR) return false; // for prune walk
      return false;
    }) as any);
    mockedFs.readdirSync.mockImplementation(((p: any) => {
      const s = String(p);
      if (s === CLAUDE_SKILLS_DIR) {
        return [{ name: 'my-skill', isDirectory: () => true }] as any;
      }
      return [] as any;
    }) as any);
    mockedFs.readFileSync.mockReturnValue(DOSSIER_SRC);

    const program = createTestProgram();
    registerSyncSkillsCommand(program);
    await expect(program.parseAsync(['node', 'dossier', 'sync-skills'])).rejects.toThrow();

    // Wrapper was written under OPENCODE_SKILLS_DIR/my-skill/SKILL.md.
    const writes = mockedFs.writeFileSync.mock.calls.map((c) => String(c[0]));
    expect(writes.some((p) => p === path.join(OPENCODE_SKILLS_DIR, 'my-skill', 'SKILL.md'))).toBe(
      true
    );
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('created:   1'));
  });

  it('skips YAML-native sources', async () => {
    const skillSource = path.join(CLAUDE_SKILLS_DIR, 'yaml-skill', 'SKILL.md');
    mockedFs.existsSync.mockImplementation(((p: any) => {
      const s = String(p);
      return s === OPENCODE_CONFIG_DIR || s === CLAUDE_SKILLS_DIR || s === skillSource;
    }) as any);
    mockedFs.readdirSync.mockImplementation(((p: any) => {
      if (String(p) === CLAUDE_SKILLS_DIR) {
        return [{ name: 'yaml-skill', isDirectory: () => true }] as any;
      }
      return [] as any;
    }) as any);
    mockedFs.readFileSync.mockReturnValue(YAML_SRC);

    const program = createTestProgram();
    registerSyncSkillsCommand(program);
    await expect(program.parseAsync(['node', 'dossier', 'sync-skills'])).rejects.toThrow();

    const writes = mockedFs.writeFileSync.mock.calls.map((c) => String(c[0]));
    expect(writes.some((p) => p.startsWith(OPENCODE_SKILLS_DIR))).toBe(false);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('skipped:   1'));
  });

  it('prunes wrappers whose claude source is gone by default', async () => {
    const orphanWrapper = path.join(OPENCODE_SKILLS_DIR, 'gone-skill', 'SKILL.md');
    mockedFs.existsSync.mockImplementation(((p: any) => {
      const s = String(p);
      // opencode dir exists, claude skills dir exists (empty), opencode skills dir exists,
      // orphan wrapper file exists.
      return (
        s === OPENCODE_CONFIG_DIR ||
        s === CLAUDE_SKILLS_DIR ||
        s === OPENCODE_SKILLS_DIR ||
        s === orphanWrapper ||
        s === path.join(OPENCODE_SKILLS_DIR, 'gone-skill')
      );
    }) as any);
    mockedFs.readdirSync.mockImplementation(((p: any) => {
      const s = String(p);
      if (s === CLAUDE_SKILLS_DIR) return [] as any;
      if (s === OPENCODE_SKILLS_DIR) {
        return [{ name: 'gone-skill', isDirectory: () => true }] as any;
      }
      return [] as any;
    }) as any);

    const program = createTestProgram();
    registerSyncSkillsCommand(program);
    await expect(program.parseAsync(['node', 'dossier', 'sync-skills'])).rejects.toThrow();

    expect(mockedFs.rmSync).toHaveBeenCalledWith(path.join(OPENCODE_SKILLS_DIR, 'gone-skill'), {
      recursive: true,
      force: true,
    });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('removed:   1'));
  });

  it('--no-prune keeps orphaned wrappers', async () => {
    mockedFs.existsSync.mockImplementation(((p: any) => {
      const s = String(p);
      return (
        s === OPENCODE_CONFIG_DIR ||
        s === CLAUDE_SKILLS_DIR ||
        s === OPENCODE_SKILLS_DIR ||
        s === path.join(OPENCODE_SKILLS_DIR, 'gone-skill')
      );
    }) as any);
    mockedFs.readdirSync.mockImplementation(((p: any) => {
      const s = String(p);
      if (s === CLAUDE_SKILLS_DIR) return [] as any;
      if (s === OPENCODE_SKILLS_DIR) {
        return [{ name: 'gone-skill', isDirectory: () => true }] as any;
      }
      return [] as any;
    }) as any);

    const program = createTestProgram();
    registerSyncSkillsCommand(program);
    await expect(
      program.parseAsync(['node', 'dossier', 'sync-skills', '--no-prune'])
    ).rejects.toThrow();

    expect(mockedFs.rmSync).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('prune disabled'));
  });

  it('--dry-run reports actions but writes nothing', async () => {
    const skillSource = path.join(CLAUDE_SKILLS_DIR, 'my-skill', 'SKILL.md');
    mockedFs.existsSync.mockImplementation(((p: any) => {
      const s = String(p);
      return s === OPENCODE_CONFIG_DIR || s === CLAUDE_SKILLS_DIR || s === skillSource;
    }) as any);
    mockedFs.readdirSync.mockImplementation(((p: any) => {
      if (String(p) === CLAUDE_SKILLS_DIR) {
        return [{ name: 'my-skill', isDirectory: () => true }] as any;
      }
      return [] as any;
    }) as any);
    mockedFs.readFileSync.mockReturnValue(DOSSIER_SRC);

    const program = createTestProgram();
    registerSyncSkillsCommand(program);
    await expect(
      program.parseAsync(['node', 'dossier', 'sync-skills', '--dry-run'])
    ).rejects.toThrow();

    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    expect(mockedFs.rmSync).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Dry run'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('created:   1'));
  });

  it('--json emits structured output', async () => {
    mockedFs.existsSync.mockImplementation(existsIn(new Set([OPENCODE_CONFIG_DIR])) as any);

    const program = createTestProgram();
    registerSyncSkillsCommand(program);
    await expect(
      program.parseAsync(['node', 'dossier', 'sync-skills', '--json'])
    ).rejects.toThrow();

    // At least one console.log call should contain valid JSON with success:true or the
    // empty-state envelope.
    const jsonCalls = (console.log as any).mock.calls
      .map((c: any[]) => String(c[0]))
      .filter((s: string) => s.trim().startsWith('{'));
    expect(jsonCalls.length).toBeGreaterThan(0);
    const parsed = JSON.parse(jsonCalls[0]);
    expect(parsed.success).toBe(true);
  });
});
