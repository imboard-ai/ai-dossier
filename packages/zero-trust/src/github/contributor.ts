/** Contributor authorization (#1065, PRD §5.1 `contributor`, §5.9). The GitHub App user
 * authorization web flow with a loopback redirect and a checked `state`, the login binding,
 * refresh rotation, and the installation reads that need a credential.
 *
 * Credential module, controller-only: the access token goes only to the broker (#1064); the
 * refresh token lives in this object's private memory. Neither, nor the authorization code,
 * is ever persisted, logged or returned. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { inspect } from 'node:util';
import { isRecord, ReasonCode, type RunRecord, transitionRun } from '../state';
import {
  type AppCredentials,
  bearer,
  deleteToken,
  type GitHubHttp,
  type GitHubResponse,
  type OAuthHttp,
  TOKEN_FORMAT,
  USER_TOKEN_PREFIX,
} from './app-auth';
import { CredentialBrokerError, type ForkCredentialBroker } from './broker';
import type { InstallationSource, InstallationSummary } from './fork';
import { isGitHubLogin } from './handoff';

export const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
/** GitHub authorization codes expire after ten minutes. */
export const AUTHORIZATION_WINDOW_MS = 10 * 60 * 1000;
const REFRESH_FORMAT = /^ghr_[A-Za-z0-9_]{20,255}$/u;
const PAGE_SIZE = 100;
const MAX_REPOSITORY_PAGES = 10;

export const CONTRIBUTOR_REFUSALS = Object.freeze([
  'invalid_redirect',
  'no_pending_authorization',
  'authorization_expired',
  'authorization_denied',
  'state_mismatch',
  'invalid_callback',
  'exchange_failed',
] as const);
export type ContributorRefusal = (typeof CONTRIBUTOR_REFUSALS)[number];

/** Fixed message: never echoes the callback, the code, or a token. */
export class ContributorAuthError extends Error {
  constructor(readonly code: ContributorRefusal) {
    super(`Contributor authorization refused: ${code}`);
    this.name = 'ContributorAuthError';
  }
}

/** Query values from the loopback redirect; untrusted. */
export interface CallbackParams {
  readonly code?: string;
  readonly state?: string;
  readonly error?: string;
}

export type LoginOutcome =
  | { readonly kind: 'bound'; readonly login: string; readonly userId: number }
  /** Scenario 17: another account authorized. Its token was revoked with the run's grant. */
  | {
      readonly kind: 'blocked';
      readonly reason: 'contributor_mismatch';
      readonly run: RunRecord;
      readonly nextPermittedAction: string;
    }
  | { readonly kind: 'reauthorize'; readonly nextPermittedAction: string }
  | { readonly kind: 'unknown'; readonly nextPermittedAction: string };

export type RefreshOutcome =
  | { readonly kind: 'refreshed'; readonly tokenId: string }
  /** The chain is dead (revoked, rotated away or `bad_refresh_token`): authorize again. */
  | { readonly kind: 'reauthorize'; readonly nextPermittedAction: string }
  /** No answer from GitHub; the stored refresh token is unchanged. Never retried here. */
  | { readonly kind: 'unavailable' };

export interface AuthorizationStatus {
  readonly authorization: 'authorized' | 'reauthorization_required' | 'not_authorized';
  readonly nextPermittedAction: string;
}

export interface ContributorOptions {
  readonly app: AppCredentials;
  /** API transport (`https://api.github.com`). */
  readonly http: GitHubHttp;
  /** Token endpoint transport (`https://github.com/login/oauth/access_token`). */
  readonly oauth: OAuthHttp;
  /** Built with the fork binding `checkForkReadiness` returned. */
  readonly broker: ForkCredentialBroker;
  /** The run's recorded contributor login. */
  readonly contributor: string;
  readonly appSlug: string;
  readonly now?: () => number;
}

/** A loopback redirect only (RFC 8252 §7.3): http, an IP literal, an explicit port. */
export function isLoopbackRedirect(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === '[::1]') &&
    url.port !== '' &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    url.href === value
  );
}

const base64url = (bytes: Buffer) => bytes.toString('base64url');

interface Pending {
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly expiresAt: number;
}

interface IssuedPair {
  readonly access: string;
  readonly refresh: string;
  readonly expiresAt: string;
}

const REDACTED = '[ContributorAuthorization redacted]';

export class ContributorAuthorization {
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read and consumed in complete()
  #pending: Pending | undefined;
  /** The current refresh token; replaced in one assignment once the broker holds its pair. */
  #refresh: string | undefined;
  #refreshing: Promise<RefreshOutcome> | undefined;
  #boundUserId: number | undefined;
  private readonly now: () => number;

