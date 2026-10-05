import { randomUUID } from 'node:crypto';
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
    const numerator = quantity * BigInt(r.price) * BigInt(r.fx.numerator);
    const denominator = BigInt(r.units) * BigInt(r.fx.denominator);
    cost += (numerator + denominator - 1n) / denominator;
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

/** Observed overruns are recorded, not silently capped. Under-estimates never free funds. */
export function budgetTotals(state: BudgetState, sessionId: string): BudgetTotals {
  const rows = state.reservations.filter(
    (r) => r.sessionId === sessionId && r.status !== 'released'
  );
  const amount = (r: BudgetReservation, dimension: 'tokens' | 'timeMs'): number =>
    Math.max(r.estimate[dimension], r.observed?.[dimension] ?? 0);
  return {
    spent: sum(
      rows
        .filter((r) => r.status === 'settled')
        .map((r) => Math.max(r.estimate.money.minor, r.observed?.money.minor ?? 0))
    ),
    reserved: sum(rows.filter((r) => r.status === 'reserved').map((r) => r.estimate.money.minor)),
    tokens: sum(rows.map((r) => amount(r, 'tokens'))),
    timeMs: sum(rows.map((r) => amount(r, 'timeMs'))),
  };
}

/** Controller-owned LOCAL filesystem ledger. Opening is read-only and never resets history. */
export class BudgetLedger {
  readonly file: string;
  private writeUncertain = false;
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
    let raw: string;
    try {
      const fd = fs.openSync(
        this.file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
      );
      try {
        if (!fs.fstatSync(fd).isFile())
          throw new BudgetError('corrupt_ledger', 'Ledger must be a regular file');
        raw = fs.readFileSync(fd, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new BudgetError('missing_ledger', 'Budget ledger missing; never reset on resume');
      throw error;
    }
    try {
      return validate(JSON.parse(raw), this.contributionId);
    } catch (error) {
      if (error instanceof BudgetError) throw error;
      throw new BudgetError('corrupt_ledger', 'Unreadable budget ledger; reconciliation required');
    }
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
    return this.mutate((state) => {
      const s = state.sessions.find((entry) => entry.id === sessionId);
      if (!s) throw new BudgetError('unknown_session', 'Unknown budget session');
      estimate(e, s.ceiling.currency);
      const t = budgetTotals(state, sessionId);
      const ceiling = s.ceiling.minor - (purpose === 'work' ? s.cleanupAllowance : 0);
      if (BigInt(t.spent) + BigInt(t.reserved) + BigInt(e.money.minor) > BigInt(ceiling))
        throw new BudgetError('ceiling_exceeded', 'Insufficient unreserved budget');
      if (
        BigInt(t.tokens) + BigInt(e.tokens) > BigInt(s.tokenLimit) ||
        BigInt(t.timeMs) + BigInt(e.timeMs) > BigInt(s.timeLimitMs)
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
    const tmp = `${this.file}.tmp-${randomUUID()}`;
    try {
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(state)}\n`, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.file);
      const dirFd = fs.openSync(path.dirname(this.file), 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch (error) {
      // A failed fsync may occur AFTER rename. Never retry from this instance
      // assuming that a failed call means nothing committed.
      this.writeUncertain = true;
      throw error;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  private locked<T>(fn: () => T): T {
    if (this.writeUncertain)
      throw new BudgetError(
        'persistence_uncertain',
        'Fence and reconcile ledger before reopening after write uncertainty'
      );
    const lock = `${this.file}.lock`;
    const start = Date.now();
    let fd: number;
    for (;;) {
      try {
        fd = fs.openSync(lock, 'wx', 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() - start >= this.lockTimeoutMs)
          throw new BudgetError(
            'lock_timeout',
            'Ledger lock held; reconcile owner before retrying'
          );
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, id: randomUUID() }));
      return fn();
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  }
}
