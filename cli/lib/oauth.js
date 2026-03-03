/**
 * OAuth authentication flow for registry login.
 * Opens browser for GitHub authentication, prompts user for code,
 * decodes JWT token to extract user info.
 */

const { exec } = require('node:child_process');
const readline = require('node:readline');

class OAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OAuthError';
  }
}

/**
 * Decode a base64url-encoded string, adding padding if needed.
 * @param {string} data - Base64url-encoded string
 * @returns {string} Decoded UTF-8 string
 */
function decodeBase64Url(data) {
  // Replace URL-safe chars with standard base64 chars
  let base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding
  const padding = 4 - (base64.length % 4);
  if (padding !== 4) {
    base64 += '='.repeat(padding);
  }
  return Buffer.from(base64, 'base64').toString('utf8');
}

/**
 * Open a URL in the user's default browser (platform-aware).
 * @param {string} url
 */
function openBrowser(url) {
  const platform = process.platform;
  let command;
  if (platform === 'darwin') {
    command = `open "${url}"`;
  } else if (platform === 'win32') {
    command = `start "" "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, (err) => {
    if (err) {
      // Browser failed to open — URL is already printed for the user
    }
  });
}

/**
 * Prompt the user for input via stdin.
 * @param {string} question - The prompt message
 * @returns {Promise<string>} User's input
 */
function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Run the OAuth flow using copy/paste method.
 * Opens a browser for GitHub authentication. The registry displays a code
 * that the user copies and pastes back into the CLI.
 *
 * @param {string} registryUrl - Base URL of the registry
 * @returns {Promise<{ token: string, username: string, orgs: string[], email: string|null }>}
 */
async function runOAuthFlow(registryUrl) {
  const authUrl = `${registryUrl}/auth/login`;

  console.log(`\n🔐 Opening browser for GitHub authentication...`);
  console.log(`   If it doesn't open automatically, visit:\n   ${authUrl}\n`);

  openBrowser(authUrl);

  const code = (await prompt('Enter the code from your browser: ')).trim();

  if (!code) {
    throw new OAuthError('No code provided');
  }

  // The code is a base64url-encoded JWT
  let token;
  try {
    token = decodeBase64Url(code);
  } catch (err) {
    throw new OAuthError(`Invalid code format: ${err.message}`);
  }

  // Decode JWT payload (middle part) to get user info
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new OAuthError('Invalid token format');
  }

  let payload;
  try {
    payload = JSON.parse(decodeBase64Url(parts[1]));
  } catch (err) {
    throw new OAuthError(`Invalid token: ${err.message}`);
  }

  const username = payload.sub;
  if (!username) {
    throw new OAuthError('Invalid token: missing username');
  }

  return {
    token,
    username,
    orgs: payload.orgs || [],
    email: payload.email || null,
  };
}

module.exports = {
  OAuthError,
  runOAuthFlow,
};
