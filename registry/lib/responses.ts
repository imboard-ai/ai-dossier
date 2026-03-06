import crypto from 'node:crypto';
import type { VercelResponse } from './types';

function formatAllowed(methods: string[]): string {
  if (methods.length === 1) return methods[0];
  if (methods.length === 2) return `${methods[0]} and ${methods[1]}`;
  return `${methods.slice(0, -1).join(', ')}, and ${methods[methods.length - 1]}`;
}

export function methodNotAllowed(res: VercelResponse, ...allowed: string[]): VercelResponse {
  return res.status(405).json({
    error: {
      code: 'METHOD_NOT_ALLOWED',
      message: `Only ${formatAllowed(allowed)} ${allowed.length === 1 ? 'is' : 'are'} allowed`,
    },
  });
}

export function serverError(
  res: VercelResponse,
  opts: { operation: string; error: unknown; code: string; message: string; status?: number }
): VercelResponse {
  const requestId = crypto.randomUUID();
  const errorMessage = opts.error instanceof Error ? opts.error.message : String(opts.error);
  console.error(
    JSON.stringify({
      level: 'error',
      operation: opts.operation,
      requestId,
      error: errorMessage,
      stack: opts.error instanceof Error ? opts.error.stack : undefined,
    })
  );
  return res.status(opts.status ?? 502).json({
    error: {
      code: opts.code,
      message: opts.message,
      request_id: requestId,
    },
  });
}
