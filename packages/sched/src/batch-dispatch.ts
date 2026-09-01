/**
 * Batch dispatch (#523, RFC-0001 §C.4/D.2/D.3): the missing driver that
 * executes `batch:<id>` units. #498 landed the batch failure-recovery library
 * (attribution/bisect/eviction/dissolve, `recovery.ts`) and the batch state
 * machine (`state.ts`); readiness/placement already treat a `ready` batch as
 * a runnable unit (`readiness.ts`, `scheduler.ts`). Nothing dispatched one
 * until now.
 *
 * Shape, mirroring `engine.ts`'s per-issue dispatch: claim a slot → spawn an
 * agent → poll ground truth → verify → transition. Generalized to `BatchEntry`
 * at batch-phase granularity instead of per-issue-phase granularity:
 *
 * ```
 * ready → executing(member i/N) ⟲ → validating → reviewing → shipping
 *   → awaiting-merge → merged → deployed → reported → done
 * ```
 *
 * A batch's single slot is claimed FRESH for each live step (one member, the
 * tail agent, the report agent) via a bespoke free-capacity-gated assignment —
 * the same shape `engine.ts`'s `dispatchReportAgents` already uses, not
 * `computeAssignments`/`runnableUnits` again after the first claim (those only
 * ever offer a `status === 'ready'` batch). Between steps — a suite run,
 * a PR merge wait — the slot is released to `idle` and holds no capacity
 * (AC5): only a live member/tail/report/fix agent holds a slot.
 *
 * The aggregate suite itself is deterministic engine work, not an LLM step —
 * it runs with no slot claimed at all, matching AC5's "member or batch-LLM-step"
 * wording precisely.
 *
 * Two distinct failure rails, deliberately different:
 * - A member's OWN agent reports itself blocked (its own gate never went
 *   green) — evicted directly, no attribution needed: the offender is already
 *   known, and either it has no commits yet (blocked before implementing) or
 *   its commits are exactly what gets reverted.
 * - The AGGREGATE suite (run by the engine after every member individually
 *   went green) comes back red — an integration-level conflict no member's own
 *   gate caught. THIS is what `recovery.ts`'s attribution/fix/evict pipeline
 *   exists for (RFC F.2).
 *
 * Scope decisions recorded here, not silently cut: no `git bisect` stage for
 * an ambiguous aggregate failure (bisect needs a per-project "run only these
 * tests" command this module has no generic way to construct) — an
 * unattributable red aggregate suite dissolves the batch rather than
 * bisecting, which `attributing → dissolving` already models. No worktree-pool
 * integration for batch-setup — cold `git worktree add` only, mirroring
 * `teardown.ts`'s cold path. No per-phase stall/escalation ladder for batch
 * sub-agents — a dead-without-verification agent is treated as blocked and
 * evicted/reported rather than redispatched stronger. Both are documented
 * follow-ups, not gaps discovered later.
 */

import * as path from 'node:path';
import {
  type BoundaryCommit,
  type MemberFootprint,
  memberRanges,
  parseBoundaryCommits,
  SAFE_REF_RE,
} from './attribution';
import {
  buildAgentCommand,
  buildBatchReportPrompt,
  buildBatchTailPrompt,
  buildMemberPrompt,
  type ResolvedDispatch,
  type SpawnDeps,
  unitLogName,
} from './dispatch';
import {
  type GroundTruth,
  isBatchPhaseDone,
  isBatchTailParked,
  isMemberBlocked,
  isMemberComplete,
  type PrTruth,
  prOfMilestone,
} from './groundtruth';
import { type Journal, unitEvent } from './journal';
import type { SchedStore } from './persist';
import type { ExecFn } from './project';
import {
  beginAttribution,
  beginFixAttempt,
  checkDissolveTrigger,
  createExecMilestonePoster,
  dissolveBatch,
  evictMembers,
  type RecoveryDeps,
  resolveFixAttempt,
  type SuiteResult,
} from './recovery';
import { assignToIdleSlot, freeCapacity } from './scheduler';
import {
  findBatch,
  findEntry,
  patchBatch,
  requeueMember,
  transitionBatch,
  transitionIssue,
  transitionSlot,
} from './state';
import { type FsExists, isSafeWorktree, runTeardown } from './teardown';
import type {
  AttributionMethod,
  BatchEntry,
  JournalEventName,
  ModelTier,
  SchedConfig,
  SchedState,
  SlotEntry,
} from './types';

/** Everything batch dispatch needs from the outside world. */
export interface BatchDispatchDeps {
  store: SchedStore;
  journal: Journal;
  groundTruth: GroundTruth;
  spawnDeps: SpawnDeps;
  now: () => Date;
  /** Repo root — cwd for `git`/`ai-dossier` calls that are not batch-worktree-scoped. */
  repoDir: string;
  /** Exec for batch git/milestone-CLI operations (never throws — the `ExecFn` contract). */
  exec: ExecFn;
  /** Runs the aggregate suite inside a batch worktree; batches never leave `validating` without one. */
  runSuite: (worktree: string) => SuiteResult;
  fsExists?: FsExists;
}

/** What one `runBatchTick` call did, merged into `engine.ts`'s `TickResult` by the caller. */
export interface BatchTickResult {
  spawned: string[];
  completed: string[];
  parked: string[];
  mergeAccepted: string[];
  failed: string[];
  /** Issue numbers requeued full-cycle by a dissolve — matches `TickResult.blocked`'s shape. */
  blocked: number[];
}

