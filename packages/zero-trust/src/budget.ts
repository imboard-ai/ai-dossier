import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import * as path from 'node:path';
import {
  BudgetError,
  type BudgetEstimate,
  type BudgetObservation,
  type BudgetRate,
  type BudgetReservation,
  type BudgetSession,
  type BudgetState,
  type EstimateRequest,
  type Money,
} from './budget-types';
import { readPrivate, replacePrivate } from './durable-fs';
import {
  lockRecoveries,
  recordLockReclaim,
  StoreLockedError,
  StorePersistenceError,
  withReadOnlyStoreLock,
  withStoreLock,
} from './lock';
import { parseStrictUtf8Json } from './strict-utf8';

function ledgerLockFile(file: string): string {
  const legacy = `${path.basename(file)}.lock`;
  const name =
    Buffer.byteLength(`${legacy}.guard`) <= 255
      ? legacy
      : `.zt-budget-lock-${createHash('sha256').update(path.basename(file)).digest('hex')}.lock`;
  return path.join(path.dirname(file), name);
}
function integer(n: number, label: string, positive = false): void {
  if (!Number.isSafeInteger(n) || n < (positive ? 1 : 0)) {
    throw new BudgetError(
      'invalid_budget',
      `${label} must be a ${positive ? 'positive' : 'nonnegative'} safe integer`
    );
  }
}

function text(s: string, label: string): void {
  if (typeof s !== 'string' || s.trim().length === 0) {
    throw new BudgetError('invalid_budget', `${label} must be nonempty`);
  }
}

function currency(s: string): void {
  if (typeof s !== 'string' || !/^[A-Z]{3}$/.test(s)) {
    throw new BudgetError('invalid_budget', 'currency must be a three-letter uppercase code');
  }
}

function money(m: Money): void {
  currency(m.currency);
  integer(m.minor, 'money.minor');
}

function safe(n: bigint): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BudgetError('invalid_budget', 'budget arithmetic overflow');
  }
  return Number(n);
}

function sum(values: number[]): number {
  return safe(values.reduce((n, v) => n + BigInt(v), 0n));
}

function rate(r: BudgetRate): void {
  text(r.resource, 'resource');
  currency(r.currency);
  currency(r.fx.currency);
  if (!['token', 'millisecond', 'vm_increment', 'byte_millisecond'].includes(r.unit)) {
    throw new BudgetError('invalid_budget', 'unsupported pricing unit');
  }
  integer(r.price, 'price');
  integer(r.units, 'units', true);
  integer(r.fx.numerator, 'FX numerator', true);
  integer(r.fx.denominator, 'FX denominator', true);
  text(r.source, 'pricing source');
  text(r.fx.timestamp, 'FX timestamp');
  if (!Number.isFinite(Date.parse(r.fx.timestamp))) {
    throw new BudgetError('invalid_budget', 'invalid FX timestamp');
  }
  if (r.currency === r.fx.currency && r.fx.numerator !== r.fx.denominator) {
    throw new BudgetError('invalid_budget', 'same-currency FX must be identity');
  }
}

/** Startup preflight: missing prices are errors even for purportedly free resources. */
export function requireBudgetRates(rates: BudgetRate[], resources: string[]): void {
  rates = structuredClone(rates);
  resources = structuredClone(resources);
  if (!Array.isArray(rates)) throw new BudgetError('invalid_budget', 'rates must be an array');
  const names = new Set<string>();
  for (const r of rates) {
    rate(r);
    if (names.has(r.resource))
      throw new BudgetError('invalid_budget', 'duplicate pricing resource');
    names.add(r.resource);
  }
  for (const resource of resources) {
    text(resource, 'requested resource');
    if (!names.has(resource)) throw new BudgetError('missing_rate', `Missing rate for ${resource}`);
  }
}

