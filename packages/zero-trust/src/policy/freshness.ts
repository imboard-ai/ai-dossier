import { isCommitSha } from '../github/fork-ref';
import { isGitHubLogin, isSafeRef, issueBinding, sameLogin } from '../github/handoff';
import type { GitHubRead } from '../github/reconcile';
import { canonicalJson } from '../receipt/schema';
import { assertNoSecrets } from '../redaction';
import { classifyPolicy, type PolicyAssessment, policyDigest } from './classify';
import { discoverPolicy } from './discover';
import { assessIssue } from './eligibility';
import { decideGate } from './gate';
import { githubPositiveId, githubRecord } from './github-values';
import { checkInvitation, type InvitationEvidence } from './invitation';

export type FreshnessReason =
  | 'policy_changed'
  | 'issue_closed'
  | 'assignment_changed'
  | 'competing_fix'
  | 'invitation_revoked'
  | 'issue_ineligible';

export interface FreshnessDeps {
  readonly read: GitHubRead;
  readonly upstream: { readonly owner: string; readonly repo: string; readonly issue: number };
  readonly contributor: string;
  readonly gated: {
    readonly policyDigest: string;
    readonly policy: PolicyAssessment;
    readonly eligibilityDigest: string;
    readonly invitation?: InvitationEvidence;
  };
  readonly ownPr?: { readonly number: number };
}

export interface FreshnessReport {
  readonly fresh: boolean;
  readonly reasons: readonly FreshnessReason[];
  readonly head: string;
  readonly policyDigest: string;
  readonly eligibilityDigest: string;
  readonly policy: PolicyAssessment;
}

/** No upstream text or transport errors are exposed by the admission seam. */
export class FreshnessUnavailableError extends Error {
  constructor() {
    super('Permission freshness unavailable');
    this.name = 'FreshnessUnavailableError';
  }
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error();
  return value;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Read-only just-in-time permission observation. Each call reads anew; no retry,
 * transition, journal, credential, model call or upstream write is performed. */
export function createFreshnessProbe(deps: FreshnessDeps): {
  check(): Promise<FreshnessReport>;
  policyFresh(): Promise<boolean>;
} {
  let read: GitHubRead;
  let snapshot: Omit<FreshnessDeps, 'read'>;
  try {
    read = deps.read;
    if (typeof read !== 'function') throw new Error();
    // Detach before any await, including nested policy and invitation evidence.
    const { upstream, contributor, gated, ownPr } = deps;
    const encoded = canonicalJson({ upstream, contributor, gated, ...(ownPr ? { ownPr } : {}) });
    assertNoSecrets(encoded);
    snapshot = freeze(JSON.parse(encoded) as Omit<FreshnessDeps, 'read'>);
    const binding = issueBinding({ upstream: snapshot.upstream, issue: snapshot.upstream.issue });
    if (!isGitHubLogin(snapshot.contributor)) throw new Error();
    digest(snapshot.gated.policyDigest);
    digest(snapshot.gated.eligibilityDigest);
    if (snapshot.ownPr !== undefined) githubPositiveId(snapshot.ownPr.number);
    if (snapshot.gated.invitation) {
      const invitation = snapshot.gated.invitation;
      digest(invitation.policyDigest);
      if (invitation.policyDigest !== snapshot.gated.policyDigest) throw new Error();
      // checkInvitation validates the timestamp and URL before its first read.
      if (!isGitHubLogin(invitation.actor) || typeof invitation.association !== 'string')
        throw new Error();
    }
    snapshot = freeze({ ...snapshot, upstream: { ...binding.upstream, issue: binding.issue } });
  } catch {
    throw new FreshnessUnavailableError();
  }

  async function check(): Promise<FreshnessReport> {
    try {
      const { upstream, contributor, gated, ownPr } = snapshot;
      const eligibility = await assessIssue(read, upstream, contributor);
      if (eligibility.kind === 'unknown') throw new Error();
      // Also validate the controller's assessed policy; malformed inputs never permit.
      const gate = decideGate(gated.policy, eligibility, contributor);
      if (gate.kind === 'hand_off' && gate.reasons.includes('unknown_input')) throw new Error();
      const branch = eligibility.facts.defaultBranch;
      if (!isSafeRef(branch)) throw new Error();
      const prefix = `/repos/${encodeURIComponent(upstream.owner)}/${encodeURIComponent(upstream.repo)}`;
      const response = await read(`${prefix}/git/ref/heads/${encodeURIComponent(branch)}`);
      if (response.status !== 200) throw new Error();
      const ref = githubRecord(response.body);
      const object = githubRecord(ref.object);
      if (
        ref.ref !== `refs/heads/${branch}` ||
        object.type !== 'commit' ||
        !isCommitSha(object.sha)
      )
        throw new Error();
      const head = object.sha;
      const discovered = await discoverPolicy(read, { ...upstream, ref: head });
      if (discovered.kind === 'unknown') throw new Error();
      // The gated assessment includes typed decisions. It may only survive when
      // its digest still binds exactly the newly read policy file identities.
      const unchanged = policyDigest(gated.policy, discovered.files) === gated.policyDigest;
      const policy = unchanged ? gated.policy : classifyPolicy(discovered.files);
      const currentDigest = unchanged ? gated.policyDigest : policyDigest(policy, discovered.files);
      const reasons: FreshnessReason[] = [];
      if (
        policy.ai === 'banned' ||
        policy.ai === 'unclear' ||
        policy.reason !== undefined ||
        ((policy.ai === 'requires_approval' || policy.directPr === 'discussion_first') &&
          !gated.invitation)
      )
        reasons.push('policy_changed');
      const facts = eligibility.facts;
      if (facts.issue.state === 'closed' || facts.issue.locked) reasons.push('issue_closed');
      if (
        facts.issue.assignees.some((a) => !sameLogin(a.login, contributor)) ||
        (policy.assignment === 'required' &&
          !facts.issue.assignees.some((a) => sameLogin(a.login, contributor)))
      )
        reasons.push('assignment_changed');
      if (
        facts.pulls.some(
          (pr) =>
            pr.state === 'open' &&
            !pr.merged &&
            !sameLogin(pr.author.login, contributor) &&
            // A numeric collision in a different repository is not our PR.
            !(
              ownPr &&
              pr.number === ownPr.number &&
              pr.fullName.toLowerCase() === facts.fullName.toLowerCase() &&
              sameLogin(pr.author.login, contributor)
            )
        )
      )
        reasons.push('competing_fix');
      if (
        !facts.public ||
        facts.archived ||
        facts.disabled ||
        facts.issue.isPullRequest ||
        eligibility.reasons.includes('not_a_bug')
      )
        reasons.push('issue_ineligible');
      if (gated.invitation) {
        const invitation = await checkInvitation(
          read,
          { upstream, issue: upstream.issue },
          {
            engagementCommentUrl: gated.invitation.url,
            engagementAt: gated.invitation.at,
            contributor,
            issueAuthor: facts.issue.author.login,
            policy: { digest: currentDigest, issueAuthorMayInvite: false },
            persist: () => {},
          }
        );
        if (invitation.kind === 'unknown' || invitation.kind === 'ambiguous') throw new Error();
        if (invitation.kind === 'declined') reasons.push('invitation_revoked');
      }
      return freeze({
        fresh: reasons.length === 0,
        reasons,
        head,
        policyDigest: currentDigest,
        eligibilityDigest: eligibility.evidenceDigest,
        policy,
      });
    } catch {
      throw new FreshnessUnavailableError();
    }
  }

  return Object.freeze({ check, policyFresh: async () => (await check()).fresh });
}
