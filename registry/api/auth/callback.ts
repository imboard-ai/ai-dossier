import * as auth from '../../lib/auth';
import config from '../../lib/config';
import type { VercelRequest, VercelResponse } from '../../lib/types';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is allowed' },
    });
  }

  const { code, error, error_description } = req.query as Record<string, string>;

  if (error) {
    return res
      .status(400)
      .send(renderErrorPage('Authentication Failed', error_description || error));
  }

  if (!code) {
    return res
      .status(400)
      .send(
        renderErrorPage(
          'Missing Code',
          'No authorization code provided. Please try logging in again.'
        )
      );
  }

  try {
    console.log('[auth/callback] Exchanging OAuth code for access token');
    const accessToken = await auth.exchangeGitHubCode(code);

    console.log('[auth/callback] Fetching user info and orgs');
    const [user, orgs] = await Promise.all([
      auth.fetchGitHubUser(accessToken),
      auth.fetchGitHubOrgs(accessToken),
    ]);
    console.log(`[auth/callback] User: ${user.login}, orgs: [${orgs.join(', ')}]`);

    const jwtPayload = {
      sub: user.login,
      email: user.email || null,
      orgs,
    };
    const token = auth.signJwt(jwtPayload);

    const displayCode = auth.encodeAsDisplayCode(token);

    const clientId = config.auth.github.clientId;
    console.log(`[auth/callback] Login complete for ${user.login}`);
    return res.status(200).send(renderSuccessPage(user.login, orgs, displayCode, clientId));
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[auth/callback] OAuth callback failed:', error.message, error.stack);
    return res
      .status(500)
      .send(
        renderErrorPage(
          'Authentication Error',
          'Failed to complete authentication. Please try again.'
        )
      );
  }
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
  <style>
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
    }
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
    .org-hint {
      margin-top: 12px;
      font-size: 12px;
      color: #666;
    }
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
    .success-icon { font-size: 48px; margin-bottom: 16px; color: #28a745; }
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

function renderErrorPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dossier Login - Error</title>
  <style>
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
    }
    h1 { color: #dc3545; margin-bottom: 16px; font-size: 24px; }
    .message { color: #666; line-height: 1.6; }
    .error-icon { font-size: 48px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="error-icon">&#10060;</div>
    <h1>${escapeHtml(title)}</h1>
    <p class="message">${escapeHtml(message)}</p>
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
