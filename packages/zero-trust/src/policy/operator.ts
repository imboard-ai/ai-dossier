import { assertSecretFree } from '../redaction';
import { isRecord } from '../state';
import type { PolicyAssessment } from './classify';

/** Gate hand-offs an operator decision may answer. Unreadable policy, ambiguous
 * templates and eligibility hand-offs stay manual: there is no reading to correct. */
export const OPERATOR_POLICY_REASONS = Object.freeze([
  'ai_unclear',
  'ownership_unclear',
  'operator_policy_stale',
] as const);

/** Values a human may record. `banned` is absent on purpose: a decision can only
 * resolve `unclear`, never relax or tighten a reading the floor or model settled. */
export const OPERATOR_POLICY_VALUES = Object.freeze({
  ai: Object.freeze(['welcomed', 'disclosure_required', 'requires_approval'] as const),
  assignment: Object.freeze(['required', 'not_required'] as const),
  directPr: Object.freeze(['welcomed', 'discussion_first'] as const),
});
export type OperatorPolicyDimension = keyof typeof OPERATOR_POLICY_VALUES;
export type OperatorPolicyDecisions = {
  readonly [D in OperatorPolicyDimension]?: (typeof OPERATOR_POLICY_VALUES)[D][number];
};

export interface OperatorPolicy {
  readonly decisions: OperatorPolicyDecisions;
  /** Why, in the operator's words; should cite the policy path:line it relies on. */
  readonly note: string;
  /** GitHub login of the contributor who recorded the decision. */
  readonly operator: string;
  /** Policy input digest of the assessment this decision answers. */
  readonly inputDigest: string;
}

export const MAX_OPERATOR_POLICY_NOTE = 1000;

export class OperatorPolicyError extends Error {
  constructor(readonly code: 'invalid_policy_decision') {
    super(`Operator policy decision refused (${code})`);
  }
}

const refuse = (): never => {
  throw new OperatorPolicyError('invalid_policy_decision');
};

/** Closed decisions in canonical dimension order; any other key or value is refused. */
function checkDecisions(value: Record<string, unknown>): OperatorPolicyDecisions {
  const keys = Object.keys(value);
  if (!keys.length) refuse();
  const decisions: Record<string, string> = {};
  for (const dimension of Object.keys(OPERATOR_POLICY_VALUES) as OperatorPolicyDimension[]) {
    if (!Object.hasOwn(value, dimension)) continue;
    const v = value[dimension];
    if (
      typeof v !== 'string' ||
      !(OPERATOR_POLICY_VALUES[dimension] as readonly string[]).includes(v)
    )
      refuse();
    decisions[dimension] = v as string;
  }
  if (Object.keys(decisions).length !== keys.length) refuse();
  return Object.freeze(decisions) as OperatorPolicyDecisions;
}

/** `ai=welcomed,directPr=welcomed` → closed decisions; duplicate or unknown keys are refused. */
export function parseOperatorPolicy(spec: string): OperatorPolicyDecisions {
  const decisions: Record<string, string> = {};
  for (const pair of spec.split(',')) {
    const [dimension, value, extra] = pair.split('=');
    if (extra !== undefined || value === undefined || Object.hasOwn(decisions, dimension)) refuse();
    decisions[dimension] = value;
  }
  return checkDecisions(decisions);
}

export function validateOperatorPolicy(value: unknown): OperatorPolicy {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'decisions,inputDigest,note,operator' ||
    !isRecord(value.decisions) ||
    typeof value.note !== 'string' ||
    typeof value.operator !== 'string' ||
    typeof value.inputDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.inputDigest) ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(value.operator)
  )
    refuse();
  const record = value as Record<string, unknown> & { decisions: Record<string, unknown> };
  const note = (record.note as string).trim();
  if (!note || note !== record.note || Array.from(note).length > MAX_OPERATOR_POLICY_NOTE) refuse();
  assertSecretFree(note);
  return Object.freeze({
    decisions: checkDecisions(record.decisions),
    note,
    operator: record.operator as string,
    inputDigest: record.inputDigest as string,
  });
}

/** Every answer recorded against `inputDigest`, merged in journal order (a later answer
 * to the same dimension wins), or undefined when none was recorded for this input. */
export function mergeOperatorPolicies(
  policies: readonly OperatorPolicy[],
  inputDigest: string
): OperatorPolicy | undefined {
  const matching = policies.filter((policy) => policy.inputDigest === inputDigest);
  if (!matching.length) return undefined;
  return Object.freeze({
    decisions: checkDecisions(Object.assign({}, ...matching.map((policy) => policy.decisions))),
    note: matching.map((policy) => policy.note).join(' | '),
    operator: (matching.at(-1) as OperatorPolicy).operator,
    inputDigest,
  });
}

/** The digest every model decision of one assessment shares, or undefined when no
 * dimension was decided (floor ban, unreadable input): nothing to bind a decision to. */
export function assessmentInputDigest(assessment: PolicyAssessment): string | undefined {
  const digests = new Set(
    Object.values(assessment.decisions ?? {}).flatMap((decision) =>
      decision?.inputDigest ? [decision.inputDigest] : []
    )
  );
  return digests.size === 1 ? [...digests][0] : undefined;
}

/** Replace only `unclear` dimensions. A banned assessment and any dimension the
 * floor or model already settled are returned untouched. An `unclear` AI reading that
 * the floor escalated over possible ban wording is exactly what a human may answer:
 * only a deterministic `banned` result is final. */
export function applyOperatorPolicy(
  assessment: PolicyAssessment,
  policy: OperatorPolicy
): { readonly assessment: PolicyAssessment; readonly applied: readonly OperatorPolicyDimension[] } {
  if (assessment.ai === 'banned') return { assessment, applied: [] };
  const next: Record<string, unknown> = { ...assessment };
  const applied: OperatorPolicyDimension[] = [];
  for (const [dimension, value] of Object.entries(policy.decisions) as [
    OperatorPolicyDimension,
    string,
  ][]) {
    if (assessment[dimension] !== 'unclear') continue;
    next[dimension] = value;
    applied.push(dimension);
  }
  return { assessment: Object.freeze(next) as unknown as PolicyAssessment, applied };
}
