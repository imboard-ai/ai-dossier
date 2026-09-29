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
 * whole session — it claims a window ending at its own enqueue time (#899):
 *
 *  - `marker`: the window starts at the session's first `ai-dossier run
 *    …/batch-issues-preparation` (runs.jsonl records every run with its
 *    session id) after the previous enqueue — a deterministic prep start, so
 *    hours of unrelated work before the prep began are excluded;
 *  - `prev-enqueue`: no marker; the window starts at the session's previous
 *    enqueue (an upper bound — unrelated work in between counts);
 *  - `lookback-cap`: neither; the window reaches back
 *    {@link MAX_PREP_LOOKBACK_MS} (the loosest upper bound).
 *
 * One enqueue that creates several batches yields identical windows. Their
 * rows are split across the batches in proportion to member count, so the
 * per-batch figures always sum to the window's tokens — never double-count.
 */

import * as path from 'node:path';
import { appendJsonl, readJsonl } from '@ai-dossier/sched';
import { collectLedger, defaultLedgerPaths, type LedgerPaths, rowTotal } from './ledger';
import { rowKey } from './store';
import type { PrepBasis, UsageRow } from './types';
import { forEachLine, safeReaddir } from './util';

export const BATCH_PREP_FILE = 'batch-prep.jsonl';

/** A window never reaches further back than this, however long the session idled before enqueue. */
export const MAX_PREP_LOOKBACK_MS = 6 * 60 * 60 * 1000;

export interface BatchPrepRecord {
  ts: string;
  batch: string;
  session_id: string;
  /** How the session id was learned — the environment (deterministic) or an explicit flag. */
  source: 'env' | 'flag';
  /** Members enqueued into this batch by the call — the weight when one call's window is split (#899). */
  members?: number;
}

/** The dossier whose first run in a session marks the start of batch prep (#899). */
export const PREP_DOSSIER = 'batch-issues-preparation';

/** A deterministic prep start: an `ai-dossier run` of {@link PREP_DOSSIER} by a session. */
export interface PrepMarker {
  session_id: string;
  startMs: number;
}

export interface PrepWindow {
  batch: string;
  session_id: string;
  fromMs: number;
  toMs: number;
  basis: PrepBasis;
  /** Split weight among the batches sharing this exact window (member count, at least 1). */
  weight: number;
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
  now: Date = new Date(),
  members?: ReadonlyMap<string, number>
): void {
  for (const batch of [...new Set(batches)]) {
    const record: BatchPrepRecord = { ts: now.toISOString(), batch, session_id: sessionId, source };
    const count = members?.get(batch);
    if (count !== undefined && count > 0) record.members = count;
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

/**
 * Prep starts recorded in `runs.jsonl`: every `ai-dossier run` of
 * {@link PREP_DOSSIER} that carries a session id. The log stamps completion, so
 * the start is `timestamp - duration_ms`. Never throws.
 */
export function readPrepMarkers(runsLog: string): PrepMarker[] {
  const out: PrepMarker[] = [];
  forEachLine(runsLog, (line) => {
    if (!line.includes(PREP_DOSSIER) || !line.includes('"session_id"')) return;
    try {
      const e = JSON.parse(line) as {
        timestamp?: string;
        dossier?: string;
        session_id?: string | null;
        duration_ms?: number | null;
      };
      if (!e.session_id || !e.dossier || !e.timestamp) return;
      if (e.dossier !== PREP_DOSSIER && !e.dossier.endsWith(`/${PREP_DOSSIER}`)) return;
      const endMs = Date.parse(e.timestamp);
      if (Number.isNaN(endMs)) return;
      const startMs = endMs - (typeof e.duration_ms === 'number' ? Math.max(0, e.duration_ms) : 0);
      out.push({ session_id: e.session_id, startMs });
    } catch {
      // torn / foreign line
    }
  });
  return out;
}

/** Records → the time window each one claims (see the module comment). */
export function prepWindows(
  records: readonly BatchPrepRecord[],
  markers: readonly PrepMarker[] = []
): PrepWindow[] {
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
    // Earliest prep run after the previous enqueue (and not after this one). A marker older than
    // the lookback cap is treated as no marker: a prep run days ago in the same long-lived
    // session is not evidence this batch's prep started then.
    const capMs = toMs - MAX_PREP_LOOKBACK_MS;
    let markerMs = Number.POSITIVE_INFINITY;
    for (const m of markers) {
      if (
        m.session_id === r.session_id &&
        m.startMs > prevMs &&
        m.startMs >= capMs &&
        m.startMs <= toMs
      ) {
        markerMs = Math.min(markerMs, m.startMs);
      }
    }
    let fromMs: number;
    let basis: PrepBasis;
    if (Number.isFinite(markerMs)) {
      fromMs = markerMs - 1; // rows are matched `ts > fromMs`; include the marker instant
      basis = 'marker';
    } else if (prevMs > capMs) {
      fromMs = prevMs;
      basis = 'prev-enqueue';
    } else {
      fromMs = capMs;
      basis = 'lookback-cap';
    }
    return {
      batch: r.batch,
      session_id: r.session_id,
      fromMs,
      toMs,
      basis,
      weight: r.members !== undefined && r.members > 0 ? r.members : 1,
    };
  });
}

/**
 * Stamp `batch:<id>` onto rows of a prep session (or its subagents) inside a
 * window. Rows already attributed to a dispatch keep that attribution. Batches
 * created by one enqueue share an identical window; its rows are dealt across
 * them in proportion to their weights (member counts) by a hash of the row's stable
 * key — each row goes whole to one batch, so per-batch sums equal the window total.
 */
export function applyPrepWindows(rows: UsageRow[], windows: readonly PrepWindow[]): void {
  if (windows.length === 0) return;
  const groups = new Map<string, PrepWindow[]>();
  for (const w of windows) {
    const key = `${w.session_id}\u0000${w.fromMs}\u0000${w.toMs}`;
    const list = groups.get(key);
    if (list) list.push(w);
    else groups.set(key, [w]);
  }
  const byWindow = [...groups.values()];
  for (const row of rows) {
    if (row.unit !== null) continue;
    const root = row.session_id.split('/')[0];
    const ts = Date.parse(row.ts);
    const hit = byWindow.find(
      (g) => g[0].session_id === root && ts > g[0].fromMs && ts <= g[0].toMs
    );
    if (!hit) continue;
    const winner = hit.length > 1 ? pickWeighted(hit, rowKey(row)) : hit[0];
    if (hit.length > 1) row.prep_split = hit.length;
    row.unit = `batch:${winner.batch}`;
    row.batch = winner.batch;
    row.role = 'prep';
    row.prep_basis = winner.basis;
  }
}

/**
 * Pick a window by weight from a hash of the row's stable key — the same row goes to
 * the same batch in every view (`usage`, `sched stats`, a partial collection), and the
 * shares converge on the weights. Batch order is fixed so the pick is reproducible.
 */
function pickWeighted(windows: readonly PrepWindow[], key: string): PrepWindow {
  const ordered = [...windows].sort((a, b) => a.batch.localeCompare(b.batch));
  const total = ordered.reduce((n, w) => n + w.weight, 0);
  const point = (Number.parseInt(key.slice(0, 8), 16) / 0x1_0000_0000) * total;
  let acc = 0;
  for (const w of ordered) {
    acc += w.weight;
    if (point < acc) return w;
  }
  return ordered[ordered.length - 1];
}

/** Every project's records under `schedRoot`, as windows (markers read from `runsLog`). */
export function readAllPrepWindows(schedRoot: string, runsLog: string): PrepWindow[] {
  const records: BatchPrepRecord[] = [];
  for (const project of safeReaddir(schedRoot)) {
    if (project.isDirectory()) records.push(...readBatchPrep(path.join(schedRoot, project.name)));
  }
  return prepWindows(records, readPrepMarkers(runsLog));
}

export interface BatchPrepTokens {
  /** Tokens of every class (input + output + cache) — the scorecard's billable total. */
  billable_tokens: number;
  sessions: number;
  messages: number;
  /** How far back the window(s) reach — `marker` is exact-start; the others are upper bounds (#899). */
  basis: PrepBasis | 'mixed';
  /** True when a window was shared with sibling batches from one enqueue and split by member count. */
  split: boolean;
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
  // Windows come from ALL records: a batch's window is shared with its siblings
  // from the same enqueue, so filtering first would hand it their share.
  const records = readBatchPrep(schedDir);
  const out = new Map<string, BatchPrepTokens>();
  if (!records.some((r) => !wanted || wanted.has(r.batch))) return out;
  const windows = prepWindows(records, readPrepMarkers(paths.runsLog));
  const sessions = new Map<string, Set<string>>();
  const bases = new Map<string, Set<PrepBasis>>();
  for (const w of windows) {
    if (wanted && !wanted.has(w.batch)) continue;
    out.set(
      w.batch,
      out.get(w.batch) ?? {
        billable_tokens: 0,
        sessions: 0,
        messages: 0,
        basis: w.basis,
        split: false,
      }
    );
    sessions.set(w.batch, (sessions.get(w.batch) ?? new Set()).add(w.session_id));
    bases.set(w.batch, (bases.get(w.batch) ?? new Set()).add(w.basis));
  }
  for (const [batch, set] of sessions) (out.get(batch) as BatchPrepTokens).sessions = set.size;
  for (const [batch, set] of bases) {
    (out.get(batch) as BatchPrepTokens).basis = set.size === 1 ? [...set][0] : 'mixed';
  }
  // Only the wanted batches' windows (siblings share theirs) bound the scan — not every
  // prep record ever written, which would read the whole transcript history.
  const wantedWindows = windows.filter((w) => !wanted || wanted.has(w.batch));
  const { rows } = collectLedger({
    sinceMs: Math.min(...wantedWindows.map((w) => w.fromMs)),
    untilMs: Math.max(...wantedWindows.map((w) => w.toMs)) + 1,
    paths,
  });
  for (const row of rows) {
    if (row.role !== 'prep' || row.batch === null) continue;
    const entry = out.get(row.batch);
    if (!entry) continue;
    entry.billable_tokens += rowTotal(row);
    entry.messages += 1;
    if (row.prep_split) entry.split = true;
  }
  return out;
}
