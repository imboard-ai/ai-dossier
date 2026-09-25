/**
 * `ai-dossier sched` — the deterministic scheduler core (RFC-0001 §C.1, issue #460).
 *
 * enqueue / status / pause / resume / abandon manage the queue and state
 * (#460); `sched start` runs the dispatch engine (#464: spawning agent
 * processes, verifying their completion against ground truth, mechanizing
 * the stall/escalation ladder) and since #468 also the detached-ship tail:
 * watching parked PRs, script-based teardown of merged worktrees, and the
 * cheap-tier report dispatch.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import * as path from 'node:path';
import type {
  AnchorMemberReport,
  AnchorReportItem,
  BatchDispatchDeps,
  BatchEntry,
  CapabilityGateResult,
  IssueCloseReader,
  OpenAnchorIssue,
  OpenAnchorLister,
  OrphanAnchorReportItem,
  SchedConfig,
  StatusReport,
  TickResult,
} from '@ai-dossier/sched';
import {
  abandonBatch,
  abandonIssue,
  attachBatchPr,
  batchAnchorStillOpen,
  buildBatchRunLogEntries,
  buildStatusReport,
  type CommitInBase,
  CorruptStateError,
  createExecFn,
  createExecGroundTruth,
  createExecResumeSeeder,
  createExecRunFencer,
  createSpawnDeps,
  DEFAULT_BATCH_PRIORITY,
  DEFAULT_ISSUE_PRIORITY,
  DEFAULT_RECONCILE_INTERVAL_MS,
  DISPATCH_PROFILE_RE,
  DispatchProfileError,
  defaultExec,
  defaultKeptWorktreeReader,
  dispatchSummary,
  type EngineDeps,
  EngineTooOldError,
  EnqueueError,
  type EnqueueInput,
  type ExecFn,
  enqueueEntries,
  FENCE_TIMEOUT_MS,
  findBatch,
  formatBatchStatus,
  GIT_OID_RE,
  IllegalTransitionError,
  isLandedResumableBlock,
  issueCloseReader,
  Journal,
  type KeptWorktreeReader,
  LIVE_SLOT_STATUSES,
  LockTimeoutError,
  labelBlockReason,
  labelOfBlockReason,
  MAX_FULL_REVIEW_MEMBERS,
  memberDispatchTier,
  OPENCODE_DISPATCH_COMMAND,
  ORPHAN_SWEEP_MAX_ANCHORS,
  orphanAnchorListArgs,
  parseManifest,
  readJsonl,
  recordTickFailure,
  reprioritizeBatch,
  reprioritizeIssue,
  requeueParkedMember,
  resolveDispatch,
  resolveProfiledDispatch,
  resolveProjectRepo,
  resolveProjectSlug,
  resumeBlockedGate,
  resumeLandedBatch,
  runLoop,
  SAFE_REF_RE,
  SchedNotFoundError,
  SchedStore,
  schedStateDir,
  schedTelemetryEnabled,
  setPaused,
  slotsForBatch,
  stopBatch,
  stopIssue,
  TEARDOWN_TIMEOUT_MS,
  TIER_ORDER,
  tick,
  tierExecutors,
  unitEvent,
} from '@ai-dossier/sched';
import { WARM_COMMAND_TIMEOUT_MS } from '@ai-dossier/worktree-pool';
import type { Command } from 'commander';
import {
  BATCH_SUITE_TIMEOUT_MS,
  batchGateRefusal,
  createBatchSuiteRunner,
} from '../batch-suite-runner';
import { envelopeFields, spawnCapRun } from '../cap-envelope';
import { loadCapabilityManifest, timeoutReasonSpent } from '../capability';
import { formatCost, formatCount } from '../cost-format';
import { detectDispatchProfile, type ProfileCandidate } from '../dispatch-detect';
import { formatAge, formatDurationMs } from '../duration';
import {
  checkEngineStaleness,
  type EngineStalenessCheck,
  formatEngineStaleWarning,
} from '../engine-version';
import {
  isIssueNumber,
  parseGhJson,
  requireRepoSlug,
  tryFetchComments,
  tryFetchLabels,
} from '../gh';
import { pickHardBlockLabel } from '../hard-block-labels';
import { detectLlm, fail } from '../helpers';
import { MAX_ISSUE_SELECTION, parseIssueSelection } from '../issue-selection';
import { findLatestPlan } from '../plan-artifact';
import { LOG_FILE as RUNS_LOG_FILE, readRunLog } from '../run-log';
import { hasSlotModeLatestMilestone } from '../runstate';
import { renderValue } from '../runstate-stats';
import {
  aggregateRunLogEntries,
  type BatchAmortizationSummary,
  type BatchJournalEvent,
  buildBatchAmortizationSummary,
  buildSchedCostReport,
  formatAmortizationLine,
  type IssueCost,
  summarizeBatchJournal,
} from '../sched-run-stats';
import { renderTable } from '../table';

/**
 * Batch-worktree `ai-dossier cap run <id>` runner for the per-member
 * incremental gate (#523 AC2). `cap run`'s `task-failed` outcome — a
 * legitimately failing test/typecheck — IS exit code 1, so the verdict comes
 * from the JSON envelope naming which of the four outcomes it was, read via
 * `spawnCapRun` (cli/src/cap-envelope.ts, #811): the dedicated envelope file
 * first, then a bottom-up stdout scan for the `cap_envelope` marker — and
 * only when the envelope's outcome agrees with `cap run`'s exit code. Reuses
 * the aggregate suite's timeout budget (`BATCH_SUITE_TIMEOUT_MS`) — both are
 * batch-worktree subprocess calls with no reason to disagree on how long is
 * too long.
 *
 * `output_tail` (#583 AC1/AC3) rides on the same envelope; when it is absent
 * the fallback is `spawnCapRun`'s captured stdout+stderr.
 */
export function createBatchCapabilityRunner(opts?: {
  /** Overridable so tests can exercise the ETIMEDOUT branch cheaply (mirrors `createBatchSuiteRunner`). */
  timeoutMs?: number;
}): (worktree: string, capabilityId: string) => CapabilityGateResult {
  const timeoutMs = opts?.timeoutMs ?? BATCH_SUITE_TIMEOUT_MS;
  return (worktree, capabilityId) => {
    const run = spawnCapRun(capabilityId, worktree, { timeoutMs });
    const result = run.spawned;
    // Captured subprocess output — the evidence fallback on every path below.
    const captured = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.error && !run.exitedWithVerdict) {
      // #681: this runner's OWN timeout (spawnSync's, `BATCH_SUITE_TIMEOUT_MS`)
      // must be distinguishable from a genuine machinery failure — before, it
      // collapsed into the evidence-free `{outcome: 'automation-broken'}`
      // below, byte-for-byte the #679 shape. Emit the same
      // `command timed out after <N>ms` reason `cli/src/capability.ts`'s
      // `classifySpawnResult` emits for its ETIMEDOUT, so the gate's
      // `isGateTimeout` classifier sees both timeout layers identically.
      // Any OTHER spawn error is a genuine machinery failure, which still
      // blocks (#583/#585) — with its code as the reason.
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === 'ETIMEDOUT') {
        return {
          outcome: 'automation-broken',
          reason: timeoutReasonSpent(timeoutMs),
          outputTail: captured || null,
        };
      }
      return {
        outcome: 'automation-broken',
        reason: `cap run ${capabilityId} spawn error ${code ?? result.error.message}`,
        outputTail: captured || null,
      };
    }
    if (run.envelope === null) {
      return {
        outcome: 'automation-broken',
        reason: `cap run ${capabilityId} exited ${result.status ?? 'unknown'} (signal ${result.signal ?? 'none'}) with no trusted envelope — ${run.diagnostics}`,
        outputTail: captured || null,
        durationMs: null,
      };
    }
    const fields = envelopeFields(run.envelope);
    // Fall back to the subprocess's own capture when the envelope omits
    // `output_tail` (a capability build predating #583, or a non-string
    // field). Passing `null` through would read as "nobody tried to capture
    // output" to `hasEarnedFailureEvidence`, which trusts the exit code in
    // that case — silently buying back the pre-#594 evict-on-any-
    // `task-failed` behaviour on the exact path #594 closes.
    const outputTail = fields.outputTail ?? (captured || null);
    // `reason` (#583 review) is the only explanation available when no
    // subprocess ran at all — `capability-unavailable`, or `automation-broken`
    // from a failed assumption probe — since `output_tail` is unset there.
    // `duration_ms` (#681) rides to `member_gates` — the gate's cost per
    // member, the raw material for per-change-shape savings reporting.
    // `spawnCapRun` only returns an envelope with a valid outcome.
    return {
      outcome: fields.outcome ?? 'automation-broken',
      outputTail,
      reason: fields.reason,
      durationMs: fields.durationMs,
    };
  };
}

interface SchedOptions {
  project?: string;
  json?: boolean;
}

interface EnqueueOptions extends SchedOptions {
  issues?: string;
  mode?: string;
  batch?: string;
  deps?: string;
  tier?: string;
  /** #771: review level for --issues slot members (light | full). */
  review?: string;
  fromManifest?: string;
  repo?: string;
  moreMembersExpected?: boolean;
  priority?: string;
  /** #603: bypass the slot-member plan:v1 pre-screen. */
  skipPlanCheck?: boolean;
  /** #707: the dispatch profile the batch records — overrides detection. */
  dispatch?: string;
}

interface AbandonOptions extends SchedOptions {
  issue?: string;
  batch?: string;
  reason?: string;
}

interface StopOptions extends SchedOptions {
  issue?: string;
  batch?: string;
  reason?: string;
}

interface ReprioritizeOptions extends SchedOptions {
  issue?: string;
  batch?: string;
  priority?: string;
}

interface StartOptions extends SchedOptions {
  interval?: number;
  once?: boolean;
  autoUpgrade?: boolean;
}

function parseMode(raw: string | undefined): 'full' | 'slot' {
  if (raw === undefined || raw === 'full') return 'full';
  if (raw === 'slot') return 'slot';
  fail([`--mode must be 'full' or 'slot', got '${raw}'`]);
}

function parseTier(raw: string | undefined): 'mechanical' | 'mid' | 'strong' {
  if (raw === undefined || raw === 'mid') return 'mid';
  if (raw === 'mechanical' || raw === 'strong') return raw;
  fail([`--tier must be mechanical | mid | strong, got '${raw}'`]);
}

/** `--review <level>` (#771): undefined when omitted, so full-mode entries carry none. */
function parseReview(raw: string | undefined): 'light' | 'full' | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'light' || raw === 'full') return raw;
  fail([`--review must be light | full, got '${raw}'`]);
}

/** `--priority <n>` (#565): any integer, undefined when the flag was omitted (the caller resolves the default). */
function parsePriority(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || String(n) !== raw.trim()) {
    fail([`--priority must be an integer, got '${raw}'`]);
  }
  return n;
}

/** Parse an issue selection (`4,5` or `4..9`), failing through the CLI's exit path. */
function issueList(raw: string, flag: string): number[] {
  try {
    return parseIssueSelection(raw);
  } catch (err) {
    fail([`--${flag}: ${(err as Error).message}`]);
  }
}

/**
 * Resolve the state store: explicit `--project`, else the repo's slug
 * (gh owner-repo, git toplevel basename fallback — fleet-cycle's convention).
 */
function resolveStore(opts: SchedOptions): { store: SchedStore; project: string } {
  const project = opts.project ?? resolveProjectSlug(defaultExec);
  if (!opts.project && project === 'default') {
    console.error(
      '⚠ Could not resolve a repo from the current directory — operating on the "default" state bucket. Run sched from the repo, or pass --project.'
    );
  }
  return { store: new SchedStore(schedStateDir(project)), project };
}

/** Route package errors through the CLI's exit path instead of a stack trace. */
function handleKnownError(err: unknown): never {
  if (
    err instanceof CorruptStateError ||
    err instanceof LockTimeoutError ||
    err instanceof EnqueueError ||
    err instanceof DispatchProfileError ||
    err instanceof IllegalTransitionError ||
    err instanceof SchedNotFoundError ||
    err instanceof EngineTooOldError
  ) {
    fail([err.message]);
  }
  throw err;
}

// --- status rendering (the CLI's shared table renderer, like every other
// table-printing command; the package deliberately has no CLI dependencies) ---

