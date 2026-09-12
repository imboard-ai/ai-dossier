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
 * bisecting, which `attributing → dissolving` already models. No per-phase
 * stall/escalation ladder for batch sub-agents — a dead-without-verification
 * agent is treated as blocked and evicted/reported rather than redispatched
 * stronger. Both are documented follow-ups, not gaps discovered later.
 *
 * `runBatchSetup` (#561) tries a pool claim first (already warm, mirroring
 * `teardown.ts`'s `poolReturn` — same `npx`-through-`deps.exec` pattern, never
 * a direct in-process `claim()` import, which resolves its git root from
 * `process.cwd()` and would break this module's `deps.repoDir` testability
 * contract); on the cold `git worktree add` path it warms the worktree itself
 * before returning, so a member's first command is never the one that
 * discovers `node_modules` is missing (`env-cold`, `docs/agent-traps.md`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type DispatchApiError, parseDispatchApiError, parseLastToolUse } from '@ai-dossier/core';
import {
  readPoolFileConfig,
  resolveProjectDir,
  resolveWarmCommands,
} from '@ai-dossier/worktree-pool';
import {
  type BoundaryCommit,
  hasEarnedFailureEvidence,
  type MemberFootprint,
  memberRanges,
  parseBoundaryCommits,
  SAFE_REF_RE,
  SHA_RE,
} from './attribution';
import {
  batchFixLogPath,
  batchGateLogPath,
  batchMemberLogPath,
  batchReportLogPath,
  batchTailLogPath,
  buildBatchReportPrompt,
  buildBatchTailPrompt,
  buildMemberPrompt,
  DispatchProfileError,
  fileSizeOrZero,
  journalCmdModelFields,
  type ResolvedDispatch,
  resolveProfiledDispatch,
  resolveTierSpawn,
  type SpawnDeps,
} from './dispatch';
import { recordDispatchApiError, resetDispatchApiErrorStreak } from './dispatch-health';
import {
  type GroundTruth,
  type GroundTruthMilestone,
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
import { batchRank, compareByPriority } from './readiness';
import {
  beginAttribution,
  beginFixAttempt,
  blockBatch,
  checkDissolveTrigger,
  createExecMilestonePoster,
  dissolveBatch,
  evictMembers,
  type RecoveryDeps,
  resolveFixAttempt,
  type SuiteResult,
} from './recovery';
import { buildSchedRunLogEntry, finalizeRunLogEntry, readDispatchLog } from './run-log';
import { assignToIdleSlot, freeCapacity } from './scheduler';
import {
  allowedBatchTransitions,
  appendEvictions,
  CLEARED_PR_WATCH_FIELDS,
  duplicateEvictionDetail,
  findBatch,
  findEntry,
  isPreservedMember,
  patchBatch,
  patchSlot,
  releaseBatchSlot,
  requeueMember,
  slotForBatch,
  transitionBatch,
  transitionIssue,
  transitionSlot,
} from './state';
import { type FsExists, isSafeWorktree, POOL_ARGS_PREFIX, POOL_BIN, runTeardown } from './teardown';
import type {
  AttributionMethod,
  BatchEntry,
  BatchStatus,
  CapabilityGateResult,
  CapOutcome,
  EvictionRecord,
  IssueStatus,
  JournalEventName,
  ModelTier,
  SchedConfig,
  SchedState,
  SlotEntry,
} from './types';
import {
  IllegalTransitionError,
  JOURNAL_DEDUP_REANNOUNCE_TICKS,
  resolveDissolvePolicy,
  SchedNotFoundError,
  TERMINAL_BATCH_STATUSES,
} from './types';

// `CapOutcome` moved to `types.ts` (#583, so `BatchEntry.member_gates` can use
// it without an import cycle) — re-exported here so `index.ts`'s existing
// `import { type CapOutcome } from './batch-dispatch'` keeps working.
export type { CapOutcome } from './types';

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
  /**
   * Exec for the cold-path warm-up install/build (#561), on its own budget —
   * a real `npm ci` + build routinely exceeds the git-op timeout `exec` is
   * tuned for. Falls back to `exec` when not supplied (existing callers/tests
   * are unaffected; production wiring should still give this its own longer
   * timeout, e.g. `@ai-dossier/worktree-pool`'s `WARM_COMMAND_TIMEOUT_MS`).
   */
  warmExec?: ExecFn;
  /** Runs the aggregate suite inside a batch worktree; batches never leave `validating` without one. */
  runSuite: (worktree: string) => SuiteResult;
  /**
   * Runs one `ai-dossier cap run <capabilityId>` in a batch worktree. Two call
   * sites, different degrade contracts:
   * - the per-member incremental gate (#523 AC2, revised #583): without this
   *   hook, the gate is skipped entirely (the member's own member-cycle run
   *   already attempted this fast path before ever posting `review done`, so
   *   a repo with no manifest loses nothing but the engine's independent
   *   re-check). With the hook: `ok` advances, `task-failed` evicts,
   *   `automation-broken`/`capability-unavailable` BLOCK the batch
   *   (`gate-inconclusive`) rather than silently proceeding — #583 found the
   *   old "proceed on anything but task-failed" policy let a script's own
   *   "I could not run this" signal (a non-zero exit reporting it never
   *   really tested anything) masquerade as either a pass or a real failure.
   * - batch-setup's `worktree.prepare` warm step (#561, `warmColdBatchWorktree`):
   *   unaffected by #583's gate policy change — `undefined`/
   *   `capability-unavailable`/`automation-broken` still fall through to
   *   package-manager detection, and a declared-and-`task-failed` capability
   *   still hard-fails the whole batch setup (a repo that owns its warm-up
   *   should never be silently second-guessed by a fallback underneath it).
   */
  runCapability?: (worktree: string, capabilityId: string) => CapabilityGateResult;
  fsExists?: FsExists;
  /**
   * Home directory for `~/.dossier/runs.jsonl` (#564) — mirrors `EngineDeps.homeDir`.
   * Undefined defers to `appendSchedRunLog`'s own `os.homedir()` default.
   */
  homeDir?: string;
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

/**
 * Why a member is being evicted: the `reason` recorded in `evictions[]` and the operator-
 * facing `detail`/`extraKv` journaled alongside it. One object rather than three adjacent
 * positional arguments — `reason` and `detail` are both strings, and transposing them
 * compiles cleanly while writing a prose sentence into the eviction record's `reason`,
 * corrupting exactly the field #613 exists to keep trustworthy.
 */
export interface MemberFailure {
  reason: string;
  detail: string;
  extraKv?: Record<string, string>;
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

/**
 * Read a dead batch dispatch's own log and classify it (#629 AC3) — tail,
 * member, fix and report all reach a `dead` agent the same way (`pid` no
 * longer alive), and every one of them previously treated that exit as a
 * real failure (`tail-agent-exited-unverified`, member eviction,
 * `report-failed`, a red fix-attempt resolution) with no way to tell a
 * confirmed provider API error apart from an agent that actually ran.
 *
 * `offset` fences this read to THIS dispatch's slice, mirroring the
 * per-issue path's `dispatchLogSlice`/`log_offset_at_spawn` (#524): these
 * batch log paths are per-ROLE, not per-dispatch, and opened in append mode
 * (`dispatch.ts`'s `openLogForAppend`), so a byte-0 read would keep
 * classifying a LATER dead exit — one that itself wrote no `result` event at
 * all (killed, OOM, an operator killing the tick — the #629 incident itself)
 * — against a STALE `result` line from an earlier dispatch, permanently
 * suppressing genuine failures and re-arming the pause on every reconcile
 * (#629 review). Each batch spawn function stamps `log_offset_at_spawn` on
 * its slot patch, exactly like the per-issue spawn path already does.
 */
function readDispatchApiError(logFile: string, offset: number): DispatchApiError | null {
  return parseDispatchApiError(readDispatchLog(logFile, offset));
}

/**
 * Classify a dead batch dispatch and, if it is a confirmed provider API
 * error, record it against the shared #505/#629 pause (the same mechanism
 * `engine.ts`'s `completeUnitOrRecover` uses — see `dispatch-health.ts`) and
 * release the slot, all inside ONE lock (a crash between recording and
 * releasing would otherwise leave the counter incremented with the slot
 * still held by a dead pid — #629 review). Returns whether it classified as
 * an API error — the caller's cue to skip its normal failure handling
 * (eviction, `tail-agent-exited-unverified`, `report-failed`, a red
 * fix-attempt resolution) entirely.
 *
 * `release: false` (the fix-agent caller) records without releasing — that
 * caller has its own release a few lines later, after also deciding whether
 * to resolve the fix attempt.
 */
function handleDeadDispatchApiError(
  deps: BatchDispatchDeps,
  batchId: string,
  logFile: string,
  offset: number,
  now: Date,
  options: { release?: boolean } = {}
): boolean {
  const apiError = readDispatchApiError(logFile, offset);
  if (!apiError) return false;
  deps.store.withLock((s) => {
    let n = recordDispatchApiError(
      (event, unitId, extra) => journalEvent(deps, event, unitId, extra),
      s,
      unit(batchId),
      apiError
    );
    if (options.release ?? true) n = releaseSlot(n, batchId, now);
    return { state: n, result: undefined };
  });
  return true;
}

/**
 * Last ~500 bytes of a gate's output tail, falling back to the envelope's
 * `reason` when no subprocess ran (#583 AC1/AC3 review: `capability-unavailable`
 * and a failed assumption probe carry no output_tail — `reason` is the only
 * explanation available for those) — journal details stay compact; the full
 * tail lives in the per-gate log file. UTF-8-safe (never splits a multi-byte
 * character) — chars would risk exactly that, hence `Buffer`, matching
 * `cli/src/capability.ts`'s `truncateTailBytes`.
 */
function gateDetailExcerpt(
  outputTail: string | null | undefined,
  reason?: string | null
): string | undefined {
  const text = outputTail || reason;
  if (!text) return undefined;
  const buf = Buffer.from(text, 'utf-8');
  return buf.length > 500 ? buf.subarray(buf.length - 500).toString('utf-8') : text;
}

/** A journal detail with the gate's output excerpt appended when there is one. */
function withExcerpt(message: string, excerpt: string | undefined): string {
  return excerpt ? `${message}: ${excerpt}` : message;
}

/**
 * Which block-the-batch branch a gate result took (#594 AC3). Both an
 * `automation-broken`/`capability-unavailable` result and a `task-failed` the
 * gate could not evidence land on `gate-inconclusive:<cap>`; only the detail
 * distinguishes "the capability is broken" from "the capability claimed a
 * failure it did not prove", and those need different operator responses.
 */
function describeInconclusive(gate: {
  id: string;
  outcome: string;
  outputTail?: string | null;
}): string {
  if (gate.outcome !== 'task-failed') return `reported ${gate.outcome}`;
  const captured = gate.outputTail?.trim();
  return captured
    ? `reported task-failed with no failing-test evidence in its ${Buffer.byteLength(captured, 'utf-8')}-byte capture`
    : 'reported task-failed with an empty capture — no evidence at all';
}

/**
 * The `command timed out after <N>ms` reason shape (#681) — produced ONLY by
 * this repo's own machinery, at exactly two sites: `cli/src/capability.ts`'s
 * `classifySpawnResult` (the capability entry's own `timeout_ms`) and
 * `cli/src/commands/sched.ts`'s `createBatchCapabilityRunner` (the runner's
 * own `spawnSync` timeout, `BATCH_SUITE_TIMEOUT_MS`). The gate classifies on
 * it to tell "the harness needed more time than it was given" (#681 — a
 * statement about DURATION, not about the harness's reliability) apart from a
 * genuine machinery failure (missing tool, broken manifest, evidence-free
 * spawn error), which must keep blocking (#583/#585/#625 rails intact).
 */
const GATE_TIMEOUT_REASON = /^command timed out after \d+ms$/;

function isGateTimeout(gate: { outcome: string; reason?: string | null }): boolean {
  return gate.outcome === 'automation-broken' && GATE_TIMEOUT_REASON.test(gate.reason ?? '');
}

/**
 * Best-effort per-gate diagnostic log (#583 AC1) — mirrors `appendCapLog`'s
 * never-crash contract: a log-write failure must not interrupt the gate
 * decision itself.
 */
function writeGateLog(
  deps: BatchDispatchDeps,
  batchId: string,
  capabilityId: string,
  issue: number,
  outputTail: string | null | undefined
): void {
  if (!outputTail) return;
  try {
    const logPath = batchGateLogPath(deps.store.runsDir, batchId, capabilityId, issue);
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(logPath, outputTail, { mode: 0o600 });
  } catch {
    // diagnostic only — never fail the gate decision over a log write
  }
}

/**
 * Persist the incremental gate's most recent verdict for a member on
 * `BatchEntry.member_gates` (#583 AC4) — shared by the live gate
 * (`reconcileMemberSlot`) and `sched resume --batch`'s recheck
 * (`resumeBlockedGate`), so a resumed batch's status never shows a stale
 * outcome from before the recheck ran.
 */
function recordMemberGate(
  deps: BatchDispatchDeps,
  batchId: string,
  memberIssue: number,
  gate: { id: string; outcome: CapOutcome; outputTail?: string | null; durationMs?: number | null },
  now: Date
): void {
  deps.store.withLock((s) => {
    const b = findBatch(s, batchId);
    return {
      state: patchBatch(
        s,
        batchId,
        {
          member_gates: {
            ...(b?.member_gates ?? {}),
            [String(memberIssue)]: {
              capability: gate.id,
              outcome: gate.outcome,
              output_tail: gate.outputTail ?? null,
              duration_ms: gate.durationMs ?? null,
              at: now.toISOString(),
            },
          },
        },
        now
      ),
      result: undefined,
    };
  });
}

/**
 * #609: the lookup and the release walk both moved to `state.ts`
 * (`slotForBatch` / `releaseBatchSlot`). They have a second caller that must
 * not disagree with this one — `scheduler.ts`'s `abandonBatch`, which
 * dissolved a batch without releasing its slot and leaked it permanently.
 * These thin aliases keep this module's call sites reading as they did.
 */
function slotFor(state: SchedState, batchId: string): SlotEntry | undefined {
  return slotForBatch(state, batchId);
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
    // A throw is exactly "no trustworthy report" (#562) — must not default to
    // `readable: true` and look like a parseable report naming zero failures.
    return { ok: false, failing: [], readable: false, detail };
  }
}

function recoveryDeps(
  deps: BatchDispatchDeps,
  config: SchedConfig,
  batch: BatchEntry,
  now: Date
): RecoveryDeps {
  return {
    exec: deps.exec,
    repoDir: batch.worktree ?? deps.repoDir,
    journal: deps.journal,
    postMilestone: createExecMilestonePoster(deps.exec, { repoDir: deps.repoDir }),
    runSuite: batch.worktree !== null ? () => deps.runSuite(batch.worktree as string) : undefined,
    dissolvePolicy: resolveDissolvePolicy(config.dissolve_policy),
    now: () => now,
  };
}

function releaseSlot(state: SchedState, batchId: string, now: Date): SchedState {
  return releaseBatchSlot(state, batchId, now);
}

// --- Batch setup (ready → executing, member 1) ---

/**
 * A pool claim already returns a warm worktree (deps installed, built), so
 * only the cold `git worktree add` path needs its own warm step (#561).
 *
 * Tries `worktree.prepare` via the optional `runCapability` hook first (a
 * repo that declares it in its manifest knows its own warm-up best) — a
 * declared-and-`task-failed` capability hard-fails the whole batch setup
 * (deliberately NOT degrade-not-crash, unlike every other `runCapability`
 * call site in this file: a repo that owns `worktree.prepare` should never
 * be silently second-guessed by falling back underneath it). `undefined`,
 * `capability-unavailable` (no such id declared) AND `automation-broken`
 * (broken manifest, missing tool, timeout — "do not trust the machinery",
 * not "the task failed") all fall through to the generic path below.
 *
 * The generic path reuses `@ai-dossier/worktree-pool`'s package-manager
 * detection, guarded on `package.json` actually being present — `npm
 * install` (and the pnpm/yarn/bun equivalents) hard-fail with no
 * `package.json` at all, so an unguarded call would turn "nothing to warm"
 * into a false failure for every non-Node repo. The guard is bypassed when
 * `.worktree-pool.json` declares explicit `warm_commands` — the escape hatch
 * for a repo whose warm-up isn't `npm install`-shaped at all.
 *
 * Warm commands run on `deps.warmExec ?? deps.exec` — a separate, longer
 * budget than the git/milestone calls `deps.exec` is tuned for (a cold
 * install+build routinely exceeds a git-op timeout; see `BatchDispatchDeps`).
 *
 * Journals `batch-warmup-done`/`batch-warmup-failed` with the elapsed time
 * appended to `detail` either way (satisfying AC1 even on the no-op branch —
 * `JournalEvent` has no dedicated `duration_ms` field).
 */
function warmColdBatchWorktree(
  deps: BatchDispatchDeps,
  batch: BatchEntry,
  worktree: string,
  now: Date,
  /** Prefixed onto the journaled detail — e.g. `pool-claim-invalid:` when the cold path was taken because a pool claim returned unusable output, rather than the ordinary "no warm spares" case. */
  poolNote = ''
): { ok: true } | { ok: false; reason: string } {
  const warmStart = deps.now();
  const elapsedMs = () => deps.now().getTime() - warmStart.getTime();
  const fail = (tag: string): { ok: false; reason: string } => {
    deps.journal.append(
      unitEvent('batch-warmup-failed', unit(batch.id), {
        detail: `${poolNote}${tag} ${elapsedMs()}ms`,
      }),
      now
    );
    return { ok: false, reason: `warmup-failed:${tag}` };
  };
  const done = (tag: string): { ok: true } => {
    deps.journal.append(
      unitEvent('batch-warmup-done', unit(batch.id), {
        detail: `${poolNote}${tag} ${elapsedMs()}ms`,
      }),
      now
    );
    return { ok: true };
  };

  const capOutcome = deps.runCapability?.(worktree, 'worktree.prepare')?.outcome;
  if (capOutcome === 'ok') return done('cap:worktree.prepare');
  if (capOutcome === 'task-failed') return fail('cap:worktree.prepare:task-failed');
  // `undefined` (no hook injected) / `capability-unavailable` (not declared)
  // / `automation-broken` (declared but the machinery itself is untrustworthy)
  // all fall through to the generic package-manager path below.

  const fsExists = deps.fsExists ?? ((p: string) => fs.existsSync(p));
  const cfg = readPoolFileConfig(deps.repoDir);
  const projectDir = resolveProjectDir(worktree, cfg.project_subdir);
  // `.worktree-pool.json`'s `project_subdir` is repo config, not attacker
  // input, but a `../`-shaped value would otherwise run install/build
  // OUTSIDE the batch worktree entirely — skip rather than warm the wrong
  // directory (or fail the whole batch over a misconfigured pool file).
  if (projectDir !== worktree && !projectDir.startsWith(worktree + path.sep)) {
    return done('skipped:project-dir-outside-worktree');
  }
  const hasExplicitWarmCommands = (cfg.warm_commands?.length ?? 0) > 0;
  if (!hasExplicitWarmCommands && !fsExists(path.join(projectDir, 'package.json'))) {
    return done('skipped:no-package-json');
  }

  const commands = resolveWarmCommands(projectDir, cfg);
  for (const [i, cmd] of commands.entries()) {
    const [bin, ...args] = cmd;
    if (bin === undefined) return fail(`pm:${i + 1}/${commands.length}:empty-command`);
    if ((deps.warmExec ?? deps.exec)(bin, args, projectDir) === null) {
      return fail(`pm:${i + 1}/${commands.length}:${bin}`);
    }
  }
  const pm = commands[0]?.[0] ?? 'none';
  return done(`pm:${pm}:${commands.length}cmds`);
}

/**
 * `batch/<id>-<YYYYMMDD>` off `base_branch`, and a fresh runstate run id
 * minted against the anchor. The worktree is either a pool claim (already
 * warm) or a cold `git worktree add` that this function then warms itself
 * (#561, see the module doc) — either way, the worktree is warm before this
 * returns `ok: true`. All-or-nothing: any failed step reports the step name
 * and nothing is partially recorded on the batch.
 */
function runBatchSetup(
  deps: BatchDispatchDeps,
  batch: BatchEntry,
  now: Date
):
  | { ok: true; branch: string; worktree: string; runId: string; poolClaimed: boolean }
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

  // Pool claim first — a claimed worktree is already warm by construction, so
  // no separate warm step runs for it (AC2). `claim()` itself never pushes
  // the branch (mirrors setup-issue-workflow's per-issue pool-claim step),
  // so that still happens here on success.
  const claimed = deps.exec(
    POOL_BIN,
    [...POOL_ARGS_PREFIX, 'claim', '--issue', String(batch.anchor), '--branch', branch],
    deps.repoDir
  );
  const claimedWorktree = claimed?.trim();
  // Same hardening `teardown.ts`'s destructive sinks apply to a worktree path
  // (no NUL/newline, no unresolved `..`) — this one is our own CLI's stdout,
  // not attacker input, but garbage here would otherwise be trusted verbatim
  // as `BatchEntry.worktree` and used as a spawn/exec cwd for every member.
  const claimIsUsable =
    !!claimedWorktree &&
    !claimedWorktree.includes('\0') &&
    !claimedWorktree.includes('\n') &&
    path.isAbsolute(claimedWorktree) &&
    path.resolve(claimedWorktree) === claimedWorktree &&
    (deps.fsExists ?? ((p: string) => fs.existsSync(p)))(claimedWorktree);
  if (claimedWorktree && claimIsUsable) {
    if (deps.exec('git', ['push', '-u', 'origin', '--', branch], claimedWorktree) === null) {
      // Return the claim rather than leaking a permanently `assigned` pool
      // entry nothing else will ever reference — `BatchEntry` only records
      // `worktree`/`pool_claimed` on the `ok: true` path below.
      deps.exec(
        POOL_BIN,
        [...POOL_ARGS_PREFIX, 'return', '--path', claimedWorktree, '--json'],
        deps.repoDir
      );
      return { ok: false, reason: 'branch-push-failed', runId: mintedRunId };
    }
    return { ok: true, branch, worktree: claimedWorktree, runId: mintedRunId, poolClaimed: true };
  }
  // A non-null, non-empty, unusable claim response (rather than a plain "no
  // warm spares" null/empty) is unusual enough to note on the batch that
  // otherwise cold-builds silently.
  const poolNote = claimedWorktree ? 'pool-claim-invalid:' : '';

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
  const warmed = warmColdBatchWorktree(deps, batch, worktree, now, poolNote);
  if (!warmed.ok) {
    // Restore the "all-or-nothing" contract this function documents: a warm
    // failure otherwise leaves the branch pushed and the worktree on disk,
    // so the NEXT tick's retry dies at `branch-create-failed` forever
    // instead of ever reaching warm-up again. Best-effort — a failed cleanup
    // here just means the next retry's `worktree-add-failed`/`branch-create-failed`
    // surfaces the leftover instead, no worse than before this cleanup existed.
    deps.exec('git', ['worktree', 'remove', '--force', '--', worktree], deps.repoDir);
    deps.exec('git', ['branch', '-D', branch], deps.repoDir);
    deps.exec('git', ['push', 'origin', '--delete', branch], deps.repoDir);
    return { ok: false, reason: warmed.reason, runId: mintedRunId };
  }
  return { ok: true, branch, worktree, runId: mintedRunId, poolClaimed: false };
}

