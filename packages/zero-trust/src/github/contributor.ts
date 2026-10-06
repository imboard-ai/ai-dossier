/** Contributor authorization (#1065, PRD §5.1 `contributor`, §5.9). The GitHub App user
 * authorization web flow with a loopback redirect and a checked `state`, the login binding,
 * refresh rotation, and the installation reads that need a credential.
 *
 * Credential module, controller-only. A new access token is used for exactly one call of
 * its own, `GET /user`, so that only the run's contributor's token ever reaches the broker
 * (#1064); every later use goes through the broker. The refresh token lives in this object's
 * private memory. Neither, nor the authorization code, is ever persisted, logged or
 * returned. */
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
import {
  type InstallationSource,
  type InstallationSummary,
  isAppSlug,
  isPositiveId,
  UNREADABLE_ACTION,
} from './fork';
import { isGitHubLogin, sameLogin } from './handoff';

export const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
/** Where a contributor revokes an authorization by hand. */
export const AUTHORIZATIONS_URL = 'https://github.com/settings/applications';
/** GitHub authorization codes expire after ten minutes. */
export const AUTHORIZATION_WINDOW_MS = 10 * 60 * 1000;
const REFRESH_FORMAT = /^ghr_[A-Za-z0-9_]{20,255}$/u;
const PAGE_SIZE = 100;
const MAX_REPOSITORY_PAGES = 10;
/** Token-endpoint errors that a new authorization cannot fix: the App is misconfigured. */
const MISCONFIGURED = Object.freeze([
  'incorrect_client_credentials',
  'redirect_uri_mismatch',
  'unsupported_grant_type',
]);
/** DELETE answers meaning the token is dead (204 revoked now, 404 already gone). */
const REVOKED = Object.freeze([204, 404]);

/** Fixed next step per refusal; the message never echoes the callback, a code or a token. */
const REFUSAL_HINTS = Object.freeze({
  invalid_options: 'the contributor login or App slug is malformed; fix the run configuration',
  invalid_redirect:
    'use a loopback redirect: http://127.0.0.1:<port>/<path> or http://[::1]:<port>/<path>',
  loopback_unavailable: 'no loopback port could be opened; free one and authorize again',
  no_pending_authorization: 'start a new authorization; each one can be completed once',
  authorization_expired: 'the authorization page expired; start a new one',
  authorization_denied: 'the contributor declined on GitHub; start a new authorization to retry',
  state_mismatch: 'the redirect did not come from this authorization; start a new one',
  invalid_callback: 'the redirect carried no usable code; start a new authorization',
  exchange_failed: 'GitHub did not issue a token; start a new authorization',
  app_misconfigured:
    'GitHub refused the App credentials or redirect, or the App does not issue expiring user tokens; the operator must fix the App',
  revoke_failed: `a token could not be revoked; revoke the App's authorization at ${AUTHORIZATIONS_URL}`,
} as const);
export type ContributorRefusal = keyof typeof REFUSAL_HINTS;
export const CONTRIBUTOR_REFUSALS = Object.freeze(
  Object.keys(REFUSAL_HINTS) as ContributorRefusal[]
);

