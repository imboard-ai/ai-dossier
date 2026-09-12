/**
 * `sched status` report (AC4): queue, slots, batches, parked PRs, and the
 * blocked/failed sets as a machine-readable report. Text rendering lives in
 * the CLI (`cli/src/commands/sched.ts`, on top of the CLI's shared
 * `renderTable`) — the package deliberately has no dependency on CLI
 * utilities.
 */

import {
  resolveDispatch,
  resolveProfiledDispatch,
  type TierExecutor,
  tierExecutors,
} from './dispatch';
import {
  batchBlockers,
  DISPATCHABLE_ISSUE_STATUSES,
  dependencyBlockers,
  runnableUnits,
} from './readiness';
import { distinctEvictions } from './state';
import type {
  BatchEntry,
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

/** Machine-readable status report (`sched status --json`). */
export interface StatusReport {
  /** Project slug the report was built for (which state bucket this is). */
  project: string;
  paused: boolean;
  max_slots: number;
  live_slots: number;
  queue: QueueEntry[];
  slots: SlotEntry[];
  batches: BatchEntry[];
  /** Parked units being watched by the PR watcher (#468). */
  parked: ParkedItem[];
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
    profile_sources: Record<string, 'user' | 'project'>;
  };
  blocked: BlockedItem[];
  failed: QueueEntry[];
}

export function buildStatusReport(
  state: SchedState,
  config: SchedConfig,
  project: string
): StatusReport {
  const blocked: BlockedItem[] = [];
  const failed: QueueEntry[] = [];

  const describeBlocker = (b: { dep: number; reason: string; depStatus?: string }): string =>
    b.reason === 'not-in-queue'
      ? `dependency #${b.dep} is not in the queue`
      : `dependency #${b.dep} not merged (status: ${b.depStatus ?? 'unknown'})`;

  for (const entry of state.entries) {
    if (entry.status === 'failed') {
      failed.push(entry);
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
    blocked.push({
      issue: batch.anchor ?? batch.members[batch.executing_member - 1] ?? -1,
      status: 'batch-blocked',
      reason: batch.blocked_reason ?? 'unknown',
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
    queue: state.entries,
    slots: state.slots,
    // Read-side half of #595's dedupe: a `state.json` persisted before
    // `appendEvictions` shipped can still carry duplicate records for one
    // member, and this report backs both `sched status`'s table and its
    // `--json` output (raw `state.json` inspection still shows the legacy
    // duplicates — nothing rewrites them).
    batches: state.batches.map((b) => ({ ...b, evictions: distinctEvictions(b.evictions) })),
    parked,
    last_pr_poll_at: state.last_pr_poll_at,
    last_label_poll_at: state.last_label_poll_at,
    dispatch_health: {
      consecutive_suspect: state.consecutive_suspect_dispatches,
      last_suspect_unit: state.last_suspect_dispatch_unit,
      consecutive_api_errors: state.consecutive_dispatch_api_errors,
      pause_reset_at: state.dispatch_pause_reset_at,
    },
    runnable: units.length,
    runnable_units: units.map((u) =>
      u.kind === 'issue' ? `issue:${u.issue}` : `batch:${u.batch}`
    ),
    dispatch: { ...dispatch, profile_sources: profileSources },
    blocked,
    failed,
  };
}