// --- Member worktrees (#677, RFC-0001 §J.3) ---

/**
 * The current member's own branch: `batch/<id>-m<n>-<issue>` (#677) — member
 * index and issue both in the name, and deterministic from persisted state,
 * so a takeover redispatch, a `sched resume --batch` recheck, and teardown
 * all re-derive the same string without a lookup table. Distinct from the
 * integration branch (`batch/<id>-<date>`): the member commits here, the
 * scheduler lands it there.
 */
export function memberBranchFor(batchId: string, memberIndex: number, issue: number): string {
  return `batch/${batchId}-m${memberIndex}-${issue}`;
}

/** The worktree path a cold member-worktree prep creates for one member. */
function memberWorktreePathFor(
  deps: BatchDispatchDeps,
  batchId: string,
  memberIndex: number,
  issue: number
): string {
  return path.join(deps.repoDir, 'worktrees', `batch-${batchId}-m${memberIndex}-${issue}`);
}

/** What {@link prepareMemberWorktree} hands the spawn site. */
interface MemberWorktree {
  branch: string;
  worktree: string;
  poolClaimed: boolean;
}

/**
 * Prepare the CURRENT member's own worktree and branch (#677, AC5): a
 * worktree whose checked-out branch is `memberBranchFor(...)` created OFF the
 * integration branch, warm before the member's first command, and pushed so
 * the member agent can commit and push to it — `member-cycle`'s Step 0
 * preconditions (inside a worktree, on YOUR member branch, clean, env warm).
 * The agent never creates either; a prompt change without this preparation
 * fails every member on precondition 2 (the reason #677 exists).
 *
 * Pool claim first — warm by construction, mirroring `runBatchSetup`. A pool
 * spare sits on the default branch, so the claimed tree is re-pointed at the
 * member branch off the INTEGRATION branch (`git checkout -B` against the
 * `origin/<integration>` ref `runBatchSetup`'s push already created
 * repo-wide); checkout preserves the installed `node_modules`. Cold fallback:
 * `git worktree add` at the integration branch tip + `warmColdBatchWorktree`
 * (#561 — a cold member is an evicted member).
 *
 * An on-disk worktree for the SAME member is reused as-is (takeover
 * redispatch, api-error hold retry): the branch is already checked out, the
 * tree already warm, and a takeover agent resumes in place — possibly dirty,
 * which is the parent's state to reason about, not something to reset.
 *
 * All-or-nothing like `runBatchSetup`; the exec calls run OUTSIDE any store
 * lock (the caller's contract), with results landed as pure data.
 */
/**
 * The pool CLI's stdout hardening shared by `runBatchSetup` and the member
 * prep (no NUL/newline, absolute, resolved, on disk) — our own CLI's
 * output, but garbage would otherwise be trusted as a `BatchEntry`
 * worktree path and used as a spawn/exec cwd.
 */
function usablePoolClaim(deps: BatchDispatchDeps, w: string | undefined): w is string {
  return (
    !!w &&
    !w.includes('\0') &&
    !w.includes('\n') &&
    path.isAbsolute(w) &&
    path.resolve(w) === w &&
    (deps.fsExists ?? ((p: string) => fs.existsSync(p)))(w)
  );
}

function prepareMemberWorktree(
  deps: BatchDispatchDeps,
  batch: BatchEntry,
  memberIndex: number,
  issue: number,
  now: Date
): ({ ok: true } & MemberWorktree) | { ok: false; reason: string } {
  if (batch.branch === null) return { ok: false, reason: 'no-integration-branch' };
  const branch = memberBranchFor(batch.id, memberIndex, issue);
  const worktree = memberWorktreePathFor(deps, batch.id, memberIndex, issue);
  if (!SAFE_REF_RE.test(branch)) return { ok: false, reason: 'invalid-member-branch-name' };
  const fsExists = deps.fsExists ?? ((p: string) => fs.existsSync(p));
  const root = deps.exec('git', ['rev-parse', '--show-toplevel'], deps.repoDir) ?? deps.repoDir;
  if (!isSafeWorktree(path.resolve(root), worktree)) {
    return { ok: false, reason: 'invalid-member-worktree-path' };
  }

  // All-or-nothing rollback for the cold path (same contract as
  // `runBatchSetup`): a warm or push failure otherwise leaves a cold
  // worktree the NEXT retry's exists-check reuses forever cold — exactly
  // the env-cold eviction #561 removed.
  const rollbackColdPrep = () => {
    deps.exec('git', ['worktree', 'remove', '--force', '--', worktree], deps.repoDir);
    deps.exec('git', ['branch', '-D', branch], deps.repoDir);
  };

  const exists = fsExists(worktree);
  if (exists) {
    // Crash-window reuse: the derived-path tree exists on disk but the
    // spawn never landed (fields null) — OR a pool-claimed tree whose
    // directory name equals the derived slug (the pool renames claims to
    // the branch slug, so a pool tree CAN sit at the derived path; the
    // persisted `member_pool_claimed` is the only record of which). In
    // either case the on-disk tree wins: reuse it rather than re-branching.
    // #632: fires once per crash window, not per tick — the call sites run
    // at spawn time (a transition point), and `claimMemberResolution`
    // gates the member advance; the capacity pre-check in
    // `spawnMemberContinuation` keeps the wedge path from re-entering
    // while no slot is free.
    deps.journal.append(
      unitEvent('member-worktree-reused', unit(batch.id), {
        issue,
        detail: worktree,
      }),
      now
    );
    return {
      ok: true,
      branch: batch.member_branch ?? branch,
      worktree: batch.member_worktree ?? worktree,
      poolClaimed: batch.member_pool_claimed,
    };
  }

  const claimed = deps.exec(
    POOL_BIN,
    [...POOL_ARGS_PREFIX, 'claim', '--issue', String(issue), '--branch', branch],
    deps.repoDir
  );
  const claimedWorktree = claimed?.trim();
  if (claimedWorktree && usablePoolClaim(deps, claimedWorktree)) {
    // Re-point the warm spare at the member branch off the integration
    // branch — `origin/<integration>` exists repo-wide (runBatchSetup pushed
    // it), and `checkout -B` preserves the installed node_modules.
    if (
      deps.exec('git', ['checkout', '-B', branch, `origin/${batch.branch}`], claimedWorktree) ===
      null
    ) {
      deps.exec(
        POOL_BIN,
        [...POOL_ARGS_PREFIX, 'return', '--path', claimedWorktree, '--json'],
        deps.repoDir
      );
      return { ok: false, reason: 'member-branch-checkout-failed' };
    }
    if (deps.exec('git', ['push', '-u', 'origin', '--', branch], claimedWorktree) === null) {
      deps.exec(
        POOL_BIN,
        [...POOL_ARGS_PREFIX, 'return', '--path', claimedWorktree, '--json'],
        deps.repoDir
      );
      return { ok: false, reason: 'member-branch-push-failed' };
    }
    return { ok: true, branch, worktree: claimedWorktree, poolClaimed: true };
  }
  const poolNote = claimedWorktree ? 'pool-claim-invalid:' : '';

  const added =
    deps.exec(
      'git',
      ['worktree', 'add', '-b', branch, worktree, batch.branch as string],
      deps.repoDir
    ) !== null;
  if (!added) {
    // Self-heal the crash window a teardown died in (branch kept, tree
    // gone): `worktree add -b` fails while the stale branch exists. The
    // member branch is disposable by construction — a member whose branch
    // still matters is CURRENT, and a current member's tree is reused by
    // the exists-check above, never re-added. Force-delete the stale ref
    // and retry the add once.
    if (deps.exec('git', ['branch', '-D', branch], deps.repoDir) === null) {
      return { ok: false, reason: 'member-worktree-add-failed' };
    }
    if (
      deps.exec(
        'git',
        ['worktree', 'add', '-b', branch, worktree, batch.branch as string],
        deps.repoDir
      ) === null
    ) {
      return { ok: false, reason: 'member-worktree-add-failed' };
    }
  }
  const warmed = warmColdBatchWorktree(deps, batch, worktree, now, poolNote);
  if (!warmed.ok) {
    rollbackColdPrep();
    return { ok: false, reason: warmed.reason };
  }
  if (deps.exec('git', ['push', '-u', 'origin', '--', branch], worktree) === null) {
    rollbackColdPrep();
    return { ok: false, reason: 'member-branch-push-failed' };
  }
  return { ok: true, branch, worktree, poolClaimed: false };
}

