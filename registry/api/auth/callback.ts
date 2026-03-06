import crypto from 'node:crypto';
import * as auth from '../../lib/auth';
import config from '../../lib/config';
import { HTTP_STATUS, OAUTH_STATE_COOKIE } from '../../lib/constants';
import createLogger from '../../lib/logger';
import { methodNotAllowed } from '../../lib/responses';
import type { VercelRequest, VercelResponse } from '../../lib/types';

const log = createLogger('auth/callback');

function parseCookie(req: VercelRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const match = header.split(';').find((c) => c.trim().startsWith(`${name}=`));
  return match ? match.split('=')[1]?.trim() : undefined;
}

function validateOAuthState(
  req: VercelRequest,
  res: VercelResponse,
  state: string | undefined
): boolean {
  const expectedState = parseCookie(req, OAUTH_STATE_COOKIE);

  // Clear the state cookie regardless of outcome
  res.setHeader(
    'Set-Cookie',
    `${OAUTH_STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=0`
  );

  const valid =
    state &&
    expectedState &&
    state.length === expectedState.length &&
    crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expectedState));

  if (!valid) {
    log.warn('State validation failed', {
      reason: !state
        ? 'missing query state'
        : !expectedState
          ? 'missing cookie state'
          : 'state mismatch',
    });
    res
      .status(HTTP_STATUS.FORBIDDEN)
      .send(
        renderErrorPage(
          'Invalid State',
          'OAuth state mismatch — possible CSRF attack. Please try logging in again.'
        )
      );
  }

  return !!valid;
}

function queryString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function exchangeCodeAndRenderSuccess(res: VercelResponse, code: string): Promise<void> {
  log.info('Exchanging OAuth code for access token');
  const accessToken = await auth.exchangeGitHubCode(code);

  log.info('Fetching user info and orgs');
  const [user, orgs] = await Promise.all([
    auth.fetchGitHubUser(accessToken),
    auth.fetchGitHubOrgs(accessToken),
  ]);
  log.info('User authenticated', { user: user.login, orgs });

  const token = auth.signJwt({ sub: user.login, email: user.email || null, orgs });
  const displayCode = auth.encodeAsDisplayCode(token);
  const clientId = config.auth.github.clientId;

  log.info('Login complete', { user: user.login });
  res.status(HTTP_STATUS.OK).send(renderSuccessPage(user.login, orgs, displayCode, clientId));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, 'GET');
  }

  const code = queryString(req.query.code);
  const error = queryString(req.query.error);
  const errorDescription = queryString(req.query.error_description);
  const state = queryString(req.query.state);

  if (error) {
    log.warn('OAuth provider error', { error, errorDescription });
    return res
      .status(HTTP_STATUS.BAD_REQUEST)
      .send(renderErrorPage('Authentication Failed', errorDescription || error));
  }

  if (!validateOAuthState(req, res, state)) {
    return;
  }

  if (!code) {
    log.warn('Missing authorization code in callback');
    return res
      .status(HTTP_STATUS.BAD_REQUEST)
      .send(
        renderErrorPage(
          'Missing Code',
          'No authorization code provided. Please try logging in again.'
        )
      );
  }

  try {
    await exchangeCodeAndRenderSuccess(res, code);
  } catch (err) {
    const caughtError = err instanceof Error ? err : new Error(String(err));
    const errorRef = crypto.randomBytes(4).toString('hex');
    log.error(`OAuth callback failed (ref=${errorRef})`, {
      error: caughtError.message,
      stack: caughtError.stack,
    });
    return res
      .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
      .send(
        renderErrorPage(
          'Authentication Error',
          'Failed to complete authentication. Please try again.',
          errorRef
        )
      );
  }
}

function basePageStyles(): string {
  return `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.1);
      padding: 40px;
      max-width: 500px;
      width: 100%;
      text-align: center;
    }`;
}

