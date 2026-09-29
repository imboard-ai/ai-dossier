/**
 * Batch-prep token attribution (#796, parent #770 P6).
 *
 * `batch-issues-preparation` (classifier / prescreen agents) runs in the
 * operator's Claude Code session, not as a scheduler dispatch, so no
 * `runs/batch-<id>-*.log` carries its tokens. The one deterministic hook is
 * `sched enqueue`, which prep calls to create the batch: it records the calling
 * session id (`CLAUDE_CODE_SESSION_ID`, set by Claude Code for every child
 * process) in `<sched-dir>/batch-prep.jsonl`. The usage ledger then attributes
 * that session's spend — subagents included — to `batch:<id>`.
 *
 * An operator session outlives any one batch, so a record does not claim the
 * whole session: it claims the window since the previous record of the same
 * session (capped at {@link MAX_PREP_LOOKBACK_MS}) up to its own enqueue time.
 * That is an upper bound — unrelated operator work inside the window counts
 * too — and the figure is disclosed separately for that reason.
 */

import * as path from 'node:path';
import { appendJsonl, readJsonl } from '@ai-dossier/sched';
import { collectLedger, defaultLedgerPaths, type LedgerPaths, rowTotal } from './ledger';
import type { UsageRow } from './types';
import { safeReaddir } from './util';

export const BATCH_PREP_FILE = 'batch-prep.jsonl';

/** A window never reaches further back than this, however long the session idled before enqueue. */
export const MAX_PREP_LOOKBACK_MS = 6 * 60 * 60 * 1000;

export interface BatchPrepRecord {
  ts: string;
  batch: string;
  session_id: string;
  /** How the session id was learned — the environment (deterministic) or an explicit flag. */
  source: 'env' | 'flag';
}

export interface PrepWindow {
  batch: string;
  session_id: string;
  fromMs: number;
  toMs: number;
}

/** The calling Claude Code session, or null outside one. */
export function currentSessionId(env: NodeJS.ProcessEnv = process.env): string | null {
  const id = env.CLAUDE_CODE_SESSION_ID;
  return typeof id === 'string' && /^[A-Za-z0-9._-]{8,128}$/.test(id) ? id : null;
}

/** Append one record per batch. Never throws (telemetry must not fail an enqueue). */
export function recordBatchPrep(
  schedDir: string,
  batches: readonly string[],
  sessionId: string,
  source: BatchPrepRecord['source'],
  now: Date = new Date()
): void {
  for (const batch of [...new Set(batches)]) {
    const record: BatchPrepRecord = { ts: now.toISOString(), batch, session_id: sessionId, source };
    appendJsonl(path.join(schedDir, BATCH_PREP_FILE), record);
  }
}

export function readBatchPrep(schedDir: string): BatchPrepRecord[] {
  try {
    return readJsonl<BatchPrepRecord>(path.join(schedDir, BATCH_PREP_FILE)).filter(
      (r) =>
        r &&
        typeof r.batch === 'string' &&
        typeof r.session_id === 'string' &&
        !Number.isNaN(Date.parse(r.ts))
    );
  } catch {
    return [];
  }
}

/** Records → the time window each one claims (see the module comment). */
export function prepWindows(records: readonly BatchPrepRecord[]): PrepWindow[] {
  const sorted = [...records].sort(
    (a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.batch.localeCompare(b.batch)
  );
  return sorted.map((r) => {
    const toMs = Date.parse(r.ts);
    // Latest strictly-earlier enqueue from the same session bounds the window.
    let prevMs = Number.NEGATIVE_INFINITY;
    for (const other of sorted) {
      const otherMs = Date.parse(other.ts);
      if (other.session_id === r.session_id && otherMs < toMs) prevMs = Math.max(prevMs, otherMs);
    }
    return {
      batch: r.batch,
      session_id: r.session_id,
      fromMs: Math.max(prevMs, toMs - MAX_PREP_LOOKBACK_MS),
      toMs,
    };
  });
}

/**
 * Stamp `batch:<id>` onto rows of a prep session (or its subagents) inside a
 * window. Rows already attributed to a dispatch keep that attribution; a row
 * two windows both claim (two batches from one enqueue call) goes to the first.
 */
export function applyPrepWindows(rows: UsageRow[], windows: readonly PrepWindow[]): void {
  if (windows.length === 0) return;
  for (const row of rows) {
    if (row.unit !== null) continue;
    const root = row.session_id.split('/')[0];
    const ts = Date.parse(row.ts);
    const hit = windows.find((w) => w.session_id === root && ts > w.fromMs && ts <= w.toMs);
    if (!hit) continue;
    row.unit = `batch:${hit.batch}`;
    row.batch = hit.batch;
    row.role = 'prep';
  }
}

/** Every project's records under `schedRoot`, as windows. */
export function readAllPrepWindows(schedRoot: string): PrepWindow[] {
  const records: BatchPrepRecord[] = [];
  for (const project of safeReaddir(schedRoot)) {
    if (project.isDirectory()) records.push(...readBatchPrep(path.join(schedRoot, project.name)));
  }
  return prepWindows(records);
}

export interface BatchPrepTokens {
  /** Tokens of every class (input + output + cache) — the scorecard's billable total. */
  billable_tokens: number;
  sessions: number;
  messages: number;
}

/**
 * Prep tokens per batch id recorded in `schedDir`. A batch with no record on
 * this host is absent from the map (unknown, not zero); a recorded batch whose
 * transcripts are gone reads 0.
 */
export function batchPrepTokens(
  schedDir: string,
  batchIds?: readonly string[],
  paths: LedgerPaths = defaultLedgerPaths()
): Map<string, BatchPrepTokens> {
  const wanted = batchIds ? new Set(batchIds) : null;
  const records = readBatchPrep(schedDir).filter((r) => !wanted || wanted.has(r.batch));
  const out = new Map<string, BatchPrepTokens>();
  if (records.length === 0) return out;
  const windows = prepWindows(records);
  const sessions = new Map<string, Set<string>>();
  for (const w of windows) {
    out.set(w.batch, out.get(w.batch) ?? { billable_tokens: 0, sessions: 0, messages: 0 });
    sessions.set(w.batch, (sessions.get(w.batch) ?? new Set()).add(w.session_id));
  }
  for (const [batch, set] of sessions) (out.get(batch) as BatchPrepTokens).sessions = set.size;
  const { rows } = collectLedger({
    sinceMs: Math.min(...windows.map((w) => w.fromMs)),
    untilMs: Math.max(...windows.map((w) => w.toMs)) + 1,
    paths,
  });
  for (const row of rows) {
    if (row.role !== 'prep' || row.batch === null) continue;
    const entry = out.get(row.batch);
    if (!entry) continue;
    entry.billable_tokens += rowTotal(row);
    entry.messages += 1;
  }
  return out;
}
