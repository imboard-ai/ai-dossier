/**
 * `sched status` report (AC4): queue, slots, batches, parked PRs, and the
 * blocked/failed sets as a machine-readable report. Text rendering lives in
 * the CLI (`cli/src/commands/sched.ts`, on top of the CLI's shared
 * `renderTable`) — the package deliberately has no dependency on CLI
 * utilities.
 */

import * as fs from 'node:fs';
import {
  type AnchorReportItem,
  type CommitInBase,
  type IssueCloseReader,
  sweepAnchors,
} from './anchor-close';
import {
  resolveDispatch,
  resolveProfiledDispatch,
  type TierExecutor,
  tierExecutors,
} from './dispatch';
import { batchOfUnit } from './journal';
import type { EngineLeaseStatus } from './persist';
import type { ExecFn } from './project';
import {
  batchBlockers,
  DISPATCHABLE_ISSUE_STATUSES,
  dependencyBlockers,
  runnableUnits,
} from './readiness';
import { DISSOLVE_REFUSED_PREFIX } from './recovery';
import { distinctEvictions, PARKED_MEMBER_STATUSES, validatedMembersOf } from './state';
import { defaultFsExists, type FsExists, POOL_ARGS_PREFIX, POOL_BIN } from './teardown';
import type {
  BatchEntry,
  DispatchProfileSource,
  MemberExitKind,
  ModelTier,
  QueueEntry,
  SchedConfig,
  SchedState,
  SlotEntry,
} from './types';
import { LIVE_SLOT_STATUSES, SATISFIED_ISSUE_STATUSES, TERMINAL_ISSUE_STATUSES } from './types';

/** An entry that cannot progress, with the human reason. */
export interface BlockedItem {
  issue: number;
  status: string;
  reason: string;
}

/** A parked unit awaiting its PR merge (#468). */
export interface ParkedItem {
  issue: number;
  pr: number;
  /** When the unit parked (entry `updated_at`). */
  since: string;
}

/**
 * #810: a batch member PARKED out of its batch — `evicted` (an engine-decided
 * failure) or `handed-back` (the member's own hand-back). Parked members are
 * never auto-dispatched; `remedies` are the exact commands an operator runs
 * to decide.
 */
export interface ParkedMemberItem {
  issue: number;
  /** The batch it left (null for a pre-#810 entry that no longer names one). */
  batch: string | null;
  kind: MemberExitKind;
  reason: string;
  /** Member branch holding its un-landed work (its remote copy survives teardown), when recorded. */
  branch: string | null;
  /** Dispatch profile a requeue runs on (the batch's). */
  dispatch_profile: string | null;
  /** When it parked (entry `updated_at`). */
  since: string;
  /** What the operator should know before choosing a remedy. */
  note: string;
  /** Exact remedy commands, in order of preference. */
  remedies: string[];
}

/** The parked-member row for one entry (#810). */
function parkedMemberItem(entry: QueueEntry): ParkedMemberItem {
  const kind = entry.status as MemberExitKind;
  const reason = entry.reason ?? entry.failure_evidence?.reason ?? kind;
  const branch = entry.failure_evidence?.branch ?? null;
  const profile = entry.dispatch_profile ?? null;
  const from =
    branch !== null ? `from ${branch}` : 'from the base branch (no member branch recorded)';
  const on = profile !== null ? ` on profile ${profile}` : ' on the default profile';
  const note =
    kind === 'handed-back'
      ? `the member handed back (${reason}) — resolve what it needs (see its handover / blocked milestone on #${entry.issue}) before requeueing`
      : `evicted (${reason}) — requeue continues the work ${from}${on}`;
  return {
    issue: entry.issue,
    batch: entry.batch ?? entry.failure_evidence?.batch ?? null,
    kind,
    reason,
    branch,
    dispatch_profile: profile,
    since: entry.updated_at,
    note,
    remedies: [
      `ai-dossier sched requeue --issue ${entry.issue}`,
      `ai-dossier sched abandon --issue ${entry.issue} --reason <why>`,
    ],
  };
}

