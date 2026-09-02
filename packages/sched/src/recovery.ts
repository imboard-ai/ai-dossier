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
 * - **A revert is never left mid-conflict.** The conflicting revert is aborted
 *   so the worktree is clean, but the reverts that already landed stay applied
 *   — which is exactly why the batch dissolves and the branch is abandoned
 *   rather than reused.
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
  SAFE_REF_RE,
  SHA_RE,
} from './attribution';
import { type BisectOutcome, runAttributionBisect } from './bisect';
import {
  buildFixPrompt,
  journalCmdModelFields,
  resolveDispatch,
  resolveTierSpawn,
} from './dispatch';
import { unitEvent } from './journal';
import type { ExecFn } from './project';
import {
  createBatch,
  findBatch,
  isPreservedMember,
  patchBatch,
  requeueMember,
  transitionBatch,
} from './state';
import {
  type AttributionMethod,
  type BatchEntry,
  type BatchPhase,
  DEFAULT_DISSOLVE_POLICY,
  DEFAULT_MAX_SLOTS,
  type DissolvePolicy,
  type EvictionRecord,
  type FailureEvidence,
  FIX_ATTEMPT_TIER,
  type FixAttemptRecord,
  IllegalTransitionError,
  type JournalEvent,
  MAX_FIX_ATTEMPTS_PER_MEMBER,
  MAX_REBASE_ATTEMPTS,
  type ModelTier,
  resolveDissolvePolicy,
  type SchedConfig,
  SchedNotFoundError,
  type SchedState,
  TERMINAL_BATCH_STATUSES,
} from './types';

// --- Injected effects ---

/** The result of one aggregate-suite run. */
export interface SuiteResult {
  ok: boolean;
  /** Failing tests when `ok` is false (empty when the suite passed). */
  failing: FailingTest[];
  /**
   * Whether the runner could actually parse a report out of the suite run
   * (#562) — irrelevant when `ok` is true. `false` means the report itself
   * was empty, unparseable, or never produced at all (spawn error, timeout),
   * which is NOT the same as a parseable report naming zero failures: a
   * caller that dissolves a batch on "0 failing tests to attribute" must be
   * able to tell those two apart first. Omitted defaults to `true` — runners
   * written before this field existed keep going through the ordinary
   * attribution path unchanged.
   */
  readable?: boolean;
  detail?: string;
}

/** Re-runs the aggregate suite in the batch checkout (AC2: after every revert/rebase). */
export type SuiteRunner = () => SuiteResult;

/** The journal surface recovery uses (the full `Journal` satisfies it). */
export interface JournalLike {
  append(event: Omit<JournalEvent, 'ts'>, now?: Date): void;
}

/**
 * One batch milestone: the phase, its status, and the reason keys (AC5).
 *
 * The status set is per-phase because the CLI's `BATCH_SPECS` is: only
 * `batch-ship` accepts `awaiting-merge`. A flat union would typecheck a
 * milestone the CLI rejects at runtime, which is exactly the failure this
 * vocabulary exists to prevent.
 */
export type BatchMilestone =
  | {
      phase: 'batch-ship';
      status: 'done' | 'blocked' | 'awaiting-merge';
      kv: Record<string, string>;
    }
  | {
      phase: Exclude<BatchPhase, 'batch-ship'>;
      status: 'done' | 'blocked';
      kv: Record<string, string>;
    };

/**
 * Posts a batch milestone to the anchor issue; returns whether it landed.
 *
 * `run` is required, not nullable: `ai-dossier runstate post --run` is a
 * required option, so a batch without a run id cannot post at all — `post()`
 * journals that case rather than building a command the CLI would reject.
 */
export type BatchMilestonePoster = (
  anchor: number,
  run: string,
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
      '--run',
      run,
    ];
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
  /** Per-project dissolve threshold policy (#563); defaults to `DEFAULT_DISSOLVE_POLICY`. */
  dissolvePolicy?: DissolvePolicy;
  now?: () => Date;
}

function clock(deps: RecoveryDeps): Date {
  return deps.now ? deps.now() : new Date();
}

/**
 * Re-run the aggregate suite, treating a runner that THROWS as a red suite.
 *
 * The re-run happens after `git revert` has already rewritten the branch, and
 * an exception escaping here would discard the whole eviction — reverted
 * commits on the branch, but a state file still calling the members healthy.
 */
function runSuite(deps: RecoveryDeps, batchId: string, now: Date): SuiteResult | null {
  if (!deps.runSuite) return null;
  try {
    return deps.runSuite();
  } catch (err) {
    const detail = `suite runner threw: ${(err as Error).message}`;
    journal(deps, unitEvent('suite-failed', `batch:${batchId}`, { detail }), now);
    // Consistent with SuiteResult.readable's contract (#562): a throw is "no
    // report produced", not a parseable report naming zero failures.
    return { ok: false, failing: [], readable: false, detail };
  }
}

function journal(deps: RecoveryDeps, event: Omit<JournalEvent, 'ts'>, now: Date): void {
  deps.journal?.append(event, now);
}

