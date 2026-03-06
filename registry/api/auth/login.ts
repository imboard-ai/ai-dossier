import config from '../../lib/config';
import type { VercelRequest, VercelResponse } from '../../lib/types';

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is allowed' },
    });
  }

  const params = new URLSearchParams({
    client_id: config.auth.github.clientId,
    redirect_uri: `${config.baseUrl}/auth/callback`,
    scope: config.auth.github.scopes,
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
}
