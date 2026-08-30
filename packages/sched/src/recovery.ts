/**
 * Batch failure recovery core — RFC-0001 §F.2/F.8/F.9 (#472): attribute
 * aggregate-suite failures deterministically, one bounded mid-tier fix
 * attempt per offending member, surgical eviction (revert the member's
 * commit range; eviction groups revert together), requeue with context, and
 * dissolve as the last resort — nothing green is thrown away.
 *
 * The module is a library: the batch-execution loop (a #464 follow-up) calls
 * these functions; they are fully testable standalone against scratch repos.
 * Discipline follows the engine's: every world-touching effect (git, suite
 * runs, milestone posts) is injected via `RecoveryDeps`, and the state
 * changes ride the typed rails in state.ts. The package never invokes an
 * LLM — the fix attempt is a dispatch INSTRUCTION the caller spawns
 * (dispatch.ts machinery), exactly like a full-cycle dispatch.
 *
 * Rails used (all pre-declared in state.ts):
 *   validating → attributing → fixing → validating (bounded fix attempt)
 *   attributing → evicting → validating (revert + suite re-run)
 *   any dissolving-capable status → dissolving → dissolved
 *   awaiting-merge → rebasing → re-validating → shipping (PR conflict, F.9)
 */

import {
  attributeByOverlap,
  type BoundaryCommit,
  commitsOfMember,
  type FailingTest,
  type MemberFootprint,
  parseBoundaryCommits,
  type TestAttribution,
} from './attribution';
import { runAttributionBisect } from './bisect';
import { buildAgentCommand, type ResolvedDispatch } from './dispatch';
import { type Journal, unitEvent } from './journal';
import type { ExecFn } from './project';
import { requeueUnshippedMembers } from './scheduler';
import { findBatch, findEntry, transitionBatch, transitionIssue } from './state';
import type { BatchEntry, FailureEvidence, ModelTier, SchedState } from './types';
import {
  DISSOLVE_EVICTED_FRACTION,
  MAX_FIX_ATTEMPTS,
  MAX_REBASE_ATTEMPTS,
  SATISFIED_ISSUE_STATUSES,
  TERMINAL_ISSUE_STATUSES,
} from './types';

// --- Deps and shared shapes ---

/** An aggregate-suite verdict. */
export interface SuiteResult {
  ok: boolean;
  /** The failing tests, as reported (empty when ok / unparseable). */
  failing: FailingTest[];
}

/** A batch milestone to post on the anchor issue (AC5). */
export interface BatchMilestone {
  /** Batch phase the milestone belongs to. */
  phase: 'batch-validate' | 'batch-ship';
  status: 'done' | 'blocked';
  /** Slug reason (required by the runstate contract on `blocked`). */
  reason: string;
  /** Extra `key=value` pairs; values must be space-free (sanitized if not). */
  kv?: Record<string, string>;
}

/** Every world-touching effect the recovery core needs, injected. */
export interface RecoveryDeps {
  /** Git exec — boundary reads, reverts, rebases. Never throws. */
  exec: ExecFn;
  /** The batch worktree: the batch branch checked out. */
  cwd: string;
  journal: Journal;
  now: () => Date;
  /** Run the aggregate suite in `cwd` — full, or only `tests` when given. */
  runSuite: (tests?: readonly string[]) => SuiteResult;
  /** Build the argv that runs ONLY `tests` — `git bisect run`'s script (F.2). */
  focusedTestCommand: (tests: readonly string[]) => string[];
  /** Post a milestone on the batch anchor (AC5); never throws. */
  postMilestone: (batch: BatchEntry, milestone: BatchMilestone) => void;
}

/** A branch/ref name safe for argv: word chars, `/`, `.`, `-`, no leading `-`. */
function safeRef(ref: string): boolean {
  return /^[\w][\w./-]*$/.test(ref) && !ref.includes('..');
}

/** Sanitize a milestone value: the runstate contract is "no spaces". */
function sanitizeValue(value: string): string {
  return value.replace(/\s+/g, '-');
}

