/**
 * Claude Code hook integration for Dossier CLI.
 * Manages the UserPromptSubmit hook that triggers automatic dossier discovery,
 * and MCP server configuration for Claude Code.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR } from './config';

export interface DossierEntry {
  name: string;
  title: string;
}

interface ClaudeHookEntry {
  type: string;
  command: string;
  id?: string;
  hooks?: ClaudeHookEntry[];
  [key: string]: unknown;
}

interface ClaudeSettings {
  hooks?: {
    UserPromptSubmit?: ClaudeHookEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const DOSSIER_HOOK_ID = 'dossier-discovery-hook';
const DOSSIER_HOOK_COMMAND = 'dossier prompt-hook';

const DOSSIER_HOOK_PATTERN =
  /\b(workflow|setup|deploy|migrate|refactor|ci\/?cd|pipeline|create\s+(script|automation|process)|sync\s+worktree|onboard|initialize|configure)\b/i;

const CLAUDE_SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const DOSSIER_LIST_CACHE_FILE = path.join(CONFIG_DIR, 'dossier-list-cache.json');
const CACHE_TTL_MS = 300_000; // 5 minutes

/**
 * Install the Dossier discovery hook into Claude Code settings.
 * Returns true if newly installed, false if already present.
 */
function installClaudeHook(): boolean {
  let settings: ClaudeSettings = {};

  // Ensure ~/.claude/ directory exists
  const claudeDir = path.dirname(CLAUDE_SETTINGS_FILE);
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
  }

  // Read existing settings
  if (fs.existsSync(CLAUDE_SETTINGS_FILE)) {
    try {
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_FILE, 'utf8'));
    } catch {
      settings = {};
    }
  }

  // Ensure hooks.UserPromptSubmit exists
  if (!settings.hooks) {
    settings.hooks = {};
  }
  if (!Array.isArray(settings.hooks.UserPromptSubmit)) {
    settings.hooks.UserPromptSubmit = [];
  }

  const hooks = settings.hooks.UserPromptSubmit;

  // Check if already installed (by id, by command string, or nested hooks format)
  const matchesHook = (h: ClaudeHookEntry): boolean => {
    if (h.id === DOSSIER_HOOK_ID || h.command === DOSSIER_HOOK_COMMAND) return true;
    // Handle nested format: { hooks: [{ type, command }] }
    if (Array.isArray(h.hooks)) {
      return h.hooks.some((inner) => inner.command === DOSSIER_HOOK_COMMAND);
    }
    return false;
  };
  const alreadyInstalled = hooks.some(matchesHook);

  if (alreadyInstalled) {
    return false;
  }

  // Install the hook
  hooks.push({
    type: 'command',
    command: DOSSIER_HOOK_COMMAND,
    id: DOSSIER_HOOK_ID,
  });

  fs.writeFileSync(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  return true;
}

/**
 * Remove the Dossier discovery hook from Claude Code settings.
 * Returns true if found and removed, false if not found.
 */
function removeClaudeHook(): boolean {
  if (!fs.existsSync(CLAUDE_SETTINGS_FILE)) {
    return false;
  }

  let settings: ClaudeSettings;
  try {
    settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_FILE, 'utf8'));
  } catch {
    return false;
  }

  const hooks = settings.hooks?.UserPromptSubmit;
  if (!Array.isArray(hooks)) {
    return false;
  }

  const originalLength = hooks.length;
  const matchesHook = (h: ClaudeHookEntry): boolean => {
    if (h.id === DOSSIER_HOOK_ID || h.command === DOSSIER_HOOK_COMMAND) return true;
    if (Array.isArray(h.hooks)) {
      return h.hooks.some((inner) => inner.command === DOSSIER_HOOK_COMMAND);
    }
    return false;
  };
  const filteredHooks = hooks.filter((h) => !matchesHook(h));
  settings.hooks = { ...settings.hooks, UserPromptSubmit: filteredHooks };

  if (filteredHooks.length === originalLength) {
    return false;
  }

  fs.writeFileSync(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  return true;
}

/**
 * Test whether a user prompt matches the dossier discovery pattern.
 */
function matchesHookPattern(prompt: string): boolean {
  return DOSSIER_HOOK_PATTERN.test(prompt);
}

interface CacheData {
  timestamp: number;
  dossiers: DossierEntry[];
}

/**
 * Return cached dossier list if fresh (< 5 minutes), null otherwise.
 */
