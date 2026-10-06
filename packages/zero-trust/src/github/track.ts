/** Upstream PR tracking and revisions (#1068; PRD §5.8 `submitted` → `awaiting_review` →
 * `revising` → `merged`/`declined`, §5.9 "Update PR" and "Withdraw contribution", scenarios
 * 12, 13 and 16). Every upstream fact comes from a credential-free read made on an explicit
 * resume; nothing polls in the background. A revision ships as a new verified candidate
 * pushed with the #1066 CAS to the same fork branch, which updates the PR. Title or body
 * edits, withdrawal and reopening are contributor actions the run confirms by reading the
 * PR again; it never writes upstream and never claims what it has not observed. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { replacePrivate } from '../durable-fs';
import { type IntentInput, isAdmitted, WriteBlockedError } from '../intents';
import type { Journal } from '../journal';
import type { CommandEvidence } from '../receipt/schema';
import { isRecoveryEvent } from '../recovery';
import { assertNoSecrets } from '../redaction';
import {
  isRecord,
  permittedTransitions,
  ReasonCode,
  type RunRecord,
  type RunState,
  restoreRun,
  TERMINAL_STATES,
  transitionRun,
} from '../state';
import { type ForkRef, ForkRefError, forkTarget, isCommitSha, readForkBranch } from './fork-ref';
import {
  findHandoffMarkers,
  handoffIntentId,
  handoffMarker,
  hasOnlyMarker,
  MAX_BODY_LENGTH,
  type PrBinding,
  prBinding,
  prTitle,
  sameLogin,
  upstreamIssueBinding,
} from './handoff';
import type { HandoffAdmission, HandoffRecord } from './handoff-driver';
import { type AmbiguityReason, type GitHubRead, listAll, listPulls } from './reconcile';
import { assertContentPolicy, HandoffError, untrustedText } from './text';

/** The tracked upstream PR. Its body carries exactly the `pr_create` hand-off marker. */
export interface TrackedPr {
  readonly binding: PrBinding;
  readonly fork: ForkRef;
  readonly number: number;
  readonly url: string;
  readonly marker: string;
}

/** Upstream checks as observed at one head SHA (scenario 12). `none`: nothing reported
 * yet; `unknown`: a read failed or an answer was not understood. Only `passed` is green. */
export type CiState = 'none' | 'pending' | 'awaiting_approval' | 'failed' | 'passed' | 'unknown';

/** One reviewer remark. Its body is untrusted text: data for the isolated revision, never an
 * instruction to the controller (PRD §5.8). */
export interface FeedbackItem {
  /** `review:<id>`, `review_comment:<id>` or `comment:<id>`. */
  readonly id: string;
  readonly author: string;
  /** Changes when the remark is edited, which makes it actionable again. */
  readonly updatedAt: string;
  readonly url: string;
  readonly body: string;
  /** The commit a review or review comment was made on, when GitHub names one. */
  readonly commitSha?: string;
}

export type GoneReason = 'pr_deleted' | 'fork_deleted' | 'fork_replaced' | 'branch_deleted';
export type PrTrack =
  | {
      readonly kind: 'observed';
      readonly number: number;
      readonly url: string;
      readonly state: 'open' | 'closed';
      readonly merged: boolean;
      /** The PR's head as GitHub reports it. */
      readonly headSha: string;
      /** The fork branch read directly; null once merged (branch deletion is then normal). */
      readonly branchSha: string | null;
      readonly title: string;
      readonly body: string | null;
      /** Open PRs only. */
      readonly ci?: CiState;
      /** Open PRs only; null when the remarks could not be read. */
      readonly feedback?: readonly FeedbackItem[] | null;
    }
  | { readonly kind: 'gone'; readonly reason: GoneReason }
  | { readonly kind: 'unknown' };

const PAGE_SIZE = 100;
const MAX_CHECK_PAGES = 10;
const MAX_FEEDBACK_PAGES = 30;
const MAX_FEEDBACK_BODY = 65536;

function enc(value: string): string {
  return encodeURIComponent(value);
}
function repoPath(binding: PrBinding): string {
  return `/repos/${enc(binding.upstream.owner)}/${enc(binding.upstream.repo)}`;
}
function loginOf(value: unknown): string | null {
  return isRecord(value) && typeof value.login === 'string' ? value.login : null;
}
async function get(read: GitHubRead, p: string) {
  try {
    return await read(p);
  } catch {
    return null;
  }
}

/** Pages an object answer (`{ total_count, <key>: [...] }`); null when truncated or unread. */
async function listKeyed(read: GitHubRead, p: string, key: string): Promise<unknown[] | null> {
  const items: unknown[] = [];
  for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
    const response = await get(
      read,
      `${p}${p.includes('?') ? '&' : '?'}per_page=${PAGE_SIZE}&page=${page}`
    );
    const body = response?.status === 200 && isRecord(response.body) ? response.body : null;
    const list = body?.[key];
    if (!body || !Array.isArray(list) || !Number.isSafeInteger(body.total_count)) return null;
    items.push(...list);
    if (list.length < PAGE_SIZE || items.length >= (body.total_count as number)) return items;
  }
  return null;
}

type Verdict = 'passed' | 'failed' | 'awaiting_approval' | 'pending' | 'unknown';
const PASSED = ['success', 'neutral', 'skipped'];
const FAILED = ['failure', 'timed_out', 'cancelled', 'startup_failure'];

function runVerdict(item: unknown): Verdict {
  if (!isRecord(item)) return 'unknown';
  const { status, conclusion } = item;
  // A fork PR's workflows wait for a maintainer's approval before anything runs.
  if (status === 'action_required' || status === 'waiting' || conclusion === 'action_required')
    return 'awaiting_approval';
  if (status !== 'completed') return typeof status === 'string' ? 'pending' : 'unknown';
  if (PASSED.includes(conclusion as string)) return 'passed';
  if (FAILED.includes(conclusion as string)) return 'failed';
  return conclusion === 'stale' ? 'pending' : 'unknown';
}

/** Upstream CI at `sha`, from check runs, workflow runs and commit statuses. Never inferred:
 * a check that has not run is not green, and an unreadable answer is `unknown`. */
