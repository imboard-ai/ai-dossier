import { isPositiveId } from '../github/fork';
import { isGitHubLogin, isRepoName, isSafeRef, sameLogin } from '../github/handoff';
import { assertNoSecrets } from '../redaction';
import { isTimestamp, ReasonCode } from '../state';
import type { PolicyAssessment, PolicyCitation } from './classify';
import type { Eligibility } from './eligibility';
import { githubRecord, isGitHubActorLogin } from './github-values';

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
  eligibility: {
    readonly kind: 'eligible' | 'ineligible' | 'hand_off';
    readonly reasons: readonly string[];
  };
  assigned: boolean;
  ban?: PolicyCitation;
}
const ELIGIBILITY_REASONS: readonly string[] = Object.freeze([
  'private_repository',
  'archived_repository',
  'disabled_repository',
  'closed_issue',
  'pull_request',
  'locked_issue',
  'not_a_bug',
  'competing_assignee',
  'competing_fix',
  'own_pr_exists',
  'bug_unlabeled',
]);
function validActor(value: unknown): string {
  const { login, url } = githubRecord(value);
  if (!isGitHubActorLogin(login) || typeof url !== 'string') throw new Error();
  const expected = login.endsWith('[bot]')
    ? `https://github.com/apps/${login.slice(0, -5)}`
    : `https://github.com/${login}`;
  if (url.toLowerCase() !== expected.toLowerCase()) throw new Error();
  return login;
}
function eligibilityFacts(
  value: Eligibility,
  contributor: string
): { eligibility: GateFacts['eligibility']; assigned: boolean } {
  const e = githubRecord(value);
  const kind = e.kind;
  const reasons = e.reasons;
  if (
    (kind !== 'eligible' && kind !== 'ineligible' && kind !== 'hand_off') ||
    !Array.isArray(reasons) ||
    reasons.length > ELIGIBILITY_REASONS.length ||
    reasons.some((r) => typeof r !== 'string' || !ELIGIBILITY_REASONS.includes(r)) ||
    typeof e.evidenceDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(e.evidenceDigest)
  )
    throw new Error();
  const detachedReasons: string[] = [...reasons];
  const facts = githubRecord(e.facts);
  const {
    repositoryId,
    fullName,
    defaultBranch,
    public: isPublic,
    archived,
    disabled,
    contributor: boundContributor,
    pulls,
    events,
  } = facts;
  const repo = typeof fullName === 'string' ? fullName.split('/') : [];
  if (
    !isPositiveId(repositoryId) ||
    repo.length !== 2 ||
    !isGitHubLogin(repo[0]) ||
    !isRepoName(repo[1]) ||
    !isSafeRef(defaultBranch) ||
    typeof isPublic !== 'boolean' ||
    typeof archived !== 'boolean' ||
    typeof disabled !== 'boolean' ||
    !isGitHubLogin(boundContributor) ||
    !sameLogin(boundContributor, contributor) ||
    !Array.isArray(pulls) ||
    !Array.isArray(events)
  )
    throw new Error();
  const issue = githubRecord(facts.issue);
  const {
    number,
    url,
    state,
    locked,
    isPullRequest,
    author,
    authorAssociation,
    labels,
    assignees,
    createdAt,
  } = issue;
  if (
    !isPositiveId(number) ||
    typeof url !== 'string' ||
    url.toLowerCase() !==
      `https://github.com/${fullName}/${isPullRequest ? 'pull' : 'issues'}/${number}`.toLowerCase() ||
    (state !== 'open' && state !== 'closed') ||
    typeof locked !== 'boolean' ||
    typeof isPullRequest !== 'boolean' ||
    typeof authorAssociation !== 'string' ||
    !Array.isArray(labels) ||
    labels.some((l) => typeof l !== 'string') ||
    !Array.isArray(assignees) ||
    typeof createdAt !== 'string' ||
    !isTimestamp(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u.test(createdAt)
        ? `${createdAt.slice(0, -1)}.000Z`
        : createdAt
    )
  )
    throw new Error();
  validActor(author);
  const assigned = assignees.map(validActor);
  const add = (reason: string) => {
    if (!detachedReasons.includes(reason)) detachedReasons.push(reason);
  };
  if (assigned.some((a) => !sameLogin(a, contributor))) add('competing_assignee');
  for (const raw of pulls) {
    const pr = githubRecord(raw);
    if (
      !isPositiveId(pr.number) ||
      typeof pr.url !== 'string' ||
      typeof pr.fullName !== 'string' ||
      pr.url.toLowerCase() !==
        `https://github.com/${pr.fullName}/pull/${pr.number}`.toLowerCase() ||
      (pr.state !== 'open' && pr.state !== 'closed') ||
      typeof pr.merged !== 'boolean' ||
      (pr.merged && pr.state !== 'closed')
    )
      throw new Error();
    const who = validActor(pr.author);
    if (pr.state === 'open') add(sameLogin(who, contributor) ? 'own_pr_exists' : 'competing_fix');
  }
  const blocked =
    !isPublic || archived || disabled || state === 'closed' || locked || isPullRequest;
  if (blocked && kind === 'eligible') throw new Error();
  if (kind !== 'eligible' && !detachedReasons.length) throw new Error();
  const resolvedKind =
    kind === 'eligible' && detachedReasons.some((r) => r !== 'bug_unlabeled') ? 'hand_off' : kind;
  return {
    eligibility: { kind: resolvedKind, reasons: Object.freeze(detachedReasons) },
    assigned: assigned.some((a) => sameLogin(a, contributor)),
  };
}
interface GateRow {
  readonly id: string;
  readonly matches: (facts: GateFacts) => boolean;
  readonly decide: (facts: GateFacts) => GateDecision;
}

/** First matching row wins. No row performs I/O, emits a comment or changes state. */
export const GATE_ROWS: readonly GateRow[] = Object.freeze(
  (
    [
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
        matches: (f: GateFacts) =>
          f.policy.assignment === 'unclear' && f.policy.directPr === 'unclear',
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
    ] satisfies GateRow[]
  ).map((row) => Object.freeze(row))
);

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
    const flags = [
      policy.draftRequired,
      policy.receiptBlockAllowed,
      policy.baselineFailuresPermitted,
    ];
    if (
      flags.some((flag) => typeof flag !== 'boolean') ||
      !Array.isArray(policy.citations) ||
      policy.citations.length > 128
    )
      throw new Error();
    const citations = policy.citations.map((c) =>
      Object.freeze({ path: c.path, line: c.line, ruleId: c.ruleId, excerpt: c.excerpt })
    );
    for (const c of citations) {
      if (
        typeof c.path !== 'string' ||
        !c.path ||
        typeof c.ruleId !== 'string' ||
        !c.ruleId ||
        typeof c.excerpt !== 'string' ||
        !Number.isSafeInteger(c.line) ||
        c.line < 1
      )
        throw new Error();
      assertNoSecrets(c.path);
      assertNoSecrets(c.ruleId);
      assertNoSecrets(c.excerpt);
    }
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
    const snapshot = eligibilityFacts(eligibility, login);
    const e = snapshot.eligibility;
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
      assigned: snapshot.assigned,
      ban,
    };
    for (const row of GATE_ROWS) if (row.matches(facts)) return Object.freeze(row.decide(facts));
    throw new Error();
  } catch {
    return Object.freeze({ kind: 'hand_off', reasons: Object.freeze(['unknown_input']) });
  }
}
