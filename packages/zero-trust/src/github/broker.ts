/** Fork-side GitHub credential broker (#1064). The only component that holds
 * GitHub credentials. Controller-only: never import it from worker-facing code.
 *
 * Under the hybrid hand-off the broker performs fork pushes only; upstream
 * writes are contributor hand-offs. Every token is narrowed to the verified
 * fork, bound to one journaled intent attempt, usable for 15 minutes, handed
 * out once, and revoked on every exit path. */
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import type { Intent, IntentState } from '../intents';
import { assertNoSecrets } from '../redaction';
import {
  type AppCredentials,
  deleteGrant,
  deleteToken,
  GitHubAuthError,
  type GitHubHttp,
  type IssuedToken,
  type IssueResult,
  mintInstallationToken,
  probeToken,
  scopeUserToken,
  TOKEN_FORMAT,
  USER_TOKEN_PREFIX,
} from './app-auth';
import {
  type AdmissionCloser,
  type ForkPushVia,
  HELD,
  hasTokenFor,
  isUserChain,
  OUTSTANDING,
  type RevokeStage,
  type TokenEvent,
  TokenJournal,
  type TokenKind,
  type TokenLedger,
  type TokenRecord,
  type TokenStore,
  TokenVault,
  UNRESOLVED,
} from './token-journal';

/** PRD §5.9: maximum 15-minute use. GitHub's 1 h / 8 h lifetimes are never relied on. */
export const USE_WINDOW_MS = 15 * 60 * 1000;
/** PRD §5.9 cleanup: try revocation at most three times, then block. */
export const MAX_REVOKE_ATTEMPTS = 3;
/** Pauses between revocation attempts, so a short rate limit or 5xx is ridden out. */
export const REVOKE_BACKOFF_MS: readonly number[] = Object.freeze([1000, 4000]);
/** Recorded when a call produced no HTTP response (transport failure or timeout). */
export const NO_RESPONSE = 0;
const UNAUTHORIZED = 401;
/** DELETE answers meaning "revoked now" (204) or "already dead" (401 ghs, 404 ghu). */
const TOKEN_GONE = Object.freeze([204, 401, 404]);

export const BROKER_REFUSALS = Object.freeze([
  'not_recovered',
  'admission_closed',
  'cancelled',
  'invalid_fork_binding',
  'invalid_intent',
  'repository_not_fork',
  'duplicate_mint',
  'user_token_held',
  'no_user_token',
  'scope_from_scoped',
  'app_credentials_invalid',
  'mint_refused',
  'mint_uncertain',
  'overbroad_token',
  'window_expired',
  'token_reused',
  'user_token_run_scoped',
] as const);
export type BrokerRefusal = (typeof BROKER_REFUSALS)[number];

/** Fixed message: never echoes request data, responses or token values. */
export class CredentialBrokerError extends Error {
  constructor(readonly code: BrokerRefusal) {
    super(`Credential broker refused: ${code}`);
    this.name = 'CredentialBrokerError';
  }
}
export class CredentialCleanupError extends Error {
  /** Ids, kinds and expiries only (safe to log); absent when nothing is outstanding. */
  readonly report?: CleanupReport;
  /** The operation's own failure, when cleanup failed after it (never serialized). */
  declare readonly operationError?: unknown;
  constructor(report?: CleanupReport, operationError?: unknown) {
    super('Credential revocation failed; run must enter blocked_cleanup');
    this.name = 'CredentialCleanupError';
    if (report) this.report = report;
    if (operationError !== undefined)
      Object.defineProperty(this, 'operationError', { value: operationError, enumerable: false });
  }
}

/** The fork verified by contributor authorization (#1065); the only write target. */
export interface ForkBinding {
  readonly repositoryId: number;
  readonly installationId: number;
  /** Fork owner login, the scoped-token `target`. */
  readonly owner: string;
}
export interface ForkPushTarget {
  readonly repositoryId: number;
  /** Defaults to `installation` (the recommended push token). */
  readonly via?: ForkPushVia;
}

export type CleanupAction =
  | 'contributor_reauthorization_then_kill_switch_or_manual_revoke'
  | 'operator_revoke_or_suspend_installation';
export interface CleanupReport {
  /** Token ids still possibly live, with GitHub's native expiry when known. */
  readonly outstanding: readonly { id: string; kind: TokenKind; expiresAt: string | null }[];
  readonly action: CleanupAction;
}

