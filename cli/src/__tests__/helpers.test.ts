import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process');
vi.mock('node:fs');

const mockedFs = vi.mocked(fs);
const mockedExecFileSync = vi.mocked(execFileSync);

import {
  buildLlmCommand,
  detectLlm,
  detectNestedHost,
  findDossierFilesLocal,
  formatDossierFields,
  formatTable,
  logPaginationInfo,
  parseDossierMetadataFromContent,
  parseListSource,
  printRegistryErrors,
  RECOMMENDED_FIELDS,
  REQUIRED_FIELDS,
  VALID_RISK_LEVELS,
  VALID_STATUSES,
} from '../helpers';
import { makeDossier, makeDossierYaml } from './helpers/test-utils';

describe('constants', () => {
  it('REQUIRED_FIELDS should include essential fields', () => {
    expect(REQUIRED_FIELDS).toContain('title');
    expect(REQUIRED_FIELDS).toContain('version');
    expect(REQUIRED_FIELDS).toContain('dossier_schema_version');
  });

  it('RECOMMENDED_FIELDS should include helpful fields', () => {
    expect(RECOMMENDED_FIELDS).toContain('objective');
    expect(RECOMMENDED_FIELDS).toContain('risk_level');
    expect(RECOMMENDED_FIELDS).toContain('status');
  });

  it('VALID_RISK_LEVELS should include standard levels', () => {
    expect(VALID_RISK_LEVELS).toEqual(['low', 'medium', 'high', 'critical']);
  });

  it('VALID_STATUSES should include standard statuses', () => {
    expect(VALID_STATUSES).toEqual(['Draft', 'Stable', 'Deprecated', 'Experimental']);
  });
});

describe('parseListSource', () => {
  it('should parse local directory path', () => {
    expect(parseListSource('.')).toEqual({ type: 'local', path: '.' });
    expect(parseListSource('/home/user/dossiers')).toEqual({
      type: 'local',
      path: '/home/user/dossiers',
    });
  });

  it('should parse github: shorthand', () => {
    const result = parseListSource('github:owner/repo');
    expect(result).toEqual({
      type: 'github',
      owner: 'owner',
      repo: 'repo',
      path: '',
      branch: 'main',
    });
  });

  it('should parse github: shorthand with subpath and branch', () => {
    const result = parseListSource('github:owner/repo/path/to/dossiers@develop');
    expect(result).toEqual({
      type: 'github',
      owner: 'owner',
      repo: 'repo',
      path: 'path/to/dossiers',
      branch: 'develop',
    });
  });

  it('should parse GitHub URL', () => {
    const result = parseListSource('https://github.com/imboard-ai/ai-dossier');
    expect(result).toEqual({
      type: 'github',
      owner: 'imboard-ai',
      repo: 'ai-dossier',
      path: '',
      branch: 'main',
    });
  });

  it('should parse GitHub tree URL with branch and path', () => {
    const result = parseListSource('https://github.com/owner/repo/tree/main/examples');
    expect(result).toEqual({
      type: 'github',
      owner: 'owner',
      repo: 'repo',
      path: 'examples',
      branch: 'main',
    });
  });
});

