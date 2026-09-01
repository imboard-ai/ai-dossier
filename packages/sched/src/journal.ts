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

export class Journal {
  readonly filePath: string;

  constructor(dir: string) {
    this.filePath = path.join(dir, JOURNAL_FILE);
  }

  /** Append one event, stamping `ts` from the caller's clock. Never throws. */
  append(event: Omit<JournalEvent, 'ts'>, now: Date = new Date()): void {
    const line: JournalEvent = { ts: now.toISOString(), ...event };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.filePath, `${JSON.stringify(line)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch (err) {
      process.stderr.write(
        `⚠ sched: could not append journal event ${event.event}: ${(err as Error).message}\n`
      );
    }
  }

  /** Read every event, oldest first; malformed lines are skipped. */
  read(): JournalEvent[] {
    return readJsonl<JournalEvent>(this.filePath);
  }
}

/**
 * Read a JSONL file oldest-first, skipping malformed lines; `[]` when the
 * file is absent or unreadable. Shared by the journal and the CLI's run log
 * so the read-loop exists once.
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

/** `issue:464` → 464; null for batch or malformed unit ids. */
export function issueOfUnit(unit: string | null): number | null {
  if (unit === null || !unit.startsWith('issue:')) return null;
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