// --- Boundary reads ---

/**
 * Read the batch branch's commits over `origin/<baseBranch>..HEAD` and map
 * them to members via the `(#N)` trailer. Null when the log cannot be read
 * (missing base ref, git failure) — the caller escalates, it never guesses.
 */
export function readBoundaries(
  deps: Pick<RecoveryDeps, 'exec' | 'cwd'>,
  baseBranch: string
): BoundaryCommit[] | null {
  if (!safeRef(baseBranch)) return null;
  const log = deps.exec(
    'git',
    ['log', '--format=%H%x09%s', `origin/${baseBranch}..HEAD`, '--'],
    deps.cwd
  );
  if (log === null) return null;
  return parseBoundaryCommits(log);
}

/** Resolve the merge-base sha of HEAD and `origin/<baseBranch>`, or null. */
function baseSha(deps: Pick<RecoveryDeps, 'exec' | 'cwd'>, baseBranch: string): string | null {
  if (!safeRef(baseBranch)) return null;
  const sha = deps.exec('git', ['merge-base', 'HEAD', `origin/${baseBranch}`, '--'], deps.cwd);
  if (sha === null) return null;
  const trimmed = sha.trim();
  return /^[0-9a-f]{7,40}$/i.test(trimmed) ? trimmed : null;
}

/** HEAD sha in `cwd`, or null. */
function headSha(deps: Pick<RecoveryDeps, 'exec' | 'cwd'>): string | null {
  const sha = deps.exec('git', ['rev-parse', 'HEAD'], deps.cwd);
  if (sha === null) return null;
  const trimmed = sha.trim();
  return /^[0-9a-f]{7,40}$/i.test(trimmed) ? trimmed : null;
}

// --- Attribution (F.2 stage 1 + 2) ---

/** The full attribution verdict over a red suite. */
export interface AttributionVerdict {
  /** Member → failing tests attributed to it. */
  attributed: Map<number, string[]>;
  /** How each attributed member was resolved. */
  methods: Map<number, 'overlap' | 'bisect'>;
}

/** Attribution could not resolve to members — a human decides (F.3's rule). */
export interface DecisionPending {
  kind: 'decision-pending';
  reason: string;
}

/**
 * Attribute a red suite's failing tests (F.2): overlap first; every test
 * still ambiguous or unattributed goes to ONE deterministic bisect over the
 * issue-boundary commits running only those tests. Bisect outcome maps all
 * of its tests to the first-bad member — conservative and loop-correct: if
 * another member also broke a test, the post-eviction suite re-run catches
 * it in the next round. Bisect green/error/unattributable ⇒ decision-pending
 * (never a guess, never a wrong merge — Q19).
 */
export function attributeSuiteFailure(
  deps: RecoveryDeps,
  batch: BatchEntry,
  failing: readonly FailingTest[],
  footprints: readonly MemberFootprint[],
  boundaries: readonly BoundaryCommit[]
): AttributionVerdict | DecisionPending {
  const overlap: TestAttribution[] = attributeByOverlap(failing, footprints);

  const attributed = new Map<number, string[]>();
  const methods = new Map<number, 'overlap' | 'bisect'>();
  for (const t of overlap) {
    if (t.members.length === 1) {
      const issue = t.members[0] as number;
      attributed.set(issue, [...(attributed.get(issue) ?? []), t.test]);
      methods.set(issue, 'overlap');
    }
  }

  const unresolved = overlap.filter((t) => t.members.length !== 1);
  if (unresolved.length === 0) {
    return { attributed, methods };
  }

  // One bisect over every unresolved test (F.2's deterministic resolver).
  const tests = unresolved.map((t) => t.test);
  const base = baseSha(deps, batch.base_branch);
  const head = headSha(deps);
  if (base === null || head === null) {
    return { kind: 'decision-pending', reason: 'base-or-head-unresolvable' };
  }
  const outcome = runAttributionBisect(
    { exec: deps.exec, cwd: deps.cwd },
    {
      base,
      head,
      boundaries,
      testCommand: deps.focusedTestCommand(tests),
    }
  );
  if (outcome.kind === 'green') {
    return { kind: 'decision-pending', reason: 'bisect-green-at-head' };
  }
  if (outcome.kind === 'error') {
    return { kind: 'decision-pending', reason: `bisect-error:${outcome.detail}` };
  }
  if (outcome.issue === null) {
    return { kind: 'decision-pending', reason: 'first-bad-not-a-member-commit' };
  }
  const issue = outcome.issue;
  attributed.set(issue, [...(attributed.get(issue) ?? []), ...tests]);
  methods.set(issue, 'bisect');
  return { attributed, methods };
}

