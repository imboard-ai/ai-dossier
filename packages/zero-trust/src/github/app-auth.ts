/** GitHub App authentication for the trusted controller. Secrets come from the
 * operator's environment, stay in memory, and never reach run artifacts. */
import { createSign } from 'node:crypto';
import { inspect } from 'node:util';

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_API_VERSION = '2022-11-28';

export class GitHubAuthError extends Error {
  constructor() {
    super('GitHub App credentials unavailable or invalid');
    this.name = 'GitHubAuthError';
  }
}
export class GitHubTransportError extends Error {
  constructor() {
    super('GitHub request did not complete');
    this.name = 'GitHubTransportError';
  }
}

/** Opaque holder: secret fields are private, so serialization cannot reach them. */
export class AppCredentials {
  readonly #appId: string;
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #privateKey: string;
  constructor(input: {
    appId: string;
    clientId: string;
    clientSecret: string;
    privateKey: string;
  }) {
    const { appId, clientId, clientSecret, privateKey } = input;
    if (
      !/^[0-9]{1,20}$/u.test(appId) ||
      !/^[A-Za-z0-9._-]{1,64}$/u.test(clientId) ||
      typeof clientSecret !== 'string' ||
      !clientSecret ||
      typeof privateKey !== 'string' ||
      !privateKey.includes('PRIVATE KEY')
    )
      throw new GitHubAuthError();
    this.#appId = appId;
    this.#clientId = clientId;
    this.#clientSecret = clientSecret;
    this.#privateKey = privateKey;
  }
  get clientId(): string {
    return this.#clientId;
  }
  /** RS256 App JWT, valid 9 minutes with 60 s of clock-skew allowance. */
  appJwt(nowMs: number): string {
    const now = Math.floor(nowMs / 1000);
    const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const data = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: now - 60, exp: now + 540, iss: this.#appId })}`;
    try {
      return `${data}.${createSign('RSA-SHA256').update(data).sign(this.#privateKey, 'base64url')}`;
    } catch {
      throw new GitHubAuthError();
    }
  }
  clientAuthorization(): string {
    return `Basic ${Buffer.from(`${this.#clientId}:${this.#clientSecret}`).toString('base64')}`;
  }
  toJSON(): string {
    return '[AppCredentials redacted]';
  }
  [inspect.custom](): string {
    return '[AppCredentials redacted]';
  }
}

export const APP_CREDENTIAL_ENV = Object.freeze({
  appId: 'ZTFC_APP_ID',
  clientId: 'ZTFC_CLIENT_ID',
  clientSecret: 'ZTFC_CLIENT_SECRET',
  privateKey: 'ZTFC_PRIVATE_KEY',
} as const);

/** The operator's environment supplies the App secrets; nothing is read from disk. */
export function appCredentialsFromEnv(env: Readonly<Record<string, string | undefined>>) {
  const value = (name: string) => {
    const found = env[name];
    if (typeof found !== 'string' || !found.trim()) throw new GitHubAuthError();
    return found;
  };
  return new AppCredentials({
    appId: value(APP_CREDENTIAL_ENV.appId).trim(),
    clientId: value(APP_CREDENTIAL_ENV.clientId).trim(),
    clientSecret: value(APP_CREDENTIAL_ENV.clientSecret),
    privateKey: value(APP_CREDENTIAL_ENV.privateKey).replace(/\\n/gu, '\n'),
  });
}

export interface GitHubRequest {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  /** Full header value (`Bearer …` or `Basic …`); never logged. */
  readonly authorization: string;
  readonly body?: unknown;
}
export interface GitHubResponse {
  readonly status: number;
  readonly json: unknown;
}
/** Injected transport: tests replay recorded responses, never live GitHub. */
export type GitHubHttp = (request: GitHubRequest) => Promise<GitHubResponse>;

export function fetchGitHubHttp(base = GITHUB_API, fetchImpl: typeof fetch = fetch): GitHubHttp {
  return async (request) => {
    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(`${base}${request.path}`, {
        method: request.method,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          'User-Agent': 'ai-dossier-zero-trust-broker',
          Authorization: request.authorization,
          ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        redirect: 'error',
      });
      text = await response.text();
    } catch {
      // No cause chaining: a transport error may carry request details.
      throw new GitHubTransportError();
    }
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json };
  };
}