describe('parseDossierMetadataFromContent', () => {
  it('should parse JSON frontmatter', () => {
    const content = makeDossier({ title: 'My Dossier', version: '2.0.0', risk_level: 'high' });
    const result = parseDossierMetadataFromContent(content, '/path/test.ds.md');

    expect(result.title).toBe('My Dossier');
    expect(result.version).toBe('2.0.0');
    expect(result.risk_level).toBe('high');
    expect(result.error).toBeNull();
  });

  it('should parse YAML frontmatter', () => {
    const content = makeDossierYaml({ title: 'YAML Dossier', version: '1.0.0' });
    const result = parseDossierMetadataFromContent(content, '/path/test.ds.md');

    expect(result.title).toBe('YAML Dossier');
    expect(result.version).toBe('1.0.0');
    expect(result.error).toBeNull();
  });

  it('should return error for content without frontmatter', () => {
    const result = parseDossierMetadataFromContent('# Just markdown', '/test.ds.md');
    expect(result.error).toBe('Invalid frontmatter');
  });

  it('should return error for invalid frontmatter', () => {
    const content = '---dossier\nkey: [invalid\n---\n\nBody';
    const result = parseDossierMetadataFromContent(content, '/test.ds.md');
    expect(result.error).toBe('Invalid frontmatter');
  });

  it('should handle array categories', () => {
    const content = makeDossier({ category: ['deploy', 'ci'] });
    const result = parseDossierMetadataFromContent(content, '/test.ds.md');
    expect(result.category).toBe('deploy, ci');
  });

  it('should detect signature presence', () => {
    const content = makeDossier({ signature: { key_id: 'abc', value: 'sig' } });
    const result = parseDossierMetadataFromContent(content, '/test.ds.md');
    expect(result.signed).toBe(true);
  });

  it('should detect checksum presence', () => {
    const content = makeDossier({ checksum: 'sha256:abc' });
    const result = parseDossierMetadataFromContent(content, '/test.ds.md');
    expect(result.checksum).toBe(true);
  });

  it('should extract filename from path', () => {
    const content = makeDossier({});
    const result = parseDossierMetadataFromContent(content, '/long/path/dossier.ds.md');
    expect(result.filename).toBe('dossier.ds.md');
  });
});

describe('formatTable', () => {
  it('should return "No dossiers found." for empty array', () => {
    expect(formatTable([])).toBe('No dossiers found.');
  });

  it('should format dossier table with headers', () => {
    const dossiers = [
      {
        path: '/test.ds.md',
        filename: 'test.ds.md',
        title: 'Test',
        risk_level: 'low',
        signed: true,
        error: null,
      },
    ];

    const table = formatTable(dossiers);
    expect(table).toContain('TITLE');
    expect(table).toContain('RISK');
    expect(table).toContain('SIGNED');
    expect(table).toContain('Test');
    expect(table).toContain('LOW');
  });

  it('should show path when showPath is true', () => {
    const dossiers = [
      {
        path: '/full/path/test.ds.md',
        filename: 'test.ds.md',
        title: 'Test',
        error: null,
      },
    ];

    const table = formatTable(dossiers, true);
    expect(table).toContain('PATH');
    expect(table).toContain('/full/path/test.ds.md');
  });
});

describe('detectLlm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return the llm name when not auto', () => {
    expect(detectLlm('claude-code')).toBe('claude-code');
    expect(detectLlm('opencode')).toBe('opencode');
    expect(detectLlm('custom-llm')).toBe('custom-llm');
  });

  it('should return null when auto-detect fails', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    expect(detectLlm('auto', true)).toBeNull();
  });

  it('should detect claude when command exists', () => {
    mockedExecFileSync.mockReturnValue(Buffer.from('/usr/bin/claude'));

    expect(detectLlm('auto', true)).toBe('claude-code');
  });

  it('should prefer claude over opencode when both are installed (order: claude first)', () => {
    mockedExecFileSync.mockImplementation((_cmd: string, args: readonly string[]) =>
      args[0] === 'claude' ? Buffer.from('/usr/bin/claude') : Buffer.from('/usr/bin/opencode')
    );

    expect(detectLlm('auto', true)).toBe('claude-code');
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockedExecFileSync).toHaveBeenCalledWith('which', ['claude'], { stdio: 'pipe' });
  });

  it('should fall back to opencode when claude is absent', () => {
    mockedExecFileSync.mockImplementation((_cmd: string, args: readonly string[]) => {
      if (args[0] === 'claude') throw new Error('not found');
      return Buffer.from('/usr/bin/opencode');
    });

    expect(detectLlm('auto', true)).toBe('opencode');
    expect(mockedExecFileSync).toHaveBeenCalledWith('which', ['claude'], { stdio: 'pipe' });
    expect(mockedExecFileSync).toHaveBeenCalledWith('which', ['opencode'], { stdio: 'pipe' });
  });

  it('should return null when neither claude nor opencode is installed', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    expect(detectLlm('auto', true)).toBeNull();
    expect(mockedExecFileSync).toHaveBeenCalledWith('which', ['claude'], { stdio: 'pipe' });
    expect(mockedExecFileSync).toHaveBeenCalledWith('which', ['opencode'], { stdio: 'pipe' });
  });
});