export async function observeCi(
  read: GitHubRead,
  binding: PrBinding,
  sha: string
): Promise<CiState> {
  if (!isCommitSha(sha)) throw new HandoffError('invalid_sha');
  const repo = repoPath(prBinding(binding));
  const [checks, runs, combined] = await Promise.all([
    listKeyed(read, `${repo}/commits/${sha}/check-runs`, 'check_runs'),
    listKeyed(read, `${repo}/actions/runs?head_sha=${sha}`, 'workflow_runs'),
    get(read, `${repo}/commits/${sha}/status`),
  ]);
  const status = combined?.status === 200 && isRecord(combined.body) ? combined.body : null;
  if (!checks || !runs || !status || !Number.isSafeInteger(status.total_count)) return 'unknown';
  const verdicts: Verdict[] = [...checks, ...runs].map(runVerdict);
  // GitHub reports `pending` for a commit with no statuses at all: count only real ones.
  if ((status.total_count as number) > 0)
    verdicts.push(
      status.state === 'success'
        ? 'passed'
        : status.state === 'pending'
          ? 'pending'
          : status.state === 'failure' || status.state === 'error'
            ? 'failed'
            : 'unknown'
    );
  if (verdicts.length === 0) return 'none';
  for (const verdict of ['failed', 'awaiting_approval', 'pending', 'unknown'] as const)
    if (verdicts.includes(verdict)) return verdict;
  return 'passed';
}

/** Reviews, review comments and conversation comments on the PR; null when unreadable. */
export async function observeFeedback(
  read: GitHubRead,
  pr: Pick<TrackedPr, 'binding' | 'number'>
): Promise<FeedbackItem[] | null> {
  const repo = repoPath(prBinding(pr.binding));
  const sources = [
    ['review', `${repo}/pulls/${pr.number}/reviews?sort=created`],
    ['review_comment', `${repo}/pulls/${pr.number}/comments?sort=created`],
    ['comment', `${repo}/issues/${pr.number}/comments?sort=created`],
  ] as const;
  const lists = await Promise.all(sources.map(([, p]) => listAll(read, p, MAX_FEEDBACK_PAGES)));
  const items: FeedbackItem[] = [];
  for (const [index, list] of lists.entries()) {
    if (!list) return null;
    const kind = sources[index]?.[0] as string;
    for (const raw of list) {
      if (!isRecord(raw)) return null;
      const author = loginOf(raw.user);
      const updatedAt = kind === 'review' ? raw.submitted_at : raw.updated_at;
      if (
        !Number.isSafeInteger(raw.id) ||
        !author ||
        typeof raw.html_url !== 'string' ||
        (raw.body !== null && typeof raw.body !== 'string')
      )
        return null;
      // A pending review has no submission time yet and is not visible feedback.
      if (kind === 'review' && raw.state === 'PENDING') continue;
      if (typeof updatedAt !== 'string') return null;
      const body = ((raw.body as string | null) ?? '').slice(0, MAX_FEEDBACK_BODY);
      // Approvals and empty comment-only reviews carry nothing to address.
      if (kind === 'review' && raw.state !== 'CHANGES_REQUESTED' && !body.trim()) continue;
      if (isRecord(raw.user) && raw.user.type === 'Bot') continue;
      items.push(
        Object.freeze({
          id: `${kind}:${raw.id}`,
          author,
          updatedAt,
          url: raw.html_url,
          body,
          ...(isCommitSha(raw.commit_id) ? { commitSha: raw.commit_id } : {}),
        })
      );
    }
  }
  return items;
}

/** The tracked PR, its fork branch, and (when open) its checks and remarks. Merged wins over
 * a deleted fork or branch; otherwise a deleted PR, fork or branch is `gone` (PRD §5.9). */
export async function observePr(read: GitHubRead, pr: TrackedPr): Promise<PrTrack> {
  const b = prBinding(pr.binding);
  const response = await get(read, `${repoPath(b)}/pulls/${pr.number}`);
  if (response?.status === 404 || response?.status === 410)
    return { kind: 'gone', reason: 'pr_deleted' };
  const body = response?.status === 200 && isRecord(response.body) ? response.body : null;
  const head = isRecord(body?.head) ? body.head : null;
  const base = isRecord(body?.base) ? body.base : null;
  if (
    !body ||
    !head ||
    !base ||
    body.number !== pr.number ||
    typeof body.html_url !== 'string' ||
    body.html_url.toLowerCase() !== pr.url.toLowerCase() ||
    (body.state !== 'open' && body.state !== 'closed') ||
    !isCommitSha(head.sha) ||
    head.ref !== b.branch ||
    base.ref !== b.base ||
    typeof body.title !== 'string' ||
    (body.body !== null && typeof body.body !== 'string')
  )
    return { kind: 'unknown' };
  const merged = body.merged === true || typeof body.merged_at === 'string';
  const facts = {
    kind: 'observed' as const,
    number: pr.number,
    url: body.html_url,
    state: body.state as 'open' | 'closed',
    merged,
    headSha: head.sha as string,
    title: body.title,
    body: body.body as string | null,
  };
  if (merged) return Object.freeze({ ...facts, branchSha: null });
  if (head.repo === null) return { kind: 'gone', reason: 'fork_deleted' };
  if (!isRecord(head.repo) || head.repo.id !== pr.fork.repositoryId)
    return { kind: 'gone', reason: 'fork_replaced' };
  let branchSha: string | null;
  try {
    branchSha = await readForkBranch(read, { fork: pr.fork, branch: b.branch });
  } catch (error) {
    if (error instanceof ForkRefError && error.code === 'fork_unverified') {
      if (error.status === 404) return { kind: 'gone', reason: 'fork_deleted' };
      if (error.status === 200) return { kind: 'gone', reason: 'fork_replaced' };
    }
    return { kind: 'unknown' };
  }
  if (branchSha === null) return { kind: 'gone', reason: 'branch_deleted' };
  if (facts.state === 'closed') return Object.freeze({ ...facts, branchSha });
  const [ci, feedback] = await Promise.all([
    observeCi(read, b, facts.headSha),
    observeFeedback(read, pr),
  ]);
  return Object.freeze({ ...facts, branchSha, ci, feedback });
}

export type UpstreamOutcome = 'awaiting_review' | 'merged' | 'declined' | 'blocked' | 'unknown';

/** AC1: observations only. `merged` only when observed merged; closed and not merged is
 * `declined`; a deleted PR, fork or branch blocks. */