export const bearer = (token: string): string => `Bearer ${token}`;

export interface IssuedToken {
  readonly value: string;
  readonly expiresAt: string;
  readonly permissions: Readonly<Record<string, string>> | null;
  readonly repositoryIds: readonly number[] | null;
}
export type IssueResult =
  | { readonly kind: 'issued'; readonly token: IssuedToken }
  | { readonly kind: 'refused'; readonly status: number }
  | { readonly kind: 'malformed'; readonly status: number };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function issued(status: number, json: unknown, prefix: string): IssueResult {
  const body = record(json);
  const value = body?.token;
  const expiresAt = body?.expires_at;
  if (
    typeof value !== 'string' ||
    !value.startsWith(prefix) ||
    typeof expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(expiresAt))
  )
    return { kind: 'malformed', status };
  const permissions = record(record(body?.installation)?.permissions ?? body?.permissions);
  const repositories = body?.repositories;
  return {
    kind: 'issued',
    token: {
      value,
      expiresAt: new Date(Date.parse(expiresAt)).toISOString(),
      permissions: permissions
        ? Object.fromEntries(Object.entries(permissions).map(([k, v]) => [k, String(v)]))
        : null,
      repositoryIds: Array.isArray(repositories)
        ? repositories.map((repo) => Number(record(repo)?.id))
        : null,
    },
  };
}

/** `POST /app/installations/{id}/access_tokens` narrowed by repository id. */
export async function mintInstallationToken(
  http: GitHubHttp,
  app: AppCredentials,
  installationId: number,
  repositoryId: number,
  nowMs: number
): Promise<IssueResult> {
  const response = await http({
    method: 'POST',
    path: `/app/installations/${installationId}/access_tokens`,
    authorization: bearer(app.appJwt(nowMs)),
    body: { repository_ids: [repositoryId], permissions: { contents: 'write' } },
  });
  if (response.status !== 201) return { kind: 'refused', status: response.status };
  return issued(response.status, response.json, 'ghs_');
}

/** `POST /applications/{client_id}/token/scoped`: one level only, from an unscoped ghu. */
export async function scopeUserToken(
  http: GitHubHttp,
  app: AppCredentials,
  parent: string,
  target: string,
  repositoryId: number
): Promise<IssueResult> {
  const response = await http({
    method: 'POST',
    path: `/applications/${app.clientId}/token/scoped`,
    authorization: app.clientAuthorization(),
    body: {
      access_token: parent,
      target,
      repository_ids: [repositoryId],
      permissions: { contents: 'write' },
    },
  });
  if (response.status !== 200 && response.status !== 201)
    return { kind: 'refused', status: response.status };
  return issued(response.status, response.json, 'ghu_');
}

/** `DELETE /installation/token` (ghs) or `DELETE /applications/{client_id}/token` (ghu). */
export async function deleteToken(
  http: GitHubHttp,
  app: AppCredentials,
  kind: 'installation' | 'user',
  value: string
): Promise<number> {
  const response =
    kind === 'installation'
      ? await http({ method: 'DELETE', path: '/installation/token', authorization: bearer(value) })
      : await http({
          method: 'DELETE',
          path: `/applications/${app.clientId}/token`,
          authorization: app.clientAuthorization(),
          body: { access_token: value },
        });
  return response.status;
}

/** Cheap liveness read; GitHub answers 401 for a dead token. */
export async function probeToken(
  http: GitHubHttp,
  kind: 'installation' | 'user',
  value: string
): Promise<number> {
  const response = await http({
    method: 'GET',
    path: kind === 'installation' ? '/installation/repositories' : '/user',
    authorization: bearer(value),
  });
  return response.status;
}

/** `DELETE /applications/{client_id}/grant`: only a LIVE token from the grant works (else 404). */
export async function deleteGrant(
  http: GitHubHttp,
  app: AppCredentials,
  liveToken: string
): Promise<number> {
  const response = await http({
    method: 'DELETE',
    path: `/applications/${app.clientId}/grant`,
    authorization: app.clientAuthorization(),
    body: { access_token: liveToken },
  });
  return response.status;
}