export interface BrokerOptions {
  /** A dedicated durable store (a `Journal` in its own controller directory). */
  readonly store: TokenStore;
  readonly http: GitHubHttp;
  readonly app: AppCredentials;
  readonly fork: ForkBinding;
  /** Current intent journal state (#1005), e.g. `() => driver.snapshot()`. */
  readonly intents: () => IntentState;
  /** Process-memory values. Shared only with a successor broker in the SAME process,
   * after the previous one was `close()`d; a new process starts empty. */
  readonly vault?: TokenVault;
  readonly now?: () => number;
  readonly setTimer?: (ms: number, fire: () => void) => () => void;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Controller hook: transition the run with `ReasonCode.CleanupFailed`. */
  readonly onCleanupBlocked?: (report: CleanupReport) => void;
  /** Called once when a journal write fails and the broker latches closed; the error
   * is the store's own (disk, permissions), never a GitHub failure. */
  readonly onJournalFailed?: (error: unknown) => void;
}

/** Shipping targets name the fork by id: `fork:<repositoryId>:branch:<name>`. */
const FORK_TARGET = /^fork:([0-9]{1,20}):branch:./u;

const CREDENTIAL_REDACTED = '[GitPushCredential redacted]';

/** Git credentials for exactly one push: env-supplied `http.extraheader`, helpers off.
 * GIT_CONFIG_* entries override repository config, so the overrides below also keep
 * hooks, proxies, TLS changes and redirects from reaching the header. Run the push from
 * a controller-owned clone the worker never had write access to. */
export class GitPushCredential {
  readonly #env: Readonly<Record<string, string>>;
  constructor(token: string) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    const config: [string, string][] = [
      ['credential.helper', ''],
      ['core.hooksPath', '/dev/null'],
      ['core.fsmonitor', 'false'],
      ['http.sslVerify', 'true'],
      ['http.proxy', ''],
      ['http.followRedirects', 'false'],
      ['protocol.allow', 'never'],
      ['protocol.https.allow', 'always'],
      ['http.https://github.com/.extraheader', `Authorization: Basic ${basic}`],
    ];
    this.#env = Object.freeze({
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TRACE_REDACT: '1',
      GIT_CONFIG_COUNT: String(config.length),
      ...Object.fromEntries(
        config.flatMap(([key, value], index) => [
          [`GIT_CONFIG_KEY_${index}`, key],
          [`GIT_CONFIG_VALUE_${index}`, value],
        ])
      ),
    });
  }
  /** Merge over a sanitized base env for `git push`; never pass it through argv. */
  env(): Readonly<Record<string, string>> {
    return this.#env;
  }
  toJSON(): string {
    return CREDENTIAL_REDACTED;
  }
  toString(): string {
    return CREDENTIAL_REDACTED;
  }
  [inspect.custom](): string {
    return CREDENTIAL_REDACTED;
  }
}

export interface ForkPushLease {
  readonly tokenId: string;
  readonly intentKey: string;
  readonly useBy: string;
  /** Aborts when the window closes, the lease is revoked, or the kill switch fires. */
  readonly signal: AbortSignal;
}

export interface KillSwitchReport {
  readonly admissionsDisabled: true;
  readonly grant:
    | { readonly deleted: true /** Token id the deletion was made with. */; readonly via: string }
    | { readonly deleted: false; readonly action: 'contributor_reauthorization_or_manual_revoke' };
  readonly installationTokens: { readonly revoked: string[]; readonly failed: string[] };
  /** User-chain tokens revoked one by one because the grant could not be deleted. */
  readonly scopedTokens: { readonly revoked: string[]; readonly failed: string[] };
  readonly userTokens: { readonly revoked: string[]; readonly failed: string[] };
  /** True only when every revocation was observed. */
  readonly complete: boolean;
}

export interface RecoveryResult {
  readonly admitted: boolean;
  readonly closedBy?: AdmissionCloser | 'journal_failed';
  readonly report?: CleanupReport;
}

export interface BrokerStatus {
  readonly admissions: 'open' | 'not_recovered' | 'journal_failed' | AdmissionCloser;
  readonly reauthorizationRequired: boolean;
  readonly tokens: readonly Pick<
    TokenRecord,
    'id' | 'kind' | 'status' | 'useBy' | 'expiresAt' | 'revokedVia' | 'verified' | 'revokeFailures'
  >[];
}

type Attempt = { ok: true } | { ok: false; stage: RevokeStage; status: number };

