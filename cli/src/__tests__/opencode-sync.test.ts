/**
 * Unit tests for opencode-sync helpers.
 *
 * `vi.mock('node:fs')` is hoisted, so every fs call inside opencode-sync goes
 * through the mock. The pure helpers (buildOpencodeWrapper, isDossierFrontmatter)
 * don't touch fs, so the mock is inert for those cases.
 */

import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOpencodeWrapper,
  isDossierFrontmatter,
  listOpencodeSkills,
  OPENCODE_CONFIG_DIR,
  OPENCODE_SKILLS_DIR,
  opencodeConfigExists,
  removeOpencodeWrapper,
  resolveTargets,
  writeOpencodeWrapper,
} from '../opencode-sync';

vi.mock('node:fs');
const mockedFs = vi.mocked(fs);

describe('opencode-sync pure logic', () => {
  const dossierSrc = [
    '---dossier',
    '{',
    '  "dossier_schema_version": "1.0.0",',
    '  "name": "full-cycle-issue-skill",',
    '  "description": "Full autopilot: use when user says \'full cycle issue\'"',
    '}',
    '---',
    '',
    '# Full Cycle Issue',
    '',
    'Run: ai-dossier run imboard-ai/git/full-cycle-issue --pull',
    '',
  ].join('\n');

  const yamlSrc = ['---', 'name: my-skill', 'description: A skill', '---', '', '# Body', ''].join(
    '\n'
  );

  it('detects dossier-frontmatter sources', () => {
    expect(isDossierFrontmatter(dossierSrc)).toBe(true);
    expect(isDossierFrontmatter(yamlSrc)).toBe(false);
    expect(isDossierFrontmatter('')).toBe(false);
  });

  it('builds a YAML wrapper preserving name and description', () => {
    const wrapper = buildOpencodeWrapper(dossierSrc, 'full-cycle-issue-skill');
    expect(wrapper).not.toBeNull();
    expect(wrapper).toContain('---\nname: full-cycle-issue-skill');
    // Single-quoted string; apostrophes doubled up.
    expect(wrapper).toContain(
      "description: 'Full autopilot: use when user says ''full cycle issue'''"
    );
    // Body is preserved verbatim after the closing fence.
    expect(wrapper).toContain('Run: ai-dossier run imboard-ai/git/full-cycle-issue --pull');
  });

  it('emits allowedTools only when the body delegates to ai-dossier run', () => {
    const wrapper = buildOpencodeWrapper(dossierSrc, 'full-cycle-issue-skill');
    expect(wrapper).toContain('allowedTools:\n  - Bash(ai-dossier run *)');

    // Self-contained skill — no delegation, no allowedTools.
    const selfContained = dossierSrc.replace(
      'Run: ai-dossier run imboard-ai/git/full-cycle-issue --pull',
      'Follow these steps: 1. Read the file. 2. Report.'
    );
    const wrapper2 = buildOpencodeWrapper(selfContained, 'pr-security-review');
    expect(wrapper2).not.toContain('allowedTools');
  });

  it('falls back to the directory name when JSON has no name field', () => {
    const noName = [
      '---dossier',
      '{',
      '  "dossier_schema_version": "1.0.0",',
      '  "title": "Scaffold Project",',
      '  "version": "1.0.0"',
      '}',
      '---',
      '',
      '# Scaffold',
      '',
    ].join('\n');
    const wrapper = buildOpencodeWrapper(noName, 'scaffold-project');
    expect(wrapper).toContain('name: scaffold-project');
  });

  it('returns null for YAML-native sources (opencode reads them directly)', () => {
    expect(buildOpencodeWrapper(yamlSrc, 'my-skill')).toBeNull();
  });

  it('returns null for unparseable sources rather than throwing', () => {
    // Malformed JSON inside the dossier fence.
    const bad = '---dossier\n{ not valid json\n---\n\n# Body\n';
    expect(buildOpencodeWrapper(bad, 'broken')).toBeNull();
  });

  it('uses objective as a description fallback when description is absent', () => {
    const noDesc = [
      '---dossier',
      '{',
      '  "dossier_schema_version": "1.0.0",',
      '  "name": "s",',
      '  "objective": "Do the thing"',
      '}',
      '---',
      '',
      '# S',
      '',
    ].join('\n');
    const wrapper = buildOpencodeWrapper(noDesc, 's');
    expect(wrapper).toContain("description: 'Do the thing'");
  });
});

