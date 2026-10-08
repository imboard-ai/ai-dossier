import { createHash } from 'node:crypto';
import { isGitHubLogin, isRepoName } from '../github/handoff';
import type { GitHubRead } from '../github/reconcile';
import { canonicalJson } from '../receipt/schema';
import { isTimestamp, ReasonCode } from '../state';
import {
  githubActor as actor,
  githubArray as array,
  githubRecord as object,
  githubPositiveId as positive,
} from './github-values';
import { isNonBugIssue } from './issue-labels';

export const ELIGIBILITY_PAGE_LIMIT = 10;
export const ELIGIBILITY_PAGE_SIZE = 100;

export interface EligibilityActor {
  readonly login: string;
  readonly url: string;
}
export interface EligibilityPull {
  readonly number: number;
  readonly url: string;
  readonly fullName: string;
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  readonly author: EligibilityActor;
}
export interface EligibilityEvent {
  /** Cross-reference timeline records do not carry a numeric REST event ID. */
  readonly id: number | null;
  readonly event: 'cross-referenced' | 'connected' | 'assigned' | 'unassigned';
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly actor: EligibilityActor | null;
  readonly assignee?: EligibilityActor;
  readonly pullUrl?: string;
  /** Exact present identity fields, detached before hydration and included in the digest. */
  readonly identityFields?: Readonly<Record<string, string | number>>;
}
export interface EligibilityFacts {
  readonly repositoryId: number;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly public: boolean;
  readonly archived: boolean;
  readonly disabled: boolean;
  readonly issue: {
    readonly number: number;
    readonly url: string;
    readonly state: 'open' | 'closed';
    readonly locked: boolean;
    readonly isPullRequest: boolean;
    readonly author: EligibilityActor;
    readonly authorAssociation: string;
    readonly labels: readonly string[];
    readonly assignees: readonly EligibilityActor[];
    readonly createdAt: string;
  };
  readonly contributor: string;
  readonly pulls: readonly EligibilityPull[];
  readonly events: readonly EligibilityEvent[];
}
export type EligibilityReason =
  | 'private_repository'
  | 'archived_repository'
  | 'disabled_repository'
  | 'closed_issue'
  | 'pull_request'
  | 'locked_issue'
  | 'not_a_bug'
  | 'competing_assignee'
  | 'competing_fix'
  | 'own_pr_exists'
  | 'bug_unlabeled';
export type Eligibility =
  | { readonly kind: 'unknown' }
  | {
      readonly kind: 'eligible' | 'hand_off';
      readonly reasons: readonly EligibilityReason[];
      readonly facts: EligibilityFacts;
      readonly evidenceDigest: string;
    }
  | {
      readonly kind: 'ineligible';
      readonly reasons: readonly EligibilityReason[];
      readonly facts: EligibilityFacts;
      readonly evidenceDigest: string;
      readonly reasonCode: ReasonCode.PolicyBlocked;
    };

function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024) throw new Error();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error();
  return value;
}
function state(value: unknown): 'open' | 'closed' {
  if (value !== 'open' && value !== 'closed') throw new Error();
  return value;
}
function time(value: unknown): string {
  const result = text(value);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u.test(result) ||
    !isTimestamp(`${result.slice(0, -1)}.000Z`)
  )
    throw new Error();
  return result;
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function sorted<T>(values: T[]): readonly T[] {
  return Object.freeze(values.sort((a, b) => compare(canonicalJson(a), canonicalJson(b))));
}

/** REST identities are parsed as data, never followed as URLs. */
interface PullTarget {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}
function pullTarget(value: unknown, kind: 'pull' | 'issue' | 'reference' = 'pull'): PullTarget {
  const match =
    /^https:\/\/(?:api\.github\.com\/repos|github\.com)\/([^/]+)\/([^/]+)\/(pulls|pull|issues)\/([1-9]\d*)(?:\.(?:diff|patch))?$/u.exec(
      text(value)
    );
  if (
    !match ||
    !isGitHubLogin(match[1]) ||
    !isRepoName(match[2]) ||
    (kind === 'issue' ? match[3] !== 'issues' : kind === 'pull' && match[3] === 'issues') ||
    ((text(value).endsWith('.diff') || text(value).endsWith('.patch')) &&
      (match[3] !== 'pull' || !text(value).startsWith('https://github.com/')))
  )
    throw new Error();
  return Object.freeze({
    owner: match[1].toLowerCase(),
    repo: match[2].toLowerCase(),
    number: positive(Number(match[4])),
  });
}

function pullKey(binding: PullTarget): string {
  return `${binding.owner}/${binding.repo}/${binding.number}`;
}