const defaultTimer = (ms: number, fire: () => void) => {
  const handle = setTimeout(fire, ms);
  handle.unref?.();
  return () => clearTimeout(handle);
};
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const statusOf = (call: Promise<number>) => call.catch(() => NO_RESPONSE);

export class ForkCredentialBroker {
  private readonly journal: TokenJournal;
  private readonly vault: TokenVault;
  private readonly now: () => number;
  private readonly setTimer: (ms: number, fire: () => void) => () => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly leases = new Map<string, { abort: AbortController; cancel: () => void }>();
  private readonly revoking = new Map<string, Promise<void>>();
  /** In-flight mints; the kill switch and run end wait for them before sweeping. */
  private readonly minting = new Set<Promise<unknown>>();
  private recovered = false;
  /** Latched on any journal failure: nothing more can be admitted or trusted. */
  private failed = false;
  private closed = false;
  private cleanupNotified = false;

  constructor(private readonly options: BrokerOptions) {
    const fork = options.fork;
    if (
      !Number.isSafeInteger(fork.repositoryId) ||
      fork.repositoryId <= 0 ||
      !Number.isSafeInteger(fork.installationId) ||
      fork.installationId <= 0 ||
      !/^[A-Za-z0-9-]{1,39}$/u.test(fork.owner)
    )
      throw new CredentialBrokerError('invalid_fork_binding');
    this.journal = new TokenJournal(options.store);
    this.vault = options.vault ?? new TokenVault();
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? defaultTimer;
    this.sleep = options.sleep ?? defaultSleep;
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }
  private get ledger(): TokenLedger {
    return this.journal.state;
  }
  private tokens(): TokenRecord[] {
    return [...this.ledger.tokens.values()];
  }
  private outstanding(): TokenRecord[] {
    return this.tokens().filter((t) => OUTSTANDING.includes(t.status));
  }
  private record(event: TokenEvent): void {
    if (this.closed) throw new CredentialBrokerError('admission_closed');
    try {
      this.journal.record(event);
    } catch (error) {
      if (!this.failed)
        try {
          this.options.onJournalFailed?.(error);
        } catch {
          // A hook failure cannot reopen admission.
        }
      this.failed = true;
      throw error;
    }
  }
  private assertOpen(): void {
    if (this.closed || this.failed || this.ledger.admissionsClosed)
      throw new CredentialBrokerError('admission_closed');
  }
  private admit(): void {
    this.assertOpen();
    if (!this.recovered) throw new CredentialBrokerError('not_recovered');
  }

  /** Must run before any admission: revokes every journaled token without a recorded revocation. */
  async recover(): Promise<RecoveryResult> {
    const lostUserChain: TokenRecord[] = [];
    for (const token of this.outstanding()) {
      if (this.vault.has(token.id)) {
        // The parent user token is revoked last so its grant stays deletable meanwhile.
        if (token.kind !== 'user') await this.revokeQuietly(token.id);
      } else if (isUserChain(token.kind)) lostUserChain.push(token);
      else this.record({ v: 1, type: 'token_unrevocable', id: token.id, at: this.iso() });
    }
    // Scoped children outlive their parent; without their values only the grant ends them.
    if (lostUserChain.length) await this.deleteGrantWithLiveToken();
    await this.revokeUserTokens();
    const report = this.unresolved();
    if (report) {
      this.blockCleanup(report);
      return { admitted: false, report };
    }
    const closedBy = this.failed ? 'journal_failed' : this.ledger.admissionsClosed;
    if (closedBy) return { admitted: false, closedBy };
    this.recovered = true;
    return { admitted: true };
  }

  /** Holds the contributor's unscoped user token (from #1065's authorization). */
  registerUserToken(value: string, expiresAt: string): string {
    this.assertOpen();
    if (this.liveUserToken()) throw new CredentialBrokerError('user_token_held');
    return this.holdUserToken(value, expiresAt);
  }

  private holdUserToken(value: string, expiresAt: string): string {
    if (
      !value.startsWith(USER_TOKEN_PREFIX) ||
      !TOKEN_FORMAT.test(value) ||
      !Number.isFinite(Date.parse(expiresAt))
    )
      throw new CredentialBrokerError('no_user_token');
    const tokenId = randomUUID();
    this.record({
      v: 1,
      type: 'token_requested',
      id: tokenId,
      kind: 'user',
      parentId: null,
      intentKey: null,
      attempt: null,
      repositoryId: null,
      at: this.iso(),
      useBy: null,
    });
    this.vault.set(tokenId, value);
    this.record({
      v: 1,
      type: 'token_minted',
      id: tokenId,
      expiresAt: new Date(Date.parse(expiresAt)).toISOString(),
    });
    return tokenId;
  }

