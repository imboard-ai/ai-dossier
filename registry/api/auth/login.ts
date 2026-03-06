import crypto from 'node:crypto';
import config from '../../lib/config';
import { OAUTH_STATE_COOKIE, OAUTH_STATE_MAX_AGE } from '../../lib/constants';
import { methodNotAllowed } from '../../lib/responses';
import type { VercelRequest, VercelResponse } from '../../lib/types';

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, 'GET');
  }

  try {
    const state = crypto.randomBytes(32).toString('hex');

    const params = new URLSearchParams({
      client_id: config.auth.github.clientId,
      redirect_uri: `${config.baseUrl}/auth/callback`,
      scope: config.auth.github.scopes,
      state,
    });

    res.setHeader(
      'Set-Cookie',
      `${OAUTH_STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=${OAUTH_STATE_MAX_AGE}`
    );

    console.log(`[auth/login] Redirecting to GitHub OAuth`);
    res.redirect(`https://github.com/login/oauth/authorize?${params}`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const errorRef = crypto.randomBytes(4).toString('hex');
    console.error(
      `[auth/login] Failed to initiate login redirect (ref=${errorRef}):`,
      error.message,
      error.stack
    );
    return res.status(500).json({
      error: {
        code: 'LOGIN_ERROR',
        message: 'Failed to initiate login. Please try again.',
        ref: errorRef,
      },
    });
  }
}