/**
 * Land the CURRENT member's work on the integration branch (#677, §J.3: "a
 * member lands its commit onto the integration branch when its own
 * verification passes"): `git merge --ff-only <member_branch>` in the shared
 * batch worktree (which holds the integration branch), then push.
 *
 * Fast-forward is always available under the SERIAL dispatch model — only
 * the member moved its branch since it was cut, and nothing else moves the
 * integration branch mid-`executing` (fix agents only run from the
 * post-last-member aggregate validation). A failed merge therefore means the
 * serial invariant broke, not a conflict to resolve: the batch BLOCKS for an
 * operator instead of silently merging or reverting. Linear history is also
 * what `boundaryCommits`/`memberRanges` attribution expects — the member's
 * `(#<issue>)`-trailed subjects stay first-parent-readable after the landing.
 */
function landMemberBranch(
  deps: BatchDispatchDeps,
  batchId: string,
  now: Date
): { ok: true } | { ok: false; reason: string } {
  const state = deps.store.load();
  const batch = findBatch(state, batchId);
  if (!batch || batch.worktree === null || batch.branch === null || batch.member_branch === null) {
    return { ok: true };
  }
  const memberIssue = batch.members[batch.executing_member - 1];
  // #677 review (defense in depth, matching `branchMergedIntoBase`'s bar):
  // the persisted ref reaches git argv below — re-validate its shape.
  if (!SAFE_REF_RE.test(batch.member_branch) || !SAFE_REF_RE.test(batch.branch)) {
    journalEvent(deps, 'landing-failed', unit(batchId), {
      issue: memberIssue,
      reason: 'invalid-branch-name',
      detail: `persisted member/integration branch failed SAFE_REF_RE: ${batch.member_branch} → ${batch.branch}`,
    });
    return { ok: false, reason: 'invalid-branch-name' };
  }
  if (deps.exec('git', ['merge', '--ff-only', batch.member_branch], batch.worktree) === null) {
    journalEvent(deps, 'landing-failed', unit(batchId), {
      issue: memberIssue,
      reason: 'landing-merge-failed',
      detail: `git merge --ff-only ${batch.member_branch} into ${batch.branch} failed — serial-landing invariant broken; blocking for an operator`,
    });
    return { ok: false, reason: 'landing-merge-failed' };
  }
  if (deps.exec('git', ['push', 'origin', '--', batch.branch], batch.worktree) === null) {
    journalEvent(deps, 'landing-failed', unit(batchId), {
      issue: memberIssue,
      reason: 'landing-push-failed',
      detail: `landed ${batch.member_branch} on ${batch.branch} locally but the push failed — blocking so origin stays the durable copy`,
    });
    return { ok: false, reason: 'landing-push-failed' };
  }
  deps.journal.append(
    unitEvent('member-landed', unit(batchId), {
      issue: memberIssue,
      detail: `${batch.member_branch} fast-forwarded onto ${batch.branch}`,
    }),
    now
  );
  return { ok: true };
}

/**
 * Tear the CURRENT member's worktree down and clear the member fields
 * (#677): pool-claimed trees are RETURNED to the pool (a raw remove leaves a
 * dangling pool entry — the corrupted-entry state `worktree-pool status`
 * reports), cold trees are removed. The member branch is deleted locally —
 * `-d` after a landing (fully merged into the integration branch), `-D` on
 * the eviction path (its commits never landed; the requeue carries the work
 * forward). The REMOTE member branch is deleted only on the landed path, and
 * deliberately KEPT on eviction — the pushed sha is the evicted work's only
 * recoverable copy.
 *
 * Best-effort and idempotent: null fields are a no-op, and a failed cleanup
 * journals `teardown-failed` rather than throwing into the caller's
 * advance/dissolve path.
 */
function teardownMemberWorktree(
  deps: BatchDispatchDeps,
  batchId: string,
  now: Date,
  /** Whether the member's branch was ff-landed onto the integration branch. Passed explicitly by the callers that KNOW — deriving it from `batch.ranges` would silently force-delete a merged branch if a caller ever reached teardown after the member pointer advanced. */
  landed: boolean
): void {
  const state = deps.store.load();
  const batch = findBatch(state, batchId);
  if (!batch || batch.member_worktree === null) return;
  const worktree = batch.member_worktree;
  const branch = batch.member_branch;
  // #677 review (defense in depth, matching `branchMergedIntoBase`'s bar):
  // persisted state reaches git argv here — re-validate the ref shape before
  // interpolating it.
  if (branch !== null && !SAFE_REF_RE.test(branch)) {
    journalEvent(deps, 'teardown-failed', unit(batchId), {
      cleanup: 'failed-invalid-branch-name',
      detail: branch,
    });
    return;
  }
  // Route through `runTeardown` for the same guarantees `teardownBatch`
  // gets: pool returns are verify-first idempotent and refuse to claim
  // success unless the pool's own self-check reports the entry `warm`;
  // cold removes post-verify the path is gone and unlisted. Nulls first —
  // clear the fields BEFORE the exec so a crash mid-teardown doesn't retry
  // into a half-cleaned tree (the re-derived path is deterministic if a
  // leftover does survive).
  deps.store.withLock((s) => {
    const b = findBatch(s, batchId);
    if (!b) return { state: s, result: undefined };
    return {
      state: patchBatch(
        s,
        batchId,
        { member_branch: null, member_worktree: null, member_pool_claimed: false },
        now
      ),
      result: undefined,
    };
  });
  const t = runTeardown(
    deps.exec,
    deps.repoDir,
    { worktree, poolClaimed: batch.member_pool_claimed === true, branch },
    deps.fsExists
  );
  const treeCleared = !t.cleanup.startsWith('failed');
  let branchCleanup = 'skipped';
  if (branch !== null && treeCleared) {
    // `-d` refuses an unmerged branch; the eviction path forces it
    // deliberately (see doc). Run from repoDir — the worktree is gone.
    const flag = landed ? '-d' : '-D';
    branchCleanup =
      deps.exec('git', ['branch', flag, branch], deps.repoDir) === null
        ? `failed-branch-delete-${flag}`
        : `branch-deleted-${flag}`;
    if (landed) {
      deps.exec('git', ['push', 'origin', '--delete', branch], deps.repoDir);
    }
  }
  const failed = !treeCleared || branchCleanup.startsWith('failed');
  journalEvent(deps, failed ? 'teardown-failed' : 'member-worktree-torn-down', unit(batchId), {
    cleanup: t.cleanup,
    branch_cleanup: branchCleanup,
    detail: t.detail,
    worktree,
  });
}

/**
 * The shared "block the batch for an operator" tail (#677 review — the same
 * load → `recoveryDeps` → `blockBatch` → re-apply sequence
 * `runValidate`'s suite-unreadable path and `runIncrementalGate`'s
 * inconclusive path each grew): releases nothing itself — callers release
 * their own slot first — and always reports the unit under `failed`.
 */
function blockBatchForOperator(
  deps: BatchDispatchDeps,
  config: SchedConfig,
  batchId: string,
  opts: { reason: string; milestonePhase?: 'batch-validate' | 'batch-review' },
  now: Date,
  result: BatchTickResult
): void {
  const stateNow = deps.store.load();
  const fresh = findBatch(stateNow, batchId);
  if (!fresh) return;
  const blocked = blockBatch(stateNow, batchId, opts, recoveryDeps(deps, config, fresh, now));
  deps.store.withLock((s) => ({
    state: applyBatchAndIssues(s, blocked.state, batchId, []),
    result: undefined,
  }));
  result.failed.push(unit(batchId));
}

/**
 * Block the batch on a mechanical landing failure (#677): release the slot,
 * persist `blocked_reason`, and journal — the same operator-inspection path
 * `suite-unreadable` uses. The member's work is safe (its branch is pushed);
 * only the integration step failed.
 */
function blockLandingFailure(
  deps: BatchDispatchDeps,
  config: SchedConfig,
  batch: BatchEntry,
  reason: string,
  now: Date,
  result: BatchTickResult
): void {
  deps.store.withLock((s) => ({ state: releaseSlot(s, batch.id, now), result: undefined }));
  blockBatchForOperator(deps, config, batch.id, { reason }, now, result);
}

/**
 * Spawn one batch member's member-cycle agent (#677) into the slot a prior
 * member (or batch-setup) just released — each member in its OWN worktree
 * off the integration branch, dispatched serially as before. Prepared by
 * {@link prepareMemberWorktree} at the spawn site (outside the lock); this
 * function only patches state and spawns.
 */
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
  result: BatchTickResult,
  member: MemberWorktree
): SchedState {
  const batch = findBatch(state, batchId);
  if (!batch || batch.worktree === null || batch.branch === null) {
    // A leaked `assigned` slot with `pid: null` is invisible to `dead`
    // detection (nothing ever kills/reclaims it) — release it here rather
    // than leaving the batch permanently down one slot of capacity.
    journalEvent(deps, 'unit-failed', unit(batchId), {
      reason: 'no-worktree',
      detail: 'spawnMember: batch has no worktree/branch — batch-setup has not landed',
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
  const spawnSpec = resolveTierSpawn(dispatch, tier, memberIssue);
  const cmd = spawnSpec.cmd;
  // #677: the prompt carries THIS member's own worktree and the integration
  // branch it was cut from — `member-cycle`'s `worktree`/`integration_branch`
  // inputs. The shared batch worktree is no longer a member surface at all.
  const prompt = buildMemberPrompt(
    dispatch.memberPrompt,
    memberIssue,
    batchId,
    member.worktree,
    batch.branch
  );
  const logFile = batchMemberLogPath(
    deps.store.runsDir,
    batchId,
    batch.executing_member,
    memberIssue
  );
  // #629: captured BEFORE spawning, mirroring `engine.ts`'s own
  // `spawnAndRecord` — the log is per-role and append-mode, so the size at
  // this instant is exactly where THIS dispatch's own output starts. Fences
  // `handleDeadDispatchApiError`'s classification to this dispatch's slice.
  const logOffset = fileSizeOrZero(logFile);

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
    // #564: `engine.ts`'s own `spawnUnit` stamps this at spawn time
    // (line ~745) — `spawnMember` never did, so `recordMemberRunLog`'s
    // `slot.spawned_at === null` guard silently skipped every member.
    spawned_at: now.toISOString(),
    log_offset_at_spawn: logOffset,
  };
  let next =
    slot.status === 'assigned' || slot.status === 'recovering'
      ? transitionSlot(withStatus, slot.id, 'running', patch, now)
      : withStatus;
  // #677: persist the member's worktree context — a takeover redispatch or a
  // `sched resume --batch` recheck after an engine restart must land in the
  // SAME worktree/branch this prompt names, not re-derive (or worse,
  // re-create) it.
  next = patchBatch(
    next,
    batchId,
    {
      member_branch: member.branch,
      member_worktree: member.worktree,
      member_pool_claimed: member.poolClaimed,
    },
    now
  );
  deps.journal.append(
    unitEvent('spawned', unit(batchId), {
      pid,
      tier,
      slot: slot.id,
      issue: memberIssue,
      ...journalCmdModelFields(spawnSpec),
      log: logFile,
      worktree: member.worktree,
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
  // #565 AC2: "journaled on each assignment" — the issue-dispatch path
  // (`engine.ts`'s `dispatchAssignments`) already does this on its own
  // 'assigned' event; mirrored here so a batch's claim carries the same
  // audit trail.
  journalEvent(deps, 'assigned', unit(batchId), { slot: claimedSlot, priority: batch.priority });
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
    kv: {
      branch: setup.branch,
      worktree: setup.worktree,
      base_branch: batch.base_branch,
      pool_claimed: setup.poolClaimed ? 'true' : 'false',
    },
  });
  deps.journal.append(
    unitEvent('batch-setup-done', unit(batchId), { detail: setup.worktree }),
    now
  );

  // #677: prepare member 1's OWN worktree before claiming the spawn — real
  // git/network work, so OUTSIDE the store lock (the same contract
  // `runBatchSetup` just followed). All-or-nothing: a failed prep posts the
  // blocked milestone and releases the slot rather than spawning into a
  // worktree that does not exist (every member would fail Step 0).
  const firstIssue = batch.members[0];
  // Shared abort tail of every setup-stage failure (#677 review): post the
  // blocked milestone when a run id exists, journal, report, release.
  const abortSetup = (kvReason: string, detail: string): void => {
    if (batch.anchor !== null && setup.runId !== null) {
      poster(batch.anchor, setup.runId, {
        phase: 'batch-setup',
        status: 'blocked',
        kv: { reason: kvReason },
      });
    } else {
      journalEvent(deps, 'milestone-post-failed', unit(batchId), {
        detail: `batch-setup blocked (${kvReason}) — no run id to post to yet`,
      });
    }
    deps.journal.append(unitEvent('batch-setup-failed', unit(batchId), { detail }), now);
    result.failed.push(unit(batchId));
    deps.store.withLock((s) => ({ state: releaseSlot(s, batchId, now), result: undefined }));
  };
  if (firstIssue === undefined) {
    abortSetup('no-member', 'claimAndSetup: batch has no members');
    return;
  }
  const freshForPrep = findBatch(deps.store.load(), batchId);
  const memberPrep = prepareMemberWorktree(
    deps,
    // The setup patch (branch/worktree/run_id) lands under the lock BELOW —
    // prep needs the integration branch, so overlay `setup.branch` on the
    // fresh state rather than waiting for the patch.
    { ...(freshForPrep ?? batch), branch: setup.branch },
    1,
    firstIssue,
    now
  );
  if (!memberPrep.ok) {
    abortSetup(
      `member-worktree-prep-failed:${memberPrep.reason}`,
      `member worktree prep failed: ${memberPrep.reason} (member 1 #${firstIssue}, branch ${memberBranchFor(batchId, 1, firstIssue)})`
    );
    return;
  }

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
      {
        branch: setup.branch,
        worktree: setup.worktree,
        run_id: setup.runId,
        pool_claimed: setup.poolClaimed,
      },
      now
    );
    next = transitionBatch(next, batchId, 'executing', { executing_member: 1 }, now);
    const slot = slotFor(next, batchId);
    if (slot) next = spawnMember(deps, dispatch, next, slot, batchId, now, result, memberPrep);
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
  // #677: make sure the current member's worktree exists before claiming a
  // slot for the redispatch — git exec work, so OUTSIDE the store lock (the
  // contract `prepareMemberWorktree` documents). The wedge arm of
  // `runBatchTick` calls this EVERY tick while the batch is `executing`
  // with no slot, so the cheap gates run first:
  // - capacity: prep before the free-capacity check would do pool/git/npm
  //   work (and journal) per tick against a full scheduler — the #610/#630/
  //   #632 per-tick emission trap. `claimAndSpawn` re-checks under the lock;
  //   this pre-check only avoids wasted prep, it is not the gate.
  // - identity: persisted member fields are reused only when they belong to
  //   the CURRENT member (they can be stale after a failed teardown that
  //   kept them, or a crash between an eviction and its teardown) and the
  //   tree still EXISTS on disk (state-first, because a pool-claimed path
  //   is not re-derivable from batchId+index+issue).
  const state = deps.store.load();
  const batch = findBatch(state, batchId);
  if (!batch || batch.status !== 'executing' || batch.worktree === null) return;
  const memberIssue = batch.members[batch.executing_member - 1];
  if (memberIssue === undefined) return;
  if (freeCapacity(state, config) === 0) return;
  const expectedBranch = memberBranchFor(batchId, batch.executing_member, memberIssue);
  const fsExists = deps.fsExists ?? ((p: string) => fs.existsSync(p));
  const reusable =
    batch.member_worktree !== null &&
    batch.member_branch === expectedBranch &&
    fsExists(batch.member_worktree);
  let member: MemberWorktree;
  if (reusable) {
    member = {
      branch: batch.member_branch as string,
      worktree: batch.member_worktree as string,
      poolClaimed: batch.member_pool_claimed,
    };
  } else {
    if (batch.member_worktree !== null) {
      // Stale context for a DIFFERENT member (or a vanished tree): journal
      // it before overwriting — the disposition of that tree is the
      // operator's to inspect if it was real.
      journalEvent(deps, 'stale-member-worktree', unit(batchId), {
        issue: memberIssue,
        detail: `persisted ${batch.member_branch ?? '?'} @ ${batch.member_worktree} does not match expected ${expectedBranch} (or tree gone) — preparing fresh`,
      });
    }
    const prep = prepareMemberWorktree(deps, batch, batch.executing_member, memberIssue, now);
    if (!prep.ok) {
      journalEvent(deps, 'unit-failed', unit(batchId), {
        issue: memberIssue,
        reason: 'member-worktree-prep-failed',
        detail: `member worktree prep failed on continuation: ${prep.reason} (branch ${expectedBranch})`,
      });
      result.failed.push(unit(batchId));
      return;
    }
    member = prep;
  }
  claimAndSpawn(deps, config, batchId, 'member', now, (nextState, slot) =>
    spawnMember(deps, dispatch, nextState, slot, batchId, now, result, member)
  );
}

/**
 * Tail/report/fix dispatches (this function, `spawnReportAgent`,
 * `reconcileFixSlot`) are NOT recorded live to `runs.jsonl` — only member
 * dispatches got that treatment in #564 (`spawnMember`'s call into
 * `recordMemberRunLog`). `sched stats --batch <id>` (`batch-stats.ts`) is
 * the only way to see their cost today, reconstructed from the raw log
 * after the fact. Wiring in live recording for these later means repeating
 * `spawnMember`'s own #564 fix first: none of these three spawn functions'
 * patches stamp `SlotEntry.spawned_at` either, so a `recordXRunLog` guarded
 * on `spawned_at !== null` (mirroring `recordMemberRunLog`) would silently
 * no-op forever, exactly like the original bug.
 */
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
    const spawnSpec = resolveTierSpawn(dispatch, 'strong', batch.anchor);
    const cmd = spawnSpec.cmd;
    const prompt = buildBatchTailPrompt(
      dispatch.batchTailPrompt,
      batchId,
      batch.anchor,
      batch.members,
      batch.worktree
    );
    const logFile = batchTailLogPath(deps.store.runsDir, batchId);
    // #629: fences `handleDeadDispatchApiError`'s classification to this
    // dispatch's slice — see `spawnMember`'s identical comment.
    const logOffset = fileSizeOrZero(logFile);
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
      log_offset_at_spawn: logOffset,
    };
    const next =
      slot.status === 'assigned' ? transitionSlot(state, slot.id, 'running', patch, now) : state;
    deps.journal.append(
      unitEvent('spawned', unit(batchId), {
        pid,
        tier: 'strong',
        slot: slot.id,
        ...journalCmdModelFields(spawnSpec),
        log: logFile,
      }),
      now
    );
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
    const spawnSpec = resolveTierSpawn(dispatch, 'mechanical', batch.anchor);
    const cmd = spawnSpec.cmd;
    const prompt = buildBatchReportPrompt(
      dispatch.batchReportPrompt,
      batchId,
      batch.anchor,
      prNumber
    );
    const logFile = batchReportLogPath(deps.store.runsDir, batchId);
    // #629: fences `handleDeadDispatchApiError`'s classification to this
    // dispatch's slice — see `spawnMember`'s identical comment.
    const logOffset = fileSizeOrZero(logFile);
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
      log_offset_at_spawn: logOffset,
    };
    const next =
      slot.status === 'assigned'
        ? transitionSlot(state, slot.id, 'running', patchState, now)
        : state;
    journalEvent(deps, 'report-dispatched', unit(batchId), {
      pid,
      slot: slot.id,
      pr: prNumber,
      ...journalCmdModelFields(spawnSpec),
      log: logFile,
    });
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
 * Green proceeds to the tail; an unreadable report (never got a parseable
 * report at all, distinct from a parseable one naming zero failures) blocks
 * the batch instead of attributing (#562); a genuinely red, parseable report
 * attributes and either fixes one offender or dissolves when nothing could be
 * attributed (RFC F.2/F.8).
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
  const rDeps = recoveryDeps(deps, config, batch, now);
  const poster = createExecMilestonePoster(deps.exec, { repoDir: deps.repoDir });

  if (suite.ok) {
    if (batch.anchor !== null && batch.run_id !== null) {
      poster(batch.anchor, batch.run_id, { phase: 'batch-validate', status: 'done', kv: {} });
    }
    deps.journal.append(
      unitEvent('verify-complete', unit(batchId), { detail: suite.detail ?? 'suite green' }),
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

  // #562: the suite report itself was unreadable (empty, unparseable, a
  // spawn/timeout error) even after the runner's own fallback retry — NOT the
  // same as a parseable report naming zero failures. Attribution would read
  // `suite.failing` as "nothing to attribute" and dissolve a batch that may
  // be fully green; block instead, preserving every member commit and the
  // worktree, for an operator to inspect. `blocked` has no CLI resume verb
  // yet — `sched abandon --batch` is today's only real exit.
  if (suite.readable === false) {
    deps.journal.append(
      unitEvent('suite-failed', unit(batchId), {
        detail: suite.detail ?? 'suite report unreadable',
      }),
      now
    );
    const blocked = blockBatch(state, batchId, { reason: 'suite-unreadable' }, rDeps);
    deps.store.withLock((s) => ({
      state: applyBatchAndIssues(s, blocked.state, batchId, []),
      result: undefined,
    }));
    // `result.blocked` is "issue numbers requeued full-cycle by a dissolve"
    // (see `BatchTickResult`'s field doc) — a blocked batch requeues nothing,
    // so it is reported only under `failed`, not under `blocked`.
    result.failed.push(unit(batchId));
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
    // #707: `dispatch` is the batch's own (profile-resolved) dispatch — the
    // fix agent rides the same family the members ran on.
    { config, tests: outcome.attributed.get(offender) ?? [], dispatch }
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
    const logFile = batchFixLogPath(deps.store.runsDir, batchId, offender);
    // #629: fences `handleDeadDispatchApiError`'s classification to this
    // dispatch's slice — see `spawnMember`'s identical comment.
    const logOffset = fileSizeOrZero(logFile);
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
      log_offset_at_spawn: logOffset,
    };
    const next = slot.status === 'assigned' ? transitionSlot(s, slot.id, 'running', patch, now) : s;
    result.spawned.push(unit(batchId));
    return next;
  });
}

