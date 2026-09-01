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
 * Deliberately not `cli`'s `appendRunLog` (`cli/src/run-log.ts`): `sched`
 * cannot depend on `cli` (the dependency runs the other way). It is gated by
 * its own opt-out instead — see {@link schedTelemetryEnabled}.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentRunUsage, RunLogEntry } from '@ai-dossier/core';
import { runsLogPath, usageParserFor } from '@ai-dossier/core';
import { appendJsonl } from './journal';

export { runsLogPath as schedRunsLogPath, usageParserFor };

/**
 * Config key gating sched dispatch telemetry — read from the same
 * `~/.dossier/config.json` the CLI writes (`dossier config schedTelemetry
 * false`), but read directly here because `sched` cannot depend on `cli`.
 */
const SCHED_TELEMETRY_KEY = 'schedTelemetry';

/**
 * Whether to write sched dispatch telemetry to `runs.jsonl`. Defaults to
 * **on** — `sched stats` and the RFC-0001 cost gates exist because this data
 * was missing (#524), so an operator who never touched the setting keeps it.
 *
 * A SEPARATE key from the CLI's `auditLog` (ai-dossier#524, decision 2).
 * `auditLog` gates what `ai-dossier run` records about the user's own CLI
 * invocations; honouring it here would silently give an operator who disabled
 * it zero scheduler cost visibility, and ignoring it would just as silently
 * widen a flag whose documented scope is the audit log. Two concerns, two
 * keys, both honest: a disabled `schedTelemetry` makes `sched stats` say so
 * rather than report an empty cohort as if nothing had run.
 *
 * Unreadable or malformed config is treated as "not opted out" — telemetry is
 * the default, and a broken config file must not silently disable it.
 */
export function schedTelemetryEnabled(home?: string): boolean {
  try {
    const configFile = path.join(home ?? os.homedir(), '.dossier', 'config.json');
    const parsed: unknown = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return true;
    const value = (parsed as Record<string, unknown>)[SCHED_TELEMETRY_KEY];
    // `'false'` as well as `false`: `dossier config <key> <value>` stores the
    // raw CLI string, so an operator following the documented opt-out writes
    // the string. Accepting only the boolean made the advertised command a
    // silent no-op (#524 review). `cli` coerces at write time now too; this
    // keeps every config file already on disk working.
    return !(value === false || value === 'false');
  } catch {
    return true;
  }
}

/**
 * Most bytes of a dispatch log read back for usage parsing (#524 review).
 * The log is agent-controlled and unbounded under `stream-json`; this caps
 * what the reconcile tick holds in memory. 32 MiB is far more than any real
 * dispatch's tail needs to reach its `result` event.
 */
const MAX_DISPATCH_LOG_BYTES = 32 * 1024 * 1024;

/** `RunLogEntry.dossier` for a sched-dispatched cycle/report agent. */
function schedDossierLabel(role: string): string {
  return `sched:${role}`;
}

// Sentinel values for the CLI-shaped fields a sched dispatch has no real
// answer for (they describe DOSSIER RESOLUTION, not an agent process) —
// named here so a reader of `runs.jsonl`/`ai-dossier history` can trace
// what each one means back to this comment, rather than a bare literal.
/** `RunLogEntry.resolved_version` — sched dispatches resolve no dossier version. */
const SCHED_RESOLVED_VERSION = 'n/a';
/** `RunLogEntry.source` — closest existing enum member; no registry/cache resolution happened. */
const SCHED_SOURCE: RunLogEntry['source'] = 'local';
/** `RunLogEntry.verification` — sched dispatches a process, it does not verify a dossier. */
const SCHED_VERIFICATION: RunLogEntry['verification'] = 'skipped';
/** `RunLogEntry.user` — sched entries are machine-authored, not a human CLI invocation. */
const SCHED_USER = 'sched';

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
  /**
   * This dispatch's OWN slice of the log file — never the whole file for a
   * unit with prior dispatches. The log is per-unit and append-mode
   * (`createSpawnDeps`), so a caller must read only
   * `[log_offset_at_spawn, EOF)`, e.g. via `readDispatchLog(file, offset)` —
   * passing the whole accumulated file here would parse (or double-count)
   * a prior dispatch's output too. Null when unreadable.
   */
  logContent: string | null;
  /** `SlotEntry.spawned_at` at the start of this dispatch, or null when unknown (pre-#524 slot). */
  spawnedAt: string | null;
  /** Completion time (engine's `now()`), used for `timestamp` and — with `spawnedAt` — `duration_ms`. */
  completedAt: Date;
  /** The tier's configured model, used when the agent's own JSON result did not report one. */
  configuredModel: string | null;
  /** The scheduler's repo working directory (`EngineDeps.repoDir`) — the sched analogue of a CLI invocation's cwd. */
  cwd: string;
  /** Process exit/signal info, when the engine has it — usually not: see the field's own doc. */
  exitCode?: number | null;
  spawnError?: string | null;
}

