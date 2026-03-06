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
  } else if (origin) {
    console.warn(`[cors] Rejected origin: ${origin}`);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function handleCors(req: VercelRequest, res: VercelResponse): boolean {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }

  // Reject mutating requests from disallowed origins (CSRF protection).
  // GET/HEAD allowed from any origin (read-only). No Origin header allowed (non-browser clients).
  const origin = req.headers.origin;
  if (origin && MUTATING_METHODS.has(req.method ?? '') && !getAllowedOrigins().includes(origin)) {
    console.warn(`[cors] Blocked mutating ${req.method} from origin: ${origin}`);
    res.status(403).json({
      error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin not allowed for mutating requests' },
    });
    return true;
  }

  return false;
}
