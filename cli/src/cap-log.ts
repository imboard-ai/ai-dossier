/**
 * Capability run telemetry — append-only JSONL at ~/.dossier/caps.jsonl.
 *
 * Modeled on run-log.ts via the shared appendAuditJsonl helper (respects the
 * auditLog config flag, mode 0600, never crashes the run). Kept separate from
 * runs.jsonl because a dossier run entry (dossier, resolved_version,
 * verification, llm…) does not describe a capability execution; `caps.jsonl`
 * carries the capability run fields: capability, outcome, exit_code,
 * duration_ms, reason, signal, cwd, timestamp.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { CapabilityOutcome } from './capability';
import { CONFIG_DIR } from './config';
import { appendAuditJsonl } from './jsonl-log';

export interface CapLogEntry {
  timestamp: string;
  capability: string;
  outcome: CapabilityOutcome;
  exit_code: number | null;
  duration_ms: number;
  /** Why a non-ok outcome happened, from the run envelope (postmortem traceability). */
  reason: string | null;
  /** Signal that killed the command, when abnormal termination occurred. */
  signal: string | null;
  cwd: string;
  /** Last bytes of combined stdout+stderr on a non-ok outcome (#583 AC1/AC3). */
  output_tail?: string;
  /** `git rev-parse HEAD` when cwd is a git work tree (#941). */
  git_head?: string;
  /** `git rev-parse HEAD^{tree}` when cwd is a git work tree (#941). */
  git_tree?: string;
  /** `git status --porcelain` was non-empty when the run started (#941). */
  dirty?: boolean;
}

const CAP_LOG_FILE = path.join(CONFIG_DIR, 'caps.jsonl');

/**
 * Append one JSONL line to ~/.dossier/caps.jsonl.
 * Respects auditLog config flag. Never crashes the run.
 */
export function appendCapLog(entry: CapLogEntry): void {
  appendAuditJsonl(CAP_LOG_FILE, entry);
}

/**
 * Latest `ok` row for `capability` that verified exactly `tree` on a clean
 * working tree. A dirty row (or one without git fields) never matches: its
 * verdict may describe uncommitted code. Null when nothing qualifies.
 */
export function findLastOk(
  capability: string,
  tree: string,
  file: string = CAP_LOG_FILE
): CapLogEntry | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    try {
      const row = JSON.parse(lines[i]) as CapLogEntry;
      if (
        row.capability === capability &&
        row.outcome === 'ok' &&
        row.git_tree === tree &&
        row.dirty === false
      ) {
        return row;
      }
    } catch {
      // A torn or foreign line must not hide older valid rows.
    }
  }
  return null;
}

export { CAP_LOG_FILE };