function renderReport(report: StatusReport, staleness?: EngineStalenessCheck): string {
  const lines: string[] = [];
  const state = report.paused ? 'PAUSED' : 'running';
  const runnable = report.runnable_units.length > 0 ? report.runnable_units.join(', ') : 'none';
  lines.push(
    `Scheduler [${report.project}]: ${state} · slots ${report.live_slots}/${report.max_slots} live`
  );
  if (report.engine_lease) {
    lines.push(
      `Engine lease: pid ${report.engine_lease.pid} (${report.engine_lease.alive ? 'live' : 'stale'})`
    );
  }
  if (report.last_tick_failure) {
    lines.push(
      `⚠ Last tick failed at ${report.last_tick_failure.at}: ${report.last_tick_failure.detail}`
    );
  }
  // #776/#791: health warnings (long pause, stale engine lease, stuck or
  // stale-closed slots, kept worktrees on done batches), each with the exact
  // remedy — near the top, where they cannot be missed under a long queue
  // table.
  for (const warning of report.warnings) {
    lines.push(`⚠ ${warning.message} → ${warning.remedy}`);
  }
  // #680: the configured executor, visible without reading the journal — an
  // operator driving a session from opencode/GLM sees here that every tier
  // still dispatches the default claude template (or that a mixed
  // `dispatch.tiers` ladder is in effect).
  lines.push(`Dispatch (default): ${dispatchSummary(report.dispatch.tiers, ' · ')}`);
  // #707: configured dispatch profiles, each named with the tier ladder it
  // will actually spawn — what a `--dispatch <name>` batch inherits. Which
  // batch uses which profile shows in the Batches table's profile column.
  for (const [name, tiers] of Object.entries(report.dispatch.profiles)) {
    const source = report.dispatch.profile_sources[name] ?? 'project';
    lines.push(`Profile ${name} (${source}): ${dispatchSummary(tiers, ' · ')}`);
  }
  if (staleness?.stale && staleness.installed !== null && staleness.latest !== null) {
    // #537: mirrors the dispatch-health block below — a status line, not a
    // block. `stale` is only ever true when both versions are known; the
    // null checks here are for TS, not reachable in practice.
    lines.push(formatEngineStaleWarning(staleness.installed, staleness.latest));
  }
  if (report.dispatch_health.consecutive_suspect > 0) {
    // `report.paused` alone can't prove dispatch-health caused it (a manual
    // `sched pause` looks identical), but a nonzero streak while paused is
    // always at least worth flagging as the likely cause; below that it's
    // purely informational — `sched resume` clears the streak (#505), so a
    // reading here always reflects activity since the last resume.
    const cause = report.paused
      ? '— likely why the scheduler is paused'
      : '— informational, below the auto-pause threshold';
    lines.push(
      `⚠ Dispatch health: ${report.dispatch_health.consecutive_suspect} consecutive suspect-dispatch exit(s) (last: ${report.dispatch_health.last_suspect_unit}) ${cause}`
    );
  }
  if (report.dispatch_health.consecutive_api_errors > 0) {
    // #629: a DIFFERENT signal from the suspect-dispatch block above — a
    // confirmed provider API error (a 429 spend/rate wall), not a timing
    // inference. Without this line a #629 pause reports `consecutive_suspect:
    // 0` and looks identical to a manual `sched pause`, which is the exact
    // ambiguity this counter exists to remove.
    const cause = report.paused
      ? '— likely why the scheduler is paused'
      : '— informational, below the auto-pause threshold';
    const resetNote = report.dispatch_health.pause_reset_at
      ? ` (provider reset at ${report.dispatch_health.pause_reset_at})`
      : '';
    lines.push(
      `⚠ Dispatch health: ${report.dispatch_health.consecutive_api_errors} consecutive confirmed dispatch failure(s) — a provider wall, not an agent exit${resetNote} ${cause}`
    );
  }
  lines.push(`Runnable units: ${runnable}`);
  lines.push('');
  lines.push('== Queue ==');
  lines.push(
    renderTable(
      [
        'issue',
        'mode',
        'batch',
        'profile',
        'priority',
        'tier',
        'review',
        'deps',
        'status',
        'pr',
        'cleanup',
      ],
      report.queue.map((e) => [
        `#${e.issue}`,
        e.mode,
        e.batch ?? '-',
        e.mode === 'full'
          ? (e.dispatch_profile ?? '-')
          : (report.batches.find((batch) => batch.id === e.batch)?.dispatch_profile ?? '-'),
        // A slot-mode member's own priority is never read by the scheduler
        // (the BATCH's priority governs, in the table below) — render '-'
        // rather than a number that looks load-bearing but is not.
        e.mode === 'slot' ? '-' : String(e.priority),
        // #771: a review=full member dispatches at `strong` minimum — show the
        // floor rather than a manifest tier that is not what actually spawns.
        e.mode === 'slot' && memberDispatchTier(e) !== e.tier
          ? `${e.tier}→${memberDispatchTier(e)}`
          : e.tier,
        // Review level is a slot-member concept; a full cycle always reviews fully.
        e.mode === 'slot' ? (e.review ?? 'light') : '-',
        e.deps.length > 0 ? e.deps.map((d) => `#${d}`).join(',') : '-',
        e.status,
        e.pr !== null && e.pr !== undefined ? String(e.pr) : '-',
        e.cleanup ?? '-',
      ])
    )
  );
  lines.push('');
  if (report.parked.length > 0) {
    const lastPoll = report.last_pr_poll_at
      ? `; last poll ${relativeTime(report.last_pr_poll_at)}`
      : '; never polled';
    lines.push(`== Parked PRs (watched, zero slots${lastPoll}) ==`);
    lines.push(
      report.parked
        .map((p) => `#${p.issue} — PR #${p.pr} (parked ${relativeTime(p.since)})`)
        .join('\n')
    );
    lines.push('');
  }
  // #810: parked batch members — never auto-dispatched; each row carries
  // the exact remedy commands. Tolerates a report from an older package.
  const parkedMembers = report.parked_members ?? [];
  if (parkedMembers.length > 0) {
    lines.push('== Parked members (evicted / handed back — waiting on an operator) ==');
    for (const p of parkedMembers) {
      lines.push(
        `#${p.issue} [${p.kind}] batch ${p.batch ?? '-'} — ${p.reason}; branch ${p.branch ?? '-'}; profile ${p.dispatch_profile ?? 'default'} (parked ${relativeTime(p.since)})`
      );
      lines.push(`    ${p.note}`);
      for (const remedy of p.remedies) lines.push(`    → ${remedy}`);
    }
    lines.push('');
  }
  lines.push('== Slots ==');
  lines.push(
    report.slots.length === 0
      ? '(no slots materialized yet)'
      : renderTable(
          [
            'slot',
            'status',
            'unit',
            'pid',
            'role',
            'phase',
            'last-progress',
            'recoveries',
            // #504: "is this slot a takeover, and is it under the short fence watch
            // rather than its phase allowance?" is the first question anyone asks when
            // debugging a refused post or a slot that recovered twice in half an hour.
            'gen',
            'fenced',
          ],
          report.slots.map((s) => [
            String(s.id),
            s.status,
            s.unit ?? '-',
            s.pid !== null ? String(s.pid) : '-',
            s.role,
            s.phase ?? '-',
            s.last_progress_at !== null ? relativeTime(s.last_progress_at) : '-',
            String(s.recoveries),
            s.gen > 0 ? String(s.gen) : '-',
            s.fenced_at !== null ? relativeTime(s.fenced_at) : '-',
          ])
        )
  );
  lines.push('');
  lines.push('== Batches ==');
  lines.push(
    report.batches.length === 0
      ? '(no batches)'
      : renderTable(
          [
            'batch',
            'status',
            'priority',
            'members',
            'member-in-work',
            'anchor',
            'worktree',
            'profile',
            'evictions',
            'pr',
          ],
          report.batches.map((b) => [
            b.id,
            formatBatchStatus(b),
            String(b.priority),
            b.members.length > 0 ? b.members.map((m) => `#${m}`).join(',') : '-',
            // #809: a parallel batch has no single member in work — summarize its runs.
            b.member_dispatch === 'parallel'
              ? parallelMemberSummary(b.member_runs, b.members.length)
              : b.executing_member > 0
                ? `${b.executing_member}/${b.members.length}`
                : '-',
            b.anchor !== null ? `#${b.anchor}` : '-',
            b.worktree ?? '-',
            // #707: the dispatch family this batch recorded at enqueue —
            // `-` = the config's default profile.
            b.dispatch_profile ?? '-',
            // #810: a hand-back is marked apart from an eviction — only
            // evictions count toward the dissolve threshold.
            b.evictions.length > 0
              ? b.evictions
                  .map((e) =>
                    e.kind === 'handed-back'
                      ? `#${e.issue}(handed-back:${e.reason})`
                      : `#${e.issue}(${e.reason})`
                  )
                  .join(',')
              : '-',
            b.pr !== null ? `#${b.pr}` : '-',
          ])
        )
  );
  lines.push('');
  lines.push('== Blocked ==');
  // #544: label-blocked entries are re-checked by the engine each tick, so say
  // when it last looked — "the label is still there" reads very differently
  // from "the engine has not looked since you removed it". Its own line, not
  // part of the `== X ==` delimiter (every section header here is a fixed
  // marker things grep for), and only when a LABEL block is actually present:
  // a dependency block or `auto-merge-blocked` has nothing to do with labels.
  if (report.blocked.some((b) => labelOfBlockReason(b.reason) !== null)) {
    lines.push(
      report.last_label_poll_at
        ? `(labels last checked ${relativeTime(report.last_label_poll_at)})`
        : '(labels never checked)'
    );
  }
  lines.push(
    report.blocked.length > 0
      ? report.blocked
          .map(
            (b) =>
              `#${b.issue} [${b.status}] — ${b.reason}` +
              (b.reason === 'suite-unreadable'
                ? '; current exit: sched abandon --batch <batch-id> (dissolves the batch and requeues its members as full-cycle work)'
                : '')
          )
          .join('\n')
      : '(none)'
  );
  lines.push('');
  lines.push('== Failed ==');
  lines.push(
    report.failed.length > 0
      ? report.failed.map((f) => `#${f.issue} — ${f.reason ?? f.status}`).join('\n')
      : '(none)'
  );
  lines.push('');
  lines.push('== Stopped ==');
  const stopped = report.stopped ?? [];
  lines.push(
    stopped.length > 0
      ? stopped.map((entry) => `#${entry.issue} — ${entry.reason ?? entry.status}`).join('\n')
      : '(none)'
  );
  // #768: report-only anchor sweep — never closes anything. Omitted entirely
  // when the report was built without GitHub (`--no-anchors`).
  if (report.anchors !== null) {
    lines.push('');
    lines.push('== Open batch anchors ==');
    lines.push(
      report.anchors.length > 0 ? report.anchors.map(renderAnchorItem).join('\n') : '(none)'
    );
  }
  // #790: the GitHub-side orphan sweep — anchors whose batch fell out of
  // `state.batches` entirely, so the ledger sweep above never saw them.
  // Report-only, same as above. Gated on `anchors !== null` (repo verified,
  // `--anchors` asked for) rather than `orphan_anchors !== null` directly:
  // `orphan_anchors` is `null` BOTH when the sweep was never asked for and
  // when it ran but the GitHub list call itself failed — those two must not
  // render identically, or a failed check looks exactly like a clean one.
  if (report.anchors !== null) {
    lines.push('');
    lines.push('== Orphaned batch anchors (not in ledger) ==');
    if (report.orphan_anchors === null) {
      lines.push('(unavailable — could not list batch-epic anchors; see the warning above)');
    } else {
      lines.push(
        report.orphan_anchors.length > 0
          ? report.orphan_anchors.map(renderOrphanAnchorItem).join('\n')
          : '(none)'
      );
      // #790 review: a cap that silently drops candidates reads as a clean,
      // complete sweep on a busy repo where it is neither — say so.
      if (report.orphan_anchors_truncated) {
        lines.push(
          `(list truncated at ${ORPHAN_SWEEP_MAX_ANCHORS} classified — more open batch-epic anchors exist beyond what is shown above)`
        );
      }
    }
  }
  return lines.join('\n');
}

/** Per-call budget for the sweep's reads — `status` must never hang for minutes. */
const ANCHOR_SWEEP_TIMEOUT_MS = 10_000;

/**
 * How many open `batch-epic` anchors the orphan lister fetches from GitHub —
 * deliberately larger than `ORPHAN_SWEEP_MAX_ANCHORS` (the classification
 * cap): `gh issue list` returns newest first, and ledger-tracked anchors are
 * excluded from the fetched set before the classification cap is applied
 * (`sweepOrphanAnchors`), so fetching only the classification cap's worth
 * would let a busy repo's tracked anchors crowd real orphans out before
 * exclusion ever runs. Still bounded — a single `gh` call, not one per
 * anchor.
 */
const ORPHAN_LIST_FETCH_LIMIT = 100;

/**
 * `sched status --anchors`' GitHub-side lister for the #790 orphan sweep:
 * every open `batch-epic` anchor issue in `repo`, or `undefined` on a failed
 * read (a non-zero `gh` exit, or output that does not parse as the requested
 * shape) — the orphan sweep then reports nothing rather than guess. The raw
 * fetch asks for more than `ORPHAN_SWEEP_MAX_ANCHORS` (`gh` lists newest
 * first): a busy repo can have that many ledger-TRACKED anchors open too,
 * and `sweepOrphanAnchors` excludes those before applying the classification
 * cap — fetching only exactly the cap would let tracked anchors crowd real
 * orphans out before exclusion ever runs. `sweepOrphanAnchors`'s `.slice()`
 * is the belt-and-braces cap on the classified count either way.
 */
function orphanAnchorListerFor(repo: string, exec: ExecFn): OpenAnchorLister {
  return () => {
    // #790 review: the argv is built by the exported `orphanAnchorListArgs`
    // (packages/sched) — the same function this package's own tests drive —
    // rather than a copy, so a change here is covered by those tests too.
    const raw = exec('gh', orphanAnchorListArgs(repo, ORPHAN_LIST_FETCH_LIMIT), process.cwd());
    if (raw === null) return undefined;
    const parsed = parseGhJson<unknown>(raw);
    if (!Array.isArray(parsed)) return undefined;
    const issues: OpenAnchorIssue[] = [];
    for (const item of parsed) {
      if (
        typeof item !== 'object' ||
        item === null ||
        typeof (item as { number?: unknown }).number !== 'number' ||
        typeof (item as { title?: unknown }).title !== 'string' ||
        typeof (item as { body?: unknown }).body !== 'string'
      ) {
        return undefined; // malformed row — say nothing rather than guess
      }
      const row = item as { number: number; title: string; body: string };
      issues.push({ number: row.number, title: row.title, body: row.body });
    }
    return issues;
  };
}

