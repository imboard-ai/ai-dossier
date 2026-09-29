import jwt from 'jsonwebtoken';
import config from './config';
import { HTTP_STATUS, JWT_EXPIRY_SECONDS, USER_AGENT } from './constants';
import createLogger from './logger';
import { canPublishTo } from './permissions';
import type { JwtPayload, VercelRequest, VercelResponse } from './types';

const log = createLogger('auth');

export function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, config.auth.jwt.secret, {
    expiresIn: JWT_EXPIRY_SECONDS,
  });
}

/**
 * Authenticate a request: extract Bearer token, verify JWT, return payload.
 * Returns null and sends the error response if authentication fails.
 */
export async function authenticateRequest(
  req: VercelRequest,
  res: VercelResponse
): Promise<JwtPayload | null> {
  const token = extractBearerToken(req);
  if (!token) {
    log.warn('Missing token', { event: 'auth.missing_token', method: req.method, url: req.url });
    res.status(HTTP_STATUS.UNAUTHORIZED).json({
      error: {
        code: 'MISSING_TOKEN',
        message: 'Authorization header required. Use: Bearer <token>',
      },
    });
    return null;
  }

  try {
    return verifyJwt(token);
  } catch (err) {
    const code =
      err instanceof Error && err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
    log.warn(code === 'TOKEN_EXPIRED' ? 'Token expired' : 'Invalid token', {
      event: `auth.${code.toLowerCase()}`,
      method: req.method,
      url: req.url,
    });
    if (code === 'TOKEN_EXPIRED') {
      res.status(HTTP_STATUS.UNAUTHORIZED).json({
        error: { code, message: 'Token has expired. Please login again.' },
      });
    } else {
      res.status(HTTP_STATUS.UNAUTHORIZED).json({
        error: { code, message: 'Invalid token. Please login again.' },
      });
    }
    return null;
  }
}

export function verifyJwt(token: string): JwtPayload {
  return jwt.verify(token, config.auth.jwt.secret, {
    algorithms: ['HS256'],
  }) as JwtPayload;
}

export function extractBearerToken(req: VercelRequest): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice('Bearer '.length);
}

export function encodeAsDisplayCode(token: string): string {
  return Buffer.from(token).toString('base64url');
}

export function decodeDisplayCode(code: string): string {
  return Buffer.from(code, 'base64url').toString('utf-8');
}

export async function exchangeGitHubCode(code: string): Promise<string> {
  const response = await fetch(config.auth.github.tokenUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: config.auth.github.clientId,
      client_secret: config.auth.github.clientSecret,
      code,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => 'unknown error');
    throw new Error(
      `GitHub OAuth token exchange failed: ${response.status} ${response.statusText} — ${body}`
    );
  }

  const data = (await response.json()) as {
    error?: string;
    error_description?: string;
    access_token: string;
  };

  if (data.error) {
    throw new Error(`GitHub OAuth error: ${data.error_description || data.error}`);
  }

  return data.access_token;
}

export async function fetchGitHubUser(
  accessToken: string
): Promise<{ login: string; email: string | null }> {
  const response = await fetch(`${config.auth.github.apiUrl}/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `GitHub API error fetching user: ${response.status} ${response.statusText} — ${body}`
    );
  }

  return (await response.json()) as { login: string; email: string | null };
}

/**
 * Authenticate + check publish/delete permission for a namespace.
 * Sends 401/403 error responses directly. Returns the verified JWT payload if authorized,
 * or null (response already sent). The payload's `sub` is the publisher's GitHub login — the
 * only trusted source for who published; never take it from request input.
 */
export async function authorizePublish(
  req: VercelRequest,
  res: VercelResponse,
  namespace: string,
  action: 'publish' | 'delete' = 'publish'
): Promise<JwtPayload | null> {
  const jwtPayload = await authenticateRequest(req, res);
  if (!jwtPayload) return null;

  const permission = canPublishTo(jwtPayload, namespace);
  if (!permission.allowed) {
    log.warn('Forbidden', {
      event: 'auth.forbidden',
      user: jwtPayload.sub,
      namespace,
      reason: permission.reason,
    });
    const verb = action === 'delete' ? 'delete from' : 'publish to';
    res.status(HTTP_STATUS.FORBIDDEN).json({
      error: {
        code: 'FORBIDDEN',
        message: `Cannot ${verb} namespace '${namespace}'`,
        namespace,
      },
    });
    return null;
  }

  return jwtPayload;
}

export async function fetchGitHubOrgs(accessToken: string): Promise<string[]> {
  const response = await fetch(`${config.auth.github.apiUrl}/user/orgs`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `GitHub API error fetching orgs: ${response.status} ${response.statusText} — ${body}`
    );
  }

  const orgs = (await response.json()) as Array<{ login: string }>;
  return orgs.map((org) => org.login);
}