function batchOrThrow(state: SchedState, batchId: string): BatchEntry {
  const batch = findBatch(state, batchId);
  if (!batch) throw new SchedNotFoundError(`Batch not found: ${batchId}`);
  return batch;
}

/**
 * Run one git command, journaling it when it fails.
 *
 * `ExecFn` collapses every failure into `null` — a genuine merge conflict, a
 * bad object, a missing binary and an expired lock all look identical. The
 * decisions here (evict? dissolve?) hang off those nulls, so the command that
 * produced one is always recorded; without it an operator sees a dissolve with
 * no way to tell a conflict from a broken environment.
 */
function git(deps: RecoveryDeps, args: string[], batchId: string, now: Date): string | null {
  const out = deps.exec('git', args, deps.repoDir);
  if (out === null) {
    journal(
      deps,
      unitEvent('git-failed', `batch:${batchId}`, { detail: `git ${args.join(' ')}` }),
      now
    );
  }
  return out;
}

/**
 * Post a milestone (AC5), or journal the one that could not be posted.
 *
 * A milestone is the operator's only record of an eviction or dissolve, so
 * every path that fails to post one says so in the journal — including the
 * "no anchor / no run id / no poster" skips, which are silent by construction
 * otherwise. The journalled detail carries the full key set so the post can be
 * reconstructed by hand.
 */
