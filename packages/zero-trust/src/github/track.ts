/** Upstream PR tracking and revisions (#1068; PRD §5.8 `submitted` → `awaiting_review` →
 * `revising` → `merged`/`declined`, §5.9 "Update PR" and "Withdraw contribution", scenarios
 * 12, 13 and 16). Every upstream fact comes from a credential-free read made on an explicit
 * resume; nothing polls in the background. A revision ships as a new verified candidate
 * pushed with the #1066 CAS to the same fork branch, which updates the PR. Title or body
 * edits, withdrawal and reopening are contributor actions the run confirms by reading the
 * PR again; it never writes upstream and never claims what it has not observed. */
import path from 'node:path';
import { isTrackerContinuation } from '../controller/tracker-continuation';
import { writePrivateFile } from '../durable-fs';
import { type IntentInput, isAdmitted, WriteBlockedError } from '../intents';
import type { Journal } from '../journal';
import type { CommandEvidence } from '../receipt/schema';
import { isRecoveryEvent } from '../recovery';
import { assertNoSecrets } from '../redaction';
import {
  isRecord,
  isRunContinuation,
  permittedTransitions,
  ReasonCode,
  type RunRecord,
  type RunState,
  restoreRun,
  sameRunRecord,
  TERMINAL_STATES,
  transitionRun,
} from '../state';
import { type ForkRef, ForkRefError, forkTarget, isCommitSha, readForkBranch } from './fork-ref';
import {
  bodyDigest,
  findHandoffMarkers,
  handoffIntentId,
  handoffMarker,
  hasOnlyMarker,
  MAX_BODY_LENGTH,
  MAX_PR_TITLE_LENGTH,
  markerOperation,
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

/** Upstream checks as observed at one head SHA (scenario 12). `none`: nothing ran or
 * reported yet; `unknown`: a read failed or an answer was not understood. Only `passed`
 * (at least one success, nothing failing or outstanding) is green. */
export type CiState = 'none' | 'pending' | 'awaiting_approval' | 'failed' | 'passed' | 'unknown';

/** Accounts whose remarks are maintainer feedback (PRD §5.9 permission authority). */
export const MAINTAINER_ASSOCIATIONS = Object.freeze(['OWNER', 'MEMBER', 'COLLABORATOR'] as const);

/** One maintainer remark. Its body is untrusted text: data for the isolated revision, never
 * an instruction to the controller (PRD §5.8). */
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

/** Why a tracked PR can no longer be followed; each blocks the run (PRD §5.9). */
export type GoneReason = 'pr_deleted' | 'fork_deleted' | 'fork_replaced' | 'branch_deleted';
/** One credential-free read of the tracked PR. */
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
  /** `detail` is secret-free: which read failed and its HTTP status. */
  | { readonly kind: 'unknown'; readonly detail?: string };
type Observed = Extract<PrTrack, { kind: 'observed' }>;

const PAGE_SIZE = 100;
const MAX_CHECK_PAGES = 10;
const MAX_FEEDBACK_PAGES = 30;
const MAX_FEEDBACK_BODY = 65536;
export const MAX_WITHDRAWAL_EXPLANATION = 2000;

function enc(value: string): string {
  return encodeURIComponent(value);
}
function repoPath(binding: PrBinding): string {
  return `/repos/${enc(binding.upstream.owner)}/${enc(binding.upstream.repo)}`;
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
    const separator = p.includes('?') ? '&' : '?';
    const response = await get(read, `${p}${separator}per_page=${PAGE_SIZE}&page=${page}`);
    const body = response?.status === 200 && isRecord(response.body) ? response.body : null;
    const list = body?.[key];
    if (!body || !Array.isArray(list) || !Number.isSafeInteger(body.total_count)) return null;
    items.push(...list);
    if (list.length < PAGE_SIZE || items.length >= (body.total_count as number)) return items;
  }
  return null;
}

type Verdict = 'passed' | 'skipped' | 'failed' | 'awaiting_approval' | 'pending' | 'unknown';
const SKIPPED = ['neutral', 'skipped'];
const FAILED = ['failure', 'timed_out', 'cancelled', 'startup_failure'];

/** One check run or workflow run; an item for another commit is not evidence for `sha`. */
function runVerdict(item: unknown, sha: string): Verdict {
  if (!isRecord(item) || item.head_sha !== sha) return 'unknown';
  const { status, conclusion } = item;
  // A fork PR's workflows wait for a maintainer's approval before anything runs.
  if (status === 'action_required' || status === 'waiting' || conclusion === 'action_required')
    return 'awaiting_approval';
  if (status !== 'completed') return typeof status === 'string' ? 'pending' : 'unknown';
  if (conclusion === 'success') return 'passed';
  if (SKIPPED.includes(conclusion as string)) return 'skipped';
  if (FAILED.includes(conclusion as string)) return 'failed';
  return conclusion === 'stale' ? 'pending' : 'unknown';
}

function statusVerdict(state: unknown): Verdict {
  if (state === 'success') return 'passed';
  if (state === 'pending') return 'pending';
  return state === 'failure' || state === 'error' ? 'failed' : 'unknown';
}