function emptyResult(): BatchTickResult {
  return { spawned: [], completed: [], parked: [], mergeAccepted: [], failed: [], blocked: [] };
}

function unit(batchId: string): string {
  return `batch:${batchId}`;
}

/**
 * Journal one event. Loosely-typed `extra`, matching `engine.ts`'s own local
 * `journal()` wrapper — `unitEvent`'s stricter `Omit<JournalEvent, ...>` typing
 * excess-property-checks an inline object literal (e.g. rejecting `pr`, a key
 * `JournalEvent` doesn't declare), where a pre-typed `Record<string, unknown>`
 * value passed through a variable does not.
 */
function journalEvent(
  deps: BatchDispatchDeps,
  event: JournalEventName,
  unitId: string,
  extra: Record<string, unknown> = {}
): void {
  deps.journal.append(unitEvent(event, unitId, extra), deps.now());
}

function slotFor(state: SchedState, batchId: string): SlotEntry | undefined {
  return state.slots.find((s) => s.unit === unit(batchId));
}

function recoveryDeps(deps: BatchDispatchDeps, batch: BatchEntry, now: Date): RecoveryDeps {
  return {
    exec: deps.exec,
    repoDir: batch.worktree ?? deps.repoDir,
    journal: deps.journal,
    postMilestone: createExecMilestonePoster(deps.exec, { repoDir: deps.repoDir }),
    runSuite: batch.worktree !== null ? () => deps.runSuite(batch.worktree as string) : undefined,
    now: () => now,
  };
}

/** Release a batch's slot to idle, whatever status it currently holds (mirrors `walkSlotToIdle`). */
function releaseSlot(state: SchedState, batchId: string, now: Date): SchedState {
  let next = state;
  let slot = slotFor(next, batchId);
  while (slot && slot.status !== 'idle') {
    const to =
      slot.status === 'running'
        ? 'exited'
        : slot.status === 'exited'
          ? 'verifying'
          : slot.status === 'verifying'
            ? 'complete'
            : slot.status === 'assigned' || slot.status === 'recovering'
              ? 'idle'
              : 'idle';
    next = transitionSlot(next, slot.id, to, {}, now);
    slot = slotFor(next, batchId);
  }
  return next;
}

// --- Batch setup (ready → executing, member 1) ---

/**
 * `batch/<id>-<YYYYMMDD>` off `base_branch`, a worktree at
 * `<repoDir>/worktrees/batch-<id>-<YYYYMMDD>` (cold git only — no pool
 * integration in this version, see the module doc), and a fresh runstate run
 * id minted against the anchor. All-or-nothing: any failed step reports the
 * step name and nothing is partially recorded on the batch.
 */
function runBatchSetup(
  deps: BatchDispatchDeps,
  batch: BatchEntry,
  now: Date
): { ok: true; branch: string; worktree: string; runId: string } | { ok: false; reason: string } {
  if (batch.anchor === null) return { ok: false, reason: 'no-anchor' };
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  const branch = `batch/${batch.id}-${date}`;
  const worktree = path.join(deps.repoDir, 'worktrees', `batch-${batch.id}-${date}`);
  if (!SAFE_REF_RE.test(branch) || !SAFE_REF_RE.test(batch.base_branch)) {
    return { ok: false, reason: 'invalid-branch-name' };
  }

  const runId = deps.exec(
    'ai-dossier',
    ['runstate', 'mint', '--issue', String(batch.anchor)],
    deps.repoDir
  );
  if (runId === null || runId.trim() === '') return { ok: false, reason: 'runstate-mint-failed' };

  if (deps.exec('git', ['fetch', 'origin', '--', batch.base_branch], deps.repoDir) === null) {
    return { ok: false, reason: 'fetch-failed' };
  }
  if (deps.exec('git', ['branch', branch, `origin/${batch.base_branch}`], deps.repoDir) === null) {
    return { ok: false, reason: 'branch-create-failed' };
  }
  if (deps.exec('git', ['push', '-u', 'origin', '--', branch], deps.repoDir) === null) {
    return { ok: false, reason: 'branch-push-failed' };
  }
  if (deps.exec('git', ['worktree', 'add', '--', worktree, branch], deps.repoDir) === null) {
    return { ok: false, reason: 'worktree-add-failed' };
  }
  return { ok: true, branch, worktree, runId: runId.trim() };
}

/** Spawn one batch member's `slot-cycle` agent into the slot batch-setup (or a prior member) just released. */
/**
 * Drive a member's `QueueEntry` through the D.1 slot-line states it must pass
 * through before `shipped-in-batch` becomes a legal edge (`validated` is the
 * only state that transitions there) — `classified → batched → waiting →
 * in-work`, each a no-op waypoint from the batch's perspective (the real
 * waiting/working happens at BATCH granularity), applied idempotently so a
 * member already past a given waypoint is left alone.
 */
function advanceMemberToInWork(state: SchedState, memberIssue: number, now: Date): SchedState {
  let next = state;
  const chain: Array<[from: string, to: 'classified' | 'batched' | 'waiting' | 'in-work']> = [
    ['queued', 'classified'],
    ['classified', 'batched'],
    ['batched', 'waiting'],
    ['waiting', 'in-work'],
  ];
  for (const [from, to] of chain) {
    if (findEntry(next, memberIssue)?.status === from) {
      next = transitionIssue(next, memberIssue, to, {}, now);
    }
  }
  return next;
}

