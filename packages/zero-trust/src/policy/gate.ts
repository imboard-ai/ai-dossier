import { isGitHubLogin } from '../github/handoff';
import { assertNoSecrets } from '../redaction';
import { ReasonCode } from '../state';
import type { PolicyAssessment, PolicyCitation } from './classify';
import type { Eligibility } from './eligibility';

export type GateDecision =
  | {
      readonly kind: 'terminate';
      readonly reason: 'ai_banned';
      readonly citation: PolicyCitation;
      readonly reasonCode: ReasonCode.PolicyBlocked;
    }
  | {
      readonly kind: 'ineligible';
      readonly reasons: readonly string[];
      readonly reasonCode: ReasonCode.PolicyBlocked;
    }
  | { readonly kind: 'hand_off'; readonly reasons: readonly string[] }
  | { readonly kind: 'request_permission'; readonly reasonCode: ReasonCode.PermissionRequired }
  | { readonly kind: 'proceed' };

interface GateFacts {
  policy: PolicyAssessment;
  eligibility: Exclude<Eligibility, { kind: 'unknown' }>;
  assigned: boolean;
  ban?: PolicyCitation;
}

/** First matching row wins. No row performs I/O, emits a comment or changes state. */
export const GATE_ROWS = Object.freeze([
  {
    id: 'ai_banned',
    matches: (f: GateFacts) => f.policy.ai === 'banned',
    decide: (f: GateFacts): GateDecision =>
      f.ban
        ? {
            kind: 'terminate',
            reason: 'ai_banned',
            citation: f.ban,
            reasonCode: ReasonCode.PolicyBlocked,
          }
        : { kind: 'hand_off', reasons: ['ban_citation_missing'] },
  },
  {
    id: 'ineligible',
    matches: (f: GateFacts) => f.eligibility.kind === 'ineligible',
    decide: (f: GateFacts): GateDecision => ({
      kind: 'ineligible',
      reasons: Object.freeze([...f.eligibility.reasons]),
      reasonCode: ReasonCode.PolicyBlocked,
    }),
  },
  {
    id: 'policy_refused',
    matches: (f: GateFacts) => f.policy.reason !== undefined,
    decide: (): GateDecision => ({ kind: 'hand_off', reasons: ['policy_unknown'] }),
  },
  {
    id: 'eligibility_hand_off',
    matches: (f: GateFacts) => f.eligibility.kind === 'hand_off',
    decide: (f: GateFacts): GateDecision => ({
      kind: 'hand_off',
      reasons: Object.freeze([...f.eligibility.reasons]),
    }),
  },
  {
    id: 'ai_unclear',
    matches: (f: GateFacts) => f.policy.ai === 'unclear',
    decide: (): GateDecision => ({ kind: 'hand_off', reasons: ['ai_unclear'] }),
  },
  {
    id: 'ownership_unclear',
    matches: (f: GateFacts) => f.policy.assignment === 'unclear' && f.policy.directPr === 'unclear',
    decide: (): GateDecision => ({ kind: 'hand_off', reasons: ['ownership_unclear'] }),
  },
  {
    id: 'ai_approval',
    matches: (f: GateFacts) => f.policy.ai === 'requires_approval',
    decide: (): GateDecision => ({
      kind: 'request_permission',
      reasonCode: ReasonCode.PermissionRequired,
    }),
  },
  {
    id: 'assignment_required',
    matches: (f: GateFacts) => f.policy.assignment === 'required' && !f.assigned,
    decide: (): GateDecision => ({
      kind: 'request_permission',
      reasonCode: ReasonCode.PermissionRequired,
    }),
  },
  {
    id: 'discussion_first',
    matches: (f: GateFacts) => f.policy.directPr === 'discussion_first',
    decide: (): GateDecision => ({
      kind: 'request_permission',
      reasonCode: ReasonCode.PermissionRequired,
    }),
  },
  {
    id: 'proceed',
    matches: (): boolean => true,
    decide: (): GateDecision => ({ kind: 'proceed' }),
  },
]);

/** Assessed, controller-owned inputs only; malformed/unknown inputs never pass. */
export function decideGate(
  policy: PolicyAssessment,
  eligibility: Eligibility,
  contributor: string
): GateDecision {
  try {
    const login = contributor;
    const ai = policy.ai;
    const assignment = policy.assignment;
    const directPr = policy.directPr;
    const reason = policy.reason;
    const citations = policy.citations.map((c) =>
      Object.freeze({ path: c.path, line: c.line, ruleId: c.ruleId, excerpt: c.excerpt })
    );
    if (
      !isGitHubLogin(login) ||
      ![
        'banned',
        'requires_approval',
        'disclosure_required',
        'welcomed',
        'silent',
        'unclear',
      ].includes(ai) ||
      !['required', 'not_required', 'unclear'].includes(assignment) ||
      !['welcomed', 'discussion_first', 'unclear'].includes(directPr) ||
      (reason !== undefined && reason !== 'budget' && reason !== 'ledger') ||
      !['eligible', 'ineligible', 'hand_off'].includes(eligibility.kind)
    )
      throw new Error();
    if (eligibility.kind === 'unknown') throw new Error();
    if (
      !Array.isArray(eligibility.reasons) ||
      eligibility.reasons.some((r) => typeof r !== 'string') ||
      eligibility.facts.contributor.toLowerCase() !== login.toLowerCase()
    )
      throw new Error();
    const assignees = eligibility.facts.issue.assignees.map((a) => a.login);
    if (assignees.some((a) => !isGitHubLogin(a))) throw new Error();
    // Even a contradictory caller-supplied eligible snapshot cannot erase ownership.
    const competing = assignees.some((a) => a.toLowerCase() !== login.toLowerCase());
    const e =
      competing && eligibility.kind === 'eligible'
        ? { ...eligibility, kind: 'hand_off' as const, reasons: ['competing_assignee' as const] }
        : eligibility;
    const ban = citations.find(
      (c) =>
        (c.ruleId === 'ai-ban-1' || c.ruleId.startsWith('decision:policy-ai@')) &&
        typeof c.path === 'string' &&
        c.path.length > 0 &&
        Number.isSafeInteger(c.line) &&
        c.line > 0 &&
        typeof c.excerpt === 'string' &&
        c.excerpt.length > 0
    );
    assertNoSecrets(
      JSON.stringify({ ai, assignment, directPr, reason, citations, reasons: e.reasons })
    );
    const facts: GateFacts = {
      policy: { ...policy, ai, assignment, directPr, reason, citations },
      eligibility: e,
      assigned: assignees.some((a) => a.toLowerCase() === login.toLowerCase()),
      ban,
    };
    for (const row of GATE_ROWS) if (row.matches(facts)) return Object.freeze(row.decide(facts));
    throw new Error();
  } catch {
    return Object.freeze({ kind: 'hand_off', reasons: Object.freeze(['unknown_input']) });
  }
}