/** Upstream CI at `sha`, from check runs, workflow runs and commit statuses. Never inferred:
 * a check that has not run is not green, everything skipped is `none`, and an unreadable
 * answer is `unknown`. */
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
  const verdicts = [...checks, ...runs].map((item) => runVerdict(item, sha));
  // GitHub reports `pending` for a commit with no statuses at all: count only real ones.
  if ((status.total_count as number) > 0) verdicts.push(statusVerdict(status.state));
  for (const verdict of ['failed', 'awaiting_approval', 'pending', 'unknown'] as const)
    if (verdicts.includes(verdict)) return verdict;
  return verdicts.includes('passed') ? 'passed' : 'none';
}

const FEEDBACK_SOURCES = Object.freeze([
  ['review', 'pulls', 'reviews'],
  ['review_comment', 'pulls', 'comments'],
  ['comment', 'issues', 'comments'],
] as const);

/** One remark as GitHub lists it; null when malformed, undefined when not feedback. */
function feedbackItem(
  kind: (typeof FEEDBACK_SOURCES)[number][0],
  raw: unknown,
  prUrl: string
): FeedbackItem | null | undefined {
  if (!isRecord(raw)) return null;
  // A pending review is not visible yet; a deleted account (no user) cannot be a maintainer.
  if ((kind === 'review' && raw.state === 'PENDING') || !isRecord(raw.user)) return undefined;
  const author = raw.user.login;
  const updatedAt = kind === 'review' ? raw.submitted_at : raw.updated_at;
  if (
    !Number.isSafeInteger(raw.id) ||
    typeof author !== 'string' ||
    typeof updatedAt !== 'string' ||
    typeof raw.html_url !== 'string' ||
    !raw.html_url.toLowerCase().startsWith(`${prUrl.toLowerCase()}#`) ||
    (raw.body !== null && typeof raw.body !== 'string')
  )
    return null;
  const body = ((raw.body as string | null) ?? '').slice(0, MAX_FEEDBACK_BODY);
  if (
    raw.user.type === 'Bot' ||
    !(MAINTAINER_ASSOCIATIONS as readonly unknown[]).includes(raw.author_association) ||
    // Approvals and empty comment-only reviews carry nothing to address.
    (kind === 'review' && raw.state !== 'CHANGES_REQUESTED' && !body.trim())
  )
    return undefined;
  return Object.freeze({
    id: `${kind}:${raw.id}`,
    author,
    updatedAt,
    url: raw.html_url,
    body,
    ...(isCommitSha(raw.commit_id) ? { commitSha: raw.commit_id } : {}),
  });
}

/** Maintainer reviews, review comments and conversation comments on the PR; null when
 * a listing is unreadable or an entry is malformed. */