function getCachedDossierList(): DossierEntry[] | null {
  if (!fs.existsSync(DOSSIER_LIST_CACHE_FILE)) {
    return null;
  }

  try {
    const data: CacheData = JSON.parse(fs.readFileSync(DOSSIER_LIST_CACHE_FILE, 'utf8'));
    if (Date.now() - data.timestamp < CACHE_TTL_MS) {
      return data.dossiers;
    }
  } catch {
    // Corrupt cache — treat as miss
  }

  return null;
}

/**
 * Write dossier list to cache file.
 */
function saveDossierListCache(dossiers: DossierEntry[]): void {
  try {
    const data: CacheData = { timestamp: Date.now(), dossiers };
    fs.writeFileSync(DOSSIER_LIST_CACHE_FILE, JSON.stringify(data), 'utf8');
  } catch {
    // Best-effort caching — ignore write errors
  }
}

// ─── MCP Server Configuration ───────────────────────────────────────────────

const CLAUDE_MCP_CONFIG_FILE = path.join(os.homedir(), '.claude', 'mcp.json');
const MCP_SERVER_NAME = 'dossier';
const MCP_SERVER_PACKAGE = '@ai-dossier/mcp-server';

interface McpServerEntry {
  command: string;
  args: string[];
  [key: string]: unknown;
}

interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

/**
 * Check whether the `claude` CLI is available on PATH.
 */
function isClaudeCliAvailable(): boolean {
  try {
    execFileSync('which', ['claude'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the dossier MCP server is already configured.
 * Checks both `claude mcp list` output (if CLI available) and the JSON config file.
 */
function isMcpServerConfigured(): boolean {
  // Check JSON config file
  if (fs.existsSync(CLAUDE_MCP_CONFIG_FILE)) {
    try {
      const config: McpConfig = JSON.parse(fs.readFileSync(CLAUDE_MCP_CONFIG_FILE, 'utf8'));
      if (config.mcpServers?.[MCP_SERVER_NAME]) {
        return true;
      }
    } catch {
      // Corrupted file — continue to check other methods
    }
  }

  return false;
}

/**
 * Configure the dossier MCP server for Claude Code.
 *
 * Strategy:
 * 1. If `claude` CLI is on PATH, use `claude mcp add` (canonical approach)
 * 2. Otherwise, fall back to writing ~/.claude/mcp.json directly
 *
 * Returns 'installed' | 'already' | 'error'
 */
function installMcpServer(): 'installed' | 'already' | 'error' {
  if (isMcpServerConfigured()) {
    return 'already';
  }

  // Try claude CLI first
  if (isClaudeCliAvailable()) {
    try {
      execFileSync(
        'claude',
        ['mcp', 'add', MCP_SERVER_NAME, '--scope', 'user', '--', 'npx', MCP_SERVER_PACKAGE],
        { stdio: 'pipe' }
      );
      return 'installed';
    } catch {
      // CLI approach failed — fall back to JSON config
    }
  }

  // Fall back to writing JSON config
  try {
    return installMcpServerViaJson();
  } catch {
    return 'error';
  }
}

/**
 * Write the MCP server config directly to ~/.claude/mcp.json.
 * Merges safely with existing config.
 */
function installMcpServerViaJson(): 'installed' | 'already' {
  let config: McpConfig = {};

  const claudeDir = path.dirname(CLAUDE_MCP_CONFIG_FILE);
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
  }

  if (fs.existsSync(CLAUDE_MCP_CONFIG_FILE)) {
    try {
      config = JSON.parse(fs.readFileSync(CLAUDE_MCP_CONFIG_FILE, 'utf8'));
    } catch {
      config = {};
    }
  }

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  if (config.mcpServers[MCP_SERVER_NAME]) {
    return 'already';
  }

  config.mcpServers[MCP_SERVER_NAME] = {
    command: 'npx',
    args: [MCP_SERVER_PACKAGE],
  };

  fs.writeFileSync(CLAUDE_MCP_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  return 'installed';
}

export {
  DOSSIER_HOOK_ID,
  DOSSIER_HOOK_COMMAND,
  DOSSIER_HOOK_PATTERN,
  CLAUDE_SETTINGS_FILE,
  CLAUDE_MCP_CONFIG_FILE,
  MCP_SERVER_NAME,
  MCP_SERVER_PACKAGE,
  DOSSIER_LIST_CACHE_FILE,
  CACHE_TTL_MS,
  installClaudeHook,
  removeClaudeHook,
  matchesHookPattern,
  getCachedDossierList,
  saveDossierListCache,
  isClaudeCliAvailable,
  isMcpServerConfigured,
  installMcpServer,
  installMcpServerViaJson,
};
