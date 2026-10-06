/** Durable record of every GitHub token the broker mints or holds. Token VALUES
 * are never persisted: they live in a process-memory TokenVault only. */
import { inspect } from 'node:util';
import { isRecoveryEvent } from '../recovery';
import { assertNoSecrets } from '../redaction';
import { isRecord, isTimestamp } from '../state';

export const TOKEN_KINDS = Object.freeze(['installation', 'user', 'user_scoped'] as const);
export type TokenKind = (typeof TOKEN_KINDS)[number];
/** The kinds a fork push can be minted as. */
export type ForkPushVia = Exclude<TokenKind, 'user'>;
export type TokenStatus =
  /** Mint request journaled; GitHub's answer not yet recorded (may exist). */
  | 'requested'
  | 'live'
  /** Handed to its one operation; never handed out again. */
  | 'used'
  | 'revoked'
  | 'mint_failed'
  /** Unscoped user token replaced by a refresh; observed dead, children unaffected. */
  | 'rotated'
  /** Value lost and no API can revoke it; blocks admission until an operator acts. */
  | 'unrevocable';
export const ADMISSION_CLOSERS = Object.freeze([
  'kill_switch',
  'cleanup_blocked',
  'run_ended',
] as const);
export type AdmissionCloser = (typeof ADMISSION_CLOSERS)[number];

export interface TokenRecord {
  readonly id: string;
  readonly kind: TokenKind;
  /** Scoped children only: the unscoped user token they were narrowed from. */
  readonly parentId: string | null;
  /** The journaled intent (#1005) and attempt this token serves; null for the user token. */
  readonly intentKey: string | null;
  readonly attempt: number | null;
  readonly repositoryId: number | null;
  readonly requestedAt: string;
  /** Broker-enforced use deadline (mint request + 15 min); null for the user token. */
  readonly useBy: string | null;
  /** GitHub's native expiry (1 h / 8 h); recorded, never relied on. */
  readonly expiresAt: string | null;
  readonly status: TokenStatus;
  readonly revokedVia?: 'token' | 'grant';
  /** True when a 401 was observed after revocation or rotation, or a grant deletion returned 204. */
  readonly verified?: boolean;
  /** Audit count of failed revocation attempts. */
  readonly revokeFailures: number;
}

export type TokenEvent =
  | {
      v: 1;
      type: 'token_requested';
      id: string;
      kind: TokenKind;
      parentId: string | null;
      intentKey: string | null;
      attempt: number | null;
      repositoryId: number | null;
      at: string;
      useBy: string | null;
    }
  | { v: 1; type: 'token_minted'; id: string; expiresAt: string }
  /** `status` 0 means no request reached GitHub (e.g. the App key could not sign). */
  | { v: 1; type: 'token_mint_failed'; id: string; status: number }
  | { v: 1; type: 'token_used'; id: string; at: string }
  /** `status`: the last HTTP status observed (0 = no response); `stage`: which call failed. */
  | {
      v: 1;
      type: 'token_revoke_failed';
      id: string;
      stage: RevokeStage;
      status: number;
      at: string;
    }
  | { v: 1; type: 'token_revoked'; id: string; verified: true; at: string }
  | { v: 1; type: 'token_rotated'; id: string; at: string }
  | { v: 1; type: 'token_unrevocable'; id: string; at: string }
  | { v: 1; type: 'grant_deleted'; via: string; at: string }
  | { v: 1; type: 'grant_delete_refused'; via: string; status: number; at: string }
  | { v: 1; type: 'admissions_disabled'; reason: AdmissionCloser; at: string }
  | { v: 1; type: 'reauthorization_required'; at: string };
export const REVOKE_STAGES = Object.freeze(['delete', 'probe'] as const);
export type RevokeStage = (typeof REVOKE_STAGES)[number];

export interface TokenLedger {
  readonly tokens: ReadonlyMap<string, TokenRecord>;
  readonly admissionsClosed: AdmissionCloser | null;
  readonly reauthorizationRequired: boolean;
}

export class TokenJournalError extends Error {
  constructor() {
    super('Invalid credential broker journal event');
    this.name = 'TokenJournalError';
  }
}