/**
 * `sched status --anchors`' readers (#768), or `undefined` (with a stderr
 * line naming `context`) when the cwd is not `project`'s repository — the
 * sweep never reads another repository's issue numbers as if they were this
 * project's. `context` labels the stderr line with the command that asked
 * (`sched status` vs `sched abandon`, #790) — reusing one function for both
 * must not print a `sched status` line while `sched abandon` is running.
 */
function anchorReaderFor(
  project: string,
  context: string
): { read: IssueCloseReader; repo: string; commitInBase: CommitInBase; exec: ExecFn } | undefined {
  // #790 review (supportability): `resolveProjectRepo` used to run through
  // the untimed `defaultExec` — `sched abandon --batch` previously made no
  // network calls at all, so this path could hang past the abandon itself
  // on an unresponsive `gh`. Build the timed exec FIRST and use it for the
  // repo check too, so every call this function makes shares the same
  // bound.
  const exec = createExecFn(ANCHOR_SWEEP_TIMEOUT_MS, {
    onError: (file, args, err) =>
      process.stderr.write(`⚠ ${context}: '${file} ${args.join(' ')}' failed: ${err.message}\n`),
  });
  const repo = resolveProjectRepo(project, exec);
  if (repo === null) {
    process.stderr.write(
      `⚠ ${context}: anchor check skipped — the current directory is not ${project}'s GitHub repository\n`
    );
    return undefined;
  }
  const read = issueCloseReader(createExecGroundTruth(exec, { repoDir: process.cwd(), repo }));
  if (read === undefined) return undefined;
  return {
    read,
    repo,
    exec,
    // Read-only reachability probe against the already-fetched remote ref.
    commitInBase: (oid, base) =>
      GIT_OID_RE.test(oid) &&
      SAFE_REF_RE.test(base) &&
      exec('git', ['merge-base', '--is-ancestor', oid, `origin/${base}`], process.cwd()) !== null,
  };
}

/** `sched status --anchors`' full readers (#768) plus the #790 orphan lister — built on {@link anchorReaderFor}. */
function anchorSweepFor(project: string): Parameters<typeof buildStatusReport>[5] {
  const reader = anchorReaderFor(project, 'sched status');
  if (reader === undefined) return undefined;
  return {
    read: reader.read,
    repo: reader.repo,
    commitInBase: reader.commitInBase,
    orphanList: orphanAnchorListerFor(reader.repo, reader.exec),
  };
}

/**
 * An `ExecFn` that reports its own failures to stderr with `label` — the same
 * `createExecFn(timeout, { onError: ... })` shape used at every other
 * subprocess call site in this file (`anchorSweepFor`, the teardown/fence/
 * batch-warm execs in `registerStartSubcommand`), pulled out once so a new
 * caller (#791's `keptWorktreeReaderFor`) does not add an eighth copy.
 */
function labelledExecFn(label: string, timeoutMs: number): ExecFn {
  return createExecFn(timeoutMs, {
    onError: (file, args, err) =>
      process.stderr.write(`⚠ ${label}: '${file} ${args.join(' ')}' failed: ${err.message}\n`),
  });
}

/** Per-call budget for #791's kept-worktree probes — local-only, but bounded so `status` never hangs on a wedged worktree. */
const KEPT_WORKTREE_TIMEOUT_MS = 5_000;

/**
 * `sched status`'s #791 kept-worktree reader — local `git status --porcelain`
 * / `git log HEAD --not --remotes` only, no network and no `gh` call, so
 * (unlike `--anchors`) it runs by default, not behind a flag.
 */
function keptWorktreeReaderFor(): KeptWorktreeReader {
  return defaultKeptWorktreeReader(
    labelledExecFn('sched kept-worktree check', KEPT_WORKTREE_TIMEOUT_MS)
  );
}

/**
 * The row shape shared by {@link renderAnchorItem} and
 * {@link renderOrphanAnchorItem} (#830): `<head> [<verdict>]<reasonsSuffix>`,
 * then the members line. Each caller builds `reasonsSuffix` itself rather
 * than this helper doing it — the ledger sweep's `reasons` are
 * operator-controlled and printed as-is, while the orphan sweep's are
 * sanitized (`renderValue`, #790 security review), and that distinction must
 * not blur into one shared implementation.
 */
function renderAnchorRow(
  head: string,
  verdict: string,
  reasonsSuffix: string,
  members: AnchorMemberReport[]
): string {
  return `${head} [${verdict}]${reasonsSuffix}\n  members: ${members.map(renderAnchorMember).join(', ')}`;
}

/** One `== Open batch anchors ==` row (#768): the anchor, its verdict and why, then its members. */
function renderAnchorItem(a: AnchorReportItem): string {
  const reasons = a.reasons.length > 0 ? ` — ${a.reasons.join(', ')}` : '';
  return renderAnchorRow(
    `#${a.anchor} (batch ${a.batch}, ${a.batch_status})`,
    a.verdict,
    reasons,
    a.members
  );
}

/**
 * One `== Orphaned batch anchors (not in ledger) ==` row (#790): report-only,
 * same shape as {@link renderAnchorItem} minus the ledger's own batch
 * id/status (there is none). The title and every reason are sanitized
 * (`renderValue`) before printing: unlike the ledger sweep's `batch`/`reason`
 * strings (operator-controlled, from `sched enqueue`), this row's `title`
 * and any `base_branch`-derived reason both come from the anchor's own
 * GitHub issue body/title — editable by anyone with issue-edit rights on the
 * pinned repo, so a raw ANSI/C1 escape in either could repaint or erase
 * terminal rows (#790 security review).
 */
function renderOrphanAnchorItem(a: OrphanAnchorReportItem): string {
  const reasons = a.reasons.length > 0 ? ` — ${a.reasons.map(renderValue).join(', ')}` : '';
  return renderAnchorRow(`#${a.anchor} "${renderValue(a.title)}"`, a.verdict, reasons, a.members);
}

/** `#4146 CLOSED/COMPLETED (ledger in-work)` — GitHub state beside the ledger's. */
function renderAnchorMember(m: AnchorMemberReport): string {
  const github = m.state_reason ? `${m.github}/${m.state_reason}` : m.github;
  return `#${m.issue} ${github} (ledger ${m.ledger_status ?? 'none'})`;
}

/** `5m ago` / `2h ago` — compact last-progress rendering for the slot table. */
function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '-';
  return formatAge(Math.max(0, now - then), ' ago');
}

// --- enqueue-time label pre-screen (#507) ---
//
// `HARD_BLOCK_LABELS` / `pickHardBlockLabel` moved to `../hard-block-labels`
// (#538) so the classify-time pre-screen can reuse the same policy list
// without duplicating it — see that file for the label list and the
// `decision-pending`-is-a-label-not-an-IssueStatus warning. Enqueueing a
// hard-blocked issue anyway just re-burns the same block a dispatched agent
// (and the escalation ladder behind it) would rediscover on its own;
// checking here costs one `gh` call instead of a slot-hour. A labelled
// issue lands as `status: 'blocked'` with a `label:` reason, same as the
// other three; see the comment on `enqueue.ts`'s status assignment for why.

/**
 * Mutate `inputs` in place, setting `blocked_label` on any issue that
 * already carries a hard-block label. Fails open on a `gh` lookup failure
 * (network, auth, rate limit, an issue number too large to be a real gh
 * argument) — enqueue must never hard-fail because a nice-to-have check
 * could not run; the issue is enqueued as `queued`, same as before #507.
 * Returns the issues whose lookup failed, so the caller can journal and
 * report them — an empty `blocked_by_label` must not read the same as "all
 * clean" when it actually means "the screen didn't run".
 *
 * Screened outside the store lock (no network I/O while holding it) but
 * before `enqueueEntries` validates the batch, so a manifest validation
 * will reject still pays the lookup cost — enqueue is not a hot path
 * (human/script-triggered, not per-dispatch), so this is accepted; a
 * repeated issue number is looked up once via the cache below.
 */
function screenHardBlockLabels(inputs: EnqueueInput[], repo?: string): number[] {
  const cache = new Map<number, string | null>();
  const failed: number[] = [];
  for (const input of inputs) {
    if (!cache.has(input.issue)) {
      if (!Number.isSafeInteger(input.issue)) {
        console.error(
          `⚠ Issue ${input.issue} is not a safe integer — skipping the label pre-screen. Enqueuing #${input.issue} normally.`
        );
        failed.push(input.issue);
        cache.set(input.issue, null);
      } else {
        const result = tryFetchLabels(String(input.issue), repo);
        if (!result.ok) {
          console.error(
            `⚠ ${result.error}\n  Enqueuing #${input.issue} normally (label pre-screen skipped).`
          );
          failed.push(input.issue);
          cache.set(input.issue, null);
        } else {
          cache.set(input.issue, pickHardBlockLabel(result.labels));
        }
      }
    }
    const hit = cache.get(input.issue) ?? null;
    if (hit) input.blocked_label = hit;
  }
  return failed;
}

/**
 * #603 / #616: refuse to seal a `mode=slot` batch whose members cannot satisfy
 * `slot-cycle` Step 0. Six preconditions are asserted there; four are the
 * scheduler's own doing and always hold by the time a member spawns. The two
 * that preparation owes every member are pure reads, and both are checked here:
 *
 *   5. a `plan:v1` artifact on the issue                       (#603)
 *   6. a classify record — the LATEST milestone carries `mode=slot`  (#616)
 *
 * A member missing either ALWAYS posts `blocked` at Step 0 and hands back.
 * Everything between here and that discovery — seal, anchor bind, `git
 * worktree add`, a full dependency warm, the member spawn — is
 * knowable-in-advance waste, and once enough members hand back the batch
 * dissolves and requeues all of them at full-cycle cost.
 *
 * Observed, not hypothesized. Batch `b-20260906-01` (anchor #600) spent a
 * 30-second cold warm and two member dispatches rediscovering precondition 5;
 * `b-20260906-04` (anchor #614) lost two of four members to precondition 6 the
 * same day, with valid plans on every one of them.
 *
 * Both checks share ONE `gh` call per issue: the comment list already fetched
 * for the plan carries the runstate milestones too. Precondition 6 accepts
 * either form `slot-cycle` accepts — a `phase=classify` record OR any prior
 * slot-mode milestone (a crash-restart re-dispatch or re-batch resumes on the
 * latter) — so a legitimate re-dispatch is never rejected.
 *
 * Unlike `screenHardBlockLabels`, a missing precondition is a HARD failure
 * rather than a `blocked` entry: a hard-block label is a state the issue may
 * leave on its own (#553 re-evaluates each tick), whereas a member missing a
 * plan or a classify record can never become runnable inside the batch. A
 * failed LOOKUP still fails open, on the same reasoning as the label screen —
 * enqueue must never hard-fail because a nice-to-have check could not run.
 *
 * `--skip-plan-check` escapes both. Only `mode=slot` inputs are screened: a
 * `full` entry runs `full-cycle-issue`, which plans for itself.
 */
function screenSlotPreconditions(inputs: EnqueueInput[], repo?: string): void {
  const noPlan: number[] = [];
  const noClassify: number[] = [];
  const checked = new Map<number, { plan: boolean; classify: boolean }>();
  for (const input of inputs) {
    if ((input.mode ?? 'full') !== 'slot') continue;
    if (!checked.has(input.issue)) {
      if (!Number.isSafeInteger(input.issue)) {
        console.error(
          `⚠ Issue ${input.issue} is not a safe integer — skipping the slot pre-screen.`
        );
        checked.set(input.issue, { plan: true, classify: true });
      } else {
        const result = tryFetchComments(String(input.issue), repo);
        if (!result.ok) {
          console.error(
            `⚠ ${result.error}\n  Enqueuing #${input.issue} normally (slot pre-screen skipped).`
          );
          checked.set(input.issue, { plan: true, classify: true });
        } else {
          const bodies = result.comments.map((c) => (typeof c?.body === 'string' ? c.body : ''));
          checked.set(input.issue, {
            plan: findLatestPlan(bodies) !== null,
            classify: hasSlotModeLatestMilestone(bodies),
          });
        }
      }
    }
    const verdict = checked.get(input.issue);
    if (verdict?.plan === false) noPlan.push(input.issue);
    if (verdict?.classify === false) noClassify.push(input.issue);
  }
  if (noPlan.length === 0 && noClassify.length === 0) return;
  const lines: string[] = [
    'Cannot enqueue as batch members — slot-cycle Step 0 would reject them.',
    '',
  ];
  if (noPlan.length > 0) {
    lines.push(
      `  no plan:v1 artifact:  ${noPlan.map((n) => `#${n}`).join(', ')}  → reason=no-plan-artifact`
    );
  }
  if (noClassify.length > 0) {
    lines.push(
      `  no classify record:   ${noClassify.map((n) => `#${n}`).join(', ')}  → reason=no-classify-record`
    );
  }
  lines.push(
    '',
    'Fix (either):',
    '  ai-dossier run imboard-ai/git/batch-issues-preparation   # composes the cohort AND posts BOTH artifacts',
    '  ai-dossier plan post --issue <n> --file <plan.md>        # the plan, per issue',
    '  ai-dossier run imboard-ai/git/issue-cycle-classifier     # the classify record, per issue',
    '',
    'Override with --skip-plan-check if both are posted between enqueue and dispatch.'
  );
  fail([lines.join('\n')]);
}

