/**
 * Configuration management for Dossier CLI
 * Handles reading and writing user preferences to ~/.dossier/config.json
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface DossierConfig {
  defaultLlm: string;
  theme: string;
  auditLog: boolean;
  [key: string]: unknown;
}

const CONFIG_DIR = path.join(os.homedir(), '.dossier');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: DossierConfig = {
  defaultLlm: 'auto',
  theme: 'auto',
  auditLog: true,
};

/**
 * Ensure config directory exists
 */
function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Load configuration from file
 */
function loadConfig(): DossierConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return { ...DEFAULT_CONFIG };
    }

    const configData = fs.readFileSync(CONFIG_FILE, 'utf8');
    const config = JSON.parse(configData);

    // Merge with defaults to ensure all keys exist
    return { ...DEFAULT_CONFIG, ...config };
  } catch (_error) {
    console.error('⚠️  Warning: Could not read config file, using defaults');
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Save configuration to file
 */
function saveConfig(config: DossierConfig): boolean {
  try {
    ensureConfigDir();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('❌ Error: Could not save config file:', (error as Error).message);
    return false;
  }
}

/**
 * Get a specific config value
 */
function getConfig(key: string): unknown {
  const config = loadConfig();
  return config[key];
}

/**
 * Set a specific config value
 */
function setConfig(key: string, value: unknown): boolean {
  const config = loadConfig();
  config[key] = value;
  return saveConfig(config);
}

export {
  ensureConfigDir,
  loadConfig,
  saveConfig,
  getConfig,
  setConfig,
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_CONFIG,
};
