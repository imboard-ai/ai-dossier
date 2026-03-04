/**
 * Claude Code hook integration for Dossier CLI.
 * Manages the UserPromptSubmit hook that triggers automatic dossier discovery.
 */

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

export {
  DOSSIER_HOOK_ID,
  DOSSIER_HOOK_COMMAND,
  DOSSIER_HOOK_PATTERN,
  CLAUDE_SETTINGS_FILE,
  DOSSIER_LIST_CACHE_FILE,
  CACHE_TTL_MS,
  installClaudeHook,
  removeClaudeHook,
  matchesHookPattern,
  getCachedDossierList,
  saveDossierListCache,
};