export async function observeFeedback(
  read: GitHubRead,
  pr: Pick<TrackedPr, 'binding' | 'number' | 'url'>
): Promise<FeedbackItem[] | null> {
  const repo = repoPath(prBinding(pr.binding));
  const items: FeedbackItem[] = [];
  for (const [kind, scope, list] of FEEDBACK_SOURCES) {
    const listed = await listAll(
      read,
      `${repo}/${scope}/${pr.number}/${list}?sort=created`,
      MAX_FEEDBACK_PAGES
    );
    if (!listed) return null;
    for (const raw of listed) {
      const item = feedbackItem(kind, raw, pr.url);
      if (item === null) return null;
      if (item) items.push(item);
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
    return { kind: 'unknown', detail: `pull:${response?.status ?? 'unreachable'}` };
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
    const status = error instanceof ForkRefError ? (error.status ?? 'unreachable') : 'error';
    return { kind: 'unknown', detail: `fork_ref:${status}` };
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

/** The result of looking for a replacement PR. */
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

export const TRACK_ERROR_CODES = Object.freeze([
  /** The journal holds an event this tracker would not have produced. */
  'invalid_journal',
  /** The supplied run is not this journal's run, nor a copy of it. */
  'run_diverged',
  'journal_in_use',
  /** The run is terminal in a state this tracker does not report. */
  'run_closed',
  'action_pending',
  'no_action',
  'admission_state',
  'invalid_candidate',
  'candidate_changed',
  /** A freshness probe could not answer; nothing was recorded. */
  'freshness_unavailable',
] as const);
export type TrackErrorCode = (typeof TRACK_ERROR_CODES)[number];

/** A refused tracking call or an invalid journal. `detail` is secret-free. */
export class TrackError extends Error {
  constructor(
    readonly code: TrackErrorCode,
    readonly detail?: string,
    options?: ErrorOptions
  ) {
    super(`Zero-trust PR tracking refused: ${code}${detail ? ` (${detail})` : ''}`, options);
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
  /** Upstream merged the PR while a revision was in progress: nothing more is pushed. */
  'merged_during_revision',
  'admission_policy',
  'admission_contributor',
  'admission_fork_binding',
  /** The CAS push refused or diverged; the intent journal holds the detail. */
  'push_blocked',
] as const);
/** Why tracking stopped; recorded with the run's `policy_blocked` transition. */
export type TrackBlockReason = (typeof TRACK_BLOCK_REASONS)[number];

/** Freshness before every revision (PRD §5.9): the same probes the PR hand-off admits on. */
export type RevisionAdmission = Pick<
  HandoffAdmission,
  'policyFresh' | 'contributorVerified' | 'forkBindingVerified'
>;

/** What a `PrTracker` reads and writes with; all controller-owned. */
export interface TrackDeps {
  readonly read: GitHubRead;
  readonly admission: RevisionAdmission;
  /** Controller-owned directory for prepared texts the contributor pastes. */
  readonly bodyDirectory: string;
  readonly now: () => string;
}

export const ACTION_KINDS = Object.freeze(['edit', 'withdraw', 'reopen'] as const);
/** A contributor action on the PR page: an edit, a withdrawal (comment and close), a reopen. */
export type ActionKind = (typeof ACTION_KINDS)[number];
export const WITHDRAWAL_REASONS = Object.freeze([
  'maintainer_request',
  'user_instruction',
] as const);
/** PRD §5.9: only an explicit maintainer request or user instruction admits a withdrawal. */
export type WithdrawalReason = (typeof WITHDRAWAL_REASONS)[number];

interface ActionBase {
  readonly input: IntentInput;
  readonly link: string;
}
interface PreparedText {
  /** Exactly what the contributor pastes; the body file holds these bytes. */
  readonly body: string;
  readonly bodyFile: string;
  readonly bodyDigest: string;
}
type PendingAction =
  | (ActionBase & PreparedText & { readonly kind: 'edit'; readonly title: string })
  | (ActionBase & PreparedText & { readonly kind: 'withdraw'; readonly reason: WithdrawalReason })
  | (ActionBase & { readonly kind: 'reopen' });

/** A prepared contributor action: the link, the text to submit, and what the run will read
 * back to confirm it. */
export interface ContributorAction {
  readonly kind: ActionKind;
  readonly link: string;
  /** Edit only: the exact title to set. */
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
  /** The review items this revision addresses; marked addressed when it is confirmed. */
  readonly feedback: readonly FeedbackRef[];
  /** Journaled before the push (write-ahead); fixed from then on. */
  readonly candidateSha?: string;
}
/** The tracker's durable state, rebuilt from its journal. */
export interface TrackState {
  readonly run: RunRecord;
  readonly contributionId: string;
  readonly pr: TrackedPr;
  /** The head the run last confirmed on the PR; a revision starts from it. */
  readonly verifiedSha: string;
  /** Feedback id → the `updatedAt` a confirmed revision addressed (AC5). */
  readonly addressed: ReadonlyMap<string, string>;
  readonly revision?: Revision;
  readonly action?: PendingAction;
  /** The head GitHub reported when the outcome was observed. */
  readonly outcomeSha?: string;
  readonly blockedReason?: TrackBlockReason;
}

/** What the last read in this process saw at a head the run can vouch for. Never journaled:
 * after a restart CI is `not_observed` until the next explicit read. */
interface Seen {
  readonly ci: CiState;
  readonly headSha: string;
  readonly branchSha: string | null;
  readonly actionable: number | null;
}

/** The run's tracking facts and what the contributor does next. */
export interface TrackStatus {
  readonly state: RunState;
  readonly pr: string;
  readonly headSha: string;
  /** As observed at `ciSha`; `not_observed` until a read in this process. */
  readonly ci: CiState | 'not_observed';
  readonly ciSha?: string;
  /** Unaddressed maintainer review items at the last read; null when not read. */
  readonly feedback: number | null;
  readonly action?: ContributorAction;
  readonly blockedReason?: TrackBlockReason;
  readonly nextPermittedAction: string;
}

/** Every call reports the status after it; pass `snapshot().run` to the other drivers
 * (`IntentDriver.observeRun`, `HandoffDriver.observeRun`) after each one. */
export type TrackOutcome =
  | { readonly kind: 'tracking'; readonly status: TrackStatus }
  | { readonly kind: 'merged' | 'declined'; readonly status: TrackStatus }
  | { readonly kind: 'blocked'; readonly reason: TrackBlockReason; readonly status: TrackStatus }
  /** GitHub could not be read: nothing was recorded; resume again later. */
  | { readonly kind: 'unknown'; readonly detail?: string; readonly status: TrackStatus }
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
  /** Journaled (and maybe pushed), but the PR head does not show the candidate yet. */
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
  | { v: 1; type: 'outcome'; outcome: 'merged' | 'declined'; headSha: string; run: RunRecord }
  | { v: 1; type: 'blocked'; reason: TrackBlockReason; run: RunRecord }
  | { v: 1; type: 'rebound'; number: number; url: string }
  | { v: 1; type: 'revision_started'; feedback: FeedbackRef[]; run: RunRecord }
  | { v: 1; type: 'revision_pushing'; candidateSha: string }
  | { v: 1; type: 'revision_confirmed'; headSha: string; run: RunRecord }
  | { v: 1; type: 'action_issued'; action: PendingAction }
  | { v: 1; type: 'action_observed' }
  | { v: 1; type: 'action_cancelled' };

function fail(detail?: string): never {
  throw new TrackError('invalid_journal', detail);
}

/** GitHub's web editor stores CRLF line endings and may drop trailing whitespace. */
function sameText(a: string | null, b: string): boolean {
  return (a ?? '').replace(/\r\n?/gu, '\n').trimEnd() === b.replace(/\r\n?/gu, '\n').trimEnd();
}

/** The same controller run or an exact forward continuation, advanced only by external
 * steps. */
function continuation(previous: RunRecord, value: unknown): RunRecord {
  const run = restoreRun(value);
  if (!isTrackerContinuation(previous, run)) throw new TrackError('run_diverged');
  return run;
}

/** The transition must be exactly `reason` applied to the current run. */
function stepped(state: TrackState, raw: Record<string, unknown>, reason: ReasonCode): RunRecord {
  const run = restoreRun(raw.run);
  if (!sameRunRecord(run, transitionRun(state.run, reason, run.updatedAt))) fail(String(raw.type));
  return run;
}

function prUrl(pr: Pick<TrackedPr, 'binding' | 'number'>): string {
  const { owner, repo } = pr.binding.upstream;
  return `https://github.com/${enc(owner)}/${enc(repo)}/pull/${pr.number}`;
}

function trackedPr(value: unknown): TrackedPr {
  if (!isRecord(value) || !isRecord(value.fork)) fail('pr');
  const binding = prBinding(value.binding);
  const fork = value.fork as unknown as ForkRef;
  try {
    forkTarget(fork, binding.branch); // Validates the fork reference.
  } catch {
    fail('fork');
  }
  if (
    !sameLogin(fork.owner, binding.headOwner) ||
    !Number.isSafeInteger(value.number) ||
    (value.number as number) < 1 ||
    typeof value.url !== 'string' ||
    value.url.toLowerCase() !== prUrl({ binding, number: value.number as number }).toLowerCase() ||
    typeof value.marker !== 'string' ||
    markerOperation(value.marker) !== 'pr_create'
  )
    fail('pr');
  return Object.freeze({
    binding,
    fork: Object.freeze({ repositoryId: fork.repositoryId, owner: fork.owner, repo: fork.repo }),
    number: value.number as number,
    url: value.url,
    marker: value.marker,
  });
}

function bodyFileName(input: IntentInput, kind: ActionKind): string {
  return `${handoffIntentId(input)}-${kind}.md`;
}

function preparedText(
  raw: Record<string, unknown>,
  input: IntentInput,
  kind: ActionKind,
  directory: string | null
): PreparedText {
  if (
    typeof raw.body !== 'string' ||
    raw.bodyDigest !== bodyDigest(raw.body) ||
    typeof raw.bodyFile !== 'string' ||
    !path.isAbsolute(raw.bodyFile) ||
    (directory !== null && path.dirname(raw.bodyFile) !== directory) ||
    path.basename(raw.bodyFile) !== bodyFileName(input, kind)
  )
    fail('action_text');
  assertNoSecrets(raw.body);
  return { body: raw.body, bodyFile: raw.bodyFile, bodyDigest: raw.bodyDigest };
}

/** A journaled action is exactly one the tracker could have issued at that point. */
function actionOf(state: TrackState, value: unknown, directory: string | null): PendingAction {
  if (!isRecord(value) || !isRecord(value.input)) fail('action');
  const raw = value;
  const kind = raw.kind as ActionKind;
  const input = raw.input as unknown as IntentInput;
  const op = kind === 'withdraw' ? 'pr_close' : 'pr_update';
  if (
    !ACTION_KINDS.includes(kind) ||
    input.operationKind !== op ||
    input.contributionId !== state.contributionId ||
    input.target !== state.pr.url ||
    input.candidateSha !== state.verifiedSha ||
    raw.link !== state.pr.url ||
    !isAdmitted(op, state.run.state)
  )
    fail('action');
  handoffIntentId(input); // Validates shape and secrets.
  const base = { input: Object.freeze({ ...input }), link: state.pr.url };
  if (kind === 'reopen') {
    if (['body', 'bodyFile', 'bodyDigest', 'title', 'reason'].some((k) => raw[k] !== undefined))
      fail('action');
    return Object.freeze({ kind, ...base });
  }
  const text = preparedText(raw, input, kind, directory);
  if (kind === 'edit') {
    if (
      typeof raw.title !== 'string' ||
      !raw.title ||
      raw.title.length > MAX_PR_TITLE_LENGTH ||
      raw.reason !== undefined ||
      !hasOnlyMarker(text.body, state.pr.marker)
    )
      fail('action');
    return Object.freeze({ kind, ...base, ...text, title: raw.title });
  }
  if (
    !WITHDRAWAL_REASONS.includes(raw.reason as WithdrawalReason) ||
    raw.title !== undefined ||
    !hasOnlyMarker(text.body, handoffMarker(input))
  )
    fail('action');
  return Object.freeze({ kind, ...base, ...text, reason: raw.reason as WithdrawalReason });
}

const TRACKING: readonly RunState[] = ['submitted', 'awaiting_review', 'accepted'];

function reduce(state: TrackState | undefined, raw: unknown, directory: string | null): TrackState {
  if (!isRecord(raw) || raw.v !== 1) fail('event');
  if (raw.type === 'track') {
    if (state || typeof raw.contributionId !== 'string' || !isCommitSha(raw.verifiedSha))
      fail('track');
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
      fail('track');
    return {
      run,
      contributionId: raw.contributionId,
      pr,
      verifiedSha: raw.verifiedSha,
      addressed: new Map(),
    };
  }
  if (!state) fail('no_track');
  // A block fences everything after it except lifecycle progress made elsewhere.
  if (state.blockedReason && raw.type !== 'run_update') fail('after_block');
  switch (raw.type) {
    case 'run_update':
      return { ...state, run: continuation(state.run, raw.run) };
    case 'review_awaited':
      if (state.run.state !== 'submitted') fail('review_awaited');
      return { ...state, run: stepped(state, raw, ReasonCode.ReviewAwaited) };
    case 'outcome': {
      if ((raw.outcome !== 'merged' && raw.outcome !== 'declined') || !isCommitSha(raw.headSha))
        fail('outcome');
      const reason =
        raw.outcome === 'merged' ? ReasonCode.ObservedUpstreamMerge : ReasonCode.UpstreamDeclined;
      // A withdrawal is satisfied by the close it asked for, or overtaken by a merge.
      return {
        ...state,
        run: stepped(state, raw, reason),
        action: undefined,
        outcomeSha: raw.headSha,
      };
    }
    case 'blocked':
      if (!TRACK_BLOCK_REASONS.includes(raw.reason as TrackBlockReason)) fail('blocked');
      return {
        ...state,
        run: stepped(state, raw, ReasonCode.PolicyBlocked),
        blockedReason: raw.reason as TrackBlockReason,
      };
    case 'rebound':
      if (raw.number === state.pr.number || state.action || state.revision) fail('rebound');
      return { ...state, pr: trackedPr({ ...state.pr, number: raw.number, url: raw.url }) };
    case 'revision_started': {
      if (state.revision || state.action || !Array.isArray(raw.feedback) || !raw.feedback.length)
        fail('revision_started');
      const feedback = raw.feedback.map((f) => {
        if (!isRecord(f) || typeof f.id !== 'string' || typeof f.updatedAt !== 'string')
          fail('revision_started');
        return Object.freeze({ id: f.id, updatedAt: f.updatedAt });
      });
      return {
        ...state,
        run: stepped(state, raw, ReasonCode.RevisionRequested),
        revision: Object.freeze({ feedback }),
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
        fail('revision_pushing');
      return {
        ...state,
        revision: Object.freeze({ ...state.revision, candidateSha: raw.candidateSha }),
      };
    case 'revision_confirmed': {
      // An edit still pending is independent of the push: it stays pending.
      const revision = state.revision;
      if (!revision?.candidateSha || raw.headSha !== revision.candidateSha)
        fail('revision_confirmed');
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
      if (state.action) fail('action_issued');
      return { ...state, action: actionOf(state, raw.action, directory) };
    case 'action_observed':
    case 'action_cancelled':
      if (!state.action) fail(raw.type);
      return { ...state, action: undefined };
    default:
      return fail(String(raw.type));
  }
}

/** Rebuilds a `PrTracker` journal; throws `TrackError('invalid_journal')` on any event the
 * tracker would not have produced at that point. */
export function replayTrack(events: readonly unknown[], bodyDirectory?: string): TrackState {
  const directory = bodyDirectory === undefined ? null : path.resolve(bodyDirectory);
  let state: TrackState | undefined;
  for (const event of events) if (!isRecoveryEvent(event)) state = reduce(state, event, directory);
  if (!state) fail('empty');
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
      return `No upstream check has run${at}; nothing is green.`;
    case 'unknown':
      return `Upstream checks${at} could not be read; nothing is claimed about them.`;
    case 'not_observed':
      return 'Upstream checks have not been read since the run was loaded; resume to read them.';
    default:
      return ci satisfies never;
  }
}

/** Hidden text cannot ride into the PR description: HTML comments (other than the marker)
 * and invisible or control characters are refused, not silently rewritten. */
function assertVisibleBody(body: string, marker: string): void {
  const rest = body.replace(marker, '');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Refuse control characters in prepared PR text.
  if (/<!--|--!?>|\p{Cf}|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/u.test(rest))
    throw new HandoffError('hidden_content');
}

const drivenJournals = new WeakSet<Journal>();
/** One read: the PR as observed, or an ambiguous re-detection a person must settle. */
type Read = PrTrack | { kind: 'handoff'; reason: AmbiguityReason };

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
      if (this.state.contributionId !== initial.contributionId)
        throw new TrackError('run_diverged', 'contribution');
      // Another driver's copy of the run may trail this journal's; only a newer one is news.
      const run = restoreRun(initial.run);
      if (!isRunContinuation(run, this.state.run)) this.observeRun(run);
    }
    drivenJournals.add(journal);
  }

  /** The durable state, as replaying the journal yields it. */
  snapshot(): TrackState {
    return { ...this.state, addressed: new Map(this.state.addressed) };
  }

  /** Record lifecycle progress made elsewhere (isolated revision and verification, pause,
   * failures). PR outcomes, review and revision steps are refused: only reads record them. */
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

  /** Current tracking facts; reads nothing. CI is `not_observed` until a read in this
   * process. */
  status(): TrackStatus {
    const s = this.state;
    const seen = this.seen;
    const ci: TrackStatus['ci'] = seen?.ci ?? 'not_observed';
    return Object.freeze({
      state: s.run.state,
      pr: s.pr.url,
      headSha: s.verifiedSha,
      ci,
      ...(seen ? { ciSha: seen.headSha } : {}),
      feedback: seen?.actionable ?? null,
      ...(s.action ? { action: this.describe(s.action) } : {}),
      ...(s.blockedReason ? { blockedReason: s.blockedReason } : {}),
      nextPermittedAction: this.next(seen),
    });
  }

  private next(seen: Seen | undefined): string {
    const s = this.state;
    const checks = ciText(seen?.ci ?? 'not_observed', seen?.headSha);
    if (s.blockedReason === 'merged_during_revision')
      return `Merged upstream at ${s.pr.url} while a revision was in progress; nothing more is pushed and the run is finished.`;
    if (s.blockedReason)
      return `Blocked (${s.blockedReason}); nothing further runs. Inspect ${s.pr.url} and start a new run if the contribution should continue.`;
    if (s.action) return this.describe(s.action).instructions;
    switch (s.run.state) {
      case 'merged':
        return s.outcomeSha === s.verifiedSha
          ? `Merged upstream at ${s.pr.url}; nothing further.`
          : `Merged upstream at ${s.pr.url} with head ${s.outcomeSha}, which is not the verified ${s.verifiedSha}; nothing further.`;
      case 'declined':
        return `Closed without merge at ${s.pr.url}. Reopening it is your action on GitHub; a new run would track it. Nothing is deleted and no follow-up is sent.`;
      case 'submitted':
        return `Submitted at ${s.pr.url}. ${checks} Resume to read the pull request and its checks.`;
      case 'awaiting_review':
      case 'accepted': {
        const n = seen?.actionable;
        const feedback = n
          ? `${n} maintainer review item(s) are not addressed at ${s.verifiedSha}; resume with a revision to address them.`
          : 'Waiting for maintainer review; no compute runs until you resume.';
        return `${feedback} ${checks}`;
      }
      case 'revising':
      case 'verifying':
        return 'Revision in progress: the candidate is produced and verified in isolation before anything is pushed.';
      case 'shipping': {
        const candidate = s.revision?.candidateSha;
        if (!candidate) return 'Ship the verified revision to the same fork branch.';
        return seen?.branchSha === candidate
          ? `Revision ${candidate} is on the fork branch; resume to confirm the pull request head shows it.`
          : `Revision ${candidate} is not on the fork branch yet; ship it again with the same candidate (the CAS push is safe to repeat).`;
      }
      case 'paused_user':
        return 'Paused by the user; resume the paused phase to continue.';
      case 'awaiting_contributor':
        return 'Waiting for a contributor prerequisite (fork or App installation); resume re-checks it.';
      default:
        return `Run is ${s.run.state}; the pull request is not tracked in this state.`;
    }
  }

  private describe(action: PendingAction): ContributorAction {
    const author = this.state.run.contributor;
    const paste = 'bodyFile' in action ? ` The prepared text is in ${action.bodyFile}.` : '';
    const instructions = {
      edit: `Open the pull request at the link, choose Edit, set the title to the prepared title, and replace the description with the prepared text, from your own account (${author}).${paste} Keep the hidden ai-dossier marker line. Then resume; the run records the edit only after it reads it back.`,
      withdraw: `Open the pull request at the link, post the prepared comment from your own account (${author}), then close the pull request.${paste} Keep the hidden ai-dossier marker line. Nothing is deleted. Then resume; the run records the contribution declined only after it observes the pull request closed, and sends no follow-up.`,
      reopen: `The pull request was closed while a revision was in progress. To continue, reopen it at the link from your own account (${author}) and resume; otherwise cancel the run. Nothing is pushed while it is closed.`,
    }[action.kind];
    return Object.freeze({
      kind: action.kind,
      link: action.link,
      ...(action.kind === 'edit' ? { title: action.title } : {}),
      ...('bodyFile' in action ? { bodyFile: action.bodyFile, bodyDigest: action.bodyDigest } : {}),
      author,
      instructions,
    });
  }

  private block(reason: TrackBlockReason): TrackOutcome {
    const state = this.state.run.state;
    if (!this.state.blockedReason && permittedTransitions(state)[ReasonCode.PolicyBlocked])
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
    if (TERMINAL_STATES.includes(s.run.state)) throw new TrackError('run_closed', s.run.state);
    return null;
  }

  /** Heads the run may see: the last verified one, or its own revision once journaled. */
  private unexpectedHead(track: Observed, candidate = this.state.revision?.candidateSha): boolean {
    const allowed = [this.state.verifiedSha, candidate];
    return (
      !allowed.includes(track.headSha) ||
      (track.branchSha !== null && !allowed.includes(track.branchSha))
    );
  }

  /** One read of the tracked PR, following a replacement PR when the tracked one is closed
   * (AC6). Records only a rebind; every other decision is the caller's. */
  private async observe(): Promise<Read> {
    let track = await observePr(this.deps.read, this.state.pr);
    const closed = track.kind === 'observed' && track.state === 'closed' && !track.merged;
    // A pending withdrawal asked for exactly this close, and a revision follows its own PR.
    if (closed && this.state.action?.kind !== 'withdraw' && !this.state.revision) {
      const moved = await relocatePr(this.deps.read, this.state.pr, this.state.run.contributor);
      if (moved.kind === 'unknown') return { kind: 'unknown', detail: 'relocate' };
      if (moved.kind === 'ambiguous') return { kind: 'handoff', reason: moved.reason };
      if (moved.kind === 'found') {
        this.persist({ v: 1, type: 'rebound', number: moved.number, url: moved.url });
        track = await observePr(this.deps.read, this.state.pr);
      }
    }
    // CI and feedback are reported only for a head the run can vouch for.
    if (track.kind === 'observed' && track.ci)
      this.seen = this.unexpectedHead(track)
        ? undefined
        : {
            ci: track.ci,
            headSha: track.headSha,
            branchSha: track.branchSha,
            actionable: track.feedback
              ? actionableFeedback(this.state, track.feedback).length
              : null,
          };
    return track;
  }

  /** What every read settles first: unreadable, ambiguous, gone, and the pending action. */
  private settle(read: Read): TrackOutcome | Observed {
    if (read.kind === 'unknown')
      return {
        kind: 'unknown',
        ...(read.detail ? { detail: read.detail } : {}),
        status: this.status(),
      };
    if (read.kind === 'handoff') return { ...read, status: this.status() };
    if (read.kind === 'gone') return this.block(read.reason);
    this.confirmAction(read);
    return read;
  }

  /** The pending contributor action, confirmed only by what the read shows. */
  private confirmAction(track: Observed): void {
    const action = this.state.action;
    if (!action) return;
    const done =
      action.kind === 'edit'
        ? track.title.trim() === action.title && sameText(track.body, action.body)
        : action.kind === 'reopen'
          ? track.state === 'open'
          : false; // A withdrawal is confirmed by the `declined` outcome itself.
    if (done) this.persist({ v: 1, type: 'action_observed' });
  }

  /** Explicit resume: the only time the run reads the PR (PRD §5.3; no background polling). */
  resume(): Promise<TrackOutcome> {
    return this.serial(async () => this.settled() ?? this.apply(await this.observe()));
  }

  /** AC1 on one read: only what was read moves the run. */
  private apply(read: Read): TrackOutcome {
    const track = this.settle(read);
    if (track.kind !== 'observed') return track;
    const revision = this.state.revision;
    if (revision) return this.duringRevision(track, revision);
    const state = this.state.run.state;
    if (!TRACKING.includes(state)) return { kind: 'tracking', status: this.status() };
    const outcome = upstreamOutcome(track);
    if (outcome === 'merged' || outcome === 'declined') {
      const reason =
        outcome === 'merged' ? ReasonCode.ObservedUpstreamMerge : ReasonCode.UpstreamDeclined;
      const run = this.transition(reason);
      this.persist({ v: 1, type: 'outcome', outcome, headSha: track.headSha, run });
      return { kind: outcome, status: this.status() };
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

  /** A read while a revision is in progress: a merge ends it, a close pauses it behind a
   * reopen hand-off, a moved head blocks, and in `shipping` the PR head confirms it. */
  private duringRevision(track: Observed, revision: Revision): TrackOutcome {
    if (track.merged) return this.block('merged_during_revision');
    if (track.state === 'closed') return this.closedDuringRevision();
    if (this.unexpectedHead(track)) return this.block('unexpected_head_sha');
    if (this.state.run.state !== 'shipping' || !revision.candidateSha)
      return { kind: 'tracking', status: this.status() };
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

  private closedDuringRevision(): TrackOutcome {
    if (!this.state.action && isAdmitted('pr_update', this.state.run.state))
      this.persist({
        v: 1,
        type: 'action_issued',
        action: { kind: 'reopen', input: this.input('pr_update'), link: this.state.pr.url },
      });
    const action = this.state.action;
    return action
      ? { kind: 'action', action: this.describe(action), status: this.status() }
      : { kind: 'tracking', status: this.status() };
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
      } catch (cause) {
        throw new TrackError('freshness_unavailable', reason, { cause });
      }
      if (!ok) return reason;
    }
    return null;
  }

  /** Explicit resume into a revision (AC2): read the PR, recheck freshness, and start one
   * only for maintainer review items not already addressed at the current head (AC5). The
   * returned feedback is untrusted input for the isolated revision. */
  beginRevision(): Promise<TrackOutcome> {
    return this.serial(async () => {
      const settled = this.settled();
      if (settled) return settled;
      if (this.state.action) throw new TrackError('action_pending', this.state.action.kind);
      const read = await this.observe();
      const outcome = this.apply(read);
      if (outcome.kind !== 'tracking' || !TRACKING.includes(this.state.run.state)) return outcome;
      if (read.kind !== 'observed' || !read.feedback)
        return { kind: 'unknown', detail: 'feedback', status: this.status() };
      const feedback = actionableFeedback(this.state, read.feedback);
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
   * receipt), then the PR head must show the candidate. Unexpected commits block. Safe to
   * repeat with the same candidate after a crash or a lost response. */
  shipRevision(request: {
    candidateSha: string;
    push: (intent: IntentInput) => Promise<string>;
  }): Promise<TrackOutcome> {
    return this.serial(async () => {
      const settled = this.settled();
      if (settled) return settled;
      const { candidateSha } = request;
      const revision = this.state.revision;
      if (this.state.run.state !== 'shipping' || !revision)
        throw new TrackError('admission_state', this.state.run.state);
      if (!isCommitSha(candidateSha) || candidateSha === this.state.verifiedSha)
        throw new TrackError('invalid_candidate');
      if (revision.candidateSha && revision.candidateSha !== candidateSha)
        throw new TrackError('candidate_changed');
      const stale = await this.fresh();
      if (stale) return this.block(stale);
      const track = this.settle(await this.observe());
      if (track.kind !== 'observed') return track;
      if (track.merged) return this.block('merged_during_revision');
      if (track.state === 'closed') return this.closedDuringRevision();
      // Only the last verified SHA, or this candidate after a lost push response (scenario 18).
      if (this.unexpectedHead(track, candidateSha)) return this.block('unexpected_head_sha');
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
      if (after.kind === 'unknown' || after.kind === 'handoff')
        return { kind: 'revision_pending', candidateSha, status: this.status() };
      return this.apply(after);
    });
  }

  private input(operationKind: 'pr_update' | 'pr_close'): IntentInput {
    return {
      contributionId: this.state.contributionId,
      target: this.state.pr.url,
      operationKind,
      candidateSha: this.state.verifiedSha,
    };
  }

  /** Writes the prepared text before the journal makes the action visible (write-ahead). */
  private prepare(input: IntentInput, kind: ActionKind, body: string): PreparedText {
    const bodyFile = writePrivateFile(
      path.resolve(this.deps.bodyDirectory),
      bodyFileName(input, kind),
      Buffer.from(body, 'utf8')
    );
    return { body, bodyFile, bodyDigest: bodyDigest(body) };
  }

  private pendingAction(action: PendingAction): TrackOutcome {
    return { kind: 'action', action: this.describe(action), status: this.status() };
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
        throw new TrackError('admission_state', this.state.run.state);
      if (this.state.action) return this.pendingAction(this.state.action);
      const title = prTitle(request.title);
      const body = request.body;
      if (typeof body !== 'string' || body.length > MAX_BODY_LENGTH)
        throw new HandoffError('invalid_body');
      // The PR stays findable by its marker (AC6) only if the edit keeps it.
      if (!hasOnlyMarker(body, this.state.pr.marker)) throw new HandoffError('marker_required');
      assertVisibleBody(body, this.state.pr.marker);
      assertNoSecrets(body);
      assertContentPolicy(`${title}\n${body}`, request.evidence);
      const input = this.input('pr_update');
      const action: PendingAction = {
        kind: 'edit',
        input,
        link: this.state.pr.url,
        title,
        ...this.prepare(input, 'edit', body),
      };
      this.persist({ v: 1, type: 'action_issued', action });
      return this.pendingAction(action);
    });
  }

  /** AC4: withdrawal on a maintainer request or the user's instruction. The contributor
   * posts the prepared comment and closes the PR; `declined` is recorded only when a later
   * resume observes it closed. Nothing is deleted and nothing follows up. Not during a
   * revision: finish or cancel it first. */
  requestWithdrawal(request: {
    reason: WithdrawalReason;
    explanation: string;
  }): Promise<TrackOutcome> {
    return this.serial(async () => {
      const settled = this.settled();
      if (settled) return settled;
      const state = this.state.run.state;
      if (!WITHDRAWAL_REASONS.includes(request.reason))
        throw new TrackError('admission_state', 'withdrawal_reason');
      if (
        !isAdmitted('pr_close', state) ||
        !permittedTransitions(state)[ReasonCode.UpstreamDeclined]
      )
        throw new TrackError('admission_state', `withdraw_in_${state}`);
      if (this.state.action) return this.pendingAction(this.state.action);
      const input = this.input('pr_close');
      const explanation = untrustedText(request.explanation, MAX_WITHDRAWAL_EXPLANATION);
      const body = `${explanation}\n\n${handoffMarker(input)}`;
      assertContentPolicy(body);
      const action: PendingAction = {
        kind: 'withdraw',
        input,
        link: this.state.pr.url,
        reason: request.reason,
        ...this.prepare(input, 'withdraw', body),
      };
      this.persist({ v: 1, type: 'action_issued', action });
      return this.pendingAction(action);
    });
  }

  /** Drop a pending action the contributor will not perform (a stale edit, a withdrawal
   * the user no longer wants, a reopen they decline). Nothing upstream changes. */
  cancelAction(): Promise<TrackOutcome> {
    return this.serial(async () => {
      const settled = this.settled();
      if (settled) return settled;
      if (!this.state.action) throw new TrackError('no_action');
      this.persist({ v: 1, type: 'action_cancelled' });
      return { kind: 'tracking', status: this.status() };
    });
  }
}
