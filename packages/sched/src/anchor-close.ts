/**
 * Batch anchor closure off the happy path (#768).
 *
 * A batch anchor used to close only when `batch-integrate` merged the batch PR
 * and ran its post-merge step (#720). A batch that blocked, was recovered by
 * hand, or whose members shipped through other PRs left its anchor open
 * forever (imboard#4244, imboard#4253).
 *
 * The rule here is deliberately NARROW (operator decision on #768): an anchor
 * closes only on POSITIVE evidence — every member issue CLOSED with
 * `stateReason=COMPLETED` BY SHIPPED CODE (a PR merged into the batch's base,
 * or a commit reachable from it), and no member evicted, handed back,
 * requeued out of the batch, or carrying an unresolved failure. A close by a
 * person, with no linked PR or commit, is not evidence: an issue's author can
 * close their own issue without write access. Every other shape leaves the
 * anchor alone and is surfaced by `sched status --anchors` as
 * `needs-operator`: an anchor with a failure trail must stay open, because
 * closing it would bury the trail. "Close on every terminal transition" was
 * considered and rejected for exactly that reason.
 *
 * Pure verdicts plus one idempotent effect (`closeAnchor`); everything that
 * talks to GitHub or git is injected, so tests never shell out.
 */

import type { IssueCloseTruth } from './groundtruth';
import { DECISION_PENDING_LABEL, hasLabel } from './labels';
import type { ExecFn } from './project';
import { distinctEvictions, findEntry, ISSUE_UNIVERSAL_FAILURE_EDGES } from './state';
import type { BatchEntry, BatchStatus, IssueStatus, SchedState } from './types';

/** Reads one issue's closure record; `undefined` = the poll failed (unreachable). */
export type IssueCloseReader = (issue: number) => IssueCloseTruth | undefined;

/**
 * Whether commit `oid` is reachable from the batch's base branch on origin —
 * `true` only when verified; `false` for "not reachable" and for "could not
 * tell" alike, so an unverifiable commit never counts as shipped.
 */
export type CommitInBase = (oid: string, baseBranch: string) => boolean;

/**
 * Member ledger statuses that ARE a failure trail: the universal failure
 * edges (derived, so a failure status added there is refused here too) plus
 * the eviction rail. A member sitting in one of these was evicted, requeued,
 * handed to a human, failed, or stopped — its anchor must stay open for an
 * operator even if GitHub shows it closed.
 */
const MEMBER_FAILURE_STATUSES: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  ...ISSUE_UNIVERSAL_FAILURE_EDGES,
  'evicted',
  'requeued',
]);

/**
 * Batch statuses whose anchors the ENGINE may close: the batch is no longer in
 * flight and its members were not requeued or stopped wholesale.
 */
export const ANCHOR_CLOSE_BATCH_STATUSES: ReadonlySet<BatchStatus> = new Set(['blocked', 'done']);

/** Batch statuses whose members were requeued or stopped wholesale — never auto-closable. */
const FAILED_BATCH_STATUSES: ReadonlySet<BatchStatus> = new Set([
  'dissolving',
  'dissolved',
  'stopped',
]);

/**
 * Batch statuses whose anchors the sweep inspects: every batch no longer in
 * flight — the engine's set plus the requeued/stopped ones it never closes.
 */
const SWEEP_BATCH_STATUSES: ReadonlySet<BatchStatus> = new Set([
  ...ANCHOR_CLOSE_BATCH_STATUSES,
  ...FAILED_BATCH_STATUSES,
]);

/**
 * The batches in `statuses` whose anchor is set and not yet recorded closed —
 * the one candidate filter the engine's close pass and the sweep share.
 */
export function openAnchorBatches(
  state: SchedState,
  statuses: ReadonlySet<BatchStatus>
): Array<BatchEntry & { anchor: number }> {
  return state.batches.filter(
    (b): b is BatchEntry & { anchor: number } =>
      b.anchor !== null && b.anchor_closed_at === null && statuses.has(b.status)
  );
}

/** `blocked (<reason>)` for a blocked batch with a reason, else the bare status. */
export function formatBatchStatus(batch: Pick<BatchEntry, 'status' | 'blocked_reason'>): string {
  return batch.status === 'blocked' && batch.blocked_reason
    ? `blocked (${batch.blocked_reason})`
    : batch.status;
}

/**
 * Why the LEDGER alone rules out closing `batch`'s anchor — empty when the
 * ledger shows no failure trail. Costs no GitHub call, so callers check it
 * before reading any issue state.
 */
