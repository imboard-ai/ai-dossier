/**
 * Ground truth for completion verification (#464, AC2 — "an agent exiting is
 * never proof of completion"). The engine never trusts the spawned agent's own
 * exit; it reconciles the claimed state against the durable sources — the
 * issue's runstate milestone trail (`ai-dossier runstate last`), GitHub
 * itself (`gh issue view`), and `git ls-remote` for the "new pushed commit"
 * stall signal. #468 adds the parked-PR state (`gh pr view`) and the setup
 * milestone's teardown keys (`gh issue view --json comments`).
 *
 * Everything is injectable (the `ExecFn` pattern from project.ts): tests —
 * and any consumer — supply fake ground truth and no subprocess runs.
 */

import { unwrapList } from './json';
import { createExecFn, type ExecFn } from './project';
import type { BatchPhase } from './types';

/** The latest runstate milestone on an issue, as `runstate last --json` reports it. */
export interface GroundTruthMilestone {
  phase: string;
  status: string;
  run: string;
  at: string;
  /** Every `key=value` line of the milestone, including the header's. */
  keys: Record<string, string>;
}

/**
 * A parked PR's GitHub state (#468 AC1) — the exact fields the watcher
 * decides on, from `gh pr view --json state,mergedAt,mergeable,labels`.
 */
export interface PrTruth {
  /** GitHub PR state: OPEN | MERGED | CLOSED. */
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  /** Set only for a genuinely merged PR (never inferred from state alone). */
  mergedAt: string | null;
  /** Mergeability as GitHub reports it; UNKNOWN while it is still computing. */
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
  /** True when the PR carries the `auto-merge-blocked` label (the watcher's block signal). */
  blocked: boolean;
}

/** Teardown inputs recovered from a run's `setup` milestone (#468 AC2). */
export interface SetupInfo {
  /** Absolute worktree path (`worktree=` key of the setup milestone). */
  worktree: string;
  /** Whether the worktree was claimed from the pool (`pool_claimed=true`). */
  poolClaimed: boolean;
  /**
   * The unit's working branch (`branch=` key), when the milestone carried it.
   * Currently unused by `runTeardown` — recovered for operator/debugging
   * value and future pool operations (e.g. branch pruning).
   */
  branch: string | null;
}

export interface GroundTruth {
  /**
   * Latest runstate milestone on the issue. **Tri-state (decision 2, option
   * A):** an object = the milestone; `null` = the issue verifiably has NO
   * milestone (known-absent); `undefined` = the poll FAILED (unreachable —
   * gh auth expired, `ai-dossier` missing, network down). Callers must PAUSE
   * decisions that need truth (stall, verify-fail) while unreachable, never
   * treat it as "no progress".
   */
  latestMilestone(issue: number): GroundTruthMilestone | null | undefined;
  /**
   * Whether the GitHub issue is CLOSED (a merged PR auto-closes it). False
   * when unreachable — an unreachable poll can never *confirm* completion,
   * which is the only direction this signal is used in.
   */
  issueClosed(issue: number): boolean;
  /** Current head sha of `branch` on origin, or null when unknown/absent/unreachable. */
  branchHead(branch: string): string | null;
  /**
   * A parked PR's GitHub state (#468). Same tri-state: `undefined` = poll
   * FAILED (unreachable — watcher decisions pause); an object = the truth.
   */
  prState(pr: number): PrTruth | undefined;
  /**
   * Teardown inputs from the issue's `setup` milestone (#468): `null` = the
   * issue verifiably has no setup milestone; `undefined` = poll FAILED.
   */
  setupInfo(issue: number): SetupInfo | null | undefined;
  /**
   * The issue's current GitHub label names (#544) — what the engine's
   * per-tick hard-block re-check screens. Same tri-state as the polls above:
   * an array = the labels (`[]` = verifiably no labels); `undefined` = the
   * poll FAILED (unreachable). The distinction is load-bearing here, not
   * cosmetic: `[]` unblocks a `label:`-blocked unit, so a failed read must
   * never be flattened into it — that would dispatch an agent straight over
   * a live human hand-off whenever gh is down.
   */
  issueLabels(issue: number): string[] | undefined;
}

/** Subprocess timeout: a hung gh/git call must not stall a tick. */
const GROUND_TRUTH_TIMEOUT_MS = 30_000;

