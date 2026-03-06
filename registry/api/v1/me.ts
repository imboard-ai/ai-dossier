import * as auth from '../../lib/auth';
import { handleCors } from '../../lib/cors';
import type { VercelRequest, VercelResponse } from '../../lib/types';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is allowed' },
    });
  }

  const authResult = auth.authenticateRequest(req);
  if (!authResult.ok) {
    return res.status(authResult.status).json({ error: authResult.error });
  }
  const { payload } = authResult;

  const username = payload.sub;
  const orgs = payload.orgs || [];

  const canPublishTo = [`${username}/*`, ...orgs.map((org) => `${org}/*`)];

  return res.status(200).json({
    username,
    email: payload.email || null,
    orgs,
    can_publish_to: canPublishTo,
  });
}