// --- Bounded fix attempt (F.2) ---

/**
 * Default prompt for the one bounded mid-tier fix attempt. The agent gets
 * the failing tests and a strict budget: fix them or report that it cannot —
 * eviction, not iteration, is the pipeline's next step.
 */
export const DEFAULT_FIX_PROMPT_TEMPLATE =
  'The aggregate suite of batch {batch} failed; the failing tests are attributed to issue #{issue}:\n\n' +
  '{tests}\n\n' +
  'You have ONE bounded attempt (you are the mid-tier fix agent of RFC-0001 F.2). Fix the failing ' +
  'tests for issue #{issue} in this repository — diagnose, fix, run the failing tests plus focused ' +
  'tests for the files you touch, and commit with the issue trailer (#N). Do not refactor beyond ' +
  "the failure, do not touch other members' changes. If you cannot fix it, say so plainly and stop.";

/** The dispatch instruction for a fix attempt — the CALLER spawns it. */
export interface FixDispatch {
  issue: number;
  /** Mid-tier agent argv (dispatch.ts `buildAgentCommand`). */
  command: string[];
  /** The fix prompt with {batch}/{issue}/{tests} substituted. */
  prompt: string;
}

/** How many fix attempts `issue` already has on record. */
function fixAttemptsFor(batch: BatchEntry, issue: number): number {
  return batch.fix_attempts.filter((fa) => fa.issue === issue).length;
}

/**
 * Begin the ONE bounded fix attempt for `issue` (F.2). Returns the dispatch
 * instruction for the caller to spawn, or null when the member already used
 * its attempt — the pipeline evicts instead of re-dispatching. Transitions
 * the batch `attributing → fixing` and records a `pending` attempt so a
 * crash between begin and resolve can never double-dispatch.
 */
export function beginFixAttempt(
  deps: RecoveryDeps,
  state: SchedState,
  batchId: string,
  issue: number,
  failingTests: readonly string[],
  resolved: ResolvedDispatch,
  fixTier: ModelTier = 'mid'
): { state: SchedState; dispatch: FixDispatch | null } {
  const now = deps.now();
  let batch = findBatch(state, batchId);
  if (!batch) throw new Error(`Batch not found: ${batchId}`);
  if (batch.status !== 'attributing') {
    throw new Error(`Batch ${batchId} is ${batch.status} — fix attempts begin from attributing`);
  }
  if (fixAttemptsFor(batch, issue) >= MAX_FIX_ATTEMPTS) {
    return { state, dispatch: null };
  }

  const tests = failingTests.length > 0 ? failingTests : ['(unattributed failing tests)'];
  const prompt = DEFAULT_FIX_PROMPT_TEMPLATE.replaceAll('{batch}', batchId)
    .replaceAll('{issue}', String(issue))
    .replaceAll('{tests}', tests.map((t) => `- ${t}`).join('\n'));
  const dispatch: FixDispatch = {
    issue,
    command: buildAgentCommand(resolved.command, fixTier, issue, resolved.tierModels),
    prompt,
  };

  let next = transitionBatch(state, batchId, 'fixing', {}, now);
  batch = findBatch(next, batchId) as BatchEntry;
  next = {
    ...next,
    batches: next.batches.map((b) =>
      b.id === batchId
        ? {
            ...b,
            fix_attempts: [
              ...b.fix_attempts,
              { issue, outcome: 'pending' as const, at: now.toISOString() },
            ],
          }
        : b
    ),
  };
  deps.journal.append(
    unitEvent('fix-dispatched', `issue:${issue}`, { detail: `batch:${batchId}` }),
    now
  );
  return { state: next, dispatch };
}