/**
 * Default exec for ground-truth calls: like project.ts's `defaultExec` (never
 * throws) but with a hard timeout so a hung `gh`/`git` cannot stall a tick
 * indefinitely (ground truth is polled outside the state lock), and a failure
 * observer that warns on stderr — a broken ground-truth environment (gh auth
 * expired, `ai-dossier` missing from a cron PATH) is never silent.
 */
export const groundTruthExec: ExecFn = createExecFn(GROUND_TRUTH_TIMEOUT_MS, {
  onError: (file, args, err) =>
    process.stderr.write(
      `⚠ sched ground truth: '${file} ${args.join(' ')}' failed: ${err.message}\n`
    ),
});

/** Parse the stdout of `ai-dossier runstate last --issue N --json`. */
export function parseMilestoneJson(stdout: string | null): GroundTruthMilestone | null {
  if (stdout === null || stdout.trim() === '' || stdout.trim() === 'null') return null;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed === null || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj.phase !== 'string' ||
      typeof obj.status !== 'string' ||
      typeof obj.at !== 'string'
    ) {
      return null;
    }
    const keys: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') keys[key] = value;
    }
    return {
      phase: obj.phase,
      status: obj.status,
      run: typeof obj.run === 'string' ? obj.run : '',
      at: obj.at,
      keys,
    };
  } catch {
    return null;
  }
}

/**
 * Ground truth backed by subprocess calls:
 * - `ai-dossier runstate last --issue N --json` — the milestone trail
 * - `gh issue view N --json state --jq .state` — issue closed
 * - `git ls-remote origin <branch>` — branch head
 * - `gh pr view <n> --json state,mergedAt,mergeable,labels` — parked-PR state (#468)
 * - `gh issue view N --json comments` — the setup milestone's teardown keys (#468)
 *
 * `repoDir` is the cwd for git; gh resolves the repo from cwd by default.
 * Every failure degrades safely: a failed milestone/PR poll reports UNREACHABLE
 * (undefined — decision 2, option A), a failed closed-poll reports false, a
 * failed head-poll null. Ground truth being unreachable pauses the engine's
 * stall/verify/watch decisions; it never crashes a tick.
 */
export function createExecGroundTruth(
  exec: ExecFn = groundTruthExec,
  opts: { repoDir?: string; runstateBin?: string } = {}
): GroundTruth {
  const runstateBin = opts.runstateBin ?? 'ai-dossier';
  return {
    latestMilestone(issue: number): GroundTruthMilestone | null | undefined {
      const out = exec(
        runstateBin,
        ['runstate', 'last', '--issue', String(issue), '--json'],
        opts.repoDir
      );
      if (out === null) return undefined; // subprocess failed — unreachable, NOT known-absent
      return parseMilestoneJson(out); // 'null' output → null (verifiably no milestone)
    },
    issueClosed(issue: number): boolean {
      return (
        exec('gh', ['issue', 'view', String(issue), '--json', 'state', '--jq', '.state']) ===
        'CLOSED'
      );
    },
    branchHead(branch: string): string | null {
      // The branch string originates from milestone output written by the
      // spawned agent — validate it as a ref name and end git's option
      // parsing with `--` so a crafted "branch" (e.g. `--upload-pack=…`)
      // can never become a git option (CWE-88). A rejected ref degrades to
      // null head: the pushed-commit progress signal just doesn't fire.
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) return null;
      const out = exec('git', ['ls-remote', 'origin', '--', branch], opts.repoDir);
      if (out === null || out === '') return null;
      const sha = out.split('\t')[0]?.trim();
      return sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
    },
    prState(pr: number): PrTruth | undefined {
      const out = exec(
        'gh',
        ['pr', 'view', String(pr), '--json', 'state,mergedAt,mergeable,labels'],
        opts.repoDir
      );
      if (out === null) return undefined; // poll failed — unreachable
      return parsePrViewJson(out) ?? undefined;
    },
    setupInfo(issue: number): SetupInfo | null | undefined {
      const out = exec('gh', ['issue', 'view', String(issue), '--json', 'comments'], opts.repoDir);
      if (out === null) return undefined; // poll failed — unreachable
      return parseSetupInfo(out);
    },
    issueLabels(issue: number): string[] | undefined {
      const out = exec('gh', ['issue', 'view', String(issue), '--json', 'labels'], opts.repoDir);
      if (out === null) return undefined; // poll failed — unreachable
      return parseIssueLabelsJson(out);
    },
  };
}

