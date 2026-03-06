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