/**
 * #810: what an operator can do with a batch whose `full` dissolve was
 * refused over validated members (`blocked_reason: dissolve-refused:<why>`).
 * Only an unattributed failure or a broken dispatch profile leaves a branch
 * worth shipping as-is; a red suite or a partial revert does not.
 */
function dissolveRefusedNote(state: SchedState, batch: BatchEntry): string {
  const reason = batch.blocked_reason ?? '';
  if (!reason.startsWith(DISSOLVE_REFUSED_PREFIX)) return '';
  const validated = validatedMembersOf(state, batch);
  if (validated.length === 0) return '';
  const why = reason.slice(DISSOLVE_REFUSED_PREFIX.length);
  const branch = batch.branch ?? '<integration branch>';
  const list = validated.map((m) => `#${m}`).join(',');
  const shippable =
    why === 'unattributable-suite-failure' || why.startsWith('dispatch-profile-missing');
  const salvage = shippable
    ? `ship them: \`gh pr create --head ${branch} --base ${batch.base_branch}\` — once it merges the engine reconciles them to shipped`
    : `the branch is red or partly reverted — inspect it before shipping anything (fix on ${branch}, then \`gh pr create --head ${branch} --base ${batch.base_branch}\`)`;
  return (
    `; validated member(s) ${list} stay landed on ${branch} — ${salvage}; or ` +
    `\`ai-dossier sched abandon --batch ${batch.id}\` (requeues them full-cycle instead)`
  );
}

/**
 * #776: how long a pause, or a live slot without progress, may last before
 * `sched status` flags it. A day is long past every phase stall allowance
 * (30 min default, 90 min `implement`), so anything older is not "still
 * working" — it is state nobody came back to.
 */
export const STATUS_HEALTH_WARNING_AGE_MS = 24 * 60 * 60 * 1000;

/** The kinds of health warning `sched status` raises (#776, plus #791's `kept-worktree`). */
export type StatusWarningKind =
  | 'long-pause'
  | 'stale-engine-lease'
  | 'stuck-slot'
  | 'stale-closed'
  | 'kept-worktree';

/**
 * A condition an operator must act on (#776): the 2026-09-24 incident was a
 * scheduler paused for days, a dead engine lease, and a slot `recovering` an
 * issue shipped four days earlier — all visible in the raw report, none of
 * them called out. `message` states the fact; `remedy` is the exact command
 * (or step) that resolves it.
 */
export interface StatusWarning {
  kind: StatusWarningKind;
  message: string;
  remedy: string;
  /** The issue the warning is about, when it is about one. */
  issue?: number;
  /** The slot the warning is about, when it is about one. */
  slot?: number;
  /** The batch the warning is about, when it is about one (#791: batch ids are strings, unlike `issue`/`slot`). */
  batch?: string;
}