  /** A refresh replaced the user token. The old one is marked rotated only once
   * observed dead (401); its scoped children stay live and journaled. */
  async rotateUserToken(value: string, expiresAt: string): Promise<string> {
    this.assertOpen();
    const previous = this.liveUserToken();
    if (!previous) throw new CredentialBrokerError('no_user_token');
    const observed = await statusOf(
      probeToken(this.options.http, 'user', this.vault.get(previous.id) as string)
    );
    // The kill switch or run end may have acted during the probe.
    this.assertOpen();
    if (observed === UNAUTHORIZED && this.ledger.tokens.get(previous.id)?.status === 'live') {
      this.record({ v: 1, type: 'token_rotated', id: previous.id, at: this.iso() });
      this.vault.delete(previous.id);
    }
    // Not observed dead: it stays journaled live and is revoked at run end.
    return this.holdUserToken(value, expiresAt);
  }

  /** The newest held unscoped user token. */
  private liveUserToken(): TokenRecord | undefined {
    return this.tokens()
      .reverse()
      .find((t) => t.kind === 'user' && t.status === 'live' && this.vault.has(t.id));
  }

  /** The journaled `push_branch` intent this mint serves, or a refusal. */
  private journaledPushIntent(intent: Intent): Intent {
    const journaled = this.options.intents().intents.get(intent.key);
    if (
      intent.operationKind !== 'push_branch' ||
      !journaled ||
      journaled.status !== 'attempted' ||
      journaled.operationKind !== 'push_branch' ||
      journaled.contributionId !== intent.contributionId ||
      journaled.target !== intent.target ||
      journaled.candidateSha !== intent.candidateSha ||
      journaled.attempts !== intent.attempts
    )
      throw new CredentialBrokerError('invalid_intent');
    // The journaled target must name the same fork the token is narrowed to.
    if (Number(FORK_TARGET.exec(journaled.target)?.[1]) !== this.options.fork.repositoryId)
      throw new CredentialBrokerError('repository_not_fork');
    if (hasTokenFor(this.ledger.tokens, journaled.key, journaled.attempts))
      throw new CredentialBrokerError('duplicate_mint');
    return journaled;
  }

  /** The unscoped user token a child is narrowed from (one level deep only). */
  private scopeParent(scopeFrom: string | undefined): TokenRecord {
    const parent = scopeFrom ? this.ledger.tokens.get(scopeFrom) : this.liveUserToken();
    if (parent?.kind === 'user_scoped') throw new CredentialBrokerError('scope_from_scoped');
    if (parent?.kind !== 'user' || parent.status !== 'live' || !this.vault.has(parent.id))
      throw new CredentialBrokerError('no_user_token');
    return parent;
  }

  /** Mints the token for ONE journaled `push_branch` intent attempt. Returns a lease:
   * `take(lease)` hands out its credential once; `revoke(lease)` ends it. */
  mintForkPush(intent: Intent, target: ForkPushTarget, scopeFrom?: string): Promise<ForkPushLease> {
    const work = this.mint(intent, target, scopeFrom);
    this.minting.add(work);
    const settle = () => this.minting.delete(work);
    work.then(settle, settle);
    return work;
  }

