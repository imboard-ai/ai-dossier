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
import type { RunLogEntry } from '@ai-dossier/core';
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
 * The agent CLI these logs are shaped for — every batch dispatch produced so
 * far uses the Claude CLI (`modelUsage`/`total_cost_usd` stream-json
 * result), and the filename convention on disk carries no record of which
 * binary was spawned (unlike a live dispatch, which knows `cmd[0]` from
 * `resolveTierSpawn` at record time). `usageParserFor` degrades to this same
 * parser for any command it doesn't specifically recognize, so this default
 * is also the safe fallback, never a narrowing assumption.
 */
const RECONSTRUCTED_CMD0 = 'claude';

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
    return buildSchedRunLogEntry({
      unit: entryUnit(entry, batchId),
      role: roleLabel(entry),
      cmd0: RECONSTRUCTED_CMD0,
      cmd: [RECONSTRUCTED_CMD0],
      logContent,
      spawnedAt: null,
      completedAt,
      configuredModel: null,
      cwd: runsDir,
    });
  });
}