/** Machine-readable status report (`sched status --json`). */
export interface StatusReport {
  /** Project slug the report was built for (which state bucket this is). */
  project: string;
  paused: boolean;
  max_slots: number;
  live_slots: number;
  engine_lease: EngineLeaseStatus | null;
  queue: QueueEntry[];
  slots: SlotEntry[];
  batches: BatchEntry[];
  /** Parked units being watched by the PR watcher (#468). */
  parked: ParkedItem[];
  /**
   * #810: batch members parked out of their batch (evicted / handed back),
   * with reason, branch, profile and the exact remedy commands.
   */
  parked_members: ParkedMemberItem[];
  /** When the PR watcher last polled (#468) — null before the first poll. */
  last_pr_poll_at: string | null;
  /**
   * When the engine last re-read hard-block labels (#544) — null before the
   * first read. Surfaced next to `last_pr_poll_at` so an operator who removed
   * a `decision-pending` label can tell "the engine has not looked yet" apart
   * from "the engine looked and the label is still there".
   */
  last_label_poll_at: string | null;
  /**
   * The dispatch-health signal — see `SchedState.consecutive_suspect_dispatches`
   * (#505, a timing heuristic) and `SchedState.consecutive_dispatch_api_errors`
   * (#629, a confirmed provider error). A pause can be caused by either
   * independently — an operator reading `consecutive_suspect: 0` alone while
   * `paused` is true would see no explanation for a #629 pause at all.
   */
  dispatch_health: {
    consecutive_suspect: number;
    last_suspect_unit: string | null;
    consecutive_api_errors: number;
    pause_reset_at: string | null;
  };
  /** Most recent scheduler-wide tick failure, if the following tick has not recovered. */
  last_tick_failure: SchedState['last_tick_failure'];
  /** How many units are runnable right now. */
  runnable: number;
  /** Which units are runnable (`issue:<n>` / `batch:<id>`), in dispatch order. */
  runnable_units: string[];
  /**
   * The configured executor per tier (#680) — which agent CLI and model each
   * tier actually dispatches, resolved exactly as the engine resolves them
   * (`resolveDispatch`). Exists because the operator's choice of agent/model
   * at the top of a session stops at the prep boundary: an operator running
   * the batch from opencode/GLM otherwise has no signal that every dispatched
   * unit is still the default `claude` template, without reading
   * `events.jsonl`. Surfaces the mixed `dispatch.tiers` ladder too.
   *
   * #707: `profiles` names every configured dispatch profile with its own
   * resolved per-tier executors, so `sched status` can say what a
   * `--dispatch glm` batch WILL spawn before it spawns. Which batch uses
   * which profile rides on each `BatchEntry.dispatch_profile`.
   */
  dispatch: {
    tiers: Record<ModelTier, TierExecutor>;
    profiles: Record<string, Record<ModelTier, TierExecutor>>;
    profile_sources: Record<string, DispatchProfileSource>;
  };
  blocked: BlockedItem[];
  failed: QueueEntry[];
  stopped: QueueEntry[];
  /**
   * Health warnings (#776), plus #791's `kept-worktree` when a reader was
   * supplied — empty when nothing needs an operator.
   */
  warnings: StatusWarning[];
  /**
   * #768 anchor sweep (report-only, `sched status --anchors`): every
   * still-open anchor of a batch that is no longer in flight, `closable`,
   * `needs-operator` or `unknown`, with each member's state. `null` when the
   * report was built without the sweep (the default — `status` makes no
   * network call unless asked; nothing is guessed from the ledger alone).
   */
  anchors: AnchorReportItem[] | null;
}

function hoursSince(iso: string, nowMs: number): number | null {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : (nowMs - at) / (60 * 60 * 1000);
}

function formatHours(hours: number): string {
  return hours >= 48 ? `${Math.floor(hours / 24)}d` : `${Math.floor(hours)}h`;
}

/** The `sched stop` invocation that releases `unit` (`issue:<n>` / `batch:<id>`). */
function stopRemedy(unit: string): string {
  // #809: a parallel member's unit `batch:<id>#<issue>` is stopped with its batch.
  const batchId = batchOfUnit(unit);
  return batchId !== null
    ? `sched stop --batch ${batchId}`
    : `sched stop --issue ${unit.slice('issue:'.length)}`;
}

/**
 * #776: the health warnings — pure over state + lease + clock, so every
 * warning is unit-testable without a live engine.
 */
