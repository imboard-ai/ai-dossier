/**
 * Credential storage for Dossier registry authentication.
 * Stores per-registry credentials at ~/.dossier/credentials.json with secure file permissions (0600).
 * Auto-migrates old flat format to keyed-by-registry format.
 *
 * Security model:
 * - **HTTPS enforcement**: Registry URLs must use HTTPS (enforced in config.ts when adding
 *   registries) so credentials are never sent over plain HTTP.
 * - **Per-registry isolation**: Each registry has its own credential entry. A compromised
 *   registry token cannot be used to authenticate against other registries.
 * - **Environment variable override**: DOSSIER_REGISTRY_TOKEN creates a virtual "env"
 *   credential entry for CI/CD contexts; it is never persisted to disk.
 */

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, ensureConfigDir } from './config';

export interface Credentials {
  token: string;
  username: string;
  orgs: string[];
  expiresAt: string | null;
}

type CredentialsStore = Record<string, Credentials>;

const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials.json');

/**
 * Read and parse the credentials file, returning the raw JSON.
 */
function readCredentialsFile(): Record<string, unknown> | null {
  if (!fs.existsSync(CREDENTIALS_FILE)) {
    return null;
  }
  try {
    // Verify file permissions haven't been loosened
    const stats = fs.statSync(CREDENTIALS_FILE);
    const otherPerms = stats.mode & 0o077;
    if (otherPerms !== 0) {
      console.error(
        `⚠️  Warning: ${CREDENTIALS_FILE} has insecure permissions (${(stats.mode & 0o777).toString(8)}). ` +
          `Expected 0600. Credentials may have been compromised. Fixing permissions.`
      );
      fs.chmodSync(CREDENTIALS_FILE, 0o600);
    }
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  } catch (error) {
    console.error(
      `⚠️  Warning: Could not parse credentials file ${CREDENTIALS_FILE} (${(error as Error).message})`
    );
    return null;
  }
}

/**
 * Detect whether the credentials file uses old flat format.
 * Old format has `token` and `username` at the top level.
 */
function isOldFormat(data: Record<string, unknown>): boolean {
  return typeof data.token === 'string' && typeof data.username === 'string';
}

/**
 * Load the full credentials store, auto-migrating old format if needed.
 */
function loadCredentialsStore(): CredentialsStore {
  // Check env var first — creates virtual credentials for "env" registry
  const envToken = process.env.DOSSIER_REGISTRY_TOKEN;

  const raw = readCredentialsFile();
  const store: CredentialsStore = {};

  if (raw) {
    if (isOldFormat(raw)) {
      // Auto-migrate: flat → keyed by "public"
      store.public = {
        token: raw.token as string,
        username: raw.username as string,
        orgs: (raw.orgs as string[]) || [],
        expiresAt: (raw.expires_at as string) || null,
      };
      // Write back migrated format
      saveCredentialsStore(store);
    } else {
      // New format: each key is a registry name
      for (const [name, value] of Object.entries(raw)) {
        const entry = value as Record<string, unknown>;
        if (entry && typeof entry.token === 'string' && typeof entry.username === 'string') {
          store[name] = {
            token: entry.token,
            username: entry.username,
            orgs: (entry.orgs as string[]) || [],
            expiresAt: (entry.expires_at as string) || (entry.expiresAt as string) || null,
          };
        }
      }
    }
  }

  if (envToken) {
    store.env = {
      token: envToken,
      username: process.env.DOSSIER_REGISTRY_USER || 'token-auth',
      orgs: process.env.DOSSIER_REGISTRY_ORGS ? process.env.DOSSIER_REGISTRY_ORGS.split(',') : [],
      expiresAt: null,
    };
  }

  return store;
}

/**
 * Save the full credentials store to file.
 */
function saveCredentialsStore(store: CredentialsStore): void {
  ensureConfigDir();
  const data: Record<string, unknown> = {};
  for (const [name, creds] of Object.entries(store)) {
    if (name === 'env') continue; // Don't persist env-var credentials
    data[name] = {
      token: creds.token,
      username: creds.username,
      orgs: creds.orgs || [],
      expires_at: creds.expiresAt || null,
    };
  }
  try {
    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch (error) {
    throw new Error(
      `Failed to save credentials to ${CREDENTIALS_FILE}: ${(error as Error).message}`
    );
  }
}

/**
 * Save credentials for a specific registry.
 */
function saveCredentials(credentials: Credentials, registryName = 'public'): void {
  const store = loadCredentialsStore();
  store[registryName] = credentials;
  saveCredentialsStore(store);
}

/**
 * Load credentials for a specific registry.
 * Falls back to "public" for backward compatibility.
 */
function loadCredentials(registryName = 'public'): Credentials | null {
  const store = loadCredentialsStore();
  return store[registryName] || null;
}

/**
 * Delete credentials for a specific registry, or all if no name given.
 */
function deleteCredentials(registryName?: string): boolean {
  if (!registryName) {
    // Delete entire file (backward compat)
    if (fs.existsSync(CREDENTIALS_FILE)) {
      fs.unlinkSync(CREDENTIALS_FILE);
      return true;
    }
    return false;
  }

  const store = loadCredentialsStore();
  if (!(registryName in store)) {
    return false;
  }
  delete store[registryName];
  saveCredentialsStore(store);
  return true;
}

/**
 * Check if credentials are expired.
 */
function isExpired(credentials: Pick<Credentials, 'expiresAt'>): boolean {
  if (!credentials.expiresAt) {
    return false;
  }
  const expires = new Date(credentials.expiresAt);
  if (Number.isNaN(expires.getTime())) {
    return true;
  }
  return Date.now() > expires.getTime();
}

/**
 * List all registries that have stored credentials.
 */
function listCredentialRegistries(): string[] {
  const store = loadCredentialsStore();
  return Object.keys(store);
}

export {
  CREDENTIALS_FILE,
  saveCredentials,
  loadCredentials,
  deleteCredentials,
  isExpired,
  listCredentialRegistries,
};