/**
 * Resolve a fix attempt with the suite verdict after the agent exited (the
 * caller re-ran the aggregate suite). Records the outcome and transitions
 * `fixing → validating` — green means the re-run passed and the batch may
 * proceed to review; red re-enters the failure pipeline (attribution knows
 * the offender; its spent attempt suppresses a second dispatch).
 */
export function resolveFixAttempt(
  deps: RecoveryDeps,
  state: SchedState,
  batchId: string,
  issue: number,
  suite: SuiteResult
): SchedState {
  const now = deps.now();
  const batch = findBatch(state, batchId);
  if (!batch) throw new Error(`Batch not found: ${batchId}`);
  if (batch.status !== 'fixing') {
    throw new Error(
      `Batch ${batchId} is ${batch.status} — only a fixing batch resolves an attempt`
    );
  }
  let next = {
    ...state,
    batches: state.batches.map((b) =>
      b.id === batchId
        ? {
            ...b,
            fix_attempts: b.fix_attempts.map((fa) =>
              fa.issue === issue && fa.outcome === 'pending'
                ? { ...fa, outcome: suite.ok ? ('green' as const) : ('red' as const) }
                : fa
            ),
          }
        : b
    ),
  };
  next = transitionBatch(next, batchId, 'validating', {}, now);
  return next;
}

// --- Eviction (F.2) ---

/** What `evictMembers` did. */
export interface EvictOutcome {
  state: SchedState;
  /** Members evicted this round (eviction-group expansion included). */
  evicted: number[];
  /** Commits actually reverted, in application order (newest first). */
  revertedCommits: string[];
  /** A revert did not apply cleanly — the branch is abandoned (dissolve). */
  revertConflict: boolean;
  /** The post-eviction suite re-run (null on conflict/dissolve). */
  suite: SuiteResult | null;
  /** The dissolve trigger that fired, if any. */
  dissolve: 'evicted-fraction' | 'revert-conflict' | null;
  /** The dissolution, when a trigger fired. */
  dissolution: DissolveOutcome | null;
}

/** All members that must revert together with `issue` (its eviction group, itself included). */
function evictionGroupOf(batch: BatchEntry, issue: number): number[] {
  const group = batch.eviction_groups.find((g) => g.includes(issue));
  return group ?? [issue];
}

/**
 * Evict members: revert their commit ranges (eviction groups revert
 * together — RFC-0001 §E.4), requeue each as full-cycle with failure
 * evidence attached, journal + post a batch milestone (AC5), re-run the
 * suite (AC2), and check the >⅓ dissolve trigger (F.2). A revert that does
 * not apply cleanly aborts the revert and dissolves the batch — the branch
 * is abandoned either way (F.2 "revert conflicts → dissolve").
 *
 * Entry rail: `attributing → evicting` (the pipeline's position when the
 * fix attempt is spent or was not applicable).
 */