export function buildStatusWarnings(
  state: SchedState,
  engineLease: EngineLeaseStatus | null,
  now: Date
): StatusWarning[] {
  const warnings: StatusWarning[] = [];
  const nowMs = now.getTime();
  const thresholdHours = STATUS_HEALTH_WARNING_AGE_MS / (60 * 60 * 1000);

  if (state.paused) {
    const hours = state.paused_at === null ? null : hoursSince(state.paused_at, nowMs);
    if (hours === null) {
      warnings.push({
        kind: 'long-pause',
        message:
          'scheduler is paused, since an unknown time (the pause predates paused_at tracking)',
        remedy: 'review the queue and slots below, then `sched resume`',
      });
    } else if (hours > thresholdHours) {
      warnings.push({
        kind: 'long-pause',
        message: `scheduler has been paused for ${formatHours(hours)} (since ${state.paused_at})`,
        remedy: 'review the queue and slots below, then `sched resume`',
      });
    }
  }

  const unfinished = state.entries.filter(
    (e) => !TERMINAL_ISSUE_STATUSES.has(e.status) && !SATISFIED_ISSUE_STATUSES.has(e.status)
  ).length;
  const liveSlots = state.slots.filter((s) => LIVE_SLOT_STATUSES.has(s.status)).length;
  if (engineLease !== null && !engineLease.alive && (unfinished > 0 || liveSlots > 0)) {
    warnings.push({
      kind: 'stale-engine-lease',
      message: `engine lease is stale (pid ${engineLease.pid} is not running) while ${unfinished} queue entr${unfinished === 1 ? 'y is' : 'ies are'} unfinished and ${liveSlots} slot(s) live — nothing is ticking`,
      remedy: 'start an engine with `sched start`',
    });
  }

  const staleClosed = new Set<number>();
  for (const entry of state.entries) {
    if (entry.stale_closed_at === null || TERMINAL_ISSUE_STATUSES.has(entry.status)) continue;
    staleClosed.add(entry.issue);
    const holder = state.slots.find(
      (s) => s.unit === `issue:${entry.issue}` && LIVE_SLOT_STATUSES.has(s.status)
    );
    warnings.push({
      kind: 'stale-closed',
      message: `issue #${entry.issue} is closed on GitHub but ${holder ? `slot ${holder.id} still holds it (${holder.status})` : 'its entry is still active'} — recovery will not re-dispatch it (flagged ${entry.stale_closed_at})`,
      remedy: `sched stop --issue ${entry.issue}`,
      issue: entry.issue,
      ...(holder ? { slot: holder.id } : {}),
    });
  }

  for (const slot of state.slots) {
    if (slot.unit === null || !LIVE_SLOT_STATUSES.has(slot.status)) continue;
    const issue = slot.unit.startsWith('issue:') ? Number(slot.unit.slice('issue:'.length)) : null;
    if (issue !== null && staleClosed.has(issue)) continue; // already named above
    const hours = hoursSince(slot.last_progress_at ?? slot.updated_at, nowMs);
    if (hours === null || hours <= thresholdHours) continue;
    warnings.push({
      kind: 'stuck-slot',
      message: `slot ${slot.id} has been ${slot.status} on ${slot.unit} with no progress for ${formatHours(hours)}`,
      remedy: `check the unit's issue, then \`${stopRemedy(slot.unit)}\` if its work is done or abandoned`,
      ...(issue !== null ? { issue } : {}),
      slot: slot.id,
    });
  }

  return warnings;
}

// --- #791: kept-worktree warning ---
//
// #768's `members-closed` reconcile keeps a `done` batch's worktree on disk
// (may hold unpushed operator work) but never surfaced it; this section adds
// that visibility, report-only. Deliberately a SEPARATE function from
// `buildStatusWarnings` above (which stays pure over state + lease + clock)
// since this one needs local git/fs reads — mirrors `anchorSweep`'s
// injectable, opt-in-by-omission shape in `buildStatusReport` below.
// `reconcileKeptWorktrees` (`batch-dispatch.ts`) clears the ledger fields on
// definitive evidence, so the warning does not persist forever.

/** One `done` batch's kept worktree (#791) — either the shared batch worktree or the current member's own. */
export interface KeptWorktreeCandidate {
  batch: string;
  /** Which `BatchEntry` field this candidate came from — `worktree` (shared) or `member_worktree` (current member, #677). */
  field: 'worktree' | 'member_worktree';
  path: string;
  poolClaimed: boolean;
}

/**
 * Every `done` batch whose `worktree` or `member_worktree` is still set in
 * the ledger (#791) — pure over state, exactly like `buildStatusWarnings`.
 * A candidate is skipped when its path is ALSO held by a non-`done` (still
 * in-flight) batch: a pool worktree the operator already returned can be
 * re-claimed by a fresh batch before the done batch's own ledger field is
 * cleared, and warning about a path a live batch is actively using is worse
 * than not warning at all — it tells the operator to remove/return a
 * worktree that is in use. Naturally bounded beyond that: only `done`
 * batches are considered, and in practice very few ever carry a kept
 * worktree (only the `members-closed` reconcile path leaves one).
 */