describe('detectNestedHost', () => {
  const nestedEnvVars = ['CLAUDE_CODE', 'CLAUDECODE', 'OPENCODE'] as const;

  beforeEach(() => {
    for (const key of nestedEnvVars) delete process.env[key];
  });

  afterEach(() => {
    for (const key of nestedEnvVars) delete process.env[key];
  });

  it('should return null when no nested-session env var is set', () => {
    expect(detectNestedHost()).toBeNull();
  });

  it('should detect Claude Code via CLAUDE_CODE', () => {
    process.env.CLAUDE_CODE = '1';
    expect(detectNestedHost()).toBe('Claude Code');
  });

  it('should detect Claude Code via CLAUDECODE', () => {
    process.env.CLAUDECODE = '1';
    expect(detectNestedHost()).toBe('Claude Code');
  });

  it('should detect opencode via OPENCODE', () => {
    process.env.OPENCODE = '1';
    expect(detectNestedHost()).toBe('opencode');
  });
});

describe('buildLlmCommand', () => {
  it('should build command for claude-code with local file', () => {
    mockedFs.readFileSync.mockReturnValue('file content');
    const result = buildLlmCommand('claude-code', '/path/to/dossier.ds.md');
    expect(result).not.toBeNull();
    expect((result as NonNullable<typeof result>).cmd).toBe('claude');
    expect((result as NonNullable<typeof result>).args).toEqual(['/path/to/dossier.ds.md']);
    expect((result as NonNullable<typeof result>).stdin).toBeUndefined();
    expect((result as NonNullable<typeof result>).agent).toBe('claude-code');
  });

  it('should build headless command for claude-code', () => {
    mockedFs.readFileSync.mockReturnValue('file content');
    const result = buildLlmCommand('claude-code', '/path/to/dossier.ds.md', true);
    expect(result).not.toBeNull();
    expect((result as NonNullable<typeof result>).cmd).toBe('claude');
    // JSON output mode so the run log can capture usage (#458).
    expect((result as NonNullable<typeof result>).args).toEqual(['-p', '--output-format', 'json']);
    expect((result as NonNullable<typeof result>).stdin).toBe('file content');
  });

  it('should forward passthrough flags in headless mode', () => {
    mockedFs.readFileSync.mockReturnValue('file content');
    const result = buildLlmCommand('claude-code', '/path/to/dossier.ds.md', true, {
      model: 'sonnet',
      budget: 2,
      permissionMode: 'bypassPermissions',
      allowedTools: 'Bash Read Write',
    });
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.cmd).toBe('claude');
    expect(r.args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--model',
      'sonnet',
      '--max-budget-usd',
      '2',
      '--permission-mode',
      'bypassPermissions',
      '--allowedTools',
      'Bash,Read,Write',
    ]);
    expect(r.stdin).toBe('file content');
    expect(r.description).toContain('--model');
    expect(r.description).toContain('--max-budget-usd');
    expect(r.description).toContain('--allowedTools');
  });

  it('should normalize comma- and space-separated allowed tools (dedupe, trim)', () => {
    mockedFs.readFileSync.mockReturnValue('file content');
    const result = buildLlmCommand('claude-code', '/path/to/dossier.ds.md', true, {
      allowedTools: 'Bash  Read, Write ,Bash,',
    });
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.args).toEqual(['-p', '--output-format', 'json', '--allowedTools', 'Bash,Read,Write']);
  });

  it('should forward --model in interactive (non-headless) mode', () => {
    mockedFs.readFileSync.mockReturnValue('file content');
    const result = buildLlmCommand('claude-code', '/path/to/dossier.ds.md', false, {
      model: 'sonnet',
    });
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.args).toEqual(['--model', 'sonnet', '/path/to/dossier.ds.md']);
    expect(r.stdin).toBeUndefined();
    expect(r.description).toBe('claude --model sonnet "/path/to/dossier.ds.md"');
  });

  it('should ignore headless-only flags in interactive mode (model still forwarded)', () => {
    mockedFs.readFileSync.mockReturnValue('file content');
    const result = buildLlmCommand('claude-code', '/path/to/dossier.ds.md', false, {
      model: 'sonnet',
      budget: 2,
      permissionMode: 'bypassPermissions',
      allowedTools: 'Bash Read',
    });
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.args).toEqual(['--model', 'sonnet', '/path/to/dossier.ds.md']);
    expect(r.stdin).toBeUndefined();
  });

  it('should handle budget of 0 in headless mode', () => {
    mockedFs.readFileSync.mockReturnValue('file content');
    const result = buildLlmCommand('claude-code', '/path/to/dossier.ds.md', true, {
      budget: 0,
    });
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.args).toEqual(['-p', '--output-format', 'json', '--max-budget-usd', '0']);
  });

  it('should return null for unknown LLM', () => {
    expect(buildLlmCommand('unknown-llm', '/file.ds.md')).toBeNull();
  });
});

