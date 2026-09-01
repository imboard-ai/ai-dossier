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
 * failure rails (RFC F.2/F.8/F.9):
 *   executing → dissolving  (a member self-reports blocked, RFC F.1)
 *   validating → attributing → (fixing | evicting) → validating
 *              → dissolving
 * ```
 *
 * NO batch claim — not the first (`ready → executing`) nor any continuation
 * (a later member, the tail agent, the report agent, the fix agent) — ever
 * goes through `computeAssignments`/`runnableUnits`. Every one is a bespoke
 * free-capacity-gated assignment, the same shape `engine.ts`'s
 * `dispatchReportAgents` already uses (`runnableUnits` only ever offers a
 * `status === 'ready'` batch, i.e. the moment BEFORE any claim). Between
 * steps — a suite run, a PR merge wait — the slot is released to `idle` and
 * holds no capacity (AC5): only a live member/tail/report/fix agent holds a
 * slot.
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
  SHA_RE,
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
  SlotStatus,
} from './types';

/**
 * The four `ai-dossier cap run` outcomes (docs/reference/capabilities.md):
 * `ok` = the capability ran and passed; `task-failed` = it ran and the TASK
 * itself failed (trust the result); `automation-broken` = do not trust the
 * machinery (missing tool, timeout, bad manifest); `capability-unavailable` =
 * no manifest / no such id / `lifecycle: shadow` — no fast path here.
 */
export type CapOutcome = 'ok' | 'task-failed' | 'automation-broken' | 'capability-unavailable';

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
  /**
   * Runs one `ai-dossier cap run <capabilityId>` in a batch worktree for the
   * per-member incremental gate (#523 AC2 — "typecheck + focused tests via
   * `cap run test.focused` when available"). Optional and degrade-not-crash,
   * like `batchExec`/`runBatchSuite`: without it, or on `automation-broken`/
   * `capability-unavailable`, the gate is skipped — the member's own
   * `slot-cycle` run already attempted this fast path (with its own reasoning
   * fallback) before ever posting `review done`, so a repo with no manifest
   * loses nothing but the engine's independent re-check.
   */
  runCapability?: (worktree: string, capabilityId: string) => CapOutcome;
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
 * Sanitize one untrusted string before it lands in persisted state, the
 * journal, or a `sched status` terminal render (CWE-117/150): a milestone
 * `reason=` value originates from a GitHub issue comment (anyone who can
 * comment on a member issue can set it) and `parseMilestoneJson` copies it
 * verbatim with no charset or length bound. Strips control characters
 * (including the ANSI escape prefix) and bounds the length.
 */
function sanitizeUntrustedText(value: string): string {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: flattening control characters is the point
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .slice(0, 200)
  );
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

/**
 * Re-apply a state computed OUTSIDE the lock (by `recovery.ts`'s functions,
 * which necessarily shell out — `git revert`, `ai-dossier runstate post` —
 * and so cannot themselves run inside `store.withLock`) onto a FRESHLY
 * loaded state, touching only `batchId`'s own batch record (plus any new
 * half-batches a dissolve split created) and the named issues' queue
 * entries. Anything a concurrent process wrote to `fresh` in the meantime —
 * `sched enqueue`, `sched abandon`, `sched pause` all take the same
 * cross-process lock — survives, where blindly returning `computed` wholesale
 * would have silently clobbered it.
 */
function applyBatchAndIssues(
  fresh: SchedState,
  computed: SchedState,
  batchId: string,
  issues: readonly number[]
): SchedState {
  const updatedBatch = computed.batches.find((b) => b.id === batchId);
  const batches = fresh.batches.map((b) => (b.id === batchId && updatedBatch ? updatedBatch : b));
  // A `halved` dissolve creates new batch ids (`<id>-a`/`<id>-b`) that exist
  // in `computed` but not yet in `fresh`.
  for (const cb of computed.batches) {
    if (!batches.some((b) => b.id === cb.id)) batches.push(cb);
  }
  const issueSet = new Set(issues);
  const entries = fresh.entries.map((e) => {
    if (!issueSet.has(e.issue)) return e;
    return computed.entries.find((ce) => ce.issue === e.issue) ?? e;
  });
  return { ...fresh, batches, entries };
}

/**
 * Run the aggregate suite, treating a THROWING runner as a red suite with no
 * failing tests — `recovery.ts`'s own internal `runSuite` wrapper already
 * does this for calls that go through `beginAttribution`/`evictMembers`/etc,
 * but `runValidate`/`reconcileFixSlot` call `deps.runSuite` directly (they
 * need the result before deciding whether to call into `recovery.ts` at
 * all), so an unguarded throw there would propagate out of `runBatchTick`
 * into `tick()`'s own catch — a bare `tick-failed` with no unit id, repeating
 * every reconcile interval forever since nothing about the batch changed.
 */
function safeSuite(deps: BatchDispatchDeps, batchId: string, worktree: string): SuiteResult {
  try {
    return deps.runSuite(worktree);
  } catch (err) {
    const detail = `suite runner threw: ${(err as Error).message}`;
    journalEvent(deps, 'suite-failed', unit(batchId), { detail });
    return { ok: false, failing: [], detail };
  }
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

/**
 * The declared edge one step closer to `idle` from each `SlotStatus`
 * (`state.ts`'s `SLOT_BASE_TRANSITIONS`) — `recovering` has no direct edge to
 * `idle`, only `running`/`failed`, so it routes through `failed` first;
 * getting this wrong throws `IllegalTransitionError` inside a lock.
 */
const NEXT_TOWARD_IDLE: Readonly<Record<SlotStatus, SlotStatus | null>> = {
  idle: null,
  assigned: 'idle',
  running: 'exited',
  exited: 'verifying',
  verifying: 'complete',
  complete: 'idle',
  recovering: 'failed',
  failed: 'idle',
};

/**
 * Release a batch's slot to idle, whatever status it currently holds (mirrors
 * `engine.ts`'s `walkSlotToIdle` walk). Unlike that walk, this one does not
 * journal `slot-released` (#525) — batch-slot release is not yet wired to
 * that event, tracked as a follow-up.
 */
function releaseSlot(state: SchedState, batchId: string, now: Date): SchedState {
  let next = state;
  let slot = slotFor(next, batchId);
  // Bounded: the longest real walk (recovering → failed → idle, or
  // running → exited → verifying → complete → idle) is 4 hops.
  for (let i = 0; i < 8 && slot && slot.status !== 'idle'; i++) {
    const to = NEXT_TOWARD_IDLE[slot.status];
    if (to === null) break;
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
):
  | { ok: true; branch: string; worktree: string; runId: string }
  // `runId`, when the mint step succeeded before a LATER step failed — so the
  // caller can still post the `batch-setup blocked` milestone to a real run
  // id rather than silently skipping the post (a batch without ANY posted
  // milestone is invisible to `sched status`'s operator-facing story).
  | { ok: false; reason: string; runId?: string } {
  if (batch.anchor === null) return { ok: false, reason: 'no-anchor' };
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  const branch = `batch/${batch.id}-${date}`;
  const worktree = path.join(deps.repoDir, 'worktrees', `batch-${batch.id}-${date}`);
  if (!SAFE_REF_RE.test(branch) || !SAFE_REF_RE.test(batch.base_branch)) {
    return { ok: false, reason: 'invalid-branch-name' };
  }
  // Defense in depth alongside enqueue.ts's `BATCH_ID_RE` (CWE-22): the batch
  // id is enqueue-time-validated against path-hostile characters already, but
  // this is the actual point where it becomes a filesystem path — the same
  // containment check teardown applies on the way OUT must hold on the way IN.
  const root = deps.exec('git', ['rev-parse', '--show-toplevel'], deps.repoDir) ?? deps.repoDir;
  if (!isSafeWorktree(path.resolve(root), worktree)) {
    return { ok: false, reason: 'invalid-worktree-path' };
  }

  const runId = deps.exec(
    'ai-dossier',
    ['runstate', 'mint', '--issue', String(batch.anchor)],
    deps.repoDir
  );
  if (runId === null || runId.trim() === '') return { ok: false, reason: 'runstate-mint-failed' };
  const mintedRunId = runId.trim();

  if (deps.exec('git', ['fetch', 'origin', '--', batch.base_branch], deps.repoDir) === null) {
    return { ok: false, reason: 'fetch-failed', runId: mintedRunId };
  }
  if (deps.exec('git', ['branch', branch, `origin/${batch.base_branch}`], deps.repoDir) === null) {
    return { ok: false, reason: 'branch-create-failed', runId: mintedRunId };
  }
  if (deps.exec('git', ['push', '-u', 'origin', '--', branch], deps.repoDir) === null) {
    return { ok: false, reason: 'branch-push-failed', runId: mintedRunId };
  }
  if (deps.exec('git', ['worktree', 'add', '--', worktree, branch], deps.repoDir) === null) {
    return { ok: false, reason: 'worktree-add-failed', runId: mintedRunId };
  }
  return { ok: true, branch, worktree, runId: mintedRunId };
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
  if (!batch || batch.worktree === null) {
    // A leaked `assigned` slot with `pid: null` is invisible to `dead`
    // detection (nothing ever kills/reclaims it) — release it here rather
    // than leaving the batch permanently down one slot of capacity.
    journalEvent(deps, 'unit-failed', unit(batchId), {
      reason: 'no-worktree',
      detail: 'spawnMember: batch has no worktree — batch-setup has not landed',
    });
    return releaseSlot(state, batchId, now);
  }
  const memberIssue = batch.members[batch.executing_member - 1];
  if (memberIssue === undefined) {
    journalEvent(deps, 'unit-failed', unit(batchId), {
      reason: 'no-member',
      detail: `spawnMember: executing_member ${batch.executing_member} has no member issue`,
    });
    return releaseSlot(state, batchId, now);
  }

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
    journalEvent(deps, 'unit-failed', unit(batchId), {
      issue: memberIssue,
      reason: 'spawn-error',
      detail: `member #${memberIssue} spawn failed: ${(err as Error).message}`,
    });
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
 * First claim of a `ready` batch: assign it a slot, run batch-setup (real
 * network round trips — `ai-dossier runstate mint`, `git fetch`/`push`), land
 * the results, then spawn member 1 in the SAME slot rather than releasing and
 * re-claiming: setup already holds the slot for its own duration, and
 * splitting it into two capacity-gated claims would only add a second gate
 * for no benefit — the slot is going to member 1 immediately either way.
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
    // `ai-dossier runstate post` REQUIRES a run id (types.ts's `BatchEntry.run_id`
    // doc) — posting with an empty string silently fails the CLI call. Only post
    // when the mint step actually landed one (`setup.runId`, when a LATER step
    // failed) or the batch already carries one from an earlier attempt.
    const runId = setup.runId ?? batch.run_id;
    if (batch.anchor !== null && runId !== null) {
      poster(batch.anchor, runId, {
        phase: 'batch-setup',
        status: 'blocked',
        kv: { reason: setup.reason },
      });
    } else {
      journalEvent(deps, 'milestone-post-failed', unit(batchId), {
        detail: `batch-setup blocked (${setup.reason}) — no run id to post to yet`,
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
    if (!b || b.status !== 'ready') {
      // The batch moved (dissolved/abandoned) between the claim and here — a
      // real worktree now exists that nothing else knows about, and the slot
      // this claim took is still `assigned` with no agent in it. Release the
      // slot rather than leaking capacity; the worktree is orphaned (named in
      // the journal for manual cleanup — it is not this rare-race path's job
      // to guess whether reusing or removing it is safe).
      journalEvent(deps, 'unit-failed', unit(batchId), {
        reason: 'batch-left-ready-during-setup',
        detail: `worktree ${setup.worktree} created but batch is now '${b?.status ?? 'gone'}' — orphaned, manual cleanup required`,
      });
      return { state: releaseSlot(s, batchId, now), result: undefined };
    }
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
    if (!batch || batch.worktree === null || batch.anchor === null) {
      journalEvent(deps, 'unit-failed', unit(batchId), {
        reason: 'no-worktree-or-anchor',
        detail: 'spawnTailAgent: batch has no worktree/anchor',
      });
      return releaseSlot(state, batchId, now);
    }
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
      journalEvent(deps, 'unit-failed', unit(batchId), {
        reason: 'spawn-error',
        detail: `tail agent spawn failed: ${(err as Error).message}`,
      });
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
    if (!batch || batch.anchor === null) {
      journalEvent(deps, 'report-failed', unit(batchId), {
        detail: 'spawnReportAgent: batch has no anchor',
      });
      return releaseSlot(state, batchId, now);
    }
    const prNumber = batch.pr;
    if (prNumber === null) {
      journalEvent(deps, 'report-failed', unit(batchId), {
        detail: 'spawnReportAgent: batch has no parked pr recorded',
      });
      return releaseSlot(state, batchId, now);
    }
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
    // `range.commits` is persisted state — validate as shas before they
    // become git argv (CWE-88), the same discipline `recovery.ts`'s revert
    // path applies to the identical values (attribution.ts's `SHA_RE` doc).
    const commits = range.commits.filter((c) => SHA_RE.test(c));
    if (commits.length === 0) return { issue: range.issue, changedPaths: [], focusedTests: [] };
    const out = deps.exec(
      'git',
      ['show', '--name-only', '--format=', ...commits],
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

  const suite = safeSuite(deps, batchId, batch.worktree);
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
    deps.store.withLock((s) => ({
      state: applyBatchAndIssues(s, dissolve.state, batchId, dissolve.requeued),
      result: undefined,
    }));
    teardownBatch(deps, batchId);
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
  deps.store.withLock((s) => ({
    state: applyBatchAndIssues(s, fixing, batchId, []),
    result: undefined,
  }));
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
      journalEvent(deps, 'unit-failed', unit(batchId), {
        issue: offender,
        reason: 'fix-spawn-error',
        detail: `fix agent spawn failed: ${(err as Error).message}`,
      });
      // The fix attempt was already recorded `dispatched` by `beginFixAttempt`
      // — a spawn failure never dispatched anything, so resolve it `red`
      // (pure, no I/O — safe inside this lock) rather than leaving the state
      // claiming an attempt is in flight forever.
      const resolved = resolveFixAttempt(s, batchId, offender, 'red', rDeps).state;
      return releaseSlot(resolved, batchId, now);
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
  deps.store.withLock((s) => ({
    state: applyBatchAndIssues(s, outcome.state, batchId, outcome.requeued),
    result: undefined,
  }));
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

/**
 * After a member leaves `executing` (green, gate-failed, or self-blocked):
 * advance to the next member, or — on the last member — transition to
 * `validating` and run the aggregate suite. Shared by every exit from
 * `reconcileMemberSlot` so the pointer-advance rail exists once.
 */
function advanceMemberOrValidate(
  deps: BatchDispatchDeps,
  config: SchedConfig,
  dispatch: ResolvedDispatch,
  batchId: string,
  memberCount: number,
  currentMember: number,
  memberIssue: number,
  now: Date,
  result: BatchTickResult
): void {
  const isLast = currentMember >= memberCount;
  if (isLast) {
    deps.store.withLock((s) => {
      const b = findBatch(s, batchId);
      if (!b || b.status !== 'executing') return { state: s, result: undefined };
      return { state: transitionBatch(s, batchId, 'validating', {}, now), result: undefined };
    });
    runValidate(deps, config, dispatch, batchId, now, result);
    return;
  }
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

/**
 * Evict the current member and either dissolve, or continue the batch via
 * `advanceMemberOrValidate` — the shared tail of both member-failure rails
 * (self-reported blocked, and the incremental gate below).
 */
function evictMemberAndContinue(
  deps: BatchDispatchDeps,
  config: SchedConfig,
  dispatch: ResolvedDispatch,
  batchId: string,
  batch: BatchEntry,
  memberIssue: number,
  reason: string,
  now: Date,
  result: BatchTickResult
): void {
  const dissolved = evictMemberDirectly(deps, batchId, memberIssue, reason, now);
  if (dissolved) {
    result.failed.push(unit(batchId));
    return;
  }
  advanceMemberOrValidate(
    deps,
    config,
    dispatch,
    batchId,
    batch.members.length,
    batch.executing_member,
    memberIssue,
    now,
    result
  );
}

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

    // Incremental gate (#523 AC2): typecheck + focused tests via `cap run`,
    // when the repo has a manifest for them — a second, independent check
    // that the member's own self-reported "done" is real, matching this
    // codebase's "never trust a claimed completion" ethos (AC2/#464's
    // `isVerifiedComplete`). `task-failed` evicts the member directly, same
    // rail as a self-reported block (RFC F.1) — no aggregate suite has run
    // yet, so there is nothing to attribute.
    if (batch.worktree !== null && deps.runCapability) {
      const gateFailure = ['typecheck.run', 'test.focused']
        .map((id) => ({ id, outcome: deps.runCapability?.(batch.worktree as string, id) }))
        .find((r) => r.outcome === 'task-failed');
      if (gateFailure) {
        const reason = `incremental-gate-failed:${gateFailure.id}`;
        journalEvent(deps, 'unit-failed', unit(batchId), {
          issue: memberIssue,
          reason,
          detail: `cap run ${gateFailure.id} reported task-failed after member review done`,
        });
        deps.store.withLock((s) => ({ state: releaseSlot(s, batchId, now), result: undefined }));
        evictMemberAndContinue(
          deps,
          config,
          dispatch,
          batchId,
          batch,
          memberIssue,
          reason,
          now,
          result
        );
        return;
      }
      // `ok` / `automation-broken` / `capability-unavailable` all proceed —
      // only a definite task failure blocks a member here.
    }

    // The commit-range recompute (`git log`) is a blocking subprocess call —
    // it must run OUTSIDE the lock, like every other exec in this module;
    // the result then lands as a pure data patch under the lock (Convention
    // review: `recordRanges` used to run `git log` INSIDE the withLock
    // mutator, which is exactly what `engine.ts`'s own "a slow git call never
    // holds the lock" invariant exists to prevent).
    const ranges = memberRanges(boundaryCommits(deps, batch));
    deps.store.withLock((s) => {
      let n = releaseSlot(s, batchId, now);
      n = patchBatch(n, batchId, { ranges }, now);
      n = advanceMemberToValidated(n, memberIssue, now);
      return { state: n, result: undefined };
    });
    result.completed.push(unit(batchId));
    advanceMemberOrValidate(
      deps,
      config,
      dispatch,
      batchId,
      batch.members.length,
      batch.executing_member,
      memberIssue,
      now,
      result
    );
    return;
  }

  if (isMemberBlocked(milestone) || dead) {
    const rawReason = milestone?.keys.reason;
    const reason =
      typeof rawReason === 'string' && rawReason.length > 0
        ? sanitizeUntrustedText(rawReason)
        : dead
          ? 'agent-exited-unverified'
          : 'member-blocked';
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
    evictMemberAndContinue(
      deps,
      config,
      dispatch,
      batchId,
      batch,
      memberIssue,
      reason,
      now,
      result
    );
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
  // Pass 1 (pure — requeue + record the eviction): safe to run entirely
  // inside the lock, unlike `dissolveBatch` below, which shells out
  // (`deps.exec`/`postMilestone`) and so must NOT hold the lock while it runs.
  const triggered = deps.store.withLock((s) => {
    const b = findBatch(s, batchId);
    if (!b) return { state: s, result: false };
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
    return { state: next, result: updated !== undefined && checkDissolveTrigger(updated) };
  });
  if (!triggered) return false;

  // Pass 2 (outside the lock — dissolveBatch shells out): re-load fresh
  // (pass 1's write already landed), dissolve, then re-apply just this
  // batch's + the requeued members' state under a fresh lock.
  const state = deps.store.load();
  const batch = findBatch(state, batchId);
  if (!batch) return false;
  const rDeps = recoveryDeps(deps, batch, now);
  const outcome = dissolveBatch(
    state,
    batchId,
    { strategy: 'full', reason: 'eviction-threshold' },
    rDeps
  );
  deps.store.withLock((s) => ({
    state: applyBatchAndIssues(s, outcome.state, batchId, outcome.requeued),
    result: undefined,
  }));
  teardownBatch(deps, batchId);
  return true;
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

  const suite = safeSuite(deps, batchId, batch.worktree);
  const rDeps = recoveryDeps(deps, batch, now);
  const { state: resolved } = resolveFixAttempt(
    deps.store.load(),
    batchId,
    offenderRecord.issue,
    suite.ok ? 'green' : 'red',
    rDeps
  );
  deps.store.withLock((s) => ({
    state: applyBatchAndIssues(s, resolved, batchId, []),
    result: undefined,
  }));

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
    teardownBatch(deps, batchId);
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

/**
 * Remove the batch's shared worktree — called both on the happy path
 * (`reconcileReportSlot`, after `batch-report done`) and on every dissolve
 * path (`runValidate`'s unattributable-suite dissolve, `evictMemberDirectly`'s
 * eviction-threshold dissolve): a dissolved batch's worktree is otherwise
 * left on disk forever, since nothing else ever calls this for it.
 */
function teardownBatch(deps: BatchDispatchDeps, batchId: string): void {
  const state = deps.store.load();
  const batch = findBatch(state, batchId);
  if (!batch || batch.worktree === null) return;
  const root = deps.exec('git', ['rev-parse', '--show-toplevel'], deps.repoDir) ?? deps.repoDir;
  if (!isSafeWorktree(path.resolve(root), batch.worktree)) {
    journalEvent(deps, 'teardown-failed', unit(batchId), {
      reason: 'unsafe-worktree-path',
      detail: batch.worktree,
    });
    return;
  }
  const result = runTeardown(
    deps.exec,
    deps.repoDir,
    { worktree: batch.worktree, poolClaimed: false, branch: batch.branch },
    deps.fsExists
  );
  journalEvent(
    deps,
    result.cleanup === 'done' ? 'teardown-done' : 'teardown-failed',
    unit(batchId),
    {
      cleanup: result.cleanup,
      detail: result.detail,
      worktree: batch.worktree,
    }
  );
}

// --- Entry point ---

/**
 * One batch reconcile+refill pass. Called from `engine.ts`'s `tick()` after
 * the issue-level pass — batches never compete with issues for a slot within
 * the same tick because this pass runs strictly after `dispatchAssignments`
 * already filled every slot it could (see the module doc: batch claims never
 * go through `computeAssignments`/`runnableUnits` at all). Loads and saves
 * state itself via `deps.store.withLock` — the caller holds no lock across
 * this call. `deps.exec` and `deps.runSuite` are mandatory; `deps.
 * runCapability` is independently optional (AC2's incremental gate is itself
 * a "when available" fast path).
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
    if (slot) continue; // live but neither running/assigned (e.g. mid-verify) — next tick
    if (batch.status === 'validating') {
      runValidate(deps, config, dispatch, batch.id, now, result);
    } else if (batch.status === 'deployed') {
      spawnReportAgent(deps, config, dispatch, batch.id, now, result);
    } else if (batch.status === 'executing') {
      // A prior spawn threw, or `claimAndSpawn` found zero free capacity —
      // either way the batch is stuck mid-member with no slot and nothing
      // else will ever retry it (Conformance review AC5 caveat; Supportability
      // review #12). Retrying every tick is safe: `claimAndSpawn` itself is
      // the capacity gate, so this is a no-op until a slot actually frees up.
      spawnMemberContinuation(deps, config, dispatch, batch.id, now, result);
    } else if (batch.status === 'reviewing' || batch.status === 'shipping') {
      // Same wedge, for a dead-or-never-claimed tail agent.
      spawnTailAgent(deps, config, dispatch, batch.id, now, result);
    } else if (batch.status === 'fixing') {
      // `beginFixAttempt` already recorded this member's ONE attempt as
      // `dispatched` before `claimAndSpawn` could find capacity — retrying the
      // exact same dispatch isn't reconstructible from persisted state (only
      // the outcome is persisted, not the command/prompt), so resolve it
      // `red` (conservatively: the member loses its one attempt and evicts on
      // the next validate pass, which is safe — never a permanent wedge).
      const state = deps.store.load();
      const b = findBatch(state, batch.id);
      const offenderRecord = b
        ? [...b.fix_attempts].reverse().find((a) => a.outcome === 'dispatched')
        : undefined;
      if (b && offenderRecord) {
        const rDeps = recoveryDeps(deps, b, now);
        const { state: resolved } = resolveFixAttempt(
          state,
          batch.id,
          offenderRecord.issue,
          'red',
          rDeps
        );
        deps.store.withLock((s) => ({
          state: applyBatchAndIssues(s, resolved, batch.id, []),
          result: undefined,
        }));
      }
    }
  }

  reconcilePrWatch(deps, now, result);
  return result;
}