/** One identity contract for event/source/subject/marker and hydrated REST objects. */
function referenceIdentity(
  value: Record<string, unknown>,
  kind: 'pull' | 'issue',
  expected?: PullTarget
): { binding: PullTarget; fields: Readonly<Record<string, string | number>> } {
  const fields: Record<string, string | number> = {};
  const tuples: PullTarget[] = expected ? [expected] : [];
  const numbers: number[] = [];
  function visit(record: Record<string, unknown>, path: string): void {
    for (const [key, raw] of Object.entries(record)) {
      const field = path ? `${path}.${key}` : key;
      if (key === 'number') {
        const number = positive(raw);
        numbers.push(number);
        fields[field] = number;
      } else if (['url', 'html_url', 'diff_url', 'patch_url'].includes(key)) {
        const url = text(raw);
        // GitHub represents source PRs through the issues API as well as pull URLs.
        const binding = pullTarget(url, key === 'url' ? 'reference' : kind);
        if (key === 'diff_url' && !url.endsWith('.diff')) throw new Error();
        if (key === 'patch_url' && !url.endsWith('.patch')) throw new Error();
        tuples.push(binding);
        fields[field] = url;
      } else if (['source', 'issue', 'subject', 'pull_request'].includes(key)) {
        visit(object(raw), field);
      }
    }
  }
  visit(value, '');
  const binding = tuples[0];
  if (
    !binding ||
    tuples.some((tuple) => pullKey(tuple) !== pullKey(binding)) ||
    numbers.some((number) => number !== binding.number)
  )
    throw new Error();
  return { binding, fields: Object.freeze(fields) };
}

interface TimelineDescriptor {
  readonly evidence: EligibilityEvent;
  readonly binding?: PullTarget;
}

/** Validate and detach every relevant entry BEFORE any hydration await. */
function timelinePage(value: unknown): { count: number; entries: TimelineDescriptor[] } {
  const page = array(value, ELIGIBILITY_PAGE_SIZE);
  const count = page.length;
  const entries: TimelineDescriptor[] = [];
  for (const value of page) {
    const entry = object(value);
    const event = text(entry.event);
    if (
      event !== 'cross-referenced' &&
      event !== 'connected' &&
      event !== 'assigned' &&
      event !== 'unassigned'
    )
      continue;
    const base = {
      id: event === 'cross-referenced' && entry.id === undefined ? null : positive(entry.id),
      createdAt: time(entry.created_at),
      ...(entry.updated_at === undefined ? {} : { updatedAt: time(entry.updated_at) }),
      actor: entry.actor === null ? null : actor(entry.actor),
    };
    if (event === 'assigned' || event === 'unassigned') {
      entries.push({
        evidence: Object.freeze({ ...base, event, assignee: actor(entry.assignee) }),
      });
      continue;
    }
    const source = entry.source === undefined ? null : object(entry.source);
    const linked = source ? object(source.issue) : null;
    if (event === 'cross-referenced' && linked && !('pull_request' in linked)) {
      referenceIdentity(entry, 'issue');
      continue;
    }
    if (linked) object(linked.pull_request);
    const { binding, fields } = referenceIdentity(entry, 'pull');
    entries.push({
      evidence: Object.freeze({ ...base, event, identityFields: fields }),
      binding,
    });
  }
  return { count, entries };
}

async function hydratePull(
  get: (path: string) => Promise<unknown>,
  binding: PullTarget
): Promise<EligibilityPull> {
  const pr = object(
    await get(
      `/repos/${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.repo)}/pulls/${binding.number}`
    )
  );
  positive(pr.number);
  pullTarget(pr.html_url);
  referenceIdentity(pr, 'pull', binding);
  const merged = pr.merged_at === null ? false : Boolean(time(pr.merged_at));
  const pullState = state(pr.state);
  if (merged && pullState !== 'closed') throw new Error();
  return Object.freeze({
    number: binding.number,
    url: text(pr.html_url),
    fullName: `${binding.owner}/${binding.repo}`,
    state: pullState,
    merged,
    author: actor(pr.user),
  });
}

