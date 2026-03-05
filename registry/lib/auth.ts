import jwt from 'jsonwebtoken';
import config from './config';
import type { JwtPayload, VercelRequest } from './types';

export function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, config.auth.jwt.secret, {
    expiresIn: 7 * 24 * 60 * 60, // 7 days in seconds
  });
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
      'User-Agent': 'Dossier-Registry',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }

  return (await response.json()) as { login: string; email: string | null };
}

export async function fetchGitHubOrgs(accessToken: string): Promise<string[]> {
  const response = await fetch(`${config.auth.github.apiUrl}/user/orgs`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'Dossier-Registry',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const orgs = (await response.json()) as Array<{ login: string }>;
  return orgs.map((org) => org.login);
}
