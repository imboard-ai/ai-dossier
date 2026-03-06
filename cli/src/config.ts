/**
 * Configuration management for Dossier CLI
 * Handles reading and writing user preferences to ~/.dossier/config.json
 * and multi-registry configuration.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface RegistryEntry {
  url: string;
  default?: boolean;
  readonly?: boolean;
}

export interface DossierConfig {
  defaultLlm: string;
  theme: string;
  auditLog: boolean;
  registries?: Record<string, RegistryEntry>;
  defaultRegistry?: string;
  [key: string]: unknown;
}

export interface ResolvedRegistry {
  name: string;
  url: string;
  readonly?: boolean;
}

const DEFAULT_REGISTRY_URL = 'https://dossier-registry.vercel.app';

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
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
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

/**
 * Load project-level .dossierrc.json by walking up from cwd.
 */
function loadProjectConfig(): DossierConfig | null {
  let dir = process.cwd();
  const root = path.parse(dir).root;

  while (dir !== root) {
    const rcFile = path.join(dir, '.dossierrc.json');
    if (fs.existsSync(rcFile)) {
      try {
        return JSON.parse(fs.readFileSync(rcFile, 'utf8'));
      } catch {
        console.error(`⚠️  Warning: Invalid .dossierrc.json at ${rcFile}`);
        return null;
      }
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Resolve all configured registries, merging user + project config.
 * Resolution priority:
 *   1. CLI --registry flag (handled by caller)
 *   2. DOSSIER_REGISTRY_URL env var → virtual "env" registry
 *   3. Project-level .dossierrc.json
 *   4. User-level ~/.dossier/config.json
 *   5. Hardcoded default (public registry)
 */
/**
 * Internal: resolve registries from pre-loaded configs (avoids redundant file reads).
 */
function resolveRegistriesFromConfig(
  userConfig: DossierConfig,
  projectConfig: DossierConfig | null
): ResolvedRegistry[] {
  // Merge registries: project overlays user (project wins on name conflicts)
  const merged: Record<string, RegistryEntry> = {};

  if (userConfig.registries) {
    for (const [name, entry] of Object.entries(userConfig.registries)) {
      merged[name] = entry;
    }
  }

  if (projectConfig?.registries) {
    for (const [name, entry] of Object.entries(projectConfig.registries)) {
      if (name in merged) {
        // Project config cannot override user-configured registries (credential exfiltration vector)
        continue;
      }
      merged[name] = entry;
    }
  }

  // DOSSIER_REGISTRY_URL env var creates a virtual "env" registry
  const envUrl = process.env.DOSSIER_REGISTRY_URL;
  if (envUrl) {
    merged.env = { url: envUrl };
  }

  // If no registries configured at all, use hardcoded default
  if (Object.keys(merged).length === 0) {
    return [{ name: 'public', url: DEFAULT_REGISTRY_URL }];
  }

  return Object.entries(merged).map(([name, entry]) => ({
    name,
    url: entry.url,
    readonly: entry.readonly,
  }));
}

function resolveRegistries(): ResolvedRegistry[] {
  return resolveRegistriesFromConfig(loadConfig(), loadProjectConfig());
}

/**
 * Resolve which single registry to use for write operations.
 * Priority: --registry flag > defaultRegistry (project > user) > first registry
 */
function resolveWriteRegistry(registryFlag?: string): ResolvedRegistry {
  const userConfig = loadConfig();
  const projectConfig = loadProjectConfig();
  const registries = resolveRegistriesFromConfig(userConfig, projectConfig);

  if (registryFlag) {
    const found = registries.find((r) => r.name === registryFlag);
    if (!found) {
      const names = registries.map((r) => r.name).join(', ');
      throw new Error(`Registry '${registryFlag}' not found. Available: ${names}`);
    }
    if (found.readonly) {
      throw new Error(`Registry '${registryFlag}' is read-only`);
    }
    return found;
  }

  const defaultName = projectConfig?.defaultRegistry || userConfig.defaultRegistry;

  if (defaultName) {
    const found = registries.find((r) => r.name === defaultName);
    if (found) {
      if (found.readonly) {
        throw new Error(`Default registry '${defaultName}' is read-only`);
      }
      return found;
    }
  }

  // Find first registry marked as default
  for (const reg of registries) {
    const allConfigs = { ...userConfig.registries, ...projectConfig?.registries };
    const entry = allConfigs[reg.name];
    if (entry?.default && !reg.readonly) {
      return reg;
    }
  }

  // Fall back to first non-readonly registry
  const writable = registries.find((r) => !r.readonly);
  if (writable) return writable;

  throw new Error('No writable registry configured. All registries are read-only.');
}

/**
 * Resolve a single registry by name (for auth commands).
 */
function resolveRegistryByName(name: string): ResolvedRegistry {
  const registries = resolveRegistries();
  const found = registries.find((r) => r.name === name);
  if (!found) {
    const names = registries.map((r) => r.name).join(', ');
    throw new Error(`Registry '${name}' not found. Available: ${names}`);
  }
  return found;
}

export {
  ensureConfigDir,
  loadConfig,
  saveConfig,
  getConfig,
  setConfig,
  loadProjectConfig,
  resolveRegistries,
  resolveWriteRegistry,
  resolveRegistryByName,
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  DEFAULT_REGISTRY_URL,
};
