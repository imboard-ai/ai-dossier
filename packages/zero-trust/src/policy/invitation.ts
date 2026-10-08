import { type IssueBinding, isGitHubLogin, issueBinding } from '../github/handoff';
import type { GitHubRead } from '../github/reconcile';
import { assertNoSecrets } from '../redaction';
import { isTimestamp, ReasonCode } from '../state';

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
const AUTHORIZED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
/** Entire message only: quotes, negation, plans, caveats and mixed prose never invite. */
export const INVITATION_RULES = Object.freeze({
  affirmative:
    /^(?:go ahead|pr welcome|prs welcome|a pr is welcome|feel free(?: to (?:submit|open) (?:a |the )?pr)?|assigned you|you(?:'re| are) assigned)[.!]?$/iu,
  negative:
    /^(?:not accepting(?: (?:prs|contributions))?|no ai|won't fix|will not fix|please do not (?:proceed|submit (?:a )?pr)|do not proceed)[.!]?$/iu,
});

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  const r = value as Record<string, unknown>;
  if ('truncated' in r && r.truncated !== false) throw new Error();
  return r;
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error();
  return value as number;
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string') throw new Error();
  const canonical = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u.test(value)
    ? `${value.slice(0, -1)}.000Z`
    : value;
  if (!isTimestamp(canonical)) throw new Error();
  return canonical;
}
function actor(value: unknown): string {
  const a = record(value);
  const login = a.login;
  if (
    typeof login !== 'string' ||
    !isGitHubLogin(login) ||
    typeof a.html_url !== 'string' ||
    a.html_url.toLowerCase() !== `https://github.com/${login}`.toLowerCase()
  )
    throw new Error();
  return login;
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
    const policy = Object.freeze({
      digest: options.policy.digest,
      issueAuthorMayInvite: options.policy.issueAuthorMayInvite,
    });
    const since = timestamp(engagementAt);
    if (
      !isGitHubLogin(contributor) ||
      !isGitHubLogin(issueAuthor) ||
      !/^[a-f0-9]{64}$/u.test(policy.digest) ||
      typeof policy.issueAuthorMayInvite !== 'boolean' ||
      typeof persist !== 'function'
    )
      throw new Error();
    const issueUrl = `https://github.com/${b.upstream.owner}/${b.upstream.repo}/issues/${b.issue}`;
    const commentPrefix = `${issueUrl}#issuecomment-`;
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
        if (
          response.status !== 200 ||
          !Array.isArray(response.body) ||
          response.body.length > INVITATION_PAGE_SIZE ||
          ('truncated' in response.body && response.body.truncated !== false)
        )
          throw new Error();
        // Decode the entire page synchronously, retaining only detached primitives across awaits.
        const count = response.body.length;
        for (const raw of response.body) {
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
              body.length > 65536 ||
              typeof a !== 'string' ||
              !ASSOCIATIONS.has(a) ||
              typeof url !== 'string' ||
              url.toLowerCase() !== `${commentPrefix}${id}`.toLowerCase()
            )
              throw new Error();
            assertNoSecrets(body);
            association = a;
            const authorized =
              AUTHORIZED.has(a) ||
              (policy.issueAuthorMayInvite && who.toLowerCase() === issueAuthor.toLowerCase());
            // The engagement itself is never its own answer, even if edited later.
            if (
              !authorized ||
              who.toLowerCase() === contributor.toLowerCase() ||
              url.toLowerCase() === engagementCommentUrl.toLowerCase() ||
              at <= since
            )
              continue;
            if (r.updated_at !== undefined && timestamp(r.updated_at) !== at) {
              result = 'ambiguous';
            } else {
              const text = body.trim();
              result = INVITATION_RULES.affirmative.test(text)
                ? 'invited'
                : INVITATION_RULES.negative.test(text)
                  ? 'declined'
                  : 'ambiguous';
            }
          } else {
            const assignee = actor(r.assignee);
            const apiUrl = `https://api.github.com/repos/${b.upstream.owner}/${b.upstream.repo}/issues/events/${id}`;
            if (typeof r.url !== 'string' || r.url.toLowerCase() !== apiUrl.toLowerCase())
              throw new Error();
            if (at <= since || assignee.toLowerCase() !== contributor.toLowerCase()) continue;
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
