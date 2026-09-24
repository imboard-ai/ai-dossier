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

import { SAFE_REF_RE } from './attribution';
import type { IssueCloseTruth } from './groundtruth';
import { DECISION_PENDING_LABEL, hasLabel } from './labels';
import type { ExecFn } from './project';
import {
  distinctEvictions,
  findEntry,
  ISSUE_UNIVERSAL_FAILURE_EDGES,
  PARKED_MEMBER_STATUSES,
} from './state';
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
  // #810: both parked statuses — `evicted` and the member's own `handed-back`.
  ...PARKED_MEMBER_STATUSES,
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

/** {@link readMembersShipping}'s answer: the GitHub-side half only, no ledger. */
interface MembersShippingResult {
  reasons: string[];
  members: AnchorMemberReport[];
  /** The member whose read failed, stopping the reads; `null` when every read that ran succeeded. */
  unreachable: number | null;
}

/**
 * The GitHub-only half of the member predicate: every member CLOSED as
 * `COMPLETED` by shipped code ({@link shippingEvidence}), none handed back.
 * No ledger involvement — `ledgerStatus` supplies each report's
 * `ledger_status` display field only, never a disqualifier; callers that
 * have a ledger entry to consult layer their own blockers on top (see
 * {@link membersShippedVerdict}). Extracted so {@link classifyOrphanAnchor}
 * can reuse the identical shipping-evidence logic for a batch that, by
 * definition, has no ledger entry to consult.
 *
 * `exhaustive: false` stops at the first disqualifying fact; `exhaustive:
 * true` reads every member so the operator sees each one's state. Either way
 * a failed read stops the reads: GitHub being unreachable is not worth N
 * more timeouts.
 */
function readMembersShipping(
  members: readonly number[],
  read: IssueCloseReader,
  baseBranch: string,
  opts: { exhaustive: boolean; repo?: string; commitInBase?: CommitInBase },
  ledgerStatus: (issue: number) => IssueStatus | null
): MembersShippingResult {
  const reports: AnchorMemberReport[] = members.map((issue) => ({
    issue,
    ledger_status: ledgerStatus(issue),
    github: 'unknown',
    state_reason: null,
    shipped_by: null,
  }));
  const reasons: string[] = [];
  let unreachable: number | null = null;
  for (const member of reports) {
    const truth = read(member.issue);
    if (truth === undefined) {
      unreachable = member.issue;
      break;
    }
    if (truth.state === 'MISSING') {
      member.github = 'MISSING';
      reasons.push(`member-missing:#${member.issue}`);
      if (!opts.exhaustive) break;
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
      const evidence = shippingEvidence(truth, baseBranch, opts.repo, opts.commitInBase);
      if ('shipped' in evidence) member.shipped_by = evidence.shipped;
      else reasons.push(`member-${evidence.refused}:#${member.issue}`);
    }
    if (hasLabel(truth.labels, DECISION_PENDING_LABEL)) {
      reasons.push(`member-handed-back:#${member.issue}`);
    }
    if (reasons.length > 0 && !opts.exhaustive) break;
  }
  return { reasons, members: reports, unreachable };
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
  const ledgerReasons = [...(opts.extraReasons ?? []), ...anchorLedgerBlockers(state, batch)];
  if (ledgerReasons.length > 0 && !exhaustive) {
    const members: AnchorMemberReport[] = batch.members.map((issue) => ({
      issue,
      ledger_status: findEntry(state, issue)?.status ?? null,
      github: 'unknown',
      state_reason: null,
      shipped_by: null,
    }));
    return { kind: 'needs-operator', reasons: ledgerReasons, members };
  }

  const gh = readMembersShipping(
    batch.members,
    read,
    batch.base_branch,
    { exhaustive, repo: opts.repo, commitInBase: opts.commitInBase },
    (issue) => findEntry(state, issue)?.status ?? null
  );
  const reasons = [...ledgerReasons, ...gh.reasons];
  // A known disqualifier outranks an unreachable read: whatever the missing
  // poll would have said, the batch is not closable on this pass.
  if (reasons.length > 0) return { kind: 'needs-operator', reasons, members: gh.members };
  if (gh.unreachable !== null) {
    return {
      kind: 'unknown',
      reasons: [`issue #${gh.unreachable} unreachable`],
      members: gh.members,
    };
  }
  return { kind: 'closable', reasons: [], members: gh.members };
}

