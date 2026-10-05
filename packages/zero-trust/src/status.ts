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
  if (
    !isRecord(value) ||
    !isAmount(value.amount) ||
    typeof value.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(value.currency)
  )
    throw new InvalidStatusError();
  return { amount: value.amount, currency: value.currency };
}

function safeStatus(value: StatusRecord): StatusRecord {
  if (!isRecord(value)) throw new InvalidStatusError();
  // Inspect actual strings (JSON escapes whitespace), never invoke input toJSON.
  // Unknown properties are stripped rather than visited or serialized.
  for (const key of [
    'runId',
    'phase',
    'state',
    'upstreamIssue',
    'contributor',
    'candidateSha',
    'reasonCode',
    'nextPermittedAction',
  ]) {
    const field = value[key];
    if (typeof field === 'string') assertNoSecrets(field);
  }
  for (const field of [value.estimatedSpend, value.budgetRemaining]) {
    if (isRecord(field) && typeof field.currency === 'string') assertNoSecrets(field.currency);
  }
  if (
    !isRecord(value) ||
    !isNonemptyString(value.runId) ||
    !isNonemptyString(value.phase) ||
    !isRunState(value.state) ||
    !isNonemptyString(value.upstreamIssue) ||
    !isNonemptyString(value.contributor) ||
    !isAmount(value.activeTimeMs) ||
    !isReasonCode(value.reasonCode) ||
    !isNonemptyString(value.nextPermittedAction) ||
    (value.candidateSha !== undefined &&
      (typeof value.candidateSha !== 'string' || !/^[a-f0-9]{40,64}$/.test(value.candidateSha)))
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