export function evictMembers(
  deps: RecoveryDeps,
  state: SchedState,
  batchId: string,
  issues: readonly number[],
  options: {
    reason: string;
    attribution: 'overlap' | 'bisect' | 'group' | 'unattributed';
    failingTests: readonly string[];
    boundaries: readonly BoundaryCommit[];
  }
): EvictOutcome {
  const { exec, cwd } = deps;
  const now = deps.now();
  const batch = findBatch(state, batchId);
  if (!batch) throw new Error(`Batch not found: ${batchId}`);
  if (batch.status !== 'attributing') {
    throw new Error(`Batch ${batchId} is ${batch.status} — eviction begins from attributing`);
  }

  // Eviction-group expansion (E.4): an offender takes its whole group.
  const toEvict = new Set<number>();
  for (const issue of issues) {
    for (const member of evictionGroupOf(batch, issue)) toEvict.add(member);
  }
  const evicted = batch.members.filter((m) => toEvict.has(m));

  // Collect the commits to revert, newest first (revert applies newest
  // first so earlier members' code stays coherent).
  const offenders = new Set(issues);
  const reverted: string[] = [];
  for (const member of evicted) {
    reverted.push(...commitsOfMember(options.boundaries, member));
  }
  // boundaries are oldest-first here; newest-first application order:
  const newestFirst = [...reverted].reverse();

  let revertConflict = false;
  const applied: string[] = [];
  for (const sha of newestFirst) {
    const ok = exec('git', ['revert', '--no-edit', sha, '--'], cwd);
    if (ok === null) {
      // Conflict: abort the in-progress revert, keep what applied before.
      exec('git', ['revert', '--abort'], cwd);
      revertConflict = true;
      break;
    }
    applied.push(sha);
  }

  // --- State: evicting rail, records, requeues, journal, milestone ---
  let next = transitionBatch(state, batchId, 'evicting', {}, now);
  const ts = now.toISOString();

  const evidenceFor = (issue: number): FailureEvidence => ({
    batch: batchId,
    failing_tests: offenders.has(issue) ? [...options.failingTests] : [],
    attribution: offenders.has(issue) ? options.attribution : 'group',
    reason: offenders.has(issue) ? options.reason : 'eviction-group',
    reverted_commits: applied.filter((sha) =>
      commitsOfMember(options.boundaries, issue).includes(sha)
    ),
    at: ts,
  });

  const records = evicted.map((issue) => ({
    issue,
    reason: offenders.has(issue) ? options.reason : 'eviction-group',
    reverted_commits: applied.filter((sha) =>
      commitsOfMember(options.boundaries, issue).includes(sha)
    ),
    group: evicted,
    at: ts,
  }));

  next = {
    ...next,
    batches: next.batches.map((b) =>
      b.id === batchId ? { ...b, evictions: [...b.evictions, ...records] } : b
    ),
  };

  for (const issue of evicted) {
    const entry = findEntry(next, issue);
    if (!entry || TERMINAL_ISSUE_STATUSES.has(entry.status)) continue;
    const reason = offenders.has(issue) ? options.reason : 'eviction-group';
    if (entry.status !== 'evicted' && entry.status !== 'requeued') {
      next = transitionIssue(next, issue, 'evicted', { reason }, now);
    }
    next = transitionIssue(
      next,
      issue,
      'requeued',
      { mode: 'full', batch: null, reason, failure_evidence: evidenceFor(issue) },
      now
    );
    deps.journal.append(unitEvent('member-evicted', `issue:${issue}`, { detail: reason }), now);
  }

  deps.postMilestone(findBatch(next, batchId) as BatchEntry, {
    phase: 'batch-validate',
    status: 'blocked',
    reason: revertConflict ? 'revert-conflict' : `evicted:${evicted.join(',')}`,
    kv: {
      reverted: String(applied.length),
      ...(revertConflict ? {} : { outcome: 'reverted' }),
    },
  });

  // --- Dissolve triggers (F.2): revert conflict, or >⅓ of members evicted ---
  const outcome: EvictOutcome = {
    state: next,
    evicted,
    revertedCommits: applied,
    revertConflict,
    suite: null,
    dissolve: null,
    dissolution: null,
  };

  if (revertConflict) {
    outcome.dissolve = 'revert-conflict';
    const dissolution = dissolveBatch(deps, next, batchId, 'revert-conflict', 'halved');
    outcome.state = dissolution.state;
    outcome.dissolution = dissolution;
    return outcome;
  }

  const evictedTotal = new Set(
    (findBatch(next, batchId) as BatchEntry).evictions.map((e) => e.issue)
  );
  if (evictedTotal.size > batch.members.length * DISSOLVE_EVICTED_FRACTION) {
    outcome.dissolve = 'evicted-fraction';
    const dissolution = dissolveBatch(deps, next, batchId, 'evicted-fraction', 'full');
    outcome.state = dissolution.state;
    outcome.dissolution = dissolution;
    return outcome;
  }

  // No trigger: re-run the suite (AC2) and re-enter validating.
  const suite = deps.runSuite();
  outcome.state = transitionBatch(next, batchId, 'validating', {}, now);
  outcome.suite = suite;
  return outcome;
}