/**
 * Parse the stdout of `gh issue view --json labels` into label names (#544).
 * Returns `undefined` — unreachable, NOT "no labels" — when the payload is
 * unusable (empty, not JSON, or missing the `labels` array): gh exiting 0
 * with a non-JSON body (an older gh, an interactive prompt on stdout) is a
 * failed read wearing a success exit code, and treating it as an empty label
 * set would unblock a `label:`-blocked unit on garbage.
 */
export function parseIssueLabelsJson(stdout: string | null): string[] | undefined {
  if (stdout === null || stdout.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  // Same `{ "<key>": [...] }` unwrap `parseSetupInfo` uses for `--json comments`
  // — one helper for one gh output shape, defensively accepting a bare array too.
  const labels = unwrapList(parsed, 'labels');
  if (labels === null) return undefined;
  return labelNames(labels);
}

/**
 * Extract label names from a gh `--json labels` array (`[{name: "..."}]`),
 * as loosely-typed `unknown` since it is remote data. Non-string/missing
 * `name` fields are dropped rather than throwing — a malformed entry must
 * not hide the labels that DID parse (#507).
 */
export function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((label) =>
      label !== null && typeof label === 'object' ? (label as { name?: unknown }).name : undefined
    )
    .filter((name): name is string => typeof name === 'string');
}

/** Parse the stdout of `gh pr view --json state,mergedAt,mergeable,labels`. */
export function parsePrViewJson(stdout: string | null): PrTruth | null {
  if (stdout === null || stdout.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed === null || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.state !== 'string') return null;
    const state = obj.state.toUpperCase();
    if (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED') return null;
    const mergedAt = typeof obj.mergedAt === 'string' && obj.mergedAt !== '' ? obj.mergedAt : null;
    const mergeableRaw = typeof obj.mergeable === 'string' ? obj.mergeable.toUpperCase() : null;
    const mergeable =
      mergeableRaw === 'MERGEABLE' || mergeableRaw === 'CONFLICTING' || mergeableRaw === 'UNKNOWN'
        ? mergeableRaw
        : null;
    const blocked = labelNames(obj.labels).includes('auto-merge-blocked');
    return { state, mergedAt, mergeable, blocked };
  } catch {
    return null;
  }
}

/**
 * Parse the stdout of `gh issue view --json comments` and recover the teardown
 * inputs from the run's `setup done` milestone comment (#468). Milestone
 * comments carry a `<!-- runstate:v1 -->` marker followed by `key=value`
 * lines; the setup milestone is the one whose header starts `phase=setup`.
 * Comments from non-collaborators (authorAssociation outside
 * OWNER/MEMBER/COLLABORATOR) are skipped — teardown inputs feed destructive
 * scripts, so a random commenter cannot supply them. Returns null when no
 * usable setup milestone exists (verifiably).
 *
 * `gh issue view --json comments` always wraps the comment list in an object
 * — `{"comments": [...]}` — never a bare array (#496; same shape
 * `cli/src/gh.ts`'s `tryFetchComments` handles independently — keep both in
 * sync). A bare array is accepted too, defensively, in case a caller ever
 * passes the unwrapped form.
 */
export function parseSetupInfo(commentsJson: string | null): SetupInfo | null {
  if (commentsJson === null || commentsJson.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(commentsJson);
  } catch {
    return null;
  }
  const comments = unwrapList(parsed, 'comments');
  if (comments === null) return null;

  const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

  // Newest setup milestone wins (a re-run can re-post setup).
  for (const raw of [...comments].reverse()) {
    if (raw === null || typeof raw !== 'object') continue;
    const comment = raw as { body?: unknown; authorAssociation?: unknown };
    if (typeof comment.body !== 'string' || !comment.body.includes('<!-- runstate:v1 -->')) {
      continue;
    }
    if (
      comment.authorAssociation !== undefined &&
      !TRUSTED_ASSOCIATIONS.has(String(comment.authorAssociation))
    ) {
      continue; // untrusted author — never a teardown source
    }

    const keys = parseMilestoneKeys(comment.body);
    if (keys.phase !== 'setup' || keys.status !== 'done') continue;
    const worktree = keys.worktree ?? null;
    if (worktree === null || worktree.length === 0) continue;
    return {
      worktree,
      poolClaimed: keys.pool_claimed === 'true',
      branch: keys.branch ?? null,
    };
  }
  return null;
}