export function upstreamOutcome(track: PrTrack): UpstreamOutcome {
  if (track.kind === 'unknown') return 'unknown';
  if (track.kind === 'gone') return 'blocked';
  if (track.merged) return 'merged';
  return track.state === 'closed' ? 'declined' : 'awaiting_review';
}

export type Relocation =
  | { readonly kind: 'none' }
  | { readonly kind: 'found'; readonly number: number; readonly url: string }
  | { readonly kind: 'ambiguous'; readonly reason: AmbiguityReason }
  | { readonly kind: 'unknown' };

/** AC6: the tracked PR is closed and the contributor may have opened another. List head +
 * base + `state=all` and keep the PRs carrying this contribution's marker, other than the one
 * already tracked; never rely on the duplicate-PR 422, which only holds while a PR is open.
 * Exactly one is the new PR; more than one hands off. */
export async function relocatePr(
  read: GitHubRead,
  pr: TrackedPr,
  contributor: string
): Promise<Relocation> {
  const pulls = await listPulls(read, pr.binding);
  if (!pulls) return { kind: 'unknown' };
  const marked = pulls.filter((p) => p.number !== pr.number && p.body?.includes(pr.marker));
  if (marked.length === 0) return { kind: 'none' };
  if (marked.length > 1) return { kind: 'ambiguous', reason: 'multiple_matches' };
  const [found] = marked as [(typeof marked)[number]];
  if (!hasOnlyMarker(found.body, pr.marker)) return { kind: 'ambiguous', reason: 'marker_missing' };
  if (found.author !== contributor.toLowerCase())
    return { kind: 'ambiguous', reason: 'foreign_author' };
  if (found.headRepoGone) return { kind: 'ambiguous', reason: 'fork_unverifiable' };
  return { kind: 'found', number: found.number, url: found.url };
}

/** The PR a completed `pr_create` hand-off observed, ready to track. */
export function trackFromHandoff(
  record: HandoffRecord,
  fork: ForkRef
): { pr: TrackedPr; headSha: string } {
  if (
    record.input.operationKind !== 'pr_create' ||
    record.status !== 'observed' ||
    !Number.isSafeInteger(record.number) ||
    typeof record.artifactRef !== 'string' ||
    !isCommitSha(record.headSha)
  )
    throw new HandoffError('not_observed');
  return {
    pr: Object.freeze({
      binding: prBinding(record.binding),
      fork,
      number: record.number as number,
      url: record.artifactRef,
      marker: handoffMarker(record.input),
    }),
    headSha: record.headSha,
  };
}

export class TrackError extends Error {
  constructor(readonly code: string) {
    super(`Zero-trust PR tracking refused: ${code}`);
    this.name = 'TrackError';
  }
}

export const TRACK_BLOCK_REASONS = Object.freeze([
  'pr_deleted',
  'fork_deleted',
  'fork_replaced',
  'branch_deleted',
  /** The PR or fork branch moved to a commit no verified push left there (scenario 13). */
  'unexpected_head_sha',
  'admission_policy',
  'admission_contributor',
  'admission_fork_binding',
  /** The CAS push refused or diverged; the intent journal holds the detail. */
  'push_blocked',
] as const);
export type TrackBlockReason = (typeof TRACK_BLOCK_REASONS)[number];

/** Freshness before every revision (PRD §5.9): the same probes the PR hand-off admits on. */
export type RevisionAdmission = Pick<
  HandoffAdmission,
  'policyFresh' | 'contributorVerified' | 'forkBindingVerified'
>;

export interface TrackDeps {
  readonly read: GitHubRead;
  readonly admission: RevisionAdmission;
  /** Controller-owned directory for prepared texts the contributor pastes. */
  readonly bodyDirectory: string;
  readonly now: () => string;
}

export type ActionKind = 'edit' | 'withdraw' | 'reopen';
export type WithdrawalReason = 'maintainer_request' | 'user_instruction';
interface PendingAction {
  readonly kind: ActionKind;
  readonly input: IntentInput;
  readonly link: string;
  readonly title?: string;
  readonly body?: string;
  readonly bodyFile?: string;
  readonly bodyDigest?: string;
  readonly reason?: WithdrawalReason;
}
/** A prepared contributor action: the link, the text to submit, and what the run will read
 * back to confirm it. */
export interface ContributorAction {
  readonly kind: ActionKind;
  readonly link: string;
  readonly title?: string;
  readonly bodyFile?: string;
  readonly bodyDigest?: string;
  readonly author: string;
  readonly instructions: string;
}

interface FeedbackRef {
  readonly id: string;
  readonly updatedAt: string;
}
interface Revision {
  readonly fromSha: string;
  readonly feedback: readonly FeedbackRef[];
  readonly candidateSha?: string;
}
export interface TrackState {
  readonly run: RunRecord;
  readonly contributionId: string;
  readonly pr: TrackedPr;
  /** The head the run last confirmed on the PR. */
  readonly verifiedSha: string;
  /** Feedback id → the `updatedAt` a confirmed revision addressed (AC5). */
  readonly addressed: ReadonlyMap<string, string>;
  readonly revision?: Revision;
  readonly action?: PendingAction;
  readonly blockedReason?: TrackBlockReason;
}

/** What the last read in this process saw. Never journaled: after a restart CI is
 * `not_observed` until the next explicit resume reads it. */
interface Seen {
  readonly ci: CiState;
  readonly headSha: string;
  readonly actionable: number | null;
}

export interface TrackStatus {
  readonly state: RunState;
  readonly pr: string;
  readonly headSha: string;
  /** As observed at `ciSha`; `not_observed` until a resume in this process reads it. */
  readonly ci: CiState | 'not_observed';
  readonly ciSha?: string;
  /** Unaddressed review items at the last read; null when not read. */
  readonly feedback: number | null;
  readonly action?: ContributorAction;
  readonly blockedReason?: TrackBlockReason;
  readonly nextPermittedAction: string;
}