/** Round UP once per resource using exact rational minor-unit conversion. */
function priceQuantity(r: BudgetRate, quantity: bigint): bigint {
  const numerator = quantity * BigInt(r.price) * BigInt(r.fx.numerator);
  const denominator = BigInt(r.units) * BigInt(r.fx.denominator);
  return (numerator + denominator - 1n) / denominator;
}

/** Price actual model usage, including zero output, with the same pinned arithmetic as admission. */
export function observeModelBudget(
  input: {
    currency: string;
    resource: string;
    inputTokens: number;
    outputTokens: number;
    timeMs: number;
  },
  rates: BudgetRate[]
): BudgetObservation {
  const request = structuredClone(input);
  const pinned = structuredClone(rates);
  currency(request.currency);
  integer(request.inputTokens, 'observed input tokens');
  integer(request.outputTokens, 'observed output tokens');
  integer(request.timeMs, 'observed time');
  requireBudgetRates(pinned, [request.resource]);
  const r = pinned.find((entry) => entry.resource === request.resource) as BudgetRate;
  if (r.unit !== 'token' || r.fx.currency !== request.currency)
    throw new BudgetError('invalid_budget', 'pricing unit or FX target mismatch');
  const tokens = sum([request.inputTokens, request.outputTokens]);
  return {
    money: { currency: request.currency, minor: safe(priceQuantity(r, BigInt(tokens))) },
    tokens,
    timeMs: request.timeMs,
    source: 'model_usage',
  };
}

export function estimateBudget(request: EstimateRequest, rates: BudgetRate[]): BudgetEstimate {
  // Validate, price and persist the SAME primitive snapshot, including getters
  // supplied through a provider configuration object.
  request = structuredClone(request);
  rates = structuredClone(rates);
  currency(request.currency);
  requireBudgetRates(rates, []);
  const used: BudgetRate[] = [];
  let cost = 0n;
  let tokens = 0;
  let timeMs = 0;
  const charge = (resource: string, unit: BudgetRate['unit'], quantity: bigint): void => {
    requireBudgetRates(rates, [resource]);
    const r = rates.find((entry) => entry.resource === resource) as BudgetRate;
    if (r.unit !== unit || r.fx.currency !== request.currency) {
      throw new BudgetError('invalid_budget', 'pricing unit or FX target mismatch');
    }
    cost += priceQuantity(r, quantity);
    if (!used.some((entry) => entry.resource === resource)) used.push(structuredClone(r));
  };
  if (request.model) {
    const m = request.model;
    integer(m.maxInputTokens, 'input tokens');
    integer(m.maxOutputTokens, 'max output tokens', true);
    integer(m.retries, 'retry count');
    integer(m.streamingTimeMs, 'streaming bound', true);
    const attempts = BigInt(m.retries) + 1n;
    tokens = safe((BigInt(m.maxInputTokens) + BigInt(m.maxOutputTokens)) * attempts);
    timeMs = safe(BigInt(m.streamingTimeMs) * attempts);
    charge(m.resource, 'token', BigInt(tokens));
    if (m.streamingResource !== undefined)
      charge(m.streamingResource, 'millisecond', BigInt(timeMs));
  }
  if (request.vm) {
    const v = request.vm;
    integer(v.durationMs, 'VM duration', true);
    integer(v.minimumBillingIncrementMs, 'VM billing increment', true);
    const increment = BigInt(v.minimumBillingIncrementMs);
    const increments = (BigInt(v.durationMs) + increment - 1n) / increment;
    charge(v.resource, 'vm_increment', increments);
    timeMs = sum([timeMs, safe(increments * increment)]);
  }
  if (request.storage) {
    const s = request.storage;
    integer(s.bytes, 'storage bytes', true);
    integer(s.retentionMs, 'storage retention', true);
    charge(s.resource, 'byte_millisecond', BigInt(s.bytes) * BigInt(s.retentionMs));
  }
  if (used.length === 0)
    throw new BudgetError('missing_rate', 'An estimate requires a priced resource');
  return { money: { currency: request.currency, minor: safe(cost) }, tokens, timeMs, rates: used };
}