/**
 * #777: refuse to CREATE a batch in a repo whose only full gate declares
 * itself timeout-prone (see `batchGateRefusal`). Reads the capability
 * manifest of the directory `enqueue` runs in — skipped when `--repo` names
 * the GitHub repo explicitly (the flag exists for enqueueing into a project
 * whose checkout is NOT the cwd, so the cwd's manifest would be the wrong
 * one), and degrade-not-crash on a malformed manifest (`cap run` reports that
 * itself at gate time). Only batches this call creates are screened: a
 * member joining an existing batch cannot un-form it.
 */
function screenBatchGate(store: SchedStore, opts: EnqueueOptions, inputs: EnqueueInput[]): void {
  if (opts.repo !== undefined) return;
  const existing = new Set(store.load().batches.map((b) => b.id));
  const born = [
    ...new Set(
      inputs
        .filter((input) => (input.mode ?? 'full') === 'slot' && input.batch != null)
        .map((input) => input.batch as string)
        .filter((id) => !existing.has(id))
    ),
  ];
  if (born.length === 0) return;
  let refusal: string | null;
  try {
    refusal = batchGateRefusal(loadCapabilityManifest(process.cwd()));
  } catch {
    return;
  }
  if (refusal === null) return;
  fail([`Cannot form batch ${born.join(', ')}: ${refusal}`]);
}

/** Append one `label-blocked`/`label-check-failed` journal event per outcome (#507 AC3). */
function journalLabelScreen(store: SchedStore, blocked: EnqueueInput[], failed: number[]): void {
  if (blocked.length === 0 && failed.length === 0) return;
  const journal = new Journal(store.dir);
  for (const input of blocked) {
    journal.append(
      unitEvent('label-blocked', `issue:${input.issue}`, {
        reason: labelBlockReason(input.blocked_label as string),
      })
    );
  }
  for (const issue of failed) {
    journal.append(
      unitEvent('label-check-failed', `issue:${issue}`, {
        reason: 'gh lookup failed — enqueued unscreened',
      })
    );
  }
}

/**
 * Resolve the dispatch profile each enqueue records (#707/#713), mutating
 * inputs in place. Explicit is the mechanism, detection the
 * convenience (#707):
 *
 * - `--dispatch <name>` wins outright — validated against the project's
 *   configured `dispatch_profiles` (a typo must fail here, naming the
 *   available profiles, never silently enqueue the default).
 * - No flag + profiles configured → detect (CLAUDECODE / parent-chain) and
 *   print the verdict WITH its method.
 * - No flag + profiles configured + detection inconclusive → FAIL naming the
 *   available profiles. The silent fallback to the configured default is
 *   exactly what produced #680 (a run that looked like an open-weights arm,
 *   executed as the Claude arm).
 * - No profiles configured → nothing to inherit; behavior is byte-identical
 *   to pre-#707 (AC1). A `--dispatch` value here is an error, not a no-op.
 *
 * Detection/refusal only applies to batches this call CREATES — an
 * incremental join (`--more-members-expected`) to a batch whose family is
 * already recorded (or deliberately default) has nothing left to decide.
 * Applied to flag-built AND manifest entries; a manifest entry's own
 * `dispatch` field wins per entry, and a cross-entry conflict is rejected by
 * `assertBatchFactsAgree` rather than silently resolved.
 */
function resolveEnqueueDispatchProfile(
  store: SchedStore,
  opts: EnqueueOptions,
  inputs: EnqueueInput[]
): void {
  const config = store.loadConfig();
  const profiles = config.dispatch?.dispatch_profiles ?? {};
  const names = Object.keys(profiles).sort();
  const slotInputs = inputs.filter((input) => (input.mode ?? 'full') === 'slot');
  const manifestProfilesByBatch = new Map<string, Set<string>>();
  for (const input of inputs) {
    if (input.dispatch === undefined) continue;
    if (!DISPATCH_PROFILE_RE.test(input.dispatch)) {
      fail([`manifest dispatch must match ${DISPATCH_PROFILE_RE}, got '${input.dispatch}'`]);
    }
    if (names.length === 0) {
      fail([
        `manifest dispatch '${input.dispatch}' was given, but no dispatch_profiles are configured for this project`,
      ]);
    }
    if (!names.includes(input.dispatch)) {
      fail([
        `manifest dispatch '${input.dispatch}' is not a configured profile — available: ${names.join(', ')}`,
      ]);
    }
    if (input.batch !== undefined && input.batch !== null) {
      const batchProfiles = manifestProfilesByBatch.get(input.batch) ?? new Set<string>();
      batchProfiles.add(input.dispatch);
      manifestProfilesByBatch.set(input.batch, batchProfiles);
    }
  }

  if (opts.dispatch !== undefined) {
    if (!DISPATCH_PROFILE_RE.test(opts.dispatch)) {
      fail([`--dispatch must match ${DISPATCH_PROFILE_RE}, got '${opts.dispatch}'`]);
    }
    if (names.length === 0) {
      fail([
        `--dispatch '${opts.dispatch}' was given, but no dispatch_profiles are configured for this project`,
        '',
        'Fix: add them to the sched config, e.g.',
        '  { "dispatch": { "dispatch_profiles": {',
        '    "claude": { "command": ["claude","-p","--output-format","json","--model","{model}"], "tier_models": { "mechanical": "haiku", "mid": "sonnet", "strong": "opus" } },',
        '    "glm":    { "command": ["opencode","run","-m","{model}","--format","json","--"], "tier_models": { "mechanical": "zai-coding-plan/glm-5.3-flash", "mid": "zai-coding-plan/glm-5.3", "strong": "zai-coding-plan/glm-5.2" } }',
        '  } } }',
      ]);
    }
    if (!names.includes(opts.dispatch)) {
      fail([
        `--dispatch '${opts.dispatch}' is not a configured profile — available: ${names.join(', ')}`,
      ]);
    }
    for (const input of inputs) {
      if (input.dispatch === undefined) input.dispatch = opts.dispatch;
    }
    (opts.json ? console.error : console.log)(`Dispatch profile: ${opts.dispatch} (explicit)`);
    return;
  }

  if (names.length === 0) return; // AC1: no profiles configured — legacy behavior, unchanged.
  // Only batches this call CREATES need their family decided now. A manifest
  // that already names a valid profile made that decision at composition time;
  // never replace it with (or reject it for lack of) ambient detection.
  const existingBatches = new Set(store.load().batches.map((b) => b.id));
  const bornBatches = new Set(
    slotInputs
      .filter((input) => input.batch != null && !existingBatches.has(input.batch))
      .map((input) => input.batch as string)
  );
  const undecidedBornBatches = new Set(
    [...bornBatches].filter((batchId) => !manifestProfilesByBatch.has(batchId))
  );
  const undecidedFullEntries = inputs.filter(
    (input) => (input.mode ?? 'full') === 'full' && input.dispatch === undefined
  );
  if (undecidedBornBatches.size === 0 && undecidedFullEntries.length === 0) return;

  const candidates: ProfileCandidate[] = names.map((name) => {
    const binaries = new Set<string>();
    const resolved = resolveProfiledDispatch(config, name);
    for (const tier of TIER_ORDER) {
      const command = resolved.tiers[tier].commandTemplate[0];
      if (command !== undefined) binaries.add(path.basename(command));
    }
    return { name, binaries: [...binaries] };
  });
  const detected = detectDispatchProfile({ env: process.env, candidates });
  if (detected === null) {
    fail([
      'Cannot determine which dispatch profile to inherit — detection was inconclusive and no --dispatch was given.',
      '',
      `Available profiles: ${names.join(', ')}`,
      '',
      'Detection knows CLAUDECODE (Claude Code) and process ancestry (best-effort — nohup/systemd/detached wrappers break it).',
      'Fix: pass --dispatch <profile> explicitly (the batch-cycle skill does this automatically).',
    ]);
  }
  for (const input of slotInputs) {
    if (
      input.dispatch === undefined &&
      input.batch !== undefined &&
      input.batch !== null &&
      undecidedBornBatches.has(input.batch)
    ) {
      input.dispatch = detected.profile;
    }
  }
  for (const input of undecidedFullEntries) {
    input.dispatch = detected.profile;
  }
  (opts.json ? console.error : console.log)(
    `Dispatch profile: ${detected.profile} (${
      detected.method === 'claudecode-env'
        ? 'inherited via CLAUDECODE'
        : 'inherited via parent chain'
    })`
  );
}

/** Print the enqueue result — human summary, or `--json`. */
function reportEnqueue(
  opts: EnqueueOptions,
  project: string,
  inputs: EnqueueInput[],
  blocked: EnqueueInput[],
  failed: number[],
  queueDepth: number
): void {
  if (opts.json) {
    console.log(
      JSON.stringify({
        project,
        enqueued: inputs.length,
        queued: inputs.length - blocked.length,
        blocked_by_label: blocked.map((input) => ({
          issue: input.issue,
          label: input.blocked_label,
        })),
        label_check_failed: failed,
        queue_depth: queueDepth,
      })
    );
    return;
  }
  const summary =
    blocked.length > 0
      ? `${inputs.length - blocked.length} queued, ${blocked.length} blocked-by-label`
      : `${inputs.length} queued`;
  console.log(
    `✓ Enqueued ${inputs.length} issue(s) for ${project} (${summary}; queue depth: ${queueDepth})`
  );
}

// --- subcommands ---