/**
 * `key=value` tokens of a runstate milestone comment body — the same pair
 * grammar `cli/src/runstate.ts` owns (the tolerant reader): the `phase=`
 * header line carries several space-separated pairs, other lines carry one
 * pair each split at the FIRST `=`. First occurrence of a key wins.
 */
function parseMilestoneKeys(body: string): Record<string, string> {
  const keys: Record<string, string> = {};
  const put = (token: string): void => {
    const eq = token.indexOf('=');
    if (eq <= 0) return;
    const key = token.slice(0, eq);
    if (keys[key] === undefined) keys[key] = token.slice(eq + 1);
  };
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('phase=')) {
      for (const token of trimmed.split(/\s+/)) put(token);
    } else {
      put(trimmed);
    }
  }
  return keys;
}

/** The `pr=` key of a milestone as a positive integer, or null when absent/malformed. */
export function prOfMilestone(milestone: GroundTruthMilestone | null): number | null {
  if (milestone === null) return null;
  const pr = Number.parseInt(milestone.keys.pr ?? '', 10);
  return Number.isInteger(pr) && pr > 0 ? pr : null;
}

/**
 * The detached-ship park signal (#468): the latest milestone is the ship
 * phase's `awaiting-merge` record carrying a `pr=` key. Such an exit is a
 * VERIFIED park, not an unverified exit — the watcher takes over from here.
 */
export function isParkedMilestone(
  milestone: GroundTruthMilestone | null
): milestone is GroundTruthMilestone {
  if (milestone === null) return false;
  if (milestone.phase !== 'ship' || milestone.status !== 'awaiting-merge') return false;
  return prOfMilestone(milestone) !== null;
}

/**
 * Completion rule (AC2): a unit's work is verified complete when the issue's
 * latest milestone is the final `report done` — the full-cycle trail's last
 * phase — or when GitHub itself says the issue is closed (a merged PR
 * auto-closes it, which is ground truth no milestone can contradict).
 */
export function isVerifiedComplete(
  milestone: GroundTruthMilestone | null,
  issueClosed: boolean
): boolean {
  if (issueClosed) return true;
  return milestone !== null && milestone.phase === 'report' && milestone.status === 'done';
}

/**
 * A batch member's completion signal (#523 AC1): `slot-cycle` posts no phase
 * of its own past `review` — "ship is batch-owned" — so a member's work is
 * verified complete when its latest milestone is `phase=review status=done
 * mode=slot`. `mode=slot` guards against a member issue somehow carrying an
 * unrelated `review done` from a stray full-cycle run.
 */
export function isMemberComplete(milestone: GroundTruthMilestone | null): boolean {
  return (
    milestone !== null &&
    milestone.phase === 'review' &&
    milestone.status === 'done' &&
    milestone.keys.mode === 'slot'
  );
}

/**
 * A batch member's blocked signal (#523 AC1/AC2): `slot-cycle` posts
 * `status=blocked mode=slot` at whichever phase it could not proceed past
 * (plan/implement/review) — the reason lives in the milestone's `reason=` key.
 */
export function isMemberBlocked(milestone: GroundTruthMilestone | null): boolean {
  return milestone !== null && milestone.status === 'blocked' && milestone.keys.mode === 'slot';
}

/**
 * The batch tail's park signal (#523 AC3) — the detached-ship pattern
 * generalized to batch granularity: the anchor's latest milestone is
 * `batch-ship awaiting-merge` carrying a `pr=` key. Mirrors `isParkedMilestone`.
 */
export function isBatchTailParked(
  milestone: GroundTruthMilestone | null
): milestone is GroundTruthMilestone {
  if (milestone === null) return false;
  if (milestone.phase !== 'batch-ship' || milestone.status !== 'awaiting-merge') return false;
  return prOfMilestone(milestone) !== null;
}

/** Whether the anchor's latest milestone is `<phase> done` (#523 — batch-review / batch-report). */
export function isBatchPhaseDone(
  milestone: GroundTruthMilestone | null,
  phase: BatchPhase
): boolean {
  return milestone !== null && milestone.phase === phase && milestone.status === 'done';
}
