/**
 * Credential storage for Dossier registry authentication.
 * Stores credentials at ~/.dossier/credentials.json with secure file permissions.
 */

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config';

export interface Credentials {
  token: string;
  username: string;
  orgs: string[];
  expiresAt: string | null;
}

const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials.json');

/**
 * Ensure the config directory exists.
 */
function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Save credentials to file with secure permissions (0600).
 */
function saveCredentials(credentials: Credentials): void {
  ensureConfigDir();
  const data = {
    token: credentials.token,
    username: credentials.username,
    orgs: credentials.orgs || [],
    expires_at: credentials.expiresAt || null,
  };
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Load credentials from file.
 */
function loadCredentials(): Credentials | null {
  if (!fs.existsSync(CREDENTIALS_FILE)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data.token || !data.username) {
      return null;
    }
    return {
      token: data.token,
      username: data.username,
      orgs: data.orgs || [],
      expiresAt: data.expires_at || null,
    };
  } catch {
    return null;
  }
}

/**
 * Delete the credentials file.
 */
function deleteCredentials(): boolean {
  if (fs.existsSync(CREDENTIALS_FILE)) {
    fs.unlinkSync(CREDENTIALS_FILE);
    return true;
  }
  return false;
}

/**
 * Check if credentials are expired.
 */
function isExpired(credentials: Pick<Credentials, 'expiresAt'>): boolean {
  if (!credentials.expiresAt) {
    return false;
  }
  try {
    const expires = new Date(credentials.expiresAt);
    return Date.now() > expires.getTime();
  } catch {
    return false;
  }
}

export { CREDENTIALS_FILE, saveCredentials, loadCredentials, deleteCredentials, isExpired };
