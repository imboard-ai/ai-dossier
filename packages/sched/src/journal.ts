/**
 * Append-only event journal (#464, AC6 — "all events journaled"; RFC-0001 §D.4
 * "Audit"). Every engine decision lands here as one JSONL line in
 * `<sched-dir>/events.jsonl`. The journal must never crash a tick: write
 * failures are swallowed after a one-line stderr warning — state.json remains
 * the operational truth, the journal is the operator's flight recorder.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { JournalEvent, JournalEventName } from './types';

/** The journal file name — the single source (persist.ts's journalPath uses it). */
export const JOURNAL_FILE = 'events.jsonl';

/**
 * Append one JSON-serializable entry as a line to `file`, creating parent
 * directories as needed (`0o700`/`0o600`, matching the journal's existing
 * hardening). Never throws — an append-only debug/telemetry file must not
 * fail the caller's operation over a write error (permissions, disk full).
 * `onError`, when given, receives the failure so the caller can signal it
 * (the journal writes a stderr warning; `packages/sched/src/run-log.ts`'s
 * `appendSchedRunLog` journals it, #524) — shared by both so the
 * mkdir+append+swallow sequence exists in exactly one place.
 */
export function appendJsonl(file: string, entry: unknown, onError?: (err: Error) => void): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    // `mode` above applies only when appendFileSync CREATES the file. These
    // files carry spawned argv and cost data (#524), so a pre-existing
    // world-readable copy — an older build's umask, a restored archive — must
    // be tightened rather than silently appended to.
    if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
    return true;
  } catch (err) {
    onError?.(err as Error);
    return false;
  }
}

export class Journal {
  readonly filePath: string;

  constructor(dir: string) {
    this.filePath = path.join(dir, JOURNAL_FILE);
  }

  /** Append one event, stamping `ts` from the caller's clock. Never throws. */
  append(event: Omit<JournalEvent, 'ts'>, now: Date = new Date()): void {
    const line: JournalEvent = { ts: now.toISOString(), ...event };
    appendJsonl(this.filePath, line, (err) => {
      process.stderr.write(
        `⚠ sched: could not append journal event ${event.event}: ${err.message}\n`
      );
    });
  }

  /** Read every event, oldest first; malformed lines are skipped. */
  read(): JournalEvent[] {
    return readJsonl<JournalEvent>(this.filePath);
  }
}

/**
 * Read a JSONL file oldest-first, skipping malformed lines; `[]` when the
 * file is absent or unreadable. `cli/src/run-log.ts` implements the same loop
 * against `runs.jsonl` — worth unifying in `core` (where `RunLogEntry` and
 * `runsLogPath` now live) rather than leaving two copies.
 */
export function readJsonl<T>(file: string): T[] {
  try {
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const out: T[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // Skip malformed lines — append-only best-effort files.
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * `issue:464` → 464; null for batch or malformed unit ids.
 *
 * Type-guards rather than trusting the declared type: `unit` now reaches here
 * straight off a `JSON.parse`d `runs.jsonl` line (`buildSchedCostReport`),
 * which is cast to `RunLogEntry` without validation. A hand-edited or
 * truncated line carrying `"unit": 5` must skip that row, not crash
 * `sched stats` with a TypeError (#524 review).
 */
export function issueOfUnit(unit: unknown): number | null {
  if (typeof unit !== 'string' || !unit.startsWith('issue:')) return null;
  const n = Number.parseInt(unit.slice('issue:'.length), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** `batch:b1` → `b1`; null for issue or malformed unit ids (#523). */
export function batchOfUnit(unit: string | null): string | null {
  if (unit === null || !unit.startsWith('batch:')) return null;
  const id = unit.slice('batch:'.length);
  return id.length > 0 ? id : null;
}

/** Convenience: build the journaled event for a unit without repeating ids. */
export function unitEvent(
  event: JournalEventName,
  unit: string,
  extra: Omit<JournalEvent, 'ts' | 'event' | 'unit'> = {}
): Omit<JournalEvent, 'ts' | 'event' | 'unit'> & { event: JournalEventName; unit: string } {
  const issue = issueOfUnit(unit);
  return { event, unit, ...(issue !== null ? { issue } : {}), ...extra };
}