export function keptWorktreeCandidates(state: SchedState): KeptWorktreeCandidate[] {
  const inFlightPaths = new Set<string>();
  for (const batch of state.batches) {
    if (batch.status === 'done') continue;
    if (batch.worktree !== null) inFlightPaths.add(batch.worktree);
    if (batch.member_worktree !== null) inFlightPaths.add(batch.member_worktree);
  }

  const candidates: KeptWorktreeCandidate[] = [];
  for (const batch of state.batches) {
    if (batch.status !== 'done') continue;
    if (batch.worktree !== null && !inFlightPaths.has(batch.worktree)) {
      candidates.push({
        batch: batch.id,
        field: 'worktree',
        path: batch.worktree,
        poolClaimed: batch.pool_claimed,
      });
    }
    if (batch.member_worktree !== null && !inFlightPaths.has(batch.member_worktree)) {
      candidates.push({
        batch: batch.id,
        field: 'member_worktree',
        path: batch.member_worktree,
        poolClaimed: batch.member_pool_claimed,
      });
    }
  }
  return candidates;
}

/**
 * Local, read-only facts about a kept worktree (#791) — injectable so tests
 * never touch a real filesystem or spawn a real `git`. The default
 * implementation ({@link defaultKeptWorktreeReader}) is the only place that
 * runs a real command, and it runs at most three, all read-only: `git
 * rev-parse --show-toplevel` (containment check), `git --no-optional-locks
 * status --porcelain`, and `git log HEAD --not --remotes`. Nothing in this
 * package ever builds a `git worktree remove` / `worktree-pool return` argv
 * from this reader — the remedy text is a string for a human to run by hand.
 */
export interface KeptWorktreeReader {
  /** Whether `path` still exists on disk. */
  exists: (path: string) => boolean;
  /**
   * Whether `path` (an existing worktree) has uncommitted changes or
   * commits not on any remote branch. `true` = dirty/unpushed (unsafe to
   * remove), `false` = clean and fully pushed (safe to remove), `null` =
   * the check could not be trusted — the git probe itself failed (path not
   * a repo, git missing, timeout), OR `path` is no longer its own worktree
   * root (pruned, or reused by something else — see `defaultKeptWorktreeReader`)
   * — reported as `unknown`, never guessed.
   */
  hasLocalWork: (path: string) => boolean | null;
}

/**
 * The real {@link KeptWorktreeReader}: `exec`/`fsExists` follow the same
 * injectable conventions as the rest of the package (`project.ts`'s
 * `ExecFn`, `teardown.ts`'s `FsExists`) so the CLI wires in a real,
 * bounded-timeout `git`/`fs` and every test wires in a spy instead.
 */
export function defaultKeptWorktreeReader(
  exec: ExecFn,
  fsExists: FsExists = defaultFsExists
): KeptWorktreeReader {
  return {
    exists: fsExists,
    hasLocalWork: (worktreePath) => {
      // Containment: a kept path that is no longer its OWN worktree root —
      // pruned by `git worktree prune`, or its directory reused for
      // something else entirely — must never report the status of whatever
      // repo git happens to find by walking up from it (#791 supportability
      // review finding 3). `git rev-parse --show-toplevel` from inside a
      // non-worktree directory still finds an ENCLOSING repo (this one, if
      // the path is under it), so the toplevel must match `worktreePath`
      // itself, not merely resolve to something.
      const toplevel = exec('git', ['rev-parse', '--show-toplevel'], worktreePath);
      if (toplevel === null) return null;
      let resolvedTarget: string;
      let resolvedToplevel: string;
      try {
        resolvedTarget = fs.realpathSync(worktreePath);
        resolvedToplevel = fs.realpathSync(toplevel);
      } catch {
        return null;
      }
      if (resolvedTarget !== resolvedToplevel) return null;

      // `--no-optional-locks`: this worktree may be the operator's own
      // in-progress repair work (the entire reason #768 kept it) — a plain
      // `git status` can contend for `index.lock` with a concurrent `git
      // add`/`commit` there (#791 supportability review finding 4); the
      // read-only variant never takes it.
      const status = exec('git', ['--no-optional-locks', 'status', '--porcelain'], worktreePath);
      if (status === null) return null;
      if (status.trim().length > 0) return true;

      // Scoped to THIS worktree's own HEAD, not `--branches` (every local
      // branch in the shared repository, #791 supportability/maintainability
      // review): worktrees share refs, so `--branches` would mark a clean,
      // fully-pushed kept worktree "unsafe to remove" because of an
      // unrelated unpushed branch sitting in a completely different
      // worktree.
      const unpushed = exec(
        'git',
        ['log', 'HEAD', '--not', '--remotes', '--oneline'],
        worktreePath
      );
      if (unpushed === null) return null;
      return unpushed.trim().length > 0;
    },
  };
}