  constructor(private readonly options: ContributorOptions) {
    if (!isGitHubLogin(options.contributor) || !/^[a-z0-9-]{1,100}$/u.test(options.appSlug))
      throw new ContributorAuthError('invalid_callback');
    this.now = options.now ?? Date.now;
  }

  /** Starts the web flow: a fresh CSPRNG `state` and PKCE verifier, kept in memory only.
   * Returns the page the contributor opens; a newer `begin` replaces an older one. */
  begin(redirectUri: string): { readonly url: string; readonly expiresAt: string } {
    if (!isLoopbackRedirect(redirectUri)) throw new ContributorAuthError('invalid_redirect');
    const state = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const expiresAt = this.now() + AUTHORIZATION_WINDOW_MS;
    this.#pending = { state, verifier, redirectUri, expiresAt };
    const query = new URLSearchParams({
      client_id: this.options.app.clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      // Suggests the run's account on GitHub's sign-in page; the binding is still checked.
      login: this.options.contributor,
      allow_signup: 'false',
    });
    return Object.freeze({
      url: `${AUTHORIZE_URL}?${query}`,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  /** Finishes the web flow: the `state` must match (single use), then the code is exchanged,
   * the access token handed to the broker, and the run bound to the authenticated login. */
  async complete(
    callback: CallbackParams,
    run: RunRecord,
    boundUserId?: number
  ): Promise<LoginOutcome> {
    const pending = this.#pending;
    // Single use, whatever happens next: a replayed or second callback finds nothing.
    this.#pending = undefined;
    if (!pending) throw new ContributorAuthError('no_pending_authorization');
    if (this.now() >= pending.expiresAt) throw new ContributorAuthError('authorization_expired');
    if (!isRecord(callback)) throw new ContributorAuthError('invalid_callback');
    const { code, state, error } = callback;
    if (typeof state !== 'string' || !sameSecret(state, pending.state))
      throw new ContributorAuthError('state_mismatch');
    if (error !== undefined) throw new ContributorAuthError('authorization_denied');
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/u.test(code))
      throw new ContributorAuthError('invalid_callback');
    const pair = await this.exchange({
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
    });
    if (pair === 'bad_refresh_token' || pair === 'unavailable')
      throw new ContributorAuthError('exchange_failed');
    await this.hold(pair, (value, expiresAt) =>
      this.options.broker.registerUserToken(value, expiresAt)
    );
    return this.bindLogin(run, boundUserId);
  }

  /** Scenario 17: binds (or, on resume, re-checks) the run to `GET /user`. A login, or a
   * recorded user id, other than the run's blocks the run and revokes the token. */
  async bindLogin(run: RunRecord, boundUserId?: number): Promise<LoginOutcome> {
    let response: GitHubResponse;
    try {
      response = await this.options.broker.readAsContributor('/user');
    } catch (error) {
      if (error instanceof CredentialBrokerError) return this.reauthorize();
      return this.unknown();
    }
    if (response.status === 401) return this.reauthorize();
    const body = isRecord(response.json) ? response.json : null;
    const login = body?.login;
    const userId = body?.id;
    if (
      response.status !== 200 ||
      !isGitHubLogin(login) ||
      !Number.isSafeInteger(userId) ||
      (userId as number) <= 0
    )
      return this.unknown();
    const expectedId = boundUserId ?? this.#boundUserId;
    if (
      login.toLowerCase() !== run.contributor.toLowerCase() ||
      login.toLowerCase() !== this.options.contributor.toLowerCase() ||
      (expectedId !== undefined && expectedId !== userId)
    ) {
      const blocked = transitionRun(
        run,
        ReasonCode.PolicyBlocked,
        new Date(this.now()).toISOString()
      );
      this.#refresh = undefined;
      // The other account's authorization ends now: revoking its token kills its chain.
      await this.options.broker.endRun('cancelled');
      return {
        kind: 'blocked',
        reason: 'contributor_mismatch',
        run: blocked,
        nextPermittedAction:
          `GitHub authenticated a different account than this run's contributor ` +
          `(${run.contributor}). Its authorization was revoked. Start a new run as the ` +
          'account that owns the fork.',
      };
    }
    this.#boundUserId = userId as number;
    return Object.freeze({ kind: 'bound', login, userId: userId as number });
  }

  /** Rotates the user token with the stored refresh token, once at a time. A dead chain
   * (revoked, or `bad_refresh_token`) answers `reauthorize` and is never tried again. */
  refresh(): Promise<RefreshOutcome> {
    this.#refreshing ??= this.rotate().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  private async rotate(): Promise<RefreshOutcome> {
    // Revoking the user token killed its refresh token: never present the dead one.
    if (!this.chainUsable()) {
      this.#refresh = undefined;
      return this.reauthorize();
    }
    const pair = await this.exchange({
      grant_type: 'refresh_token',
      refresh_token: this.#refresh as string,
    });
    if (pair === 'unavailable') return { kind: 'unavailable' };
    if (pair === 'bad_refresh_token') {
      this.#refresh = undefined;
      return this.reauthorize();
    }
    try {
      const tokenId = await this.hold(pair, (value, expiresAt) =>
        this.options.broker.rotateUserToken(value, expiresAt)
      );
      return { kind: 'refreshed', tokenId };
    } catch (error) {
      if (!(error instanceof CredentialBrokerError)) throw error;
      return this.reauthorize();
    }
  }

  /** The broker holds the new access token BEFORE the refresh token is replaced, so the
   * stored pair is never half-updated. A token the broker refuses is revoked at once. */
  private async hold(
    pair: IssuedPair,
    register: (value: string, expiresAt: string) => string | Promise<string>
  ): Promise<string> {
    let tokenId: string;
    try {
      tokenId = await register(pair.access, pair.expiresAt);
    } catch (error) {
      this.#refresh = undefined;
      await deleteToken(this.options.http, this.options.app, 'user', pair.access).catch(
        () => undefined
      );
      throw error;
    }
    this.#refresh = pair.refresh;
    return tokenId;
  }

  private chainUsable(): boolean {
    if (this.#refresh === undefined) return false;
    const status = this.options.broker.status();
    return (
      !status.reauthorizationRequired &&
      (status.admissions === 'open' || status.admissions === 'not_recovered') &&
      status.tokens.some((token) => token.kind === 'user' && token.status === 'live')
    );
  }

  private async exchange(
    grant: Readonly<Record<string, string>>
  ): Promise<IssuedPair | 'bad_refresh_token' | 'unavailable'> {
    let response: GitHubResponse;
    try {
      response = await this.options.oauth(this.options.app.oauthForm(grant));
    } catch {
      return 'unavailable';
    }
    const body = isRecord(response.json) ? response.json : null;
    if (body?.error === 'bad_refresh_token') return 'bad_refresh_token';
    const access = body?.access_token;
    const refresh = body?.refresh_token;
    const expiresIn = body?.expires_in;
    if (
      response.status !== 200 ||
      typeof access !== 'string' ||
      !access.startsWith(USER_TOKEN_PREFIX) ||
      !TOKEN_FORMAT.test(access) ||
      typeof refresh !== 'string' ||
      !REFRESH_FORMAT.test(refresh) ||
      typeof expiresIn !== 'number' ||
      !Number.isSafeInteger(expiresIn) ||
      expiresIn <= 0
    )
      return 'unavailable';
    return { access, refresh, expiresAt: new Date(this.now() + expiresIn * 1000).toISOString() };
  }

  /** Status facts only: never a token, code or state. */
  status(): AuthorizationStatus {
    if (this.chainUsable())
      return {
        authorization: 'authorized',
        nextPermittedAction: 'None: the contributor authorization is live.',
      };
    const required = this.options.broker.status().reauthorizationRequired;
    return {
      authorization: required ? 'reauthorization_required' : 'not_authorized',
      nextPermittedAction: this.reauthorize().nextPermittedAction,
    };
  }

  private reauthorize(): { kind: 'reauthorize'; nextPermittedAction: string } {
    return {
      kind: 'reauthorize',
      nextPermittedAction:
        `reauthorize: authorize the ${this.options.appSlug} GitHub App again as ` +
        `${this.options.contributor} (the run opens the authorization page), then resume the run.`,
    };
  }

  private unknown(): { kind: 'unknown'; nextPermittedAction: string } {
    return {
      kind: 'unknown',
      nextPermittedAction:
        'GitHub could not be read, so nothing was recorded. Resume the run to check again.',
    };
  }

  /** Repository ids the installation selected, read with the held user token. */
  async selectedRepositories(
    installationId: number
  ): Promise<readonly number[] | 'authorize' | null> {
    if (!Number.isSafeInteger(installationId) || installationId <= 0) return null;
    const ids: number[] = [];
    for (let page = 1; page <= MAX_REPOSITORY_PAGES; page++) {
      let response: GitHubResponse;
      try {
        response = await this.options.broker.readAsContributor(
          `/user/installations/${installationId}/repositories?per_page=${PAGE_SIZE}&page=${page}`
        );
      } catch (error) {
        return error instanceof CredentialBrokerError ? 'authorize' : null;
      }
      if (response.status === 401) return 'authorize';
      const body = isRecord(response.json) ? response.json : null;
      const repositories = body?.repositories;
      if (response.status !== 200 || !Array.isArray(repositories)) return null;
      for (const repository of repositories) {
        const id = isRecord(repository) ? repository.id : undefined;
        if (!Number.isSafeInteger(id) || (id as number) <= 0) return null;
        ids.push(id as number);
      }
      if (repositories.length < PAGE_SIZE) return ids;
    }
    // More than the bound: certainly more than the fork alone.
    return null;
  }

  toJSON(): string {
    return REDACTED;
  }
  [inspect.custom](): string {
    return REDACTED;
  }
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** App JWT read: the installation covering a repository (`none` on 404). */
export async function appInstallationFor(
  github: GitHubHttp,
  app: AppCredentials,
  repository: { readonly owner: string; readonly repo: string },
  nowMs: number = Date.now()
): Promise<InstallationSummary | 'none' | null> {
  let response: GitHubResponse;
  try {
    response = await github({
      method: 'GET',
      path: `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/installation`,
      authorization: bearer(app.appJwt(nowMs)),
    });
  } catch {
    return null;
  }
  if (response.status === 404) return 'none';
  const body = isRecord(response.json) ? response.json : null;
  const account = isRecord(body?.account) ? body.account.login : undefined;
  const permissions = isRecord(body?.permissions) ? body.permissions : null;
  if (
    response.status !== 200 ||
    !body ||
    !Number.isSafeInteger(body.id) ||
    (body.id as number) <= 0 ||
    !isGitHubLogin(account) ||
    typeof body.repository_selection !== 'string' ||
    !permissions
  )
    return null;
  return Object.freeze({
    id: body.id as number,
    account,
    repositorySelection: body.repository_selection,
    permissions: Object.freeze(
      Object.fromEntries(Object.entries(permissions).map(([name, level]) => [name, String(level)]))
    ),
    suspended: body.suspended_at !== null && body.suspended_at !== undefined,
  });
}

/** The credential side of `checkForkReadiness`. Before the broker exists (the fork binding
 * is not known yet) or without a live user token, the repository set answers `authorize`. */
export function installationSource(options: {
  readonly http: GitHubHttp;
  readonly app: AppCredentials;
  readonly contributor?: ContributorAuthorization;
  readonly now?: () => number;
}): InstallationSource {
  const now = options.now ?? Date.now;
  return Object.freeze({
    installationFor: (repository: { readonly owner: string; readonly repo: string }) =>
      appInstallationFor(options.http, options.app, repository, now()),
    selectedRepositories: async (installationId: number) =>
      options.contributor ? options.contributor.selectedRepositories(installationId) : 'authorize',
  });
}

/** One-shot loopback receiver for the authorization redirect. Answers a fixed page that
 * echoes nothing, sends no referrer, and stops after the first request on `path`. */
export interface LoopbackReceiver {
  readonly redirectUri: string;
  readonly callback: Promise<CallbackParams>;
  close(): void;
}

const CALLBACK_PAGE =
  '<!doctype html><meta charset="utf-8"><title>ai-dossier</title>' +
  '<p>Authorization received. You can close this window and return to the terminal.</p>';

export function listenLoopback(
  options: { readonly path?: string; readonly timeoutMs?: number } = {}
): Promise<LoopbackReceiver> {
  const callbackPath = options.path ?? '/callback';
  if (!/^\/[A-Za-z0-9/_-]{0,64}$/u.test(callbackPath))
    throw new ContributorAuthError('invalid_redirect');
  let settle!: { resolve: (value: CallbackParams) => void; reject: (error: Error) => void };
  const callback = new Promise<CallbackParams>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // A receiver nobody awaits must not surface an unhandled rejection on close.
  callback.catch(() => undefined);
  let done = false;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (done || request.method !== 'GET' || url.pathname !== callbackPath) {
      response.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      response.end('Not found');
      return;
    }
    done = true;
    const value = (name: string) => {
      const found = url.searchParams.get(name);
      return found !== null && found.length <= 1024 ? found : undefined;
    };
    const params: CallbackParams = Object.freeze({
      ...(value('code') === undefined ? {} : { code: value('code') }),
      ...(value('state') === undefined ? {} : { state: value('state') }),
      ...(value('error') === undefined ? {} : { error: value('error') }),
    });
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    response.end(CALLBACK_PAGE, () => close());
    settle.resolve(params);
  });
  const timer = setTimeout(() => {
    settle.reject(new ContributorAuthError('authorization_expired'));
    close();
  }, options.timeoutMs ?? AUTHORIZATION_WINDOW_MS);
  timer.unref?.();
  function close() {
    done = true;
    clearTimeout(timer);
    settle.reject(new ContributorAuthError('authorization_expired'));
    server.close();
    server.closeAllConnections?.();
  }
  return new Promise((resolve, reject) => {
    server.once('error', () => {
      clearTimeout(timer);
      reject(new ContributorAuthError('invalid_redirect'));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve(
        Object.freeze({ redirectUri: `http://127.0.0.1:${port}${callbackPath}`, callback, close })
      );
    });
  });
}