function registerEnqueueSubcommand(cmd: Command): void {
  cmd
    .command('enqueue')
    .description('Add issues to the scheduler queue (flags, a --from-manifest JSON file, or both)')
    .option('--issues <numbers>', 'Comma-separated issue numbers or ranges, e.g. 101,105..109')
    .option('--mode <mode>', "Execution mode: 'full' (default) or 'slot'", 'full')
    .option('--batch <id>', 'Batch id (required for slot mode)')
    .option('--deps <numbers>', 'Comma-separated dependency issue numbers (applied to all)')
    .option('--tier <tier>', 'Model tier: mechanical | mid (default) | strong', 'mid')
    .option(
      '--review <level>',
      "Slot members only: review level light (default) | full — a review=full member dispatches at strong tier minimum and gets full-cycle-grade review; at most 2 per batch (config's max_full_review_members)"
    )
    .option('--from-manifest <path>', 'JSON file of entries (batch-prep output)')
    .option(
      '--more-members-expected',
      "With --batch: don't seal this batch yet — more members are coming in a later enqueue call"
    )
    .option(
      '--priority <n>',
      "Assignment weight: for --mode full, the issue's own priority (default 0); for --mode slot, the BATCH's priority (default 10, or config's default_batch_priority) — higher dispatches first"
    )
    .option(
      '--skip-plan-check',
      'Enqueue slot members even when they carry no plan:v1 artifact (they will hand back with reason=no-plan-artifact unless a plan is posted before dispatch)'
    )
    .option(
      '--dispatch <profile>',
      'Name the dispatch profile for every enqueued entry (a dispatch_profiles key) — overrides CLAUDECODE/parent-chain detection; with no flag and inconclusive detection the enqueue FAILS rather than guessing the default'
    )
    .option('--project <slug>', 'Project slug (default: owner-repo of the current directory)')
    .option(
      '--repo <owner/name>',
      "GitHub repo to screen hard-block labels against (default: current directory's repo — required when --project targets a different repo)"
    )
    .option('--json', 'Output the result as JSON')
    .action((opts: EnqueueOptions) => {
      requireRepoSlug(opts.repo);
      const { store, project } = resolveStore(opts);

      const inputs: EnqueueInput[] = [];
      let manifestProject: string | null = null;
      if (opts.fromManifest) {
        let raw: string;
        try {
          raw = fs.readFileSync(opts.fromManifest, 'utf-8');
        } catch (err) {
          fail([`Cannot read manifest ${opts.fromManifest}: ${(err as Error).message}`]);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          fail([`Manifest is not valid JSON: ${(err as Error).message}`]);
        }
        if (
          parsed &&
          typeof parsed === 'object' &&
          typeof (parsed as { project?: unknown }).project === 'string'
        ) {
          manifestProject = (parsed as { project: string }).project;
        }
        try {
          inputs.push(...parseManifest(parsed));
        } catch (err) {
          fail([(err as Error).message]);
        }
      }

      if (manifestProject !== null && manifestProject !== project) {
        console.error(
          `⚠ Manifest was prepared for project '${manifestProject}' but enqueueing into '${project}'`
        );
      }

      const explicitPriority = parsePriority(opts.priority);
      // #565: --priority is only ever consumed inside the --issues branch
      // below — silently accepting it alongside a manifest-only call would
      // validate the flag and then discard it. A manifest supplies priority
      // per entry via its own `priority`/`batch_priority` fields instead.
      if (explicitPriority !== undefined && !opts.issues) {
        fail([
          '--priority applies to --issues only — a manifest entry sets its own "priority"/"batch_priority" field',
        ]);
      }

      if (opts.issues) {
        const mode = parseMode(opts.mode);
        const tier = parseTier(opts.tier);
        const review = parseReview(opts.review);
        const deps = opts.deps ? issueList(opts.deps, 'deps') : [];
        for (const issue of issueList(opts.issues, 'issues')) {
          inputs.push({
            issue,
            mode,
            batch: opts.batch ?? null,
            deps,
            tier,
            ...(review !== undefined ? { review } : {}),
            // #565: for a slot-mode entry, --priority addresses the BATCH
            // (batch_priority below) — the member's own priority is never
            // read by the scheduler (only `mode: 'full'` entries compete for
            // a slot directly), so it stays at the default rather than
            // showing a number in `sched status` that looks load-bearing
            // but is not.
            priority:
              mode === 'slot'
                ? DEFAULT_ISSUE_PRIORITY
                : (explicitPriority ?? DEFAULT_ISSUE_PRIORITY),
            ...(mode === 'slot' && explicitPriority !== undefined
              ? { batch_priority: explicitPriority }
              : {}),
            ...(opts.moreMembersExpected ? { more_members_expected: true } : {}),
          });
        }
      }

      if (inputs.length === 0) {
        fail(['Nothing to enqueue — pass --issues or --from-manifest']);
      }
      if (inputs.length > MAX_ISSUE_SELECTION) {
        fail([
          `Cannot enqueue ${inputs.length} issues — the label pre-screen costs one gh call each, past the ${MAX_ISSUE_SELECTION} cap.\nFix: split the manifest into batches of at most ${MAX_ISSUE_SELECTION}.`,
        ]);
      }

      // #707: resolve the dispatch profile (explicit flag → detection →
      // refuse) BEFORE any state mutation, so a refused enqueue leaves no
      // batch and no partially-applied batch fact.
      resolveEnqueueDispatchProfile(store, opts, inputs);

      // #777: before any state mutation — a refused batch leaves nothing behind.
      screenBatchGate(store, opts, inputs);

      // #565: a batch-mode entry with no explicit batch_priority (neither
      // --priority on the CLI nor a manifest field) gets the configurable
      // default here — `enqueueEntries`/`createBatch` stay config-free, same
      // as the label pre-screen's resolution one field over. Applied ONLY to
      // batches this call is actually CREATING — a member joining a batch
      // that already exists (an incremental `--more-members-expected` call,
      // or a later manifest split) must never inject a value, or
      // `assertBatchFactsAgree` rejects the whole enqueue for "re-pointing"
      // a priority the operator never asked to change.
      const defaultBatchPriority =
        store.loadConfig().default_batch_priority ?? DEFAULT_BATCH_PRIORITY;
      const existingBatchIds = new Set(store.load().batches.map((b) => b.id));
      const batchPrioritySeeded = new Set<string>();
      for (const input of inputs) {
        if ((input.mode ?? 'full') !== 'slot' || input.batch == null) continue;
        if (input.batch_priority !== undefined) {
          batchPrioritySeeded.add(input.batch);
          continue;
        }
        if (existingBatchIds.has(input.batch) || batchPrioritySeeded.has(input.batch)) continue;
        input.batch_priority = defaultBatchPriority;
        batchPrioritySeeded.add(input.batch);
      }

      // #603: before the store lock and before any batch is created, so a
      // rejected enqueue leaves no batch, no anchor binding and no worktree.
      if (!opts.skipPlanCheck) {
        screenSlotPreconditions(inputs, opts.repo);
      }

      const failed = screenHardBlockLabels(inputs, opts.repo);

      // #771: the per-batch review=full cap, resolved from config here —
      // `enqueueEntries` stays config-free, same as default_batch_priority.
      const maxFullReviewMembers =
        store.loadConfig().max_full_review_members ?? MAX_FULL_REVIEW_MEMBERS;

      let queueDepth: number;
      try {
        queueDepth = store.withLock((state) => {
          const next = enqueueEntries(state, inputs, new Date(), {
            maxFullReviewMembers,
          });
          return { state: next, result: next.entries.length };
        });
      } catch (err) {
        handleKnownError(err);
      }

      const blocked = inputs.filter((input) => input.blocked_label);
      journalLabelScreen(store, blocked, failed);
      reportEnqueue(opts, project, inputs, blocked, failed, queueDepth);
    });
}

function registerStatusSubcommand(cmd: Command): void {
  cmd
    .command('status')
    .description('Render the queue, slots, batches, and blocked/failed sets')
    .option('--project <slug>', 'Project slug (default: owner-repo of the current directory)')
    .option('--json', 'Output the report as JSON')
    .option(
      '--anchors',
      "Also sweep open batch anchors — ledger-tracked (#768) and orphaned (#790, batches no longer in state.batches) — reads issue state from GitHub; run from the project's repository"
    )
    .action(async (opts: SchedOptions & { anchors?: boolean }) => {
      const { store, project } = resolveStore(opts);
      try {
        const report = buildStatusReport(
          store.load(),
          store.loadConfig(),
          project,
          store.engineLeaseStatus(),
          new Date(),
          opts.anchors === true ? anchorSweepFor(project) : undefined,
          // #791: local git only, no network — runs by default, unlike --anchors.
          keptWorktreeReaderFor()
        );
        // Cache-only (#537): `status` is a fast, offline-friendly diagnostic
        // — it reads whatever `sched start` last cached rather than risking
        // a multi-second hang on an unreachable npm registry.
        const staleness = await checkEngineStaleness({ noFetch: true });
        if (opts.json) {
          console.log(JSON.stringify({ ...report, engine_staleness: staleness }, null, 2));
        } else {
          console.log(renderReport(report, staleness));
        }
      } catch (err) {
        handleKnownError(err);
      }
    });
}

interface PauseResumeOptions extends SchedOptions {
  /** Resume-only: a batch id blocked on `gate-inconclusive:<cap>` (#583 — re-run that gate for its current member) or over landed work (`dissolve-refused:*` / `tail-blocked:*` / `members-mismatch:*` / `respawn-cap:tail`, #822 → `resumeLandedBatch`), instead of the global pause toggle. */
  batch?: string;
}

/**
 * `sched resume --batch <id>` (#583 AC4) — re-runs the incremental gate that
 * blocked `<id>` and resolves it, using the SAME `BatchDispatchDeps` shape
 * `sched start` builds (see `registerStartSubcommand`'s `deps` object /
 * `engine.ts`'s `EngineDeps → BatchDispatchDeps` mapping), scoped down to
 * just what `resumeBlockedGate` needs — no teardown/fence/report machinery,
 * since this never touches those phases.
 */
// #822: a batch blocked over landed work (`isLandedResumableBlock`) is routed
// to `resumeLandedBatchCommand` instead of the gate recheck.
function resumeBatchGate(opts: PauseResumeOptions): void {
  const { store } = resolveStore(opts);
  // #822: a batch blocked over LANDED work (a refused dissolve, #832's tail
  // blocks) resumes by re-running the gate + tail over its landed members —
  // routed before the config load, which only the gate recheck needs.
  const blockedOn = findBatch(store.load(), opts.batch as string)?.blocked_reason ?? null;
  if (isLandedResumableBlock(blockedOn)) {
    resumeLandedBatchCommand(store, opts);
    return;
  }
  let config: SchedConfig;
  try {
    config = store.loadConfig();
  } catch (err) {
    handleKnownError(err);
  }
  const deps: BatchDispatchDeps = {
    store,
    journal: new Journal(store.dir),
    groundTruth: createExecGroundTruth(undefined, { repoDir: process.cwd() }),
    spawnDeps: createSpawnDeps(process.cwd()),
    now: () => new Date(),
    repoDir: process.cwd(),
    exec: createExecFn(TEARDOWN_TIMEOUT_MS, {
      onError: (file, args, err) =>
        process.stderr.write(
          `⚠ sched resume --batch: '${file} ${args.join(' ')}' failed: ${err.message}\n`
        ),
    }),
    runSuite: createBatchSuiteRunner(config),
    runCapability: createBatchCapabilityRunner(),
  };
  try {
    const result = resumeBlockedGate(
      deps,
      config,
      resolveDispatch(config),
      opts.batch as string,
      new Date()
    );
    if (opts.json) {
      console.log(JSON.stringify({ batch: opts.batch, ...result }));
      return;
    }
    if (result.outcome === 'still-blocked') {
      console.log(
        (result.blockedBy === 'unevidenced-failure'
          ? `⏸ Batch ${opts.batch} still blocked — cap run ${result.capability} reports task-failed but produced no evidence it earned one (#594).`
          : `⏸ Batch ${opts.batch} still blocked — cap run ${result.capability} is still inconclusive.`) +
          (result.detail ? `\n  ${result.detail}` : '')
      );
    } else if (result.outcome === 'evicted') {
      console.log(
        `✗ Batch ${opts.batch}: cap run ${result.capability} now reports task-failed — member evicted, batch continues.`
      );
    } else if (result.outcome === 'skipped') {
      console.log(
        `⏭ Batch ${opts.batch}: cap run ${result.capability} timed out on recheck — gate declines (#681), member stands, batch continues.`
      );
    } else {
      console.log(
        `✓ Batch ${opts.batch}: cap run ${result.capability} now reports ok — member completed, batch continues.`
      );
    }
  } catch (err) {
    handleKnownError(err);
  }
}

/**
 * `sched resume --batch <id>` for a batch blocked over landed work (#822):
 * `blocked → validating`; the running engine's next tick re-runs the gate and
 * then the tail over the landed members only.
 */
function resumeLandedBatchCommand(store: SchedStore, opts: PauseResumeOptions): void {
  try {
    // The checks the pure transition cannot make: the worktree the gate re-runs
    // in still exists, and a profiled batch's profile still resolves (else the
    // engine's next tick would just dissolve-refuse it again).
    const batch = findBatch(store.load(), opts.batch as string);
    if (batch?.worktree && !fs.existsSync(batch.worktree)) {
      throw new SchedNotFoundError(
        `Batch ${opts.batch}: its integration worktree ${batch.worktree} no longer exists — the gate cannot re-run; open the PR from ${batch.branch ?? 'its branch'} by hand, or \`sched abandon --batch ${opts.batch}\``
      );
    }
    if (batch?.dispatch_profile) {
      resolveProfiledDispatch(store.loadConfig(), batch.dispatch_profile);
    }
    const resumed = store.withLock((state) => {
      const r = resumeLandedBatch(state, opts.batch as string);
      return { state: r.state, result: r };
    });
    new Journal(store.dir).append(
      unitEvent('batch-resumed', `batch:${opts.batch}`, {
        reason: resumed.reason,
        detail: `landed=${resumed.landed.join(',')} — gate + tail re-run over the landed members${resumed.clearedExits > 0 ? `; cleared ${resumed.clearedExits} counted tail exit(s)` : ''}`,
      })
    );
    if (opts.json) {
      console.log(
        JSON.stringify({
          batch: opts.batch,
          outcome: 'resumed',
          from: resumed.reason,
          landed: resumed.landed,
        })
      );
      return;
    }
    console.log(
      `▶ Batch ${opts.batch} resumed from '${resumed.reason}' — the next engine tick re-runs the batch gate, then the tail over landed member(s) ${resumed.landed.map((m) => `#${m}`).join(', ')}.`
    );
  } catch (err) {
    handleKnownError(err);
  }
}

function registerPauseResumeSubcommand(cmd: Command, pause: boolean): void {
  const sub = cmd
    .command(pause ? 'pause' : 'resume')
    .description(
      pause
        ? 'Prevent every new agent process, including recovery takeovers; live agents keep running'
        : 'Resume making new slot assignments; with --batch <id>, re-run the incremental gate for a batch blocked on gate-inconclusive (#583), or re-run the gate + tail over the landed members of a batch blocked over landed work — dissolve-refused / tail-blocked / members-mismatch / respawn-cap:tail (#822)'
    )
    .option('--project <slug>', 'Project slug (default: owner-repo of the current directory)')
    .option('--json', 'Output the result as JSON');
  if (!pause) {
    sub.option(
      '--batch <id>',
      'Batch id blocked on gate-inconclusive:<cap> (re-run that gate) or over landed work (dissolve-refused / tail-blocked / members-mismatch / respawn-cap:tail — ship the landed members)'
    );
  }
  sub.action((opts: PauseResumeOptions) => {
    if (!pause && opts.batch) {
      resumeBatchGate(opts);
      return;
    }
    const { store, project } = resolveStore(opts);
    try {
      const paused = store.withLock((state) => ({
        state: setPaused(state, pause),
        result: pause,
      }));
      if (opts.json) {
        console.log(JSON.stringify({ project, paused }));
      } else {
        console.log(paused ? '⏸ Scheduler paused' : '▶ Scheduler resumed');
      }
    } catch (err) {
      handleKnownError(err);
    }
  });
}

interface StatsOptions extends SchedOptions {
  // `--project` only matters for `--batch` (a batch id is scoped to a
  // project's `~/.dossier/sched/<project>/runs/`, unlike `runs.jsonl`, which
  // is one global file — see the command's description for the resulting
  // cross-repo caveat when `--batch` is absent: same issue number in two
  // repos sums together).
  issues?: string;
  batch?: string;
}

