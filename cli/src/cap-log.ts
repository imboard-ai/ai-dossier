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
}

const CAP_LOG_FILE = path.join(CONFIG_DIR, 'caps.jsonl');

/**
 * Append one JSONL line to ~/.dossier/caps.jsonl.
 * Respects auditLog config flag. Never crashes the run.
 */
export function appendCapLog(entry: CapLogEntry): void {
  appendAuditJsonl(CAP_LOG_FILE, entry);
}

export { CAP_LOG_FILE };
