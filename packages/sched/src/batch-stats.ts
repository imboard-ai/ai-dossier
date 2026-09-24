/**
 * Reconstruct a batch's per-member (and tail/report/fix) dispatch costs
 * directly from the raw per-unit logs on disk (#564) — `batch-dispatch.ts`
 * spawns members/tail/report/fix agents directly (`deps.spawnDeps.spawn()`),
 * bypassing `engine.ts`'s per-issue `recordDispatchRunLog`, so a batch run
 * that predates `recordMemberRunLog` (#564's write-side fix) has raw
 * dispatch logs on disk but zero `runs.jsonl` coverage. This module recovers
 * exactly what a human previously had to hand-parse
 * (`docs/reports/batch-pilot-2-execution.md` §13): read each log directly
 * and build the same `RunLogEntry` shape `buildSchedRunLogEntry` produces
 * for a live dispatch.
 *
 * Works identically for a live batch or one whose `SchedState` record is
 * long gone (post-teardown) — membership comes from filenames already on
 * disk, never from state.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isOpenCodeUsageStream, type RunLogEntry, SCHED_DISPATCH_EVENT } from '@ai-dossier/core';
import {
  batchFixLogPath,
  batchMemberLogPath,
  batchReportLogPath,
  batchTailLogPath,
} from './dispatch';
import { buildSchedRunLogEntry, readDispatchLog } from './run-log';

/** One raw dispatch log discovered for a batch, parsed from its filename. */
export type BatchLogEntry =
  | { role: 'member'; member: number; issue: number; file: string }
  | { role: 'tail'; file: string }
  | { role: 'report'; file: string }
  | { role: 'fix'; offender: number; file: string };

/** Loosely extracts the numbers from a member/fix filename shape — verified below by rebuilding the exact path from the same builder `batch-dispatch.ts` used to construct it. */
const MEMBER_RE = /-m(\d+)-(\d+)\.log$/;
const FIX_RE = /-fix-(\d+)\.log$/;

/**
 * Every raw dispatch log on disk for `batchId`, parsed from the filename
 * convention `batch-dispatch.ts`'s spawn functions already use
 * (`spawnMember`, `spawnTailAgent`, `spawnReportAgent`, `reconcileFixSlot`).
 * Every match is verified by REBUILDING the exact path via the same
 * `batchMemberLogPath`/`batchTailLogPath`/`batchReportLogPath`/
 * `batchFixLogPath` builders those spawn functions call to construct it
 * (`./dispatch`) — construction and parsing can never silently diverge,
 * because parsing IS construction run in reverse (#564 review).
 *
 * Never throws — an unreadable runs directory yields an empty list. `ENOENT`
 * degrades silently (a directory that never existed legitimately has no
 * logs); any OTHER error (permissions, a bad mount) warns to stderr instead
 * of looking identical to "this batch simply never ran" — mirrors
 * `dispatch.ts`'s `fileSizeOrZero` (#524 review), the same class of gap.
 */
export function listBatchDispatchLogs(runsDir: string, batchId: string): BatchLogEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(runsDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      process.stderr.write(
        `⚠ sched: could not read runs directory ${runsDir} (${code}); batch '${batchId}' stats will be incomplete\n`
      );
    }
    return [];
  }

  const tailFile = batchTailLogPath(runsDir, batchId);
  const reportFile = batchReportLogPath(runsDir, batchId);

  const entries: BatchLogEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.log')) continue;
    const file = path.join(runsDir, name);
    if (file === tailFile) {
      entries.push({ role: 'tail', file });
      continue;
    }
    if (file === reportFile) {
      entries.push({ role: 'report', file });
      continue;
    }
    const fixMatch = name.match(FIX_RE);
    if (fixMatch) {
      const offender = Number.parseInt(fixMatch[1], 10);
      if (batchFixLogPath(runsDir, batchId, offender) === file) {
        entries.push({ role: 'fix', offender, file });
        continue;
      }
    }
    const memberMatch = name.match(MEMBER_RE);
    if (memberMatch) {
      const member = Number.parseInt(memberMatch[1], 10);
      const issue = Number.parseInt(memberMatch[2], 10);
      if (batchMemberLogPath(runsDir, batchId, member, issue) === file) {
        entries.push({ role: 'member', member, issue, file });
      }
    }
  }
  return entries;
}

/**
 * The argv of one `{"type":"sched-dispatch","cmd":[...]}` preamble line, or
 * null for any other line (including the `event:"spawned"` follow-up, which
 * carries no `cmd`). Only a non-empty all-string `cmd` array counts.
 */
export function parsePreambleLine(line: string): string[] | null {
  if (!line.includes(`"${SCHED_DISPATCH_EVENT}"`)) return null;
  try {
    const parsed = JSON.parse(line) as { type?: unknown; cmd?: unknown };
    if (
      parsed.type === SCHED_DISPATCH_EVENT &&
      Array.isArray(parsed.cmd) &&
      parsed.cmd.length > 0 &&
      parsed.cmd.every((part) => typeof part === 'string')
    ) {
      return parsed.cmd as string[];
    }
  } catch {
    // truncated/partial line
  }
  return null;
}

