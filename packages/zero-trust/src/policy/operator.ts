import { assertSecretFree } from '../redaction';
import { isRecord } from '../state';
import type { PolicyAssessment } from './classify';

/** Gate hand-offs an operator decision may answer. Unreadable policy, ambiguous
 * templates and eligibility hand-offs stay manual: there is no reading to correct. */
export const OPERATOR_POLICY_REASONS = Object.freeze(['ai_unclear', 'ownership_unclear'] as const);

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

/** `ai=welcomed,directPr=welcomed` → closed decisions; duplicate or unknown keys are refused. */
export function parseOperatorPolicy(spec: string): OperatorPolicyDecisions {
  const decisions: Record<string, string> = {};
  for (const pair of spec.split(',')) {
    const [dimension, value, extra] = pair.split('=');
    if (
      extra !== undefined ||
      !Object.hasOwn(OPERATOR_POLICY_VALUES, dimension) ||
      Object.hasOwn(decisions, dimension) ||
      !(OPERATOR_POLICY_VALUES[dimension as OperatorPolicyDimension] as readonly string[]).includes(
        value
      )
    )
      refuse();
    decisions[dimension] = value;
  }
  return Object.freeze(decisions) as OperatorPolicyDecisions;
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
  const entries = Object.entries(record.decisions);
  if (!entries.length) refuse();
  const spec = entries.map(([dimension, v]) => `${dimension}=${String(v)}`).join(',');
  if (entries.some(([, v]) => typeof v !== 'string')) refuse();
  return Object.freeze({
    decisions: parseOperatorPolicy(spec),
    note,
    operator: record.operator as string,
    inputDigest: record.inputDigest as string,
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
 * floor or model already settled are returned untouched. */
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