describe('opencode-sync fs helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opencodeConfigExists reflects existsSync on the config dir', () => {
    mockedFs.existsSync.mockReturnValue(true);
    expect(opencodeConfigExists()).toBe(true);
    expect(mockedFs.existsSync).toHaveBeenCalledWith(OPENCODE_CONFIG_DIR);

    mockedFs.existsSync.mockReturnValue(false);
    expect(opencodeConfigExists()).toBe(false);
  });

  it('resolveTargets defaults to claude + auto-detect opencode', () => {
    mockedFs.existsSync.mockReturnValue(true);
    expect(resolveTargets(undefined)).toEqual({ writeClaude: true, writeOpencode: true });

    mockedFs.existsSync.mockReturnValue(false);
    expect(resolveTargets(undefined)).toEqual({ writeClaude: true, writeOpencode: false });
  });

  it('resolveTargets --for claude skips opencode even when present', () => {
    mockedFs.existsSync.mockReturnValue(true);
    expect(resolveTargets('claude')).toEqual({ writeClaude: true, writeOpencode: false });
  });

  it('resolveTargets --for both forces opencode regardless of dir', () => {
    mockedFs.existsSync.mockReturnValue(false);
    expect(resolveTargets('both')).toEqual({ writeClaude: true, writeOpencode: true });
  });

  it('writeOpencodeWrapper creates when target missing', () => {
    mockedFs.existsSync.mockReturnValue(false);
    const src = '---dossier\n{"name":"s","description":"d"}\n---\n\nBody\n';
    const result = writeOpencodeWrapper('s', src);
    expect(result).toBe('created');
    expect(mockedFs.mkdirSync).toHaveBeenCalledWith(path.join(OPENCODE_SKILLS_DIR, 's'), {
      recursive: true,
    });
    expect(mockedFs.writeFileSync).toHaveBeenCalled();
  });

  it('writeOpencodeWrapper reports unchanged when content matches', () => {
    const src = '---dossier\n{"name":"s","description":"d"}\n---\n\nBody\n';
    const expected = buildOpencodeWrapper(src, 's');
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(expected as string);

    const result = writeOpencodeWrapper('s', src);
    expect(result).toBe('unchanged');
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('writeOpencodeWrapper updates when existing content differs', () => {
    const src = '---dossier\n{"name":"s","description":"d"}\n---\n\nBody\n';
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('---\nname: s\ndescription: old\n---\n\nOld body\n');

    const result = writeOpencodeWrapper('s', src);
    expect(result).toBe('updated');
    expect(mockedFs.writeFileSync).toHaveBeenCalled();
  });

  it('writeOpencodeWrapper skips YAML-native sources', () => {
    const yamlSrc = '---\nname: s\ndescription: d\n---\n\nBody\n';
    const result = writeOpencodeWrapper('s', yamlSrc);
    expect(result).toBe('skipped');
    expect(mockedFs.mkdirSync).not.toHaveBeenCalled();
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('removeOpencodeWrapper is a no-op when nothing present', () => {
    mockedFs.existsSync.mockReturnValue(false);
    expect(removeOpencodeWrapper('missing')).toBe(false);
    expect(mockedFs.rmSync).not.toHaveBeenCalled();
  });

  it('removeOpencodeWrapper removes present wrapper', () => {
    mockedFs.existsSync.mockReturnValue(true);
    expect(removeOpencodeWrapper('present')).toBe(true);
    expect(mockedFs.rmSync).toHaveBeenCalledWith(path.join(OPENCODE_SKILLS_DIR, 'present'), {
      recursive: true,
      force: true,
    });
  });

  it('listOpencodeSkills returns [] when dir missing', () => {
    mockedFs.existsSync.mockReturnValue(false);
    expect(listOpencodeSkills()).toEqual([]);
  });

  it('listOpencodeSkills returns directory names with SKILL.md', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readdirSync.mockReturnValue([
      { name: 'a', isDirectory: () => true },
      { name: 'b', isDirectory: () => true },
      { name: 'file.txt', isDirectory: () => false },
    ] as any);
    expect(listOpencodeSkills()).toEqual(['a', 'b']);
  });
});