export function anchorLedgerBlockers(state: SchedState, batch: BatchEntry): string[] {
  const reasons: string[] = [];
  if (FAILED_BATCH_STATUSES.has(batch.status)) reasons.push(`batch-${batch.status}`);
  if (batch.members.length === 0) reasons.push('no-members');
  for (const e of distinctEvictions(batch.evictions)) {
    reasons.push(`member-evicted:#${e.issue}`);
  }
  for (const issue of batch.members) {
    const entry = findEntry(state, issue);
    if (!entry) {
      reasons.push(`member-not-in-ledger:#${issue}`);
      continue;
    }
    if (MEMBER_FAILURE_STATUSES.has(entry.status)) {
      reasons.push(`member-${entry.status}:#${issue}`);
    } else if (entry.mode !== 'slot' || entry.batch !== batch.id) {
      // Requeued out of this batch (dissolve / abandon → full-cycle): its
      // outcome is no longer this batch's to vouch for.
      reasons.push(`member-requeued:#${issue}`);
    }
  }
  return [...new Set(reasons)];
}

/** One member's state as the sweep and the close comment show it. */
export interface AnchorMemberReport {
  issue: number;
  /** The member's ledger status, or null when the ledger no longer carries it. */
  ledger_status: IssueStatus | null;
  /** GitHub state, or `unknown` when the poll failed / was not made. */
  github: 'OPEN' | 'CLOSED' | 'MISSING' | 'unknown';
  state_reason: string | null;
  /** The verified shipping evidence for a member that shipped; null otherwise. */
  shipped_by: string | null;
}

/**
 * The anchor-close predicate's answer. Every open-anchor verdict carries
 * `reasons` (empty for `closable`; for `unknown`, which read failed — ground
 * truth unreachable, so nothing is decided this pass).
 */
export type AnchorVerdict =
  | { kind: 'anchor-closed' }
  | {
      kind: 'closable' | 'needs-operator' | 'unknown';
      reasons: string[];
      members: AnchorMemberReport[];
    };

/** The verdict of an anchor that is still open. */
export type OpenAnchorVerdict = Exclude<AnchorVerdict, { kind: 'anchor-closed' }>;

/**
 * The verified shipping evidence for a member closed as completed, or the
 * reason it is not evidence. Only code that landed in `baseBranch` counts:
 * a PR of `repo` (the pinned project repository) MERGED into it — as the
 * close event's closer, or, for a hand close, as a closing reference — or a
 * commit reachable from it. A hand close (no linked
 * closer), an unmerged or other-base PR, and an unverifiable commit are all
 * refusals — anyone who can close the issue could otherwise mint "shipped".
 */
export function shippingEvidence(
  truth: IssueCloseTruth,
  baseBranch: string,
  repo: string | undefined,
  commitInBase: CommitInBase | undefined
): { shipped: string } | { refused: string } {
  const closer = truth.closer;
  if (closer === null) {
    // Closed by hand. Still shipped when a PR of the pinned repo, MERGED into
    // the base, names it as closed (`Closes #N` — GitHub parsed it, then did
    // not act: the imboard#4116 shape). A merge needs write access, so an
    // author's self-close alone still never counts.
    const ref = truth.closingPrs.find(
      (pr) =>
        pr.merged &&
        pr.baseRefName === baseBranch &&
        repo !== undefined &&
        pr.repo?.toLowerCase() === repo.toLowerCase()
    );
    return ref !== undefined
      ? { shipped: `PR #${ref.number} (closing reference; issue closed by hand)` }
      : { refused: 'closed-by-hand' };
  }
  if (closer.kind === 'pr') {
    // A PR in ANOTHER repository can close this issue (`Fixes owner/repo#N`)
    // and merge into a same-named base — that is not code in this project.
    if (repo === undefined || closer.repo?.toLowerCase() !== repo.toLowerCase()) {
      return { refused: `closer-pr-${closer.number}-other-repo` };
    }
    if (!closer.merged) return { refused: `closer-pr-unmerged-${closer.number}` };
    if (closer.baseRefName !== baseBranch) {
      return { refused: `closer-pr-${closer.number}-not-into-${baseBranch}` };
    }
    return { shipped: `PR #${closer.number}` };
  }
  if (commitInBase?.(closer.oid, baseBranch) !== true) {
    return { refused: `closer-commit-${closer.oid.slice(0, 12)}-not-in-${baseBranch}` };
  }
  return { shipped: `commit ${closer.oid.slice(0, 12)}` };
}

export interface MembersVerdictOptions {
  /** Read every member even after a disqualifier (the sweep); the engine stops early. */
  exhaustive?: boolean;
  /** Reasons already known before any member is read (e.g. a handed-back anchor). */
  extraReasons?: string[];
  /** Verifies commit closers; without it a commit closer is never evidence. */
  commitInBase?: CommitInBase;
  /** The pinned `owner/name`; without it a PR closer is never evidence. */
  repo?: string;
}

