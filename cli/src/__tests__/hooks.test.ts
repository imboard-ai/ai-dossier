import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs');
vi.mock('node:child_process');

const mockedFs = vi.mocked(fs);
const mockedExecFileSync = vi.mocked(execFileSync);

import {
  CACHE_TTL_MS,
  CLAUDE_MCP_CONFIG_FILE,
  CLAUDE_SETTINGS_FILE,
  DOSSIER_HOOK_COMMAND,
  DOSSIER_HOOK_ID,
  DOSSIER_LIST_CACHE_FILE,
  getCachedDossierList,
  installClaudeHook,
  installMcpServer,
  installMcpServerViaJson,
  isClaudeCliAvailable,
  isMcpServerConfigured,
  MCP_SERVER_NAME,
  MCP_SERVER_PACKAGE,
  matchesHookPattern,
  removeClaudeHook,
  saveDossierListCache,
} from '../hooks';

describe('hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFs.existsSync.mockReturnValue(false);
  });

  describe('matchesHookPattern', () => {
    it.each([
      'help me setup the project',
      'deploy to production',
      'migrate the database',
      'refactor the auth module',
      'create script for testing',
      'configure the CI/CD pipeline',
      'onboard new developer',
      'initialize the project',
      'sync worktree changes',
      'setup pipeline for deployment',
    ])('should match: "%s"', (prompt) => {
      expect(matchesHookPattern(prompt)).toBe(true);
    });

    it.each([
      'hello world',
      'fix the bug',
      'add a button',
      'what is typescript',
      'review this PR',
    ])('should not match: "%s"', (prompt) => {
      expect(matchesHookPattern(prompt)).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(matchesHookPattern('DEPLOY to staging')).toBe(true);
      expect(matchesHookPattern('Setup the project')).toBe(true);
    });
  });

  describe('installClaudeHook', () => {
    it('should create settings file and install hook when no file exists', () => {
      mockedFs.existsSync.mockReturnValue(false);

      const result = installClaudeHook();

      expect(result).toBe(true);
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        CLAUDE_SETTINGS_FILE,
        expect.stringContaining(DOSSIER_HOOK_ID),
        'utf8'
      );
    });

    it('should return false if hook is already installed by id', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [{ type: 'command', command: 'other', id: DOSSIER_HOOK_ID }],
          },
        })
      );

      expect(installClaudeHook()).toBe(false);
    });

    it('should return false if hook is already installed by command', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [{ type: 'command', command: DOSSIER_HOOK_COMMAND }],
          },
        })
      );

      expect(installClaudeHook()).toBe(false);
    });

    it('should add hook to existing settings without UserPromptSubmit', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ someOther: true }));

      const result = installClaudeHook();
      expect(result).toBe(true);

      const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
      const written = JSON.parse(writtenJson);
      expect(written.hooks.UserPromptSubmit).toHaveLength(1);
      expect(written.hooks.UserPromptSubmit[0].id).toBe(DOSSIER_HOOK_ID);
    });

    it('should handle corrupted settings file', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('not json');

      const result = installClaudeHook();
      expect(result).toBe(true);
    });

    it('should detect hook in nested hooks format', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              { type: 'wrapper', hooks: [{ type: 'command', command: DOSSIER_HOOK_COMMAND }] },
            ],
          },
        })
      );

      expect(installClaudeHook()).toBe(false);
    });
  });

  describe('removeClaudeHook', () => {
    it('should return false if settings file does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(removeClaudeHook()).toBe(false);
    });

    it('should return false if no UserPromptSubmit hooks', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ hooks: {} }));

      expect(removeClaudeHook()).toBe(false);
    });

    it('should remove hook by id and return true', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              { type: 'command', command: 'other-hook' },
              { type: 'command', command: DOSSIER_HOOK_COMMAND, id: DOSSIER_HOOK_ID },
            ],
          },
        })
      );

      expect(removeClaudeHook()).toBe(true);
      const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
      const written = JSON.parse(writtenJson);
      expect(written.hooks.UserPromptSubmit).toHaveLength(1);
      expect(written.hooks.UserPromptSubmit[0].command).toBe('other-hook');
    });

    it('should return false if hook not found in list', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [{ type: 'command', command: 'other-hook' }],
          },
        })
      );

      expect(removeClaudeHook()).toBe(false);
    });

    it('should handle corrupted settings file', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('bad json');

      expect(removeClaudeHook()).toBe(false);
    });
  });

  describe('getCachedDossierList', () => {
    it('should return null when cache file does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(getCachedDossierList()).toBeNull();
    });

    it('should return dossiers when cache is fresh', () => {
      const dossiers = [{ name: 'test', title: 'Test' }];
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ timestamp: Date.now(), dossiers }));

      expect(getCachedDossierList()).toEqual(dossiers);
    });

    it('should return null when cache is stale', () => {
      const dossiers = [{ name: 'test', title: 'Test' }];
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ timestamp: Date.now() - CACHE_TTL_MS - 1000, dossiers })
      );

      expect(getCachedDossierList()).toBeNull();
    });

    it('should return null on corrupted cache', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('bad json');

      expect(getCachedDossierList()).toBeNull();
    });
  });

  describe('saveDossierListCache', () => {
    it('should write cache to file', () => {
      const dossiers = [{ name: 'test', title: 'Test' }];
      saveDossierListCache(dossiers);

      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        DOSSIER_LIST_CACHE_FILE,
        expect.stringContaining('"name":"test"'),
        'utf8'
      );
    });

    it('should silently ignore write errors', () => {
      mockedFs.writeFileSync.mockImplementation(() => {
        throw new Error('EACCES');
      });

      expect(() => saveDossierListCache([])).not.toThrow();
    });
  });

  // ─── MCP Server Configuration ─────────────────────────────────────────────

  describe('isClaudeCliAvailable', () => {
    it('should return true when claude is on PATH', () => {
      mockedExecFileSync.mockReturnValue(Buffer.from('/usr/bin/claude'));
      expect(isClaudeCliAvailable()).toBe(true);
      expect(mockedExecFileSync).toHaveBeenCalledWith('which', ['claude'], { stdio: 'pipe' });
    });

    it('should return false when claude is not on PATH', () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('not found');
      });
      expect(isClaudeCliAvailable()).toBe(false);
    });
  });

  describe('isMcpServerConfigured', () => {
    it('should return false when mcp.json does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(isMcpServerConfigured()).toBe(false);
    });

    it('should return true when dossier entry exists in mcp.json', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({
          mcpServers: {
            [MCP_SERVER_NAME]: { command: 'npx', args: [MCP_SERVER_PACKAGE] },
          },
        })
      );
      expect(isMcpServerConfigured()).toBe(true);
    });

    it('should return false when mcp.json has other servers but not dossier', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({
          mcpServers: {
            'other-server': { command: 'npx', args: ['other-pkg'] },
          },
        })
      );
      expect(isMcpServerConfigured()).toBe(false);
    });

    it('should return false on corrupted mcp.json', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('not json');
      expect(isMcpServerConfigured()).toBe(false);
    });
  });

  describe('installMcpServerViaJson', () => {
    beforeEach(() => {
      mockedFs.writeFileSync.mockReset();
      mockedFs.mkdirSync.mockReset();
    });

    it('should create mcp.json with dossier entry when no file exists', () => {
      mockedFs.existsSync.mockReturnValue(false);

      const result = installMcpServerViaJson();

      expect(result).toBe('installed');
      expect(mockedFs.mkdirSync).toHaveBeenCalled();
      const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
      const written = JSON.parse(writtenJson);
      expect(written.mcpServers[MCP_SERVER_NAME]).toEqual({
        command: 'npx',
        args: [MCP_SERVER_PACKAGE],
      });
    });

    it('should merge into existing mcp.json without overwriting other servers', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({
          mcpServers: {
            context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'] },
          },
        })
      );

      const result = installMcpServerViaJson();

      expect(result).toBe('installed');
      const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
      const written = JSON.parse(writtenJson);
      expect(written.mcpServers.context7).toBeDefined();
      expect(written.mcpServers[MCP_SERVER_NAME]).toEqual({
        command: 'npx',
        args: [MCP_SERVER_PACKAGE],
      });
    });

    it('should return already when dossier entry exists', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({
          mcpServers: {
            [MCP_SERVER_NAME]: { command: 'npx', args: [MCP_SERVER_PACKAGE] },
          },
        })
      );

      expect(installMcpServerViaJson()).toBe('already');
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should handle corrupted mcp.json by starting fresh', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('bad json');

      const result = installMcpServerViaJson();

      expect(result).toBe('installed');
      const writtenJson = mockedFs.writeFileSync.mock.calls[0][1] as string;
      const written = JSON.parse(writtenJson);
      expect(written.mcpServers[MCP_SERVER_NAME]).toBeDefined();
    });
  });

  describe('installMcpServer', () => {
    beforeEach(() => {
      mockedFs.writeFileSync.mockReset();
      mockedFs.mkdirSync.mockReset();
      mockedExecFileSync.mockReset();
    });

    it('should return already when server is already configured', () => {
      // isMcpServerConfigured reads mcp.json
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({
          mcpServers: { [MCP_SERVER_NAME]: { command: 'npx', args: [MCP_SERVER_PACKAGE] } },
        })
      );

      expect(installMcpServer()).toBe('already');
    });

    it('should use claude CLI when available', () => {
      // isMcpServerConfigured: mcp.json does not exist
      mockedFs.existsSync.mockReturnValue(false);
      // isClaudeCliAvailable: which claude succeeds
      // claude mcp add: succeeds
      mockedExecFileSync.mockReturnValue(Buffer.from(''));

      const result = installMcpServer();

      expect(result).toBe('installed');
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'claude',
        ['mcp', 'add', MCP_SERVER_NAME, '--scope', 'user', '--', 'npx', MCP_SERVER_PACKAGE],
        { stdio: 'pipe' }
      );
    });

    it('should fall back to JSON when claude CLI fails', () => {
      mockedFs.existsSync.mockReturnValue(false);
      // which claude succeeds, but claude mcp add fails
      let callCount = 0;
      mockedExecFileSync.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Buffer.from('/usr/bin/claude'); // which claude
        throw new Error('claude mcp add failed'); // claude mcp add
      });

      const result = installMcpServer();

      expect(result).toBe('installed');
      // Should have written mcp.json as fallback
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        CLAUDE_MCP_CONFIG_FILE,
        expect.stringContaining(MCP_SERVER_PACKAGE),
        'utf8'
      );
    });

    it('should fall back to JSON when claude CLI is not available', () => {
      mockedFs.existsSync.mockReturnValue(false);
      // which claude fails
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('not found');
      });

      const result = installMcpServer();

      expect(result).toBe('installed');
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        CLAUDE_MCP_CONFIG_FILE,
        expect.stringContaining(MCP_SERVER_PACKAGE),
        'utf8'
      );
    });

    it('should return error when both CLI and JSON fail', () => {
      mockedFs.existsSync.mockReturnValue(false);
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('not found');
      });
      mockedFs.writeFileSync.mockImplementation(() => {
        throw new Error('EACCES');
      });

      const result = installMcpServer();

      expect(result).toBe('error');
    });
  });
});
