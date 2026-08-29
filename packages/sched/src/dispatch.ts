/**
 * Agent dispatch machinery (#464, AC1 — "a runnable queue unit is dispatched
 * as a spawned agent process … with `--model` per its tier; pid + phase +
 * last-progress timestamp tracked in state.json"; RFC-0001 §C.1 "spawns agent
 * processes via the existing `run` machinery").
 *
 * The command is a template (default `claude -p --output-format json --model
 * {model}` — the same headless invocation `ai-dossier run` builds in
 * cli/src/helpers.ts) with `{model}`/`{issue}` placeholders; the prompt
 * travels on stdin exactly like the run machinery's headless path. Children
 * spawn DETACHED and unref'd: an agent must survive a sched crash (RFC F.10 —
 * restart reconciles by pid, it never owns the agent's lifetime).
 *
 * All process I/O is injectable (`SpawnDeps`) so tests spawn fake agents, and
 * the package itself never invokes an LLM — it spawns a process the operator
 * configured.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sanitizeSlug } from './project';
import {
  DEFAULT_PR_POLL_INTERVAL_MS,
  DEFAULT_RECONCILE_INTERVAL_MS,
  DEFAULT_STALL_TIMEOUT_MS,
  type DispatchConfig,
  type ModelTier,
  type SchedConfig,
  TIER_LADDER,
  TIER_ORDER,
} from './types';

/** Default tier → model mapping (claude aliases; override in config.json). */
export const DEFAULT_TIER_MODELS: Readonly<Record<ModelTier, string>> = {
  mechanical: 'haiku',
  mid: 'sonnet',
  strong: 'opus',
};

/** Default headless agent command template (claude, the run machinery's first choice). */
export const DEFAULT_DISPATCH_COMMAND: readonly string[] = [
  'claude',
  '-p',
  '--output-format',
  'json',
  '--model',
  '{model}',
];

/** opencode equivalent (the run machinery's second agent, #459). */
export const OPENCODE_DISPATCH_COMMAND: readonly string[] = [
  'opencode',
  'run',
  '--format',
  'json',
  '--model',
  '{model}',
];

/**
 * Default prompt sent on the child's stdin. Detached ship mode (#468): the
 * agent parks the PR on `auto-merge` and STOPS — the scheduler's PR watcher
 * owns the merge wait and dispatches teardown + report as tail work. The
 * fleet pattern of re-dispatching a full-cycle run for the tail is retired.
 * Operators wanting attached runs (agent drives to the final report itself)
 * override `dispatch.prompt` in config.json.
 */
export const DEFAULT_PROMPT_TEMPLATE =
  'Run the full-cycle-issue workflow for GitHub issue #{issue} in this repository.\n\n' +
  'Begin by fetching the workflow: ai-dossier run imboard-ai/git/full-cycle-issue --pull\n\n' +
  'Then execute it for issue #{issue} in detached ship mode (ship_mode=detached), following every ' +
  'phase (gate, setup, plan, implement, review) without asking questions, until Phase 5 parks the ' +
  'PR: apply the auto-merge label, post the awaiting-merge milestone, and STOP. Do not wait for ' +
  'the merge, do not run teardown or report — the scheduler watches the PR and dispatches those.';

/**
 * Default prompt for the report agent dispatched after a merged PR (#468
 * AC2) — a cheap-tier run of the report phase only, never a full cycle.
 */
export const DEFAULT_REPORT_PROMPT_TEMPLATE =
  'Run the report phase for GitHub issue #{issue} in this repository.\n\n' +
  'Begin by fetching the workflow: ai-dossier run imboard-ai/git/report-issue --pull\n\n' +
  'The work is DONE: pull request #{pr} is merged (merge commit via `gh pr view {pr}`), the issue ' +
  'is closed, and the worktree is already torn down (cleanup status: {cleanup}). Do not ' +
  're-implement, re-review, or re-ship anything — produce the final report for issue #{issue} and ' +
  'post its runstate milestone.';

/**
 * Default prompt for the ONE bounded fix attempt a batch member gets before it
 * is evicted (#472 AC2). Deliberately narrow: the agent fixes the named
 * failures on the batch branch it is already on — it does not re-plan, re-scope
 * or touch other members' work, because the next step after a red re-run is
 * reverting this member's commits, not a second attempt.
 */
export const DEFAULT_FIX_PROMPT_TEMPLATE =
  'The aggregate test suite for batch {batch} is failing, and the failures were attributed to ' +
  'issue #{issue}.\n\nFailing tests:\n{tests}\n\n' +
  'You are on the batch branch with every member already committed. Fix ONLY these failures, in ' +
  "the code belonging to issue #{issue}; do not revert or modify other members' commits, do not " +
  're-plan the issue, and do not open a PR. Commit the fix on this branch with the `(#{issue})` ' +
  'subject trailer. This is the only fix attempt — if the suite is still red afterwards the ' +
  "member's commits are reverted and it is requeued as a standalone full-cycle run.";

