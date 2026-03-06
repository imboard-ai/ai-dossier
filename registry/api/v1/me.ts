import { authenticateRequest } from '../../lib/auth';
import { HTTP_STATUS } from '../../lib/constants';
import { handleCors } from '../../lib/cors';
import { methodNotAllowed } from '../../lib/responses';
import type { VercelRequest, VercelResponse } from '../../lib/types';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return;

  if (req.method !== 'GET') {
    return methodNotAllowed(res, 'GET');
  }

  const payload = await authenticateRequest(req, res);
  if (!payload) return;

  const username = payload.sub;
  const orgs = payload.orgs || [];
  const canPublishTo = [`${username}/*`, ...orgs.map((org) => `${org}/*`)];

  return res.status(HTTP_STATUS.OK).json({
    username,
    email: payload.email || null,
    orgs,
    can_publish_to: canPublishTo,
  });
}