/**
 * The spawned argv of the LAST dispatch recorded in a log — each spawn opens
 * with a `sched-dispatch` preamble (written by `createSpawnDeps`), and logs
 * are append-mode, so a redispatched unit (e.g. retried on a fallback agent,
 * #629) holds several; the newest one describes the stream the parsers read
 * the final result from. Null when the log has none (a pre-preamble log, or
 * one whose head was cut by `readDispatchLog`'s bounded window).
 */
export function dispatchPreambleCmd(logContent: string | null): string[] | null {
  if (!logContent) return null;
  const marker = `{"type":"${SCHED_DISPATCH_EVENT}"`;
  let last: string[] | null = null;
  for (let at = logContent.indexOf(marker); at !== -1; at = logContent.indexOf(marker, at + 1)) {
    if (at > 0 && logContent[at - 1] !== '\n') continue; // only whole preamble lines
    const end = logContent.indexOf('\n', at);
    const cmd = parsePreambleLine(logContent.slice(at, end === -1 ? undefined : end));
    if (cmd) last = cmd;
  }
  return last;
}

/**
 * The model an agent argv requested — the value after `-m`/`--model`, or
 * `--model=<id>` — or null when the argv names none. For opencode this is
 * already a concrete `provider/model` id (e.g. `openai/gpt-5.6-luna`); for
 * claude it may be an alias, but claude's own result reports the resolved
 * model, which `buildSchedRunLogEntry` prefers over this fallback.
 */
export function modelFromCmd(cmd: readonly string[]): string | null {
  for (let i = 0; i < cmd.length; i++) {
    const part = cmd[i];
    if (part === '--') break; // everything after is the agent's prompt, not flags
    if ((part === '-m' || part === '--model') && i + 1 < cmd.length) {
      const value = cmd[i + 1];
      return value && !value.startsWith('-') ? value : null;
    }
    if (part.startsWith('--model=')) return part.slice('--model='.length) || null;
  }
  return null;
}

function roleLabel(entry: BatchLogEntry): string {
  switch (entry.role) {
    case 'member':
      return `batch-member-m${entry.member}`;
    case 'fix':
      return `batch-fix-${entry.offender}`;
    case 'tail':
      return 'batch-tail';
    case 'report':
      return 'batch-report';
  }
}

/** Member and fix logs attribute to their issue (same scheme live dispatches use); tail/report have none. */
function entryUnit(entry: BatchLogEntry, batchId: string): string {
  if (entry.role === 'member') return `issue:${entry.issue}`;
  if (entry.role === 'fix') return `issue:${entry.offender}`;
  return `batch:${batchId}`;
}

/**
 * Reconstruct `RunLogEntry` rows for every dispatch log found for `batchId`
 * — the read-time equivalent of `recordMemberRunLog`, for a batch with no
 * `runs.jsonl` coverage (predates #564, or was torn down before the
 * write-side fix could run). `spawnedAt` is unrecoverable after the fact, so
 * `duration_ms` degrades to null (the existing "unmeasurable" convention);
 * `completedAt` uses the log file's own mtime as the closest available
 * timestamp.
 */
export function buildBatchRunLogEntries(runsDir: string, batchId: string): RunLogEntry[] {
  return listBatchDispatchLogs(runsDir, batchId).map((entry) => {
    const logContent = readDispatchLog(entry.file, 0);
    let completedAt: Date;
    try {
      completedAt = fs.statSync(entry.file).mtime;
    } catch {
      completedAt = new Date(0);
    }
    // Filenames do not retain the spawned command, but every dispatch log
    // opens with a `sched-dispatch` preamble carrying the exact argv (#769).
    // Prefer it: it names the binary AND the model the member was spawned
    // with — the opencode JSON stream never reports a model id, so without
    // it an opencode member's Model column read `-`. Logs that predate the
    // preamble (or whose head fell outside the bounded read window) keep the
    // old fallback: OpenCode only for its distinctive step_finish/step-finish
    // pair, everything else the established Claude-shaped parser.
    const preambleCmd = dispatchPreambleCmd(logContent);
    const cmd0 = preambleCmd?.[0] ?? (isOpenCodeUsageStream(logContent) ? 'opencode' : 'claude');
    return buildSchedRunLogEntry({
      unit: entryUnit(entry, batchId),
      role: roleLabel(entry),
      cmd0,
      cmd: preambleCmd ?? [cmd0],
      logContent,
      spawnedAt: null,
      completedAt,
      configuredModel: preambleCmd ? modelFromCmd(preambleCmd) : null,
      cwd: runsDir,
    });
  });
}
