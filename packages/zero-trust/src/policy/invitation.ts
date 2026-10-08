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
/** Permission floor is private immutable data, not core's exported mutable Set. */
const MAINTAINER_ASSOCIATIONS: readonly string[] = Object.freeze([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
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
  return observeInvitation(read, binding, options);
}

/** Revalidate an admitted comment/assignment source and every later answer.
 * No persistence callback is called on this freshness-only observation path. */
export async function recheckInvitation(
  read: GitHubRead,
  binding: IssueBinding,
  evidence: InvitationEvidence,
  options: Pick<InvitationOptions, 'contributor' | 'issueAuthor' | 'policy'>
): Promise<InvitationResult> {
  try {
    const { actor, association, url, at, policyDigest } = record(evidence);
    if ([actor, association, url, at, policyDigest].some((value) => typeof value !== 'string'))
      throw new Error();
    const source = Object.freeze({
      actor,
      association,
      url,
      at,
      policyDigest,
    }) as InvitationEvidence;
    return await observeInvitation(
      read,
      binding,
      {
        ...options,
        engagementCommentUrl: source.url,
        engagementAt: source.at,
        persist: () => {},
      },
      source
    );
  } catch {
    return Object.freeze({ kind: 'unknown' });
  }
}

async function observeInvitation(
  read: GitHubRead,
  binding: IssueBinding,
  options: InvitationOptions,
  source?: InvitationEvidence
): Promise<InvitationResult> {
  try {
    record(options);
    record(binding);
    record(binding.upstream);
    const b = issueBinding(binding);
    const { engagementCommentUrl, engagementAt, contributor, issueAuthor, persist } = options;
    const rawPolicy = record(options.policy);
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
    const policyDigest = policy.digest;
    const commentPrefix = `${issueUrl(b)}#issuecomment-`;
    const assignmentSource = source?.association === 'ASSIGNMENT_EVENT';
    if (
      typeof engagementCommentUrl !== 'string' ||
      (assignmentSource
        ? !new RegExp(
            `^https://api\\.github\\.com/repos/${b.upstream.owner}/${b.upstream.repo.replace(/[.]/gu, '\\.')}\\/issues/events/[1-9]\\d*$`,
            'iu'
          ).test(engagementCommentUrl)
        : !engagementCommentUrl.toLowerCase().startsWith(commentPrefix.toLowerCase()) ||
          !/^[1-9]\d*$/u.test(engagementCommentUrl.slice(commentPrefix.length)))
    )
      throw new Error();
    // Persisted permission must itself carry a valid human/assignment authority.
    const sourceSnapshot = source
      ? Object.freeze({
          actor: source.actor,
          association: source.association,
          url: source.url,
          at: source.at,
          policyDigest: source.policyDigest,
        })
      : undefined;
    if (
      sourceSnapshot &&
      (!isGitHubActorLogin(sourceSnapshot.actor) ||
        typeof sourceSnapshot.policyDigest !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(sourceSnapshot.policyDigest) ||
        (!assignmentSource &&
          !MAINTAINER_ASSOCIATIONS.includes(sourceSnapshot.association) &&
          !(policy.issueAuthorMayInvite && sameLogin(sourceSnapshot.actor, issueAuthor))))
    )
      throw new Error();
    let sourceSeen = false;
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
              (MAINTAINER_ASSOCIATIONS.includes(a) ||
                (policy.issueAuthorMayInvite && sameLogin(who, issueAuthor)));
            if (sourceSnapshot && !assignmentSource && sameLogin(url, sourceSnapshot.url)) {
              if (
                sourceSeen ||
                !authorized ||
                sameLogin(who, contributor) ||
                !sameLogin(who, sourceSnapshot.actor) ||
                a !== sourceSnapshot.association ||
                at !== since ||
                timestamp(r.updated_at) !== at ||
                !affirmative.test(body.trim())
              )
                throw new Error();
              sourceSeen = true;
              continue;
            }
            // The engagement itself is never its own answer, even if edited later.
            if (
              !authorized ||
              sameLogin(who, contributor) ||
              url.toLowerCase() === engagementCommentUrl.toLowerCase() ||
              (sourceSnapshot ? at < since : at <= since)
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
            const expectedIssueApi = `https://api.github.com${path}`;
            const suppliedIssueUrl = r.issue_url;
            if (
              suppliedIssueUrl !== undefined &&
              (typeof suppliedIssueUrl !== 'string' ||
                suppliedIssueUrl.toLowerCase() !== expectedIssueApi.toLowerCase())
            )
              throw new Error();
            if (r.issue !== undefined) {
              const issue = record(r.issue);
              const fields = { number: b.issue, url: expectedIssueApi, html_url: issueUrl(b) };
              for (const [key, expected] of Object.entries(fields)) {
                const supplied = issue[key];
                if (supplied === undefined) continue;
                if (
                  typeof expected === 'number'
                    ? supplied !== expected
                    : typeof supplied !== 'string' ||
                      supplied.toLowerCase() !== expected.toLowerCase()
                )
                  throw new Error();
              }
            }
            if (sourceSnapshot && assignmentSource && sameLogin(r.url, sourceSnapshot.url)) {
              if (
                sourceSeen ||
                r.event !== 'assigned' ||
                !sameLogin(assignee, contributor) ||
                !sameLogin(who, sourceSnapshot.actor) ||
                at !== since ||
                (r.updated_at !== undefined && timestamp(r.updated_at) !== at)
              )
                throw new Error();
              sourceSeen = true;
              continue;
            }
            // GitHub timestamps have only second precision. On revalidation,
            // the exact source is handled above; another equal-time observation
            // cannot safely be declared older and silently discarded.
            if ((sourceSnapshot ? at < since : at <= since) || !sameLogin(assignee, contributor))
              continue;
            // Assignment API authorization is the authority evidence; no fabricated association.
            association = 'ASSIGNMENT_EVENT';
            url = r.url;
            result = r.event === 'assigned' ? 'invited' : 'ambiguous';
          }
          const evidence = Object.freeze({
            actor: who,
            association,
            url,
            policyDigest,
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
    if (sourceSnapshot && !sourceSeen) throw new Error();
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
    if (!sourceSnapshot) await persist(last.evidence);
    return Object.freeze({
      kind: 'invited',
      evidence: last.evidence,
      reasonCode: ReasonCode.MaintainerInvited,
    });
  } catch {
    return Object.freeze({ kind: 'unknown' });
  }
}
