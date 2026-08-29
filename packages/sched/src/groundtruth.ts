/**
 * Ground truth for completion verification (#464, AC2 — "an agent exiting is
 * never proof of completion"). The engine never trusts the spawned agent's own
 * exit; it reconciles the claimed state against the durable sources — the
 * issue's runstate milestone trail (`ai-dossier runstate last`) and GitHub
 * itself (`gh issue view`), plus `git ls-remote` for the "new pushed commit"
 * stall signal.
 *
 * Everything is injectable (the `ExecFn` pattern from project.ts): tests —
 * and any consumer — supply fake ground truth and no subprocess runs.
 */

import { execFileSync } from 'node:child_process';
import type { ExecFn } from './project';

/** The latest runstate milestone on an issue, as `runstate last --json` reports it. */
export interface GroundTruthMilestone {
  phase: string;
  status: string;
  run: string;
  at: string;
  /** Every `key=value` line of the milestone, including the header's. */
  keys: Record<string, string>;
}

export interface GroundTruth {
  /** Latest runstate milestone on the issue, or null when the issue has none. */
  latestMilestone(issue: number): GroundTruthMilestone | null;
  /** Whether the GitHub issue is CLOSED (a merged PR auto-closes it). */
  issueClosed(issue: number): boolean;
  /** Current head sha of `branch` on origin, or null when unknown/absent. */
  branchHead(branch: string): string | null;
}

/** Subprocess timeout: a hung gh/git call must not wedge a tick under the state lock. */
const GROUND_TRUTH_TIMEOUT_MS = 30_000;

/**
 * Default exec for ground-truth calls: like project.ts's `defaultExec` (never
 * throws) but with a hard timeout so a hung `gh`/`git` cannot hold the
 * scheduler's state lock indefinitely.
 */
export const groundTruthExec: ExecFn = (file, args, cwd) => {
  try {
    return String(
      execFileSync(file, args, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: GROUND_TRUTH_TIMEOUT_MS,
        ...(cwd ? { cwd } : {}),
      })
    ).trim();
  } catch {
    return null;
  }
};

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
 *
 * `repoDir` is the cwd for git; gh resolves the repo from cwd by default.
 * Every failure degrades to null/false — ground truth being unreachable must
 * pause a decision (treated as "unknown"), never crash the tick.
 */
export function createExecGroundTruth(
  exec: ExecFn = groundTruthExec,
  opts: { repoDir?: string; runstateBin?: string } = {}
): GroundTruth {
  const runstateBin = opts.runstateBin ?? 'ai-dossier';
  return {
    latestMilestone(issue: number): GroundTruthMilestone | null {
      return parseMilestoneJson(
        exec(runstateBin, ['runstate', 'last', '--issue', String(issue), '--json'], opts.repoDir)
      );
    },
    issueClosed(issue: number): boolean {
      return (
        exec('gh', ['issue', 'view', String(issue), '--json', 'state', '--jq', '.state']) ===
        'CLOSED'
      );
    },
    branchHead(branch: string): string | null {
      const out = exec('git', ['ls-remote', 'origin', branch], opts.repoDir);
      if (out === null || out === '') return null;
      const sha = out.split('\t')[0]?.trim();
      return sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
    },
  };
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
