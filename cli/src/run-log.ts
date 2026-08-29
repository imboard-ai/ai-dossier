/**
 * Persistent run log for dossier executions.
 * Append-only JSONL at ~/.dossier/runs.jsonl.
 */

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config';
import { appendAuditJsonl } from './jsonl-log';

export interface RunLogEntry {
  timestamp: string;
  dossier: string;
  resolved_version: string;
  source: 'cache' | 'registry' | 'local' | 'url';
  registry?: string;
  /**
   * How the version was resolved (only meaningful for registry sources):
   *   - 'pinned'      — caller passed name@version explicitly
   *   - 'registry'    — resolver called the registry and got a fresh version
   *   - 'cache'       — resolver served from TTL'd resolution cache (no registry call)
   *   - 'stale-cache' — registry was unreachable; fell back to highest cached semver
   * Useful for postmortems answering "did this run hit a stale resolution that
   * masked a registry outage?". Absent for local files and URLs.
   */
  resolution_source?: 'pinned' | 'registry' | 'cache' | 'stale-cache';
  verification: 'passed' | 'failed' | 'skipped' | 'nested-skip';
  llm: string;
  user: string;
  cwd: string;
  nested: boolean;
  /**
   * Deprecated: written by the pre-#401 update-check machinery. Retained on the
   * interface so `dossier history` can still display this field when reading
   * older runs.jsonl entries. Not written by new runs.
   */
  update_available?: string;
  /**
   * Cost/observability fields (#458). All optional and nullable so old-schema
   * entries still parse; written by new runs with explicit nulls when a value
   * is unavailable — never fabricated.
   */
  /** Wall-clock duration of the run in milliseconds (action start → entry write). */
  duration_ms?: number | null;
  /**
   * The exact agent command spawned (binary + args). Prompt content is excluded
   * (headless prompts travel over stdin). Null when nothing was spawned
   * (nested-skip, failed verification, dry-run, no LLM detected, unknown LLM).
   */
  spawned_command?: string | null;
  /** Model id as reported by the agent CLI, else the requested --model alias. Null when unknown. */
  model?: string | null;
  /** Exit code of the spawned agent process, or of the CLI action for early exits. Null when killed by a signal or failed to spawn. */
  exit_code?: number | null;
  /** Why the spawned process produced no exit code: spawn error (e.g. ENOENT) or signal. Null when the process exited normally. */
  spawn_error?: string | null;
  /** Input tokens reported by the agent CLI. Null when unavailable. */
  input_tokens?: number | null;
  /** Output tokens reported by the agent CLI. Null when unavailable. */
  output_tokens?: number | null;
  /** Total cost in USD reported by the agent CLI. Null when unavailable. */
  total_cost_usd?: number | null;
}

const LOG_FILE = path.join(CONFIG_DIR, 'runs.jsonl');

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
