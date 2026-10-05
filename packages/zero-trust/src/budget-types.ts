/** All monetary values are nonnegative safe-integer minor units, never decimal prices. */
export interface Money {
  currency: string;
  minor: number;
}

export interface BudgetRate {
  resource: string;
  currency: string;
  unit: 'token' | 'millisecond' | 'vm_increment' | 'byte_millisecond';
  price: number;
  /** Number of units priced together (e.g. one million tokens). */
  units: number;
  source: string;
  fx: {
    currency: string;
    /** Rational conversion of source minor units into target minor units. */
    numerator: number;
    denominator: number;
    timestamp: string;
  };
}

export interface BudgetEstimate {
  money: Money;
  tokens: number;
  timeMs: number;
  rates: BudgetRate[];
}

export interface EstimateRequest {
  currency: string;
  model?: {
    resource: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    retries: number;
    streamingTimeMs: number;
    /** Optional time-priced streaming resource, in addition to token charges. */
    streamingResource?: string;
  };
  vm?: { resource: string; durationMs: number; minimumBillingIncrementMs: number };
  storage?: { resource: string; bytes: number; retentionMs: number };
}

export interface BudgetSession {
  id: string;
  ceiling: Money;
  cleanupAllowance: number;
  tokenLimit: number;
  timeLimitMs: number;
}

export interface BudgetObservation {
  money: Money;
  tokens: number;
  timeMs: number;
  source: string;
}

export interface BudgetReservation {
  id: string;
  sessionId: string;
  purpose: 'work' | 'teardown';
  estimate: BudgetEstimate;
  status: 'reserved' | 'settled' | 'released';
  observed?: BudgetObservation;
  releaseEvidence?: string;
}

export interface BudgetState {
  schemaVersion: 1;
  contributionId: string;
  sessions: BudgetSession[];
  reservations: BudgetReservation[];
}

export type BudgetErrorCode =
  | 'invalid_budget'
  | 'missing_rate'
  | 'ceiling_exceeded'
  | 'limit_exceeded'
  | 'corrupt_ledger'
  | 'missing_ledger'
  | 'identity_mismatch'
  | 'lock_timeout'
  | 'persistence_uncertain'
  | 'unknown_session'
  | 'unknown_reservation'
  | 'already_reconciled';

export class BudgetError extends Error {
  constructor(
    readonly code: BudgetErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'BudgetError';
  }
}