// --- Dissolve (F.2/F.8) ---

/** What `dissolveBatch` did. */
export interface DissolveOutcome {
  state: SchedState;
  /** Members requeued as full-cycle (strategy `full`). */
  requeued: number[];
  /** Members whose outcome was preserved — nothing green is discarded (F.8). */
  preserved: number[];
  /** The two half-batch ids (strategy `halved`), else null. */
  halves: [string, string] | null;
}

/**
 * Whether the >⅓ eviction trigger is armed for `batch` (F.2). Exposed for
 * status previews; `evictMembers` applies it automatically.
 */
export function dissolveTriggered(batch: BatchEntry): boolean {
  const evicted = new Set(batch.evictions.map((e) => e.issue));
  return evicted.size > batch.members.length * DISSOLVE_EVICTED_FRACTION;
}

/** Members whose work has merged or whose entry is terminal — preserved on dissolve (F.8). */
function preservedMembers(state: SchedState, batch: BatchEntry): number[] {
  return batch.members.filter((issue) => {
    const entry = findEntry(state, issue);
    if (!entry) return false;
    return TERMINAL_ISSUE_STATUSES.has(entry.status) || SATISFIED_ISSUE_STATUSES.has(entry.status);
  });
}

/**
 * Dissolve the batch (F.2/F.8): `dissolving → dissolved`, requeue every
 * unshipped member — strategy `full` requeues each as full-cycle (the
 * `abandonBatch` semantics); strategy `halved` splits the still-batched
 * unshipped members into two forming half-batches (`<id>-a` / `<id>-b`,
 * first half = first ceil(n/2) in dispatch order) and retags their entries,
 * per F.9's "conflict probability ∝ batch width". Members already
 * shipped/terminal keep their outcome; members already evicted/requeued
 * earlier keep their full-cycle requeue. Falls back to `full` when fewer
 * than two halvable members exist. Posts the dissolve milestone with what
 * was preserved (AC5) and journals `batch-dissolved`.
 */