/** The anchor issue's own ground truth, shared by {@link classifyAnchor} and {@link classifyOrphanAnchor}. */
type AnchorGroundVerdict =
  | { kind: 'anchor-closed' }
  | { kind: 'anchor-missing' }
  | { kind: 'unknown'; reasons: string[] }
  | { kind: 'open'; handedBack: boolean };

function anchorGroundVerdict(read: IssueCloseReader, anchorIssue: number): AnchorGroundVerdict {
  const anchor = read(anchorIssue);
  if (anchor === undefined) {
    return { kind: 'unknown', reasons: [`anchor #${anchorIssue} unreachable`] };
  }
  if (anchor.state === 'CLOSED') return { kind: 'anchor-closed' };
  if (anchor.state === 'MISSING') return { kind: 'anchor-missing' };
  return { kind: 'open', handedBack: hasLabel(anchor.labels, DECISION_PENDING_LABEL) };
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
  const ground = anchorGroundVerdict(read, batch.anchor);
  if (ground.kind === 'anchor-closed') return { kind: 'anchor-closed' };
  if (ground.kind === 'anchor-missing') {
    return { kind: 'needs-operator', reasons: ['anchor-missing'], members: [] };
  }
  if (ground.kind === 'unknown') return { kind: 'unknown', reasons: ground.reasons, members: [] };
  const extraReasons = ground.handedBack ? ['anchor-handed-back'] : [];
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

// --- #790: orphan anchors — batches dropped from `state.batches` entirely ---
//
// `sweepAnchors` above only ever sees a batch that is still IN `state.batches`
// (`openAnchorBatches` filters that array). Nothing in this codebase today
// removes an entry from `state.batches` — `abandonBatch` dissolves a batch
// in place (status → `dissolved`, still swept) and the one split path
// (`recovery.ts`'s halved dissolve) carries the parent's `anchor` forward
// onto the new half-batches. The one way a batch's row is gone while its
// GitHub anchor stays open is `state.json` itself being lost or reset
// (`persist.ts`'s `load()` falls back to `createEmptyState()` when the file
// is missing) — exactly the imboard#4244/#4253 shape: `sched status --json`
// showed `batches: []` while both anchors were still open. Whatever the
// cause, an anchor with no ledger row is invisible to `sweepAnchors`
// (there is no `BatchEntry` to iterate), so this sweep is GitHub-only: list
// open `batch-epic` anchors directly, recover membership from the anchor's
// own issue body, and classify with the same shipping-evidence logic
// `classifyAnchor` uses.

/** One `- [ ] #N ...` / `- [x] #N ...` member line, plus the `base_branch: <name>` line — both written once at batch creation (per `examples/git/batch-issues-preparation.ds.md`'s Step 6 anchor-body template) and never edited afterward by any code in this repo. */
const ORPHAN_MEMBER_RE = /^- \[[ xX]\] #(\d+)/gm;
const ORPHAN_BASE_BRANCH_RE = /^base_branch:\s*(\S+)/m;

/** The largest issue number a GitHub GraphQL `Int!` variable accepts — a member number above this could never be a real issue, so it is dropped rather than sent to `read`. */
const MAX_GITHUB_ISSUE_NUMBER = 2 ** 31 - 1;

/**
 * #790 (security review): the anchor body is untrusted input — anyone who can
 * comment-and-edit an open `batch-epic` issue controls it. Without a cap, a
 * body with thousands of checklist lines would cost thousands of GraphQL
 * reads per sweep (`classifyOrphanAnchor` runs `exhaustive: true`), and one
 * crafted out-of-range member number would error that member's read,
 * `orphan-unknown` it, and abort {@link sweepOrphanAnchors}'s reads for every
 * later anchor. Both are answered the same way: a body over the cap is
 * reported `orphan-needs-operator` (reason `members-over-cap`) with NO reads
 * performed at all — see {@link classifyOrphanAnchor}.
 */
export const ORPHAN_SWEEP_MAX_MEMBERS = 50;

/**
 * Recover a batch anchor's members and base branch from its own issue body —
 * the only record left once the batch has dropped out of `state.batches`.
 * The body is the batch-compose format (RFC-0001): one member checklist line
 * per issue, then metadata lines including `base_branch: <name>`. Nothing in
 * this codebase edits an anchor's body after creation (verified: no
 * `gh issue edit ... --body` targets an anchor), so the checklist is already
 * the complete, stable membership — a `batch-setup` runstate milestone would
 * only repeat the same list less reliably (missing entirely for an anchor
 * that predates runstate, or belonging to a requeued run's earlier attempt).
 *
 * Both fields are untrusted (#790 security review) and validated before use:
 * a member number outside `1..MAX_GITHUB_ISSUE_NUMBER` is dropped (never sent
 * to `read`), and `base_branch` falls back to `main` — never propagating a
 * string {@link SAFE_REF_RE} would reject as a git ref — when the metadata
 * line is missing OR unsafe. `main` is what `gate-issue` defaults to, so it
 * is what `shippingEvidence` checks a closer against either way.
 * `members_over_cap` is set (members truncated to {@link ORPHAN_SWEEP_MAX_MEMBERS})
 * rather than silently proceeding on a partial list — the caller reports it,
 * never reads a partial membership as if it were the whole batch.
 */
export function parseOrphanAnchorBody(body: string): {
  members: number[];
  base_branch: string;
  members_over_cap: boolean;
} {
  const raw = [...body.matchAll(ORPHAN_MEMBER_RE)].map((m) => Number(m[1]));
  const valid = raw.filter((n) => Number.isInteger(n) && n > 0 && n <= MAX_GITHUB_ISSUE_NUMBER);
  const deduped = [...new Set(valid)];
  const members_over_cap = deduped.length > ORPHAN_SWEEP_MAX_MEMBERS;
  const members = members_over_cap ? deduped.slice(0, ORPHAN_SWEEP_MAX_MEMBERS) : deduped;
  const rawBranch = ORPHAN_BASE_BRANCH_RE.exec(body)?.[1];
  const base_branch = rawBranch !== undefined && SAFE_REF_RE.test(rawBranch) ? rawBranch : 'main';
  return { members, base_branch, members_over_cap };
}

/** A batch-epic anchor recovered from GitHub, with no `state.batches` row behind it. */
export interface OrphanAnchorCandidate {
  anchor: number;
  members: number[];
  base_branch: string;
  /** Set when {@link parseOrphanAnchorBody} truncated the member list at {@link ORPHAN_SWEEP_MAX_MEMBERS} — `classifyOrphanAnchor` refuses to read a partial membership. */
  members_over_cap?: boolean;
}

/**
 * {@link classifyOrphanAnchor}'s answer. Deliberately its own vocabulary —
 * `orphan-closable-candidate`, never bare `closable` — because without a
 * ledger there is no failure-trail evidence (no eviction/requeue record to
 * rule out, the operator's rule from #768 is POSITIVE evidence only): even a
 * verdict with zero disqualifying reasons is a CANDIDATE for a human to
 * confirm, not the ledger-backed `sweepAnchors`' stronger `closable`.
 */
export type OrphanAnchorVerdict = {
  kind: 'orphan-closable-candidate' | 'orphan-needs-operator' | 'orphan-unknown';
  reasons: string[];
  members: AnchorMemberReport[];
};

/**
 * Classify one orphan anchor candidate, or `null` when it turns out not to be
 * an orphan at all — the anchor CLOSED between the GitHub list and this read
 * (the caller only ever lists open anchors), the same list-then-read race
 * `sweepAnchors` answers by `continue`-ing past a freshly `anchor-closed`
 * verdict rather than reporting one. Deliberately NOT `classifyAnchor` /
 * `membersShippedVerdict` verbatim: those consult `anchorLedgerBlockers`,
 * which pushes `member-not-in-ledger:#N` for every member of ANY batch not
 * in `state.batches` — for an orphan that is true by construction, so the
 * ledger-backed predicate would answer `needs-operator` unconditionally and
 * this sweep could never report a clean batch as a candidate. This reuses
 * the SAME shipping-evidence logic ({@link readMembersShipping}, which is
 * {@link shippingEvidence} plus the open/not-completed/handed-back checks)
 * and the SAME anchor-level ground truth ({@link anchorGroundVerdict}) that
 * `classifyAnchor` uses — the ledger check is the one piece structurally
 * inapplicable to something not in the ledger.
 */
export function classifyOrphanAnchor(
  candidate: OrphanAnchorCandidate,
  read: IssueCloseReader,
  opts: { repo?: string; commitInBase?: CommitInBase } = {}
): OrphanAnchorVerdict | null {
  const ground = anchorGroundVerdict(read, candidate.anchor);
  if (ground.kind === 'anchor-closed') {
    // The caller lists only OPEN anchors, so this is a list-then-read race
    // (closed between the list and this read) — same non-event as
    // `sweepAnchors`'s `if (verdict.kind === 'anchor-closed') continue`, so
    // the sweep skips it too rather than reporting a stale action item.
    return null;
  }
  if (ground.kind === 'anchor-missing') {
    return { kind: 'orphan-needs-operator', reasons: ['anchor-missing'], members: [] };
  }
  if (ground.kind === 'unknown') {
    return { kind: 'orphan-unknown', reasons: ground.reasons, members: [] };
  }
  if (candidate.members.length === 0) {
    return { kind: 'orphan-needs-operator', reasons: ['no-members-recovered'], members: [] };
  }
  // #790 security review: a body truncated at the member cap is a PARTIAL
  // membership — reading and clearing those members would be evidence about
  // the wrong batch. Refuse without a single GitHub read.
  if (candidate.members_over_cap === true) {
    return { kind: 'orphan-needs-operator', reasons: ['members-over-cap'], members: [] };
  }
  const extraReasons = ground.handedBack ? ['anchor-handed-back'] : [];
  const gh = readMembersShipping(
    candidate.members,
    read,
    candidate.base_branch,
    { exhaustive: true, repo: opts.repo, commitInBase: opts.commitInBase },
    () => null
  );
  const reasons = [...extraReasons, ...gh.reasons];
  if (reasons.length > 0) {
    return { kind: 'orphan-needs-operator', reasons, members: gh.members };
  }
  if (gh.unreachable !== null) {
    return {
      kind: 'orphan-unknown',
      reasons: [`issue #${gh.unreachable} unreachable`],
      members: gh.members,
    };
  }
  return { kind: 'orphan-closable-candidate', reasons: [], members: gh.members };
}

/** One open `batch-epic` anchor issue, as listed from GitHub. */
export interface OpenAnchorIssue {
  number: number;
  title: string;
  body: string;
}

/** Lists open `batch-epic` anchor issues for the pinned project repo, or `undefined` on a failed read (unverified repo, `gh` unreachable). */
export type OpenAnchorLister = () => OpenAnchorIssue[] | undefined;

/** `sched status --anchors`' orphan sweep (#790): bounded read cost per run — a GitHub-side sweep must never grow with the repo's total anchor count. */
export const ORPHAN_SWEEP_MAX_ANCHORS = 20;

/** One `sched status --anchors` orphan-sweep row. */
export interface OrphanAnchorReportItem {
  anchor: number;
  title: string;
  verdict: OrphanAnchorVerdict['kind'];
  reasons: string[];
  members: AnchorMemberReport[];
}

/**
 * `sched status --anchors`' orphan sweep (#790): every open `batch-epic`
 * anchor in the pinned project repo whose batch is no longer in
 * `state.batches` — invisible to {@link sweepAnchors}, which only walks the
 * ledger. Report-only by construction, exactly like `sweepAnchors`: `list`
 * and `read` are both pure lookups with no write capability, so this
 * function has no way to close, comment on, label, or edit anything — it
 * only ever builds and returns {@link OrphanAnchorReportItem} rows.
 *
 * `null` means the list itself failed (an unverified repo, or `gh`
 * unreachable) — distinct from `[]` ("asked, found zero orphans"), the same
 * null-vs-empty convention `StatusReport.anchors`/`orphan_anchors` already
 * use for "the sweep did not run at all". Ledger-tracked anchors are
 * excluded BEFORE the {@link ORPHAN_SWEEP_MAX_ANCHORS} cap is applied — a
 * busy repo with 20+ open ledger-tracked `batch-epic` anchors must not let
 * them crowd out the orphans this sweep exists to find. Classifying stops at
 * the first failed member/anchor read (the same fail-closed posture as
 * `sweepAnchors`): every anchor after that point is reported `orphan-unknown`
 * without a further call.
 */
export function sweepOrphanAnchors(
  state: SchedState,
  list: OpenAnchorLister,
  read: IssueCloseReader,
  opts: { repo?: string; commitInBase?: CommitInBase } = {}
): OrphanAnchorReportItem[] | null {
  const anchors = list();
  if (anchors === undefined) return null;
  const ledgerAnchors = new Set(
    state.batches.map((b) => b.anchor).filter((a): a is number => a !== null)
  );
  const orphanCandidates = anchors.filter((issue) => !ledgerAnchors.has(issue.number));
  const items: OrphanAnchorReportItem[] = [];
  let aborted = false;
  for (const issue of orphanCandidates.slice(0, ORPHAN_SWEEP_MAX_ANCHORS)) {
    const { members, base_branch, members_over_cap } = parseOrphanAnchorBody(issue.body);
    const verdict: OrphanAnchorVerdict | null = aborted
      ? { kind: 'orphan-unknown', reasons: ['GitHub unreachable — sweep aborted'], members: [] }
      : classifyOrphanAnchor(
          { anchor: issue.number, members, base_branch, members_over_cap },
          read,
          opts
        );
    if (verdict === null) continue; // closed between the list and this read — not an orphan
    if (verdict.kind === 'orphan-unknown') aborted = true;
    items.push({
      anchor: issue.number,
      title: issue.title,
      verdict: verdict.kind,
      reasons: verdict.reasons,
      members: verdict.members,
    });
  }
  return items;
}

// --- #790: warn (never refuse) when a batch with an open anchor is dropped ---

/**
 * Whether dissolving `batch` (`sched abandon --batch`) should warn an
 * operator: its anchor is set and, per `read`, still OPEN. Pure predicate —
 * the CLI performs the actual GitHub read and the print/journal side effect
 * (`sched abandon --batch`'s handler). `null` covers both "no anchor to warn
 * about" and "read failed / anchor already closed or missing" alike: this
 * function only ever tells the caller whether to warn, never why not to —
 * `abandonBatch` itself must NEVER refuse over this (#790: refusing would
 * wedge exactly the cleanup `abandon` exists for).
 */
export function batchAnchorStillOpen(
  batch: Pick<BatchEntry, 'anchor'>,
  read: IssueCloseReader
): number | null {
  if (batch.anchor === null) return null;
  // Reuses `anchorGroundVerdict` (the same anchor-level read `classifyAnchor`
  // and `classifyOrphanAnchor` use) rather than re-deriving "is it OPEN"
  // ourselves — `kind === 'open'` is exactly `truth.state === 'OPEN'`, one
  // ground-truth read of the anchor shared by all three call sites.
  return anchorGroundVerdict(read, batch.anchor).kind === 'open' ? batch.anchor : null;
}
