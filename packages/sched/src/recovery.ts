/**
 * Batch failure recovery (#472, RFC-0001 §F.2/F.8/F.9): what happens when the
 * aggregate suite goes red or the batch PR will not merge.
 *
 * ```
 * validating → attributing → fixing (ONE bounded attempt) → validating
 *                          → evicting (revert the member's commits) → validating
 *   > ⅓ evicted, or a revert conflict → dissolving → members requeued
 * awaiting-merge (CONFLICTING | auto-merge-blocked)
 *                          → rebasing → re-validating → shipping
 *                          → (2nd occurrence) dissolving into two half-batches
 * ```
 *
 * The rules this module exists to enforce:
 *
 * - **Nothing green is discarded.** Shipped and terminal members keep their
 *   outcome through every eviction and dissolve; only active work requeues.
 * - **One fix attempt per member.** A second red suite evicts — it never
 *   re-dispatches, so a batch cannot burn its budget on one broken member.
 * - **A revert never runs half-way.** A conflicting revert is aborted and the
 *   batch dissolves; a worktree left mid-revert would poison every later step.
 * - **The scheduler never calls an LLM.** `beginFixAttempt` returns the command
 *   and prompt for the caller to spawn (dispatch.ts), exactly like #464.
 *
 * State transitions are the typed rails in state.ts; every effect (git, the
 * suite runner, milestone posting, the journal) is injected, so the whole
 * module is testable against scratch repos and fakes.
 */

import {
  type AmbiguousTest,
  attributeByOverlap,
  type BoundaryCommit,
  type FailingTest,
  type MemberFootprint,
  type MemberRange,
  offendersOf,
  SHA_RE,
} from './attribution';
import { type BisectOutcome, runAttributionBisect } from './bisect';
import {
  buildAgentCommand,
  buildFixPrompt,
  DEFAULT_FIX_PROMPT_TEMPLATE,
  DEFAULT_TIER_MODELS,
  resolveDispatch,
} from './dispatch';
import { unitEvent } from './journal';
import type { ExecFn } from './project';
import { findBatch, requeueMember, transitionBatch } from './state';
import {
  type AttributionMethod,
  type BatchEntry,
  DISSOLVE_EVICTION_FRACTION,
  type EvictionRecord,
  type FailureEvidence,
  type FixAttemptRecord,
  type JournalEvent,
  MAX_FIX_ATTEMPTS_PER_MEMBER,
  MAX_REBASE_ATTEMPTS,
  type ModelTier,
  SATISFIED_ISSUE_STATUSES,
  type SchedConfig,
  SchedNotFoundError,
  type SchedState,
  TERMINAL_BATCH_STATUSES,
  TERMINAL_ISSUE_STATUSES,
} from './types';

// --- Injected effects ---

/** The result of one aggregate-suite run. */
export interface SuiteResult {
  ok: boolean;
  /** Failing tests when `ok` is false (empty when the suite passed). */
  failing: FailingTest[];
  detail?: string;
}

/** Re-runs the aggregate suite in the batch checkout (AC2: after every revert/rebase). */
export type SuiteRunner = () => SuiteResult;

/** The journal surface recovery uses (the full `Journal` satisfies it). */
export interface JournalLike {
  append(event: Omit<JournalEvent, 'ts'>, now?: Date): void;
}

/** Batch-line runstate phases (the CLI's `batch-*` vocabulary). */
export type BatchPhase =
  | 'batch-setup'
  | 'batch-validate'
  | 'batch-review'
  | 'batch-ship'
  | 'batch-report';

/** One batch milestone: the phase, its status, and the reason keys (AC5). */
export interface BatchMilestone {
  phase: BatchPhase;
  status: 'done' | 'blocked' | 'awaiting-merge';
  kv: Record<string, string>;
}

/** Posts a batch milestone to the anchor issue; returns whether it landed. */
export type BatchMilestonePoster = (
  anchor: number,
  run: string | null,
  milestone: BatchMilestone
) => boolean;

/** Milestone values carry no spaces (the dossier rule) — collapse them to `-`. */
function milestoneValue(value: string): string {
  return value.trim().replace(/\s+/g, '-');
}