function successPageStyles(): string {
  return `
    h1 { color: #1a1a1a; margin-bottom: 8px; font-size: 24px; }
    .subtitle { color: #666; margin-bottom: 16px; }
    .orgs-section { margin-bottom: 20px; }
    .orgs-label { font-size: 12px; color: #999; text-transform: uppercase; margin-bottom: 8px; }
    .orgs-list { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
    .org-badge {
      background: #e1f5fe;
      color: #0277bd;
      padding: 4px 12px;
      border-radius: 16px;
      font-size: 13px;
    }
    .no-orgs { color: #999; font-size: 13px; font-style: italic; }
    .org-hint { margin-top: 12px; font-size: 12px; color: #666; }
    .org-hint a { color: #007bff; text-decoration: none; }
    .org-hint a:hover { text-decoration: underline; }
    .code-box {
      background: #f8f9fa;
      border: 2px dashed #ddd;
      border-radius: 8px;
      padding: 20px;
      margin: 20px 0;
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 12px;
      word-break: break-all;
      cursor: pointer;
      transition: border-color 0.2s;
      max-height: 150px;
      overflow-y: auto;
    }
    .code-box:hover { border-color: #007bff; }
    .instructions { color: #666; font-size: 14px; line-height: 1.6; }
    .copy-btn {
      background: #007bff;
      color: white;
      border: none;
      padding: 12px 24px;
      border-radius: 6px;
      font-size: 16px;
      cursor: pointer;
      margin-top: 16px;
    }
    .copy-btn:hover { background: #0056b3; }
    .success-icon { font-size: 48px; margin-bottom: 16px; color: #28a745; }`;
}

function renderSuccessPage(
  username: string,
  orgs: string[],
  code: string,
  clientId: string
): string {
  const orgsHtml =
    orgs.length > 0
      ? `<div class="orgs-list">${orgs.map((org) => `<span class="org-badge">${escapeHtml(org)}</span>`).join(' ')}</div>`
      : '<div class="orgs-list"><span class="no-orgs">No organizations detected</span></div>';

  const grantUrl = `https://github.com/settings/connections/applications/${escapeHtml(clientId)}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dossier Login - Success</title>
  <style>${basePageStyles()}${successPageStyles()}
  </style>
</head>
<body>
  <div class="container">
    <div class="success-icon">&#10004;</div>
    <h1>Welcome, ${escapeHtml(username)}!</h1>
    <p class="subtitle">Copy this code back to your terminal</p>

    <div class="orgs-section">
      <div class="orgs-label">Organizations</div>
      ${orgsHtml}
      <p class="org-hint">
        Missing an org? <a href="${grantUrl}" target="_blank">Grant organization access</a>
      </p>
    </div>

    <div class="code-box" id="code" onclick="copyCode()">
      ${escapeHtml(code)}
    </div>

    <button class="copy-btn" onclick="copyCode()">Copy Code</button>

    <p class="instructions">
      Paste this code in your terminal when prompted.<br>
      You can close this window after copying.
    </p>
  </div>

  <script>
    function copyCode() {
      const code = document.getElementById('code').textContent.trim();
      navigator.clipboard.writeText(code).then(() => {
        document.querySelector('.copy-btn').textContent = 'Copied!';
        setTimeout(() => {
          document.querySelector('.copy-btn').textContent = 'Copy Code';
        }, 2000);
      });
    }
  </script>
</body>
</html>`;
}

function renderErrorPage(title: string, message: string, errorRef?: string): string {
  const refHtml = errorRef ? `<p class="error-ref">Reference: ${escapeHtml(errorRef)}</p>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dossier Login - Error</title>
  <style>${basePageStyles()}
    h1 { color: #dc3545; margin-bottom: 16px; font-size: 24px; }
    .message { color: #666; line-height: 1.6; }
    .error-icon { font-size: 48px; margin-bottom: 16px; }
    .error-ref { color: #999; font-size: 12px; margin-top: 16px; font-family: monospace; }
  </style>
</head>
<body>
  <div class="container">
    <div class="error-icon">&#10060;</div>
    <h1>${escapeHtml(title)}</h1>
    <p class="message">${escapeHtml(message)}</p>
    ${refHtml}
  </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return String(text).replace(/[&<>"']/g, (c) => map[c]);
}