function session(s: BudgetSession): void {
  text(s.id, 'session ID');
  money(s.ceiling);
  integer(s.ceiling.minor, 'ceiling');
  integer(s.cleanupAllowance, 'cleanup allowance');
  integer(s.tokenLimit, 'token limit', true);
  integer(s.timeLimitMs, 'time limit', true);
  if (s.cleanupAllowance > s.ceiling.minor)
    throw new BudgetError('invalid_budget', 'cleanup allowance exceeds ceiling');
}

function estimate(e: BudgetEstimate, target: string): void {
  money(e.money);
  if (e.money.currency !== target)
    throw new BudgetError('invalid_budget', 'estimate currency mismatch');
  integer(e.tokens, 'estimated tokens');
  integer(e.timeMs, 'estimated time');
  requireBudgetRates(e.rates, []);
  if (e.rates.length === 0)
    throw new BudgetError('missing_rate', 'Reservation requires pinned pricing');
  for (const r of e.rates) {
    if (r.fx.currency !== target) throw new BudgetError('invalid_budget', 'FX target mismatch');
    if (r.unit === 'token' && (e.tokens === 0 || e.timeMs === 0)) {
      throw new BudgetError(
        'invalid_budget',
        'Model reservations require token and time bounds, including free models'
      );
    }
  }
}

function observation(o: BudgetObservation, target: string): void {
  money(o.money);
  if (o.money.currency !== target)
    throw new BudgetError('invalid_budget', 'observed currency mismatch');
  integer(o.tokens, 'observed tokens');
  integer(o.timeMs, 'observed time');
  text(o.source, 'observation source');
}

/** Validate every row after every disk read; never trust stored counters or reset corrupt history. */
function validate(raw: unknown, contributionId: string): BudgetState {
  try {
    const state = raw as BudgetState;
    if (
      state.schemaVersion !== 1 ||
      !Array.isArray(state.sessions) ||
      !Array.isArray(state.reservations)
    )
      throw new Error('invalid schema');
    text(state.contributionId, 'contribution ID');
    const sessions = new Map<string, BudgetSession>();
    for (const s of state.sessions) {
      session(s);
      if (sessions.has(s.id)) throw new Error('duplicate session');
      sessions.set(s.id, s);
    }
    const ids = new Set<string>();
    for (const r of state.reservations) {
      text(r.id, 'reservation ID');
      const s = sessions.get(r.sessionId);
      if (!s || ids.has(r.id)) throw new Error('invalid reservation identity');
      ids.add(r.id);
      if (r.purpose !== 'work' && r.purpose !== 'teardown') throw new Error('invalid purpose');
      estimate(r.estimate, s.ceiling.currency);
      if (r.status === 'settled') {
        if (!r.observed || r.releaseEvidence !== undefined) throw new Error('invalid settlement');
        observation(r.observed, s.ceiling.currency);
      } else if (r.status === 'released') {
        text(r.releaseEvidence as string, 'release evidence');
        if (r.observed !== undefined) throw new Error('released observation');
      } else if (
        r.status !== 'reserved' ||
        r.observed !== undefined ||
        r.releaseEvidence !== undefined
      ) {
        throw new Error('invalid reservation status');
      }
    }
    if (state.contributionId !== contributionId)
      throw new BudgetError('identity_mismatch', 'Contribution identity mismatch');
    return state;
  } catch (error) {
    if (error instanceof BudgetError && error.code === 'identity_mismatch') throw error;
    throw new BudgetError('corrupt_ledger', 'Invalid budget ledger; reconciliation required');
  }
}

export interface BudgetTotals {
  spent: number;
  reserved: number;
  tokens: number;
  timeMs: number;
}