function evictOffender(
  deps: BatchDispatchDeps,
  config: SchedConfig,
  batchId: string,
  offender: number,
  attribution: AttributionMethod,
  now: Date,
  result: BatchTickResult
): void {
  const state = deps.store.load();
  const batch = findBatch(state, batchId);
  if (!batch) return;
  const rDeps = recoveryDeps(deps, config, batch, now);
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
/** The outcome of a one-shot claim on a member's resolution (#613). */
interface MemberClaim {
  claimed: boolean;
  observed: number | null;
  status: BatchStatus | null;
}

/**
 * The one-shot claim on resolving `currentMember` (#613). Transitions the batch only while
 * it is still `executing` on exactly that member; `false` means another call already
 * claimed it (a duplicate dispatch of the same eviction/completion, or a re-entrant tick)
 * and this caller must journal nothing and spawn nothing. Advancing anyway would validate a
 * batch that already validated, or skip past a member that has not run at all — which is
 * precisely how one member's eviction record ends up naming the member the batch already
 * advanced past while the next member gets no record.
 *
 * Written once and called from both arms so the two can never drift apart: they are the
 * same claim, differing only in what they transition to.
 */
function claimMemberResolution(
  deps: BatchDispatchDeps,
  batchId: string,
  currentMember: number,
  now: Date,
  next: (b: BatchEntry) => { to: BatchStatus; patch: Partial<BatchEntry> }
): MemberClaim {
  return deps.store.withLock<MemberClaim>((s) => {
    const b = findBatch(s, batchId);
    if (!b || b.status !== 'executing' || b.executing_member !== currentMember) {
      return {
        state: s,
        result: {
          claimed: false,
          observed: b?.executing_member ?? null,
          status: b?.status ?? null,
        },
      };
    }
    const { to, patch } = next(b);
    return {
      state: transitionBatch(s, batchId, to, patch, now),
      result: { claimed: true, observed: b.executing_member, status: b.status },
    };
  });
}

/** Journal a lost claim so a batch that stops advancing never does so silently (#613). */
function journalAdvanceSkipped(
  deps: BatchDispatchDeps,
  batchId: string,
  memberIssue: number,
  currentMember: number,
  claim: { observed: number | null; status: BatchStatus | null }
): void {
  journalEvent(deps, 'member-advance-skipped', unit(batchId), {
    issue: memberIssue,
    detail: `another resolution already advanced past member ${currentMember} (batch is now executing_member=${claim.observed ?? 'gone'}, status=${claim.status ?? 'gone'}) — no second member-advanced and no second continuation`,
  });
}

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
    const claim = claimMemberResolution(deps, batchId, currentMember, now, () => ({
      to: 'validating',
      patch: {},
    }));
    if (!claim.claimed) {
      journalAdvanceSkipped(deps, batchId, memberIssue, currentMember, claim);
      return;
    }
    runValidate(deps, config, dispatch, batchId, now, result);
    return;
  }
  const claim = claimMemberResolution(deps, batchId, currentMember, now, (b) => ({
    to: 'executing',
    patch: { executing_member: b.executing_member + 1 },
  }));
  if (!claim.claimed) {
    journalAdvanceSkipped(deps, batchId, memberIssue, currentMember, claim);
    return;
  }
  journalEvent(deps, 'member-advanced', unit(batchId), { issue: memberIssue });
  spawnMemberContinuation(deps, config, dispatch, batchId, now, result);
}

/**
 * Evict the current member and either dissolve, or continue the batch via
 * `advanceMemberOrValidate` — the shared tail of both member-failure rails
 * (self-reported blocked, and the incremental gate below).
 *
 * #613: `evictMemberDirectly`'s duplicate check (#595) is the one atomic,
 * lock-protected claim on "did THIS member's eviction already happen" — so
 * the `unit-failed` journal is emitted inside `evictMemberDirectly`, the
 * moment that claim succeeds and BEFORE the dissolve that claim may trigger,
 * rather than by each caller before it ever calls this function. A caller
 * that journaled `unit-failed` unconditionally, before the claim, could fire
 * it twice for one member (and once for the next member never at all) under
 * a duplicate/re-entrant resolve — the record and the journal must share the
 * same gate or they can disagree about which member the batch is advancing
 * past. Emitting it inside also keeps cause before effect in the journal and
 * survives a kill during the dissolve's shell-outs, which would otherwise
 * leave the eviction record on disk with no line saying why.
 *
 * Exported (not part of the package's `index.ts` public surface — imported
 * directly by `batch-integration.test.ts`) so #613's regression test can
 * call it twice with one stale `BatchEntry` snapshot: the exact "another
 * resolution already claimed this member" condition, which the public
 * `runBatchTick`/`resumeBlockedGate` entry points cannot reproduce since
 * both always read state fresh.
 */