export type TrackOutcome =
  | { readonly kind: 'tracking'; readonly status: TrackStatus }
  | { readonly kind: 'merged' | 'declined'; readonly status: TrackStatus }
  | { readonly kind: 'blocked'; readonly reason: TrackBlockReason; readonly status: TrackStatus }
  /** GitHub could not be read: nothing was recorded; resume again later. */
  | { readonly kind: 'unknown'; readonly status: TrackStatus }
  /** Re-detection found several candidate PRs, or one it cannot attribute: a person decides. */
  | {
      readonly kind: 'handoff';
      readonly reason: AmbiguityReason;
      readonly status: TrackStatus;
    }
  | {
      readonly kind: 'revising';
      readonly feedback: readonly FeedbackItem[];
      readonly status: TrackStatus;
    }
  | { readonly kind: 'nothing_to_revise'; readonly status: TrackStatus }
  /** Pushed (or about to be), but the PR head does not show the candidate yet. */
  | {
      readonly kind: 'revision_pending';
      readonly candidateSha: string;
      readonly status: TrackStatus;
    }
  | { readonly kind: 'revised'; readonly headSha: string; readonly status: TrackStatus }
  | { readonly kind: 'action'; readonly action: ContributorAction; readonly status: TrackStatus };

type Event =
  | {
      v: 1;
      type: 'track';
      run: RunRecord;
      contributionId: string;
      pr: TrackedPr;
      verifiedSha: string;
    }
  | { v: 1; type: 'run_update'; run: RunRecord }
  | { v: 1; type: 'review_awaited'; run: RunRecord }
  | { v: 1; type: 'outcome'; outcome: 'merged' | 'declined'; run: RunRecord }
  | { v: 1; type: 'blocked'; reason: TrackBlockReason; run: RunRecord }
  | { v: 1; type: 'rebound'; number: number; url: string }
  | { v: 1; type: 'revision_started'; feedback: FeedbackRef[]; run: RunRecord }
  | { v: 1; type: 'revision_pushing'; candidateSha: string }
  | { v: 1; type: 'revision_confirmed'; headSha: string; run: RunRecord }
  | { v: 1; type: 'action_issued'; action: PendingAction }
  | { v: 1; type: 'action_observed' };

