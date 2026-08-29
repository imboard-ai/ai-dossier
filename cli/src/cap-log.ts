/**
 * Capability run telemetry — append-only JSONL at ~/.dossier/caps.jsonl.
 *
 * Modeled on run-log.ts (appendFileSync, mode 0600, respects the auditLog
 * config flag, never crashes the caller). Kept separate from runs.jsonl
 * because a dossier run entry (dossier, resolved_version, verification, llm…)
 * does not describe a capability execution; `caps.jsonl` carries exactly the
 * capability contract fields: id, outcome, duration.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { CapabilityOutcome } from './capability';
import { CONFIG_DIR, ensureConfigDir, getConfig } from './config';

export interface CapLogEntry {
  timestamp: string;
  capability: string;
  outcome: CapabilityOutcome;
  exit_code: number | null;
  duration_ms: number;
  cwd: string;
}

const CAP_LOG_FILE = path.join(CONFIG_DIR, 'caps.jsonl');

/**
 * Append one JSONL line to ~/.dossier/caps.jsonl.
 * Respects auditLog config flag. Never crashes the run.
 */
export function appendCapLog(entry: CapLogEntry): void {
  try {
    if (getConfig('auditLog') === false) return;
    ensureConfigDir();
    fs.appendFileSync(CAP_LOG_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // Never crash the run
  }
}

export { CAP_LOG_FILE };
