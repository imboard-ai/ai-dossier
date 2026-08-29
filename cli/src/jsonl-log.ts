/**
 * Shared append-only JSONL audit logging (runs.jsonl, caps.jsonl).
 *
 * One helper so every telemetry file behaves identically: respects the
 * auditLog config flag, creates the config dir, appends with mode 0600,
 * and never crashes the run on failure.
 */

import fs from 'node:fs';
import { ensureConfigDir, getConfig } from './config';

/**
 * Append one JSONL line to an audit log file.
 * Respects the auditLog config flag. Never crashes the run; on failure a
 * warning goes to stderr so an operator can tell the log is incomplete.
 */
export function appendAuditJsonl(file: string, entry: unknown): void {
  try {
    if (getConfig('auditLog') === false) return;
    ensureConfigDir();
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch (err) {
    process.stderr.write(
      `Warning: could not append telemetry to ${file}: ${(err as Error).message}\n`
    );
  }
}