export class ContributorAuthError extends Error {
  constructor(readonly code: ContributorRefusal) {
    super(`Contributor authorization refused: ${code} (${REFUSAL_HINTS[code]})`);
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
  /** Scenario 17: another account authorized. The run records `policy_blocked`. */
  | {
      readonly kind: 'blocked';
      readonly reason: 'contributor_mismatch';
      readonly run: RunRecord;
      /** False when GitHub did not confirm the other account's token dead. */
      readonly tokenRevoked: boolean;
      readonly nextPermittedAction: string;
    }
  | { readonly kind: 'reauthorize'; readonly nextPermittedAction: string }
  | { readonly kind: 'unknown'; readonly nextPermittedAction: string };

export type RefreshOutcome =
  | { readonly kind: 'refreshed'; readonly tokenId: string }
  /** The chain is dead (revoked, rotated away or `bad_refresh_token`): authorize again. */
  | { readonly kind: 'reauthorize'; readonly nextPermittedAction: string }
  /** No usable answer from GitHub; nothing is retried here. If GitHub did rotate, the stored
   * refresh token is now dead and the next refresh answers `reauthorize`. */
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

/** A canonical loopback redirect only (RFC 8252 §7.3): http, an IP literal, an explicit
 * port, a path, no query or fragment. */
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

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

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
type Exchange = IssuedPair | 'bad_refresh_token' | 'misconfigured' | 'unavailable';

type Identity = { login: string; userId: number } | 'unauthorized' | null;
function identity(response: GitHubResponse): Identity {
  if (response.status === 401) return 'unauthorized';
  const body = isRecord(response.json) ? response.json : null;
  const login = body?.login;
  const userId = body?.id;
  if (response.status !== 200 || !isGitHubLogin(login) || !isPositiveId(userId)) return null;
  return { login, userId };
}

const REDACTED = '[ContributorAuthorization redacted]';

export class ContributorAuthorization {
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read and consumed in complete()
  #pending: Pending | undefined;
  /** The current refresh token; replaced in one assignment once the broker holds its pair. */
  #refresh: string | undefined;
  #refreshing: Promise<RefreshOutcome> | undefined;
  #boundUserId: number | undefined;
  /** complete, bindLogin and refresh change the same state: one at a time. */
  #tail: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly options: ContributorOptions) {
    if (!isGitHubLogin(options.contributor) || !isAppSlug(options.appSlug))
      throw new ContributorAuthError('invalid_options');
    this.now = options.now ?? Date.now;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work);
    this.#tail = result.catch(() => undefined);
    return result;
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

  /** For `listenLoopback({ isExpected })`: whether a redirect carries the pending `state`. */
  matchesPending(state: string): boolean {
    const pending = this.#pending;
    return pending !== undefined && typeof state === 'string' && sameSecret(state, pending.state);
  }

  /** Finishes the web flow: the `state` must match (single use), then the code is exchanged
   * and the new token's `GET /user` login checked. Only the run's contributor's token is
   * handed to the broker; another account's is revoked at once and blocks the run. */
  complete(callback: CallbackParams, run: RunRecord, boundUserId?: number): Promise<LoginOutcome> {
    const pending = this.#pending;
    // Single use, whatever happens next: a replayed or second callback finds nothing.
    this.#pending = undefined;
    return this.serial(async () => {
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
      if (pair === 'misconfigured') throw new ContributorAuthError('app_misconfigured');
      if (typeof pair === 'string') throw new ContributorAuthError('exchange_failed');

      let who: Identity;
      try {
        who = identity(
          await this.options.http({
            method: 'GET',
            path: '/user',
            authorization: bearer(pair.access),
          })
        );
      } catch {
        who = null;
      }
      if (who === null || who === 'unauthorized') {
        // Unverified: the token never reaches the broker.
        if (!(await this.discard(pair.access))) throw new ContributorAuthError('revoke_failed');
        return who === null ? this.unknownAuthorization() : this.reauthorize();
      }
      if (this.mismatch(run, who, boundUserId)) {
        const tokenRevoked = await this.discard(pair.access);
        return this.blocked(run, tokenRevoked);
      }
      // Re-authorizing while the broker still holds a token: the new one replaces it.
      const held = this.options.broker
        .status()
        .tokens.some((token) => token.kind === 'user' && token.status === 'live');
      await this.hold(pair, (value, expiresAt) =>
        held
          ? this.options.broker.rotateUserToken(value, expiresAt)
          : this.options.broker.registerUserToken(value, expiresAt)
      );
      this.#refresh = pair.refresh;
      this.#boundUserId = who.userId;
      return Object.freeze({ kind: 'bound', login: who.login, userId: who.userId });
    });
  }

  /** Scenario 17 on resume: re-checks `GET /user` through the broker. A login, or a recorded
   * user id, other than the run's ends the broker's run (revoking that token) and blocks. */
  bindLogin(run: RunRecord, boundUserId?: number): Promise<LoginOutcome> {
    return this.serial(async () => {
      let who: Identity;
      try {
        who = identity(await this.options.broker.readAsContributor('/user'));
      } catch (error) {
        if (refusesNoToken(error)) return this.reauthorize();
        if (error instanceof CredentialBrokerError) throw error;
        return this.unknown();
      }
      if (who === 'unauthorized') return this.reauthorize();
      if (who === null) return this.unknown();
      if (this.mismatch(run, who, boundUserId)) {
        this.#refresh = undefined;
        // Revoke first: a run record that cannot transition must not keep the token alive.
        await this.options.broker.endRun('cancelled');
        return this.blocked(run, true);
      }
      this.#boundUserId = who.userId;
      return Object.freeze({ kind: 'bound', login: who.login, userId: who.userId });
    });
  }

  private mismatch(
    run: RunRecord,
    who: { login: string; userId: number },
    boundUserId: number | undefined
  ): boolean {
    const expectedId = boundUserId ?? this.#boundUserId;
    return (
      !sameLogin(who.login, run.contributor) ||
      !sameLogin(who.login, this.options.contributor) ||
      (expectedId !== undefined && expectedId !== who.userId)
    );
  }

  private blocked(run: RunRecord, tokenRevoked: boolean): LoginOutcome {
    const manual = tokenRevoked
      ? ''
      : ` GitHub did not confirm its token revoked: revoke the App's authorization at ${AUTHORIZATIONS_URL}.`;
    return {
      kind: 'blocked',
      reason: 'contributor_mismatch',
      run: transitionRun(run, ReasonCode.PolicyBlocked, new Date(this.now()).toISOString()),
      tokenRevoked,
      nextPermittedAction:
        "GitHub authenticated a different account than this run's contributor " +
        `(${run.contributor}).${manual} Start a new run as the account that owns the fork.`,
    };
  }

  /** Rotates the user token with the stored refresh token, once at a time. A dead chain
   * (revoked, or `bad_refresh_token`) answers `reauthorize` and is never tried again. */
  refresh(): Promise<RefreshOutcome> {
    this.#refreshing ??= this.serial(() => this.rotate()).finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  private async rotate(): Promise<RefreshOutcome> {
    const refresh = this.#refresh;
    // Revoking the user token killed its refresh token: never present the dead one.
    if (refresh === undefined || !this.chainUsable()) {
      this.#refresh = undefined;
      return this.reauthorize();
    }
    const pair = await this.exchange({ grant_type: 'refresh_token', refresh_token: refresh });
    if (pair === 'bad_refresh_token') {
      this.#refresh = undefined;
      return this.reauthorize();
    }
    if (typeof pair === 'string') return { kind: 'unavailable' };
    try {
      const tokenId = await this.hold(pair, (value, expiresAt) =>
        this.options.broker.rotateUserToken(value, expiresAt)
      );
      this.#refresh = pair.refresh;
      return { kind: 'refreshed', tokenId };
    } catch (error) {
      // The old refresh token was spent by this exchange; the new pair was revoked.
      this.#refresh = undefined;
      if (error instanceof CredentialBrokerError) return this.reauthorize();
      throw error;
    }
  }

  /** The broker must hold the new access token BEFORE the caller replaces the refresh token,
   * so the stored pair is never half-updated. A token the broker refuses is revoked at once. */
  private async hold(
    pair: IssuedPair,
    register: (value: string, expiresAt: string) => string | Promise<string>
  ): Promise<string> {
    try {
      return await register(pair.access, pair.expiresAt);
    } catch (error) {
      if (!(await this.discard(pair.access))) throw new ContributorAuthError('revoke_failed');
      throw error;
    }
  }

  /** Revokes a token the broker never journaled; true once GitHub reports it dead. */
  private async discard(access: string): Promise<boolean> {
    const status = await deleteToken(this.options.http, this.options.app, 'user', access).catch(
      () => 0
    );
    return REVOKED.includes(status);
  }

  private chainUsable(): boolean {
    const status = this.options.broker.status();
    return (
      !status.reauthorizationRequired &&
      (status.admissions === 'open' || status.admissions === 'not_recovered') &&
      status.tokens.some((token) => token.kind === 'user' && token.status === 'live')
    );
  }

  private async exchange(grant: Readonly<Record<string, string>>): Promise<Exchange> {
    let response: GitHubResponse;
    try {
      response = await this.options.oauth(this.options.app.oauthForm(grant));
    } catch {
      return 'unavailable';
    }
    const body = isRecord(response.json) ? response.json : null;
    if (body?.error === 'bad_refresh_token') return 'bad_refresh_token';
    if (MISCONFIGURED.includes(body?.error as string)) return 'misconfigured';
    const access = body?.access_token;
    if (
      response.status !== 200 ||
      typeof access !== 'string' ||
      !access.startsWith(USER_TOKEN_PREFIX) ||
      !TOKEN_FORMAT.test(access)
    )
      return 'unavailable';
    const refresh = body?.refresh_token;
    const expiresIn = body?.expires_in;
    if (typeof refresh !== 'string' || !REFRESH_FORMAT.test(refresh) || !isPositiveId(expiresIn)) {
      // A live token without an expiring refresh chain (expiring user tokens disabled):
      // never kept, never handed out.
      await this.discard(access);
      return 'misconfigured';
    }
    return { access, refresh, expiresAt: new Date(this.now() + expiresIn * 1000).toISOString() };
  }

  /** Status facts only: never a token, code or state. */
  status(): AuthorizationStatus {
    if (this.#refresh !== undefined && this.chainUsable())
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
    return { kind: 'unknown', nextPermittedAction: UNREADABLE_ACTION };
  }

  /** The login could not be read right after the exchange; the token was revoked unused. */
  private unknownAuthorization(): { kind: 'unknown'; nextPermittedAction: string } {
    return {
      kind: 'unknown',
      nextPermittedAction:
        'GitHub could not confirm which account authorized, so the token was revoked unused. ' +
        `Authorize the ${this.options.appSlug} GitHub App again as ${this.options.contributor}.`,
    };
  }

  /** Repository ids the installation selected, read with the held user token. */
  async selectedRepositories(
    installationId: number
  ): Promise<readonly number[] | 'authorize' | null> {
    if (!isPositiveId(installationId)) return null;
    const ids: number[] = [];
    for (let page = 1; page <= MAX_REPOSITORY_PAGES; page++) {
      let response: GitHubResponse;
      try {
        response = await this.options.broker.readAsContributor(
          `/user/installations/${installationId}/repositories?per_page=${PAGE_SIZE}&page=${page}`
        );
      } catch (error) {
        if (refusesNoToken(error)) return 'authorize';
        if (error instanceof CredentialBrokerError) throw error;
        return null;
      }
      if (response.status === 401) return 'authorize';
      // The contributor's token cannot see the installation: it does not cover the fork.
      if (response.status === 404) return [];
      const body = isRecord(response.json) ? response.json : null;
      const repositories = body?.repositories;
      if (response.status !== 200 || !Array.isArray(repositories)) return null;
      for (const repository of repositories) {
        const id = isRecord(repository) ? repository.id : undefined;
        if (!isPositiveId(id)) return null;
        ids.push(id);
      }
      if (repositories.length < PAGE_SIZE) return ids;
    }
    // Past the bound: certainly more than the fork alone, which the check reports as too broad.
    return ids;
  }

  toJSON(): string {
    return REDACTED;
  }
  [inspect.custom](): string {
    return REDACTED;
  }
}

/** The broker holds no live user token for this run (none yet, revoked, or run ended). */
function refusesNoToken(error: unknown): boolean {
  return (
    error instanceof CredentialBrokerError &&
    (error.code === 'no_user_token' || error.code === 'admission_closed')
  );
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
    !isPositiveId(body.id) ||
    !isGitHubLogin(account) ||
    typeof body.repository_selection !== 'string' ||
    !permissions
  )
    return null;
  return Object.freeze({
    id: body.id,
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

/** One-shot loopback receiver for the authorization redirect. */
export interface LoopbackReceiver {
  readonly redirectUri: string;
  readonly callback: Promise<CallbackParams>;
  close(): void;
}

const CALLBACK_PAGE =
  '<!doctype html><meta charset="utf-8"><title>ai-dossier</title>' +
  '<p>Authorization received. You can close this window and return to the terminal.</p>';
const MAX_PARAM_LENGTH = 1024;

/** The callback's `code`, `state` and `error`, or null for anything that is not one: a
 * malformed target, a missing `state`, or neither a code nor an error. Never throws. */
function callbackParams(target: string, callbackPath: string): CallbackParams | null {
  const mark = target.indexOf('?');
  if ((mark < 0 ? target : target.slice(0, mark)) !== callbackPath || mark < 0) return null;
  let query: URLSearchParams;
  try {
    query = new URLSearchParams(target.slice(mark + 1));
  } catch {
    return null;
  }
  const value = (name: string) => {
    const found = query.get(name);
    return found !== null && found.length <= MAX_PARAM_LENGTH ? found : undefined;
  };
  const code = value('code');
  const state = value('state');
  const error = value('error');
  if (state === undefined || (code === undefined && error === undefined)) return null;
  return Object.freeze({
    ...(code === undefined ? {} : { code }),
    state,
    ...(error === undefined ? {} : { error }),
  });
}

/** Listens on 127.0.0.1 for the redirect. Answers a fixed page that echoes nothing and sends
 * no referrer; resolves on the first well-formed callback whose `state` `isExpected` accepts
 * (pass `auth.matchesPending`), answering 400 to anything else and to a foreign Host header
 * (DNS rebinding). Rejects with `authorization_expired` on timeout or `close()`. */
export function listenLoopback(
  options: {
    readonly path?: string;
    readonly timeoutMs?: number;
    readonly isExpected?: (state: string) => boolean;
  } = {}
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
  let host = '';
  const server = http.createServer((request, response) => {
    const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
    const params =
      !done && request.method === 'GET' && request.headers.host === host
        ? callbackParams(request.url ?? '', callbackPath)
        : null;
    let accepted = false;
    try {
      accepted = params !== null && (options.isExpected?.(params.state as string) ?? true) === true;
    } catch {
      accepted = false;
    }
    if (!accepted) {
      response.writeHead(400, { ...headers, 'Content-Type': 'text/plain' });
      response.end('Bad request');
      return;
    }
    done = true;
    response.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
    response.end(CALLBACK_PAGE, () => close());
    settle.resolve(params as CallbackParams);
  });
  const timer = setTimeout(close, options.timeoutMs ?? AUTHORIZATION_WINDOW_MS);
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
      reject(new ContributorAuthError('loopback_unavailable'));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address !== 'object' || !address || !address.port) {
        close();
        reject(new ContributorAuthError('loopback_unavailable'));
        return;
      }
      host = `127.0.0.1:${address.port}`;
      resolve(Object.freeze({ redirectUri: `http://${host}${callbackPath}`, callback, close }));
    });
  });
}