describe('buildLlmCommand (opencode)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedFs.readFileSync.mockReturnValue('dossier content');
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('should build headless command with the dossier piped via stdin', () => {
    const result = buildLlmCommand('opencode', '/path/to/dossier.ds.md', true);
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.cmd).toBe('opencode');
    expect(r.args).toEqual(['run', '--format', 'json']);
    expect(r.stdin).toBe('dossier content');
    expect(r.agent).toBe('opencode');
    expect(r.description).toContain('opencode run --format json');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('should forward --model in headless mode', () => {
    const result = buildLlmCommand('opencode', '/path/to/dossier.ds.md', true, {
      model: 'moonshotai/kimi-k3',
    });
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.args).toEqual(['run', '--format', 'json', '--model', 'moonshotai/kimi-k3']);
    expect(r.stdin).toBe('dossier content');
  });

  it('should build interactive command as a seeded session (run -i), not a project path', () => {
    const result = buildLlmCommand('opencode', '/path/to/dossier.ds.md', false);
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.cmd).toBe('opencode');
    // Bare `opencode [project]` would treat the prompt as a project path —
    // the prompt must seed a `run -i` session instead.
    expect(r.args).toEqual(['run', '-i', 'dossier content']);
    expect(r.stdin).toBeUndefined();
    expect(r.agent).toBe('opencode');
  });

  it('should forward --model in interactive mode', () => {
    const result = buildLlmCommand('opencode', '/path/to/dossier.ds.md', false, {
      model: 'moonshotai/kimi-k3',
    });
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.args).toEqual(['run', '-i', '--model', 'moonshotai/kimi-k3', 'dossier content']);
  });

  it('should warn about unsupported flags instead of silently dropping them (headless)', () => {
    const result = buildLlmCommand('opencode', '/path/to/dossier.ds.md', true, {
      budget: 2,
      permissionMode: 'bypassPermissions',
      allowedTools: 'Bash Read',
    });
    expect(result).not.toBeNull();
    const r = result as NonNullable<typeof result>;
    expect(r.args).toEqual(['run', '--format', 'json']);
    const warnings = warnSpy.mock.calls.map((call) => String(call[0]));
    expect(warnings).toHaveLength(3);
    expect(warnings.some((w) => w.includes('--budget'))).toBe(true);
    expect(warnings.some((w) => w.includes('--permission-mode'))).toBe(true);
    expect(warnings.some((w) => w.includes('--allowed-tools'))).toBe(true);
  });

  it('should warn about unsupported flags in interactive mode too', () => {
    const result = buildLlmCommand('opencode', '/path/to/dossier.ds.md', false, {
      permissionMode: 'bypassPermissions',
    });
    expect(result).not.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('--permission-mode'));
  });
});