/**
 * The member half of the predicate: every member CLOSED as `COMPLETED` by
 * shipped code ({@link shippingEvidence}), none handed back, and the ledger
 * clean. Shared by the anchor close and by `reconcileStaleBlockedBatches`'
 * members-closed evidence, so the two can never disagree about what
 * "shipped" means.
 *
 * `exhaustive: false` (the engine) stops at the first disqualifying fact and
 * skips GitHub entirely when the ledger already disqualifies — a batch that
 * stays blocked is re-checked every tick, so the cheap answer matters there.
 * `exhaustive: true` (the `sched status --anchors` sweep) reads every member
 * so the operator sees each one's state. Either way a failed read stops the
 * reads: GitHub being unreachable is not worth N more timeouts.
 */
export function membersShippedVerdict(
  state: SchedState,
  batch: BatchEntry,
  read: IssueCloseReader,
  opts: MembersVerdictOptions = {}
): OpenAnchorVerdict {
  const exhaustive = opts.exhaustive === true;
  const reasons = [...(opts.extraReasons ?? []), ...anchorLedgerBlockers(state, batch)];
  const members: AnchorMemberReport[] = batch.members.map((issue) => ({
    issue,
    ledger_status: findEntry(state, issue)?.status ?? null,
    github: 'unknown',
    state_reason: null,
    shipped_by: null,
  }));
  if (reasons.length > 0 && !exhaustive) return { kind: 'needs-operator', reasons, members };

  let unreachable: number | null = null;
  for (const member of members) {
    const truth = read(member.issue);
    if (truth === undefined) {
      unreachable = member.issue;
      break;
    }
    if (truth.state === 'MISSING') {
      member.github = 'MISSING';
      reasons.push(`member-missing:#${member.issue}`);
      if (!exhaustive) break;
      continue;
    }
    member.github = truth.state;
    member.state_reason = truth.stateReason;
    if (truth.state === 'OPEN') {
      reasons.push(`member-open:#${member.issue}`);
    } else if (truth.stateReason !== 'COMPLETED') {
      reasons.push(
        `member-closed-${(truth.stateReason ?? 'unknown').toLowerCase()}:#${member.issue}`
      );
    } else {
      const evidence = shippingEvidence(truth, batch.base_branch, opts.repo, opts.commitInBase);
      if ('shipped' in evidence) member.shipped_by = evidence.shipped;
      else reasons.push(`member-${evidence.refused}:#${member.issue}`);
    }
    if (hasLabel(truth.labels, DECISION_PENDING_LABEL)) {
      reasons.push(`member-handed-back:#${member.issue}`);
    }
    if (reasons.length > 0 && !exhaustive) break;
  }
  // A known disqualifier outranks an unreachable read: whatever the missing
  // poll would have said, the batch is not closable on this pass.
  if (reasons.length > 0) return { kind: 'needs-operator', reasons, members };
  if (unreachable !== null) {
    return { kind: 'unknown', reasons: [`issue #${unreachable} unreachable`], members };
  }
  return { kind: 'closable', reasons: [], members };
}

/**
 * The full anchor verdict: the anchor itself first (an already-closed anchor
 * needs nothing; a handed-back anchor is the operator's), then
 * {@link membersShippedVerdict}.
 */
export function classifyAnchor(
  state: SchedState,
  batch: BatchEntry,
  read: IssueCloseReader,
  opts: Omit<MembersVerdictOptions, 'extraReasons'> = {}
): AnchorVerdict {
  if (batch.anchor === null) {
    return { kind: 'needs-operator', reasons: ['no-anchor'], members: [] };
  }
  const anchor = read(batch.anchor);
  if (anchor === undefined) {
    return { kind: 'unknown', reasons: [`anchor #${batch.anchor} unreachable`], members: [] };
  }
  if (anchor.state === 'CLOSED') return { kind: 'anchor-closed' };
  if (anchor.state === 'MISSING') {
    return { kind: 'needs-operator', reasons: ['anchor-missing'], members: [] };
  }
  const extraReasons = hasLabel(anchor.labels, DECISION_PENDING_LABEL)
    ? ['anchor-handed-back']
    : [];
  return membersShippedVerdict(state, batch, read, { ...opts, extraReasons });
}

/** The idempotency marker on the anchor-close comment — one per batch. */
export function anchorCloseMarker(batchId: string): string {
  return `<!-- batch-close:v1 batch=${batchId} anchor -->`;
}

