import { isTrustedAuthorAssociation } from '@ai-dossier/core';
import {
  type IssueBinding,
  isGitHubLogin,
  issueBinding,
  issueUrl,
  MAX_BODY_LENGTH,
  sameLogin,
} from '../github/handoff';
import type { GitHubRead } from '../github/reconcile';
import { assertNoSecrets } from '../redaction';
import { isTimestamp, ReasonCode } from '../state';
import {
  githubActor,
  githubArray,
  isGitHubActorLogin,
  githubPositiveId as positive,
  githubRecord as record,
} from './github-values';

export const INVITATION_PAGE_LIMIT = 10;
export const INVITATION_PAGE_SIZE = 100;
export interface InvitationPolicy {
  /** Digest of the current assessed repository policy, supplied by the controller. */
  readonly digest: string;
  /** Explicit repository rule, never inferred from issue/comment authorship. */
  readonly issueAuthorMayInvite: boolean;
}
export interface InvitationEvidence {
  readonly actor: string;
  readonly association: string;
  readonly url: string;
  readonly policyDigest: string;
  readonly at: string;
}
export interface InvitationOptions {
  readonly engagementCommentUrl: string;
  readonly engagementAt: string;
  readonly contributor: string;
  readonly issueAuthor: string;
  readonly policy: InvitationPolicy;
  readonly persist: (evidence: InvitationEvidence) => void | Promise<void>;
}
export type InvitationResult =
  | {
      readonly kind: 'invited';
      readonly evidence: InvitationEvidence;
      readonly reasonCode: ReasonCode.MaintainerInvited;
    }
  | {
      readonly kind: 'declined';
      readonly url: string;
      readonly reasonCode: ReasonCode.UpstreamDeclined;
    }
  | { readonly kind: 'ambiguous'; readonly url: string }
  | { readonly kind: 'waiting' | 'unknown' };

const ASSOCIATIONS = new Set([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
  'CONTRIBUTOR',
  'FIRST_TIME_CONTRIBUTOR',
  'FIRST_TIMER',
  'NONE',
  'MANNEQUIN',
]);
/** Entire message only: quotes, negation, plans, caveats and mixed prose never invite. */
export const INVITATION_RULES = Object.freeze({
  affirmative:
    "^(?:go ahead|pr welcome|prs welcome|a pr is welcome|feel free(?: to (?:submit|open) (?:a |the )?pr)?|assigned you|you(?:'re| are) assigned)[.!]?$",
  negative:
    "^(?:not accepting(?: (?:prs|contributions))?|no ai|won't fix|will not fix|please do not (?:proceed|submit (?:a )?pr)|do not proceed)[.!]?$",
});
const affirmative = new RegExp(INVITATION_RULES.affirmative, 'iu');
const negative = new RegExp(INVITATION_RULES.negative, 'iu');

function timestamp(value: unknown): string {
  if (typeof value !== 'string') throw new Error();
  const canonical = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u.test(value)
    ? `${value.slice(0, -1)}.000Z`
    : value;
  if (!isTimestamp(canonical)) throw new Error();
  return canonical;
}
function actor(value: unknown): string {
  return githubActor(value).login;
}
interface Observation {
  kind: 'invited' | 'declined' | 'ambiguous';
  evidence: InvitationEvidence;
}

