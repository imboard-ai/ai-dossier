/**
 * Persistent run log for dossier executions.
 * Append-only JSONL at ~/.dossier/runs.jsonl.
 */

import fs from 'node:fs';
import { type RunLogEntry, runsLogPath } from '@ai-dossier/core';
import { appendAuditJsonl } from './jsonl-log';

/**
 * The runs.jsonl entry schema now lives in `@ai-dossier/core` (#524) so
 * `packages/sched`'s dispatch path can write entries in the same shape
 * without depending on `cli`. Re-exported here so existing imports of
 * `RunLogEntry` from `./run-log` keep working unchanged.
 */
export type { RunLogEntry };

/**
 * `runsLogPath()` (`@ai-dossier/core`) is the single source of truth for
 * this path (#524) — `packages/sched`'s writer and `ai-dossier sched stats`'
 * reader both derive it the same way, so the two can never silently drift
 * apart. Equivalent to the prior `path.join(CONFIG_DIR, 'runs.jsonl')`.
 */
const LOG_FILE = runsLogPath();

/**
 * Append one JSONL line to ~/.dossier/runs.jsonl.
 * Respects auditLog config flag. Never crashes the run.
 */
export function appendRunLog(entry: RunLogEntry): void {
  appendAuditJsonl(LOG_FILE, entry);
}

/**
 * Read the run log, filter, return most-recent-first.
 * Skips malformed lines.
 */
export function readRunLog(opts?: { limit?: number; dossier?: string }): RunLogEntry[] {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
    let entries: RunLogEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }
    if (opts?.dossier) {
      entries = entries.filter((e) => e.dossier === opts.dossier);
    }
    entries.reverse();
    if (opts?.limit) {
      entries = entries.slice(0, opts.limit);
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Clear the run log file.
 */
export function clearRunLog(): void {
  try {
    if (fs.existsSync(LOG_FILE)) {
      fs.writeFileSync(LOG_FILE, '', { mode: 0o600 });
    }
  } catch {
    // Silently fail
  }
}

export { LOG_FILE };
