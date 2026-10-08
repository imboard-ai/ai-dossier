import type { ContributionEvidence } from './evidence';

export const text = { type: 'string', maxLength: 8192 };
export const sha = { type: 'string', pattern: '^[a-f0-9]{40}$' };
export const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
export const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] });
export const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const number = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
export const outcome = { enum: ['unknown', 'awaiting_review', 'merged', 'declined', 'blocked'] };
export const portableFields = {
  upstreamIssue: text,
  pr: nullable(text),
  verifiedSha: nullable(sha),
  outcomeSha: nullable(sha),
  outcome,
  costTotals: nullable({
    type: 'array',
    maxItems: 128,
    items: object({
      sessionId: text,
      currency: { type: 'string', pattern: '^[A-Z]{3}$' },
      spent: number,
      reserved: number,
      tokens: number,
      timeMs: number,
    }),
  }),
};
/** Deliberate allowlist: never spread internal source hashes/evidence into public facts. */
export function portableFacts(facts: ContributionEvidence) {
  return {
    upstreamIssue: facts.upstreamIssue,
    pr: facts.pr,
    verifiedSha: facts.verifiedSha,
    outcomeSha: facts.outcomeSha,
    outcome: facts.outcome,
    costTotals: facts.costTotals,
  };
}