/** One bounded observation per explicit resume. No polling, transitions or upstream writes. */
export async function checkInvitation(
  read: GitHubRead,
  binding: IssueBinding,
  options: InvitationOptions
): Promise<InvitationResult> {
  try {
    const b = issueBinding(binding);
    const { engagementCommentUrl, engagementAt, contributor, issueAuthor, persist } = options;
    const rawPolicy = options.policy;
    const policy = Object.freeze({
      digest: rawPolicy.digest,
      issueAuthorMayInvite: rawPolicy.issueAuthorMayInvite,
    });
    const since = timestamp(engagementAt);
    if (
      !isGitHubLogin(contributor) ||
      !isGitHubActorLogin(issueAuthor) ||
      typeof policy.digest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(policy.digest) ||
      typeof policy.issueAuthorMayInvite !== 'boolean' ||
      typeof persist !== 'function'
    )
      throw new Error();
    const commentPrefix = `${issueUrl(b)}#issuecomment-`;
    if (
      typeof engagementCommentUrl !== 'string' ||
      !engagementCommentUrl.toLowerCase().startsWith(commentPrefix.toLowerCase()) ||
      !/^[1-9]\d*$/u.test(engagementCommentUrl.slice(commentPrefix.length))
    )
      throw new Error();
    const path = `/repos/${encodeURIComponent(b.upstream.owner)}/${encodeURIComponent(b.upstream.repo)}/issues/${b.issue}`;
    const observations: Observation[] = [];
    const identities = new Set<string>();
    async function pages(kind: 'comments' | 'timeline'): Promise<void> {
      for (let page = 1; page <= INVITATION_PAGE_LIMIT; page++) {
        const response = await read(
          `${path}/${kind}?per_page=${INVITATION_PAGE_SIZE}&page=${page}`
        );
        if (response.status !== 200) throw new Error();
        const bodyPage = githubArray(response.body, INVITATION_PAGE_SIZE);
        // Decode the entire page synchronously, retaining only detached primitives across awaits.
        const count = bodyPage.length;
        for (const raw of bodyPage) {
          const r = record(raw);
          if (kind === 'timeline' && r.event !== 'assigned' && r.event !== 'unassigned') {
            if (typeof r.event !== 'string') throw new Error();
            continue;
          }
          const id = positive(r.id);
          const identity = `${kind}:${id}`;
          if (identities.has(identity)) throw new Error();
          identities.add(identity);
          const at = timestamp(r.created_at);
          const who = actor(kind === 'comments' ? r.user : r.actor);
          let association: string;
          let url: string;
          let result: Observation['kind'];
          if (kind === 'comments') {
            const body = r.body;
            const a = r.author_association;
            url = r.html_url as string;
            if (
              typeof body !== 'string' ||
              body.length > MAX_BODY_LENGTH ||
              typeof a !== 'string' ||
              !ASSOCIATIONS.has(a) ||
              typeof url !== 'string' ||
              url.toLowerCase() !== `${commentPrefix}${id}`.toLowerCase()
            )
              throw new Error();
            const expectedRest = {
              issue_url: `https://api.github.com${path}`,
              url: `https://api.github.com/repos/${b.upstream.owner}/${b.upstream.repo}/issues/comments/${id}`,
            };
            for (const [key, expected] of Object.entries(expectedRest)) {
              const identity = r[key];
              if (
                identity !== undefined &&
                (typeof identity !== 'string' || identity.toLowerCase() !== expected.toLowerCase())
              )
                throw new Error();
            }
            assertNoSecrets(body);
            association = a;
            const authorized =
              isGitHubLogin(who) &&
              (isTrustedAuthorAssociation(a) ||
                (policy.issueAuthorMayInvite && sameLogin(who, issueAuthor)));
            // The engagement itself is never its own answer, even if edited later.
            if (
              !authorized ||
              sameLogin(who, contributor) ||
              url.toLowerCase() === engagementCommentUrl.toLowerCase() ||
              at <= since
            )
              continue;
            if (timestamp(r.updated_at) !== at) {
              result = 'ambiguous';
            } else {
              const text = body.trim();
              result = affirmative.test(text)
                ? 'invited'
                : negative.test(text)
                  ? 'declined'
                  : 'ambiguous';
            }
          } else {
            const assignee = actor(r.assignee);
            const apiUrl = `https://api.github.com/repos/${b.upstream.owner}/${b.upstream.repo}/issues/events/${id}`;
            if (typeof r.url !== 'string' || r.url.toLowerCase() !== apiUrl.toLowerCase())
              throw new Error();
            if (at <= since || !sameLogin(assignee, contributor)) continue;
            // Assignment API authorization is the authority evidence; no fabricated association.
            association = 'ASSIGNMENT_EVENT';
            url = r.url;
            result = r.event === 'assigned' ? 'invited' : 'ambiguous';
          }
          const evidence = Object.freeze({
            actor: who,
            association,
            url,
            policyDigest: policy.digest,
            at,
          });
          assertNoSecrets(JSON.stringify(evidence));
          observations.push({ kind: result, evidence });
        }
        if (count < INVITATION_PAGE_SIZE) return;
      }
      throw new Error();
    }
    await pages('comments');
    await pages('timeline');
    if (!observations.length) return Object.freeze({ kind: 'waiting' });
    observations.sort(
      (a, b) =>
        a.evidence.at.localeCompare(b.evidence.at) || a.evidence.url.localeCompare(b.evidence.url)
    );
    // Any ambiguity or conflicting authorized answers need judgment, never latest-message permission.
    const ambiguous = observations.find((o) => o.kind === 'ambiguous');
    const last = observations[observations.length - 1];
    if (ambiguous || new Set(observations.map((o) => o.kind)).size > 1)
      return Object.freeze({ kind: 'ambiguous', url: (ambiguous ?? last).evidence.url });
    if (last.kind === 'declined')
      return Object.freeze({
        kind: 'declined',
        url: last.evidence.url,
        reasonCode: ReasonCode.UpstreamDeclined,
      });
    await persist(last.evidence);
    return Object.freeze({
      kind: 'invited',
      evidence: last.evidence,
      reasonCode: ReasonCode.MaintainerInvited,
    });
  } catch {
    return Object.freeze({ kind: 'unknown' });
  }
}