function reservationTotals(
  state: BudgetState,
  sessionId: string,
  purpose?: BudgetReservation['purpose']
) {
  const rows = state.reservations.filter(
    (r) =>
      r.sessionId === sessionId &&
      r.status !== 'released' &&
      (purpose === undefined || r.purpose === purpose)
  );
  const total = (values: number[]): bigint => values.reduce((n, v) => n + BigInt(v), 0n);
  const amount = (r: BudgetReservation, dimension: 'tokens' | 'timeMs'): number =>
    Math.max(r.estimate[dimension], r.observed?.[dimension] ?? 0);
  return {
    spent: total(
      rows
        .filter((r) => r.status === 'settled')
        .map((r) => Math.max(r.estimate.money.minor, r.observed?.money.minor ?? 0))
    ),
    reserved: total(rows.filter((r) => r.status === 'reserved').map((r) => r.estimate.money.minor)),
    tokens: total(rows.map((r) => amount(r, 'tokens'))),
    timeMs: total(rows.map((r) => amount(r, 'timeMs'))),
  };
}

/** Observed overruns are recorded, not silently capped. Under-estimates never free funds. */
export function budgetTotals(state: BudgetState, sessionId: string): BudgetTotals {
  const t = reservationTotals(state, sessionId);
  return {
    spent: safe(t.spent),
    reserved: safe(t.reserved),
    tokens: safe(t.tokens),
    timeMs: safe(t.timeMs),
  };
}

/** Read-only stopping predicate. Work cannot consume the protected cleanup
 * allowance; bigint totals also recognize observed overruns beyond safe sums. */
export function isBudgetSessionExhausted(state: BudgetState, sessionId: string): boolean {
  const session = state.sessions.find((entry) => entry.id === sessionId);
  if (!session) throw new BudgetError('unknown_session', 'Unknown budget session');
  const totals = reservationTotals(state, sessionId);
  const committedMoney = totals.spent + totals.reserved;
  const workCeiling = BigInt(session.ceiling.minor) - BigInt(session.cleanupAllowance);
  return (
    committedMoney > workCeiling ||
    (workCeiling > 0n && committedMoney === workCeiling) ||
    totals.tokens >= BigInt(session.tokenLimit) ||
    totals.timeMs >= BigInt(session.timeLimitMs)
  );
}