/** Fully-resolved dispatch settings the engine runs with. */
export interface ResolvedDispatch {
  /** Command template with `{model}`/`{issue}` placeholders. */
  command: string[];
  /** Prompt template with `{issue}` placeholder. */
  prompt: string;
  /** Report-agent prompt template with `{issue}`/`{pr}`/`{cleanup}` placeholders (#468). */
  reportPrompt: string;
  /** Model per tier; null means "no model flag" (the command's `--model {model}` pair drops). */
  tierModels: Record<ModelTier, string | null>;
  stallTimeoutMs: number;
  reconcileIntervalMs: number;
  /** Parked-PR poll interval (#468 AC1, default 150 s — "every 2–3 min"). */
  prPollIntervalMs: number;
}

/** Resolve engine dispatch settings from the (possibly sparse) config. */
export function resolveDispatch(config: SchedConfig): ResolvedDispatch {
  const dispatch: DispatchConfig = config.dispatch ?? {};
  const tierModels: Record<ModelTier, string | null> = {
    mechanical: dispatch.tier_models?.mechanical ?? DEFAULT_TIER_MODELS.mechanical,
    mid: dispatch.tier_models?.mid ?? DEFAULT_TIER_MODELS.mid,
    strong: dispatch.tier_models?.strong ?? DEFAULT_TIER_MODELS.strong,
  };
  return {
    command: dispatch.command ?? [...DEFAULT_DISPATCH_COMMAND],
    prompt: dispatch.prompt ?? DEFAULT_PROMPT_TEMPLATE,
    reportPrompt: dispatch.report_prompt ?? DEFAULT_REPORT_PROMPT_TEMPLATE,
    tierModels,
    stallTimeoutMs: config.stall_timeout_ms ?? DEFAULT_STALL_TIMEOUT_MS,
    reconcileIntervalMs: config.reconcile_interval_ms ?? DEFAULT_RECONCILE_INTERVAL_MS,
    prPollIntervalMs: config.pr_poll_interval_ms ?? DEFAULT_PR_POLL_INTERVAL_MS,
  };
}

/**
 * Build the concrete agent argv for one dispatch: substitute `{issue}` and
 * `{model}`. When the tier's model is null, the `{model}` item AND its
 * immediately-preceding flag (e.g. `--model`) drop together — a command never
 * carries a flag whose value is missing.
 */
export function buildAgentCommand(
  template: readonly string[],
  tier: ModelTier,
  issue: number,
  tierModels: Readonly<Record<ModelTier, string | null>>
): string[] {
  const model = tierModels[tier] ?? null;
  const argv: string[] = [];
  for (const item of template) {
    if (item === '{model}') {
      if (model === null) {
        // Drop the preceding flag along with the placeholder.
        if (argv.length > 0 && argv[argv.length - 1].startsWith('--')) argv.pop();
        continue;
      }
      argv.push(model);
      continue;
    }
    argv.push(item.replaceAll('{issue}', String(issue)));
  }
  return argv;
}

/** Build the child's stdin prompt for one dispatch. */
export function buildPrompt(template: string, issue: number): string {
  return template.replaceAll('{issue}', String(issue));
}

/** Build the report agent's stdin prompt (#468): `{issue}`/`{pr}`/`{cleanup}` substituted. */
export function buildReportPrompt(
  template: string,
  issue: number,
  pr: number,
  cleanup: string
): string {
  return template
    .replaceAll('{issue}', String(issue))
    .replaceAll('{pr}', String(pr))
    .replaceAll('{cleanup}', cleanup);
}

/**
 * Build the fix agent's stdin prompt (#472): `{issue}`, `{batch}` and the
 * failing-test list substituted. Tests are rendered one per line so the agent
 * gets the exact ids the suite reported, not a summary.
 */
export function buildFixPrompt(
  template: string,
  issue: number,
  batch: string,
  tests: readonly string[]
): string {
  return template
    .replaceAll('{issue}', String(issue))
    .replaceAll('{batch}', batch)
    .replaceAll(
      '{tests}',
      tests.length > 0 ? tests.map((t) => `- ${t}`).join('\n') : '- (none reported)'
    );
}

/** One tier stronger on the ladder, or null at the top (RFC-0001 §C.1). */
export function escalateTier(tier: ModelTier): ModelTier | null {
  return TIER_LADDER[tier];
}

/**
 * The tier for a report-agent (re)dispatch after `recoveries` escalations
 * (#468): reports start cheap (mechanical) and climb the same ladder —
 * mechanical → mid → strong — with null past the top. The engine's
 * `ESCALATION_CAP` check fails the unit before that null is reached.
 */
export function reportTierFor(recoveries: number): ModelTier | null {
  return TIER_ORDER[recoveries] ?? null;
}

// --- Process I/O (injectable) ---