function fail(): never {
  throw new TrackError('invalid_journal');
}
function sameRun(a: RunRecord, b: RunRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function digestOf(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}
/** GitHub's web editor stores CRLF line endings and may drop trailing whitespace. */
function sameText(a: string | null, b: string): boolean {
  return (a ?? '').replace(/\r\n?/gu, '\n').trimEnd() === b.replace(/\r\n?/gu, '\n').trimEnd();
}

/** Only the same controller run or an exact forward continuation may be observed. */
function continuation(previous: RunRecord, value: unknown): RunRecord {
  const run = restoreRun(value);
  if (
    run.runId !== previous.runId ||
    run.upstreamIssue !== previous.upstreamIssue ||
    run.contributor !== previous.contributor ||
    run.createdAt !== previous.createdAt ||
    run.history.length < previous.history.length ||
    JSON.stringify(run.history.slice(0, previous.history.length)) !==
      JSON.stringify(previous.history)
  )
    fail();
  return run;
}

/** The transition must be exactly `reason` applied to the current run. */
function stepped(state: TrackState, raw: Record<string, unknown>, reason: ReasonCode): RunRecord {
  const run = restoreRun(raw.run);
  if (!sameRun(run, transitionRun(state.run, reason, run.updatedAt))) fail();
  return run;
}

function prUrl(pr: Pick<TrackedPr, 'binding' | 'number'>): string {
  const { owner, repo } = pr.binding.upstream;
  return `https://github.com/${enc(owner)}/${enc(repo)}/pull/${pr.number}`;
}

function trackedPr(value: unknown): TrackedPr {
  if (!isRecord(value) || !isRecord(value.fork)) fail();
  const binding = prBinding(value.binding);
  const fork = value.fork as unknown as ForkRef;
  try {
    forkTarget(fork, binding.branch); // Validates the fork reference.
  } catch {
    fail();
  }
  if (
    !Number.isSafeInteger(value.number) ||
    (value.number as number) < 1 ||
    typeof value.url !== 'string' ||
    value.url.toLowerCase() !== prUrl({ binding, number: value.number as number }).toLowerCase() ||
    typeof value.marker !== 'string' ||
    findHandoffMarkers(value.marker).length !== 1 ||
    findHandoffMarkers(value.marker)[0] !== value.marker ||
    !value.marker.endsWith(' op=pr_create -->')
  )
    fail();
  return Object.freeze({
    binding,
    fork: Object.freeze({ repositoryId: fork.repositoryId, owner: fork.owner, repo: fork.repo }),
    number: value.number as number,
    url: value.url,
    marker: value.marker,
  });
}

function actionOf(state: TrackState, raw: unknown, directory: string | null): PendingAction {
  if (!isRecord(raw) || !isRecord(raw.input)) fail();
  const kind = raw.kind as ActionKind;
  const input = raw.input as unknown as IntentInput;
  const op = kind === 'withdraw' ? 'pr_close' : 'pr_update';
  if (
    !['edit', 'withdraw', 'reopen'].includes(kind) ||
    input.operationKind !== op ||
    input.contributionId !== state.contributionId ||
    input.target !== state.pr.url ||
    input.candidateSha !== state.verifiedSha ||
    raw.link !== state.pr.url ||
    !isAdmitted(op, state.run.state)
  )
    fail();
  handoffIntentId(input); // Validates shape and secrets.
  const text = kind !== 'reopen';
  if (text) {
    if (
      typeof raw.body !== 'string' ||
      raw.bodyDigest !== digestOf(raw.body) ||
      typeof raw.bodyFile !== 'string' ||
      !path.isAbsolute(raw.bodyFile) ||
      (directory !== null && path.dirname(raw.bodyFile) !== directory) ||
      path.basename(raw.bodyFile) !== `${handoffIntentId(input)}-${kind}.md`
    )
      fail();
    assertNoSecrets(raw.body);
  } else if (raw.body !== undefined || raw.bodyFile !== undefined || raw.title !== undefined)
    fail();
  if (
    kind === 'edit' &&
    (typeof raw.title !== 'string' || !hasOnlyMarker(raw.body, state.pr.marker))
  )
    fail();
  if (kind === 'withdraw') {
    if (!['maintainer_request', 'user_instruction'].includes(raw.reason as string)) fail();
    if (!hasOnlyMarker(raw.body, handoffMarker(input))) fail();
  } else if (raw.reason !== undefined) fail();
  return Object.freeze({
    kind,
    input: Object.freeze({ ...input }),
    link: raw.link as string,
    ...(kind === 'edit' ? { title: raw.title as string } : {}),
    ...(text
      ? {
          body: raw.body as string,
          bodyFile: raw.bodyFile as string,
          bodyDigest: raw.bodyDigest as string,
        }
      : {}),
    ...(kind === 'withdraw' ? { reason: raw.reason as WithdrawalReason } : {}),
  });
}

const TRACKING: readonly RunState[] = ['submitted', 'awaiting_review', 'accepted'];

function reduce(state: TrackState | undefined, raw: unknown, directory: string | null): TrackState {
  if (!isRecord(raw) || raw.v !== 1) fail();
  if (raw.type === 'track') {
    if (state || typeof raw.contributionId !== 'string' || !isCommitSha(raw.verifiedSha)) fail();
    const run = restoreRun(raw.run);
    const pr = trackedPr(raw.pr);
    // The run, never a caller, names the target: its issue's repository and contributor.
    const issue = upstreamIssueBinding(run.upstreamIssue).upstream;
    if (
      !TRACKING.includes(run.state) ||
      !sameLogin(issue.owner, pr.binding.upstream.owner) ||
      !sameLogin(issue.repo, pr.binding.upstream.repo) ||
      !sameLogin(pr.binding.headOwner, run.contributor)
    )
      fail();
    return {
      run,
      contributionId: raw.contributionId,
      pr,
      verifiedSha: raw.verifiedSha,
      addressed: new Map(),
    };
  }
  if (!state) fail();
  // A block fences everything after it except lifecycle progress made elsewhere.
  if (state.blockedReason && raw.type !== 'run_update') fail();
  switch (raw.type) {
    case 'run_update':
      return { ...state, run: continuation(state.run, raw.run) };
    case 'review_awaited':
      if (state.run.state !== 'submitted') fail();
      return { ...state, run: stepped(state, raw, ReasonCode.ReviewAwaited) };
    case 'outcome': {
      if (raw.outcome !== 'merged' && raw.outcome !== 'declined') fail();
      const reason =
        raw.outcome === 'merged' ? ReasonCode.ObservedUpstreamMerge : ReasonCode.UpstreamDeclined;
      // The withdrawal is satisfied by the close it asked for, or overtaken by a merge.
      return { ...state, run: stepped(state, raw, reason), action: undefined };
    }
    case 'blocked':
      if (!TRACK_BLOCK_REASONS.includes(raw.reason as TrackBlockReason)) fail();
      return {
        ...state,
        run: stepped(state, raw, ReasonCode.PolicyBlocked),
        blockedReason: raw.reason as TrackBlockReason,
      };
    case 'rebound': {
      const number = raw.number as number;
      if (number === state.pr.number || state.action || state.revision) fail();
      const pr = trackedPr({ ...state.pr, number, url: raw.url });
      return { ...state, pr };
    }
    case 'revision_started': {
      if (state.revision || state.action || !Array.isArray(raw.feedback) || !raw.feedback.length)
        fail();
      const feedback = raw.feedback.map((f) => {
        if (!isRecord(f) || typeof f.id !== 'string' || typeof f.updatedAt !== 'string') fail();
        return Object.freeze({ id: f.id, updatedAt: f.updatedAt });
      });
      return {
        ...state,
        run: stepped(state, raw, ReasonCode.RevisionRequested),
        revision: Object.freeze({ fromSha: state.verifiedSha, feedback }),
      };
    }
    case 'revision_pushing':
      if (
        !state.revision ||
        state.revision.candidateSha ||
        state.run.state !== 'shipping' ||
        !isCommitSha(raw.candidateSha) ||
        raw.candidateSha === state.verifiedSha
      )
        fail();
      return {
        ...state,
        revision: Object.freeze({ ...state.revision, candidateSha: raw.candidateSha }),
      };
    case 'revision_confirmed': {
      const revision = state.revision;
      if (!revision?.candidateSha || raw.headSha !== revision.candidateSha || state.action) fail();
      const addressed = new Map(state.addressed);
      for (const f of revision.feedback) addressed.set(f.id, f.updatedAt);
      return {
        ...state,
        run: stepped(state, raw, ReasonCode.PublicationObserved),
        verifiedSha: revision.candidateSha,
        addressed,
        revision: undefined,
      };
    }
    case 'action_issued':
      if (state.action) fail();
      return { ...state, action: actionOf(state, raw.action, directory) };
    case 'action_observed':
      if (!state.action) fail();
      return { ...state, action: undefined };
    default:
      return fail();
  }
}

export function replayTrack(events: readonly unknown[], bodyDirectory?: string): TrackState {
  const directory = bodyDirectory === undefined ? null : path.resolve(bodyDirectory);
  let state: TrackState | undefined;
  for (const event of events) if (!isRecoveryEvent(event)) state = reduce(state, event, directory);
  if (!state) fail();
  return state;
}

/** Remarks a revision should address: not the contributor's own, not the run's prepared
 * comments, and not already addressed by a confirmed revision unless edited since (AC5). */
export function actionableFeedback(
  state: TrackState,
  feedback: readonly FeedbackItem[]
): FeedbackItem[] {
  return feedback.filter(
    (f) =>
      !sameLogin(f.author, state.run.contributor) &&
      findHandoffMarkers(f.body).length === 0 &&
      state.addressed.get(f.id) !== f.updatedAt
  );
}

function ciText(ci: CiState | 'not_observed', sha?: string): string {
  const at = sha ? ` at ${sha}` : '';
  switch (ci) {
    case 'passed':
      return `Upstream checks passed${at}.`;
    case 'pending':
      return `Upstream checks are still running${at}; nothing is green yet.`;
    case 'awaiting_approval':
      return `Upstream checks${at} are waiting for a maintainer to approve them; nothing has run, so nothing is green.`;
    case 'failed':
      return `Upstream checks failed${at}.`;
    case 'none':
      return `No upstream checks are reported${at}; nothing is green.`;
    case 'unknown':
      return `Upstream checks${at} could not be read; nothing is claimed about them.`;
    default:
      return 'Upstream checks have not been read since the run was loaded; resume to read them.';
  }
}

const drivenJournals = new WeakSet<Journal>();
/** One read: the PR as observed, or an ambiguous re-detection a person must settle. */
type Read = Exclude<PrTrack, { kind: 'unknown' }> | { kind: 'handoff'; reason: AmbiguityReason };

/** Serial controller driver over its own journal; the directory is controller-owned. */
export class PrTracker {
  private state: TrackState;
  private seen: Seen | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly journal: Journal,
    private readonly deps: TrackDeps,
    initial: { run: RunRecord; contributionId: string; pr: TrackedPr; headSha: string }
  ) {
    if (drivenJournals.has(journal)) throw new TrackError('journal_in_use');
    const directory = path.resolve(deps.bodyDirectory);
    const events = journal.read().filter((event) => !isRecoveryEvent(event));
    if (!events.length) {
      const event: Event = {
        v: 1,
        type: 'track',
        run: restoreRun(initial.run),
        contributionId: initial.contributionId,
        pr: initial.pr,
        verifiedSha: initial.headSha,
      };
      this.state = reduce(undefined, event, directory);
      journal.append(event);
    } else {
      this.state = replayTrack(events, directory);
      if (this.state.contributionId !== initial.contributionId) fail();
      this.observeRun(initial.run);
    }
    drivenJournals.add(journal);
  }

  snapshot(): TrackState {
    return { ...this.state, addressed: new Map(this.state.addressed) };
  }

  /** Record lifecycle progress made elsewhere (isolated revision and verification). */
  observeRun(value: RunRecord): void {
    const run = continuation(this.state.run, value);
    if (run.history.length !== this.state.run.history.length)
      this.persist({ v: 1, type: 'run_update', run });
  }

  private persist(event: Event): void {
    const next = reduce(this.state, event, path.resolve(this.deps.bodyDirectory));
    this.journal.append(event);
    this.state = next;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(work);
    this.tail = pending.catch(() => undefined);
    return pending;
  }

  private transition(reason: ReasonCode): RunRecord {
    return transitionRun(this.state.run, reason, this.deps.now());
  }

  status(): TrackStatus {
    const s = this.state;
    const seen = this.seen;
    const action = s.action && this.describe(s.action);
    const ci: TrackStatus['ci'] = seen?.ci ?? 'not_observed';
    const facts = {
      state: s.run.state,
      pr: s.pr.url,
      headSha: s.verifiedSha,
      ci,
      ...(seen ? { ciSha: seen.headSha } : {}),
      feedback: seen?.actionable ?? null,
      ...(action ? { action } : {}),
      ...(s.blockedReason ? { blockedReason: s.blockedReason } : {}),
    };
    return Object.freeze({ ...facts, nextPermittedAction: this.next(ci, seen?.headSha) });
  }

  private next(ci: CiState | 'not_observed', sha?: string): string {
    const s = this.state;
    const checks = ciText(ci, sha);
    if (s.blockedReason)
      return `Blocked (${s.blockedReason}); nothing further runs. Inspect ${s.pr.url} and start a new run if the contribution should continue.`;
    if (s.action) return this.describe(s.action).instructions;
    switch (s.run.state) {
      case 'merged':
        return `Merged upstream at ${s.pr.url}; nothing further.`;
      case 'declined':
        return `Closed without merge at ${s.pr.url}. Reopening it is your action on GitHub; a new run would track it. Nothing is deleted and no follow-up is sent.`;
      case 'submitted':
        return `Submitted at ${s.pr.url}. ${checks} Resume to read the pull request and its checks.`;
      case 'awaiting_review':
      case 'accepted': {
        const n = this.seen?.actionable;
        const feedback = n
          ? `${n} review item(s) are not addressed at ${s.verifiedSha}; resume with a revision to address them.`
          : 'Waiting for maintainer review; no compute runs until you resume.';
        return `${feedback} ${checks}`;
      }
      case 'revising':
      case 'verifying':
        return 'Revision in progress: the candidate is produced and verified in isolation before anything is pushed.';
      case 'shipping':
        return s.revision?.candidateSha
          ? `Revision ${s.revision.candidateSha} is pushed or pushing; resume to confirm the pull request head shows it.`
          : 'Ship the verified revision to the same fork branch.';
      default:
        return `Run is ${s.run.state}; the pull request is not tracked in this state.`;
    }
  }

  private describe(action: PendingAction): ContributorAction {
    const author = this.state.run.contributor;
    const paste = action.bodyFile ? ` The prepared text is in ${action.bodyFile}.` : '';
    const instructions = {
      edit: `Open the pull request at the link, choose Edit, and set the title and description to the prepared text from your own account (${author}).${paste} Keep the hidden ai-dossier marker line. Then resume; the run records the edit only after it reads it back.`,
      withdraw: `Open the pull request at the link, post the prepared comment from your own account (${author}), then close the pull request.${paste} Keep the hidden ai-dossier marker line. Nothing is deleted. Then resume; the run records the contribution declined only after it observes the pull request closed, and sends no follow-up.`,
      reopen: `The pull request was closed while a revision was in progress. To continue, reopen it at the link from your own account (${author}) and resume; otherwise cancel the run. Nothing is pushed while it is closed.`,
    }[action.kind];
    return Object.freeze({
      kind: action.kind,
      link: action.link,
      ...(action.title === undefined ? {} : { title: action.title }),
      ...(action.bodyFile ? { bodyFile: action.bodyFile, bodyDigest: action.bodyDigest } : {}),
      author,
      instructions,
    });
  }

  private block(reason: TrackBlockReason): TrackOutcome {
    if (
      !this.state.blockedReason &&
      permittedTransitions(this.state.run.state)[ReasonCode.PolicyBlocked]
    )
      this.persist({
        v: 1,
        type: 'blocked',
        reason,
        run: this.transition(ReasonCode.PolicyBlocked),
      });
    return { kind: 'blocked', reason, status: this.status() };
  }

  private settled(): TrackOutcome | null {
    const s = this.state;
    if (s.blockedReason) return { kind: 'blocked', reason: s.blockedReason, status: this.status() };
    if (s.run.state === 'merged' || s.run.state === 'declined')
      return { kind: s.run.state, status: this.status() };
    if (TERMINAL_STATES.includes(s.run.state)) throw new TrackError('run_closed');
    return null;
  }

  /** One read of the tracked PR, following a replacement PR when the tracked one is closed
   * (AC6). `null` means GitHub could not be read and nothing was recorded. */
  private async observe(): Promise<Read | null> {
    let track = await observePr(this.deps.read, this.state.pr);
    if (track.kind === 'unknown') return null;
    const closed = track.kind === 'observed' && track.state === 'closed' && !track.merged;
    // A pending withdrawal asked for exactly this close: it is the answer, not a lead.
    if (closed && this.state.action?.kind !== 'withdraw' && !this.state.revision) {
      const moved = await relocatePr(this.deps.read, this.state.pr, this.state.run.contributor);
      if (moved.kind === 'unknown') return null;
      if (moved.kind === 'ambiguous') return { kind: 'handoff', reason: moved.reason };
      if (moved.kind === 'found') {
        this.persist({ v: 1, type: 'rebound', number: moved.number, url: moved.url });
        track = await observePr(this.deps.read, this.state.pr);
        if (track.kind === 'unknown') return null;
      }
    }
    if (track.kind === 'observed' && track.ci)
      this.seen = {
        ci: track.ci,
        headSha: track.headSha,
        actionable: track.feedback ? actionableFeedback(this.state, track.feedback).length : null,
      };
    return track as Read;
  }

  /** The pending contributor action, confirmed only by what the read shows. */
  private confirmAction(track: Extract<PrTrack, { kind: 'observed' }>): void {
    const action = this.state.action;
    if (!action) return;
    const done =
      action.kind === 'edit'
        ? track.title === action.title && sameText(track.body, action.body as string)
        : action.kind === 'reopen'
          ? track.state === 'open'
          : false; // A withdrawal is confirmed by the `declined` outcome itself.
    if (done) this.persist({ v: 1, type: 'action_observed' });
  }

  /** Heads the run may see: the last verified one, or its own revision once pushed. */
  private unexpectedHead(track: Extract<PrTrack, { kind: 'observed' }>): boolean {
    const allowed = [this.state.verifiedSha, this.state.revision?.candidateSha];
    return (
      !allowed.includes(track.headSha) ||
      (track.branchSha !== null && !allowed.includes(track.branchSha))
    );
  }

  /** Explicit resume: the only time the run reads the PR (PRD §5.3; no background polling). */
  resume(): Promise<TrackOutcome> {
    return this.serial(() => this.track());
  }

  private async track(): Promise<TrackOutcome> {
    const settled = this.settled();
    if (settled) return settled;
    return this.apply(await this.observe());
  }

  /** AC1 on one observation: only what was read moves the run. */
  private apply(track: Read | null): TrackOutcome {
    if (!track) return { kind: 'unknown', status: this.status() };
    if (track.kind === 'handoff') return { ...track, status: this.status() };
    if (track.kind === 'gone') return this.block(track.reason);
    this.confirmAction(track);
    const state = this.state.run.state;
    if (state === 'shipping' && this.state.revision) return this.confirmRevision(track);
    if (!TRACKING.includes(state)) return { kind: 'tracking', status: this.status() };
    if (track.merged) {
      const run = this.transition(ReasonCode.ObservedUpstreamMerge);
      this.persist({ v: 1, type: 'outcome', outcome: 'merged', run });
      return { kind: 'merged', status: this.status() };
    }
    if (track.state === 'closed') {
      const run = this.transition(ReasonCode.UpstreamDeclined);
      this.persist({ v: 1, type: 'outcome', outcome: 'declined', run });
      return { kind: 'declined', status: this.status() };
    }
    if (this.unexpectedHead(track)) return this.block('unexpected_head_sha');
    if (state === 'submitted')
      this.persist({
        v: 1,
        type: 'review_awaited',
        run: this.transition(ReasonCode.ReviewAwaited),
      });
    return { kind: 'tracking', status: this.status() };
  }

  /** Freshness immediately before every revision step (PRD §5.9). A probe that answers no
   * blocks; one that cannot answer refuses without recording anything. */
  private async fresh(): Promise<TrackBlockReason | null> {
    const { admission } = this.deps;
    const probes = [
      ['admission_policy', () => admission.policyFresh()],
      ['admission_contributor', () => admission.contributorVerified()],
      ['admission_fork_binding', () => admission.forkBindingVerified()],
    ] as const;
    for (const [reason, probe] of probes) {
      let ok: boolean;
      try {
        ok = (await probe()) === true;
      } catch {
        throw new TrackError('freshness_unavailable');
      }
      if (!ok) return reason;
    }
    return null;
  }

  /** Explicit resume into a revision (AC2): read the PR, recheck freshness, and start one
   * only for review items not already addressed at the current head (AC5). The returned
   * feedback is untrusted input for the isolated revision. */
  beginRevision(): Promise<TrackOutcome> {
    return this.serial(async () => {
      const settled = this.settled();
      if (settled) return settled;
      if (this.state.action) throw new TrackError('action_pending');
      const track = await this.observe();
      const outcome = this.apply(track);
      if (outcome.kind !== 'tracking' || !TRACKING.includes(this.state.run.state)) return outcome;
      if (track?.kind !== 'observed' || !track.feedback)
        return { kind: 'unknown', status: this.status() };
      const feedback = actionableFeedback(this.state, track.feedback);
      if (!feedback.length) return { kind: 'nothing_to_revise', status: this.status() };
      const stale = await this.fresh();
      if (stale) return this.block(stale);
      this.persist({
        v: 1,
        type: 'revision_started',
        feedback: feedback.map((f) => ({ id: f.id, updatedAt: f.updatedAt })),
        run: this.transition(ReasonCode.RevisionRequested),
      });
      return { kind: 'revising', feedback, status: this.status() };
    });
  }

  /** Ship the verified revision (AC2): freshness again, then the CAS push from the last
   * verified SHA through the caller's `IntentDriver.execute` (`ForkPusher`, a fresh
   * receipt), then the PR head must show the candidate. Unexpected commits block. */
  shipRevision(request: {
    candidateSha: string;
    push: (intent: IntentInput) => Promise<string>;
  }): Promise<TrackOutcome> {
    return this.serial(async () => {
      const settled = this.settled();
      if (settled) return settled;
      const { candidateSha } = request;
      const revision = this.state.revision;
      if (this.state.run.state !== 'shipping' || !revision) throw new TrackError('admission_state');
      if (!isCommitSha(candidateSha) || candidateSha === this.state.verifiedSha)
        throw new TrackError('invalid_candidate');
      if (revision.candidateSha && revision.candidateSha !== candidateSha)
        throw new TrackError('candidate_changed');
      const stale = await this.fresh();
      if (stale) return this.block(stale);
      const track = await this.observe();
      if (!track) return { kind: 'unknown', status: this.status() };
      if (track.kind === 'handoff') return { ...track, status: this.status() };
      if (track.kind === 'gone') return this.block(track.reason);
      this.confirmAction(track);
      if (track.merged || track.state === 'closed') return this.closedDuringRevision(track);
      // Only the last verified SHA, or this candidate after a lost push response (scenario 18).
      const allowed = [revision.fromSha, candidateSha];
      if (
        !allowed.includes(track.headSha) ||
        (track.branchSha !== null && !allowed.includes(track.branchSha))
      )
        return this.block('unexpected_head_sha');
      if (!revision.candidateSha) this.persist({ v: 1, type: 'revision_pushing', candidateSha });
      if (track.branchSha !== candidateSha) {
        try {
          await request.push({
            contributionId: this.state.contributionId,
            target: forkTarget(this.state.pr.fork, this.state.pr.binding.branch),
            operationKind: 'push_branch',
            candidateSha,
          });
        } catch (error) {
          // The intent journal blocked (diverged remote, refused receipt): so does tracking.
          if (error instanceof WriteBlockedError) return this.block('push_blocked');
          throw error;
        }
      }
      const after = await this.observe();
      if (!after || after.kind === 'handoff')
        return { kind: 'revision_pending', candidateSha, status: this.status() };
      if (after.kind === 'gone') return this.block(after.reason);
      return this.confirmRevision(after);
    });
  }

  private pendingAction(): TrackOutcome {
    return {
      kind: 'action',
      action: this.describe(this.state.action as PendingAction),
      status: this.status(),
    };
  }

  /** A merge overtakes the revision; a close pauses it behind a reopen hand-off. */
  private closedDuringRevision(track: Extract<PrTrack, { kind: 'observed' }>): TrackOutcome {
    // Merged mid-revision: the outcome is upstream's; the run reports it and pushes nothing.
    if (track.merged) return { kind: 'tracking', status: this.status() };
    if (!this.state.action)
      this.issue({
        kind: 'reopen',
        input: this.input('pr_update'),
        link: this.state.pr.url,
      });
    return this.pendingAction();
  }

  private confirmRevision(track: Extract<PrTrack, { kind: 'observed' }>): TrackOutcome {
    const revision = this.state.revision as Revision;
    if (track.merged || track.state === 'closed') return this.closedDuringRevision(track);
    if (this.unexpectedHead(track)) return this.block('unexpected_head_sha');
    // Nothing pushed yet: the revision waits for `shipRevision`.
    if (!revision.candidateSha) return { kind: 'tracking', status: this.status() };
    if (track.headSha !== revision.candidateSha)
      return {
        kind: 'revision_pending',
        candidateSha: revision.candidateSha,
        status: this.status(),
      };
    this.persist({
      v: 1,
      type: 'revision_confirmed',
      headSha: track.headSha,
      run: this.transition(ReasonCode.PublicationObserved),
    });
    if (this.seen) this.seen = { ...this.seen, actionable: null };
    return { kind: 'revised', headSha: track.headSha, status: this.status() };
  }

  private input(operationKind: 'pr_update' | 'pr_close'): IntentInput {
    return {
      contributionId: this.state.contributionId,
      target: this.state.pr.url,
      operationKind,
      candidateSha: this.state.verifiedSha,
    };
  }

  private issue(action: PendingAction): void {
    let stored = action;
    if (action.body !== undefined) {
      const directory = path.resolve(this.deps.bodyDirectory);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const bodyFile = path.join(directory, `${handoffIntentId(action.input)}-${action.kind}.md`);
      const text = action.title === undefined ? action.body : `${action.title}\n\n${action.body}`;
      // Write-ahead: the prepared text exists before the journal makes the action visible.
      replacePrivate(bodyFile, Buffer.from(text, 'utf8'));
      stored = { ...action, bodyFile, bodyDigest: digestOf(action.body) };
    }
    this.persist({ v: 1, type: 'action_issued', action: stored });
  }

  /** AC3: a title or description change during a revision is the contributor's edit on the
   * PR page; GitHub has no prefill for edits. The run confirms it by reading it back. */
  requestEdit(request: {
    title: string;
    body: string;
    /** Receipt commands backing any success claim in the text. */
    evidence?: readonly CommandEvidence[];
  }): Promise<TrackOutcome> {
    return this.serial(async () => {
      const settled = this.settled();
      if (settled) return settled;
      if (!this.state.revision || !isAdmitted('pr_update', this.state.run.state))
        throw new TrackError('admission_state');
      if (this.state.action) return this.pendingAction();
      const title = prTitle(request.title);
      const body = request.body;
      if (typeof body !== 'string' || body.length > MAX_BODY_LENGTH)
        throw new HandoffError('invalid_body');
      // The PR stays findable by its marker (AC6) only if the edit keeps it.
      if (!hasOnlyMarker(body, this.state.pr.marker)) throw new HandoffError('marker_required');
      assertNoSecrets(body);
      assertContentPolicy(`${title}\n${body}`, request.evidence);
      this.issue({
        kind: 'edit',
        input: this.input('pr_update'),
        link: this.state.pr.url,
        title,
        body,
      });
      return this.pendingAction();
    });
  }

  /** AC4: withdrawal on a maintainer request or the user's instruction. The contributor
   * posts the prepared comment and closes the PR; `declined` is recorded only when a later
   * resume observes it closed. Nothing is deleted and nothing follows up. */
  requestWithdrawal(request: {
    reason: WithdrawalReason;
    explanation: string;
  }): Promise<TrackOutcome> {
    return this.serial(async () => {
      const settled = this.settled();
      if (settled) return settled;
      const state = this.state.run.state;
      if (
        !['maintainer_request', 'user_instruction'].includes(request.reason) ||
        !isAdmitted('pr_close', state) ||
        !permittedTransitions(state)[ReasonCode.UpstreamDeclined]
      )
        throw new TrackError('admission_state');
      if (this.state.action) return this.pendingAction();
      const input = this.input('pr_close');
      const body = `${untrustedText(request.explanation, 2000)}\n\n${handoffMarker(input)}`;
      assertContentPolicy(body);
      this.issue({
        kind: 'withdraw',
        input,
        link: this.state.pr.url,
        body,
        reason: request.reason,
      });
      return this.pendingAction();
    });
  }
}