/** Controller-owned LOCAL filesystem ledger. Opening is read-only and never resets history. */
export class BudgetLedger {
  /** Non-mutating snapshot through a caller-pinned path. Never canonicalize it:
   * resolving /proc/self/fd back to a name discards descriptor authority. */
  static readOnlySnapshot(file: string, contributionId: string): BudgetState {
    try {
      return withReadOnlyStoreLock(ledgerLockFile(file), () =>
        BudgetLedger.readSnapshot(file, contributionId)
      );
    } catch (error) {
      if (error instanceof BudgetError) throw error;
      throw new BudgetError(
        'persistence_uncertain',
        'Budget evidence requires transaction reconciliation'
      );
    }
  }
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Called through BudgetLedger by both snapshot paths.
  private static readSnapshot(file: string, contributionId: string): BudgetState {
    let bytes: Buffer;
    try {
      bytes = readPrivate(file, (stat) => {
        if (stat.uid !== process.getuid?.())
          throw new BudgetError('corrupt_ledger', 'Ledger must be a private regular file');
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new BudgetError('missing_ledger', 'Budget ledger missing; never reset on resume');
      throw new BudgetError('corrupt_ledger', 'Unreadable budget ledger; reconciliation required');
    }
    try {
      return validate(parseStrictUtf8Json(bytes), contributionId);
    } catch (error) {
      if (error instanceof BudgetError) throw error;
      throw new BudgetError('corrupt_ledger', 'Unreadable budget ledger; reconciliation required');
    }
  }
  readonly file: string;
  private writeUncertain = false;
  private readonly resumePending = new Set<string>();
  private readonly acknowledged = new Set<string>();
  private readonly recoveryDirectory: string;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Assigned in constructor and read by locked() for every transaction.
  private readonly lockFile: string;
  constructor(
    file: string,
    readonly contributionId: string,
    private readonly lockTimeoutMs = 5_000
  ) {
    text(contributionId, 'contribution ID');
    integer(lockTimeoutMs, 'lock timeout', true);
    // Normalize directory aliases so two callers cannot lock the same ledger
    // through different symlinked directory names. The supervisor provisions it.
    this.file = path.join(fs.realpathSync(path.dirname(path.resolve(file))), path.basename(file));
    // Data paths must never alias another store's permanent guard or evidence.
    // Parent metadata directories are reserved too, preventing nested aliases.
    for (
      let current = this.file;
      current !== path.dirname(current);
      current = path.dirname(current)
    ) {
      const name = path.basename(current);
      if (
        name.startsWith('.zt-') ||
        /\.(lock|guard|recovery|recovery-journal)$/.test(name) ||
        ['events.jsonl', 'nonce-initializing', 'lock-recovery'].includes(name) ||
        name.includes('.quarantine-')
      )
        throw new BudgetError('invalid_budget', 'Ledger path is reserved for controller metadata');
    }
    const legacy = `${path.basename(this.file)}.recovery-journal`;
    const name =
      Buffer.byteLength(legacy) <= 255
        ? legacy
        : `.zt-budget-recovery-${createHash('sha256').update(path.basename(this.file)).digest('hex')}`;
    this.recoveryDirectory = path.join(path.dirname(this.file), name);
    this.lockFile = ledgerLockFile(this.file);
    // Opening an existing ledger is a resume boundary, independent of whether
    // the dead controller held its short mutation lock when it crashed. Capture
    // ALL old unknown outcomes; a null observation never reconciles them.
    if (fs.existsSync(this.file)) {
      for (const row of this.snapshot().reservations) {
        if (row.status === 'reserved') this.resumePending.add(row.id);
      }
    }
  }

  /** Explicit first creation only: cannot overwrite an existing contribution. */
  initialize(requiredResources: string[], rates: BudgetRate[]): void {
    requireBudgetRates(rates, requiredResources);
    this.locked(() => {
      if (fs.existsSync(this.file))
        throw new BudgetError('invalid_budget', 'Ledger already exists');
      this.save({
        schemaVersion: 1,
        contributionId: this.contributionId,
        sessions: [],
        reservations: [],
      });
    });
  }

  snapshot(): BudgetState {
    return BudgetLedger.readSnapshot(this.file, this.contributionId);
  }

  startSession(input: BudgetSession): void {
    const s = structuredClone(input);
    session(s);
    this.mutate((state) => {
      if (state.sessions.some((existing) => existing.id === s.id))
        throw new BudgetError('invalid_budget', 'Session already exists; ceilings cannot reset');
      state.sessions.push(s);
    });
  }

  reserve(
    sessionId: string,
    estimateMax: BudgetEstimate,
    purpose: 'work' | 'teardown' = 'work'
  ): BudgetReservation {
    const e = structuredClone(estimateMax);
    if (purpose !== 'work' && purpose !== 'teardown')
      throw new BudgetError('invalid_budget', 'Invalid reservation purpose');
    const reservation = this.mutate((state) => {
      const pending = new Set(this.resumePending);
      if (fs.existsSync(this.recoveryDirectory)) {
        for (const id of lockRecoveries(this.recoveryDirectory).flatMap(
          (event) => event.pendingReservations
        ))
          pending.add(id);
      }
      if (
        state.reservations.some(
          (row) =>
            row.status === 'reserved' && (pending.has(row.id) || !this.acknowledged.has(row.id))
        )
      )
        throw new BudgetError(
          'persistence_uncertain',
          'Reconcile recovered reservations before new work'
        );
      const s = state.sessions.find((entry) => entry.id === sessionId);
      if (!s) throw new BudgetError('unknown_session', 'Unknown budget session');
      estimate(e, s.ceiling.currency);
      const t = reservationTotals(state, sessionId);
      const workCeiling = BigInt(s.ceiling.minor) - BigInt(s.cleanupAllowance);
      let committed = t.spent + t.reserved;
      let ceiling = workCeiling;
      if (purpose === 'teardown') {
        const work = reservationTotals(state, sessionId, 'work');
        const workCommitted = work.spent + work.reserved;
        // Charge work overruns to work only. Cleanup can borrow unreserved work
        // funds, but its protected allowance survives even an overrun of the ceiling.
        committed -= workCommitted;
        ceiling =
          BigInt(s.cleanupAllowance) +
          (workCommitted < workCeiling ? workCeiling - workCommitted : 0n);
      }
      if (committed + BigInt(e.money.minor) > ceiling)
        throw new BudgetError('ceiling_exceeded', 'Insufficient unreserved budget');
      if (
        t.tokens + BigInt(e.tokens) > BigInt(s.tokenLimit) ||
        t.timeMs + BigInt(e.timeMs) > BigInt(s.timeLimitMs)
      )
        throw new BudgetError('limit_exceeded', 'Token or time limit exceeded');
      const r: BudgetReservation = {
        id: randomUUID(),
        sessionId,
        purpose,
        estimate: e,
        status: 'reserved',
      };
      state.reservations.push(r);
      return structuredClone(r);
    });
    // Only the complete transaction, INCLUDING lock finalization, acknowledges
    // this hold. A failed return or another handle's hold must be reconciled.
    this.acknowledged.add(reservation.id);
    return reservation;
  }

  /** null means outcome unknown: retain the entire reservation, including limits. */
  settle(reservationId: string, observed: BudgetObservation | null): void {
    const o = structuredClone(observed);
    this.mutate((state) => {
      const r = this.pending(state, reservationId);
      if (o === null) return;
      observation(o, r.estimate.money.currency);
      r.observed = o;
      r.status = 'settled';
    });
  }

  /** Only explicit evidence that no billable action occurred permits a release. */
  release(reservationId: string, noChargeEvidence: string): void {
    text(noChargeEvidence, 'no-charge evidence');
    this.mutate((state) => {
      const r = this.pending(state, reservationId);
      r.status = 'released';
      r.releaseEvidence = noChargeEvidence;
    });
  }

  private pending(state: BudgetState, id: string): BudgetReservation {
    const r = state.reservations.find((entry) => entry.id === id);
    if (!r) throw new BudgetError('unknown_reservation', 'Unknown reservation');
    if (r.status !== 'reserved')
      throw new BudgetError('already_reconciled', 'Reservation already reconciled');
    return r;
  }

  private mutate<T>(fn: (state: BudgetState) => T): T {
    return this.locked(() => {
      const state = this.snapshot();
      const result = fn(state);
      validate(state, this.contributionId);
      this.save(state);
      return result;
    });
  }

  private save(state: BudgetState): void {
    try {
      replacePrivate(this.file, Buffer.from(`${JSON.stringify(state)}\n`));
    } catch (error) {
      // A failed fsync may occur AFTER rename. Never retry from this instance
      // assuming that a failed call means nothing committed.
      this.writeUncertain = true;
      throw error;
    }
  }

  private locked<T>(fn: () => T): T {
    if (this.writeUncertain)
      throw new BudgetError(
        'persistence_uncertain',
        'Fence and reconcile ledger before reopening after write uncertainty'
      );
    const lock = this.lockFile;
    try {
      return withStoreLock(
        lock,
        this.lockTimeoutMs,
        (owner) => {
          const pending = fs.existsSync(this.file)
            ? this.snapshot()
                .reservations.filter((row) => row.status === 'reserved')
                .map((row) => row.id)
            : [];
          for (const id of pending) this.resumePending.add(id);
          recordLockReclaim(this.recoveryDirectory, lock, owner, pending);
        },
        fn,
        () => this.writeUncertain
      );
    } catch (error) {
      if (error instanceof StorePersistenceError) this.writeUncertain = true;
      if (error instanceof StoreLockedError || error instanceof SyntaxError)
        throw new BudgetError('lock_timeout', 'Ledger lock held; reconcile owner before retrying');
      throw error;
    }
  }
}
