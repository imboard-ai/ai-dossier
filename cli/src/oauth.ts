/**
 * OAuth authentication flow for registry login.
 * Opens browser for GitHub authentication, prompts user for code,
 * decodes JWT token to extract user info.
 */

import { execFile } from 'node:child_process';
import readline from 'node:readline';

export interface OAuthResult {
  token: string;
  username: string;
  orgs: string[];
  email: string | null;
}

interface JwtPayload {
  sub: string;
  orgs?: string[];
  email?: string;
}

class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthError';
  }
}

/**
 * Decode a base64url-encoded string, adding padding if needed.
 */
function decodeBase64Url(data: string): string {
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
 */
function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }

  execFile(cmd, args, (_err) => {
    // Browser failed to open — URL is already printed for the user
  });
}

/**
 * Prompt the user for input via stdin.
 */
function prompt(question: string): Promise<string> {
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
 */
async function runOAuthFlow(registryUrl: string): Promise<OAuthResult> {
  const authUrl = `${registryUrl}/auth/login`;

  console.log(`\n🔐 Opening browser for GitHub authentication...`);
  console.log(`   If it doesn't open automatically, visit:\n   ${authUrl}\n`);

  openBrowser(authUrl);

  const code = (await prompt('Enter the code from your browser: ')).trim();

  if (!code) {
    throw new OAuthError('No code provided');
  }

  // The code is a base64url-encoded JWT
  let token: string;
  try {
    token = decodeBase64Url(code);
  } catch (err) {
    throw new OAuthError(`Invalid code format: ${(err as Error).message}`);
  }

  // Decode JWT payload (middle part) to get user info
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new OAuthError('Invalid token format');
  }

  let payload: JwtPayload;
  try {
    payload = JSON.parse(decodeBase64Url(parts[1]));
  } catch (err) {
    throw new OAuthError(`Invalid token: ${(err as Error).message}`);
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

export { OAuthError, runOAuthFlow };
