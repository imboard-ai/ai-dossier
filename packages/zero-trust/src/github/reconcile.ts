/** Credential-free reconciliation reads (PRD §5.7, scenarios 11 and 16). A submission is
 * identified by head + base + `state=all` + hidden marker, never by GitHub's duplicate-PR
 * 422, which only holds while the first PR is open. */
import {
  hasOnlyMarker,
  type IssueBinding,
  issueBinding,
  type PrBinding,
  prBinding,
} from './handoff';

export interface GitHubResponse {
  readonly status: number;
  readonly body: unknown;
}
/** GET of a `/repos/...` API path. Implementations must not attach credentials. */
export type GitHubRead = (path: string) => Promise<GitHubResponse>;

export const GITHUB_API = 'https://api.github.com';
const PAGE_SIZE = 100;
const MAX_PR_PAGES = 10;
const MAX_COMMENT_PAGES = 30;

/** Anonymous reader: public upstream reads need no credential, so none is ever sent. */
export function anonymousReader(fetchImpl: typeof fetch = fetch): GitHubRead {
  return async (path) => {
    if (!path.startsWith('/repos/')) throw new Error('Only repository reads are allowed');
    const response = await fetchImpl(`${GITHUB_API}${path}`, {
      method: 'GET',
      redirect: 'error',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'ai-dossier-zero-trust',
      },
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  };
}

type Unknown = { readonly kind: 'unknown' };
export type AmbiguityReason =
  | 'multiple_matches'
  | 'marker_missing'
  | 'foreign_author'
  /** The marked PR exists but its head no longer resolves (fork deleted or renamed). */
  | 'fork_unverifiable';
type Ambiguous = { readonly kind: 'ambiguous'; readonly reason: AmbiguityReason };

/** Lists every page or reports unknown; a truncated listing is never treated as complete. */
export async function listAll(
  read: GitHubRead,
  path: string,
  maxPages: number
): Promise<unknown[] | null> {
  const items: unknown[] = [];
  for (let page = 1; page <= maxPages; page++) {
    let response: GitHubResponse;
    try {
      response = await read(`${path}&per_page=${PAGE_SIZE}&page=${page}`);
    } catch {
      return null;
    }
    if (response.status !== 200 || !Array.isArray(response.body)) return null;
    items.push(...response.body);
    if (response.body.length < PAGE_SIZE) return items;
  }
  return null;
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function login(value: unknown): string | null {
  const user = obj(value);
  return typeof user?.login === 'string' ? user.login.toLowerCase() : null;
}
function enc(value: string): string {
  return encodeURIComponent(value);
}

export interface PrExpectation {
  readonly marker: string;
  readonly contributor: string;
  readonly candidateSha: string;
  /** When the link was issued. Enables the base-only scan for a PR whose head no longer
   * resolves; only PRs created since then can carry this intent's marker. */
  readonly issuedAt?: string;
}
export type PrObservation =
  | {
      readonly kind: 'found';
      readonly url: string;
      readonly number: number;
      readonly headSha: string;
      readonly state: 'open' | 'closed';
      readonly merged: boolean;
    }
  | { readonly kind: 'absent' }
  | { readonly kind: 'head_mismatch'; readonly url: string; readonly headSha: string }
  | Ambiguous
  | Unknown;

/** One validated PR from the head+base listing. */
export interface ListedPull {
  readonly number: number;
  readonly url: string;
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  readonly headSha: string;
  readonly body: string | null;
  /** Lowercased author login, or null when GitHub did not say. */
  readonly author: string | null;
  /** The head repository no longer resolves (fork deleted or renamed). */
  readonly headRepoGone: boolean;
  readonly headRepositoryId: number | null;
}

/** Every PR on exactly this head and base, in any state, or null when the listing is
 * unreadable, truncated, malformed, or answers outside the requested head/base. */
export async function listPulls(
  read: GitHubRead,
  binding: PrBinding
): Promise<ListedPull[] | null> {
  const b = prBinding(binding);
  const repo = `${enc(b.upstream.owner)}/${enc(b.upstream.repo)}`;
  const items = await listAll(
    read,
    `/repos/${repo}/pulls?state=all&head=${enc(`${b.headOwner}:${b.branch}`)}&base=${enc(b.base)}`,
    MAX_PR_PAGES
  );
  if (!items) return null;
  const prefix = `https://github.com/${b.upstream.owner}/${b.upstream.repo}/pull/`.toLowerCase();
  const pulls: ListedPull[] = [];
  for (const item of items) {
    const pr = obj(item);
    const head = obj(pr?.head);
    const base = obj(pr?.base);
    if (
      !pr ||
      !head ||
      !base ||
      !Number.isSafeInteger(pr.number) ||
      typeof pr.html_url !== 'string' ||
      !pr.html_url.toLowerCase().startsWith(prefix) ||
      typeof head.sha !== 'string' ||
      !/^[a-f0-9]{40}$/u.test(head.sha) ||
      (pr.state !== 'open' && pr.state !== 'closed') ||
      (pr.body !== null && typeof pr.body !== 'string')
    )
      return null;
    // GitHub answered outside the requested head/base: do not trust the listing.
    if (
      typeof head.label !== 'string' ||
      head.label.toLowerCase() !== `${b.headOwner}:${b.branch}`.toLowerCase() ||
      head.ref !== b.branch ||
      base.ref !== b.base
    )
      return null;
    pulls.push({
      number: pr.number as number,
      url: pr.html_url,
      state: pr.state,
      merged: typeof pr.merged_at === 'string',
      headSha: head.sha,
      body: pr.body as string | null,
      author: login(pr.user),
      headRepoGone: head.repo === null,
      headRepositoryId: Number.isSafeInteger(obj(head.repo)?.id)
        ? (obj(head.repo)?.id as number)
        : null,
    });
  }
  return pulls;
}

/** One match persists; zero keeps waiting; several, or one without the marker, hands off. */
export async function reconcilePr(
  read: GitHubRead,
  binding: PrBinding,
  expected: PrExpectation
): Promise<PrObservation> {
  const b = prBinding(binding);
  const pulls = await listPulls(read, b);
  if (!pulls) return { kind: 'unknown' };
  if (pulls.length === 0)
    return expected.issuedAt
      ? findOrphan(
          read,
          `${enc(b.upstream.owner)}/${enc(b.upstream.repo)}`,
          b.base,
          expected.marker,
          expected.issuedAt
        )
      : { kind: 'absent' };
  if (pulls.length > 1) return { kind: 'ambiguous', reason: 'multiple_matches' };
  const [pr] = pulls as [ListedPull];
  // A deleted fork leaves `head.repo` null: the head can no longer be verified.
  if (pr.headRepoGone) return { kind: 'ambiguous', reason: 'fork_unverifiable' };
  if (!hasOnlyMarker(pr.body, expected.marker))
    return { kind: 'ambiguous', reason: 'marker_missing' };
  if (pr.author !== expected.contributor.toLowerCase())
    return { kind: 'ambiguous', reason: 'foreign_author' };
  if (pr.headSha !== expected.candidateSha)
    return { kind: 'head_mismatch', url: pr.url, headSha: pr.headSha };
  return {
    kind: 'found',
    url: pr.url,
    number: pr.number,
    headSha: pr.headSha,
    state: pr.state,
    merged: pr.merged,
  };
}

/** A deleted fork drops the PR out of the head filter: scan the base, newest first, back to
 * the issue time. A marked PR found there cannot be verified, so it hands off. */
async function findOrphan(
  read: GitHubRead,
  repo: string,
  base: string,
  marker: string,
  issuedAt: string
): Promise<PrObservation> {
  const since = Date.parse(issuedAt);
  for (let page = 1; page <= MAX_PR_PAGES; page++) {
    let response: GitHubResponse;
    try {
      response = await read(
        `/repos/${repo}/pulls?state=all&base=${enc(base)}&sort=created&direction=desc&per_page=${PAGE_SIZE}&page=${page}`
      );
    } catch {
      return { kind: 'unknown' };
    }
    if (response.status !== 200 || !Array.isArray(response.body)) return { kind: 'unknown' };
    for (const item of response.body) {
      const pr = obj(item);
      const created = typeof pr?.created_at === 'string' ? Date.parse(pr.created_at) : Number.NaN;
      if (!pr || !Number.isFinite(created)) return { kind: 'unknown' };
      if (created < since) return { kind: 'absent' };
      if (typeof pr.body === 'string' && pr.body.includes(marker))
        return { kind: 'ambiguous', reason: 'fork_unverifiable' };
    }
    if (response.body.length < PAGE_SIZE) return { kind: 'absent' };
  }
  return { kind: 'unknown' };
}

export interface CommentExpectation {
  readonly marker: string;
  readonly contributor: string;
  /** Only comments updated since the link was issued can carry its marker. */
  readonly since?: string;
}
export type CommentObservation =
  | { readonly kind: 'found'; readonly url: string; readonly id: number }
  | { readonly kind: 'absent' }
  | Ambiguous
  | Unknown;

/** Engagement comment by marker on the issue's comments (scenario 16). */
export async function reconcileComment(
  read: GitHubRead,
  binding: IssueBinding,
  expected: CommentExpectation
): Promise<CommentObservation> {
  const b = issueBinding(binding);
  const items = await listAll(
    read,
    `/repos/${enc(b.upstream.owner)}/${enc(b.upstream.repo)}/issues/${b.issue}/comments?${expected.since ? `since=${enc(expected.since)}` : 'sort=created'}`,
    MAX_COMMENT_PAGES
  );
  if (!items) return { kind: 'unknown' };
  const prefix =
    `https://github.com/${b.upstream.owner}/${b.upstream.repo}/issues/${b.issue}#issuecomment-`.toLowerCase();
  const matches = [];
  for (const item of items) {
    const comment = obj(item);
    if (!comment || (typeof comment.body !== 'string' && comment.body !== null))
      return { kind: 'unknown' };
    if (typeof comment.body === 'string' && comment.body.includes(expected.marker))
      matches.push(comment);
  }
  if (matches.length === 0) return { kind: 'absent' };
  if (matches.length > 1) return { kind: 'ambiguous', reason: 'multiple_matches' };
  const [comment] = matches;
  if (!hasOnlyMarker(comment.body, expected.marker))
    return { kind: 'ambiguous', reason: 'marker_missing' };
  if (login(comment.user) !== expected.contributor.toLowerCase())
    return { kind: 'ambiguous', reason: 'foreign_author' };
  if (
    !Number.isSafeInteger(comment.id) ||
    typeof comment.html_url !== 'string' ||
    !comment.html_url.toLowerCase().startsWith(prefix)
  )
    return { kind: 'unknown' };
  return { kind: 'found', url: comment.html_url, id: comment.id as number };
}