/**
 * The default poster: shells `ai-dossier runstate post`, which validates the
 * phase/status/key contract and refuses a malformed milestone. Never throws —
 * a failed post is journaled by the caller and degrades the audit trail, it
 * does not fail the recovery.
 */
export function createExecMilestonePoster(
  exec: ExecFn,
  opts: { bin?: string; repoDir?: string } = {}
): BatchMilestonePoster {
  const bin = opts.bin ?? 'ai-dossier';
  return (anchor, run, milestone) => {
    const args = [
      'runstate',
      'post',
      '--issue',
      String(anchor),
      '--phase',
      milestone.phase,
      '--status',
      milestone.status,
    ];
    if (run !== null && run !== '') args.push('--run', run);
    for (const [key, value] of Object.entries(milestone.kv)) {
      args.push('--kv', `${key}=${milestoneValue(value)}`);
    }
    return exec(bin, args, opts.repoDir) !== null;
  };
}

/** Everything recovery needs from the outside world. */
export interface RecoveryDeps {
  /** Git (and the milestone CLI, via the default poster) — never throws. */
  exec: ExecFn;
  /** The batch checkout every git effect runs in. */
  repoDir: string;
  journal?: JournalLike;
  postMilestone?: BatchMilestonePoster;
  /** Re-runs the aggregate suite after a revert or a rebase. */
  runSuite?: SuiteRunner;
  now?: () => Date;
}