export function evictMemberAndContinue(
  deps: BatchDispatchDeps,
  config: SchedConfig,
  dispatch: ResolvedDispatch,
  batchId: string,
  batch: BatchEntry,
  memberIssue: number,
  failure: MemberFailure,
  now: Date,
  result: BatchTickResult
): void {
  const { dissolved, duplicate } = evictMemberDirectly(
    deps,
    config,
    batchId,
    memberIssue,
    failure,
    now
  );
  if (duplicate) return;
  if (dissolved) {
    result.failed.push(unit(batchId));
    return;
  }
  // #677: the evicted member's commits never landed (eviction is the
  // pre-landing rail), so there is nothing to revert on the integration
  // branch — but its worktree/branch must go, or the next tick's prep for
  // the NEXT member collides with a stale tree. `teardownBatch` already
  // handled it on the dissolved path (the fields are cleared there).
  teardownMemberWorktree(deps, batchId, now, false);
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

/**
 * The incremental gate (#523 AC2, revised #583): typecheck + focused tests
 * via `cap run`, when the repo has a manifest for them — a second,
 * independent check that the member's own self-reported "done" is real,
 * matching this codebase's "never trust a claimed completion" ethos
 * (AC2/#464's `isVerifiedComplete`). Three-way policy: `task-failed` evicts
 * the member directly, same rail as a self-reported block (RFC F.1) — no
 * aggregate suite has run yet, so there is nothing to attribute.
 * `automation-broken`/`capability-unavailable` — the gate itself could not
 * reach a verdict — BLOCK the batch instead of silently proceeding (#583: a
 * script that legitimately could not run its suite must not be read as
 * either a pass or a real failure). Only both `ok` falls through.
 *
 * Two carve-outs from that block rail: an UNDECLARED id skips (#625 — not a
 * verdict, a repo that has not opted in), and a TIMEOUT-shaped
 * `automation-broken` skips too (#681 — the capability ran and needed more
 * time than it was given; recorded `capability-unavailable`, the parent's
 * expensive stage covers the member).
 *
 * A `task-failed` is itself split in two (#594): its `outputTail` must carry
 * recognizable evidence of a failing test (`hasFailingTestEvidence`) before
 * it is trusted as a red suite. A `task-failed` whose output proves nothing —
 * empty, or only a wrapper script's own framing — did not earn its exit
 * code, and joins the inconclusive case on the block-the-batch path instead
 * of evicting a member for a failure that never happened.
 *
 * Returns `true` when the gate already decided the member's fate (evicted or
 * blocked, both of which `return` from the caller); `false` when no hook is
 * configured or both checks came back `ok`, meaning the caller should treat
 * the member as genuinely complete.
 */
function runIncrementalGate(
  deps: BatchDispatchDeps,
  config: SchedConfig,
  dispatch: ResolvedDispatch,
  batchId: string,
  batch: BatchEntry,
  memberIssue: number,
  now: Date,
  result: BatchTickResult
): boolean {
  if (batch.worktree === null || !deps.runCapability) return false;
  // #677: the gate judges the member's OWN work — pre-landing, its diff
  // exists only in the member worktree/branch. The shared batch worktree is
  // the fallback for a batch dispatched before member worktrees existed (its
  // members' commits landed directly on the integration branch).
  const worktree = batch.member_worktree ?? batch.worktree;
  const runCapability = deps.runCapability;
  const gateResults = ['typecheck.run', 'test.focused'].map((id) => ({
    id,
    ...runCapability(worktree, id),
  }));
  const rawFailure = gateResults.find((r) => r.outcome === 'task-failed');
  // #625: `capability-unavailable` is NOT an inconclusive verdict — it means
  // the repo never declared this id, i.e. it has not opted into this half of
  // the gate. Blocking on it made batching opt-in per repo behind an
  // undocumented, source-only requirement: a repo declaring neither capability
  // blocked on member 1 with `gate-inconclusive:typecheck.run` and no way to
  // discover why. That is the opposite of the capability layer's contract —
  // declare more, spend fewer tokens; declare nothing, it still works.
  //
  // #583/#585's block-the-batch rail is for `automation-broken`: a DECLARED
  // capability whose machinery could not be trusted. That reasoning does not
  // extend to an id nobody wrote down.
  //
  // `warmColdBatchWorktree` in this same file already draws exactly this
  // distinction for `worktree.prepare`, and the member workflow (member-cycle,
  // #677) runs its own relevance-scoped tests rather than treating a broken
  // capability as fatal. This was the one place that treated it as fatal.
  //
  // Skipping costs EARLY detection, not correctness: the aggregate `test.full`
  // gate still runs before ship, CI still runs on the batch PR, and #562's
  // attribution still pins a red suite to the member that caused it.
  // #681: a timeout is a statement about DURATION, not about the harness's
  // reliability — the capability ran correctly and simply needed more time
  // than it was given (a member touching two workspace roots selects a
  // dependents closure that approaches the whole workspace). It therefore
  // joins #625's skip rail, not the block rail: the gate DECLINES the member
  // (recorded `capability-unavailable` — skip, parent covers it) instead of
  // blocking the batch on `automation-broken`.
  const timedOut = gateResults.filter(isGateTimeout);
  const gateInconclusive = gateResults.find(
    (r) => r.outcome === 'automation-broken' && !isGateTimeout(r)
  );
  const undeclared = gateResults.filter((r) => r.outcome === 'capability-unavailable');
  for (const skipped of undeclared) {
    // Journalled per member: a gate that silently does not run is its own
    // trap (#594's shape — absence reading as a verdict). Silence must never
    // be mistaken for a pass.
    //
    // #632: confirmed this fires once per member, not once per tick.
    // `runIncrementalGate` is called only from the `isMemberComplete` branch
    // of `reconcileMemberSlot`, and both of that branch's callees
    // (`completeMemberGate`, `evictMemberAndContinue`) advance
    // `batch.executing_member` before returning — so the very next tick
    // reads a DIFFERENT `memberIssue` from `batch.members[executing_member -
    // 1]`, and this gate never runs twice against the same member.
    journalEvent(deps, 'gate-skipped', unit(batchId), {
      issue: memberIssue,
      reason: `gate-skipped:${skipped.id}`,
      detail: `cap run ${skipped.id} is not declared by this repo — member judged on the checks that ARE available`,
    });
  }
  for (const declined of timedOut) {
    // Journalled per member with a DISTINCT reason slug (`gate-skipped-timeout`
    // vs #625's `gate-skipped`): an operator reading the journal must see
    // "the gate declined — needed more time" as different from "the gate was
    // never declared", and neither may read as a pass (#594's shape).
    // AC2/AC4: the capability's own output — which carries the resolved
    // package selection (e.g. the `pnpm --filter ...` line) — is what makes
    // the selection breadth visible; it goes to the per-gate log in full,
    // into the journal excerpt, and onto `member_gates.output_tail` with the
    // capability's `duration_ms`, the per-shape gate-cost recording.
    writeGateLog(deps, batchId, declined.id, memberIssue, declined.outputTail);
    journalEvent(deps, 'gate-skipped', unit(batchId), {
      issue: memberIssue,
      reason: `gate-skipped-timeout:${declined.id}`,
      detail: withExcerpt(
        `cap run ${declined.id} ${declined.reason ?? 'timed out'} after member review done — a statement about duration, not the harness's reliability; the parent's expensive stage (aggregate suite + CI) covers this member (#681)`,
        gateDetailExcerpt(declined.outputTail, declined.reason)
      ),
    });
    recordMemberGate(
      deps,
      batchId,
      memberIssue,
      {
        id: declined.id,
        // #681 AC3: record the DECLINE, not a machinery failure — the batch
        // outcome for an ungateable member is `capability-unavailable` (skip,
        // parent covers it), never `automation-broken` (block).
        outcome: 'capability-unavailable',
        outputTail: declined.outputTail,
        durationMs: declined.durationMs,
      },
      now
    );
  }
  const earnedFailure =
    rawFailure && hasEarnedFailureEvidence(rawFailure.id, rawFailure.outputTail)
      ? rawFailure
      : undefined;
  const unevidencedFailure = rawFailure && !earnedFailure ? rawFailure : undefined;
  // Record the gate the batch is actually routed on, not merely the worst
  // outcome: an unevidenced `task-failed` alongside a genuine
  // `automation-broken` blocks on the LATTER, and `member_gates` naming the
  // former would contradict `blocked_reason` in `sched status` — and would
  // name a different capability than `resumeBlockedGate` rechecks, since that
  // parses `blocked_reason`.
  const decisiveGate = earnedFailure ?? gateInconclusive ?? unevidencedFailure;
  if (decisiveGate) {
    recordMemberGate(deps, batchId, memberIssue, decisiveGate, now);
  }
  if (earnedFailure) {
    const reason = `incremental-gate-failed:${earnedFailure.id}`;
    writeGateLog(deps, batchId, earnedFailure.id, memberIssue, earnedFailure.outputTail);
    const excerpt = gateDetailExcerpt(earnedFailure.outputTail, earnedFailure.reason);
    deps.store.withLock((s) => ({ state: releaseSlot(s, batchId, now), result: undefined }));
    evictMemberAndContinue(
      deps,
      config,
      dispatch,
      batchId,
      batch,
      memberIssue,
      {
        reason,
        detail: withExcerpt(
          `cap run ${earnedFailure.id} reported task-failed with failing-test evidence after member review done`,
          excerpt
        ),
      },
      now,
      result
    );
    return true;
  }
  const inconclusive = gateInconclusive ?? unevidencedFailure;
  if (inconclusive) {
    const reason = `gate-inconclusive:${inconclusive.id}`;
    writeGateLog(deps, batchId, inconclusive.id, memberIssue, inconclusive.outputTail);
    const excerpt = gateDetailExcerpt(inconclusive.outputTail, inconclusive.reason);
    // #594 AC3: say WHICH of the two block-the-batch branches fired. Both land
    // on `gate-inconclusive:<cap>`, and a later run must not have to re-derive
    // "the capability was broken" from "the capability reported a failure it
    // could not evidence" — the operator's next action differs.
    journalEvent(deps, 'gate-inconclusive', unit(batchId), {
      issue: memberIssue,
      reason,
      detail: withExcerpt(
        `cap run ${inconclusive.id} ${describeInconclusive(inconclusive)} after member review done`,
        excerpt
      ),
    });
    deps.store.withLock((s) => ({ state: releaseSlot(s, batchId, now), result: undefined }));
    // #677: F.11's block semantics are "the member's commit stays on the
    // branch, nothing requeued/reverted" — under member worktrees that is
    // true only if the member LANDS before the batch blocks. The block means
    // the gate could not reach a verdict, not that the work is bad, so the
    // verified member joins the integration branch and is there for an
    // operator (or the #686 out-of-band reconcile) to act on. A landing
    // failure blocks the batch with its own reason — same operator outcome.
    const landed = landMemberBranch(deps, batchId, now);
    if (!landed.ok) {
      blockLandingFailure(deps, config, batch, landed.reason, now, result);
      return true;
    }
    blockBatchForOperator(
      deps,
      config,
      batchId,
      { reason, milestonePhase: 'batch-review' },
      now,
      result
    );
    return true;
  }
  return false;
}

/**
 * The member is verifiably done — self-reported complete AND (when checked)
 * the incremental gate agrees. Recompute the member's commit range, mark it
 * validated, and advance the batch. Shared by `reconcileMemberSlot`'s
 * immediate "both gate checks ok" fallthrough and `resumeBlockedGate` (#583)
 * — a member confirmed complete via a delayed `sched resume --batch` recheck
 * gets exactly the same treatment as one confirmed complete on the first try.
 * `releaseSlot` is idempotent (a no-op once the slot is already idle), so
 * this is safe to call whether or not the caller already released it.
 */
function completeMemberGate(
  deps: BatchDispatchDeps,
  config: SchedConfig,
  dispatch: ResolvedDispatch,
  batchId: string,
  batch: BatchEntry,
  memberIssue: number,
  now: Date,
  result: BatchTickResult
): void {
  // #677 (§J.3): land the member's verified work on the integration branch
  // BEFORE anything reads it — the range recompute below runs `git log` on
  // the batch branch, which only sees the member's commits once landed. The
  // exec calls run OUTSIDE the lock (same invariant as the range recompute's
  // own comment below).
  const landed = landMemberBranch(deps, batchId, now);
  if (!landed.ok) {
    blockLandingFailure(deps, config, batch, landed.reason, now, result);
    return;
  }
  // The commit-range recompute (`git log`) is a blocking subprocess call — it
  // must run OUTSIDE the lock, like every other exec in this module; the
  // result then lands as a pure data patch under the lock (Convention review:
  // `recordRanges` used to run `git log` INSIDE the withLock mutator, which
  // is exactly what `engine.ts`'s own "a slow git call never holds the lock"
  // invariant exists to prevent).
  const ranges = memberRanges(boundaryCommits(deps, batch));
  deps.store.withLock((s) => {
    // #629: a verified member completion is proof dispatch is healthy —
    // reset the confirmed-failure streak, mirroring the per-issue path's
    // `resetDispatchApiErrorStreak` on its own verified-complete branch, or a
    // healthy member sandwiched between two unrelated api-error hits (this
    // one and a later one on the tail/report agent) would be invisible to
    // the streak and could still tip it into a false-positive pause.
    let n = resetDispatchApiErrorStreak(releaseSlot(s, batchId, now));
    n = patchBatch(n, batchId, { ranges }, now);
    n = advanceMemberToValidated(n, memberIssue, now);
    return { state: n, result: undefined };
  });
  result.completed.push(unit(batchId));
  // #677: the member's tree is done serving — landed, ranges recomputed.
  // Teardown before the advance so the next member's prep cannot collide
  // with this tree's cleanup.
  teardownMemberWorktree(deps, batchId, now, true);
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

/**
 * `sched resume --batch <id>` (#583 AC4): an operator-triggered, synchronous
 * one-shot recheck of a batch blocked on `gate-inconclusive:<capabilityId>`
 * — re-runs exactly that capability against the current member and resolves
 * the block:
 *
 * - still `automation-broken`/`capability-unavailable` → stays `blocked`,
 *   no state change (the capability still isn't fixed).
 * - a TIMEOUT-shaped `automation-broken` (#681) → the block dissolves: the
 *   gate declines the member (`capability-unavailable`, skip — the parent's
 *   expensive stage covers it) and the member completes via the same rail an
 *   `ok` recheck uses. Returns `outcome: 'skipped'`.
 * - `task-failed` with recognizable failing-test evidence (#594,
 *   `hasFailingTestEvidence`) → the member really is broken; evict via the
 *   same rail the live gate uses. `task-failed` with no evidence stays
 *   `blocked`, same as the still-inconclusive case above.
 * - `ok` → the member really was fine; complete it via the same rail the
 *   live gate uses.
 *
 * Deliberately NOT a generic engine tick: `runBatchTick`'s own "executing
 * with no live slot" wedge-recovery path (`spawnMemberContinuation`,
 * unconditional) exists for a dispatch that never happened — reusing it here
 * would redispatch a fresh agent for a member whose work is already
 * committed and reviewed. This function transitions `blocked → executing`
 * and immediately, synchronously, calls the same completion/eviction
 * functions the live gate calls — no intervening tick ever sees the batch
 * `executing` with nothing in flight.
 */
export function resumeBlockedGate(
  deps: BatchDispatchDeps,
  config: SchedConfig,
  dispatch: ResolvedDispatch,
  batchId: string,
  now: Date
): {
  outcome: 'still-blocked' | 'evicted' | 'completed' | 'skipped';
  capability: string;
  /**
   * Why the batch is still blocked, when it is. Both branches land on
   * `gate-inconclusive:<cap>`, but the operator's next action differs — fix
   * the capability's availability, or fix the wrapper that reports a failure
   * it cannot evidence — so the caller must not have to guess from the detail.
   */
  blockedBy?: 'inconclusive' | 'unevidenced-failure';
  detail?: string;
} {
  const state = deps.store.load();
  const batch = findBatch(state, batchId);
  if (!batch) throw new SchedNotFoundError(`Batch not found: ${batchId}`);
  // A gate recheck can immediately advance to the next provider dispatch, so
  // it must use the batch's recorded profile rather than the engine default.
  const batchDispatch =
    batch.dispatch_profile === null
      ? dispatch
      : resolveProfiledDispatch(config, batch.dispatch_profile);
  if (batch.status !== 'blocked' || !batch.blocked_reason?.startsWith('gate-inconclusive:')) {
    // #677 review: the landing-failure blocks have no resume verb (same as
    // `suite-unreadable`) — name the actual reason and the operator path
    // instead of a bare illegal-transition error that reads like a bug.
    if (batch.status === 'blocked') {
      throw new SchedNotFoundError(
        `Batch ${batchId} is blocked on '${batch.blocked_reason ?? '?'}', which has no gate recheck: inspect the batch worktree/state named in its journal, then \`sched abandon --batch ${batchId}\` if it is a dead end`
      );
    }
    throw new IllegalTransitionError('batch', batch.status, 'executing');
  }
  const capabilityId = batch.blocked_reason.slice('gate-inconclusive:'.length);
  const memberIssue = batch.members[batch.executing_member - 1];
  if (batch.worktree === null || !deps.runCapability || memberIssue === undefined) {
    throw new SchedNotFoundError(
      `Batch ${batchId} has no worktree/current member/gate hook to recheck`
    );
  }
  const recheck = deps.runCapability(
    // #677: recheck the member's OWN tree — pre-landing, the member's diff
    // exists only in its worktree; a batch-worktree recheck would test a
    // tree missing the change and trivially pass it. The fallback preserves
    // the pre-#677 behavior for a batch blocked before member worktrees
    // existed (its member's commits were already on the integration branch).
    batch.member_worktree ?? batch.worktree,
    capabilityId
  );
  const result = emptyResult();
  const excerpt = gateDetailExcerpt(recheck.outputTail, recheck.reason);

  // #681: a recheck can classify what the batch blocked on as a TIMEOUT —
  // the capability ran correctly and needed more time than it was given,
  // which is a statement about duration, not about the harness's
  // reliability. That is not a verdict the batch may stay blocked on:
  // unblock and complete the member via the same rail an `ok` recheck uses,
  // recording the decline (`capability-unavailable` — skip, the parent's
  // expensive stage covers it) so the batch outcome never reads as a
  // machinery failure that never existed.
  if (isGateTimeout(recheck)) {
    writeGateLog(deps, batchId, capabilityId, memberIssue, recheck.outputTail);
    journalEvent(deps, 'gate-skipped', unit(batchId), {
      issue: memberIssue,
      reason: `gate-skipped-timeout:${capabilityId}`,
      detail: withExcerpt(
        `sched resume --batch: cap run ${capabilityId} ${recheck.reason ?? 'timed out'} on recheck — gate declines, member stands; the parent's expensive stage (aggregate suite + CI) covers it (#681)`,
        excerpt
      ),
    });
    deps.store.withLock((s) => ({
      state: patchBatch(
        transitionBatch(s, batchId, 'executing', {}, now),
        batchId,
        { blocked_reason: null },
        now
      ),
      result: undefined,
    }));
    recordMemberGate(
      deps,
      batchId,
      memberIssue,
      {
        id: capabilityId,
        outcome: 'capability-unavailable',
        outputTail: recheck.outputTail,
        durationMs: recheck.durationMs,
      },
      now
    );
    completeMemberGate(deps, config, batchDispatch, batchId, batch, memberIssue, now, result);
    return { outcome: 'skipped', capability: capabilityId, detail: excerpt };
  }

  recordMemberGate(deps, batchId, memberIssue, { id: capabilityId, ...recheck }, now);

  if (recheck.outcome === 'automation-broken' || recheck.outcome === 'capability-unavailable') {
    // Still inconclusive: leave an audit trail (log + journal) exactly like
    // the live gate does, even though the batch stays `blocked` — otherwise
    // a repeated `sched resume --batch` leaves no record of when it was last
    // checked or what it said (#583 review).
    writeGateLog(deps, batchId, capabilityId, memberIssue, recheck.outputTail);
    journalEvent(deps, 'gate-inconclusive', unit(batchId), {
      issue: memberIssue,
      reason: `gate-inconclusive:${capabilityId}`,
      detail: withExcerpt(
        `sched resume --batch: cap run ${capabilityId} still reports ${recheck.outcome} on recheck`,
        excerpt
      ),
    });
    return {
      outcome: 'still-blocked',
      capability: capabilityId,
      blockedBy: 'inconclusive',
      detail: excerpt,
    };
  }

  // A recheck can still come back `task-failed` with no evidence behind it
  // (#594) — the same routing the live gate applies, so a resumed batch
  // never evicts a member for a failure `hasFailingTestEvidence` cannot
  // confirm.
  if (
    recheck.outcome === 'task-failed' &&
    !hasEarnedFailureEvidence(capabilityId, recheck.outputTail)
  ) {
    writeGateLog(deps, batchId, capabilityId, memberIssue, recheck.outputTail);
    journalEvent(deps, 'gate-inconclusive', unit(batchId), {
      issue: memberIssue,
      reason: `gate-inconclusive:${capabilityId}`,
      detail: withExcerpt(
        `sched resume --batch: cap run ${capabilityId} still reports task-failed with no failing-test evidence on recheck`,
        excerpt
      ),
    });
    return {
      outcome: 'still-blocked',
      capability: capabilityId,
      blockedBy: 'unevidenced-failure',
      detail: excerpt,
    };
  }

  deps.store.withLock((s) => ({
    state: patchBatch(
      transitionBatch(s, batchId, 'executing', {}, now),
      batchId,
      { blocked_reason: null },
      now
    ),
    result: undefined,
  }));

  if (recheck.outcome === 'task-failed') {
    const reason = `incremental-gate-failed:${capabilityId}`;
    writeGateLog(deps, batchId, capabilityId, memberIssue, recheck.outputTail);
    evictMemberAndContinue(
      deps,
      config,
      batchDispatch,
      batchId,
      batch,
      memberIssue,
      {
        reason,
        detail: withExcerpt(
          `sched resume --batch: cap run ${capabilityId} reported task-failed on recheck`,
          excerpt
        ),
      },
      now,
      result
    );
    return { outcome: 'evicted', capability: capabilityId, detail: excerpt };
  }

  journalEvent(deps, 'external-advance', unit(batchId), {
    issue: memberIssue,
    detail: `sched resume --batch: cap run ${capabilityId} reported ok on recheck`,
  });
  completeMemberGate(deps, config, batchDispatch, batchId, batch, memberIssue, now, result);
  return { outcome: 'completed', capability: capabilityId };
}

/**
 * Record one member dispatch's tokens/cost to `runs.jsonl` (#564) — the
 * `batch-dispatch.ts` analogue of `engine.ts`'s `recordDispatchRunLog`.
 * Batch members never go through `engine.ts`'s per-unit spawn/record path
 * (`spawnMember` calls `deps.spawnDeps.spawn()` directly), so #524's capture
 * never covered them; this closes that gap using the exact same
 * `buildSchedRunLogEntry`/`appendSchedRunLog` machinery, attributed to
 * `issue:<memberIssue>` — the SAME unit scheme ordinary issue dispatches use,
 * so a member's cost shows up in the default `sched stats` view with no new
 * unit format for the read side to special-case.
 *
 * Exactly-once per dispatch, mirroring `recordDispatchRunLog`'s own
 * invariant: called from both of `reconcileMemberSlot`'s exit branches
 * (member complete, member blocked/dead) — a batch never redispatches the
 * same member slot (eviction requeues it as an independent full-cycle run
 * instead), so unlike `engine.ts`'s per-unit log, a member's log file is
 * always one-shot and reading from offset 0 is always correct.
 */
function recordMemberRunLog(
  deps: BatchDispatchDeps,
  dispatch: ResolvedDispatch,
  state: SchedState,
  batchId: string,
  batch: BatchEntry,
  memberIssue: number,
  slot: SlotEntry,
  now: Date
): string | null {
  if (slot.status !== 'running' || slot.spawned_at === null) {
    journalEvent(deps, 'run-log-skipped', unit(batchId), {
      issue: memberIssue,
      reason: slot.spawned_at === null ? 'never-spawned' : `already-recorded-${slot.status}`,
      slot: slot.id,
    });
    return null;
  }

  const tier: ModelTier = findEntry(state, memberIssue)?.tier ?? 'mid';
  const { cmd, model } = resolveTierSpawn(dispatch, tier, memberIssue);
  const logFile = batchMemberLogPath(
    deps.store.runsDir,
    batchId,
    batch.executing_member,
    memberIssue
  );
  // #629: fenced to THIS dispatch's slice (`log_offset_at_spawn`, stamped by
  // `spawnMember`/`spawnMemberContinuation` at spawn time) rather than a
  // fixed byte-0 read. Before #629 a member log never outlived one attempt
  // (eviction was the only exit besides completion), so byte-0 was safe; a
  // confirmed-API-error hold now retries the SAME member in place, appending
  // a SECOND attempt to the same file — an unfenced read would double-count
  // the first attempt's tokens into the second's `runs.jsonl` entry, exactly
  // the #524 divergence this telemetry system exists to prevent.
  const logContent = readDispatchLog(logFile, slot.log_offset_at_spawn ?? 0);

  const runEntry = buildSchedRunLogEntry({
    unit: `issue:${memberIssue}`,
    role: 'batch-member',
    cmd0: cmd[0],
    cmd,
    logContent,
    spawnedAt: slot.spawned_at,
    completedAt: now,
    configuredModel: model,
    cwd: deps.repoDir,
    tier,
  });

  finalizeRunLogEntry(
    runEntry,
    logContent,
    deps.homeDir,
    (event, extra) => journalEvent(deps, event, unit(batchId), extra),
    { issue: memberIssue, log: logFile }
  );

  // #591: the last tool this member dispatch called — attributes an
  // `agent-exited-unverified` failure to a concrete cause without opening the transcript.
  return parseLastToolUse(logContent);
}

/**
 * #622: the milestone a member dispatch's fate is read from.
 *
 * Returns the LAST milestone this dispatch posted that is terminal for a
 * member — complete (`review/done mode=slot`) or blocked (`blocked
 * mode=slot`) — falling back to the newest milestone when the dispatch
 * produced no terminal one, and to `latestMilestone` entirely when the
 * ground truth cannot enumerate a window.
 *
 * "Last terminal" rather than "last": a member may post a non-terminal
 * catch-up milestone after finishing (the observed case: `review done` then
 * `implement done` fifteen seconds later), and a reader that takes the
 * newest concludes the unit never finished. It is also "last" rather than
 * "first" so a member that posts `blocked` and then genuinely completes, or
 * vice versa, is judged on its final word.
 *
 * The tri-state contract is preserved exactly: `undefined` still means the
 * poll failed and the caller must pause.
 */
function terminalMilestoneForDispatch(
  deps: BatchDispatchDeps,
  memberIssue: number,
  slot: SlotEntry
): GroundTruthMilestone | null | undefined {
  const latest = deps.groundTruth.latestMilestone(memberIssue);
  if (latest === undefined) return undefined; // unreachable — pause
  const since = slot.spawned_at;
  if (since === null || deps.groundTruth.milestonesSince === undefined) return latest;

  const window = deps.groundTruth.milestonesSince(memberIssue, since);
  // A failed enumeration is NOT fatal here — the caller already has a usable
  // answer from `latestMilestone`. Degrade to it rather than pausing the
  // batch on a secondary read.
  if (window === undefined) return latest;

  for (let i = window.length - 1; i >= 0; i--) {
    const m = window[i];
    if (m === undefined) continue;
    if (isMemberComplete(m, since) || isMemberBlocked(m, since)) return m;
  }
  return latest;
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
  // #622: the milestone this DISPATCH's fate should be read from — the last
  // TERMINAL one it posted, not merely the newest one on the issue.
  //
  // `latestMilestone` alone gets this wrong in a way that evicts finished
  // work: a member posted `review done` at 12:52:37 and a catch-up
  // `implement done` at 12:52:52, and the engine — seeing only the newest —
  // concluded the unit never finished and evicted it, despite a pushed
  // commit and 7/7 conformance. `review done` satisfied every condition
  // `isMemberComplete` checks except being last.
  //
  // Searching the dispatch's own milestones does NOT weaken #575/#605's
  // fence: the window starts at `spawned_at`, so a previous run's terminal
  // milestone is excluded by construction rather than by predicate. When the
  // ground truth cannot answer (older implementation, or an unreachable
  // poll) this degrades to the previous latest-only behaviour.
  const milestone = terminalMilestoneForDispatch(deps, memberIssue, slot);
  if (milestone === undefined) return; // unreachable — pause this batch's decisions

  // #575 / #605: fence to THIS member dispatch's `spawned_at` — a member
  // re-added to a fresh batch run after a PREVIOUS batch already posted a
  // terminal `mode=slot` milestone (pilot re-run, requeue-with-context, and
  // above all RFC-0001 F.8's requeue of every member of a dissolved batch)
  // must not read as instantly finished against that stale milestone. Mirrors
  // the per-issue fence in `engine.ts`'s `reconcileRunning`/
  // `completeUnitOrRecover` — same bug class, same fix, different predicates
  // (`isMemberComplete`/`isMemberBlocked` vs `isVerifiedComplete`).
  //
  // BOTH terminal predicates are fenced, and it took losing a batch to learn
  // why: #575 fenced only `isMemberComplete`, so a stale `blocked mode=slot`
  // still evicted a healthy member mid-run and the journal reported the OLD
  // run's `reason=`, naming a precondition that had already been fixed.
  const staleTerminal =
    milestone !== null &&
    ((isMemberComplete(milestone) && !isMemberComplete(milestone, slot.spawned_at)) ||
      (isMemberBlocked(milestone) && !isMemberBlocked(milestone, slot.spawned_at)));
  // #610: this dispatch's own spawned_at IS the fence value the two
  // predicates above already key on — reusing it here as the "already
  // journalled" marker means a fresh dispatch (new spawned_at) invalidates
  // the marker for free, with no reset needed at any spawn site. Without the
  // gate this re-fired every tick for as long as the stale milestone stayed
  // latest — once every reconcile interval for the member's whole run.
  if (staleTerminal && slot.stale_milestone_ignored_for !== slot.spawned_at) {
    journalEvent(deps, 'stale-milestone-ignored', unit(batchId), {
      issue: memberIssue,
      slot: slot.id,
      run: milestone.run,
      // The engine's OWN decision time — `milestone.at` is kept separately so
      // an operator can still see how old the stale milestone actually is.
      at: now.toISOString(),
      milestone_at: milestone.at,
      detail: `${milestone.status === 'blocked' ? 'blocked' : 'complete'} milestone predates dispatch spawned_at=${slot.spawned_at}`,
    });
    deps.store.withLock((s) => ({
      state: patchSlot(s, slot.id, { stale_milestone_ignored_for: slot.spawned_at }, now),
      result: undefined,
    }));
  }

  if (isMemberComplete(milestone, slot.spawned_at)) {
    deps.journal.append(
      unitEvent('external-advance', unit(batchId), {
        issue: memberIssue,
        detail: 'member review done',
      }),
      now
    );
    // The member's own agent process is done regardless of what the
    // incremental gate below decides — record its telemetry once here (#564)
    // rather than at each of this branch's two later exit points.
    recordMemberRunLog(deps, dispatch, state0, batchId, batch, memberIssue, slot, now);

    // Incremental gate (#523 AC2, revised #583) — see `runIncrementalGate`'s
    // own doc comment for the three-way policy. A `true` return means the
    // gate already decided the member's fate (evicted or blocked) and
    // returned early; `false` means both checks were `ok` and the member is
    // genuinely done.
    if (runIncrementalGate(deps, config, dispatch, batchId, batch, memberIssue, now, result)) {
      return;
    }

    completeMemberGate(deps, config, dispatch, batchId, batch, memberIssue, now, result);
    return;
  }

  const blockedNow = isMemberBlocked(milestone, slot.spawned_at);
  if (
    dead &&
    !blockedNow &&
    handleDeadDispatchApiError(
      deps,
      batchId,
      batchMemberLogPath(deps.store.runsDir, batchId, batch.executing_member, memberIssue),
      slot.log_offset_at_spawn ?? 0,
      now
    )
  ) {
    // #629: a confirmed provider API error is not a real member failure —
    // evicting the member for an account-wide spend wall would silently
    // throw away real, correct work. `runBatchTick`'s "same wedge" retry
    // (`spawnMemberContinuation`, now pause-gated) retries the SAME member in
    // place, keeping its position.
    return;
  }
  if (blockedNow || dead) {
    // #605: only a milestone THIS dispatch posted may name the reason. A dead
    // agent whose issue carries only a stale `blocked` milestone is an
    // unverified exit, not a re-run of the previous run's block — reporting
    // the old `reason=` here is what made the journal misdirect, naming a
    // precondition that had already been fixed on a run where it no longer
    // applied.
    const rawReason = blockedNow ? milestone?.keys.reason : undefined;
    const reason =
      typeof rawReason === 'string' && rawReason.length > 0
        ? sanitizeUntrustedText(rawReason)
        : dead
          ? 'agent-exited-unverified'
          : 'member-blocked';
    const lastTool = recordMemberRunLog(
      deps,
      dispatch,
      state0,
      batchId,
      batch,
      memberIssue,
      slot,
      now
    );
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
      {
        reason,
        // This rail covers a self-reported block AND a member that simply died, so the
        // detail must follow the RESOLVED reason — `member blocked` on an
        // `agent-exited-unverified` eviction contradicts the reason on its own journal line.
        detail:
          reason === 'agent-exited-unverified'
            ? 'member agent exited without posting a terminal milestone'
            : 'member blocked',
        // #591: attributes an unverified member exit to a concrete cause (e.g.
        // `Monitor`) without opening the transcript. Gated on the RESOLVED reason, not
        // `dead` — a member can be simultaneously `dead` AND carry a milestone-posted
        // `reason` (it posted `blocked` and then exited), and that real block has no
        // log-derived cause to attribute; only `agent-exited-unverified` does.
        extraKv:
          reason === 'agent-exited-unverified' && lastTool !== null
            ? { last_tool: lastTool }
            : undefined,
      },
      now,
      result
    );
  }
}

/**
 * Requeue a member full-cycle, record the eviction, and dissolve if this tips
 * the batch past its `dissolve_policy` threshold (#563; RFC F.1/F.8) — WITHOUT
 * going through `recovery.ts`'s `evictMembers` (which needs
 * `attributing`/`evicting` status and a commit range to revert; a member
 * evicted here has neither). Returns whether the batch dissolved.
 *
 * A member already in `evictions[]` is a NO-OP here, not merely a skipped
 * record (#595 AC1): the requeue must not run a second time either. It would
 * overwrite the first eviction's `failure_evidence` — leaving `evictions[]`
 * and the queue entry disagreeing about why the member was evicted — and, if
 * the member has since been re-dispatched full-cycle, would take the
 * `executing → evicted → requeued` rail and kill that live run.
 *
 * Returns `{ dissolved, duplicate }`: `dissolved` is whether this eviction tipped the batch
 * past its threshold and the batch is gone; `duplicate: true` means another resolution had
 * already claimed this member's eviction, and the caller must journal nothing and advance
 * nothing on top of it (#613 — that is exactly how a record ends up naming the member the
 * batch already advanced past).
 */
function evictMemberDirectly(
  deps: BatchDispatchDeps,
  config: SchedConfig,
  batchId: string,
  memberIssue: number,
  failure: MemberFailure,
  now: Date
): { dissolved: boolean; duplicate: boolean } {
  const { reason } = failure;
  const dissolvePolicy = resolveDissolvePolicy(config.dissolve_policy);
  // Pass 1 (pure — requeue + record the eviction): safe to run entirely
  // inside the lock, unlike `dissolveBatch` below, which shells out
  // (`deps.exec`/`postMilestone`) and so must NOT hold the lock while it runs.
  const { triggered, duplicate, prior } = deps.store.withLock<{
    triggered: boolean;
    duplicate: boolean;
    prior: EvictionRecord | undefined;
  }>((s) => {
    const b = findBatch(s, batchId);
    if (!b) {
      return { state: s, result: { triggered: false, duplicate: false, prior: undefined } };
    }
    const priorRecord = b.evictions.find((e) => e.issue === memberIssue);
    if (priorRecord) {
      // A duplicate never re-evaluates the dissolve threshold: the resolution that WROTE
      // this record already did, under this same lock. (#595: a duplicate must not count
      // twice; #613: it must not act on the batch at all.) Note this also means a dissolve
      // interrupted between pass 1 and pass 2 is not retried here — re-entering
      // `dissolveBatch` on an already-terminal batch throws `IllegalTransitionError`.
      return {
        state: s,
        result: { triggered: false, duplicate: true, prior: priorRecord },
      };
    }
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
    // `appendEvictions` stays the state-level backstop even though the
    // duplicate is already short-circuited above — it is the one append path.
    const { evictions, duplicate: duplicateRecords } = appendEvictions(b, [
      {
        issue: memberIssue,
        reason,
        attribution: 'none',
        reverted_commits: [],
        group: [],
        at: now.toISOString(),
      },
    ]);
    next = patchBatch(next, batchId, { evictions }, now);
    const updated = findBatch(next, batchId);
    return {
      state: next,
      result: {
        triggered: updated !== undefined && checkDissolveTrigger(updated, dissolvePolicy),
        duplicate: duplicateRecords.length > 0,
        prior: undefined,
      },
    };
  });
  if (duplicate) {
    journalEvent(deps, 'eviction-duplicate', unit(batchId), {
      issue: memberIssue,
      detail: duplicateEvictionDetail(memberIssue, reason, prior),
    });
    // Another resolution already claimed this member's eviction record — the
    // caller must not journal its own `unit-failed`/advance the batch again
    // on top of that one (#613: that is exactly how a record ends up naming
    // the member the batch already advanced past).
    return { dissolved: false, duplicate: true };
  }
  // This call owns the member's resolution, so it owns recording WHY — before pass 2 below
  // can dissolve, tear the worktree down, or be killed mid-shell-out and leave the eviction
  // record on disk with no journal line naming its cause (#613). The caller's extras go
  // first so the authoritative keys always win: `extraKv` is a wide Record, and a future
  // caller passing `reason`/`detail`/`issue` must not be able to rewrite the record's own
  // identity.
  journalEvent(deps, 'unit-failed', unit(batchId), {
    ...(failure.extraKv ?? {}),
    issue: memberIssue,
    reason,
    detail: failure.detail,
  });
  if (!triggered) return { dissolved: false, duplicate: false };

  // Pass 2 (outside the lock — dissolveBatch shells out): re-load fresh
  // (pass 1's write already landed), dissolve, then re-apply just this
  // batch's + the requeued members' state under a fresh lock.
  const state = deps.store.load();
  const batch = findBatch(state, batchId);
  if (!batch) return { dissolved: false, duplicate: false };
  const rDeps = recoveryDeps(deps, config, batch, now);
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
  return { dissolved: true, duplicate: false };
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

  // #629: a confirmed provider API error means the fix agent never got a
  // real chance to fix anything — record it against the shared pause (AC1/
  // AC2/AC3) so an operator reads "spend limit", not a fix that failed on
  // its merits. `release: false`: this function releases the slot itself a
  // few lines below, after also deciding whether to resolve the fix attempt
  // — one release, not two. The one-shot fix-attempt model has no existing
  // "retry the same attempt" primitive (unlike tail/member/report, which the
  // tick loop itself retries), so the suite still runs and resolves the
  // attempt below exactly as today: the member's one fix attempt is consumed
  // and resolves per the suite's real result. An operator who wants it back
  // must re-trigger the fix after `sched resume` — see
  // packages/sched/README.md's dispatch-health section.
  handleDeadDispatchApiError(
    deps,
    batchId,
    batchFixLogPath(deps.store.runsDir, batchId, offenderRecord.issue),
    slot.log_offset_at_spawn ?? 0,
    now,
    { release: false }
  );

  deps.store.withLock((s) => ({ state: releaseSlot(s, batchId, now), result: undefined }));

  const suite = safeSuite(deps, batchId, batch.worktree);
  const rDeps = recoveryDeps(deps, config, batch, now);
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

  if (
    batch.status === 'reviewing' &&
    isBatchPhaseDone(milestone, 'batch-review', slot.spawned_at)
  ) {
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
      // #629: a verified park is proof dispatch is healthy — reset the
      // confirmed-failure streak, mirroring the per-issue path's own parked
      // branch.
      let n = resetDispatchApiErrorStreak(releaseSlot(s, batchId, now));
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
    // #629: a confirmed provider API error is not a real tail-agent failure —
    // record it against the shared pause and let `runBatchTick`'s "same
    // wedge" retry (`spawnTailAgent`, now pause-gated) respawn it, instead of
    // journaling a failure that will never stop respawning on its own.
    if (
      handleDeadDispatchApiError(
        deps,
        batchId,
        batchTailLogPath(deps.store.runsDir, batchId),
        slot.log_offset_at_spawn ?? 0,
        now
      )
    ) {
      return;
    }
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

  if (isBatchPhaseDone(milestone, 'batch-report', slot.spawned_at)) {
    deps.journal.append(
      unitEvent('external-advance', unit(batchId), { detail: 'batch report done' }),
      now
    );
    deps.store.withLock((s) => {
      // #629: a verified report completion is proof dispatch is healthy —
      // reset the confirmed-failure streak, mirroring the per-issue path's
      // own verified-complete branch.
      let n = resetDispatchApiErrorStreak(releaseSlot(s, batchId, now));
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
    // #629: same reasoning as `reconcileTailSlot` — a confirmed API error is
    // not a real report-agent failure; record it and let the `deployed`
    // branch's `spawnReportAgent` retry (now pause-gated) instead of
    // journaling `report-failed` for a wall that will keep respawning anyway.
    if (
      handleDeadDispatchApiError(
        deps,
        batchId,
        batchReportLogPath(deps.store.runsDir, batchId),
        slot.log_offset_at_spawn ?? 0,
        now
      )
    ) {
      return;
    }
    deps.journal.append(
      unitEvent('report-failed', unit(batchId), { detail: 'unverified exit' }),
      now
    );
    deps.store.withLock((s) => ({ state: releaseSlot(s, batchId, now), result: undefined }));
  }
}

// --- PR watch for `awaiting-merge` batches (mirrors `pollParkedPrs`/`reconcileParked`) ---

/**
 * Reset a batch's `pr-watch-failed` dedup marker (#630/#633). A no-op when no
 * streak is recorded, so it is safe to call on every non-`awaiting-merge`
 * batch every tick.
 */
function clearPrWatchFailed(deps: BatchDispatchDeps, batch: BatchEntry, now: Date): void {
  if (batch.pr_watch_failed_reason === null) return;
  deps.store.withLock((s) => ({
    state: patchBatch(s, batch.id, CLEARED_PR_WATCH_FIELDS, now, false),
    result: undefined,
  }));
}

function reconcilePrWatch(deps: BatchDispatchDeps, now: Date, result: BatchTickResult): void {
  const state = deps.store.load();
  for (const batch of state.batches) {
    if (batch.status !== 'awaiting-merge') {
      // #633: the marker is scoped to ONE awaiting-merge stretch. Merged,
      // blocked and dissolved batches all leave through this guard, and
      // `BATCH_TRANSITIONS` lets a batch come back to `awaiting-merge` on the
      // same id (`awaiting-merge → rebasing → re-validating → shipping →
      // awaiting-merge`, `recovery.ts`'s `handlePrConflict`). Leaving a live
      // reason behind would make the SAME reason recurring after a real
      // rebase-and-reship read as an unchanged streak and stay silent —
      // contradicting `BatchEntry.pr_watch_failed_reason`'s own contract.
      clearPrWatchFailed(deps, batch, now);
      continue;
    }
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
      const reason = truth.blocked ? 'auto-merge-blocked' : 'pr-conflicting';
      const isNewStreak = batch.pr_watch_failed_reason !== reason;
      const ticks = isNewStreak ? 1 : batch.pr_watch_failed_ticks + 1;
      const since = isNewStreak ? now.toISOString() : (batch.pr_watch_failed_since as string);
      // #630: journal on the streak's first tick, then again only every
      // `JOURNAL_DEDUP_REANNOUNCE_TICKS` — never every tick — mirrors #610's
      // `stale_milestone_ignored_for` dedup for the "distinct condition"
      // half, while still giving a still-blocked streak a later line an
      // operator can read "still blocked, Nth check" off (a single onset
      // entry never updates, so "after 40 minutes" would otherwise never be
      // legible from any journal line at all). `at` is the engine's OWN
      // decision time, never copied from `truth` (which carries no timestamp
      // of its own); `since` is the streak's onset, and is what makes the
      // duration legible — `ticks_persisted` is a tick count against an
      // operator-tunable `reconcile_interval_ms`, not a fixed wall-clock.
      if (isNewStreak || ticks % JOURNAL_DEDUP_REANNOUNCE_TICKS === 0) {
        journalEvent(deps, 'pr-watch-failed', unit(batch.id), {
          reason,
          pr,
          at: now.toISOString(),
          since,
          ticks_persisted: ticks,
        });
      }
      deps.store.withLock((s) => ({
        // `touchUpdatedAt: false` — a silent tick that only advances the
        // streak counter is bookkeeping, not activity (same rule as
        // `patchEntry`'s dedup writes).
        state: patchBatch(
          s,
          batch.id,
          {
            pr_watch_failed_reason: reason,
            pr_watch_failed_since: since,
            pr_watch_failed_ticks: ticks,
          },
          now,
          false
        ),
        result: undefined,
      }));
      // #472's own rebase-and-reship path (RFC F.9) is a documented follow-up
      // for the batch PR-conflict rail; for now the batch stays parked and
      // the block is visible via the journal + `sched status`.
    } else {
      // #630: the condition cleared — reset the marker so a future
      // re-occurrence (even the SAME reason) journals its own fresh entry.
      // This is de-duplication, not suppression: only an UNCHANGED streak
      // stays silent.
      clearPrWatchFailed(deps, batch, now);
    }
  }
}

// --- #686: stale-BLOCKED batch reconciliation (ground truth beats the ledger) ---

/**
 * #686: how long after a batch `blocked` its merge evidence may still arrive
 * and reconcile it — measured from `updated_at`, which is when the batch
 * became blocked (dedup writes don't touch it). Same window semantics as the
 * per-issue path's `STALE_RECONCILE_WINDOW_MS` (engine.ts): past it, an
 * abandoned batch is left as-is rather than polled (one `gh pr view` plus git
 * probes) forever. A local constant rather than an import: engine.ts already
 * imports THIS module, so the arrow points one way only.
 */
const STALE_BLOCKED_RECONCILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The forward rail a surviving member walks to `done` on a stale-blocked
 * reconcile — every step an ALREADY-LEGAL `ISSUE_BASE_TRANSITIONS` edge, so
 * the walk invents no new state-machine surface (AC3: a member whose commits
 * are in the base must not stay `in-work`, and `in-work → shipped-in-batch`
 * is not an edge — but `in-work → committed → validated → shipped-in-batch →
 * done` is). Members whose current status has no entry here (`waiting`, i.e.
 * never dispatched) are not walked: no recorded work, nothing shipped.
 */
const MEMBER_RECONCILE_CHAIN: Partial<Record<IssueStatus, IssueStatus>> = {
  'in-work': 'committed',
  committed: 'validated',
  validated: 'shipped-in-batch',
  'shipped-in-batch': 'done',
};

/**
 * Whether every SURVIVING member of `batch` was actually dispatched — i.e. no
 * surviving member is still sitting in a pre-dispatch status (`queued`,
 * `classified`, `batched`, `waiting`). Surviving = a `batch.members` issue
 * that is still a slot-mode entry, not evicted (its work was reverted and it
 * requeued full-cycle), and not already preserved (shipped/terminal through
 * another rail).
 *
 * This is the safety rail behind AC1: a member that never ran has NO work on
 * the branch, so a batch carrying one is NOT reconcilable to shipped —
 * reconciling it would call an issue `done` that shipped nothing, minting the
 * exact ledger/ground-truth drift (#675-class) this issue exists to cure,
 * just with the signs flipped. A dispatched member, by contrast, put its work
 * ON the branch (even when the gate blocked before its range was recorded —
 * the b-20260909-01 shape, where the only surviving member sat `in-work`),
 * and the branch is exactly what the merge evidence below covers.
 */
function everySurvivingMemberDispatched(state: SchedState, batch: BatchEntry): boolean {
  const evicted = new Set(batch.evictions.map((e) => e.issue));
  for (const issue of batch.members) {
    const entry = findEntry(state, issue);
    if (!entry) continue;
    if (entry.mode !== 'slot' || evicted.has(issue) || isPreservedMember(entry)) continue;
    // Pre-dispatch statuses: queued/classified/batched/waiting. `in-work` is
    // stamped at SPAWN (`spawnMember`), `committed`/`validated` at verified
    // completion — everything the entry can reach afterwards means the
    // member was dispatched and its work is on the branch.
    if (!DISPATCHED_MEMBER_STATUSES.has(entry.status)) return false;
  }
  return true;
}

/** Slot-line statuses that prove a member was actually dispatched (see above). */
const DISPATCHED_MEMBER_STATUSES: ReadonlySet<IssueStatus> = new Set([
  'in-work',
  'committed',
  'validated',
]);

/**
 * Whether the batch branch has landed in the base — the b-20260909-01 shape
 * of merge evidence ("The batch branch is in `main` at c277ff59b", `pr=None`):
 * the branch was merged out of band, so its commits are IN the base even
 * though the batch never shipped a PR of its own. Two probes against the
 * remote-tracking ref (refreshed best-effort first — a merge that landed on
 * the remote is invisible to `rev-list` until fetched; fetch failure leaves
 * the stale ref, the same degradation the per-issue path tolerates):
 *
 * - `git rev-list --count origin/<base>..<branch>` is 0 — nothing of the
 *   branch is missing from the base, i.e. every member commit on it is an
 *   ancestor of the base (AC1's wording);
 * - the branch tip is NOT the base tip — the branch actually carried work.
 *   A batch branch starts AT the base tip, so a branch that never received a
 *   member commit still probes 0 on the range; requiring a different tip is
 *   what separates "shipped" from "vacuously empty".
 */
function branchMergedIntoBase(deps: BatchDispatchDeps, batch: BatchEntry): boolean {
  if (batch.worktree === null || batch.branch === null) return false;
  // CWE-88 (the repo's own trap index): both refs are interpolated into git
  // argv below. They are state values written by batch-setup, not remote
  // input, but `runBatchSetup` refuses to CREATE anything this pattern would
  // reject (SAFE_REF_RE at the branch-creation site) — hold the reader to
  // the same bar instead of trusting upstream state shape.
  if (!SAFE_REF_RE.test(batch.branch) || !SAFE_REF_RE.test(batch.base_branch)) return false;
  const base = `origin/${batch.base_branch}`;
  deps.exec('git', ['fetch', 'origin', batch.base_branch], deps.repoDir);
  const ahead = deps.exec('git', ['rev-list', '--count', `${base}..${batch.branch}`], deps.repoDir);
  if ((ahead ?? '').trim() !== '0') return false;
  const branchTip = deps.exec('git', ['rev-parse', batch.branch], deps.repoDir);
  const baseTip = deps.exec('git', ['rev-parse', base], deps.repoDir);
  return branchTip !== null && baseTip !== null && branchTip.trim() !== '' && branchTip !== baseTip;
}

/**
 * #686: reconcile a `blocked` batch whose work demonstrably shipped anyway.
 * `reconcilePrWatch` above only watches `awaiting-merge` batches, and
 * `resumeBlockedGate` only re-runs the gate — so a batch blocked on a stale
 * verdict (the concrete case: `gate-inconclusive:test.focused`, itself often
 * a #690-declined gate TIMEOUT) whose PR merged out of band — or whose every
 * member commit is already in the base — stayed blocked FOREVER: no report,
 * no teardown, an operator-visible `blocked` row, and members stuck
 * `in-work`. Sibling of the per-issue `reconcileStaleFailedParks`
 * (engine.ts) under the same principle: ground truth beats the ledger, for
 * ANY stale verdict — the blocked_reason is deliberately not examined.
 *
 * Evidence (either suffices, cheapest first): the batch PR is MERGED with a
 * real timestamp (a merged batch PR contains the whole batch branch), or the
 * batch branch has fully landed in the base branch. A survivability guard
 * applies to BOTH paths (see `everySurvivingMemberDispatched`) — a batch with
 * a surviving member that was never dispatched is not reconcilable.
 *
 * On reconcile the batch joins the SAME rail a normally-merged batch takes:
 * `blocked → merged → deployed` (the `blocked → merged` edge exists for
 * exactly this caller), surviving members walked to `done` along legal
 * edges, and — when `batch.pr` is set — the ordinary `deployed` machinery
 * dispatches the report agent next tick, with teardown after `batch-report
 * done`. With `pr === null` no report agent can be prompted (it names the
 * PR), so the same lock continues `deployed → reported → done` and the
 * worktree is torn down here instead; the journal line says why no report
 * agent was dispatched rather than leaving the gap silent.
 *
 * Bounded by construction: only `blocked` batches within the window are
 * examined, the PR check is one `gh` call, git runs only when PR evidence
 * didn't already reconcile, and a reconciled batch leaves `blocked` — the
 * one journal line fires on the one-way transition, never per-tick (the
 * #632 lesson: no journal inside a loop that doesn't terminate the unit).
 */
function reconcileStaleBlockedBatches(
  deps: BatchDispatchDeps,
  now: Date,
  result: BatchTickResult
): void {
  const state = deps.store.load();
  const nowMs = now.getTime();
  for (const batch of state.batches) {
    if (batch.status !== 'blocked') continue;
    if (nowMs - Date.parse(batch.updated_at) >= STALE_BLOCKED_RECONCILE_WINDOW_MS) continue;
    if (!everySurvivingMemberDispatched(state, batch)) continue;

    let evidence:
      | { kind: 'pr-merged'; pr: number; mergedAt: string }
      | { kind: 'commits-in-base' }
      | null = null;
    if (batch.pr !== null) {
      const truth = deps.groundTruth.prState(batch.pr);
      if (truth !== undefined && truth.state === 'MERGED' && truth.mergedAt !== null) {
        evidence = { kind: 'pr-merged', pr: batch.pr, mergedAt: truth.mergedAt };
      }
    }
    if (evidence === null && branchMergedIntoBase(deps, batch)) {
      evidence = { kind: 'commits-in-base' };
    }
    if (evidence === null) continue;

    const blockedReason = batch.blocked_reason ?? 'blocked';
    const failedAt = batch.updated_at;
    let reconciled = false;
    let unwalkable: number[] = [];
    deps.store.withLock((s) => {
      const b = findBatch(s, batch.id);
      // Re-check under the lock: `sched resume --batch` (a passing recheck)
      // or `sched abandon` may have moved the batch out from under the
      // snapshot this pass started from.
      if (!b || b.status !== 'blocked') return { state: s, result: undefined };
      let n = transitionBatch(s, batch.id, 'merged', {}, now);
      n = transitionBatch(n, batch.id, 'deployed', {}, now);
      unwalkable = [];
      for (const issue of b.members) {
        let entry = findEntry(n, issue);
        if (!entry || isPreservedMember(entry)) continue;
        let guard = 0;
        while (entry !== undefined) {
          const nextStatus = MEMBER_RECONCILE_CHAIN[entry.status];
          if (nextStatus === undefined || guard++ > 8) break; // chain is 4 long; never loop forever on a bad table
          try {
            n = transitionIssue(n, issue, nextStatus, {}, now);
          } catch {
            // Not reachable along legal edges from here — name it in the
            // journal rather than forcing an illegal transition.
            unwalkable.push(issue);
            break;
          }
          entry = findEntry(n, issue);
        }
      }
      if (b.pr === null) {
        // No PR → no report agent is possible (its prompt names the PR).
        // Finish the terminal rail and let teardown run below.
        n = transitionBatch(n, batch.id, 'reported', {}, now);
        n = transitionBatch(n, batch.id, 'done', {}, now);
      }
      reconciled = true;
      return { state: n, result: undefined };
    });
    if (!reconciled) continue;

    journalEvent(deps, 'stale-failure-reconciled', unit(batch.id), {
      pr: batch.pr ?? undefined,
      reason: blockedReason,
      failedAt,
      evidence: evidence.kind,
      ...(evidence.kind === 'pr-merged' ? { mergedAt: evidence.mergedAt } : {}),
      detail:
        (evidence.kind === 'pr-merged'
          ? `PR #${evidence.pr} is MERGED — ledger reconciled blocked (${blockedReason}) to the merged rail (blocked at ${failedAt}); report and teardown will now dispatch`
          : `every member commit is an ancestor of ${batch.base_branch} — ledger reconciled blocked (${blockedReason}) to shipped (blocked at ${failedAt})`) +
        (batch.pr === null
          ? ' — no PR of its own, so no report agent can be prompted; teardown dispatched inline'
          : '') +
        (unwalkable.length > 0
          ? `; members NOT walked (no legal edge): ${unwalkable.join(',')}`
          : ''),
    });
    result.mergeAccepted.push(unit(batch.id));
    if (batch.pr === null) {
      teardownBatch(deps, batch.id);
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
  // #677: the current member's worktree goes first — it is batch-owned
  // state on the same teardown path as the shared tree, and a blocked or
  // dissolved batch must not leak a member tree (its branch/fields are
  // cleared by the helper; a gate-inconclusive BLOCK that intends to resume
  // never reaches this function). The batch is terminal here, so the
  // ranges-recorded membership of the last current member is a safe landed
  // signal (a range exists only for a member whose verified work landed).
  const terminal = findBatch(deps.store.load(), batchId);
  const lastMemberLanded =
    terminal?.ranges.some((r) => r.issue === terminal.members[terminal.executing_member - 1]) ===
    true;
  teardownMemberWorktree(deps, batchId, deps.now(), lastMemberLanded);
  const state = deps.store.load();
  const batch = findBatch(state, batchId);
  if (!batch || batch.worktree === null) return;
  const root = deps.exec('git', ['rev-parse', '--show-toplevel'], deps.repoDir) ?? deps.repoDir;
  // Pool-claimed worktrees are validated by the pool's own `return` (it only
  // accepts paths in pool state) and can legitimately live outside either
  // `isSafeWorktree` root when `.worktree-pool.json` configures a custom
  // `pool_dir` — mirrors `runTeardown`'s own internal skip for `poolClaimed`.
  if (batch.pool_claimed !== true && !isSafeWorktree(path.resolve(root), batch.worktree)) {
    journalEvent(deps, 'teardown-failed', unit(batchId), {
      reason: 'unsafe-worktree-path',
      detail: batch.worktree,
    });
    return;
  }
  const result = runTeardown(
    deps.exec,
    deps.repoDir,
    { worktree: batch.worktree, poolClaimed: batch.pool_claimed === true, branch: batch.branch },
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
 * the issue-level pass — this pass never claims a slot the issue pass already
 * gave to an issue (see the module doc: a batch's OWN claim never goes
 * through `computeAssignments`/`runnableUnits`). It is not, however, run on
 * leftovers: `dispatchAssignments` (#565) reserves capacity ahead of time for
 * any ready batch that outranks a competing issue in `runnableUnits`'
 * priority order, so a higher-priority batch is not starved by same-tick
 * issue dispatch — see that function's doc for the reservation mechanics.
 * Loads and saves state itself via `deps.store.withLock` — the caller holds
 * no lock across this call. `deps.exec` and `deps.runSuite` are mandatory;
 * `deps.runCapability` is independently optional (AC2's incremental gate is
 * itself a "when available" fast path).
 */
export function runBatchTick(
  deps: BatchDispatchDeps,
  config: SchedConfig,
  dispatch: ResolvedDispatch
): BatchTickResult {
  const result = emptyResult();
  const now = deps.now();

  // #707: each batch dispatches through ITS OWN recorded profile, not the
  // engine's default. Successful resolution is cached per tick (per
  // runBatchTick call); missing profiles are handled per batch. A profile that
  // no longer resolves (config edited
  // mid-run) never silently falls back — the silent fallback is precisely
  // the #680 incident shape (a run that looked like one agent family,
  // executed as another). The reaction depends on how far the batch got:
  // - pre-merge (`dissolving` is a legal edge): DISSOLVE with reason
  //   `dispatch-profile-missing:<name>` — loud, deterministic, one-shot, and
  //   the members requeue as full-cycle units on the config default, which is
  //   a coherent recovery rather than a mislabelled continuation.
  // - post-merge (PR parked/merged — the product already shipped): dissolving
  //   would discard a landed PR's bookkeeping, so the remaining dispatch (the
  //   report agent) runs on the default and journals
  //   `dispatch-profile-missing` once while it holds the decision open — a
  //   bounded phase (deployed → reported), with the journal acting as the
  //   durable deduplication record across ticks and process restarts.
  const profileCache = new Map<string, ResolvedDispatch>();
  const missingProfileBatches = new Set<string>();
  const missingProfileNotices = new Set(
    deps.journal
      .read()
      .filter((event) => event.event === 'dispatch-profile-missing' && event.unit !== undefined)
      .map((event) => event.unit as string)
  );
  const dispatchFor = (batch: BatchEntry): ResolvedDispatch | null => {
    if (batch.dispatch_profile === null) return dispatch;
    const cached = profileCache.get(batch.dispatch_profile);
    if (cached !== undefined) return cached;
    if (missingProfileBatches.has(batch.id)) return dispatch;
    try {
      const resolved = resolveProfiledDispatch(config, batch.dispatch_profile);
      profileCache.set(batch.dispatch_profile, resolved);
      return resolved;
    } catch (err) {
      if (!(err instanceof DispatchProfileError)) throw err;
      missingProfileBatches.add(batch.id);
      const current = deps.store.load();
      const fresh = findBatch(current, batch.id);
      const dissolvable =
        fresh !== undefined && allowedBatchTransitions(fresh.status).includes('dissolving');
      if (dissolvable) {
        const liveSlot = slotFor(current, batch.id);
        if (
          liveSlot !== undefined &&
          liveSlot.pid !== null &&
          deps.spawnDeps.isAlive(liveSlot.pid, liveSlot.pid_start ?? undefined)
        ) {
          deps.spawnDeps.kill(liveSlot.pid, liveSlot.pid_start ?? undefined);
        }
        const outcome = dissolveBatch(
          current,
          batch.id,
          { strategy: 'full', reason: `dispatch-profile-missing:${batch.dispatch_profile}` },
          recoveryDeps(deps, config, fresh, now)
        );
        deps.store.withLock((s) => ({
          state: applyBatchAndIssues(s, outcome.state, batch.id, outcome.requeued),
          result: undefined,
        }));
        teardownBatch(deps, batch.id);
        result.failed.push(unit(batch.id));
        // Resolution failed: clean up any batch/member worktrees, then skip
        // this batch for the rest of the pass. No further arm can claim it.
        // Do not cache a missing profile: every batch must receive its own
        // dissolve/journal reaction rather than inheriting a cached default.
        return null;
      } else {
        const batchUnit = unit(batch.id);
        if (!missingProfileNotices.has(batchUnit)) {
          journalEvent(deps, 'dispatch-profile-missing', batchUnit, {
            detail: `profile '${batch.dispatch_profile}' is no longer configured; the post-merge tail runs on the default dispatch`,
          });
          missingProfileNotices.add(batchUnit);
        }
        return dispatch;
      }
    }
  };

  // #565: when more ready batches exist than free capacity, claim them in
  // the same priority order `runnableUnits` would (desc priority → asc
  // readiness age → anchor) — this loop never goes through
  // `computeAssignments`/`runnableUnits` itself (see the module doc), so it
  // applies the shared comparator/rank helpers directly. The ORDER and
  // MEMBERSHIP of `readyOrder` are frozen from a snapshot taken once up
  // front — a batch that becomes `ready` mid-pass waits for the next tick;
  // only the per-batch `slotFor`/`status` re-check inside the loop reads
  // fresh state (one `store.load()` per iteration, in case an earlier claim
  // in this same pass changed things).
  // #629: dispatch-health pause (#505, and now the confirmed-api-error
  // streak) stops NEW per-issue assignments via `computeAssignments` — but
  // nothing in this function ever read `paused` before #629, so claiming a
  // `ready` batch here (a provider dispatch, `batch-setup`, the most literal
  // "new assignment" there is) or a respawn wedge in the second loop below
  // would keep happening every tick regardless, making the pause cosmetic
  // for the exact incident (a batch tail respawning against a spend wall)
  // that motivated it. Read once — every use below in this same tick must
  // agree, and re-reading per iteration only risks a pause landing mid-loop
  // and gating some batches but not others in one pass.
  const paused = deps.store.load().paused;
  const readyOrder = paused
    ? []
    : [...deps.store.load().batches]
        .filter((b) => b.status === 'ready')
        .sort((a, b) => compareByPriority(batchRank(a), batchRank(b)))
        .map((b) => b.id);
  for (const batchId of readyOrder) {
    const state = deps.store.load();
    const batch = findBatch(state, batchId);
    if (batch && batch.status === 'ready' && slotFor(state, batchId) === undefined) {
      // #707: batch-setup dispatches through the batch's own profile too — it
      // is the batch's first agent, not an engine-internal step.
      const batchDispatch = dispatchFor(batch);
      if (batchDispatch !== null) {
        claimAndSetup(deps, config, batchDispatch, batchId, now, result);
      }
    }
  }

  for (const batch of deps.store.load().batches) {
    const slot = slotFor(deps.store.load(), batch.id);
    // #609: a TERMINAL batch (`done`/`dissolved`) still holding a slot matches
    // none of the status arms below and would fall through their `continue`,
    // so nothing ever looks at that slot again — not even the orphaned-pid
    // rail that would otherwise notice its dead process. It leaked for the
    // life of the state file, with no CLI lever to recover it.
    //
    // This arm is the safety net, deliberately independent of the fix in
    // `abandonBatch` that stops one from being created: it also REPAIRS state
    // files that already carry a leaked slot, which is the only way an
    // operator gets those three hours of held capacity back.
    if (TERMINAL_BATCH_STATUSES.has(batch.status)) {
      if (slot) {
        deps.store.withLock((s) => ({
          state: releaseBatchSlot(s, batch.id, now),
          result: undefined,
        }));
        journalEvent(deps, 'slot-released', unit(batch.id), {
          slot: slot.id,
          detail: `terminal batch (${batch.status}) held slot ${slot.id}`,
        });
      }
      continue;
    }
    // #707: resolve this batch's profile once per pass — or dissolve/fall
    // back loudly when it no longer resolves (see `dispatchFor` above).
    // Terminal batches are skipped before this call so a removed profile does
    // not generate a missing-profile event on every later tick.
    const batchDispatch = dispatchFor(batch);
    if (batchDispatch === null) continue;
    if (slot && (slot.status === 'running' || slot.status === 'assigned')) {
      if (batch.status === 'executing') {
        reconcileMemberSlot(deps, config, batchDispatch, batch.id, slot, now, result);
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
      // A local suite run, not a provider dispatch — unaffected by `paused`.
      runValidate(deps, config, batchDispatch, batch.id, now, result);
      continue;
    }
    // #629: every branch below spawns a provider agent — hold the wedge
    // until `sched resume` (see the top of this function for why `paused`
    // is read once, up front, rather than per iteration).
    if (paused) continue;
    if (batch.status === 'deployed') {
      spawnReportAgent(deps, config, batchDispatch, batch.id, now, result);
    } else if (batch.status === 'executing') {
      // A prior spawn threw, or `claimAndSpawn` found zero free capacity —
      // either way the batch is stuck mid-member with no slot and nothing
      // else will ever retry it (Conformance review AC5 caveat; Supportability
      // review #12). Retrying every tick is cheap-by-contract (#677 review):
      // `spawnMemberContinuation` runs the free-capacity and member-identity
      // pre-checks BEFORE any pool/git work, so a full scheduler (or stale
      // member context) exits here without exec'ing, and `claimAndSpawn`
      // remains the authoritative capacity gate.
      spawnMemberContinuation(deps, config, batchDispatch, batch.id, now, result);
    } else if (batch.status === 'reviewing' || batch.status === 'shipping') {
      // Same wedge, for a dead-or-never-claimed tail agent.
      spawnTailAgent(deps, config, batchDispatch, batch.id, now, result);
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
        const rDeps = recoveryDeps(deps, config, b, now);
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
  reconcileStaleBlockedBatches(deps, now, result);
  return result;
}