  private async mint(
    intent: Intent,
    target: ForkPushTarget,
    scopeFrom?: string
  ): Promise<ForkPushLease> {
    // Refusals up to the journaled request happen before any network call.
    this.admit();
    if (target.repositoryId !== this.options.fork.repositoryId)
      throw new CredentialBrokerError('repository_not_fork');
    const journaled = this.journaledPushIntent(intent);
    const via = target.via ?? 'installation';
    const parent = via === 'user_scoped' ? this.scopeParent(scopeFrom) : undefined;

    const tokenId = randomUUID();
    const requestedAt = this.now();
    const useBy = this.iso(requestedAt + USE_WINDOW_MS);
    // Fsynced BEFORE the request, so a crash mid-mint is visible to recovery.
    this.record({
      v: 1,
      type: 'token_requested',
      id: tokenId,
      kind: via,
      parentId: parent?.id ?? null,
      intentKey: journaled.key,
      attempt: journaled.attempts,
      repositoryId: this.options.fork.repositoryId,
      at: this.iso(requestedAt),
      useBy,
    });
    const token = await this.issue(tokenId, parent, requestedAt);
    this.vault.set(tokenId, token.value);
    try {
      this.record({ v: 1, type: 'token_minted', id: tokenId, expiresAt: token.expiresAt });
    } catch (error) {
      // The journal is gone, so revoke with no record; recovery still sees `requested`.
      const kind = via === 'installation' ? 'installation' : 'user';
      if ((await this.deleteAndProbe(kind, token.value)).ok) this.vault.delete(tokenId);
      throw error;
    }
    if (!this.narrowedAsRequested(via, token)) {
      this.record({ v: 1, type: 'token_overbroad', id: tokenId, at: this.iso() });
      await this.revoke(tokenId);
      throw new CredentialBrokerError('overbroad_token');
    }
    if (this.closed || this.failed || this.ledger.admissionsClosed) {
      // Admission closed while GitHub was answering: end the token, hand out nothing.
      await this.revoke(tokenId);
      throw new CredentialBrokerError('admission_closed');
    }
    const abort = new AbortController();
    const cancel = this.setTimer(Math.max(0, Date.parse(useBy) - this.now()), () => {
      // Window closed: revoke even while the operation is still running.
      this.revokeQuietly(tokenId);
    });
    this.leases.set(tokenId, { abort, cancel });
    return Object.freeze({ tokenId, intentKey: journaled.key, useBy, signal: abort.signal });
  }

  private async issue(
    tokenId: string,
    parent: TokenRecord | undefined,
    requestedAt: number
  ): Promise<IssuedToken> {
    const { http, app, fork } = this.options;
    let result: IssueResult;
    try {
      result = parent
        ? await scopeUserToken(
            http,
            app,
            this.vault.get(parent.id) as string,
            fork.owner,
            fork.repositoryId
          )
        : await mintInstallationToken(
            http,
            app,
            fork.installationId,
            fork.repositoryId,
            requestedAt
          );
    } catch (error) {
      if (error instanceof GitHubAuthError) {
        // The JWT could not be signed, so no request reached GitHub.
        this.record({ v: 1, type: 'token_mint_failed', id: tokenId, status: NO_RESPONSE });
        throw new CredentialBrokerError('app_credentials_invalid');
      }
      return this.uncertainMint(tokenId, NO_RESPONSE);
    }
    if (result.kind === 'refused' && result.status < 500) {
      this.record({ v: 1, type: 'token_mint_failed', id: tokenId, status: result.status });
      throw new CredentialBrokerError('mint_refused');
    }
    // Outcome unknown (5xx, malformed 2xx): GitHub may hold a live token we never saw.
    if (result.kind !== 'issued') return this.uncertainMint(tokenId, result.status);
    return result.token;
  }

  private uncertainMint(tokenId: string, status: number): never {
    this.record({ v: 1, type: 'token_mint_uncertain', id: tokenId, status });
    const report = this.unresolved();
    if (report) this.blockCleanup(report);
    throw new CredentialBrokerError('mint_uncertain');
  }

  /** GitHub must confirm the narrowing; anything broader is revoked at once. */
  private narrowedAsRequested(via: ForkPushVia, token: IssuedToken): boolean {
    const { permissions, repositoryIds } = token;
    if (
      !permissions ||
      token.repositorySelection !== 'selected' ||
      (via === 'installation' && repositoryIds === null) ||
      permissions.contents !== 'write' ||
      Object.entries(permissions).some(
        ([name, level]) => name !== 'contents' && !(name === 'metadata' && level === 'read')
      )
    )
      return false;
    return (
      repositoryIds === null ||
      (repositoryIds.length === 1 && repositoryIds[0] === this.options.fork.repositoryId)
    );
  }

  /** Hands the lease's credential to its operation exactly once, inside the window. */
  take(lease: ForkPushLease): GitPushCredential {
    this.assertOpen();
    const token = this.ledger.tokens.get(lease.tokenId);
    const value = this.vault.get(lease.tokenId);
    if (
      !token ||
      token.status !== 'live' ||
      value === undefined ||
      !this.leases.has(lease.tokenId) ||
      this.revoking.has(lease.tokenId)
    )
      throw new CredentialBrokerError('token_reused');
    if (token.useBy === null || this.now() >= Date.parse(token.useBy))
      throw new CredentialBrokerError('window_expired');
    this.record({ v: 1, type: 'token_used', id: token.id, at: this.iso() });
    return new GitPushCredential(value);
  }

