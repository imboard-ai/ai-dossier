import config from '../../lib/config';
import { HTTP_STATUS } from '../../lib/constants';
import { handleCors } from '../../lib/cors';
import type { VercelRequest, VercelResponse } from '../../lib/types';

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (handleCors(req, res)) return;

  res.status(HTTP_STATUS.OK).json({
    status: 'OK',
    service: 'Dossier Registry API',
    version: config.apiVersion,
  });
}