/** The comment posted on the anchor before it is closed. */
export function renderAnchorCloseComment(batch: BatchEntry, members: AnchorMemberReport[]): string {
  return [
    anchorCloseMarker(batch.id),
    `**Batch \`${batch.id}\` anchor closed by sched** — every member issue was closed as completed by code that landed in \`${batch.base_branch}\`, and none was evicted, handed back, requeued, or left with a failure.`,
    '',
    '| member | shipped by |',
    '|---|---|',
    ...members.map((m) => `| #${m.issue} | ${m.shipped_by ?? 'unknown'} |`),
    '',
    `Batch ledger status at close: \`${formatBatchStatus(batch)}\`.`,
  ].join('\n');
}

/**
 * `comments-unreadable`: the marker check could not run (or the gh identity
 * could not be read), so nothing was posted; `comment-failed`/`close-failed`:
 * that write failed.
 */
export type AnchorCloseOutcome =
  | 'closed'
  | 'comments-unreadable'
  | 'comment-failed'
  | 'close-failed';

/** A GitHub login — the only shape interpolated into the comment filter below. */
const GH_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

/**
 * Comment-then-close the anchor, idempotently (the #720 shape): the comment
 * is posted only when the anchor does not already carry this batch's marker,
 * so a rerun after a failed close closes without a second comment. The marker
 * counts only at the START of a comment by the authenticated gh user — any
 * commenter could otherwise post it and suppress the audit comment. When the
 * existing comments cannot be read, nothing is posted: a duplicate comment is
 * exactly what the marker exists to prevent.
 *
 * Every call names `repo` explicitly (`-R`): the anchor is never resolved from
 * whatever repository the cwd happens to be.
 */
export function closeAnchor(
  exec: ExecFn,
  repoDir: string,
  repo: string,
  batch: BatchEntry,
  anchorIssue: number,
  members: AnchorMemberReport[]
): AnchorCloseOutcome {
  const anchor = String(anchorIssue);
  const login = exec('gh', ['api', 'user', '--jq', '.login'], repoDir)?.trim();
  if (login === undefined || !GH_LOGIN_RE.test(login)) return 'comments-unreadable';
  const mine = exec(
    'gh',
    [
      'issue',
      'view',
      anchor,
      '-R',
      repo,
      '--json',
      'comments',
      '--jq',
      `[.comments[] | select(.author.login == "${login}") | .body]`,
    ],
    repoDir
  );
  let bodies: unknown;
  try {
    bodies = mine === null ? null : JSON.parse(mine);
  } catch {
    bodies = null;
  }
  if (!Array.isArray(bodies)) return 'comments-unreadable';
  const marker = anchorCloseMarker(batch.id);
  if (!bodies.some((b) => typeof b === 'string' && b.startsWith(marker))) {
    const body = renderAnchorCloseComment(batch, members);
    if (exec('gh', ['issue', 'comment', anchor, '-R', repo, '--body', body], repoDir) === null) {
      return 'comment-failed';
    }
  }
  return exec('gh', ['issue', 'close', anchor, '-R', repo, '--reason', 'completed'], repoDir) ===
    null
    ? 'close-failed'
    : 'closed';
}

/** A `sched status --anchors` sweep row (report-only — the sweep never closes anything). */
export interface AnchorReportItem {
  batch: string;
  anchor: number;
  batch_status: BatchStatus;
  verdict: OpenAnchorVerdict['kind'];
  reasons: string[];
  members: AnchorMemberReport[];
}

/**
 * `sched status --anchors`' sweep (#768): every still-open anchor of a batch
 * that is no longer in flight, marked `closable` (the strict condition holds —
 * the engine will close it, within its 7-day window), `needs-operator`
 * (anything else), or `unknown` (a GitHub read failed — nothing decided),
 * with each member's state. Report-only by construction: it takes no exec for
 * writes and has no way to close anything. The first failed read stops the
 * sweep's reads; every later batch is reported `unknown` without a call.
 */
export function sweepAnchors(
  state: SchedState,
  read: IssueCloseReader,
  opts: { repo?: string; commitInBase?: CommitInBase } = {}
): AnchorReportItem[] {
  const items: AnchorReportItem[] = [];
  let aborted = false;
  for (const batch of openAnchorBatches(state, SWEEP_BATCH_STATUSES)) {
    const verdict: AnchorVerdict = aborted
      ? { kind: 'unknown', reasons: ['GitHub unreachable — sweep aborted'], members: [] }
      : classifyAnchor(state, batch, read, { exhaustive: true, ...opts });
    if (verdict.kind === 'anchor-closed') continue;
    if (verdict.kind === 'unknown') aborted = true;
    items.push({
      batch: batch.id,
      anchor: batch.anchor,
      batch_status: batch.status,
      verdict: verdict.kind,
      reasons: verdict.reasons,
      members: verdict.members,
    });
  }
  return items;
}
