/** Contributor hand-off links (PRD §5.7, owner decision A). Owner, repository, base and
 * head come only from the controller binding; every prefilled field is untrusted text
 * that is URL-encoded and bounded and cannot move the target. */
import { createHash } from 'node:crypto';
import { type IntentInput, idempotencyKey } from '../intents';
import type { CommandEvidence } from '../receipt/schema';
import { assertNoSecrets } from '../redaction';
import { assertContentPolicy, HandoffError, untrustedText } from './text';

export { HandoffError } from './text';

/** Conservative prefill ceiling; GitHub and browsers reject longer URLs inconsistently. */
export const MAX_PREFILL_URL_LENGTH = 8000;
export const MAX_PR_TITLE_LENGTH = 256;
/** GitHub's maximum issue/PR/comment body length. */
export const MAX_BODY_LENGTH = 65536;
export const HANDOFF_OPERATIONS = Object.freeze(['engagement_comment', 'pr_create'] as const);
export type HandoffOperation = (typeof HANDOFF_OPERATIONS)[number];

export interface RepoBinding {
  readonly owner: string;
  readonly repo: string;
}
export interface PrBinding {
  readonly upstream: RepoBinding;
  readonly base: string;
  /** The contributor's fork owner; the fork repository itself is checked at admission. */
  readonly headOwner: string;
  readonly branch: string;
}
export interface IssueBinding {
  readonly upstream: RepoBinding;
  readonly issue: number;
}

const OWNER = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/u;
const REPO = /^[A-Za-z0-9._-]{1,100}$/u;

export function isGitHubLogin(value: unknown): value is string {
  return typeof value === 'string' && OWNER.test(value);
}

/** A strict subset of git ref names, so a ref can never carry URL syntax. */
export function isSafeRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9._/-]{1,255}$/u.test(value) &&
    !/^[-./]|[/.]$|\.\.|\/\/|\/\.|\.lock$/u.test(value)
  );
}

function repoBinding(value: unknown): RepoBinding {
  const v = value as RepoBinding;
  if (
    typeof v !== 'object' ||
    v === null ||
    !isGitHubLogin(v.owner) ||
    typeof v.repo !== 'string' ||
    !REPO.test(v.repo) ||
    v.repo === '.' ||
    v.repo === '..'
  )
    throw new HandoffError('invalid_binding');
  return Object.freeze({ owner: v.owner, repo: v.repo });
}

export function prBinding(value: unknown): PrBinding {
  const v = value as PrBinding;
  if (typeof v !== 'object' || v === null) throw new HandoffError('invalid_binding');
  const upstream = repoBinding(v.upstream);
  if (!isSafeRef(v.base) || !isSafeRef(v.branch) || !isGitHubLogin(v.headOwner))
    throw new HandoffError('invalid_binding');
  return Object.freeze({ upstream, base: v.base, headOwner: v.headOwner, branch: v.branch });
}

export function issueBinding(value: unknown): IssueBinding {
  const v = value as IssueBinding;
  if (typeof v !== 'object' || v === null) throw new HandoffError('invalid_binding');
  const upstream = repoBinding(v.upstream);
  if (!Number.isSafeInteger(v.issue) || v.issue < 1) throw new HandoffError('invalid_binding');
  return Object.freeze({ upstream, issue: v.issue });
}

function handoffInput(input: IntentInput): IntentInput & { operationKind: HandoffOperation } {
  idempotencyKey(input); // Validates shape and secrets.
  if (!(HANDOFF_OPERATIONS as readonly string[]).includes(input.operationKind))
    throw new HandoffError('not_a_handoff');
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(input.contributionId))
    throw new HandoffError('invalid_contribution');
  return input as IntentInput & { operationKind: HandoffOperation };
}

/** Stable, secret-free intent id derived from the idempotency key. */
export function handoffIntentId(input: IntentInput): string {
  return createHash('sha256')
    .update(idempotencyKey(handoffInput(input)))
    .digest('hex')
    .slice(0, 32);
}

/** Hidden run marker: contribution id + intent id + operation, nothing else. */
export function handoffMarker(input: IntentInput): string {
  const valid = handoffInput(input);
  return `<!-- ai-dossier:ztfc contribution=${valid.contributionId} intent=${handoffIntentId(valid)} op=${valid.operationKind} -->`;
}

const MARKER =
  /<!-- ai-dossier:ztfc contribution=([A-Za-z0-9_-]{1,128}) intent=([a-f0-9]{32}) op=(engagement_comment|pr_create) -->/gu;

