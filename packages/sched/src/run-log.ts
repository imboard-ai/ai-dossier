/**
 * Per-dispatch `runs.jsonl` telemetry for the scheduler (#524).
 *
 * `packages/sched` spawns agents detached and never read their JSON result
 * back — `~/.dossier/runs.jsonl` had zero entries for scheduler-dispatched
 * units, so per-issue cost could not be baselined. This module closes that
 * gap: one entry per completed dispatch (a redispatch/takeover produces
 * another entry, not an update to the first — each is a distinct process
 * with its own tokens/duration), written to the SAME `runs.jsonl` `cli`'s
 * `ai-dossier run` already writes to, using the shared `RunLogEntry` schema
 * from `@ai-dossier/core`.
 *
 * Deliberately not `cli`'s `appendRunLog` (`cli/src/run-log.ts`): that
 * wrapper is gated by the CLI's `auditLog` user-config flag, a setting that
 * has no equivalent here — sched dispatch telemetry is not an optional
 * feature the way the CLI's own audit log is, and `sched` cannot depend on
 * `cli` (the dependency runs the other way). The write itself is a plain,
 * unconditional JSONL append.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type AgentRunUsage,
  parseAgentUsage,
  parseOpenCodeUsage,
  type RunLogEntry,
} from '@ai-dossier/core';

/** `~/.dossier/runs.jsonl` — the same file `cli`'s `ai-dossier run` writes to. Testable via `home`. */
export function schedRunsLogPath(home: string = os.homedir()): string {
  return path.join(home, '.dossier', 'runs.jsonl');
}

/**
 * Pick the usage parser for the dispatched agent, keyed off the command
 * template's binary — the same claude/opencode split `cli/src/helpers.ts`
 * uses for `ai-dossier run` (#459). Anything else (an operator-configured
 * command this build doesn't recognize) parses as null usage — genuinely
 * unavailable, never guessed at.
 */
export function usageParserFor(
  cmd0: string
): (stdout: string | null | undefined) => AgentRunUsage | null {
  return cmd0 === 'opencode' ? parseOpenCodeUsage : parseAgentUsage;
}

/** Everything `buildSchedRunLogEntry` needs to build one dispatch's entry. */
export interface SchedRunLogInput {
  /** Scheduler unit id, e.g. `issue:524` or `batch:b1` — the run-log correlation key. */
  unit: string;
  /** The role this dispatch ran as, for the synthetic `dossier` label — `sched:cycle` / `sched:report`. */
  role: string;
  /** Command template's binary (`cmd[0]`) — selects the usage parser. */
  cmd0: string;
  /** Full argv actually spawned (binary + args, prompt excluded — travels on stdin). */
  cmd: readonly string[];
  /** The combined stdout/stderr log file's content for this dispatch, or null if unreadable. */
  logContent: string | null;
  /** `SlotEntry.spawned_at` at the start of this dispatch, or null when unknown (pre-#524 slot). */
  spawnedAt: string | null;
  /** Completion time (engine's `now()`), used for `timestamp` and — with `spawnedAt` — `duration_ms`. */
  completedAt: Date;
  /** The tier's configured model, used when the agent's own JSON result did not report one. */
  configuredModel: string | null;
  /** Process exit/signal info, when the engine has it — usually not: see the field's own doc. */
  exitCode?: number | null;
  spawnError?: string | null;
}

/**
 * Build one `RunLogEntry` for a completed sched dispatch.
 *
 * `input_tokens`/`output_tokens`/cache tokens/cost come from `parseAgentUsage`/
 * `parseOpenCodeUsage` — `modelUsage`-sourced, never blended with a top-level
 * `usage` block (the fix for the ~43% fabricated-saving bug, #524). Null
 * when the log content is missing or does not parse as the expected agent's
 * result shape — never fabricated, and distinguishable from "no usage
 * reported" only by reading `spawned_command`/`exit_code` alongside it (this
 * function does not synthesize a separate "parse failed" flag: a null log
 * plus a normal exit is itself the signal something upstream lost the
 * output).
 *
 * `exit_code` is null for sched dispatches unless the caller supplies one:
 * children are spawned detached and unref'd (dispatch.ts) so sched can
 * survive its own restarts without owning the agent's lifetime — there is no
 * `'exit'` event to read a real exit code from. This is a known, accepted
 * gap (see the planning doc's Risk Areas for #524), not a regression this
 * function introduces.
 */
export function buildSchedRunLogEntry(input: SchedRunLogInput): RunLogEntry {
  const usage = usageParserFor(input.cmd0)(input.logContent);
  const duration_ms =
    input.spawnedAt !== null ? input.completedAt.getTime() - Date.parse(input.spawnedAt) : null;

  return {
    timestamp: input.completedAt.toISOString(),
    dossier: `sched:${input.role}`,
    resolved_version: 'n/a',
    source: 'local',
    verification: 'skipped',
    llm: input.cmd0,
    user: 'sched',
    cwd: '',
    nested: false,
    duration_ms,
    spawned_command: input.cmd.join(' '),
    model: usage?.model ?? input.configuredModel ?? null,
    exit_code: input.exitCode ?? null,
    spawn_error: input.spawnError ?? null,
    input_tokens: usage?.input_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
    cache_creation_tokens: usage?.cache_creation_tokens ?? null,
    cache_read_tokens: usage?.cache_read_tokens ?? null,
    total_cost_usd: usage?.total_cost_usd ?? null,
    unit: input.unit,
  };
}

/**
 * Append one entry to `~/.dossier/runs.jsonl`. Never throws — a telemetry
 * write must not fail the reconcile tick it runs inside; failures are the
 * caller's to journal if desired.
 */
export function appendSchedRunLog(entry: RunLogEntry, home: string = os.homedir()): void {
  try {
    const file = schedRunsLogPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // Best-effort telemetry — never crash the tick over a write failure.
  }
}

/**
 * Read a dispatch's combined stdout/stderr log file, or null when it does
 * not exist / cannot be read (never throws) — the "0 bytes" pilot symptom
 * (#524) reads as an empty string here, distinct from a missing file, so
 * callers can tell "the agent wrote nothing" from "we couldn't find the log".
 */
export function readDispatchLog(logFile: string): string | null {
  try {
    return fs.readFileSync(logFile, 'utf-8');
  } catch {
    return null;
  }
}
