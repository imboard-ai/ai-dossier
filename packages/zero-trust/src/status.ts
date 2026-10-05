import { assertNoSecrets } from './redaction';
import {
  isNonemptyString,
  isReasonCode,
  isRecord,
  isRunState,
  type ReasonCode,
  type RunState,
} from './state';

export interface MoneyEstimate {
  readonly amount: number;
  readonly currency: string;
}

/** §5.1 status facts. Money is estimated, time is active milliseconds (not waits). */
export interface StatusRecord {
  readonly runId: string;
  readonly phase: string;
  readonly state: RunState;
  readonly upstreamIssue: string;
  readonly contributor: string;
  readonly candidateSha?: string;
  readonly activeTimeMs: number;
  readonly estimatedSpend: MoneyEstimate;
  readonly budgetRemaining: MoneyEstimate;
  readonly reasonCode: ReasonCode;
  readonly nextPermittedAction: string;
}

export class InvalidStatusError extends Error {
  constructor() {
    super('Invalid zero-trust status record');
    this.name = 'InvalidStatusError';
  }
}

function isAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function money(value: unknown): MoneyEstimate {
  if (!isRecord(value)) throw new InvalidStatusError();
  const amount = value.amount;
  const currency = value.currency;
  if (typeof currency === 'string') assertNoSecrets(currency);
  if (!isAmount(amount) || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))
    throw new InvalidStatusError();
  return { amount, currency };
}

function safeStatus(input: StatusRecord): StatusRecord {
  if (!isRecord(input)) throw new InvalidStatusError();
  // Read each fact once: getters cannot swap a validated value before rendering.
  const value = {
    runId: input.runId,
    phase: input.phase,
    state: input.state,
    upstreamIssue: input.upstreamIssue,
    contributor: input.contributor,
    candidateSha: input.candidateSha,
    activeTimeMs: input.activeTimeMs,
    estimatedSpend: input.estimatedSpend,
    budgetRemaining: input.budgetRemaining,
    reasonCode: input.reasonCode,
    nextPermittedAction: input.nextPermittedAction,
  };
  // Inspect actual strings (JSON escapes whitespace), never invoke input toJSON.
  // Unknown properties are stripped rather than visited or serialized.
  for (const field of Object.values(value)) {
    if (typeof field === 'string') assertNoSecrets(field);
  }
  if (
    !isNonemptyString(value.runId) ||
    !isNonemptyString(value.phase) ||
    !isRunState(value.state) ||
    !isNonemptyString(value.upstreamIssue) ||
    !isNonemptyString(value.contributor) ||
    !isAmount(value.activeTimeMs) ||
    !isReasonCode(value.reasonCode) ||
    !isNonemptyString(value.nextPermittedAction) ||
    (value.candidateSha !== undefined &&
      (typeof value.candidateSha !== 'string' ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.candidateSha)))
  )
    throw new InvalidStatusError();
  const estimatedSpend = money(value.estimatedSpend);
  const budgetRemaining = money(value.budgetRemaining);
  if (estimatedSpend.currency !== budgetRemaining.currency) throw new InvalidStatusError();
  return {
    runId: value.runId,
    phase: value.phase,
    state: value.state,
    upstreamIssue: value.upstreamIssue,
    contributor: value.contributor,
    ...(value.candidateSha === undefined ? {} : { candidateSha: value.candidateSha }),
    activeTimeMs: value.activeTimeMs,
    estimatedSpend,
    budgetRemaining,
    reasonCode: value.reasonCode,
    nextPermittedAction: value.nextPermittedAction,
  };
}

export function renderJson(status: StatusRecord): string {
  return JSON.stringify(safeStatus(status), null, 2);
}

/** Quoted values keep untrusted newlines/control characters from spoofing lines. */
export function renderHuman(status: StatusRecord): string {
  return Object.entries(safeStatus(status))
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n');
}
