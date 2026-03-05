import type { VercelRequest, VercelResponse } from './types';

const DEFAULT_ALLOWED_ORIGINS = ['https://dossier.imboard.ai', 'https://registry.dossier.dev'];

function getAllowedOrigins(): string[] {
  const envOrigins = process.env.CORS_ALLOWED_ORIGINS;
  if (envOrigins) {
    return envOrigins.split(',').map((o) => o.trim());
  }
  return DEFAULT_ALLOWED_ORIGINS;
}

export function setCorsHeaders(req: VercelRequest, res: VercelResponse): void {
  const origin = req.headers.origin;
  const allowed = getAllowedOrigins();

  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
}

export function handleCors(req: VercelRequest, res: VercelResponse): boolean {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }

  return false;
}