/** Structured facts only. No prose interpretation, run transition, write or credential. */
export async function assessIssue(
  read: GitHubRead,
  target: { readonly owner: string; readonly repo: string; readonly issue: number },
  contributor: string
): Promise<Eligibility> {
  try {
    // Snapshot trusted caller bindings before the first await.
    const { owner, repo, issue } = target;
    if (!isGitHubLogin(owner) || !isRepoName(repo) || !isGitHubLogin(contributor))
      return { kind: 'unknown' };
    positive(issue);
    const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    async function get(path: string): Promise<unknown> {
      const response = await read(path);
      if (response.status !== 200) throw new Error();
      return response.body;
    }
    const repository = object(await get(prefix));
    const fullName = text(repository.full_name);
    if (fullName.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) throw new Error();
    const repositoryFacts = {
      repositoryId: positive(repository.id),
      fullName,
      defaultBranch: text(repository.default_branch),
      public: !bool(repository.private),
      archived: bool(repository.archived),
      disabled: bool(repository.disabled),
    };
    const raw = object(await get(`${prefix}/issues/${issue}`));
    const isPullRequest = 'pull_request' in raw;
    const url = text(raw.html_url);
    const expectedUrl = `https://github.com/${fullName}/${isPullRequest ? 'pull' : 'issues'}/${issue}`;
    if (positive(raw.number) !== issue || url.toLowerCase() !== expectedUrl.toLowerCase())
      throw new Error();
    const labels = sorted(array(raw.labels, 100).map((label) => text(object(label).name)));
    const assignees = sorted(array(raw.assignees, 100).map(actor));
    if (new Set(assignees.map((user) => user.login.toLowerCase())).size !== assignees.length)
      throw new Error();
    const issueFacts = Object.freeze({
      number: issue,
      url,
      state: state(raw.state),
      locked: bool(raw.locked),
      isPullRequest,
      author: actor(raw.user),
      authorAssociation: text(raw.author_association),
      labels,
      assignees,
      createdAt: time(raw.created_at),
    });
    const events: EligibilityEvent[] = [];
    const pulls = new Map<string, EligibilityPull>();
    const ids = new Set<string>();
    let complete = false;
    for (let page = 1; page <= ELIGIBILITY_PAGE_LIMIT; page++) {
      const pageSnapshot = timelinePage(
        await get(
          `${prefix}/issues/${issue}/timeline?per_page=${ELIGIBILITY_PAGE_SIZE}&page=${page}`
        )
      );
      for (const { evidence, binding } of pageSnapshot.entries) {
        const id =
          evidence.id === null ? canonicalJson({ evidence, binding }) : `id:${evidence.id}`;
        if (ids.has(id)) throw new Error();
        ids.add(id);
        if (!binding) {
          events.push(evidence);
          continue;
        }
        const key = pullKey(binding);
        let pull = pulls.get(key);
        if (!pull) {
          pull = await hydratePull(get, binding);
          pulls.set(key, pull);
        }
        events.push(
          Object.freeze({
            ...evidence,
            pullUrl: pull.url,
          })
        );
      }
      if (pageSnapshot.count < ELIGIBILITY_PAGE_SIZE) {
        complete = true;
        break;
      }
    }
    if (!complete) return { kind: 'unknown' };
    const facts: EligibilityFacts = Object.freeze({
      ...repositoryFacts,
      issue: issueFacts,
      contributor: contributor.toLowerCase(),
      pulls: sorted([...pulls.values()]),
      events: sorted(events),
    });
    const evidenceDigest = createHash('sha256')
      .update(canonicalJson(facts, 1024 * 1024))
      .digest('hex');
    const blocked: EligibilityReason[] = [];
    if (!facts.public) blocked.push('private_repository');
    if (facts.archived) blocked.push('archived_repository');
    if (facts.disabled) blocked.push('disabled_repository');
    if (facts.issue.state === 'closed') blocked.push('closed_issue');
    if (isPullRequest) blocked.push('pull_request');
    if (facts.issue.locked) blocked.push('locked_issue');
    if (blocked.length)
      return {
        kind: 'ineligible',
        reasons: Object.freeze(blocked),
        facts,
        evidenceDigest,
        reasonCode: ReasonCode.PolicyBlocked,
      };
    const reasons: EligibilityReason[] = [];
    if (isNonBugIssue(labels)) reasons.push('not_a_bug');
    if (assignees.some((user) => user.login.toLowerCase() !== facts.contributor))
      reasons.push('competing_assignee');
    for (const pr of pulls.values()) {
      if (pr.state !== 'open' || pr.merged) continue;
      const reason =
        pr.author.login.toLowerCase() === facts.contributor ? 'own_pr_exists' : 'competing_fix';
      if (!reasons.includes(reason)) reasons.push(reason);
    }
    if (reasons.length)
      return { kind: 'hand_off', reasons: sorted(reasons), facts, evidenceDigest };
    return {
      kind: 'eligible',
      reasons: Object.freeze(labels.length === 0 ? ['bug_unlabeled'] : []),
      facts,
      evidenceDigest,
    };
  } catch {
    // Never expose exception text or incomplete evidence as an eligibility snapshot.
    return { kind: 'unknown' };
  }
}