function clock(deps: RecoveryDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function journal(deps: RecoveryDeps, event: Omit<JournalEvent, 'ts'>, now: Date): void {
  deps.journal?.append(event, now);
}

function batchOrThrow(state: SchedState, batchId: string): BatchEntry {
  const batch = findBatch(state, batchId);
  if (!batch) throw new SchedNotFoundError(`Batch not found: ${batchId}`);
  return batch;
}

/** Patch batch fields without a status change (records, counters). */
function patchBatch(
  state: SchedState,
  batchId: string,
  patch: Partial<BatchEntry>,
  now: Date
): SchedState {
  return {
    ...state,
    batches: state.batches.map((b) =>
      b.id === batchId ? { ...b, ...patch, updated_at: now.toISOString() } : b
    ),
  };
}

/** Post a milestone when an anchor exists; journal the failure when it does not land. */
function post(
  deps: RecoveryDeps,
  batch: BatchEntry,
  milestone: BatchMilestone,
  now: Date
): boolean {
  if (batch.anchor === null || !deps.postMilestone) return false;
  const ok = deps.postMilestone(batch.anchor, batch.run_id, milestone);
  if (!ok) {
    journal(
      deps,
      unitEvent('milestone-post-failed', `batch:${batch.id}`, {
        detail: `${milestone.phase} ${milestone.status}`,
      }),
      now
    );
  }
  return ok;
}

// --- AC1: attribution ---

/** What one attribution pass concluded. */
export interface AttributionOutcome {
  /** How the offenders were identified (`none` when nothing could be attributed). */
  method: AttributionMethod;
  /** Members that own at least one failing test, ascending. */
  offenders: number[];
  /** Failing tests per offending member. */
  attributed: Map<number, FailingTest[]>;
  ambiguous: AmbiguousTest[];
  unattributed: FailingTest[];
  /** The bisect result when stage 2 ran, else null. */
  bisect: BisectOutcome | null;
}

/** Stage-2 inputs: what `git bisect` needs to resolve an ambiguous failure. */
export interface BisectSpec {
  /** Last known-good commit (the batch base). */
  good: string;
  /** Known-bad commit (the batch branch head). */
  bad: string;
  /** Command running ONLY the failing tests. */
  testCommand: readonly string[];
  /** The batch branch's issue-boundary commits, oldest first. */
  boundary: readonly BoundaryCommit[];
}

export interface AttributionInput {
  failing: readonly FailingTest[];
  footprints: readonly MemberFootprint[];
  /** Omit to run overlap only (bisect needs a checkout and boundary commits). */
  bisect?: BisectSpec;
}

/**
 * `validating → attributing`: map the red suite's failures onto members (AC1).
 * Overlap first; `git bisect` only when overlap left something ambiguous or
 * unattributed, and only ever to ADD an offender — a bisect that lands on a
 * non-member commit reports `unattributable` and adds nobody.
 */
export function beginAttribution(
  state: SchedState,
  batchId: string,
  input: AttributionInput,
  deps: RecoveryDeps
): { state: SchedState; outcome: AttributionOutcome } {
  const now = clock(deps);
  const batch = batchOrThrow(state, batchId);
  let next = state;
  if (batch.status !== 'attributing') {
    next = transitionBatch(next, batchId, 'attributing', {}, now);
  }
  journal(
    deps,
    unitEvent('suite-failed', `batch:${batchId}`, { detail: `${input.failing.length} failing` }),
    now
  );

  const overlap = attributeByOverlap(input.failing, input.footprints);
  const attributed = new Map(overlap.attributed);
  let bisect: BisectOutcome | null = null;
  let method: AttributionMethod = attributed.size > 0 ? 'overlap' : 'none';

  const needsBisect = overlap.ambiguous.length > 0 || overlap.unattributed.length > 0;
  if (needsBisect && input.bisect) {
    bisect = runAttributionBisect(deps.exec, {
      repoDir: deps.repoDir,
      good: input.bisect.good,
      bad: input.bisect.bad,
      testCommand: input.bisect.testCommand,
      boundary: input.bisect.boundary,
    });
    if (bisect.kind === 'first-bad') {
      const unresolved = [...overlap.ambiguous.map((a) => a.test), ...overlap.unattributed];
      attributed.set(bisect.issue, [...(attributed.get(bisect.issue) ?? []), ...unresolved]);
      method = 'bisect';
    }
  }

  const outcome: AttributionOutcome = {
    method,
    offenders: offendersOf({ ...overlap, attributed }),
    attributed,
    ambiguous: overlap.ambiguous,
    unattributed: overlap.unattributed,
    bisect,
  };
  journal(
    deps,
    unitEvent('attributed', `batch:${batchId}`, {
      detail: `method=${outcome.method} offenders=${outcome.offenders.join(',') || 'none'}`,
    }),
    now
  );
  return { state: next, outcome };
}

// --- AC2: the one bounded fix attempt ---

/** The fix agent the CALLER spawns — sched builds the instruction, never the LLM call. */
export interface FixDispatch {
  issue: number;
  tier: ModelTier;
  command: string[];
  prompt: string;
}

/**
 * `attributing → fixing`: hand back the ONE bounded fix dispatch for a member
 * (AC2). Returns `dispatch: null` when the member already had its attempt —
 * the caller's next step is then `evictMembers`, never a second dispatch.
 */
export function beginFixAttempt(
  state: SchedState,
  batchId: string,
  issue: number,
  deps: RecoveryDeps,
  opts: { config?: SchedConfig; tests?: readonly FailingTest[] } = {}
): { state: SchedState; dispatch: FixDispatch | null } {
  const now = clock(deps);
  const batch = batchOrThrow(state, batchId);
  const attempts = batch.fix_attempts.filter((a) => a.issue === issue).length;
  if (attempts >= MAX_FIX_ATTEMPTS_PER_MEMBER) {
    return { state, dispatch: null };
  }

  const tier: ModelTier = 'mid';
  const resolved = resolveDispatch(opts.config ?? { max_slots: 1 });
  const dispatch: FixDispatch = {
    issue,
    tier,
    command: buildAgentCommand(resolved.command, tier, issue, {
      ...DEFAULT_TIER_MODELS,
      ...resolved.tierModels,
    }),
    prompt: buildFixPrompt(
      DEFAULT_FIX_PROMPT_TEMPLATE,
      issue,
      batchId,
      (opts.tests ?? []).map((t) => t.id)
    ),
  };

  const record: FixAttemptRecord = { issue, tier, outcome: 'dispatched', at: now.toISOString() };
  let next = state;
  if (batch.status !== 'fixing') {
    next = transitionBatch(next, batchId, 'fixing', {}, now);
  }
  next = patchBatch(next, batchId, { fix_attempts: [...batch.fix_attempts, record] }, now);
  journal(deps, unitEvent('fix-dispatched', `batch:${batchId}`, { issue, tier }), now);
  return { state: next, dispatch };
}

/**
 * `fixing → validating`: record how the fix attempt ended and return the batch
 * to validation, where the suite re-run decides what happens next (AC2). A
 * `red` outcome does NOT evict here — the caller re-runs the suite and calls
 * `evictMembers` if it is still failing, so eviction is always driven by
 * evidence rather than by the fix agent's own claim.
 */
export function resolveFixAttempt(
  state: SchedState,
  batchId: string,
  issue: number,
  outcome: 'green' | 'red',
  deps: RecoveryDeps
): { state: SchedState } {
  const now = clock(deps);
  const batch = batchOrThrow(state, batchId);
  let patched = false;
  const fixAttempts = [...batch.fix_attempts]
    .reverse()
    .map((a) => {
      if (patched || a.issue !== issue || a.outcome !== 'dispatched') return a;
      patched = true;
      return { ...a, outcome };
    })
    .reverse();

  let next = patchBatch(state, batchId, { fix_attempts: fixAttempts }, now);
  if (batch.status === 'fixing') {
    next = transitionBatch(next, batchId, 'validating', {}, now);
  }
  journal(deps, unitEvent('fix-resolved', `batch:${batchId}`, { issue, detail: outcome }), now);
  return { state: next };
}

// --- AC2/AC3: eviction ---

export interface EvictionInput {
  /** Members to evict; eviction-group partners are added automatically. */
  issues: readonly number[];
  /** Short slug recorded on the entry, the eviction record and the milestone. */
  reason: string;
  /** How the offenders were identified (carried into the failure evidence). */
  attribution: AttributionMethod;
  /** Each member's commits on the batch branch (from `memberRanges`). */
  ranges: readonly MemberRange[];
  /** Failing tests per member, for the requeue evidence. */
  failingByMember?: ReadonlyMap<number, FailingTest[]>;
}

export interface EvictionOutcome {
  state: SchedState;
  /** Members whose commits were reverted (includes group partners). */
  evicted: number[];
  /** Members actually put back on the queue (shipped members are not). */
  requeued: number[];
  /** Commits reverted, in the order they were reverted (newest first). */
  reverted: string[];
  /** True when a revert conflicted — the batch dissolves instead. */
  conflict: boolean;
  dissolved: boolean;
  dissolve?: DissolveOutcome;
  /** The post-eviction suite re-run, when a runner was supplied. */
  suite: SuiteResult | null;
}

/**
 * Every member that must leave with `issues`: an eviction group reverts
 * together (RFC-0001 §E.4), because a member built on another's API cannot
 * survive that API's revert.
 */
export function expandEvictionGroups(batch: BatchEntry, issues: readonly number[]): number[] {
  const out = new Set(issues);
  let grew = true;
  while (grew) {
    grew = false;
    for (const group of batch.eviction_groups) {
      if (group.some((m) => out.has(m))) {
        for (const member of group) {
          if (!out.has(member)) {
            out.add(member);
            grew = true;
          }
        }
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * `attributing → evicting`: revert the offending members' commits, requeue them
 * as full-cycle with their failure evidence, re-run the suite, and dissolve if
 * the batch has now lost more than a third of its members (AC2/AC3/AC5).
 *
 * A conflicting revert aborts and dissolves immediately — a half-reverted
 * worktree is not a state any later step can reason about.
 */
export function evictMembers(
  state: SchedState,
  batchId: string,
  input: EvictionInput,
  deps: RecoveryDeps
): EvictionOutcome {
  const now = clock(deps);
  const batch = batchOrThrow(state, batchId);
  const targets = expandEvictionGroups(batch, input.issues);
  let next = state;
  if (batch.status !== 'evicting') {
    next = transitionBatch(next, batchId, 'evicting', {}, now);
  }

  // Revert newest commits first, and later members before earlier ones: a
  // revert applies cleanly only against the tree the commit sat on top of.
  const ordered = [...input.ranges]
    .filter((range) => targets.includes(range.issue))
    .reverse()
    .flatMap((range) => [...range.commits].reverse());
  const revertedByMember = new Map<number, string[]>();
  const reverted: string[] = [];

  for (const range of [...input.ranges].filter((r) => targets.includes(r.issue))) {
    revertedByMember.set(range.issue, []);
  }

  for (const sha of ordered) {
    if (!SHA_RE.test(sha)) {
      return revertConflict(next, batchId, deps, now, reverted, `invalid commit sha ${sha}`);
    }
    if (deps.exec('git', ['revert', '--no-edit', sha], deps.repoDir) === null) {
      // Leave no half-applied revert behind: abort, then `--quit` as the
      // fallback for git versions that refuse the abort outside a sequence.
      if (deps.exec('git', ['revert', '--abort'], deps.repoDir) === null) {
        deps.exec('git', ['revert', '--quit'], deps.repoDir);
      }
      return revertConflict(next, batchId, deps, now, reverted, `git revert ${sha} conflicted`);
    }
    reverted.push(sha);
    const owner = input.ranges.find((r) => r.commits.includes(sha));
    if (owner)
      revertedByMember.set(owner.issue, [...(revertedByMember.get(owner.issue) ?? []), sha]);
  }

  // Requeue every reverted member with its evidence attached (AC2).
  const requeued: number[] = [];
  const records: EvictionRecord[] = [];
  for (const issue of targets) {
    const tests = input.failingByMember?.get(issue) ?? [];
    const memberCommits = revertedByMember.get(issue) ?? [];
    const evidence: FailureEvidence = {
      batch: batchId,
      reason: input.reason,
      failing_tests: tests.map((t) => t.id),
      attribution: input.attribution,
      reverted_commits: memberCommits,
      at: now.toISOString(),
    };
    const result = requeueMember(next, issue, { mode: 'full', batch: null }, input.reason, now, {
      failure_evidence: evidence,
    });
    next = result.state;
    if (result.requeued) requeued.push(issue);
    records.push({
      issue,
      reason: input.reason,
      attribution: input.attribution,
      reverted_commits: memberCommits,
      group: targets.filter((t) => t !== issue),
      at: now.toISOString(),
    });
    journal(
      deps,
      unitEvent('member-evicted', `batch:${batchId}`, {
        issue,
        detail: `${input.reason} reverted=${memberCommits.length}`,
      }),
      now
    );
  }

  next = patchBatch(next, batchId, { evictions: [...batch.evictions, ...records] }, now);
  const evictedBatch = batchOrThrow(next, batchId);
  post(
    deps,
    evictedBatch,
    {
      phase: 'batch-validate',
      status: 'blocked',
      kv: {
        reason: input.reason,
        evicted: targets.join(',') || 'none',
        requeued: requeued.join(',') || 'none',
        reverted: String(reverted.length),
        attribution: input.attribution,
      },
    },
    now
  );

  // Back to validation with the suite re-run (AC2: "re-run the suite").
  const suite = deps.runSuite ? deps.runSuite() : null;
  next = transitionBatch(next, batchId, 'validating', {}, now);

  if (checkDissolveTrigger(batchOrThrow(next, batchId))) {
    const dissolve = dissolveBatch(
      next,
      batchId,
      { strategy: 'full', reason: 'eviction-threshold' },
      deps
    );
    return {
      state: dissolve.state,
      evicted: targets,
      requeued,
      reverted,
      conflict: false,
      dissolved: true,
      dissolve,
      suite,
    };
  }

  return {
    state: next,
    evicted: targets,
    requeued,
    reverted,
    conflict: false,
    dissolved: false,
    suite,
  };
}

/** A conflicting (or unusable) revert: dissolve the batch rather than half-revert it (AC3). */
function revertConflict(
  state: SchedState,
  batchId: string,
  deps: RecoveryDeps,
  now: Date,
  reverted: string[],
  detail: string
): EvictionOutcome {
  journal(deps, unitEvent('revert-conflict', `batch:${batchId}`, { detail }), now);
  const dissolve = dissolveBatch(
    state,
    batchId,
    { strategy: 'full', reason: 'revert-conflict' },
    deps
  );
  return {
    state: dissolve.state,
    evicted: [],
    requeued: dissolve.requeued,
    reverted,
    conflict: true,
    dissolved: true,
    dissolve,
    suite: null,
  };
}

/**
 * Whether the batch has lost STRICTLY more than a third of its members
 * (RFC-0001 §F.8). Counted over distinct evicted members, so a member evicted
 * once and recorded twice never inflates the trigger.
 */
export function checkDissolveTrigger(batch: BatchEntry): boolean {
  if (batch.members.length === 0) return false;
  const evicted = new Set(batch.evictions.map((e) => e.issue)).size;
  return evicted > batch.members.length * DISSOLVE_EVICTION_FRACTION;
}

// --- AC3: dissolve ---

export interface DissolveOptions {
  /**
   * `full` requeues every unshipped member as its own full-cycle run;
   * `halved` splits them into two fresh `forming` batches (§F.9's answer to a
   * batch that keeps conflicting: smaller batches, not abandoned work).
   */
  strategy: 'full' | 'halved';
  reason: string;
  /** Milestone phase to report under (default `batch-validate`; ship uses `batch-ship`). */
  milestonePhase?: BatchPhase;
}

export interface DissolveOutcome {
  state: SchedState;
  /** Members put back on the queue. */
  requeued: number[];
  /** Members whose work was kept as-is (shipped, merged, terminal). */
  preserved: number[];
  /** Ids of the half-batches created by the `halved` strategy. */
  newBatches: string[];
}

/**
 * Dissolve a batch (AC3): abandon the branch, requeue every unshipped member,
 * and report what was preserved. Shipped/terminal members are never touched —
 * "nothing green is discarded" is the whole point of dissolving rather than
 * failing the batch.
 */
export function dissolveBatch(
  state: SchedState,
  batchId: string,
  opts: DissolveOptions,
  deps: RecoveryDeps
): DissolveOutcome {
  const now = clock(deps);
  const batch = batchOrThrow(state, batchId);
  if (TERMINAL_BATCH_STATUSES.has(batch.status)) {
    throw new SchedNotFoundError(
      `Batch ${batchId} is already ${batch.status} — nothing to dissolve`
    );
  }

  const unshipped: number[] = [];
  const preserved: number[] = [];
  for (const issue of batch.members) {
    const entry = state.entries.find((e) => e.issue === issue);
    if (!entry) continue;
    if (TERMINAL_ISSUE_STATUSES.has(entry.status) || SATISFIED_ISSUE_STATUSES.has(entry.status)) {
      preserved.push(issue);
    } else {
      unshipped.push(issue);
    }
  }

  let next = transitionBatch(state, batchId, 'dissolving', {}, now);
  const newBatches: string[] = [];
  const requeued: number[] = [];

  if (opts.strategy === 'halved' && unshipped.length > 0) {
    const pivot = Math.ceil(unshipped.length / 2);
    const halves: Array<{ id: string; members: number[] }> = [
      { id: `${batchId}-a`, members: unshipped.slice(0, pivot) },
      { id: `${batchId}-b`, members: unshipped.slice(pivot) },
    ].filter((h) => h.members.length > 0);

    for (const half of halves) {
      next = {
        ...next,
        batches: [
          ...next.batches,
          {
            id: half.id,
            status: 'forming',
            members: [...half.members],
            base_branch: batch.base_branch,
            executing_member: 0,
            anchor: batch.anchor,
            branch: null,
            run_id: batch.run_id,
            // Groups survive the split, restricted to the members that landed
            // in this half — a group spanning both halves is no longer a group.
            eviction_groups: batch.eviction_groups
              .map((group) => group.filter((m) => half.members.includes(m)))
              .filter((group) => group.length > 1),
            evictions: [],
            fix_attempts: [],
            rebase_attempts: 0,
            created_at: now.toISOString(),
            updated_at: now.toISOString(),
          },
        ],
      };
      newBatches.push(half.id);
      for (const issue of half.members) {
        const result = requeueMember(
          next,
          issue,
          { mode: 'slot', batch: half.id },
          opts.reason,
          now
        );
        next = result.state;
        if (result.requeued) requeued.push(issue);
      }
    }
    journal(
      deps,
      unitEvent('batch-split', `batch:${batchId}`, { detail: newBatches.join(',') }),
      now
    );
  } else {
    for (const issue of unshipped) {
      const result = requeueMember(next, issue, { mode: 'full', batch: null }, opts.reason, now);
      next = result.state;
      if (result.requeued) requeued.push(issue);
    }
  }

  next = transitionBatch(next, batchId, 'dissolved', {}, now);
  journal(
    deps,
    unitEvent('batch-dissolved', `batch:${batchId}`, {
      detail: `${opts.reason} strategy=${opts.strategy} requeued=${requeued.length} preserved=${preserved.length}`,
    }),
    now
  );
  post(
    deps,
    batch,
    {
      phase: opts.milestonePhase ?? 'batch-validate',
      status: 'blocked',
      kv: {
        reason: opts.reason,
        dissolved: 'true',
        strategy: opts.strategy,
        requeued: requeued.join(',') || 'none',
        preserved: preserved.join(',') || 'none',
        ...(newBatches.length > 0 ? { split_into: newBatches.join(',') } : {}),
      },
    },
    now
  );

  return { state: next, requeued, preserved, newBatches };
}

// --- AC4: the batch PR conflict path ---

export type PrConflictAction = 'reship' | 'dissolved';

export interface PrConflictOutcome {
  state: SchedState;
  action: PrConflictAction;
  /** True when the rebase itself succeeded. */
  rebased: boolean;
  /** The post-rebase suite re-run, when a runner was supplied. */
  suite: SuiteResult | null;
  dissolve?: DissolveOutcome;
}

/** A branch name safe to interpolate into git argv (groundtruth.ts's ref pattern). */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * The batch PR came back CONFLICTING or `auto-merge-blocked` (AC4).
 *
 * First occurrence: rebase the batch branch onto the base, re-run the suite,
 * and re-ship once. Second occurrence — or a rebase that conflicts, or a suite
 * that is red after a clean rebase — dissolves the batch into two half-batches:
 * the work is kept, the batch that could not land is not retried a third time.
 */
export function handlePrConflict(
  state: SchedState,
  batchId: string,
  deps: RecoveryDeps,
  opts: { reason?: string } = {}
): PrConflictOutcome {
  const now = clock(deps);
  const batch = batchOrThrow(state, batchId);
  const reason = opts.reason ?? 'pr-conflict';

  // Both paths enter `rebasing` — it is the honest state for "the merge came
  // back blocked" — and only the attempt count decides whether a rebase runs.
  let next = transitionBatch(state, batchId, 'rebasing', {}, now);

  if (batch.rebase_attempts >= MAX_REBASE_ATTEMPTS) {
    const dissolve = dissolveBatch(
      next,
      batchId,
      { strategy: 'halved', reason: `${reason}-recurred`, milestonePhase: 'batch-ship' },
      deps
    );
    return { state: dissolve.state, action: 'dissolved', rebased: false, suite: null, dissolve };
  }

  next = patchBatch(next, batchId, { rebase_attempts: batch.rebase_attempts + 1 }, now);

  const base = batch.base_branch;
  if (!REF_RE.test(base)) {
    const dissolve = dissolveBatch(
      next,
      batchId,
      { strategy: 'halved', reason: 'invalid-base-branch', milestonePhase: 'batch-ship' },
      deps
    );
    return { state: dissolve.state, action: 'dissolved', rebased: false, suite: null, dissolve };
  }

  deps.exec('git', ['fetch', 'origin', '--', base], deps.repoDir);
  if (deps.exec('git', ['rebase', `origin/${base}`], deps.repoDir) === null) {
    // Never leave the worktree mid-rebase.
    deps.exec('git', ['rebase', '--abort'], deps.repoDir);
    const dissolve = dissolveBatch(
      next,
      batchId,
      { strategy: 'halved', reason: 'rebase-conflict', milestonePhase: 'batch-ship' },
      deps
    );
    return { state: dissolve.state, action: 'dissolved', rebased: false, suite: null, dissolve };
  }
  journal(deps, unitEvent('batch-rebased', `batch:${batchId}`, { detail: base }), now);

  next = transitionBatch(next, batchId, 're-validating', {}, now);
  const suite = deps.runSuite ? deps.runSuite() : null;
  if (suite !== null && !suite.ok) {
    const dissolve = dissolveBatch(
      next,
      batchId,
      { strategy: 'halved', reason: 'rebase-suite-red', milestonePhase: 'batch-ship' },
      deps
    );
    return { state: dissolve.state, action: 'dissolved', rebased: true, suite, dissolve };
  }

  next = transitionBatch(next, batchId, 'shipping', {}, now);
  post(
    deps,
    batchOrThrow(next, batchId),
    {
      phase: 'batch-ship',
      status: 'blocked',
      kv: { reason, rebased: base, rebase_attempts: String(batch.rebase_attempts + 1) },
    },
    now
  );
  return { state: next, action: 'reship', rebased: true, suite };
}
