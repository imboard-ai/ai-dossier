import crypto from 'node:crypto';
import { HTTP_STATUS } from './constants';
import createLogger from './logger';
import type { VercelRequest, VercelResponse } from './types';

const log = createLogger('responses');

function formatAllowed(methods: string[]): string {
  if (methods.length === 1) return methods[0];
  if (methods.length === 2) return `${methods[0]} and ${methods[1]}`;
  return `${methods.slice(0, -1).join(', ')}, and ${methods[methods.length - 1]}`;
}

const VALID_REQUEST_ID = /^[a-zA-Z0-9-]{1,64}$/;

/** Extracts the request ID from the x-request-id header, or generates a new UUID if absent. */
export function getRequestId(req: VercelRequest): string {
  const header = req.headers['x-request-id'];
  const existing = Array.isArray(header) ? header[0] : header;
  if (existing && VALID_REQUEST_ID.test(existing)) return existing;
  const generated = crypto.randomUUID();
  if (existing) {
    log.warn('Rejected invalid X-Request-Id', { provided: existing, generated });
  }
  return generated;
}

/** Returns a 405 Method Not Allowed response listing the permitted HTTP methods. */
export function methodNotAllowed(
  req: VercelRequest,
  res: VercelResponse,
  ...allowed: string[]
): VercelResponse {
  log.warn('method-not-allowed', {
    method: req.method,
    path: req.url?.split('?')[0],
    allowed,
  });
  return res.status(HTTP_STATUS.METHOD_NOT_ALLOWED).json({
    error: {
      code: 'METHOD_NOT_ALLOWED',
      message: `Only ${formatAllowed(allowed)} ${allowed.length === 1 ? 'is' : 'are'} allowed`,
    },
  });
}

/** Returns a 400 response for path traversal attempts, with a warning log. */
export function invalidPathError(
  res: VercelResponse,
  requestId: string,
  identifier: string
): VercelResponse {
  log.warn('Path traversal detected', { requestId, identifier });
  return res.status(HTTP_STATUS.BAD_REQUEST).json({
    error: { code: 'INVALID_PATH', message: 'Path traversal is not allowed' },
  });
}

/** Returns a structured JSON error response with logging, request tracing, and a configurable status code (defaults to 502). */
export function serverError(
  res: VercelResponse,
  opts: {
    operation: string;
    error: unknown;
    code: string;
    message: string;
    status?: number;
    requestId?: string;
    context?: Record<string, unknown>;
  }
): VercelResponse {
  const requestId = opts.requestId || crypto.randomUUID();
  const errorMessage = opts.error instanceof Error ? opts.error.message : String(opts.error);
  const errorType = opts.error instanceof Error ? opts.error.name : typeof opts.error;
  log.error(opts.operation, {
    requestId,
    errorType,
    error: errorMessage,
    stack: opts.error instanceof Error ? opts.error.stack : undefined,
    ...opts.context,
  });
  return res.status(opts.status ?? HTTP_STATUS.BAD_GATEWAY).json({
    error: {
      code: opts.code,
      message: opts.message,
      request_id: requestId,
    },
  });
}