/** Every marker in a body; a reconciler accepts only exactly one, equal to its own. */
export function findHandoffMarkers(text: string): string[] {
  return [...text.matchAll(MARKER)].map((match) => match[0]);
}

export function hasOnlyMarker(text: unknown, marker: string): boolean {
  if (typeof text !== 'string') return false;
  const found = findHandoffMarkers(text);
  return found.length === 1 && found[0] === marker;
}

export function prTitle(value: unknown): string {
  return untrustedText(value, MAX_PR_TITLE_LENGTH, false);
}

export interface PreparedLink {
  /** `prefilled`: the link carries the body. `body_file`: paste the body from the file. */
  readonly kind: 'prefilled' | 'body_file';
  readonly url: string;
  readonly title?: string;
  readonly body: string;
}

function checkedBody(body: unknown, marker: string): string {
  if (typeof body !== 'string' || body.length > MAX_BODY_LENGTH)
    throw new HandoffError('invalid_body');
  if (!hasOnlyMarker(body, marker)) throw new HandoffError('marker_required');
  assertNoSecrets(body);
  return body;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}
function ref(value: string): string {
  return value.split('/').map(segment).join('/');
}

/** Prefilled compare URL; falls back to a short title-only URL plus a body file. */
export function compareLink(
  intent: IntentInput,
  binding: PrBinding,
  title: string,
  body: string,
  /** Receipt commands backing the body (`PrContent.commands`). */
  evidence?: readonly CommandEvidence[]
): PreparedLink {
  const valid = handoffInput(intent);
  if (valid.operationKind !== 'pr_create') throw new HandoffError('not_a_handoff');
  const b = prBinding(binding);
  const safeTitle = prTitle(title);
  const safeBody = checkedBody(body, handoffMarker(valid));
  // No advertising; a blanket success claim needs the receipt's passing evidence.
  assertContentPolicy(`${safeTitle}\n${safeBody}`, evidence);
  return Object.freeze({ ...formatCompareLink(b, safeTitle, safeBody), title: safeTitle });
}

/** Pure URL formatting (no policy checks); replay uses it to re-derive an issued link. */
export function formatCompareLink(
  binding: PrBinding,
  title: string,
  body: string
): { kind: PreparedLink['kind']; url: string; body: string } {
  const b = prBinding(binding);
  const base =
    `https://github.com/${segment(b.upstream.owner)}/${segment(b.upstream.repo)}` +
    `/compare/${ref(b.base)}...${segment(b.headOwner)}:${ref(b.branch)}` +
    `?expand=1&title=${encodeURIComponent(title)}`;
  const full = `${base}&body=${encodeURIComponent(body)}`;
  return full.length <= MAX_PREFILL_URL_LENGTH
    ? { kind: 'prefilled', url: full, body }
    : { kind: 'body_file', url: base, body };
}

export function issueUrl(binding: IssueBinding): string {
  const b = issueBinding(binding);
  return `https://github.com/${segment(b.upstream.owner)}/${segment(b.upstream.repo)}/issues/${b.issue}`;
}

/** GitHub has no prefill parameter for issue comments: the link opens the issue and the
 * contributor pastes the prepared body (same reconciliation by marker). */
export function issueCommentLink(
  intent: IntentInput,
  binding: IssueBinding,
  body: string
): PreparedLink {
  const valid = handoffInput(intent);
  if (valid.operationKind !== 'engagement_comment') throw new HandoffError('not_a_handoff');
  const b = issueBinding(binding);
  const safeBody = checkedBody(body, handoffMarker(valid));
  assertContentPolicy(safeBody);
  return Object.freeze({
    kind: 'body_file',
    url: issueUrl(b),
    body: safeBody,
  });
}

export interface EngagementInput {
  /** Model-proposed approach; untrusted. */
  readonly approach: string;
  /** Existing checks the contributor intends to run; untrusted. */
  readonly verification: string;
}

/** PRD §5.3 disclosed request: heavy LLM use, proposed scope, intended verification. */
export function engagementBody(intent: IntentInput, input: EngagementInput): string {
  const approach = untrustedText(input.approach, 1000, false);
  const verification = untrustedText(input.verification, 500, false);
  const body = [
    "I'd like to work on this issue using substantial LLM assistance through ai-dossier " +
      '(https://github.com/imboard-ai/ai-dossier).',
    `My proposed approach: ${approach}`,
    `I would validate it with ${verification}, and a focused regression test where appropriate.`,
    'Would you welcome this contribution, and should I be assigned before proceeding?',
    '',
    handoffMarker(intent),
  ].join('\n');
  assertContentPolicy(body);
  return body;
}