export interface SpawnDeps {
  /**
   * Spawn a detached agent process and return its pid. `logFile` receives the
   * child's combined stdout/stderr (agents outlive sched, so their output
   * cannot stay in this process's pipes). Throws synchronously when the
   * process cannot be spawned (missing binary, unwritable log dir).
   */
  spawn(cmd: string[], prompt: string, logFile: string): number;
  /**
   * Signal a pid; returns false when it was already dead (or not ours).
   * `expectedStart` (the persisted `/proc` start-time) enables the pid-reuse
   * guard: a pid whose start-time no longer matches was reused by an
   * unrelated process and is never signalled.
   */
  kill(pid: number, expectedStart?: number): boolean;
  /**
   * Whether a pid is alive (best-effort). `expectedStart` applies the same
   * pid-reuse guard as `kill`.
   */
  isAlive(pid: number, expectedStart?: number): boolean;
  /**
   * `/proc/<pid>/stat` start-time (field 22) of a pid, when the platform
   * exposes it (Linux); null elsewhere. The engine persists this at spawn so
   * pid identity survives engine restarts (decision 1, option C).
   */
  processStart(pid: number): number | null;
}

/** `issue:464` → `issue-464` (filesystem-safe unit ids for log file names). */
export function unitLogName(unit: string): string {
  return sanitizeSlug(unit);
}

/** Poll cadence bounds for `sleep`'s stop-check interval (engine loop). */
export const STOP_POLL_MIN_MS = 100;
export const STOP_POLL_MAX_MS = 1000;

/**
 * `/proc/<pid>/stat` start-time (field 22, clock ticks since boot) — stable
 * process identity for the lifetime of the pid, so a recycled pid is
 * detectable. Null when /proc is unavailable (macOS/Windows) or the process
 * is gone.
 */
export function procStartTime(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    // comm (field 2) is parenthesized and may contain spaces — everything
    // after the LAST ')' is fields 3..N, space-separated.
    const close = stat.lastIndexOf(')');
    if (close === -1) return null;
    const fields = stat.slice(close + 2).split(' ');
    // field 22 (starttime) -> index 19 in the post-comm array (field 3 = index 0)
    const start = Number.parseInt(fields[19] ?? '', 10);
    return Number.isInteger(start) && start >= 0 ? start : null;
  } catch {
    return null;
  }
}

/**
 * Real process I/O: detached spawn with output to a log file, unref'd.
 *
 * Pid-reuse guard (decision 1, option C — hybrid): every pid this instance
 * spawns is recorded with its `/proc` start-time; `kill`/`isAlive` accept the
 * start-time persisted in state.json and refuse a pid whose current
 * start-time no longer matches (it was reused by an unrelated process — the
 * agent we spawned is already dead, so skipping the signal loses nothing).
 * On platforms without /proc the guard degrades to best-effort, and pids
 * without a recorded start-time (e.g. from pre-decision state files) stay
 * best-effort everywhere.
 */
export function createSpawnDeps(cwd?: string): SpawnDeps {
  /** Pids spawned by THIS instance -> their /proc start-time (Linux). */
  const spawnedStarts = new Map<number, number>();

  /** True when `pid` plausibly still names the process we recorded. */
  function matchesRecordedStart(pid: number, expectedStart: number | undefined): boolean {
    const expected = expectedStart ?? spawnedStarts.get(pid);
    if (expected === undefined) return true; // no recorded identity — best-effort
    const current = procStartTime(pid);
    if (current === null) return true; // /proc unavailable (non-Linux) or a race — best-effort
    return current === expected;
  }

  return {
    spawn(cmd: string[], prompt: string, logFile: string): number {
      fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
      const out = fs.openSync(logFile, 'a', 0o600);
      try {
        const child = spawn(cmd[0], cmd.slice(1), {
          ...(cwd ? { cwd } : {}),
          detached: true,
          stdio: ['pipe', out, out],
        });
        // Spawn failures surface synchronously via the pid check below; the
        // async 'error' event must never crash the engine (ENOENT), and an
        // agent exiting before reading stdin must never crash it either (EPIPE).
        child.on('error', (err) => {
          process.stderr.write(`⚠ sched: spawn '${cmd[0]}' failed: ${err.message}\n`);
        });
        if (child.stdin !== null) {
          child.stdin.on('error', () => {});
          child.stdin.write(prompt);
          child.stdin.end();
        }
        child.unref();
        if (child.pid === undefined) {
          throw new Error(
            `failed to spawn '${cmd[0]}' — is it on PATH? (command: ${cmd.join(' ')})`
          );
        }
        const start = procStartTime(child.pid);
        if (start !== null) spawnedStarts.set(child.pid, start);
        return child.pid;
      } finally {
        // The child holds its own dups of the fd; the parent's copy must close.
        fs.closeSync(out);
      }
    },
    kill(pid: number, expectedStart?: number): boolean {
      if (!matchesRecordedStart(pid, expectedStart)) {
        spawnedStarts.delete(pid);
        return false; // reused pid — the agent we spawned is already gone
      }
      try {
        process.kill(pid, 'SIGTERM');
        return true;
      } catch {
        spawnedStarts.delete(pid);
        return false;
      }
    },
    isAlive(pid: number, expectedStart?: number): boolean {
      try {
        process.kill(pid, 0);
        return matchesRecordedStart(pid, expectedStart);
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    processStart(pid: number): number | null {
      return procStartTime(pid);
    },
  };
}