function statsRow(label: string, row: Omit<IssueCost, 'issue'>): string[] {
  return [
    label,
    String(row.runs),
    formatCount(row.input_tokens),
    formatCount(row.output_tokens),
    formatCount(row.reasoning_tokens),
    formatCount(row.steps),
    formatCount(row.cache_creation_tokens),
    formatCount(row.cache_read_tokens),
    row.cost === 'unpriced'
      ? 'unpriced'
      : row.cost === 'partial'
        ? `${formatCost(row.total_cost_usd)} + unpriced`
        : formatCost(row.total_cost_usd),
    formatDurationMs(row.duration_ms),
    row.model ?? '-',
    row.provider ?? '-',
    row.tier ?? '-',
    row.usage,
  ];
}

const STATS_HEADERS = [
  'Issue',
  'Runs',
  'In',
  'Out',
  'Reasoning',
  'Steps',
  'Cache-W',
  'Cache-R',
  'Cost',
  'Duration',
  'Model',
  'Provider',
  'Tier',
  'Usage',
];
const STATS_ALIGN = [
  'left',
  'right',
  'right',
  'right',
  'right',
  'right',
  'right',
  'right',
  'right',
  'right',
  'left',
  'left',
  'left',
  'left',
] as const;

/**
 * `--batch <id>` mode (#564): batch members/tail/report/fix agents never go
 * through `engine.ts`'s per-issue dispatch/record path — `runs.jsonl` alone
 * cannot answer "what did this batch cost", live or historical. Reconstruct
 * directly from the raw per-unit logs on disk instead (same source a human
 * previously hand-parsed, `docs/reports/batch-pilot-2-execution.md` §13).
 */
function runBatchStats(opts: StatsOptions & { batch: string }): void {
  const { store, project } = resolveStore(opts);
  const entries = buildBatchRunLogEntries(store.runsDir, opts.batch);
  const memberIssues = [
    ...new Set(
      entries
        .map((e) => e.unit)
        .filter((u): u is string => typeof u === 'string' && u.startsWith('issue:'))
    ),
  ]
    .map((u) => Number.parseInt(u.slice('issue:'.length), 10))
    .sort((a, b) => a - b);
  const report = buildSchedCostReport(entries, memberIssues);
  // Tail/report agents carry no issue — `buildSchedCostReport` already
  // excludes them from per-issue rows (same `issueOfUnit`-based filtering as
  // the default path); fold them into one visible line so nothing about the
  // batch's actual spend is silently dropped (AC2). `aggregateRunLogEntries`
  // (not `buildSchedCostReport`, which filters to `issue:<n>` units only —
  // #564 review) sums these `batch:<id>`-unit entries directly.
  const overhead = entries.filter((e) => e.unit === `batch:${opts.batch}`);
  const overheadTotals = aggregateRunLogEntries(overhead);
  const amortization = batchAmortization(store, opts.batch, entries);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ...report,
          batch: opts.batch,
          project,
          overhead: overhead.length > 0 ? overheadTotals : null,
          overhead_runs: overhead.length,
          amortization,
          source: store.runsDir,
        },
        null,
        2
      )
    );
    return;
  }

  if (entries.length === 0) {
    console.log(`No dispatch logs found for batch '${opts.batch}' under ${store.runsDir}.`);
    if (amortization.members_enqueued > 0) console.log(formatAmortizationLine(amortization));
    return;
  }

  const rows = report.issues.map((row) => statsRow(`#${row.issue}`, row));
  rows.push(statsRow('TOTAL (members)', report.totals));
  if (overhead.length > 0) {
    rows.push(statsRow('batch-overhead (tail+report)', overheadTotals));
  }
  console.log(`Batch ${opts.batch} [${project}]:`);
  console.log(renderTable(STATS_HEADERS, rows, { align: [...STATS_ALIGN], separator: true }));
  console.log(formatAmortizationLine(amortization));
}

/**
 * The batch's amortization summary (#775): its persisted state entry (when
 * `state.json` still holds it) + its `events.jsonl` lines + the reconstructed
 * dispatch entries. Best-effort on the two extra reads — an unreadable state
 * or journal only narrows the summary, never fails the cost report above it.
 */
function batchAmortization(
  store: SchedStore,
  batchId: string,
  entries: ReturnType<typeof buildBatchRunLogEntries>
): BatchAmortizationSummary {
  let batch: BatchEntry | null = null;
  try {
    batch = store.load().batches.find((b) => b.id === batchId) ?? null;
  } catch {
    batch = null;
  }
  let events: BatchJournalEvent[] = [];
  try {
    events = readJsonl<BatchJournalEvent>(store.journalPath);
  } catch {
    events = [];
  }
  return buildBatchAmortizationSummary({
    batchId,
    batch,
    journal: summarizeBatchJournal(events, batchId),
    entries,
  });
}

function registerStatsSubcommand(cmd: Command): void {
  cmd
    .command('stats')
    .description(
      'Per-issue token/cost totals for scheduler-dispatched agent runs (from ~/.dossier/runs.jsonl; --batch reads batch member/tail/report/fix logs directly)'
    )
    .option(
      '--project <slug>',
      "Project slug (default: owner-repo of the current directory) — scopes --batch to that project's runs dir"
    )
    .option('--issues <selection>', 'Restrict to these issues (e.g. "4,5" or "4..9")')
    .option(
      '--batch <id>',
      "Report a batch's member/tail/report/fix dispatch costs directly from its raw logs"
    )
    .option('--json', 'Output the report as JSON')
    .action((opts: StatsOptions) => {
      if (opts.batch) {
        if (opts.issues) fail(['--issues cannot be combined with --batch']);
        runBatchStats(opts as StatsOptions & { batch: string });
        return;
      }
      const issues = opts.issues ? issueList(opts.issues, 'issues') : undefined;
      const entries = readRunLog();
      const report = buildSchedCostReport(entries, issues);
      // An empty cohort and a disabled recorder look identical in the log file
      // (#524, decision 2), and `--issues` synthesizes zero-run rows so the
      // row count never reaches 0 on that path. Resolve it once, up front, and
      // surface it on every path — including `--json`.
      const telemetryOn = schedTelemetryEnabled();

      if (opts.json) {
        console.log(
          JSON.stringify(
            { ...report, telemetry_enabled: telemetryOn, source: RUNS_LOG_FILE },
            null,
            2
          )
        );
        return;
      }

      if (report.issues.length === 0) {
        console.log(`No sched-dispatched runs.jsonl entries found in ${RUNS_LOG_FILE}.`);
      }
      if (!telemetryOn) {
        console.log(
          'Note: sched telemetry is disabled (`schedTelemetry: false` in ~/.dossier/config.json) — ' +
            'dispatches are not recorded. Re-enable with `dossier config schedTelemetry true`.'
        );
      }
      if (report.issues.length === 0) return;

      const rows = report.issues.map((row) => statsRow(`#${row.issue}`, row));
      rows.push(statsRow('TOTAL', report.totals));
      console.log(renderTable(STATS_HEADERS, rows, { align: [...STATS_ALIGN], separator: true }));
    });
}

/**
 * #809: the `member-in-work` cell of a parallel batch — `∥ 2 running, 1 landed /3`
 * rather than a pointer that reads as "member 3 of 3" while three still run.
 */
function parallelMemberSummary(runs: ReadonlyArray<{ status: string }>, members: number): string {
  if (runs.length === 0) return `∥ 0/${members}`;
  const counts = new Map<string, number>();
  for (const r of runs) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  return `∥ ${[...counts].map(([status, n]) => `${n} ${status}`).join(', ')} /${members}`;
}

function registerAbandonSubcommand(cmd: Command): void {
  cmd
    .command('abandon')
    .description('Fail an issue entry (or dissolve a batch and requeue its members as full-cycle)')
    .option('--issue <number>', 'Issue number to abandon')
    .option('--batch <id>', 'Batch id to dissolve')
    .option('--reason <text>', 'Reason recorded on the entry')
    .option('--project <slug>', 'Project slug (default: owner-repo of the current directory)')
    .option('--json', 'Output the result as JSON')
    .action((opts: AbandonOptions) => {
      if ((opts.issue ? 1 : 0) + (opts.batch ? 1 : 0) !== 1) {
        fail(['Pass exactly one of --issue <number> or --batch <id>']);
      }
      const { store, project } = resolveStore(opts);
      const reason = opts.reason ?? 'abandoned';
      try {
        if (opts.issue) {
          const issue = issueList(opts.issue, 'issue')[0];
          const result = store.withLock((state) => {
            const r = abandonIssue(state, issue, reason);
            return { state: r.state, result: r.releasedSlots };
          });
          if (opts.json) {
            console.log(JSON.stringify({ abandoned: `issue:${issue}`, released_slots: result }));
          } else {
            console.log(`✓ Abandoned issue #${issue} (released ${result.length} slot(s))`);
          }
        } else if (opts.batch) {
          const spawnDeps = createSpawnDeps(process.cwd());
          const { requeued, anchor } = store.withLock((state) => {
            const anchor = findBatch(state, opts.batch as string)?.anchor ?? null;
            // #809: abandon requeues every member full-cycle — an agent still
            // running in one of the batch's slots (a parallel member holds its
            // own) would keep working a unit the engine is about to redispatch.
            for (const slot of slotsForBatch(state, opts.batch as string)) {
              if (slot.pid !== null && spawnDeps.isAlive(slot.pid, slot.pid_start ?? undefined)) {
                spawnDeps.kill(slot.pid, slot.pid_start ?? undefined);
              }
            }
            const r = abandonBatch(state, opts.batch as string, reason);
            return { state: r.state, result: { requeued: r.requeued, anchor } };
          });
          // #790: never a refusal — the dissolve above already committed.
          // This is a courtesy warning only, run after the lock (a GitHub
          // read, never inside `withLock` — see `anchorReaderFor`'s own
          // comment on why network I/O stays outside it). Run before the
          // JSON output below so `--json` can carry its result too, not
          // just the stderr line.
          const anchorOpen = warnIfAbandonedAnchorOpen(store, project, opts.batch, anchor);
          if (opts.json) {
            console.log(
              JSON.stringify({
                abandoned: `batch:${opts.batch}`,
                requeued,
                anchor_open: anchorOpen,
              })
            );
          } else {
            console.log(
              `✓ Dissolved batch ${opts.batch}; requeued ${requeued.length} member(s) as full-cycle`
            );
          }
        }
      } catch (err) {
        handleKnownError(err);
      }
    });
}

interface RequeueOptions extends SchedOptions {
  issue: string;
  reason?: string;
}

/**
 * `sched requeue --issue <n>` (#810): the operator's remedy for a PARKED batch
 * member (evicted / handed back). Requeues it as a full-cycle unit on the
 * batch's dispatch profile; the engine's cycle prompt then continues from the
 * member branch recorded at park time. Refuses anything that is not parked.
 */
function registerRequeueSubcommand(cmd: Command): void {
  cmd
    .command('requeue')
    .description(
      'Requeue a parked batch member (evicted / handed-back) as full-cycle, on the batch dispatch profile, continuing from its member branch'
    )
    .requiredOption('--issue <number>', 'Parked member issue number')
    .option('--reason <text>', 'Reason recorded on the entry', 'operator-requeue')
    .option('--project <slug>', 'Project slug (default: owner-repo of the current directory)')
    .option('--json', 'Output the result as JSON')
    .action((opts: RequeueOptions) => {
      const issues = issueList(opts.issue, 'issue');
      if (issues.length !== 1) {
        fail([`--issue takes a single issue number, got '${opts.issue}'`]);
      }
      const issue = issues[0] as number;
      const { store } = resolveStore(opts);
      try {
        const entry = store.withLock((state) => {
          const r = requeueParkedMember(state, issue, opts.reason ?? 'operator-requeue');
          return { state: r.state, result: r.entry };
        });
        const branch = entry.failure_evidence?.branch ?? null;
        new Journal(store.dir).append(
          unitEvent('member-requeued', `issue:${issue}`, {
            reason: opts.reason ?? 'operator-requeue',
            detail: `full-cycle on profile ${entry.dispatch_profile ?? 'default'}${branch !== null ? ` from ${branch}` : ''}`,
          })
        );
        if (opts.json) {
          console.log(
            JSON.stringify({
              requeued: `issue:${issue}`,
              dispatch_profile: entry.dispatch_profile,
              branch,
            })
          );
        } else {
          console.log(
            `✓ Requeued #${issue} as full-cycle on profile ${entry.dispatch_profile ?? 'default'}` +
              (branch !== null ? `, continuing from ${branch}` : '')
          );
        }
      } catch (err) {
        handleKnownError(err);
      }
    });
}

/** Per-call budget for attach-pr's two reads (repo verification, `gh pr view`) — an operator command must not hang on gh. */
const ATTACH_PR_READ_TIMEOUT_MS = 10_000;

interface AttachPrOptions extends SchedOptions {
  batch: string;
}

/**
 * `sched attach-pr --batch <id> <pr>` (#824): record an operator-named PR as a
 * blocked batch's `batch.pr` — the explicit remedy for #789's
 * `pr-detect-ambiguous`, and batch-integrate manual recovery's Step 6b. The
 * project repository is verified FIRST (`resolveProjectRepo`) and every PR
 * read is pinned to it with `-R`; an unverifiable repository refuses before
 * any PR is read. `attachBatchPr` holds the PR to #789's own candidate checks
 * and records nothing on any mismatch; it never closes the anchor.
 */