/** Shell-quote `s` for a copy-pasteable remedy command (#791 security review) — passthrough when already shell-safe. */
function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The `git worktree remove` / `worktree-pool return` remedy text for a
 * candidate — never executed here, only printed. The pool invocation is
 * built from `teardown.ts`'s own `POOL_BIN`/`POOL_ARGS_PREFIX` (the same
 * `npx -y @ai-dossier/worktree-pool@^0.7.0` pin teardown.ts actually runs),
 * not a hand-written `ai-dossier worktree-pool` string — that binary does
 * not exist (#791 DRY/documentation review).
 */
function keptWorktreeRemedy(candidate: KeptWorktreeCandidate): string {
  const path = shellQuote(candidate.path);
  return candidate.poolClaimed
    ? `${POOL_BIN} ${POOL_ARGS_PREFIX.join(' ')} return --path ${path}`
    : `git worktree remove ${path}`;
}

/** Per-run cap on how many kept-worktree candidates get probed with real git calls (#791 supportability review finding 7) — `sched status` must stay fast even with many leftovers. */
export const KEPT_WORKTREE_PROBE_LIMIT = 10;

/** One `{ kind: 'kept-worktree', ... }` warning — the shared literal shape every branch below returns (#791 maintainability review finding 5). */
function keptWorktreeWarning(
  candidate: KeptWorktreeCandidate,
  detail: string,
  remedy: string
): StatusWarning {
  const poolNote = candidate.poolClaimed ? ' (pool claim held indefinitely)' : '';
  return {
    kind: 'kept-worktree',
    message: `batch ${candidate.batch} is done but its ${candidate.field} ${candidate.path} is still held${poolNote} — ${detail}`,
    remedy,
    batch: candidate.batch,
  };
}

/**
 * Turn kept-worktree candidates into `StatusWarning`s (#791) — pure given
 * the reader, exactly like `buildStatusWarnings` is pure given the state
 * and lease. A reader call that throws is caught defensively (a hostile or
 * buggy injected reader must never crash `sched status`) and routed to the
 * SAME "could not be checked" outcome as a reader returning `null` — a
 * thrown `exists()` must never read as "gone", which would tell an operator
 * there is nothing left to do when the truth is simply unknown (#791
 * maintainability review finding 3).
 */
export function buildKeptWorktreeWarnings(
  candidates: KeptWorktreeCandidate[],
  reader: KeptWorktreeReader
): StatusWarning[] {
  const probed = candidates.slice(0, KEPT_WORKTREE_PROBE_LIMIT);
  const overflow = candidates.slice(KEPT_WORKTREE_PROBE_LIMIT);

  const warnings = probed.map((candidate) => {
    let exists: boolean;
    let existsChecked = true;
    try {
      exists = reader.exists(candidate.path);
    } catch {
      exists = false;
      existsChecked = false;
    }
    if (!existsChecked) {
      return keptWorktreeWarning(
        candidate,
        'whether the path still exists could not be checked',
        `inspect ${shellQuote(candidate.path)} manually — if it is gone, no cleanup is needed; if clear, \`${keptWorktreeRemedy(candidate)}\``
      );
    }
    if (!exists) {
      return keptWorktreeWarning(
        candidate,
        'the path no longer exists on disk — the engine clears this ledger entry automatically once it re-confirms on its next tick',
        candidate.poolClaimed
          ? 'no local cleanup needed for now — if this persists past the next tick, check `worktree-pool status` for the claim'
          : 'no local cleanup needed — the worktree is already gone'
      );
    }
    let hasLocalWork: boolean | null;
    try {
      hasLocalWork = reader.hasLocalWork(candidate.path);
    } catch {
      hasLocalWork = null;
    }
    const removeCmd = keptWorktreeRemedy(candidate);
    if (hasLocalWork === null) {
      return keptWorktreeWarning(
        candidate,
        'local git status could not be checked',
        `inspect ${shellQuote(candidate.path)} manually before removing (git probe failed) — if clear, \`${removeCmd}\``
      );
    }
    if (hasLocalWork) {
      return keptWorktreeWarning(
        candidate,
        'it has uncommitted changes or commits not on any remote branch',
        `commit/push first, then \`${removeCmd}\``
      );
    }
    return keptWorktreeWarning(candidate, 'it is clean and fully pushed', removeCmd);
  });

  for (const candidate of overflow) {
    warnings.push(
      keptWorktreeWarning(
        candidate,
        `not probed (over the ${KEPT_WORKTREE_PROBE_LIMIT}-candidate limit this run)`,
        're-run `sched status` after clearing some of the other kept worktrees, or inspect it manually'
      )
    );
  }

  return warnings;
}

export function buildStatusReport(
  state: SchedState,
  config: SchedConfig,
  project: string,
  engineLease: EngineLeaseStatus | null = null,
  now: Date = new Date(),
  /** #768: the opt-in anchor sweep's GitHub/git readers; omitted → `anchors: null`. */
  anchorSweep?: { read: IssueCloseReader; repo?: string; commitInBase?: CommitInBase },
  /** #791: the opt-in kept-worktree reader; omitted → no `kept-worktree` warnings (zero behavior change for every existing caller). */
  worktreeReader?: KeptWorktreeReader
): StatusReport {
  const blocked: BlockedItem[] = [];
  const failed: QueueEntry[] = [];
  const stopped: QueueEntry[] = [];
  const parkedMembers: ParkedMemberItem[] = [];

  const describeBlocker = (b: { dep: number; reason: string; depStatus?: string }): string =>
    b.reason === 'not-in-queue'
      ? `dependency #${b.dep} is not in the queue`
      : `dependency #${b.dep} not merged (status: ${b.depStatus ?? 'unknown'})`;

  for (const entry of state.entries) {
    if (entry.status === 'failed') {
      failed.push(entry);
      continue;
    }
    if (entry.status === 'stopped') {
      stopped.push(entry);
      continue;
    }
    if (entry.status === 'blocked' || entry.status === 'decision-pending') {
      blocked.push({
        issue: entry.issue,
        status: entry.status,
        reason: entry.reason ?? entry.status,
      });
      continue;
    }
    if (TERMINAL_ISSUE_STATUSES.has(entry.status) || SATISFIED_ISSUE_STATUSES.has(entry.status)) {
      continue;
    }
    if (PARKED_MEMBER_STATUSES.has(entry.status)) {
      parkedMembers.push(parkedMemberItem(entry));
      continue;
    }

    if (entry.mode === 'full') {
      if (DISPATCHABLE_ISSUE_STATUSES.has(entry.status)) {
        const blockers = dependencyBlockers(state, entry);
        if (blockers.length > 0) {
          blocked.push({
            issue: entry.issue,
            status: entry.status,
            reason: blockers.map(describeBlocker).join('; '),
          });
        }
      }
      continue;
    }

    // Slot mode: the member runs when its batch dispatches. Cross-batch /
    // external dependency blockers come from the batch's edge set.
    const batch = state.batches.find((b) => b.id === entry.batch);
    if (batch && batch.status !== 'forming' && batch.status !== 'dissolved') {
      const mine = batchBlockers(state, batch).filter((b) => b.issue === entry.issue);
      if (mine.length > 0) {
        blocked.push({
          issue: entry.issue,
          status: entry.status,
          reason: mine.map(describeBlocker).join('; '),
        });
      }
    }
  }

  // #583 AC4: a blocked BATCH (e.g. `gate-inconclusive`, or #562's
  // `suite-unreadable`) is otherwise invisible to `blocked` — every entry
  // above comes from `state.entries` (per-issue), and a blocked batch's
  // member entries stay `slot`-mode `executing`/whatever they were, not
  // `blocked`. Reuses `BlockedItem`'s shape so the CLI's existing
  // "== Blocked ==" renderer needs no changes; `anchor` is set by the time
  // any gate can block a batch (batch-setup already ran), so the `-1`
  // fallback is defensive, not expected in practice.
  for (const batch of state.batches) {
    if (batch.status !== 'blocked') continue;
    const validatedNote = dissolveRefusedNote(state, batch);
    blocked.push({
      issue: batch.anchor ?? batch.members[batch.executing_member - 1] ?? -1,
      status: 'batch-blocked',
      reason: `${batch.blocked_reason ?? 'unknown'}${validatedNote}`,
    });
  }

  const units = state.paused ? [] : runnableUnits(state);

  // #680: resolve the dispatch config the way the engine does, so the report
  // can never disagree with what actually spawns (`tierExecutors` is the one
  // conversion, shared with the startup banner).
  const resolved = resolveDispatch(config);
  // #707: every configured profile, resolved the way `dispatchFor` resolves
  // it for a batch — so the display can never disagree with what spawns.
  const profiles = Object.fromEntries(
    Object.keys(config.dispatch?.dispatch_profiles ?? {}).map((name) => [
      name,
      tierExecutors(resolveProfiledDispatch(config, name)),
    ])
  ) as Record<string, Record<ModelTier, TierExecutor>>;
  const dispatch = { tiers: tierExecutors(resolved), profiles };
  const profileSources = config.dispatch?.dispatch_profile_sources ?? {};

  const parked: ParkedItem[] = state.entries
    .filter((e): e is QueueEntry & { pr: number } => e.status === 'parked' && e.pr !== null)
    .map((e) => ({ issue: e.issue, pr: e.pr, since: e.updated_at }));

  return {
    project,
    paused: state.paused,
    max_slots: config.max_slots,
    live_slots: state.slots.filter((s) => LIVE_SLOT_STATUSES.has(s.status)).length,
    engine_lease: engineLease,
    queue: state.entries,
    slots: state.slots,
    // Read-side half of #595's dedupe: a `state.json` persisted before
    // `appendEvictions` shipped can still carry duplicate records for one
    // member, and this report backs both `sched status`'s table and its
    // `--json` output (raw `state.json` inspection still shows the legacy
    // duplicates — nothing rewrites them).
    batches: state.batches.map((b) => ({ ...b, evictions: distinctEvictions(b.evictions) })),
    parked,
    parked_members: parkedMembers,
    last_pr_poll_at: state.last_pr_poll_at,
    last_label_poll_at: state.last_label_poll_at,
    dispatch_health: {
      consecutive_suspect: state.consecutive_suspect_dispatches,
      last_suspect_unit: state.last_suspect_dispatch_unit,
      consecutive_api_errors: state.consecutive_dispatch_api_errors,
      pause_reset_at: state.dispatch_pause_reset_at,
    },
    last_tick_failure: state.last_tick_failure,
    runnable: units.length,
    runnable_units: units.map((u) =>
      u.kind === 'issue' ? `issue:${u.issue}` : `batch:${u.batch}`
    ),
    dispatch: { ...dispatch, profile_sources: profileSources },
    blocked,
    failed,
    stopped,
    warnings: [
      ...buildStatusWarnings(state, engineLease, now),
      // #791: omitted unless the caller supplies a reader — same opt-in-by-
      // omission shape as the anchor sweep below, so every pre-existing
      // caller/test sees zero behavior change.
      ...(worktreeReader !== undefined
        ? buildKeptWorktreeWarnings(keptWorktreeCandidates(state), worktreeReader)
        : []),
    ],
    anchors:
      anchorSweep !== undefined
        ? sweepAnchors(state, anchorSweep.read, {
            repo: anchorSweep.repo,
            commitInBase: anchorSweep.commitInBase,
          })
        : null,
  };
}
