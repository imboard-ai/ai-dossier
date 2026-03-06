import jwt from 'jsonwebtoken';
import config from './config';
import { JWT_EXPIRY_SECONDS, USER_AGENT } from './constants';
import { canPublishTo } from './permissions';
import type { JwtPayload, VercelRequest, VercelResponse } from './types';

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
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'auth.missing_token',
        method: req.method,
        url: req.url,
      })
    );
    res.status(401).json({
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
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: `auth.${code.toLowerCase()}`,
        method: req.method,
        url: req.url,
      })
    );
    if (code === 'TOKEN_EXPIRED') {
      res.status(401).json({
        error: { code, message: 'Token has expired. Please login again.' },
      });
    } else {
      res.status(401).json({
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
 * Sends 401/403 error responses directly. Returns true if authorized.
 */
export async function authorizePublish(
  req: VercelRequest,
  res: VercelResponse,
  namespace: string
): Promise<boolean> {
  const jwtPayload = await authenticateRequest(req, res);
  if (!jwtPayload) return false;

  const permission = canPublishTo(jwtPayload, namespace);
  if (!permission.allowed) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'auth.forbidden',
        user: jwtPayload.sub,
        namespace,
        reason: permission.reason,
      })
    );
    res.status(403).json({
      error: { code: 'FORBIDDEN', message: permission.reason },
    });
    return false;
  }

  return true;
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
