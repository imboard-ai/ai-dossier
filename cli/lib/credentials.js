/**
 * Credential storage for Dossier registry authentication.
 * Stores credentials at ~/.dossier/credentials.json with secure file permissions.
 */

const fs = require('node:fs');
const path = require('node:path');
const { CONFIG_DIR } = require('./config');

const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials.json');

/**
 * Ensure the config directory exists.
 */
function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Save credentials to file with secure permissions (0600).
 * @param {{ token: string, username: string, orgs: string[], expiresAt?: string }} credentials
 */
function saveCredentials(credentials) {
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
 * @returns {{ token: string, username: string, orgs: string[], expiresAt: string|null } | null}
 */
function loadCredentials() {
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
 * @returns {boolean} True if deleted, false if it didn't exist.
 */
function deleteCredentials() {
  if (fs.existsSync(CREDENTIALS_FILE)) {
    fs.unlinkSync(CREDENTIALS_FILE);
    return true;
  }
  return false;
}

/**
 * Check if credentials are expired.
 * @param {{ expiresAt: string|null }} credentials
 * @returns {boolean}
 */
function isExpired(credentials) {
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

module.exports = {
  CREDENTIALS_FILE,
  saveCredentials,
  loadCredentials,
  deleteCredentials,
  isExpired,
};
