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

export class Journal {
  readonly filePath: string;

  constructor(dir: string) {
    this.filePath = path.join(dir, 'events.jsonl');
  }

  /** Append one event, stamping `ts` from the caller's clock. Never throws. */
  append(event: Omit<JournalEvent, 'ts'>, now: Date = new Date()): void {
    const line: JournalEvent = { ts: now.toISOString(), ...event };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.filePath, `${JSON.stringify(line)}\n`, 'utf8');
    } catch (err) {
      process.stderr.write(
        `⚠ sched: could not append journal event ${event.event}: ${(err as Error).message}\n`
      );
    }
  }

  /** Read every event, oldest first; malformed lines are skipped. */
  read(): JournalEvent[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const lines = fs.readFileSync(this.filePath, 'utf8').split('\n').filter(Boolean);
      const events: JournalEvent[] = [];
      for (const line of lines) {
        try {
          events.push(JSON.parse(line) as JournalEvent);
        } catch {
          // Skip malformed lines — the journal is append-only and best-effort.
        }
      }
      return events;
    } catch {
      return [];
    }
  }
}

/** Convenience: build the journaled event for a unit without repeating ids. */
export function unitEvent(
  event: JournalEventName,
  unit: string,
  extra: Omit<JournalEvent, 'ts' | 'event' | 'unit'> = {}
): Omit<JournalEvent, 'ts' | 'event' | 'unit'> & { event: JournalEventName; unit: string } {
  const issue = unit.startsWith('issue:')
    ? Number.parseInt(unit.slice('issue:'.length), 10)
    : undefined;
  return {
    event,
    unit,
    ...(issue !== undefined && !Number.isNaN(issue) ? { issue } : {}),
    ...extra,
  };
}