function registerAttachPrSubcommand(cmd: Command): void {
  cmd
    .command('attach-pr <pr>')
    .description(
      "Record a MERGED PR as a blocked batch's own (resolves pr-detect-ambiguous, #824) — verified same-repo, head = batch branch, base = batch base; never closes the anchor"
    )
    .requiredOption('--batch <id>', 'Blocked batch id to record the PR on')
    .option('--project <slug>', 'Project slug (default: owner-repo of the current directory)')
    .option('--json', 'Output the result as JSON')
    .action((prArg: string, opts: AttachPrOptions) => {
      const prDigits = prArg.replace(/^#/, '');
      if (!isIssueNumber(prDigits)) {
        fail([`<pr> must be a pull request number (e.g. 4270 or #4270), got '${prArg}'`]);
      }
      const pr = Number(prDigits);
      const { store, project } = resolveStore(opts);
      const exec = labelledExecFn('sched attach-pr', ATTACH_PR_READ_TIMEOUT_MS);
      const repo = resolveProjectRepo(project, exec);
      if (repo === null) {
        fail([
          `Refusing to attach PR #${pr}: the current directory is not ${project}'s GitHub repository (or gh could not confirm it) — every PR read is pinned to the verified repository with -R, and there is none to pin to. Run from the project's own checkout.`,
        ]);
      }
      try {
        const result = attachBatchPr(
          {
            store,
            journal: new Journal(store.dir),
            groundTruth: createExecGroundTruth(exec, { repoDir: process.cwd(), repo }),
            repo,
          },
          opts.batch,
          pr
        );
        if (opts.json) {
          console.log(JSON.stringify({ batch: opts.batch, repo, ...result }));
          return;
        }
        if (result.outcome === 'already-attached') {
          console.log(`= Batch ${opts.batch} already has PR #${pr} recorded — nothing to do`);
          return;
        }
        console.log(
          `✓ Attached ${repo}#${pr} (MERGED ${result.mergedAt}) to batch ${opts.batch}` +
            (result.clearedAmbiguousTicks > 0
              ? `; cleared the pr-detect-ambiguous streak (${result.clearedAmbiguousTicks} tick(s))`
              : '') +
            ' — the next engine tick (`sched start`, the tick cron, or a one-off `sched start --once`) reconciles the batch on pr-merged evidence, then report + teardown follow; the anchor is left to its own evidence-gated close'
        );
      } catch (err) {
        handleKnownError(err);
      }
    });
}

/**
 * #790: `sched abandon --batch` dissolves a batch in place — it stays in
 * `state.batches` (status `dissolved`), so `sched status --anchors`'s ledger
 * sweep already re-surfaces its anchor as `needs-operator` on the very next
 * run. The gap this closes is the WINDOW between the dissolve and that next
 * `--anchors` run: abandon is the moment an operator has already decided
 * this batch is done, so warn right here instead of relying on them to
 * remember to check. Never refuses — the dissolve has already happened by
 * the time this runs; refusing here would accomplish nothing but noise.
 * When the anchor check itself cannot run (unresolved repo, unreachable
 * `gh`), `anchorReaderFor` prints its own stderr note labeled `sched
 * abandon` (not `sched status` — #790 review) and this function silently
 * gives up on the "still open" question specifically: a false "still open"
 * would be worse than saying nothing about THAT, but the failure itself is
 * never hidden.
 *
 * Returns the anchor number when it warned (still open), else `null` — the
 * caller folds this into `abandon --json`'s additive `anchor_open` field
 * (#790 review) so a JSON consumer sees the warning too, not just stderr.
 */
function warnIfAbandonedAnchorOpen(
  store: SchedStore,
  project: string,
  batchId: string,
  anchor: number | null
): number | null {
  if (anchor === null) return null;
  const reader = anchorReaderFor(project, 'sched abandon');
  if (reader === undefined) return null;
  const stillOpen = batchAnchorStillOpen({ anchor }, reader.read);
  if (stillOpen === null) return null;
  const message = `batch ${batchId} abandoned with its anchor #${stillOpen} still open on GitHub — sched status --anchors will surface it as needs-operator; close it by hand once its members are accounted for`;
  process.stderr.write(`⚠ sched abandon: ${message}\n`);
  new Journal(store.dir).append(
    unitEvent('batch-anchor-open-on-abandon', `batch:${batchId}`, {
      detail: `anchor #${stillOpen} still open`,
    })
  );
  return stillOpen;
}

function registerStopSubcommand(cmd: Command): void {
  cmd
    .command('stop')
    .description(
      'Terminate an issue agent or batch process and record terminal stopped outcomes without escalation'
    )
    .option('--issue <number>', 'Issue number to stop')
    .option('--batch <id>', 'Batch id to stop with all unfinished members')
    .option('--reason <text>', 'Reason recorded on the entry', 'stopped')
    .option('--project <slug>', 'Project slug (default: owner-repo of the current directory)')
    .option('--json', 'Output the result as JSON')
    .action((opts: StopOptions) => {
      if ((opts.issue ? 1 : 0) + (opts.batch ? 1 : 0) !== 1) {
        fail(['Pass exactly one of --issue <number> or --batch <id>']);
      }
      const issues = opts.issue ? issueList(opts.issue, 'issue') : null;
      if (issues !== null && issues.length !== 1) {
        fail([`--issue takes a single issue number, got '${opts.issue}'`]);
      }
      const issue = issues?.[0];
      const { store } = resolveStore(opts);
      const spawnDeps = createSpawnDeps(process.cwd());
      try {
        const result = store.withLock((state) => {
          const unit = opts.batch ? `batch:${opts.batch}` : `issue:${issue}`;
          // #809: a parallel batch also holds one slot per running member
          // (`batch:<id>#<issue>`) — terminate every one of them.
          const slots = opts.batch
            ? slotsForBatch(state, opts.batch)
            : state.slots.filter((candidate) => candidate.unit === unit);
          let terminated = false;
          for (const slot of slots) {
            if (slot.pid !== null && spawnDeps.isAlive(slot.pid, slot.pid_start ?? undefined)) {
              terminated = spawnDeps.kill(slot.pid, slot.pid_start ?? undefined) || terminated;
            }
          }
          const stopped = opts.batch
            ? stopBatch(state, opts.batch, opts.reason)
            : stopIssue(state, issue as number, opts.reason);
          return {
            state: stopped.state,
            result: {
              releasedSlots: stopped.releasedSlots,
              stopped:
                'stopped' in stopped && Array.isArray(stopped.stopped) ? stopped.stopped : [],
              terminated,
            },
          };
        });
        new Journal(store.dir).append(
          unitEvent('stopped', opts.batch ? `batch:${opts.batch}` : `issue:${issue}`, {
            reason: opts.reason,
            detail: result.terminated ? 'agent terminated' : 'no live agent to terminate',
          })
        );
        if (opts.json) {
          console.log(
            JSON.stringify({
              stopped: opts.batch ? `batch:${opts.batch}` : `issue:${issue}`,
              terminated: result.terminated,
              released_slots: result.releasedSlots,
              ...(opts.batch ? { stopped_members: result.stopped } : {}),
            })
          );
        } else {
          console.log(
            opts.batch
              ? `✓ Stopped batch ${opts.batch} and ${result.stopped.length} member(s) (released ${result.releasedSlots.length} slot(s))`
              : `✓ Stopped issue #${issue} (released ${result.releasedSlots.length} slot(s))`
          );
        }
      } catch (err) {
        handleKnownError(err);
      }
    });
}

function registerReprioritizeSubcommand(cmd: Command): void {
  cmd
    .command('reprioritize')
    .description(
      "Adjust a queued issue or batch's assignment weight in place (#565) — no abandon/re-enqueue round trip"
    )
    .option('--issue <number>', 'Issue number to reprioritize')
    .option('--batch <id>', 'Batch id to reprioritize')
    .requiredOption('--priority <n>', 'New priority (integer; higher dispatches first)')
    .option('--project <slug>', 'Project slug (default: owner-repo of the current directory)')
    .option('--json', 'Output the result as JSON')
    .action((opts: ReprioritizeOptions) => {
      if ((opts.issue ? 1 : 0) + (opts.batch ? 1 : 0) !== 1) {
        fail(['Pass exactly one of --issue <number> or --batch <id>']);
      }
      const priority = parsePriority(opts.priority);
      if (priority === undefined) fail(['--priority is required']);
      const { store } = resolveStore(opts);
      try {
        if (opts.issue) {
          const issues = issueList(opts.issue, 'issue');
          if (issues.length !== 1) {
            fail([`--issue takes a single issue number, got '${opts.issue}'`]);
          }
          const issue = issues[0];
          const previous = store.withLock((state) => {
            const before = state.entries.find((e) => e.issue === issue)?.priority ?? null;
            return { state: reprioritizeIssue(state, issue, priority), result: before };
          });
          new Journal(store.dir).append(
            unitEvent('reprioritized', `issue:${issue}`, { priority, detail: `was ${previous}` })
          );
          if (opts.json) {
            console.log(JSON.stringify({ reprioritized: `issue:${issue}`, priority }));
          } else {
            console.log(`✓ Issue #${issue} priority set to ${priority}`);
          }
        } else if (opts.batch) {
          const batchId = opts.batch;
          const previous = store.withLock((state) => {
            const before = state.batches.find((b) => b.id === batchId)?.priority ?? null;
            return { state: reprioritizeBatch(state, batchId, priority), result: before };
          });
          new Journal(store.dir).append(
            unitEvent('reprioritized', `batch:${batchId}`, { priority, detail: `was ${previous}` })
          );
          if (opts.json) {
            console.log(JSON.stringify({ reprioritized: `batch:${batchId}`, priority }));
          } else {
            console.log(`✓ Batch ${batchId} priority set to ${priority}`);
          }
        }
      } catch (err) {
        handleKnownError(err);
      }
    });
}

/** `npm i -g @ai-dossier/cli@latest` can take a while (network + install). */
const UPGRADE_TIMEOUT_MS = 120_000;

/**
 * A local `ExecFn` built directly on this file's own `execFileSync` import,
 * deliberately NOT `@ai-dossier/sched`'s `createExecFn` (used for
 * `teardownExec`/`fencer`/`batchExec` below): those wrap a call the
 * *engine* owns, whereas an unattended `npm i -g` is a CLI-only side
 * effect with real system impact, and `vi.mock('node:child_process')` in
 * this package's own tests only intercepts `execFileSync` calls made from
 * CLI source — not calls made from inside `@ai-dossier/sched`'s compiled
 * dist output, which Vitest's SSR module graph externalizes rather than
 * transforming (a real cross-package mocking gap this file must not build
 * on for anything that shells out unattended).
 */
function createUpgradeExec(): ExecFn {
  return (file, args) => {
    try {
      return String(
        execFileSync(file, args, {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: UPGRADE_TIMEOUT_MS,
        })
      ).trim();
    } catch (err) {
      process.stderr.write(
        `⚠ sched auto-upgrade: '${file} ${args.join(' ')}' failed: ${(err as Error).message}\n`
      );
      return null;
    }
  };
}

/**
 * #537: after a tick, compare the installed engine against npm latest;
 * when behind, journal `engine-stale` once per distinct (installed, latest)
 * pair (not every tick — a long-running loop would otherwise spam the
 * journal every reconcile) and warn on stderr. When `autoUpgradeEnabled`
 * and nothing is mid-dispatch (`LIVE_SLOT_STATUSES` against freshly
 * re-read state — must reflect what the tick that just ran actually did),
 * self-upgrade via `upgradeExec`.
 */
async function checkAndHandleEngineStaleness(
  store: SchedStore,
  journal: Journal,
  autoUpgradeEnabled: boolean,
  upgradeExec: ExecFn
): Promise<void> {
  const staleness = await checkEngineStaleness();
  if (!staleness.stale) return;
  const { installed, latest } = staleness;
  if (installed === null || latest === null) return; // unreachable when stale=true; keeps TS honest

  const events = journal.read();
  const lastStale = [...events].reverse().find((e) => e.event === 'engine-stale');
  const alreadyJournaled =
    lastStale?.installed_version === installed && lastStale?.latest_version === latest;

  if (!alreadyJournaled) {
    journal.append({
      event: 'engine-stale',
      installed_version: installed,
      latest_version: latest,
      detail: `installed @ai-dossier/sched@${installed} behind npm latest ${latest}`,
    });
    process.stderr.write(`${formatEngineStaleWarning(installed, latest)}\n`);
  }

  if (!autoUpgradeEnabled) return;

  // Re-read fresh — must reflect what the tick that just ran left behind,
  // not a pre-tick snapshot (AC2: "only while no unit is mid-dispatch").
  // Best-effort like the rest of this function: a failure here (state became
  // unreadable between the tick that just succeeded and this re-check) must
  // not crash the `--once` cron path after the tick itself already
  // completed successfully — never surface as an unhandled rejection.
  let busy: boolean;
  try {
    const state = store.load();
    busy = state.slots.some((s) => LIVE_SLOT_STATUSES.has(s.status));
  } catch (err) {
    process.stderr.write(
      `⚠ sched auto-upgrade: could not re-read state to confirm no unit is mid-dispatch, skipping upgrade: ${(err as Error).message}\n`
    );
    return;
  }
  if (busy) return;

  process.stderr.write('⚠ sched: auto-upgrading (npm i -g @ai-dossier/cli@latest)…\n');
  const output = upgradeExec('npm', ['i', '-g', '@ai-dossier/cli@latest']);
  if (output === null) {
    journal.append({
      event: 'engine-auto-upgrade-failed',
      installed_version: installed,
      latest_version: latest,
      detail: 'npm i -g @ai-dossier/cli@latest failed — see stderr for the npm error',
    });
    process.stderr.write('⚠ sched: auto-upgrade failed — see above\n');
  } else {
    journal.append({
      event: 'engine-auto-upgrade-attempted',
      installed_version: installed,
      latest_version: latest,
      detail: 'npm i -g @ai-dossier/cli@latest completed',
    });
    process.stderr.write('✓ sched: auto-upgrade completed\n');
  }
}

function registerStartSubcommand(cmd: Command): void {
  cmd
    .command('start')
    .description(
      'Run the dispatch engine: spawn agents, verify completion, escalate stalls, watch parked PRs, tear down merged worktrees, dispatch report agents (Ctrl-C stops the engine; agents keep running)'
    )
    .option(
      '--interval <seconds>',
      'Reconcile tick interval in seconds (default 60)',
      Number.parseInt
    )
    .option('--once', 'Run a single reconcile+refill tick and exit (cron-style)')
    .option(
      '--auto-upgrade',
      'Self-upgrade (npm i -g @ai-dossier/cli@latest) when the installed engine is behind npm latest and no unit is mid-dispatch'
    )
    .option('--project <slug>', 'Project slug (default: owner-repo of the current directory)')
    .option('--json', 'Output tick results as JSON')
    .action(async (opts: StartOptions) => {
      const { store, project } = resolveStore(opts);
      const acquisition = store.acquireEngineLease();
      if (!acquisition.acquired) {
        // Timer overlap is expected: --once must produce no human or JSON noise.
        if (!opts.once) {
          console.log(
            acquisition.holder === null
              ? 'Scheduler engine is already starting for this project.'
              : `Scheduler engine is already running (pid ${acquisition.holder.pid}).`
          );
        }
        return;
      }
      try {
        let config: SchedConfig;
        try {
          config = store.loadConfig();
        } catch (err) {
          handleKnownError(err);
        }

        // CLI flag beats config.json beats the engine default (60s).
        if (opts.interval !== undefined) {
          if (!Number.isInteger(opts.interval) || opts.interval <= 0) {
            fail(['--interval must be a positive number of seconds']);
          }
          config = { ...config, reconcile_interval_ms: opts.interval * 1000 };
        }

        // #537: CLI flag beats config.json beats off-by-default, same
        // precedence as --interval above.
        const autoUpgradeEnabled = opts.autoUpgrade ?? config.auto_upgrade ?? false;
        const upgradeExec = createUpgradeExec();

        // Resolve the agent command: config dispatch.command wins; otherwise
        // auto-detect (claude first, opencode fallback — the run machinery's
        // order, #459) and use the matching headless template. Skipped
        // entirely once `dispatch.tiers` is set (#527) — an operator who
        // configured a mixed agent-CLI ladder opted out of the single-CLI
        // auto-detect for every tier, not just the ones they overrode.
        const tiersBypassesAutoDetect = config.dispatch?.tiers !== undefined;
        if (tiersBypassesAutoDetect && config.dispatch?.command === undefined) {
          // A tier without its own `dispatch.tiers.<tier>.command` (and no
          // top-level `dispatch.command`) falls back to the built-in claude
          // template, not the detected CLI — surface this before a confusing
          // `spawn-error: ENOENT` shows up deep in the journal instead.
          console.error(
            '⚠ dispatch.tiers is set — auto-detect (claude/opencode) is skipped for every tier; ' +
              'a tier without its own dispatch.tiers.<tier>.command falls back to the built-in ' +
              'claude template, not the detected CLI.'
          );
        }
        const dispatchCommand = tiersBypassesAutoDetect
          ? undefined
          : (config.dispatch?.command ??
            (detectLlm('auto', true) === 'opencode' ? [...OPENCODE_DISPATCH_COMMAND] : undefined));
        const engineConfig = dispatchCommand
          ? { ...config, dispatch: { ...config.dispatch, command: dispatchCommand } }
          : config;

        // #680: log the executor the engine will actually use — agent + model
        // per tier, resolved AFTER the auto-detect above so the banner matches
        // real spawns. Once per start (both --once and the continuous loop):
        // the operator's prep-session choice of agent/model stops here, and
        // this line is where that becomes visible. Suppressed on the one
        // machine-consumed path (`--once --json`, the cron/automation output)
        // so stdout stays pure JSON there — every human-facing path sees it.
        if (!(opts.once && opts.json)) {
          console.log(
            `▶ sched dispatch (default): ${dispatchSummary(tierExecutors(resolveDispatch(engineConfig)))}`
          );
          // #707: name every configured profile and the tier ladder it spawns —
          // what a `--dispatch <name>` batch inherits, visible at engine start.
          for (const name of Object.keys(engineConfig.dispatch?.dispatch_profiles ?? {}).sort()) {
            console.log(
              `▶ sched profile ${name}: ${dispatchSummary(tierExecutors(resolveProfiledDispatch(engineConfig, name)))}`
            );
          }
        }

        // #768: the anchor close writes to GitHub, so it runs only against the
        // repository verified to BE this project's — never whatever the cwd is.
        const anchorRepo = resolveProjectRepo(project, defaultExec) ?? undefined;
        if (anchorRepo === undefined && !(opts.once && opts.json)) {
          console.log(
            `▶ sched anchor close: off — the current directory is not ${project}'s GitHub repository`
          );
        }
        const deps: EngineDeps = {
          store,
          journal: new Journal(store.dir),
          groundTruth: createExecGroundTruth(undefined, {
            repoDir: process.cwd(),
            ...(anchorRepo !== undefined ? { repo: anchorRepo } : {}),
          }),
          ...(anchorRepo !== undefined ? { anchorRepo } : {}),
          spawnDeps: createSpawnDeps(process.cwd()),
          now: () => new Date(),
          repoDir: process.cwd(),
          teardownExec: createExecFn(TEARDOWN_TIMEOUT_MS, {
            onError: (file, args, err) =>
              process.stderr.write(
                `⚠ sched teardown: '${file} ${args.join(' ')}' failed: ${err.message}\n`
              ),
          }),
          // #504: the ladder fences a superseded run before respawning its takeover.
          // Its own exec rather than the ground-truth one: a fence is a WRITE, and
          // borrowing `groundTruthExec` would file the only diagnostic for a failed write
          // under `sched ground truth`, where nobody debugging a fence would look.
          fencer: createExecRunFencer(
            createExecFn(FENCE_TIMEOUT_MS, {
              onError: (file, args, err) =>
                process.stderr.write(
                  `⚠ sched fence: '${file} ${args.join(' ')}' failed: ${err.message}\n`
                ),
            }),
            { repoDir: process.cwd() }
          ),
          // #840: a requeued parked batch member's first dispatch seeds its
          // resume trail (a `setup done` milestone on its member branch) so the
          // full-cycle gate resumes ON that branch. A write, so its own exec +
          // diagnostic prefix, on the fence's budget (two short CLI calls).
          resumeSeeder: createExecResumeSeeder(
            createExecFn(FENCE_TIMEOUT_MS, {
              onError: (file, args, err) =>
                process.stderr.write(
                  `⚠ sched resume-seed: '${file} ${args.join(' ')}' failed: ${err.message}\n`
                ),
            }),
            { repoDir: process.cwd() }
          ),
          // #523: batch git/milestone-CLI operations (worktree claim, commit-range
          // recording, milestone posting, PR watch) and the aggregate suite runner
          // that gates `executing → reviewing`. Reuses the same timeout as teardown
          // (worktree/git ops). The cold-path warm-up install/build (#561) does
          // NOT reuse this — see `batchWarmExec` below — a real `npm ci`+build
          // routinely exceeds this budget.
          batchExec: createExecFn(TEARDOWN_TIMEOUT_MS, {
            onError: (file, args, err) =>
              process.stderr.write(
                `⚠ sched batch: '${file} ${args.join(' ')}' failed: ${err.message}\n`
              ),
          }),
          // #561: batch-setup's cold-path warm-up (install + build) on its own
          // budget, matching `@ai-dossier/worktree-pool`'s own per-issue warm-up
          // budget for the identical work (`WARM_COMMAND_TIMEOUT_MS`) rather than
          // the git-op-tuned `batchExec` above.
          batchWarmExec: createExecFn(WARM_COMMAND_TIMEOUT_MS, {
            onError: (file, args, err) =>
              process.stderr.write(
                `⚠ sched batch warm-up: '${file} ${args.join(' ')}' failed: ${err.message}\n`
              ),
          }),
          runBatchSuite: createBatchSuiteRunner(config),
          runBatchCapability: createBatchCapabilityRunner(),
        };

        const describe = (result: TickResult): string => {
          const parts: string[] = [];
          if (result.spawned.length > 0) parts.push(`spawned ${result.spawned.join(', ')}`);
          if (result.parked.length > 0) parts.push(`parked ${result.parked.join(', ')}`);
          if (result.mergeAccepted.length > 0)
            parts.push(`merge accepted ${result.mergeAccepted.join(', ')}`);
          if (result.staleReconciled.length > 0)
            parts.push(`stale failure reconciled ${result.staleReconciled.join(', ')}`);
          if (result.dependentsUnblocked.length > 0)
            parts.push(`dependents unblocked ${result.dependentsUnblocked.join(', ')}`);
          if (result.labelCleared.length > 0)
            parts.push(`label cleared ${result.labelCleared.join(', ')}`);
          if (result.labelBlocked.length > 0)
            parts.push(`label blocked ${result.labelBlocked.join(', ')}`);
          if (result.labelCheckFailed.length > 0)
            parts.push(`label check unreachable ${result.labelCheckFailed.join(', ')}`);
          if (result.teardownDone.length > 0)
            parts.push(`teardown done ${result.teardownDone.join(', ')}`);
          if (result.teardownFailed.length > 0)
            parts.push(`teardown failed ${result.teardownFailed.join(', ')}`);
          if (result.reportDispatched.length > 0)
            parts.push(`report dispatched ${result.reportDispatched.join(', ')}`);
          if (result.reportWaiting > 0)
            parts.push(`${result.reportWaiting} report(s) waiting for a free slot`);
          if (result.externalAdvances.length > 0)
            parts.push(`externally completed ${result.externalAdvances.join(', ')}`);
          if (result.completed.length > 0) parts.push(`completed ${result.completed.join(', ')}`);
          if (result.redispatched.length > 0)
            parts.push(`redispatched ${result.redispatched.join(', ')}`);
          if (result.failed.length > 0) parts.push(`failed ${result.failed.join(', ')}`);
          if (result.blocked.length > 0)
            parts.push(`blocked ${result.blocked.map((i) => `#${i}`).join(', ')}`);
          return parts.length > 0 ? parts.join(' · ') : 'nothing to do';
        };

        if (opts.once) {
          let result: TickResult;
          try {
            result = tick(deps, engineConfig);
          } catch (err) {
            recordTickFailure(deps, err);
            // Route known package errors through the CLI exit path; any other
            // failure must not surface as an unhandled async rejection (this is
            // the cron path).
            handleKnownError(err);
            fail([`sched tick failed: ${(err as Error).name}: ${(err as Error).message}`]);
          }
          await checkAndHandleEngineStaleness(store, deps.journal, autoUpgradeEnabled, upgradeExec);
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`✓ [${project}] tick: ${describe(result)}`);
          }
          return;
        }

        const interval =
          (engineConfig.reconcile_interval_ms ?? DEFAULT_RECONCILE_INTERVAL_MS) / 1000;
        console.log(
          `▶ Scheduler engine running for ${project} (tick every ${interval}s, Ctrl-C to stop)`
        );
        let stopping = false;
        process.on('SIGINT', () => {
          if (stopping) process.exit(130);
          stopping = true;
          console.log('\n⏹ Stopping engine (spawned agents keep running)…');
        });
        await runLoop(
          deps,
          engineConfig,
          () => stopping,
          (result) => {
            if (!opts.json) console.log(`✓ [${new Date().toISOString()}] ${describe(result)}`);
            else console.log(JSON.stringify({ ts: new Date().toISOString(), ...result }));
            // #537: journal/warn only in the continuous loop — the actual
            // `npm i -g` shell-out (up to UPGRADE_TIMEOUT_MS) only runs from
            // the cron-driven --once path below; running it here would stall
            // reconciliation for however long the install takes. Fire-and-
            // forget: bounded by the check's own short network timeout, never
            // blocks the next tick (onTick is synchronous by contract).
            void checkAndHandleEngineStaleness(store, deps.journal, false, upgradeExec).catch(
              () => {}
            );
          }
        );
        console.log('⏹ Engine stopped');
      } finally {
        store.releaseEngineLease(acquisition.lease);
      }
    });
}

export function registerSchedCommand(program: Command): void {
  const schedCmd = program
    .command('sched')
    .description(
      'Deterministic scheduler core — queue, slots, dispatch, verification, stall ladder (RFC-0001)'
    );

  registerEnqueueSubcommand(schedCmd);
  registerStatusSubcommand(schedCmd);
  registerPauseResumeSubcommand(schedCmd, true);
  registerPauseResumeSubcommand(schedCmd, false);
  registerAbandonSubcommand(schedCmd);
  registerRequeueSubcommand(schedCmd);
  registerAttachPrSubcommand(schedCmd);
  registerStopSubcommand(schedCmd);
  registerReprioritizeSubcommand(schedCmd);
  registerStartSubcommand(schedCmd);
  registerStatsSubcommand(schedCmd);
}