/** The completion half of the same chain: `in-work → committed → validated` (see `advanceMemberToInWork`). */
function advanceMemberToValidated(state: SchedState, memberIssue: number, now: Date): SchedState {
  let next = state;
  const chain: Array<[from: string, to: 'committed' | 'validated']> = [
    ['in-work', 'committed'],
    ['committed', 'validated'],
  ];
  for (const [from, to] of chain) {
    if (findEntry(next, memberIssue)?.status === from) {
      next = transitionIssue(next, memberIssue, to, {}, now);
    }
  }
  return next;
}

function spawnMember(
  deps: BatchDispatchDeps,
  dispatch: ResolvedDispatch,
  state: SchedState,
  slot: SlotEntry,
  batchId: string,
  now: Date,
  result: BatchTickResult
): SchedState {
  const batch = findBatch(state, batchId);
  if (!batch || batch.worktree === null) return state;
  const memberIssue = batch.members[batch.executing_member - 1];
  if (memberIssue === undefined) return state;

  const withStatus = advanceMemberToInWork(state, memberIssue, now);
  const tier: ModelTier = findEntry(withStatus, memberIssue)?.tier ?? 'mid';
  const cmd = buildAgentCommand(dispatch.command, tier, memberIssue, dispatch.tierModels);
  const prompt = buildMemberPrompt(dispatch.memberPrompt, memberIssue, batchId, batch.worktree);
  const logFile = path.join(
    deps.store.runsDir,
    `${unitLogName(unit(batchId))}-m${batch.executing_member}-${memberIssue}.log`
  );

  let pid: number;
  try {
    pid = deps.spawnDeps.spawn(cmd, prompt, logFile);
  } catch (err) {
    deps.journal.append(
      unitEvent('batch-setup-failed', unit(batchId), {
        detail: `member #${memberIssue} spawn failed: ${(err as Error).message}`,
      }),
      now
    );
    result.failed.push(unit(batchId));
    return releaseSlot(withStatus, batchId, now);
  }

  const patch = {
    pid,
    pid_start: deps.spawnDeps.processStart(pid),
    phase: 'member',
    last_progress_at: now.toISOString(),
  };
  const next =
    slot.status === 'assigned' || slot.status === 'recovering'
      ? transitionSlot(withStatus, slot.id, 'running', patch, now)
      : withStatus;
  deps.journal.append(
    unitEvent('spawned', unit(batchId), {
      pid,
      tier,
      slot: slot.id,
      issue: memberIssue,
      detail: `member ${batch.executing_member}/${batch.members.length}`,
    }),
    now
  );
  result.spawned.push(unit(batchId));
  return next;
}

/**
 * First claim of a `ready` batch: assign it a slot, run batch-setup, land the
 * results, then spawn member 1 in the SAME slot (setup and the first member's
 * spawn are effectively instantaneous — no real wait happens between them, so
 * there is nothing to release capacity for in between).
 */
function claimAndSetup(
  deps: BatchDispatchDeps,
  config: SchedConfig,
  dispatch: ResolvedDispatch,
  batchId: string,
  now: Date,
  result: BatchTickResult
): void {
  const claimedSlot = deps.store.withLock((state) => {
    const batch = findBatch(state, batchId);
    if (!batch || batch.status !== 'ready' || batch.anchor === null || slotFor(state, batchId)) {
      return { state, result: null as number | null };
    }
    if (freeCapacity(state, config) === 0) return { state, result: null };
    const assigned = assignToIdleSlot(state, unit(batchId), 'batch-setup', now);
    return { state: assigned.state, result: assigned.slotId };
  });
  if (claimedSlot === null) return;

  const state = deps.store.load();
  const batch = findBatch(state, batchId);
  if (!batch) return;
  const setup = runBatchSetup(deps, batch, now);
  const poster = createExecMilestonePoster(deps.exec, { repoDir: deps.repoDir });

  if (!setup.ok) {
    if (batch.anchor !== null) {
      poster(batch.anchor, batch.run_id ?? '', {
        phase: 'batch-setup',
        status: 'blocked',
        kv: { reason: setup.reason },
      });
    }
    deps.journal.append(
      unitEvent('batch-setup-failed', unit(batchId), { detail: setup.reason }),
      now
    );
    result.failed.push(unit(batchId));
    deps.store.withLock((s) => ({ state: releaseSlot(s, batchId, now), result: undefined }));
    return;
  }

  poster(batch.anchor as number, setup.runId, {
    phase: 'batch-setup',
    status: 'done',
    kv: { branch: setup.branch, worktree: setup.worktree, base_branch: batch.base_branch },
  });
  deps.journal.append(
    unitEvent('batch-setup-done', unit(batchId), { detail: setup.worktree }),
    now
  );

  deps.store.withLock((s) => {
    const b = findBatch(s, batchId);
    if (!b || b.status !== 'ready') return { state: s, result: undefined };
    let next = patchBatch(
      s,
      batchId,
      { branch: setup.branch, worktree: setup.worktree, run_id: setup.runId },
      now
    );
    next = transitionBatch(next, batchId, 'executing', { executing_member: 1 }, now);
    const slot = slotFor(next, batchId);
    if (slot) next = spawnMember(deps, dispatch, next, slot, batchId, now, result);
    return { state: next, result: undefined };
  });
}