export function dissolveBatch(
  deps: RecoveryDeps,
  state: SchedState,
  batchId: string,
  reason: string,
  strategy: 'full' | 'halved'
): DissolveOutcome {
  const now = deps.now();
  const batch = findBatch(state, batchId);
  if (!batch) throw new Error(`Batch not found: ${batchId}`);
  const ts = now.toISOString();

  const preserved = preservedMembers(state, batch);
  // Members already on the full-cycle rail (evicted/requeued by an earlier
  // recovery round) are NOT halved back into new batches — their requeue
  // stands; the halves take only still-batched unshipped members.
  const alreadyOut = batch.members.filter((issue) => {
    const entry = findEntry(state, issue);
    return entry !== undefined && (entry.status === 'evicted' || entry.status === 'requeued');
  });
  const halvable = batch.members.filter(
    (issue) => !preserved.includes(issue) && !alreadyOut.includes(issue)
  );

  let next = state;
  let halves: [string, string] | null = null;
  let requeued: number[] = [];

  if (strategy === 'halved' && halvable.length >= 2) {
    const mid = Math.ceil(halvable.length / 2);
    const halfMembers: [number[], number[]] = [halvable.slice(0, mid), halvable.slice(mid)];
    const halfIds: [string, string] = [`${batchId}-a`, `${batchId}-b`];
    halves = halfIds;

    const groupsFor = (members: number[]): number[][] =>
      batch.eviction_groups
        .map((g) => g.filter((m) => members.includes(m)))
        .filter((g) => g.length > 0);

    next = {
      ...next,
      batches: [
        ...next.batches,
        ...halfIds.map((id, i) => ({
          id,
          status: 'forming' as const,
          members: halfMembers[i] as number[],
          base_branch: batch.base_branch,
          executing_member: 0,
          anchor: batch.anchor,
          branch: null,
          run_id: batch.run_id,
          eviction_groups: groupsFor(halfMembers[i] as number[]),
          evictions: [],
          fix_attempts: [],
          rebase_attempts: 0,
          created_at: ts,
          updated_at: ts,
        })),
      ],
    };
    // Retag half members into their new batches. This is a metadata patch,
    // not a typed transition: the entry is changing batch identity, so the
    // old batch's rail no longer applies (the same rationale as
    // abandonBatch's queued|classified retag).
    const halfOf = new Map<number, string>();
    for (let i = 0; i < 2; i++) {
      for (const m of halfMembers[i] as number[]) halfOf.set(m, halfIds[i] as string);
    }
    next = {
      ...next,
      entries: next.entries.map((e) => {
        const half = halfOf.get(e.issue);
        return half !== undefined
          ? { ...e, batch: half, status: 'batched' as const, updated_at: ts }
          : e;
      }),
    };
    // The halves own these members now — remove them from the dissolving
    // batch so the shared requeue loop below does not double-requeue them.
    const halved = new Set([...halfMembers[0], ...halfMembers[1]]);
    next = {
      ...next,
      batches: next.batches.map((b) =>
        b.id === batchId ? { ...b, members: b.members.filter((m) => !halved.has(m)) } : b
      ),
    };
  }

  // dissolving → dissolved on the typed rails (transitionBatch throws for
  // statuses that do not declare dissolving — the caller routes through
  // rebasing/evicting first when needed).
  next = transitionBatch(next, batchId, 'dissolving', {}, now);
  next = transitionBatch(next, batchId, 'dissolved', {}, now);
  const requeuedState = requeueUnshippedMembers(
    next,
    findBatch(next, batchId) as BatchEntry,
    `dissolved:${reason}`,
    now
  );
  requeued = requeuedState.requeued;
  next = requeuedState.state;

  deps.journal.append(unitEvent('batch-dissolved', `batch:${batchId}`, { detail: reason }), now);
  deps.postMilestone(findBatch(next, batchId) as BatchEntry, {
    phase: 'batch-validate',
    status: 'blocked',
    reason: `dissolved:${reason}`,
    kv: {
      preserved: preserved.map(String).join(',') || 'none',
      ...(halves
        ? { halves: halves.join(',') }
        : { requeued: requeued.map(String).join(',') || 'none' }),
    },
  });

  return { state: next, requeued, preserved, halves };
}

// --- Batch-PR conflict path (F.9 / AC4) ---

/** What `handlePrConflict` did. */
export type PrConflictOutcome =
  | { kind: 'rebased'; state: SchedState; suite: SuiteResult }
  | { kind: 'dissolved'; state: SchedState; dissolution: DissolveOutcome }
  | { kind: 'error'; state: SchedState; detail: string };

/**
 * A batch PR hit CONFLICTING or `auto-merge-blocked` (base moved — F.9):
 *
 * - first occurrence: `awaiting-merge → rebasing`, rebase the batch branch
 *   onto `origin/<base>` (conflict ⇒ abort + dissolve into halves — the
 *   branch cannot be rebuilt mechanically), force-push-with-lease the
 *   rebuilt branch, `rebasing → re-validating`, re-run the suite; green ⇒
 *   `re-validating → shipping` (re-ship once), red ⇒ dissolve into halves;
 * - second occurrence: dissolve into two half-batches immediately
 *   (rebase_attempts guard — "conflict probability ∝ batch width").
 */