describe('findDossierFilesLocal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should find .ds.md files in directory', () => {
    mockedFs.readdirSync.mockReturnValue([
      { name: 'test.ds.md', isFile: () => true, isDirectory: () => false },
      { name: 'readme.md', isFile: () => true, isDirectory: () => false },
      { name: 'other.ds.md', isFile: () => true, isDirectory: () => false },
    ] as unknown as fs.Dirent[]);

    const files = findDossierFilesLocal('/test/dir');
    expect(files).toHaveLength(2);
    expect(files[0]).toContain('test.ds.md');
    expect(files[1]).toContain('other.ds.md');
  });

  it('should skip node_modules and hidden directories', () => {
    mockedFs.readdirSync.mockReturnValue([
      { name: 'node_modules', isFile: () => false, isDirectory: () => true },
      { name: '.git', isFile: () => false, isDirectory: () => true },
      { name: 'test.ds.md', isFile: () => true, isDirectory: () => false },
    ] as unknown as fs.Dirent[]);

    const files = findDossierFilesLocal('/test/dir', true);
    expect(files).toHaveLength(1);
  });

  it('should return empty array on read error', () => {
    mockedFs.readdirSync.mockImplementation(() => {
      throw new Error('EACCES');
    });

    expect(findDossierFilesLocal('/no/access')).toEqual([]);
  });
});

describe('printRegistryErrors', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('should print errors in indent style by default', () => {
    const errors = [
      { registry: 'main', error: 'Not found' },
      { registry: 'backup', error: 'Timeout' },
    ];

    printRegistryErrors(errors);

    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith('   main: Not found');
    expect(errorSpy).toHaveBeenCalledWith('   backup: Timeout');
  });

  it('should print errors in warning style', () => {
    const errors = [{ registry: 'cdn', error: 'Connection refused' }];

    printRegistryErrors(errors, 'warning');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("⚠️  Registry 'cdn': Connection refused");
  });

  it('should handle empty errors array', () => {
    printRegistryErrors([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('formatDossierFields', () => {
  it('should extract and format all fields', () => {
    const result = formatDossierFields({
      name: 'my-dossier',
      version: '1.0.0',
      title: 'My Dossier',
      category: ['dev', 'tools'],
      description: 'A test dossier',
    });

    expect(result).toEqual({
      name: 'my-dossier',
      version: '1.0.0',
      title: 'My Dossier',
      category: 'dev, tools',
      description: 'A test dossier',
    });
  });

  it('should default missing fields to empty strings', () => {
    const result = formatDossierFields({});

    expect(result).toEqual({
      name: '',
      version: '',
      title: '',
      category: '',
      description: '',
    });
  });

  it('should handle string category', () => {
    const result = formatDossierFields({ category: 'security' });
    expect(result.category).toBe('security');
  });

  it('should fall back to objective when description is missing', () => {
    const result = formatDossierFields({ objective: 'Do something useful' });
    expect(result.description).toBe('Do something useful');
  });
});

describe('logPaginationInfo', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('should not log when there is only one page', () => {
    logPaginationInfo(10, 1, 20);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('should log page info and next page hint when not on last page', () => {
    logPaginationInfo(50, 1, 20);

    expect(logSpy).toHaveBeenCalledWith('\nPage 1/3 (20 per page)');
    expect(logSpy).toHaveBeenCalledWith('Use --page 2 to see more results');
  });

  it('should not show next page hint on last page', () => {
    logPaginationInfo(50, 3, 20);

    expect(logSpy).toHaveBeenCalledWith('\nPage 3/3 (20 per page)');
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Use --page'));
  });
});