// --- Continuation: claim a fresh slot for the next live step ---

/**
 * Claim a fresh idle slot for the batch's next live step (a later member, the
 * tail agent, the report agent), gated on free capacity exactly like
 * `dispatchReportAgents` — never through `computeAssignments`/`runnableUnits`
 * again (those only ever offer a `status === 'ready'` batch).
 */
function claimAndSpawn(
  deps: BatchDispatchDeps,
  config: SchedConfig,
  batchId: string,
  phase: string,
  now: Date,
  spawn: (state: SchedState, slot: SlotEntry) => SchedState
): boolean {
  return deps.store.withLock((state) => {
    const batch = findBatch(state, batchId);
    if (!batch || slotFor(state, batchId)) return { state, result: false };
    if (freeCapacity(state, config) === 0) return { state, result: false };
    const assigned = assignToIdleSlot(state, unit(batchId), phase, now, 'cycle');
    const slot = assigned.state.slots.find((s) => s.id === assigned.slotId);
    if (!slot) return { state, result: false };
    return { state: spawn(assigned.state, slot), result: true };
  });
}

function spawnMemberContinuation(
  deps: BatchDispatchDeps,
  config: SchedConfig,
  dispatch: ResolvedDispatch,
  batchId: string,
  now: Date,
  result: BatchTickResult
): void {
  claimAndSpawn(deps, config, batchId, 'member', now, (state, slot) =>
    spawnMember(deps, dispatch, state, slot, batchId, now, result)
  );
}

function spawnTailAgent(
  deps: BatchDispatchDeps,
  config: SchedConfig,
  dispatch: ResolvedDispatch,
  batchId: string,
  now: Date,
  result: BatchTickResult
): void {
  claimAndSpawn(deps, config, batchId, 'reviewing', now, (state, slot) => {
    const batch = findBatch(state, batchId);
    if (!batch || batch.worktree === null || batch.anchor === null) return state;
    const cmd = buildAgentCommand(dispatch.command, 'strong', batch.anchor, dispatch.tierModels);
    const prompt = buildBatchTailPrompt(
      dispatch.batchTailPrompt,
      batchId,
      batch.anchor,
      batch.members,
      batch.worktree
    );
    const logFile = path.join(deps.store.runsDir, `${unitLogName(unit(batchId))}-tail.log`);
    let pid: number;
    try {
      pid = deps.spawnDeps.spawn(cmd, prompt, logFile);
    } catch (err) {
      deps.journal.append(
        unitEvent('batch-setup-failed', unit(batchId), {
          detail: `tail agent spawn failed: ${(err as Error).message}`,
        }),
        now
      );
      result.failed.push(unit(batchId));
      return releaseSlot(state, batchId, now);
    }
    const patch = {
      pid,
      pid_start: deps.spawnDeps.processStart(pid),
      phase: 'reviewing',
      last_progress_at: now.toISOString(),
    };
    const next =
      slot.status === 'assigned' ? transitionSlot(state, slot.id, 'running', patch, now) : state;
    deps.journal.append(unitEvent('spawned', unit(batchId), { pid, slot: slot.id }), now);
    result.spawned.push(unit(batchId));
    return next;
  });
}

function spawnReportAgent(
  deps: BatchDispatchDeps,
  config: SchedConfig,
  dispatch: ResolvedDispatch,
  batchId: string,
  now: Date,
  result: BatchTickResult
): void {
  claimAndSpawn(deps, config, batchId, 'report', now, (state, slot) => {
    const batch = findBatch(state, batchId);
    if (!batch || batch.anchor === null) return state;
    const prNumber = batch.pr;
    if (prNumber === null) return state;
    const cmd = buildAgentCommand(
      dispatch.command,
      'mechanical',
      batch.anchor,
      dispatch.tierModels
    );
    const prompt = buildBatchReportPrompt(
      dispatch.batchReportPrompt,
      batchId,
      batch.anchor,
      prNumber
    );
    const logFile = path.join(deps.store.runsDir, `${unitLogName(unit(batchId))}-report.log`);
    let pid: number;
    try {
      pid = deps.spawnDeps.spawn(cmd, prompt, logFile);
    } catch (err) {
      deps.journal.append(
        unitEvent('report-failed', unit(batchId), { detail: (err as Error).message }),
        now
      );
      return releaseSlot(state, batchId, now);
    }
    const patchState = {
      pid,
      pid_start: deps.spawnDeps.processStart(pid),
      phase: 'report',
      last_progress_at: now.toISOString(),
    };
    const next =
      slot.status === 'assigned'
        ? transitionSlot(state, slot.id, 'running', patchState, now)
        : state;
    journalEvent(deps, 'report-dispatched', unit(batchId), { pid, slot: slot.id, pr: prNumber });
    result.spawned.push(unit(batchId));
    return next;
  });
}

// --- Aggregate validate + attribution/fix/evict (RFC F.2) ---

