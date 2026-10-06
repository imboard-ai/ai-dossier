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
type Ambiguous = {
  readonly kind: 'ambiguous';
  readonly reason: 'multiple_matches' | 'marker_missing' | 'foreign_author';
};

/** Lists every page or reports unknown; a truncated listing is never treated as complete. */
async function listAll(
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

/** One match persists; zero keeps waiting; several, or one without the marker, hands off. */
export async function reconcilePr(
  read: GitHubRead,
  binding: PrBinding,
  expected: PrExpectation
): Promise<PrObservation> {
  const b = prBinding(binding);
  const repo = `${enc(b.upstream.owner)}/${enc(b.upstream.repo)}`;
  const items = await listAll(
    read,
    `/repos/${repo}/pulls?state=all&head=${enc(`${b.headOwner}:${b.branch}`)}&base=${enc(b.base)}`,
    MAX_PR_PAGES
  );
  if (!items) return { kind: 'unknown' };
  const prefix = `https://github.com/${b.upstream.owner}/${b.upstream.repo}/pull/`.toLowerCase();
  const pulls = [];
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
      return { kind: 'unknown' };
    // GitHub answered outside the requested head/base: do not trust the listing.
    if (
      typeof head.label !== 'string' ||
      head.label.toLowerCase() !== `${b.headOwner}:${b.branch}`.toLowerCase() ||
      head.ref !== b.branch ||
      base.ref !== b.base
    )
      return { kind: 'unknown' };
    pulls.push({ pr, headSha: head.sha });
  }
  if (pulls.length === 0) return { kind: 'absent' };
  if (pulls.length > 1) return { kind: 'ambiguous', reason: 'multiple_matches' };
  const [{ pr, headSha }] = pulls;
  if (!hasOnlyMarker(pr.body, expected.marker))
    return { kind: 'ambiguous', reason: 'marker_missing' };
  if (login(pr.user) !== expected.contributor.toLowerCase())
    return { kind: 'ambiguous', reason: 'foreign_author' };
  const url = pr.html_url as string;
  if (headSha !== expected.candidateSha) return { kind: 'head_mismatch', url, headSha };
  return {
    kind: 'found',
    url,
    number: pr.number as number,
    headSha,
    state: pr.state as 'open' | 'closed',
    merged: typeof pr.merged_at === 'string',
  };
}

export interface CommentExpectation {
  readonly marker: string;
  readonly contributor: string;
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
    `/repos/${enc(b.upstream.owner)}/${enc(b.upstream.repo)}/issues/${b.issue}/comments?sort=created`,
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
