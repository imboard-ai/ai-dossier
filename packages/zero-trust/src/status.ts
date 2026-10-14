import Ajv from 'ajv';
import { validateAuthorApproval } from './controller/config';
import type { PolicyAssessment } from './policy/classify';
import { canonicalJson } from './receipt/schema';
import { assertNoSecrets, assertSecretFree } from './redaction';
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
  /** Observed policy diagnostics, never admission or publication authority. */
  readonly policyGate?: {
    readonly baseSha: string;
    readonly reasons: readonly string[];
    readonly assessment: PolicyAssessment;
  };
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
  readonly authorApproval?: {
    readonly userId: number;
    readonly login: string;
    readonly name: string;
    readonly email: string;
    readonly source: 'default' | 'override';
    readonly approvedAt: string;
  };
}

export class InvalidStatusError extends Error {
  constructor() {
    super('Invalid zero-trust status record');
    this.name = 'InvalidStatusError';
  }
}

const text = { type: 'string' };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});
const citation = object({ sourceId: text, line: { type: 'integer', minimum: 1 }, quote: text });
const decision = object({
  status: { enum: ['accepted', 'escalated'] },
  reason: {
    enum: [
      'accepted',
      'budget',
      'ledger',
      'invalid_pass',
      'provider',
      'confidence',
      'disagreement',
      'floor',
      'secret',
      'cache',
      'cache_write',
      'configuration',
      'aborted',
      'input',
    ],
  },
  value: { type: ['string', 'boolean'] },
  confidence: text,
  provider: text,
  model: text,
  questionVersion: text,
  questionDigest: text,
  inputDigest: text,
  citations: { type: 'array', items: citation },
  citationDigest: text,
});
const validatePolicyGate = new Ajv({ strict: false }).compile(
  object({
    baseSha: { type: 'string', pattern: '^[a-f0-9]{40}$' },
    reasons: { type: 'array', items: { type: 'string', pattern: '^[a-z_]{1,64}$' } },
    assessment: object(
      {
        ai: {
          enum: [
            'banned',
            'requires_approval',
            'disclosure_required',
            'welcomed',
            'silent',
            'unclear',
          ],
        },
        assignment: { enum: ['required', 'not_required', 'unclear'] },
        directPr: { enum: ['welcomed', 'discussion_first', 'unclear'] },
        draftRequired: { type: 'boolean' },
        receiptBlockAllowed: { type: 'boolean' },
        baselineFailuresPermitted: { type: 'boolean' },
        citations: {
          type: 'array',
          items: object({
            path: text,
            line: { type: 'integer', minimum: 1 },
            ruleId: text,
            excerpt: text,
          }),
        },
        reason: { enum: ['budget', 'ledger'] },
        decisions: object(
          Object.fromEntries(
            [
              'ai',
              'assignment',
              'directPr',
              'draftRequired',
              'receiptBlockAllowed',
              'baselineFailuresPermitted',
            ].map((dimension) => [dimension, decision])
          ),
          []
        ),
      },
      [
        'ai',
        'assignment',
        'directPr',
        'draftRequired',
        'receiptBlockAllowed',
        'baselineFailuresPermitted',
        'citations',
      ]
    ),
  })
);

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
    authorApproval: input.authorApproval,
    policyGate: input.policyGate,
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
  let authorApproval: StatusRecord['authorApproval'];
  if (value.authorApproval !== undefined) {
    const a = value.authorApproval;
    if (!isRecord(a)) throw new InvalidStatusError();
    const held = {
      userId: a.userId,
      login: a.login,
      name: a.name,
      email: a.email,
      source: a.source,
      approvedAt: a.approvedAt,
    };
    for (const fact of Object.values(held)) if (typeof fact === 'string') assertNoSecrets(fact);
    try {
      authorApproval = validateAuthorApproval(held, value.contributor);
    } catch {
      throw new InvalidStatusError();
    }
  }
  if (estimatedSpend.currency !== budgetRemaining.currency) throw new InvalidStatusError();
  let policyGate: StatusRecord['policyGate'];
  if (value.policyGate !== undefined) {
    // Canonical descriptor snapshot rejects getters/toJSON and bounds allocation.
    // Scan the detached primitive strings before JSON quoting can hide whitespace.
    const held = JSON.parse(canonicalJson(value.policyGate, 1024 * 1024));
    assertSecretFree(held);
    if (!validatePolicyGate(held)) throw new InvalidStatusError();
    policyGate = held as StatusRecord['policyGate'];
  }
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
    ...(authorApproval === undefined ? {} : { authorApproval }),
    ...(policyGate === undefined ? {} : { policyGate }),
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
