import config from '../../lib/config';
import { handleCors } from '../../lib/cors';
import type { VercelRequest, VercelResponse } from '../../lib/types';

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return;

  res.status(200).json({
    status: 'OK',
    service: 'Dossier Registry API',
    version: config.apiVersion,
  });
}
