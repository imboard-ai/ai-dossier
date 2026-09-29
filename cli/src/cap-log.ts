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

import crypto from 'node:crypto';
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
  /** Tree was dirty before or after the run, or HEAD/tree moved during it (#941). */
  dirty?: boolean;
  /** The git probe timed out or errored; `dirty` is then true (#941). */
  git_probe?: 'timeout' | 'error';
  /** Args passed after `--` to `cap run` (#941): `--only smoke` is not a full gate. */
  args?: string[];
  /** sha256 of the JSON args array — the match key for `cap last-ok`. */
  args_hash?: string;
}

/** Stable digest of a capability's extra args (order-sensitive). */
export function hashCapArgs(args: string[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex');
}

const CAP_LOG_FILE = path.join(CONFIG_DIR, 'caps.jsonl');

/**
 * Append one JSONL line to ~/.dossier/caps.jsonl.
 * Respects auditLog config flag. Never crashes the run.
 */
export function appendCapLog(entry: CapLogEntry): void {
  appendAuditJsonl(CAP_LOG_FILE, entry);
}

/** A torn append can leave `{"timestamp"...garbage` glued to the next row; salvage the tail. */
function parseRow(line: string): CapLogEntry | null {
  try {
    return JSON.parse(line) as CapLogEntry;
  } catch {
    const at = line.lastIndexOf('{"timestamp"');
    if (at <= 0) return null;
    try {
      return JSON.parse(line.slice(at)) as CapLogEntry;
    } catch {
      return null;
    }
  }
}

/**
 * Latest `ok` row for `capability` invoked with exactly `args` that verified
 * exactly `tree` on a clean working tree. Not part of the match key (by
 * design): git-ignored files, toolchain/CLI versions, env, nested repos.
 * A dirty row, a probe-failed row, or one without `args_hash` (pre-args
 * schema) never matches. Null when nothing qualifies; a missing file is
 * "nothing", any other read error throws.
 */
export function findLastOk(
  capability: string,
  tree: string,
  args: string[] = [],
  file: string = CAP_LOG_FILE
): CapLogEntry | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const want = hashCapArgs(args);
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    const row = parseRow(lines[i]);
    if (
      row &&
      row.capability === capability &&
      row.outcome === 'ok' &&
      row.git_tree === tree &&
      row.dirty === false &&
      !row.git_probe &&
      row.args_hash === want
    ) {
      return row;
    }
  }
  return null;
}

export { CAP_LOG_FILE };