/** Whole milliseconds between `spawnedAt` and `completedAt`, or null when unmeasurable. */
function measureDuration(spawnedAt: string | null, completedAt: Date): number | null {
  if (spawnedAt === null) return null;
  const started = Date.parse(spawnedAt);
  if (Number.isNaN(started)) return null; // malformed spawned_at — unmeasurable, not zero
  const elapsed = completedAt.getTime() - started;
  return elapsed >= 0 ? elapsed : null; // negative = clock skew, not a real duration
}

/**
 * Build one `RunLogEntry` for a completed sched dispatch.
 *
 * `input_tokens`/`output_tokens`/cache tokens/cost come from `parseAgentUsage`/
 * `parseOpenCodeUsage` (via `usageParserFor`) — `modelUsage`-sourced, never
 * blended with a top-level `usage` block (the fix for the ~43% fabricated-
 * saving bug, #524). Null when `logContent` is missing or does not parse as
 * the expected agent's result shape — never fabricated, and distinguishable
 * from "no usage reported" only by reading `spawned_command`/`exit_code`
 * alongside it (this function does not synthesize a separate "parse failed"
 * flag: a null log plus a normal exit is itself the signal something
 * upstream lost the output).
 *
 * `exit_code` is null for sched dispatches unless the caller supplies one:
 * children are spawned detached and unref'd (dispatch.ts) so sched can
 * survive its own restarts without owning the agent's lifetime — there is no
 * `'exit'` event to read a real exit code from. This is a known, accepted
 * gap, not a regression this function introduces.
 */
export function buildSchedRunLogEntry(input: SchedRunLogInput): RunLogEntry {
  const usage: AgentRunUsage | null = usageParserFor(input.cmd0)(input.logContent);
  const duration_ms = measureDuration(input.spawnedAt, input.completedAt);

  return {
    timestamp: input.completedAt.toISOString(),
    dossier: schedDossierLabel(input.role),
    resolved_version: SCHED_RESOLVED_VERSION,
    source: SCHED_SOURCE,
    verification: SCHED_VERIFICATION,
    llm: input.cmd0,
    user: SCHED_USER,
    cwd: input.cwd,
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
 * write must not fail the reconcile tick it runs inside. Returns `false` on
 * failure so the caller can journal it (`recordDispatchRunLog` does) rather
 * than the write vanishing with zero operator-visible signal.
 *
 * A no-op returning `true` when {@link schedTelemetryEnabled} is false: the
 * operator opted out, so writing nothing is the SUCCESSFUL outcome, not a
 * failure for the caller to journal as a lost entry.
 */
export function appendSchedRunLog(
  entry: RunLogEntry,
  home?: string,
  onError?: (err: Error) => void
): boolean {
  if (!schedTelemetryEnabled(home)) return true;
  return appendJsonl(runsLogPath(home), entry, onError);
}

/**
 * Read a dispatch's log file, or null when it does not exist / cannot be
 * read (never throws) — the "0 bytes" pilot symptom (#524) reads as an
 * empty string here, distinct from a missing file, so callers can tell "the
 * agent wrote nothing" from "we couldn't find the log".
 *
 * `offset` (#524) returns only bytes from that position onward — the log is
 * per-unit and append-mode, so a redispatched unit's file holds every prior
 * dispatch's output too; passing `slot.log_offset_at_spawn` here isolates
 * just the dispatch currently being recorded. Default 0 preserves "read the
 * whole file" for a unit's first dispatch (offset unknown / not yet spawned
 * under this scheme).
 */
export function readDispatchLog(logFile: string, offset = 0): string | null {
  let fd: number | null = null;
  try {
    const size = fs.statSync(logFile).size;
    // Bounded read (#524 review). A `stream-json` dispatch's log grows with
    // every turn and tool result, and its size is controlled entirely by the
    // spawned agent — reading it whole inside the reconcile tick would hold
    // several times the file size resident and can OOM the long-lived
    // scheduler. Read at most the last MAX_DISPATCH_LOG_BYTES: the final
    // `result` event lives at the tail, so the primary path is unaffected and
    // only the per-turn fallback degrades to a partial sum.
    const start = Math.max(offset, size - MAX_DISPATCH_LOG_BYTES);
    const length = size - start;
    if (length <= 0) return '';

    // Byte offsets, not UTF-16 string indices: `offset` comes from
    // `fs.statSync().size`, and a string index would misalign against any
    // multi-byte UTF-8 content written before it.
    const buffer = Buffer.allocUnsafe(length);
    fd = fs.openSync(logFile, 'r');
    const read = fs.readSync(fd, buffer, 0, length, start);
    const text = buffer.subarray(0, read).toString('utf-8');

    // When the window skipped past `offset`, its first line is almost
    // certainly a partial one — drop it rather than feeding a truncated
    // record to a parser.
    if (start > offset) {
      const firstBreak = text.indexOf('\n');
      return firstBreak === -1 ? '' : text.slice(firstBreak + 1);
    }
    return text;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed / invalid fd — nothing left to release.
      }
    }
  }
}
