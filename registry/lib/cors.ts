import { HTTP_STATUS } from './constants';
import createLogger from './logger';
import type { VercelRequest, VercelResponse } from './types';

const log = createLogger('cors');

const DEFAULT_ALLOWED_ORIGINS = ['https://dossier.imboard.ai', 'https://registry.dossier.dev'];

function getAllowedOrigins(): string[] {
  const envOrigins = process.env.CORS_ALLOWED_ORIGINS;
  if (envOrigins) {
    const raw = envOrigins.split(',').map((o) => o.trim());
    const filtered = raw.filter(Boolean);
    if (filtered.length < raw.length) {
      log.warn('CORS_ALLOWED_ORIGINS contains empty entries — filtered out', {
        raw: raw.length,
        filtered: filtered.length,
      });
    }
    return filtered;
  }
  return DEFAULT_ALLOWED_ORIGINS;
}

/**
 * Sets CORS response headers based on the request origin.
 * If the origin is in the allowlist, reflects it in Access-Control-Allow-Origin.
 * Unknown origins receive no Allow-Origin header but still get the allowed methods/headers
 * so preflight responses are well-formed.
 */
export function setCorsHeaders(
  req: VercelRequest,
  res: VercelResponse,
  allowedOrigins?: string[]
): void {
  const origin = req.headers.origin;
  const allowed = allowedOrigins ?? getAllowedOrigins();

  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS, HEAD');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
    res.setHeader('Vary', 'Origin');
  } else if (origin) {
    log.warn('Rejected origin', { origin });
  }
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Handles CORS preflight and enforces origin-based CSRF protection.
 *
 * Returns `true` if the request was fully handled (preflight 204, or blocked 403)
 * and the caller should stop processing. Returns `false` if the request should
 * continue to the main handler.
 *
 * Security model:
 * - OPTIONS preflight: responds 204 with CORS headers, always handled.
 * - GET/HEAD: allowed from any origin (read-only, no CSRF risk).
 * - POST/PUT/PATCH/DELETE from an unknown origin: blocked with 403 ORIGIN_NOT_ALLOWED.
 * - No Origin header (non-browser clients like curl/CLI): allowed through,
 *   since CSRF is a browser-only attack vector.
 */
export function handleCors(req: VercelRequest, res: VercelResponse): boolean {
  const allowedOrigins = getAllowedOrigins();
  setCorsHeaders(req, res, allowedOrigins);

  if (req.method === 'OPTIONS') {
    res.status(HTTP_STATUS.NO_CONTENT).end();
    return true;
  }

  // CSRF protection: reject mutating requests from unknown browser origins.
  // GET/HEAD are read-only so they pass regardless of origin. Requests without
  // an Origin header come from non-browser clients (curl, CLI) which are not
  // susceptible to CSRF, so they are also allowed through.
  const origin = req.headers.origin;
  if (origin && MUTATING_METHODS.has(req.method ?? '') && !allowedOrigins.includes(origin)) {
    log.warn('Blocked mutating request from disallowed origin', { method: req.method, origin });
    res.status(HTTP_STATUS.FORBIDDEN).json({
      error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin not allowed for mutating requests' },
    });
    return true;
  }

  return false;
}