function post(
  deps: RecoveryDeps,
  batch: BatchEntry,
  milestone: BatchMilestone,
  now: Date
): boolean {
  const rendered = Object.entries(milestone.kv)
    .map(([key, value]) => `${key}=${milestoneValue(value)}`)
    .join(' ');
  const describe = (why: string): void => {
    journal(
      deps,
      unitEvent('milestone-post-failed', `batch:${batch.id}`, {
        detail: `${milestone.phase} ${milestone.status} ${rendered} (${why})`,
      }),
      now
    );
  };

  if (batch.anchor === null) {
    describe('batch has no anchor issue to post to');
    return false;
  }
  if (batch.run_id === null) {
    describe('batch has no run id — runstate post requires one');
    return false;
  }
  if (!deps.postMilestone) {
    describe('no milestone poster configured');
    return false;
  }
  const ok = deps.postMilestone(batch.anchor, batch.run_id, milestone);
  if (!ok) describe('runstate post failed');
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
    unitEvent('suite-failed', `batch:${batchId}`, {
      // Zero failing tests reaching attribution is not "the suite passed" — it
      // is a report nothing could be read out of, which looks identical to
      // green unless the line says so.
      detail:
        input.failing.length === 0
          ? '0 failing — nothing to attribute (the suite report may be empty or unparseable)'
          : `${input.failing.length} failing`,
    }),
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
      onWarn: (detail) =>
        journal(deps, unitEvent('git-failed', `batch:${batchId}`, { detail }), now),
    });
    if (bisect.kind === 'first-bad') {
      const unresolved = [...overlap.ambiguous.map((a) => a.test), ...overlap.unattributed];
      attributed.set(bisect.issue, [...(attributed.get(bisect.issue) ?? []), ...unresolved]);
      method = 'bisect';
    }
  }

  const outcome: AttributionOutcome = {
    method,
    offenders: offendersOf(attributed),
    attributed,
    ambiguous: overlap.ambiguous,
    unattributed: overlap.unattributed,
    bisect,
  };
  // `method=none offenders=none` is the state that precedes a blanket dissolve,
  // so the line has to say WHY nothing was attributed — whether bisect was
  // never asked for, errored, or landed on a non-member commit.
  const bisectNote =
    bisect === null
      ? needsBisect
        ? 'bisect=not-requested'
        : 'bisect=not-needed'
      : `bisect=${bisect.kind}${'sha' in bisect ? `@${bisect.sha}` : ''}${
          'detail' in bisect ? ` (${bisect.detail})` : ''
        }`;
  journal(
    deps,
    unitEvent('attributed', `batch:${batchId}`, {
      detail:
        `method=${outcome.method} offenders=${outcome.offenders.join(',') || 'none'} ` +
        `ambiguous=${outcome.ambiguous.length} unattributed=${outcome.unattributed.length} ${bisectNote}`,
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
    // Journaled, not silent: otherwise the trail shows one `fix-dispatched`
    // and then a `member-evicted` with nothing explaining why no second fix
    // was tried.
    journal(
      deps,
      unitEvent('fix-resolved', `batch:${batchId}`, {
        issue,
        detail: `refused: ${attempts}/${MAX_FIX_ATTEMPTS_PER_MEMBER} attempts already used — next step is eviction`,
      }),
      now
    );
    return { state, dispatch: null };
  }

  const tier = FIX_ATTEMPT_TIER;
  // `max_slots` is irrelevant here — only the command/prompt/tier-model parts
  // of the resolved dispatch are used — but SchedConfig requires it.
  const resolved = resolveDispatch(opts.config ?? { max_slots: DEFAULT_MAX_SLOTS });
  const spawnSpec = resolveTierSpawn(resolved, tier, issue);
  const dispatch: FixDispatch = {
    issue,
    tier,
    command: spawnSpec.cmd,
    prompt: buildFixPrompt(
      resolved.fixPrompt,
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
  journal(
    deps,
    unitEvent('fix-dispatched', `batch:${batchId}`, {
      issue,
      tier,
      ...journalCmdModelFields(spawnSpec),
    }),
    now
  );
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
  // The most recent still-open attempt for this member.
  const idx = batch.fix_attempts.findLastIndex(
    (a) => a.issue === issue && a.outcome === 'dispatched'
  );
  const fixAttempts =
    idx === -1
      ? batch.fix_attempts
      : batch.fix_attempts.map((a, i) => (i === idx ? { ...a, outcome } : a));

  let next = patchBatch(state, batchId, { fix_attempts: fixAttempts }, now);
  if (batch.status === 'fixing') {
    next = transitionBatch(next, batchId, 'validating', {}, now);
  }
  journal(
    deps,
    unitEvent('fix-resolved', `batch:${batchId}`, {
      issue,
      detail: idx === -1 ? `${outcome} (no matching dispatched attempt on record)` : outcome,
    }),
    now
  );
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
  /**
   * True only when the batch actually reached `dissolved`. `false` covers
   * two different cases: the dissolve threshold was never crossed (`dissolve`
   * below is `undefined`), OR it was crossed but `strategy: 'partial'`
   * (#563) preserved the survivors instead — the batch is then already in
   * `reviewing`, not untouched. Check `dissolve` for which case applies.
   */
  dissolved: boolean;
  /** Set whenever `dissolveBatch` was invoked at all, regardless of whether it dissolved or preserved. */
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
  // Restricted to actual members: a group naming a stray issue would otherwise
  // produce an eviction record for a non-member, which then counts against
  // `members.length` in the dissolve trigger and dissolves the batch early.
  return [...out].filter((issue) => batch.members.includes(issue)).sort((a, b) => a - b);
}

/**
 * The targets' commits in the order a revert must walk them: newest first
 * ACROSS members, not member by member.
 *
 * Grouping by member loses branch order, and reverting an older commit while a
 * newer one still sits on top of it is precisely what makes `git revert`
 * conflict — which dissolves the whole batch. For a branch `A1 B1 A2 B2`,
 * evicting both members reverts `B2 A2 B1 A1`.
 */
function orderRevertCommits(ranges: readonly MemberRange[], targets: readonly number[]): string[] {
  return ranges
    .filter((range) => targets.includes(range.issue))
    .flatMap((range) => range.commits.map((sha, i) => ({ sha, position: range.positions[i] ?? i })))
    .sort((a, b) => b.position - a.position)
    .map((commit) => commit.sha);
}

/**
 * `attributing → evicting`: revert the offending members' commits, requeue them
 * as full-cycle with their failure evidence, re-run the suite, and check the
 * batch's configurable dissolve threshold (`DissolvePolicy`, AC2/AC3/AC5).
 * Crossing it has two outcomes (#563): if the re-run suite came back green
 * for the survivors, the batch is PRESERVED — trimmed to its survivors and
 * carried straight to `reviewing`, only the evicted members requeue; a red
 * or unreadable re-run dissolves the batch in full, as before.
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

  // An eviction group can pull in a member that already shipped. Reverting its
  // commits would destroy merged work while `requeueMember` (rightly) refuses
  // to requeue it — the batch would then report a member as shipped with its
  // code gone. Dissolving instead keeps the invariant: nothing green is
  // discarded, and the unshipped members are requeued intact.
  const shipped = targets.filter((issue) => {
    const entry = state.entries.find((e) => e.issue === issue);
    return entry !== undefined && isPreservedMember(entry);
  });
  if (shipped.length > 0) {
    journal(
      deps,
      unitEvent('revert-conflict', `batch:${batchId}`, {
        detail: `eviction group pulls in already-shipped member(s) ${shipped.join(',')} — dissolving instead of reverting merged work`,
      }),
      now
    );
    const dissolve = dissolveBatch(
      state,
      batchId,
      { strategy: 'full', reason: 'evicts-shipped-member' },
      deps
    );
    return {
      state: dissolve.state,
      evicted: [],
      requeued: dissolve.requeued,
      reverted: [],
      conflict: true,
      dissolved: true,
      dissolve,
      suite: null,
    };
  }

  let next = state;
  if (batch.status !== 'evicting') {
    next = transitionBatch(next, batchId, 'evicting', {}, now);
  }

  const ordered = orderRevertCommits(input.ranges, targets);
  // Validate the WHOLE plan before touching the repo: rejecting a malformed
  // sha mid-loop would leave the earlier reverts committed.
  const malformed = ordered.find((sha) => !SHA_RE.test(sha));
  if (malformed !== undefined) {
    return revertConflict(next, batchId, targets, deps, now, [], `invalid commit sha ${malformed}`);
  }

  const revertedByMember = new Map<number, string[]>();
  for (const range of input.ranges) {
    if (targets.includes(range.issue)) revertedByMember.set(range.issue, []);
  }
  const reverted: string[] = [];

  // Reverts land as commits before any state is persisted, so a crash between
  // the two would re-revert on the next run — and a double revert re-applies
  // the broken change. Skip what the branch already carries.
  const history = deps.exec('git', ['log', '--format=%B', '-n', '500'], deps.repoDir) ?? '';

  for (const sha of ordered) {
    const owner = input.ranges.find((r) => r.commits.includes(sha));
    const record = (): void => {
      reverted.push(sha);
      if (owner) {
        revertedByMember.set(owner.issue, [...(revertedByMember.get(owner.issue) ?? []), sha]);
      }
    };
    if (history.includes(`This reverts commit ${sha}`)) {
      record();
      continue;
    }
    if (git(deps, ['revert', '--no-edit', sha], batchId, now) === null) {
      // Leave no half-applied revert behind: abort, then `--quit` plus a hard
      // reset as the fallback for git versions that refuse the abort outside a
      // sequence (`--quit` alone KEEPS the conflicted index).
      let clean = git(deps, ['revert', '--abort'], batchId, now) !== null;
      if (!clean) {
        git(deps, ['revert', '--quit'], batchId, now);
        clean = git(deps, ['reset', '--hard', 'HEAD'], batchId, now) !== null;
      }
      return revertConflict(
        next,
        batchId,
        targets,
        deps,
        now,
        reverted,
        `git revert ${sha} conflicted${clean ? '' : ' — and the cleanup failed; this checkout is left mid-revert and must not be reused'}`
      );
    }
    record();
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
        // A member with no commits is NOT a clean eviction: its work is still
        // on the branch while the queue says it was evicted, so the batch would
        // ship code it believes it removed. `reverted=0` alone reads as "an
        // empty range", which is why this says it in words.
        detail:
          memberCommits.length === 0
            ? `${input.reason} reverted=0 — NO commits found for this member on the batch branch; its work was NOT reverted`
            : `${input.reason} reverted=${memberCommits.length}`,
      }),
      now
    );
  }

  next = patchBatch(next, batchId, { evictions: [...batch.evictions, ...records] }, now);
  const withoutCommits = targets.filter((t) => (revertedByMember.get(t) ?? []).length === 0);
  post(
    deps,
    batchOrThrow(next, batchId),
    {
      phase: 'batch-validate',
      status: 'blocked',
      kv: {
        reason: input.reason,
        evicted: targets.join(',') || 'none',
        requeued: requeued.join(',') || 'none',
        reverted: String(reverted.length),
        attribution: input.attribution,
        ...(withoutCommits.length > 0 ? { no_commits: withoutCommits.join(',') } : {}),
      },
    },
    now
  );

  // Back to validation with the suite re-run (AC2: "re-run the suite").
  const suite = runSuite(deps, batchId, now);
  next = transitionBatch(next, batchId, 'validating', {}, now);

  const dissolvePolicy = resolveDissolvePolicy(deps.dissolvePolicy);
  if (checkDissolveTrigger(batchOrThrow(next, batchId), dissolvePolicy)) {
    // A fresh green suite for the survivors (#563) means their work is still
    // safe to ship as-is — dissolve only the evicted members, not the whole
    // batch. A red or unreadable suite means the survivors themselves cannot
    // be trusted, so the batch dissolves in full, as before. A member with
    // NO commits found on the branch (`withoutCommits`, computed above) was
    // never actually removed from the branch despite being marked evicted —
    // shipping the "survivors" would ship its un-reverted work too, so that
    // also forces `full`.
    const survivorsGreen = suite !== null && suite.ok === true && withoutCommits.length === 0;
    // Why `full` was chosen over `partial` (or why `partial` was still safe) —
    // distinct from a green suite, since "no suite runner configured" and "a
    // genuinely red suite" both fall to `full` but mean very different things
    // to an operator reading the journal.
    const reason = survivorsGreen
      ? 'eviction-threshold'
      : withoutCommits.length > 0
        ? 'eviction-threshold-unreverted-member'
        : suite === null
          ? 'eviction-threshold-suite-unavailable'
          : 'eviction-threshold-suite-red';
    const dissolve = dissolveBatch(
      next,
      batchId,
      { strategy: survivorsGreen ? 'partial' : 'full', reason },
      deps
    );
    // Not simply `!survivorsGreen`: `dissolveBatch` itself falls through to a
    // full dissolve when `partial` finds zero survivors (every member
    // evicted), so the actual batch status is the only reliable signal.
    const dissolved = findBatch(dissolve.state, batchId)?.status === 'dissolved';
    return {
      state: dissolve.state,
      evicted: targets,
      // The surviving members the dissolve requeued belong here too — a caller
      // reading `requeued` must see everything that went back on the queue.
      requeued: [...new Set([...requeued, ...dissolve.requeued])].sort((a, b) => a - b),
      reverted,
      conflict: false,
      dissolved,
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

/**
 * A conflicting (or unusable) revert: abandon the batch rather than continue on
 * a partly-reverted branch (AC3).
 *
 * The reverts that already succeeded stay committed — they are named in the
 * journal line because they ride along on the abandoned branch, which is
 * exactly why the branch is abandoned rather than reused.
 */
function revertConflict(
  state: SchedState,
  batchId: string,
  targets: readonly number[],
  deps: RecoveryDeps,
  now: Date,
  reverted: string[],
  detail: string
): EvictionOutcome {
  journal(
    deps,
    unitEvent('revert-conflict', `batch:${batchId}`, {
      detail: `${detail}; already applied and left on the abandoned branch: ${reverted.join(',') || 'none'}`,
    }),
    now
  );
  const dissolve = dissolveBatch(
    state,
    batchId,
    { strategy: 'full', reason: 'revert-conflict' },
    deps
  );
  return {
    state: dissolve.state,
    evicted: [...targets],
    requeued: dissolve.requeued,
    reverted,
    conflict: true,
    dissolved: true,
    dissolve,
    suite: null,
  };
}

/**
 * Whether the batch has lost more evictions than its dissolve threshold
 * tolerates (RFC-0001 §F.8, floor raised by #563). Counted over distinct
 * evicted members, so a member evicted once and recorded twice never
 * inflates the trigger. The threshold is `max(ceil(N × fraction),
 * min_evictions_before_dissolve)` — see `DissolvePolicy` for why `ceil`
 * matters at small N.
 */
export function checkDissolveTrigger(
  batch: BatchEntry,
  policy: DissolvePolicy = DEFAULT_DISSOLVE_POLICY
): boolean {
  if (batch.members.length === 0) return false;
  const threshold = dissolveThreshold(batch.members.length, policy);
  return evictedMemberIds(batch).size > threshold;
}

/**
 * `max(ceil(N × fraction), min_evictions_before_dissolve)` — the shared
 * threshold math, clamped below `N` so a batch that loses every member is
 * always reachable-dissolvable regardless of the configured floor. Without
 * the clamp, N=1 is a degenerate case: `ceil(1 × ⅓) = 1` already equals `N`,
 * so `evicted > threshold` can never be true — a 1-member batch's only
 * member could be evicted and the batch would never dissolve. The clamp
 * also caps a `min_evictions_before_dissolve` a project configured too high
 * for a given batch size, rather than letting it disable dissolution outright.
 */
function dissolveThreshold(memberCount: number, policy: DissolvePolicy): number {
  const threshold = Math.max(
    Math.ceil(memberCount * policy.fraction),
    policy.min_evictions_before_dissolve
  );
  return Math.min(threshold, memberCount - 1);
}

/**
 * Distinct evicted member ids, however many times each was recorded — the
 * one definition of "which members are out" that `checkDissolveTrigger`,
 * `dissolveBatch`'s policy-input count, and `preserveSurvivors`'s survivor
 * computation all share.
 */
function evictedMemberIds(batch: BatchEntry): Set<number> {
  return new Set(batch.evictions.map((e) => e.issue));
}

// --- AC3: dissolve ---

export interface DissolveOptions {
  /**
   * `full` requeues every unshipped member as its own full-cycle run;
   * `halved` splits them into two fresh `forming` batches (§F.9's answer to a
   * batch that keeps conflicting: smaller batches, not abandoned work);
   * `partial` (#563) keeps the batch alive and ships only the survivors,
   * requeuing just the evicted members — used when a fresh suite re-run
   * already confirmed the survivors are green, so nothing green is
   * discarded even though the batch crossed the dissolve threshold.
   */
  strategy: 'full' | 'halved' | 'partial';
  reason: string;
  /** Milestone phase to report under (default `batch-validate`; ship uses `batch-ship`). */
  milestonePhase?: BatchPhase;
}

export interface DissolveOutcome {
  state: SchedState;
  /** Members put back on the queue. */
  requeued: number[];
  /**
   * Members whose work was kept as-is: shipped/merged/terminal on `full` and
   * `halved`, OR — for `partial` — the survivors kept in the batch to ship
   * together (not yet shipped themselves, but not discarded either).
   */
  preserved: number[];
  /** Ids of the half-batches created by the `halved` strategy. */
  newBatches: string[];
}

/**
 * Dissolve a batch (AC3): mark it `dissolved`, requeue every unshipped member,
 * and report what was preserved. Shipped/terminal members are never touched —
 * "nothing green is discarded" is the whole point of dissolving rather than
 * failing the batch.
 *
 * `strategy: 'partial'` (#563) is a different shape entirely — the batch
 * never becomes `dissolved`, so it is handled by `preserveSurvivors` before
 * any of the `dissolving`/`dissolved` transitions below run.
 *
 * No git runs here: the batch branch is simply left behind unmerged. Sched
 * deletes nothing, so an operator can still inspect what the batch built.
 */
export function dissolveBatch(
  state: SchedState,
  batchId: string,
  opts: DissolveOptions,
  deps: RecoveryDeps
): DissolveOutcome {
  const now = clock(deps);
  const batch = batchOrThrow(state, batchId);
  // `partial`'s target is `reviewing` (only legal from `validating`), never
  // `dissolving` — naming the wrong target here would blame a transition
  // `partial` never attempts. Checked before the generic terminal guard so a
  // terminal batch gets this message too when the caller asked for `partial`.
  if (opts.strategy === 'partial' && batch.status !== 'validating') {
    throw new IllegalTransitionError('batch', batch.status, 'reviewing');
  }
  if (TERMINAL_BATCH_STATUSES.has(batch.status)) {
    // The batch WAS found — this is an illegal edge, not a missing id, and a
    // caller catching SchedNotFoundError to mean "unknown batch" would misroute it.
    throw new IllegalTransitionError('batch', batch.status, 'dissolving');
  }

  // Policy inputs recorded on every dissolve decision (AC3), regardless of
  // which strategy or reason drove it — "what did the batch look like when
  // this was decided?" is always answerable from the journal/milestone.
  const dissolvePolicy = resolveDissolvePolicy(deps.dissolvePolicy);
  const policyInputs = {
    memberCount: batch.members.length,
    evictedCount: evictedMemberIds(batch).size,
    threshold: dissolveThreshold(batch.members.length, dissolvePolicy),
  };

  if (opts.strategy === 'partial') {
    const outcome = preserveSurvivors(state, batch, opts, deps, now, policyInputs);
    // `null` means every member was evicted — there is nothing "partial"
    // about that, so fall through to an ordinary full dissolve below
    // (`strategy` is downgraded to `full` for the rest of this call; `opts`
    // itself is left untouched since it may be shared with the caller).
    if (outcome) return outcome;
  }
  const strategy: 'full' | 'halved' = opts.strategy === 'halved' ? 'halved' : 'full';

  const unshipped: number[] = [];
  const preserved: number[] = [];
  for (const issue of batch.members) {
    const entry = state.entries.find((e) => e.issue === issue);
    if (!entry) continue;
    if (isPreservedMember(entry)) {
      preserved.push(issue);
    } else {
      unshipped.push(issue);
    }
  }

  // Why the member is back on the queue, carried on the entry itself — a
  // dissolve requeue is otherwise indistinguishable from a fresh enqueue.
  const evidence: FailureEvidence = {
    batch: batchId,
    reason: opts.reason,
    failing_tests: [],
    attribution: 'none',
    reverted_commits: [],
    at: now.toISOString(),
  };

  let next = transitionBatch(state, batchId, 'dissolving', {}, now);
  const newBatches: string[] = [];
  const requeued: number[] = [];

  if (strategy === 'halved' && unshipped.length > 0) {
    // Split by POSITION, not by coupling: the halves are the first and second
    // half of `unshipped` in member order. A coupled eviction group straddling
    // the pivot is therefore broken up — accepted, because both halves re-run
    // through the same validate/evict rails, where a member that cannot stand
    // alone is evicted rather than silently shipped.
    const pivot = Math.ceil(unshipped.length / 2);
    const taken = new Set(next.batches.map((b) => b.id));
    // A colliding id would produce two batches answering to one name:
    // `findBatch` would return the first and `validateState` would refuse to
    // load the file at all on the next start.
    const freeId = (base: string): string => {
      let id = base;
      let n = 2;
      while (taken.has(id)) id = `${base}${n++}`;
      taken.add(id);
      return id;
    };
    const halves: Array<{ id: string; members: number[] }> = [
      { id: freeId(`${batchId}-a`), members: unshipped.slice(0, pivot) },
      { id: freeId(`${batchId}-b`), members: unshipped.slice(pivot) },
    ].filter((h) => h.members.length > 0);

    for (const half of halves) {
      next = {
        ...next,
        batches: [
          ...next.batches,
          createBatch(half.id, half.members, now, {
            base_branch: batch.base_branch,
            anchor: batch.anchor ?? undefined,
            run_id: batch.run_id ?? undefined,
            // #565: a dissolve split is not a fresh batch — carry the
            // parent's priority forward, or an operator's `--priority`
            // (or `reprioritize`) is silently lost the moment a batch
            // dissolves into halves.
            priority: batch.priority,
            // Groups survive the split, restricted to the members that landed
            // in this half — a group spanning both halves is no longer a group.
            eviction_groups: batch.eviction_groups
              .map((group) => group.filter((m) => half.members.includes(m)))
              .filter((group) => group.length > 1),
          }),
        ],
      };
      newBatches.push(half.id);
      for (const issue of half.members) {
        const result = requeueMember(
          next,
          issue,
          { mode: 'slot', batch: half.id },
          opts.reason,
          now,
          { failure_evidence: { ...evidence, batch: half.id } }
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
      const result = requeueMember(next, issue, { mode: 'full', batch: null }, opts.reason, now, {
        failure_evidence: evidence,
      });
      next = result.state;
      if (result.requeued) requeued.push(issue);
    }
  }

  next = transitionBatch(next, batchId, 'dissolved', {}, now);
  journal(
    deps,
    unitEvent('batch-dissolved', `batch:${batchId}`, {
      // Ids, not counts, for what went back on the queue vs. what kept its
      // result; N/evictions/threshold (AC3) are the policy inputs behind the
      // decision itself, so a dissolve is explainable without re-deriving it.
      detail:
        `${opts.reason} strategy=${strategy} N=${policyInputs.memberCount} ` +
        `evictions=${policyInputs.evictedCount} threshold=${policyInputs.threshold} ` +
        `requeued=${requeued.join(',') || 'none'} preserved=${preserved.join(',') || 'none'}` +
        (newBatches.length > 0 ? ` split_into=${newBatches.join(',')}` : ''),
    }),
    now
  );
  post(
    deps,
    batchOrThrow(next, batchId),
    {
      phase: opts.milestonePhase ?? 'batch-validate',
      status: 'blocked',
      kv: {
        reason: opts.reason,
        dissolved: 'true',
        strategy,
        requeued: requeued.join(',') || 'none',
        preserved: preserved.join(',') || 'none',
        ...(newBatches.length > 0 ? { split_into: newBatches.join(',') } : {}),
      },
    },
    now
  );

  return { state: next, requeued, preserved, newBatches };
}

/**
 * `strategy: 'partial'` (#563): the caller has already confirmed the
 * survivors are green — a fresh suite re-run came back `ok` right before this
 * was called. Requeue nothing here: the members THIS round evicted were
 * already requeued by the caller's own eviction loop before `dissolveBatch`
 * was invoked, so re-requeuing them would double the bookkeeping — this
 * function's own `requeued` is therefore always `[]`; the evicted ids are
 * reported separately (`evicted_total=`) so the milestone/journal can still
 * show them without claiming this call put them on the queue. The remaining
 * work is to trim them out of `batch.members` (and the `eviction_groups` /
 * `ranges` that name them — `enqueue.ts` throws on a group or range naming a
 * non-member) so the batch that ships reports only the survivors it actually
 * contains, and carry the batch forward exactly like the ordinary all-green
 * path does: straight to `reviewing`, never through `dissolving`/`dissolved`
 * at all.
 *
 * Returns `null` when every member has been evicted across the batch's
 * history — there are no survivors to preserve, so the caller falls through
 * to an ordinary full dissolve instead of shipping an empty batch.
 */
function preserveSurvivors(
  state: SchedState,
  batch: BatchEntry,
  opts: DissolveOptions,
  deps: RecoveryDeps,
  now: Date,
  policyInputs: { memberCount: number; evictedCount: number; threshold: number }
): DissolveOutcome | null {
  // Cumulative across every eviction round this batch has had, not just this
  // one — a member evicted two rounds ago is still not a survivor.
  const evictedIds = evictedMemberIds(batch);
  const survivors = batch.members.filter((issue) => !evictedIds.has(issue));
  if (survivors.length === 0) return null;
  const evictedTotal = [...evictedIds].sort((a, b) => a - b);

  let next = patchBatch(
    state,
    batch.id,
    {
      members: survivors,
      eviction_groups: batch.eviction_groups
        .map((group) => group.filter((m) => survivors.includes(m)))
        .filter((group) => group.length > 1),
      ranges: batch.ranges.filter((r) => survivors.includes(r.issue)),
    },
    now
  );
  next = transitionBatch(next, batch.id, 'reviewing', {}, now);

  journal(
    deps,
    unitEvent('batch-preserved', `batch:${batch.id}`, {
      detail:
        `${opts.reason} strategy=partial N=${policyInputs.memberCount} ` +
        `evictions=${policyInputs.evictedCount} threshold=${policyInputs.threshold} ` +
        `requeued=none evicted_total=${evictedTotal.join(',') || 'none'} ` +
        `preserved=${survivors.join(',') || 'none'}`,
    }),
    now
  );
  post(
    deps,
    batchOrThrow(next, batch.id),
    {
      phase: opts.milestonePhase ?? 'batch-validate',
      status: 'done',
      kv: {
        reason: opts.reason,
        dissolved: 'false',
        strategy: 'partial',
        requeued: 'none',
        evicted_total: evictedTotal.join(',') || 'none',
        preserved: survivors.join(',') || 'none',
      },
    },
    now
  );

  // This call requeued nothing — the caller's own eviction loop already
  // requeued this round's evicted members before invoking dissolveBatch.
  return { state: next, requeued: [], preserved: survivors, newBatches: [] };
}

export interface BlockOptions {
  reason: string;
  /** Milestone phase to report under (default `batch-validate`). */
  milestonePhase?: BatchPhase;
}

/**
 * Block a batch on an unreadable suite report (#562) — unlike `dissolveBatch`,
 * nothing is requeued and nothing is reverted. The failure here is in the
 * SUITE REPORT, not in any member's code: `runValidate` reaches this only
 * after the resolved suite command came back unreadable (and, when the
 * resolved primary tier was cap/config, its one fallback retry too — a
 * repo-detected primary has no further fallback and blocks on its first
 * unreadable report), so there is no failing-test list to attribute and no
 * member to blame. The branch, every member commit, and the worktree are left
 * exactly as they are (the caller must not tear the worktree down) so a human
 * can inspect why the suite command failed to produce a report — dissolving
 * here would discard a possibly-green batch's work to "fix" a problem in
 * tooling, not in the code (docs/agent-traps.md). The `validating` transition
 * below is where a future resume verb would land once the suite command is
 * fixed; today's only real exit from `blocked` is `sched abandon --batch`.
 */
export function blockBatch(
  state: SchedState,
  batchId: string,
  opts: BlockOptions,
  deps: RecoveryDeps
): { state: SchedState } {
  const now = clock(deps);
  const batch = batchOrThrow(state, batchId);
  if (TERMINAL_BATCH_STATUSES.has(batch.status)) {
    throw new IllegalTransitionError('batch', batch.status, 'blocked');
  }
  // #583: persist the reason on the entry itself — previously only the
  // journal/runstate milestone carried it, so `sched status` had nothing to
  // read back for a blocked batch (including the pre-existing #562 case).
  const next = transitionBatch(state, batchId, 'blocked', { blocked_reason: opts.reason }, now);
  journal(deps, unitEvent('batch-blocked', `batch:${batchId}`, { detail: opts.reason }), now);
  post(
    deps,
    batchOrThrow(next, batchId),
    {
      phase: opts.milestonePhase ?? 'batch-validate',
      status: 'blocked',
      kv: { reason: opts.reason, dissolved: 'false' },
    },
    now
  );
  return { state: next };
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
  // Guarded, so a retry against a batch already in `rebasing` is idempotent
  // rather than an IllegalTransitionError out of a recovery call.
  let next = state;
  if (batch.status !== 'rebasing') {
    next = transitionBatch(next, batchId, 'rebasing', {}, now);
  }

  /** Every give-up path here ends the same way: halve the batch, keep the work. */
  const bailToHalves = (
    from: SchedState,
    bailReason: string,
    rebased = false,
    suite: SuiteResult | null = null
  ): PrConflictOutcome => {
    const dissolve = dissolveBatch(
      from,
      batchId,
      { strategy: 'halved', reason: bailReason, milestonePhase: 'batch-ship' },
      deps
    );
    return { state: dissolve.state, action: 'dissolved', rebased, suite, dissolve };
  };

  if (batch.rebase_attempts >= MAX_REBASE_ATTEMPTS) {
    return bailToHalves(next, `${reason}-recurred`);
  }

  next = patchBatch(next, batchId, { rebase_attempts: batch.rebase_attempts + 1 }, now);

  const base = batch.base_branch;
  if (!SAFE_REF_RE.test(base)) {
    return bailToHalves(next, 'invalid-base-branch');
  }

  // Rebase what the batch actually owns. `git rebase` acts on whatever HEAD
  // happens to be, so a checkout left on another branch (or detached by an
  // earlier step) would otherwise rewrite the wrong ref and "re-ship" something
  // that is not this batch.
  if (batch.branch !== null) {
    const head = git(deps, ['symbolic-ref', '--quiet', '--short', 'HEAD'], batchId, now);
    if (head !== batch.branch) {
      journal(
        deps,
        unitEvent('git-failed', `batch:${batchId}`, {
          detail: `checkout is on '${head ?? 'detached HEAD'}', expected the batch branch '${batch.branch}'`,
        }),
        now
      );
      return bailToHalves(next, 'wrong-branch-checked-out');
    }
  }

  // A failed fetch is not a conflict: rebasing onto a stale `origin/<base>`
  // silently produces a batch that will conflict again at merge time, and
  // reporting it as `rebase-conflict` sends the operator after the wrong cause.
  if (git(deps, ['fetch', 'origin', '--', base], batchId, now) === null) {
    return bailToHalves(next, 'fetch-failed');
  }
  if (git(deps, ['rebase', `origin/${base}`], batchId, now) === null) {
    // Never leave the worktree mid-rebase.
    git(deps, ['rebase', '--abort'], batchId, now);
    return bailToHalves(next, 'rebase-conflict');
  }
  journal(deps, unitEvent('batch-rebased', `batch:${batchId}`, { detail: base }), now);

  next = transitionBatch(next, batchId, 're-validating', {}, now);
  const suite = runSuite(deps, batchId, now);
  // NOTE (#562 scope boundary): unlike `runValidate`'s primary gate, this
  // post-rebase re-validate does not yet consult `suite.readable` — an
  // unreadable report here still halves rather than blocks. `handlePrConflict`
  // already dissolves by design on ANY red suite after its one rebase attempt
  // (docstring above), a different, narrower recovery policy than the primary
  // `validating` rail; giving it its own unreadable→blocked branch is a
  // follow-up, not part of this issue's stated scope (#562).
  if (suite !== null && !suite.ok) {
    return bailToHalves(next, 'rebase-suite-red', true, suite);
  }

  next = transitionBatch(next, batchId, 'shipping', {}, now);
  post(
    deps,
    batchOrThrow(next, batchId),
    {
      phase: 'batch-ship',
      // NOT `blocked`: the rebase worked and the batch is re-shipping. `blocked`
      // stamps `next=done` on a run that is still going, and counts toward the
      // runstate resume-loop cap.
      status: 'awaiting-merge',
      kv: { reason, rebased: base, rebase_attempts: String(batch.rebase_attempts + 1) },
    },
    now
  );
  return { state: next, action: 'reship', rebased: true, suite };
}