export function handlePrConflict(
  deps: RecoveryDeps,
  state: SchedState,
  batchId: string,
  conflict: 'pr-conflicting' | 'auto-merge-blocked'
): PrConflictOutcome {
  const { exec, cwd } = deps;
  const now = deps.now();
  const batch = findBatch(state, batchId);
  if (!batch) throw new Error(`Batch not found: ${batchId}`);
  if (batch.status !== 'awaiting-merge') {
    throw new Error(
      `Batch ${batchId} is ${batch.status} — the conflict path begins from awaiting-merge`
    );
  }
  if (!safeRef(batch.base_branch)) {
    return { kind: 'error', state, detail: `unsafe base branch ref: ${batch.base_branch}` };
  }

  // awaiting-merge only declares rebasing/merged — route through rebasing
  // before any dissolve (the typed rails force it).
  let next = transitionBatch(state, batchId, 'rebasing', {}, now);

  if (batch.rebase_attempts >= MAX_REBASE_ATTEMPTS) {
    const dissolution = dissolveBatch(deps, next, batchId, `${conflict}-2nd-occurrence`, 'halved');
    return { kind: 'dissolved', state: dissolution.state, dissolution };
  }

  next = {
    ...next,
    batches: next.batches.map((b) =>
      b.id === batchId ? { ...b, rebase_attempts: b.rebase_attempts + 1 } : b
    ),
  };

  const fetched = exec('git', ['fetch', 'origin', batch.base_branch, '--'], cwd);
  if (fetched === null) {
    return { kind: 'error', state: next, detail: 'git fetch origin <base> failed' };
  }
  const rebased = exec('git', ['rebase', `origin/${batch.base_branch}`, '--'], cwd);
  if (rebased === null) {
    exec('git', ['rebase', '--abort'], cwd);
    const dissolution = dissolveBatch(deps, next, batchId, 'rebase-conflict', 'halved');
    return { kind: 'dissolved', state: dissolution.state, dissolution };
  }

  if (batch.branch === null || !safeRef(batch.branch)) {
    return {
      kind: 'error',
      state: next,
      detail: `batch branch missing/unsafe: ${String(batch.branch)}`,
    };
  }
  const pushed = exec('git', ['push', '--force-with-lease', 'origin', batch.branch, '--'], cwd);
  if (pushed === null) {
    return {
      kind: 'error',
      state: next,
      detail: 'force-with-lease push of the rebased branch failed',
    };
  }

  deps.journal.append(unitEvent('batch-rebased', `batch:${batchId}`, { detail: conflict }), now);

  next = transitionBatch(next, batchId, 're-validating', {}, now);
  const suite = deps.runSuite();
  if (!suite.ok) {
    const dissolution = dissolveBatch(deps, next, batchId, 'revalidate-failed', 'halved');
    return { kind: 'dissolved', state: dissolution.state, dissolution };
  }
  next = transitionBatch(next, batchId, 'shipping', {}, now);
  return { kind: 'rebased', state: next, suite };
}

// --- Milestone poster (AC5) ---

/**
 * Exec-based batch milestone poster: shells `ai-dossier runstate post` on
 * the anchor issue. Posting is degradation, never a crash — a failed post
 * warns on stderr and the recovery continues (the journal keeps the record).
 * Batches without an anchor cannot post; that warns too.
 */
export function createExecBatchPoster(
  exec: ExecFn,
  cwd: string
): (batch: BatchEntry, milestone: BatchMilestone) => void {
  return (batch, milestone) => {
    if (batch.anchor === null) {
      process.stderr.write(
        `⚠ sched recovery: batch ${batch.id} has no anchor — milestone (${milestone.phase} ${milestone.status} ${milestone.reason}) not posted\n`
      );
      return;
    }
    const args = [
      'runstate',
      'post',
      '--issue',
      String(batch.anchor),
      '--phase',
      milestone.phase,
      '--status',
      milestone.status,
      '--kv',
      `reason=${sanitizeValue(milestone.reason)}`,
    ];
    if (batch.run_id !== null) {
      args.push('--run', batch.run_id);
    }
    for (const [key, value] of Object.entries(milestone.kv ?? {})) {
      args.push('--kv', `${key}=${sanitizeValue(value)}`);
    }
    const out = exec('ai-dossier', args, cwd);
    if (out === null) {
      process.stderr.write(
        `⚠ sched recovery: milestone post failed for batch ${batch.id} (${milestone.phase} ${milestone.status} ${milestone.reason})\n`
      );
    }
  };
}