  /** Mint → hand out once → revoke on success, failure, throw, cancellation or deadline. */
  async withForkPush<T>(
    intent: Intent,
    target: ForkPushTarget,
    operation: (credential: GitPushCredential, signal: AbortSignal) => Promise<T>,
    cancel?: AbortSignal
  ): Promise<T> {
    if (cancel?.aborted) throw new CredentialBrokerError('cancelled');
    const lease = await this.mintForkPush(intent, target);
    // A cancel that arrived during the mint fired before any listener existed.
    if (cancel?.aborted) {
      await this.revoke(lease.tokenId);
      throw new CredentialBrokerError('cancelled');
    }
    const onCancel = () => {
      this.revokeQuietly(lease.tokenId);
    };
    cancel?.addEventListener('abort', onCancel, { once: true });
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await operation(this.take(lease), lease.signal) };
    } catch (error) {
      outcome = { ok: false, error };
    } finally {
      cancel?.removeEventListener('abort', onCancel);
    }
    try {
      await this.revoke(lease.tokenId);
    } catch (error) {
      // A cleanup failure outranks the operation's result, but keeps its error.
      if (error instanceof CredentialCleanupError && !outcome.ok)
        throw new CredentialCleanupError(error.report, outcome.error);
      throw error;
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /** Revokes one operation token (installation or scoped child), retrying with backoff;
   * final failure blocks cleanup. The unscoped user token is refused: revoking it ends
   * its refresh chain, so only `endRun`, cancellation or `killAll` may do that. */
  revoke(lease: ForkPushLease | string): Promise<void> {
    const tokenId = typeof lease === 'string' ? lease : lease.tokenId;
    if (this.ledger.tokens.get(tokenId)?.kind === 'user')
      return Promise.reject(new CredentialBrokerError('user_token_run_scoped'));
    return this.revokeAny(tokenId);
  }

  private revokeAny(tokenId: string): Promise<void> {
    const pending = this.revoking.get(tokenId);
    if (pending) return pending;
    const work = this.revokeOnce(tokenId).finally(() => this.revoking.delete(tokenId));
    this.revoking.set(tokenId, work);
    return work;
  }

  private revokeQuietly(tokenId: string): Promise<void> {
    return this.revokeAny(tokenId).catch(() => undefined);
  }

  /** Re-read after every await: a grant deletion may have ended the token meanwhile. */
  private stillOutstanding(tokenId: string): boolean {
    const status = this.ledger.tokens.get(tokenId)?.status;
    if (status && OUTSTANDING.includes(status)) return true;
    this.vault.delete(tokenId);
    return false;
  }

  private async revokeOnce(tokenId: string): Promise<void> {
    const handle = this.leases.get(tokenId);
    if (handle) {
      handle.cancel();
      handle.abort.abort();
      this.leases.delete(tokenId);
    }
    const token = this.ledger.tokens.get(tokenId);
    if (!token || !OUTSTANDING.includes(token.status)) return;
    const value = this.vault.get(tokenId);
    if (value === undefined || token.status === 'requested') {
      if (!isUserChain(token.kind))
        this.record({ v: 1, type: 'token_unrevocable', id: tokenId, at: this.iso() });
      const report = this.unresolved();
      if (report) this.blockCleanup(report);
      throw new CredentialCleanupError(report);
    }
    const kind = token.kind === 'installation' ? 'installation' : 'user';
    for (let attempt = 1; attempt <= MAX_REVOKE_ATTEMPTS; attempt++) {
      if (attempt > 1) await this.sleep(REVOKE_BACKOFF_MS[attempt - 2] ?? 0);
      if (!this.stillOutstanding(tokenId)) return;
      const result = await this.deleteAndProbe(kind, value);
      if (!this.stillOutstanding(tokenId)) return;
      if (result.ok) {
        // Journal first: if this write is lost, a held value lets a restart re-check.
        this.record({ v: 1, type: 'token_revoked', id: tokenId, verified: true, at: this.iso() });
        this.vault.delete(tokenId);
        if (kind === 'user' && token.kind === 'user') this.requireReauthorization();
        return;
      }
      this.record({
        v: 1,
        type: 'token_revoke_failed',
        id: tokenId,
        stage: result.stage,
        status: result.status,
        at: this.iso(),
      });
    }
    const report = this.unresolved();
    if (report) this.blockCleanup(report);
    throw new CredentialCleanupError(report);
  }

  /** A revocation counts only when a liveness read afterwards observes 401. */
  private async deleteAndProbe(kind: 'installation' | 'user', value: string): Promise<Attempt> {
    const deleted = await statusOf(deleteToken(this.options.http, this.options.app, kind, value));
    if (!TOKEN_GONE.includes(deleted)) return { ok: false, stage: 'delete', status: deleted };
    const probed = await statusOf(probeToken(this.options.http, kind, value));
    return probed === UNAUTHORIZED ? { ok: true } : { ok: false, stage: 'probe', status: probed };
  }

  /** Revoking the unscoped user token kills its refresh chain (`bad_refresh_token`). */
  private requireReauthorization(): void {
    if (!this.ledger.reauthorizationRequired)
      this.record({ v: 1, type: 'reauthorization_required', at: this.iso() });
  }

  /** Grant deletion with an unexpired, unrevoked user-chain token; 404 is never success. */
  private async deleteGrantWithLiveToken(): Promise<string | undefined> {
    const now = this.now();
    const candidates = this.tokens()
      .filter(
        (t) =>
          isUserChain(t.kind) &&
          HELD.includes(t.status) &&
          t.expiresAt !== null &&
          Date.parse(t.expiresAt) > now &&
          this.vault.has(t.id)
      )
      // Prefer the unscoped user token, then the newest child.
      .sort((a, b) =>
        a.kind === b.kind ? b.requestedAt.localeCompare(a.requestedAt) : a.kind === 'user' ? -1 : 1
      );
    for (const candidate of candidates)
      for (let attempt = 1; attempt <= MAX_REVOKE_ATTEMPTS; attempt++) {
        if (attempt > 1) await this.sleep(REVOKE_BACKOFF_MS[attempt - 2] ?? 0);
        const value = this.vault.get(candidate.id);
        if (value === undefined) break;
        const status = await statusOf(deleteGrant(this.options.http, this.options.app, value));
        if (status === 204) {
          this.record({ v: 1, type: 'grant_deleted', via: candidate.id, at: this.iso() });
          for (const token of this.tokens())
            if (isUserChain(token.kind)) this.vault.delete(token.id);
          this.requireReauthorization();
          return candidate.id;
        }
        this.record({
          v: 1,
          type: 'grant_delete_refused',
          via: candidate.id,
          status,
          at: this.iso(),
        });
        // 404: this token is not live in the grant; retrying it cannot succeed.
        if (status === 404) break;
      }
    return undefined;
  }

  private async revokeUserTokens(): Promise<void> {
    for (const token of this.outstanding())
      if (token.kind === 'user' && this.vault.has(token.id)) await this.revokeQuietly(token.id);
  }

  private async settleMints(): Promise<void> {
    await Promise.allSettled([...this.minting]);
  }

  /** Run end or cancellation (PRD §5.8): children first, the unscoped user token last. */
  async endRun(reason: 'completed' | 'cancelled' = 'completed'): Promise<void> {
    this.closeAdmissions('run_ended', reason);
    await this.settleMints();
    if (this.outstanding().some((t) => isUserChain(t.kind) && !this.vault.has(t.id)))
      await this.deleteGrantWithLiveToken();
    for (const token of this.outstanding())
      if (token.kind !== 'user' && this.vault.has(token.id)) await this.revokeQuietly(token.id);
    // A child that would not die is still covered by the grant while the parent lives.
    if (this.outstanding().some((t) => t.kind === 'user_scoped'))
      await this.deleteGrantWithLiveToken();
    await this.revokeUserTokens();
    for (const token of this.outstanding())
      if (token.kind === 'installation' && !this.vault.has(token.id))
        this.record({ v: 1, type: 'token_unrevocable', id: token.id, at: this.iso() });
    const report = this.unresolved();
    if (report) {
      this.blockCleanup(report);
      throw new CredentialCleanupError(report);
    }
  }

  /** Incident kill switch: disable admissions, delete the grant while a live token
   * is still held, then revoke installation tokens. Reports only what it observed. */
  async killAll(): Promise<KillSwitchReport> {
    this.closeAdmissions('kill_switch');
    for (const handle of this.leases.values()) handle.abort.abort();
    await this.settleMints();
    // Grant FIRST: once the last live user-chain token is revoked, the grant cannot be deleted.
    const via = await this.deleteGrantWithLiveToken().catch(() => undefined);
    const sweep = async (kind: TokenKind) => {
      const revoked: string[] = [];
      const failed: string[] = [];
      for (const token of this.outstanding())
        if (token.kind === kind)
          try {
            await this.revokeAny(token.id);
            revoked.push(token.id);
          } catch {
            failed.push(token.id);
          }
      return { revoked, failed };
    };
    // Without the grant, end every tracked user-chain token one by one: children
    // first (they outlive their parent), then the unscoped user token.
    const none = { revoked: [], failed: [] };
    const scopedTokens = via ? none : await sweep('user_scoped');
    const userTokens = via ? none : await sweep('user');
    const installationTokens = await sweep('installation');
    const report = this.unresolved();
    if (report) this.blockCleanup(report);
    const grant: KillSwitchReport['grant'] = via
      ? { deleted: true, via }
      : { deleted: false, action: 'contributor_reauthorization_or_manual_revoke' };
    return Object.freeze({
      admissionsDisabled: true,
      grant,
      installationTokens,
      scopedTokens,
      userTokens,
      // Without the grant, an untracked or value-lost token of it may still live.
      complete: Boolean(via) && installationTokens.failed.length === 0 && !report,
    });
  }

  /** The owner confirmed by hand (e.g. GitHub settings) that this token is dead.
   * Returns what is still unresolved. */
  resolveByOperator(tokenId: string): CleanupReport | undefined {
    this.record({ v: 1, type: 'operator_resolved', id: tokenId, at: this.iso() });
    this.vault.delete(tokenId);
    return this.unresolved();
  }

  /** Settles unresolved tokens whose JOURNALED native expiry has passed. A token
   * without a recorded `expiresAt` is never settled by time. */
  settleExpired(): CleanupReport | undefined {
    const now = this.now();
    for (const token of this.tokens())
      if (
        UNRESOLVED.includes(token.status) &&
        token.expiresAt !== null &&
        Date.parse(token.expiresAt) <= now
      ) {
        this.record({ v: 1, type: 'token_expired', id: token.id, at: this.iso(now) });
        this.vault.delete(token.id);
      }
    return this.unresolved();
  }

  /** Stops this instance's timers and writes, so a successor can take over the journal. */
  close(): void {
    for (const handle of this.leases.values()) {
      handle.cancel();
      handle.abort.abort();
    }
    this.leases.clear();
    this.closed = true;
  }

  private closeAdmissions(reason: AdmissionCloser, detail?: 'completed' | 'cancelled'): void {
    if (this.failed || this.ledger.admissionsClosed) return;
    try {
      this.record({
        v: 1,
        type: 'admissions_disabled',
        reason,
        ...(detail ? { detail } : {}),
        at: this.iso(),
      });
    } catch {
      // `record` already latched `failed`, which closes admission in memory.
    }
  }

  private unresolved(): CleanupReport | undefined {
    const outstanding = this.tokens()
      .filter((t) => UNRESOLVED.includes(t.status))
      .map((t) => ({ id: t.id, kind: t.kind, expiresAt: t.expiresAt }));
    if (!outstanding.length) return undefined;
    return Object.freeze({
      outstanding,
      action: outstanding.some((t) => isUserChain(t.kind))
        ? 'contributor_reauthorization_then_kill_switch_or_manual_revoke'
        : 'operator_revoke_or_suspend_installation',
    });
  }

  private blockCleanup(report: CleanupReport): void {
    this.closeAdmissions('cleanup_blocked');
    if (this.cleanupNotified) return;
    this.cleanupNotified = true;
    try {
      this.options.onCleanupBlocked?.(report);
    } catch {
      // The hook cannot reopen admission; the journal already records the block.
    }
  }

  /** Safe for logs and status output: ids, kinds, states and times only. */
  status(): BrokerStatus {
    const ledger = this.ledger;
    const status: BrokerStatus = {
      admissions:
        ledger.admissionsClosed ??
        (this.failed ? 'journal_failed' : this.recovered ? 'open' : 'not_recovered'),
      reauthorizationRequired: ledger.reauthorizationRequired,
      tokens: this.tokens().map((t) => ({
        id: t.id,
        kind: t.kind,
        status: t.status,
        useBy: t.useBy,
        expiresAt: t.expiresAt,
        revokeFailures: t.revokeFailures,
        ...(t.revokedVia ? { revokedVia: t.revokedVia } : {}),
        ...(t.verified === undefined ? {} : { verified: t.verified }),
      })),
    };
    assertNoSecrets(JSON.stringify(status));
    return status;
  }
}