/** Pending/live statuses still need revocation. */
export const OUTSTANDING: readonly TokenStatus[] = Object.freeze(['requested', 'live', 'used']);
/** Statuses that keep a run from closing cleanly. */
export const UNRESOLVED: readonly TokenStatus[] = Object.freeze([...OUTSTANDING, 'unrevocable']);
/** Minted and not yet revoked: a value GitHub still honours. */
export const HELD: readonly TokenStatus[] = Object.freeze(['live', 'used']);
export const isUserChain = (kind: TokenKind): boolean => kind !== 'installation';
const isTokenKind = (value: unknown): value is TokenKind =>
  TOKEN_KINDS.includes(value as TokenKind);

/** One token per journaled intent attempt; the broker pre-check and replay share this rule. */
export function hasTokenFor(
  tokens: ReadonlyMap<string, TokenRecord>,
  intentKey: string,
  attempt: number
): boolean {
  return [...tokens.values()].some((t) => t.intentKey === intentKey && t.attempt === attempt);
}

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
function fail(): never {
  throw new TokenJournalError();
}
const id = (value: unknown): string =>
  typeof value === 'string' && ID.test(value) ? value : fail();
const at = (value: unknown): string => (isTimestamp(value) ? value : fail());
const httpStatus = (value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 1000
    ? value
    : fail();
const positive = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fail();
const nullable = <T>(value: unknown, check: (v: unknown) => T): T | null =>
  value === null ? null : check(value);

function requestedToken(
  tokens: ReadonlyMap<string, TokenRecord>,
  event: Record<string, unknown>
): TokenRecord {
  const tokenId = id(event.id);
  const kind = event.kind;
  if (tokens.has(tokenId) || !isTokenKind(kind)) fail();
  const parentId = nullable(event.parentId, id);
  const parent = parentId === null ? undefined : tokens.get(parentId);
  // Narrowing is one level deep: a scoped child names an unscoped user parent.
  if ((kind === 'user_scoped') !== (parent?.kind === 'user')) fail();
  const intentKey = nullable(event.intentKey, (v) =>
    typeof v === 'string' && v.length > 0 && v.length <= 8192 ? v : fail()
  );
  const attempt = nullable(event.attempt, positive);
  const repositoryId = nullable(event.repositoryId, positive);
  const useBy = nullable(event.useBy, at);
  // Operation tokens carry an intent, attempt, repository and use window; the user token none.
  const operation = kind !== 'user';
  if (
    [intentKey, attempt, repositoryId, useBy].some((v) => (v === null) === operation) ||
    (kind !== 'user_scoped' && parentId !== null) ||
    (operation && hasTokenFor(tokens, intentKey as string, attempt as number))
  )
    fail();
  return Object.freeze({
    id: tokenId,
    kind,
    parentId,
    intentKey,
    attempt,
    repositoryId,
    requestedAt: at(event.at),
    useBy,
    expiresAt: null,
    status: 'requested',
    revokeFailures: 0,
  });
}

function reduceToken(ledger: TokenLedger, raw: unknown): TokenLedger {
  if (!isRecord(raw) || raw.v !== 1) fail();
  const event = raw;
  const tokens = new Map(ledger.tokens);
  const update = (
    key: unknown,
    allowed: readonly TokenStatus[],
    patch: (current: TokenRecord) => Partial<TokenRecord>
  ) => {
    const current = tokens.get(id(key));
    if (!current || !allowed.includes(current.status)) fail();
    tokens.set(current.id, Object.freeze({ ...current, ...patch(current) }));
  };
  let { admissionsClosed, reauthorizationRequired } = ledger;
  switch (event.type) {
    case 'token_requested': {
      const token = requestedToken(tokens, event);
      tokens.set(token.id, token);
      break;
    }
    case 'token_minted':
      update(event.id, ['requested'], () => ({ status: 'live', expiresAt: at(event.expiresAt) }));
      break;
    case 'token_mint_failed':
      httpStatus(event.status);
      update(event.id, ['requested'], () => ({ status: 'mint_failed' }));
      break;
    case 'token_used':
      at(event.at);
      if (tokens.get(id(event.id))?.kind === 'user') fail();
      update(event.id, ['live'], () => ({ status: 'used' }));
      break;
    case 'token_revoke_failed':
      at(event.at);
      httpStatus(event.status);
      if (!REVOKE_STAGES.includes(event.stage as RevokeStage)) fail();
      update(event.id, OUTSTANDING, (current) => ({
        revokeFailures: current.revokeFailures + 1,
      }));
      break;
    case 'token_revoked':
      at(event.at);
      if (event.verified !== true) fail();
      update(event.id, HELD, () => ({ status: 'revoked', revokedVia: 'token', verified: true }));
      break;
    case 'token_rotated':
      at(event.at);
      if (tokens.get(id(event.id))?.kind !== 'user') fail();
      update(event.id, ['live'], () => ({ status: 'rotated', verified: true }));
      break;
    case 'token_unrevocable':
      at(event.at);
      update(event.id, OUTSTANDING, () => ({ status: 'unrevocable' }));
      break;
    case 'grant_deleted': {
      at(event.at);
      const via = tokens.get(id(event.via));
      if (!via || !isUserChain(via.kind) || !HELD.includes(via.status)) fail();
      // Grant deletion ends EVERY token of the authorization, scoped children included.
      for (const token of tokens.values())
        if (isUserChain(token.kind) && UNRESOLVED.includes(token.status))
          tokens.set(
            token.id,
            Object.freeze({ ...token, status: 'revoked', revokedVia: 'grant', verified: true })
          );
      break;
    }
    case 'grant_delete_refused':
      at(event.at);
      httpStatus(event.status);
      if (!tokens.has(id(event.via))) fail();
      break;
    case 'admissions_disabled':
      at(event.at);
      if (!ADMISSION_CLOSERS.includes(event.reason as AdmissionCloser)) fail();
      // The first closer is kept; later ones never reopen or relabel admission.
      admissionsClosed ??= event.reason as AdmissionCloser;
      break;
    case 'reauthorization_required':
      at(event.at);
      reauthorizationRequired = true;
      break;
    default:
      fail();
  }
  return Object.freeze({ tokens, admissionsClosed, reauthorizationRequired });
}

export function replayTokens(events: readonly unknown[]): TokenLedger {
  let ledger: TokenLedger = Object.freeze({
    tokens: new Map(),
    admissionsClosed: null,
    reauthorizationRequired: false,
  });
  for (const event of events) if (!isRecoveryEvent(event)) ledger = reduceToken(ledger, event);
  return ledger;
}

/** The durable store the broker writes; satisfied by `Journal` in its own directory. */
export interface TokenStore {
  read(): unknown[];
  append(event: unknown): void;
}

/** Validates every event against the ledger and the redaction policy before append. */
export class TokenJournal {
  private ledger: TokenLedger;
  constructor(private readonly store: TokenStore) {
    this.ledger = replayTokens(store.read());
  }
  get state(): TokenLedger {
    return this.ledger;
  }
  record(event: TokenEvent): TokenLedger {
    // Scan the one free-form value raw as well as the encoded event (trap #1004).
    if (event.type === 'token_requested' && event.intentKey !== null)
      assertNoSecrets(event.intentKey);
    assertNoSecrets(JSON.stringify(event));
    const next = reduceToken(this.ledger, event);
    this.store.append(event);
    this.ledger = next;
    return next;
  }
}

const VAULT_REDACTED = '[TokenVault redacted]';

/** Process-memory token values. Never serialized; a new process starts empty. */
export class TokenVault {
  readonly #values = new Map<string, string>();
  set(tokenId: string, value: string): void {
    this.#values.set(tokenId, value);
  }
  get(tokenId: string): string | undefined {
    return this.#values.get(tokenId);
  }
  has(tokenId: string): boolean {
    return this.#values.has(tokenId);
  }
  delete(tokenId: string): void {
    this.#values.delete(tokenId);
  }
  toJSON(): string {
    return VAULT_REDACTED;
  }
  [inspect.custom](): string {
    return VAULT_REDACTED;
  }
}