function memberFootprints(deps: BatchDispatchDeps, batch: BatchEntry): MemberFootprint[] {
  if (batch.worktree === null) return [];
  return batch.ranges.map((range) => {
    const out = deps.exec(
      'git',
      ['show', '--name-only', '--format=', ...range.commits],
      batch.worktree as string
    );
    const changedPaths = (out ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return { issue: range.issue, changedPaths, focusedTests: [] };
  });
}

function boundaryCommits(deps: BatchDispatchDeps, batch: BatchEntry): BoundaryCommit[] {
  if (batch.worktree === null || batch.branch === null) return [];
  const out = deps.exec(
    'git',
    ['log', '--reverse', '--format=%H%x09%s', `origin/${batch.base_branch}..${batch.branch}`],
    batch.worktree
  );
  return parseBoundaryCommits(out);
}

/** Recompute and persist each member's commit range on the batch (#523 AC2), after any commit lands. */
function recordRanges(
  deps: BatchDispatchDeps,
  state: SchedState,
  batchId: string,
  now: Date
): SchedState {
  const batch = findBatch(state, batchId);
  if (!batch) return state;
  const ranges = memberRanges(boundaryCommits(deps, batch));
  return patchBatch(state, batchId, { ranges }, now);
}

/**
 * `validating`, no live slot: run the aggregate suite (deterministic — no
 * agent, no slot claimed, matching AC5's "member or batch-LLM-step" wording).
 * Green proceeds to the tail; red attributes and either fixes one offender or
 * dissolves when nothing could be attributed (RFC F.2/F.8).
 */
function runValidate(
  deps: BatchDispatchDeps,
  config: SchedConfig,
  dispatch: ResolvedDispatch,
  batchId: string,
  now: Date,
  result: BatchTickResult
): void {
  const state = deps.store.load();
  const batch = findBatch(state, batchId);
  if (!batch || batch.worktree === null) return;

  const suite = deps.runSuite(batch.worktree);
  const rDeps = recoveryDeps(deps, batch, now);
  const poster = createExecMilestonePoster(deps.exec, { repoDir: deps.repoDir });

  if (suite.ok) {
    if (batch.anchor !== null && batch.run_id !== null) {
      poster(batch.anchor, batch.run_id, { phase: 'batch-validate', status: 'done', kv: {} });
    }
    deps.journal.append(
      unitEvent('verify-complete', unit(batchId), { detail: 'suite green' }),
      now
    );
    deps.store.withLock((s) => {
      const b = findBatch(s, batchId);
      if (!b || b.status !== 'validating') return { state: s, result: undefined };
      return { state: transitionBatch(s, batchId, 'reviewing', {}, now), result: undefined };
    });
    spawnTailAgent(deps, config, dispatch, batchId, now, result);
    return;
  }

  const { state: attributed, outcome } = beginAttribution(
    state,
    batchId,
    { failing: suite.failing, footprints: memberFootprints(deps, batch) },
    rDeps
  );

  if (outcome.offenders.length === 0) {
    const dissolve = dissolveBatch(
      attributed,
      batchId,
      { strategy: 'full', reason: 'unattributable-suite-failure' },
      rDeps
    );
    deps.store.withLock((s) => {
      const b = findBatch(s, batchId);
      if (!b) return { state: s, result: undefined };
      return { state: dissolve.state, result: undefined };
    });
    result.blocked.push(...dissolve.requeued);
    result.failed.push(unit(batchId));
    return;
  }

  const offender = outcome.offenders[0];
  const { state: fixing, dispatch: fixDispatch } = beginFixAttempt(
    attributed,
    batchId,
    offender,
    rDeps,
    { config, tests: outcome.attributed.get(offender) ?? [] }
  );
  deps.store.withLock((_s) => ({ state: fixing, result: undefined }));
  if (fixDispatch === null) {
    // Already had its one attempt — evict directly (mirrors the module's own
    // documented next step when `beginFixAttempt` refuses).
    evictOffender(deps, config, batchId, offender, outcome.method, now, result);
    return;
  }

  claimAndSpawn(deps, config, batchId, 'fixing', now, (s, slot) => {
    const logFile = path.join(
      deps.store.runsDir,
      `${unitLogName(unit(batchId))}-fix-${offender}.log`
    );
    let pid: number;
    try {
      pid = deps.spawnDeps.spawn(fixDispatch.command, fixDispatch.prompt, logFile);
    } catch (err) {
      deps.journal.append(
        unitEvent('fix-dispatched', unit(batchId), {
          issue: offender,
          detail: `spawn failed: ${(err as Error).message}`,
        }),
        now
      );
      return releaseSlot(s, batchId, now);
    }
    const patch = {
      pid,
      pid_start: deps.spawnDeps.processStart(pid),
      phase: 'fixing',
      last_progress_at: now.toISOString(),
    };
    const next = slot.status === 'assigned' ? transitionSlot(s, slot.id, 'running', patch, now) : s;
    result.spawned.push(unit(batchId));
    return next;
  });
}

function evictOffender(
  deps: BatchDispatchDeps,
  _config: SchedConfig,
  batchId: string,
  offender: number,
  attribution: AttributionMethod,
  now: Date,
  result: BatchTickResult
): void {
  const state = deps.store.load();
  const batch = findBatch(state, batchId);
  if (!batch) return;
  const rDeps = recoveryDeps(deps, batch, now);
  const outcome = evictMembers(
    state,
    batchId,
    { issues: [offender], reason: 'suite-red-after-fix', attribution, ranges: batch.ranges },
    rDeps
  );
  deps.store.withLock((_s) => ({ state: outcome.state, result: undefined }));
  if (outcome.dissolved) {
    result.failed.push(unit(batchId));
    return;
  }
  if (outcome.suite?.ok) {
    deps.store.withLock((s) => {
      const b = findBatch(s, batchId);
      if (!b || b.status !== 'validating') return { state: s, result: undefined };
      return { state: transitionBatch(s, batchId, 'reviewing', {}, now), result: undefined };
    });
  }
}

// --- Reconcile a batch currently holding a live/exited slot ---

function reconcileMemberSlot(
  deps: BatchDispatchDeps,
  config: SchedConfig,
  dispatch: ResolvedDispatch,
  batchId: string,
  slot: SlotEntry,
  now: Date,
  result: BatchTickResult
): void {
  const state0 = deps.store.load();
  const batch = findBatch(state0, batchId);
  if (!batch) return;
  const memberIssue = batch.members[batch.executing_member - 1];
  if (memberIssue === undefined) return;

  const dead = slot.pid !== null && !deps.spawnDeps.isAlive(slot.pid, slot.pid_start ?? undefined);
  const milestone = deps.groundTruth.latestMilestone(memberIssue);
  if (milestone === undefined) return; // unreachable — pause this batch's decisions

  if (isMemberComplete(milestone)) {
    deps.journal.append(
      unitEvent('external-advance', unit(batchId), {
        issue: memberIssue,
        detail: 'member review done',
      }),
      now
    );
    deps.store.withLock((s) => {
      let n = releaseSlot(s, batchId, now);
      n = recordRanges(deps, n, batchId, now);
      n = advanceMemberToValidated(n, memberIssue, now);
      return { state: n, result: undefined };
    });
    result.completed.push(unit(batchId));

    const isLast = batch.executing_member >= batch.members.length;
    if (isLast) {
      deps.store.withLock((s) => {
        const b = findBatch(s, batchId);
        if (!b || b.status !== 'executing') return { state: s, result: undefined };
        return { state: transitionBatch(s, batchId, 'validating', {}, now), result: undefined };
      });
      runValidate(deps, config, dispatch, batchId, now, result);
    } else {
      deps.store.withLock((s) => {
        const b = findBatch(s, batchId);
        if (!b || b.status !== 'executing') return { state: s, result: undefined };
        return {
          state: transitionBatch(
            s,
            batchId,
            'executing',
            { executing_member: b.executing_member + 1 },
            now
          ),
          result: undefined,
        };
      });
      deps.journal.append(unitEvent('member-advanced', unit(batchId), { issue: memberIssue }), now);
      spawnMemberContinuation(deps, config, dispatch, batchId, now, result);
    }
    return;
  }

  if (isMemberBlocked(milestone) || dead) {
    const reason = milestone?.keys.reason ?? (dead ? 'agent-exited-unverified' : 'member-blocked');
    journalEvent(deps, 'unit-failed', unit(batchId), {
      issue: memberIssue,
      reason,
      detail: 'member blocked',
    });
    deps.store.withLock((s) => ({ state: releaseSlot(s, batchId, now), result: undefined }));

    // A member that never went green (RFC F.1) evicts DIRECTLY — no aggregate
    // suite has run yet, so there is nothing for `attributing`/`evicting` (the
    // AGGREGATE-suite-red pipeline, RFC F.2) to attribute or revert: the
    // offender is already known, and `batch.ranges` has no entry for a member
    // that never reached `isMemberComplete`. `executing → validating →
    // attributing → evicting` is not even a legal edge from mid-`executing`
    // (BATCH_TRANSITIONS has no `executing → evicting`) — this stays entirely
    // within `executing`/`dissolving`, both of which ARE legal from here.
    const dissolved = evictMemberDirectly(deps, batchId, memberIssue, reason, now);
    if (dissolved) {
      result.failed.push(unit(batchId));
      return;
    }

    const isLast = batch.executing_member >= batch.members.length;
    if (isLast) {
      deps.store.withLock((s) => {
        const b = findBatch(s, batchId);
        if (!b || b.status !== 'executing') return { state: s, result: undefined };
        return { state: transitionBatch(s, batchId, 'validating', {}, now), result: undefined };
      });
      runValidate(deps, config, dispatch, batchId, now, result);
    } else {
      deps.store.withLock((s) => {
        const b = findBatch(s, batchId);
        if (!b || b.status !== 'executing') return { state: s, result: undefined };
        return {
          state: transitionBatch(
            s,
            batchId,
            'executing',
            { executing_member: b.executing_member + 1 },
            now
          ),
          result: undefined,
        };
      });
      journalEvent(deps, 'member-advanced', unit(batchId), { issue: memberIssue });
      spawnMemberContinuation(deps, config, dispatch, batchId, now, result);
    }
  }
}

/**
 * Requeue a member full-cycle, record the eviction, and dissolve if this tips
 * the batch past the ⅓ threshold (RFC F.1/F.8) — WITHOUT going through
 * `recovery.ts`'s `evictMembers` (which needs `attributing`/`evicting` status
 * and a commit range to revert; a member evicted here has neither). Returns
 * whether the batch dissolved.
 */
function evictMemberDirectly(
  deps: BatchDispatchDeps,
  batchId: string,
  memberIssue: number,
  reason: string,
  now: Date
): boolean {
  let dissolved = false;
  deps.store.withLock((s) => {
    const b = findBatch(s, batchId);
    if (!b) return { state: s, result: undefined };
    const evidence = {
      batch: batchId,
      reason,
      failing_tests: [],
      attribution: 'none' as const,
      reverted_commits: [],
      at: now.toISOString(),
    };
    const requeueResult = requeueMember(
      s,
      memberIssue,
      { mode: 'full', batch: null },
      reason,
      now,
      { failure_evidence: evidence }
    );
    let next = requeueResult.state;
    next = patchBatch(
      next,
      batchId,
      {
        evictions: [
          ...b.evictions,
          {
            issue: memberIssue,
            reason,
            attribution: 'none',
            reverted_commits: [],
            group: [],
            at: now.toISOString(),
          },
        ],
      },
      now
    );
    const updated = findBatch(next, batchId);
    if (updated && checkDissolveTrigger(updated)) {
      const rDeps = recoveryDeps(deps, updated, now);
      const outcome = dissolveBatch(
        next,
        batchId,
        { strategy: 'full', reason: 'eviction-threshold' },
        rDeps
      );
      dissolved = true;
      return { state: outcome.state, result: undefined };
    }
    return { state: next, result: undefined };
  });
  return dissolved;
}

function reconcileFixSlot(
  deps: BatchDispatchDeps,
  config: SchedConfig,
  batchId: string,
  slot: SlotEntry,
  now: Date,
  result: BatchTickResult
): void {
  if (slot.pid !== null && deps.spawnDeps.isAlive(slot.pid, slot.pid_start ?? undefined)) return; // still running

  const state = deps.store.load();
  const batch = findBatch(state, batchId);
  if (!batch || batch.worktree === null) return;
  const offenderRecord = [...batch.fix_attempts].reverse().find((a) => a.outcome === 'dispatched');
  if (!offenderRecord) return;

  deps.store.withLock((s) => ({ state: releaseSlot(s, batchId, now), result: undefined }));

  const suite = deps.runSuite(batch.worktree);
  const rDeps = recoveryDeps(deps, batch, now);
  const { state: resolved } = resolveFixAttempt(
    deps.store.load(),
    batchId,
    offenderRecord.issue,
    suite.ok ? 'green' : 'red',
    rDeps
  );
  deps.store.withLock((_s) => ({ state: resolved, result: undefined }));

  if (suite.ok) {
    deps.store.withLock((s) => {
      const b = findBatch(s, batchId);
      if (!b || b.status !== 'validating') return { state: s, result: undefined };
      return { state: transitionBatch(s, batchId, 'reviewing', {}, now), result: undefined };
    });
    return;
  }
  evictOffender(deps, config, batchId, offenderRecord.issue, 'overlap', now, result);
}

function reconcileTailSlot(
  deps: BatchDispatchDeps,
  batchId: string,
  slot: SlotEntry,
  now: Date,
  result: BatchTickResult
): void {
  const state = deps.store.load();
  const batch = findBatch(state, batchId);
  if (!batch || batch.anchor === null) return;
  const dead = slot.pid !== null && !deps.spawnDeps.isAlive(slot.pid, slot.pid_start ?? undefined);
  const milestone = deps.groundTruth.latestMilestone(batch.anchor);
  if (milestone === undefined) return;

  if (batch.status === 'reviewing' && isBatchPhaseDone(milestone, 'batch-review')) {
    deps.store.withLock((s) => {
      const b = findBatch(s, batchId);
      if (!b || b.status !== 'reviewing') return { state: s, result: undefined };
      return { state: transitionBatch(s, batchId, 'shipping', {}, now), result: undefined };
    });
    return;
  }

  if (isBatchTailParked(milestone)) {
    const pr = prOfMilestone(milestone);
    journalEvent(deps, 'pr-parked', unit(batchId), { pr: pr ?? undefined });
    deps.store.withLock((s) => {
      let n = releaseSlot(s, batchId, now);
      const b = findBatch(n, batchId);
      if (!b) return { state: n, result: undefined };
      n = b.status === 'reviewing' ? transitionBatch(n, batchId, 'shipping', {}, now) : n;
      n = transitionBatch(n, batchId, 'awaiting-merge', { pr }, now);
      return { state: n, result: undefined };
    });
    result.parked.push(unit(batchId));
    return;
  }

  if (dead) {
    deps.journal.append(
      unitEvent('unit-failed', unit(batchId), { reason: 'tail-agent-exited-unverified' }),
      now
    );
    deps.store.withLock((s) => ({ state: releaseSlot(s, batchId, now), result: undefined }));
    result.failed.push(unit(batchId));
  }
}

function reconcileReportSlot(
  deps: BatchDispatchDeps,
  batchId: string,
  slot: SlotEntry,
  now: Date,
  result: BatchTickResult
): void {
  const state = deps.store.load();
  const batch = findBatch(state, batchId);
  if (!batch || batch.anchor === null) return;
  const dead = slot.pid !== null && !deps.spawnDeps.isAlive(slot.pid, slot.pid_start ?? undefined);
  const milestone = deps.groundTruth.latestMilestone(batch.anchor);
  if (milestone === undefined) return;

  if (isBatchPhaseDone(milestone, 'batch-report')) {
    deps.journal.append(
      unitEvent('external-advance', unit(batchId), { detail: 'batch report done' }),
      now
    );
    deps.store.withLock((s) => {
      let n = releaseSlot(s, batchId, now);
      const b = findBatch(n, batchId);
      if (!b || b.status !== 'deployed') return { state: n, result: undefined };
      n = transitionBatch(n, batchId, 'reported', {}, now);
      n = transitionBatch(n, batchId, 'done', {}, now);
      return { state: n, result: undefined };
    });
    result.completed.push(unit(batchId));
    teardownBatch(deps, batchId, now);
    return;
  }
  if (dead) {
    deps.journal.append(
      unitEvent('report-failed', unit(batchId), { detail: 'unverified exit' }),
      now
    );
    deps.store.withLock((s) => ({ state: releaseSlot(s, batchId, now), result: undefined }));
  }
}

// --- PR watch for `awaiting-merge` batches (mirrors `pollParkedPrs`/`reconcileParked`) ---

function reconcilePrWatch(deps: BatchDispatchDeps, now: Date, result: BatchTickResult): void {
  const state = deps.store.load();
  for (const batch of state.batches) {
    if (batch.status !== 'awaiting-merge') continue;
    const pr = batch.pr;
    if (pr === null) continue;
    const truth: PrTruth | undefined = deps.groundTruth.prState(pr);
    if (truth === undefined) continue; // unreachable — keep watching

    if (truth.state === 'MERGED' && truth.mergedAt !== null) {
      journalEvent(deps, 'merge-accepted', unit(batch.id), { pr });
      deps.store.withLock((s) => {
        const b = findBatch(s, batch.id);
        if (!b || b.status !== 'awaiting-merge') return { state: s, result: undefined };
        let n = transitionBatch(s, batch.id, 'merged', {}, now);
        n = transitionBatch(n, batch.id, 'deployed', {}, now);
        for (const issue of b.members) {
          const entry = findEntry(n, issue);
          if (entry && entry.status !== 'shipped-in-batch') {
            try {
              n = transitionIssue(n, issue, 'shipped-in-batch', {}, now);
              n = transitionIssue(n, issue, 'done', {}, now);
            } catch {
              // Already terminal via another rail — leave it.
            }
          }
        }
        return { state: n, result: undefined };
      });
      result.mergeAccepted.push(unit(batch.id));
      continue;
    }
    if (truth.blocked || truth.mergeable === 'CONFLICTING') {
      journalEvent(deps, 'pr-watch-failed', unit(batch.id), {
        reason: truth.blocked ? 'auto-merge-blocked' : 'pr-conflicting',
        pr,
      });
      // #472's own rebase-and-reship path (RFC F.9) is a documented follow-up
      // for the batch PR-conflict rail; for now the batch stays parked and
      // the block is visible via the journal + `sched status`.
    }
  }
}

function teardownBatch(deps: BatchDispatchDeps, batchId: string, _now: Date): void {
  const state = deps.store.load();
  const batch = findBatch(state, batchId);
  if (!batch || batch.worktree === null) return;
  const root = deps.exec('git', ['rev-parse', '--show-toplevel'], deps.repoDir) ?? deps.repoDir;
  if (!isSafeWorktree(path.resolve(root), batch.worktree)) return;
  runTeardown(
    deps.exec,
    deps.repoDir,
    { worktree: batch.worktree, poolClaimed: false, branch: batch.branch },
    deps.fsExists
  );
}

// --- Entry point ---

/**
 * One batch reconcile+refill pass. Called from `engine.ts`'s `tick()` after
 * the issue-level pass — batches never compete with issues for a slot within
 * the same tick, they take whatever `runnableUnits` left after issue dispatch
 * (already true of a single combined `computeAssignments` call, since
 * `runnableUnits` orders issues before batches).
 */
export function runBatchTick(
  deps: BatchDispatchDeps,
  config: SchedConfig,
  dispatch: ResolvedDispatch
): BatchTickResult {
  const result = emptyResult();
  const now = deps.now();

  for (const batch of deps.store.load().batches) {
    if (batch.status === 'ready' && slotFor(deps.store.load(), batch.id) === undefined) {
      claimAndSetup(deps, config, dispatch, batch.id, now, result);
    }
  }

  for (const batch of deps.store.load().batches) {
    const slot = slotFor(deps.store.load(), batch.id);
    if (slot && (slot.status === 'running' || slot.status === 'assigned')) {
      if (batch.status === 'executing') {
        reconcileMemberSlot(deps, config, dispatch, batch.id, slot, now, result);
      } else if (batch.status === 'fixing') {
        reconcileFixSlot(deps, config, batch.id, slot, now, result);
      } else if (batch.status === 'reviewing' || batch.status === 'shipping') {
        reconcileTailSlot(deps, batch.id, slot, now, result);
      } else if (batch.status === 'deployed') {
        reconcileReportSlot(deps, batch.id, slot, now, result);
      }
      continue;
    }
    if (!slot && batch.status === 'validating') {
      runValidate(deps, config, dispatch, batch.id, now, result);
    } else if (!slot && batch.status === 'deployed') {
      spawnReportAgent(deps, config, dispatch, batch.id, now, result);
    }
  }

  reconcilePrWatch(deps, now, result);
  return result;
}
