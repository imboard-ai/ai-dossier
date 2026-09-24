/**
 * Scheduler + dossier-run attribution for the usage ledger (#769).
 *
 * Tokens are NOT read from here: every sched-dispatched agent's tokens are
 * already in the Claude Code transcripts / opencode.db on the same host, and
 * `runs.jsonl`'s token columns would double-count them. What these sources
 * add is *attribution*:
 *
 * - sched dispatch logs (`~/.dossier/sched/<project>/runs/*.log`) name the
 *   unit/batch/issue in their filename and carry the agent's own session id
 *   in the stream (opencode `sessionID`, claude `session_id`) → an
 *   authoritative session → issue/batch join.
 * - sched `events.jsonl` records dispatch-failure/-unhealthy walls (#629/#505)
 *   → limit events.
 * - `runs.jsonl` entries written with `session_id` (#769) → how many
 *   `ai-dossier run` invocations each session made.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunLogEntry } from '@ai-dossier/core';
import { modelFromCmd, parsePreambleLine } from '@ai-dossier/sched';
import type { LimitEvent, UsageRow } from './types';
import { forEachLine, LIMIT_TEXT_RE, mtimeMs, oneLine, safeReaddir } from './util';

/** Most bytes of one dispatch log scanned for session ids (streams can be large). */
const MAX_LOG_SCAN_BYTES = 32 * 1024 * 1024;

/** A session that a sched dispatch log proves belongs to a unit. */
export interface DispatchRef {
  session_id: string;
  unit: string;
  issue: number | null;
  batch: string | null;
  /** `member` | `fix` | `tail` | `report` | `issue` | `other`. */
  role: string;
  /** sched project slug (`owner-repo`). */
  project: string;
  /** Model from the dispatch preamble's argv, when it named one. */
  model: string | null;
  log: string;
}

/** Filename → unit attribution. Mirrors `packages/sched`'s `unitLogName`-based builders. */
export function parseDispatchLogName(
  name: string
): Pick<DispatchRef, 'unit' | 'issue' | 'batch' | 'role'> | null {
  let m = name.match(/^batch-(.+)-m\d+-(\d+)\.log$/);
  if (m) return { unit: `issue:${m[2]}`, issue: Number(m[2]), batch: m[1], role: 'member' };
  m = name.match(/^batch-(.+)-fix-(\d+)\.log$/);
  if (m) return { unit: `issue:${m[2]}`, issue: Number(m[2]), batch: m[1], role: 'fix' };
  m = name.match(/^batch-(.+)-(tail|report)\.log$/);
  if (m) return { unit: `batch:${m[1]}`, issue: null, batch: m[1], role: m[2] };
  m = name.match(/^issue-(\d+)\.log$/);
  if (m) return { unit: `issue:${m[1]}`, issue: Number(m[1]), batch: null, role: 'issue' };
  if (name.endsWith('.log')) {
    return { unit: name.slice(0, -'.log'.length), issue: null, batch: null, role: 'other' };
  }
  return null;
}

/**
 * Every agent session in a dispatch log, each with the model of the
 * `sched-dispatch` preamble that precedes it (logs are append-mode: a
 * redispatched unit holds several dispatches, possibly on different agents).
 * Only a record's TOP-LEVEL `sessionID` (opencode) / `session_id` (claude)
 * counts — a tool call's input or output that merely mentions another
 * session id must not attribute that session to this unit.
 */
export function sessionsIn(content: string): { session_id: string; model: string | null }[] {
  const found = new Map<string, string | null>();
  let model: string | null = null;
  for (const line of content.split('\n')) {
    const cmd = parsePreambleLine(line);
    if (cmd) {
      model = modelFromCmd(cmd);
      continue;
    }
    if (!line.includes('"sessionID"') && !line.includes('"session_id"')) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const id = record.sessionID ?? record.session_id;
    if (typeof id === 'string' && SESSION_ID_SHAPE.test(id) && !found.has(id)) {
      found.set(id, model);
    }
  }
  return [...found].map(([session_id, m]) => ({ session_id, model: m }));
}

const SESSION_ID_SHAPE =
  /^(?:ses_[A-Za-z0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Session ids only — see {@link sessionsIn}. */
export function sessionIdsIn(content: string): string[] {
  return sessionsIn(content).map((s) => s.session_id);
}

function readBounded(file: string): string | null {
  try {
    const size = fs.statSync(file).size;
    if (size <= MAX_LOG_SCAN_BYTES) return fs.readFileSync(file, 'utf-8');
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.allocUnsafe(MAX_LOG_SCAN_BYTES);
      const read = fs.readSync(fd, buffer, 0, MAX_LOG_SCAN_BYTES, 0);
      return buffer.subarray(0, read).toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * session id → dispatch attribution, across every sched project under
 * `schedRoot` (`~/.dossier/sched`). Logs last modified before `sinceMs`
 * cannot hold a session active in the window and are skipped unread.
 */
export function indexDispatchLogs(schedRoot: string, sinceMs: number): Map<string, DispatchRef> {
  const index = new Map<string, DispatchRef>();
  for (const project of safeReaddir(schedRoot)) {
    if (!project.isDirectory()) continue;
    const runsDir = path.join(schedRoot, project.name, 'runs');
    for (const entry of safeReaddir(runsDir)) {
      if (!entry.isFile()) continue;
      const parsed = parseDispatchLogName(entry.name);
      if (!parsed) continue;
      const log = path.join(runsDir, entry.name);
      if ((mtimeMs(log) ?? 0) < sinceMs) continue;
      const content = readBounded(log);
      if (!content) continue;
      for (const { session_id, model } of sessionsIn(content)) {
        index.set(session_id, { session_id, ...parsed, project: project.name, model, log });
      }
    }
  }
  return index;
}

/**
 * Stamp dispatch attribution onto rows in place. A subagent/child session
 * inherits its parent's dispatch (a batch member's opencode child session is
 * still that member's spend). Dispatch attribution replaces the branch
 * heuristic; a row whose store recorded no model falls back to the
 * preamble's model.
 */
export function applyDispatchIndex(rows: UsageRow[], index: Map<string, DispatchRef>): void {
  if (index.size === 0) return;
  // session → parent, so a grandchild (a subagent's own subagent) still
  // reaches the dispatched root.
  const parentOf = new Map<string, string>();
  for (const row of rows) {
    if (row.parent_session_id) parentOf.set(row.session_id, row.parent_session_id);
  }
  const refFor = (session: string): DispatchRef | undefined => {
    let current: string | undefined = session;
    for (let depth = 0; current && depth < 16; depth++) {
      const ref = index.get(current);
      if (ref) return ref;
      current = parentOf.get(current);
    }
    return undefined;
  };
  for (const row of rows) {
    const ref =
      refFor(row.session_id) ?? (row.parent_session_id ? refFor(row.parent_session_id) : undefined);
    if (!ref) continue;
    row.unit = ref.unit;
    row.batch = ref.batch;
    if (ref.issue !== null) {
      row.issue = ref.issue;
      row.issue_source = 'dispatch';
    }
    if (row.model === null && ref.model) row.model = ref.model;
  }
}

/**
 * Provider named by a limit message — sched events record none, but the
 * provider's own wording does (`claude.ai/settings/usage` → anthropic). Null
 * when it cannot be told, so the view compares against every provider.
 */
export function providerFromText(text: string): string | null {
  if (/claude|anthropic/i.test(text)) return 'anthropic';
  if (/openai|chatgpt|codex/i.test(text)) return 'openai';
  if (/z\.ai|zhipu|glm/i.test(text)) return 'zai';
  if (/alibaba|dashscope|qwen/i.test(text)) return 'alibaba';
  return null;
}

/** sched `dispatch-failure` / `dispatch-unhealthy` limit walls in `[sinceMs, untilMs)`. */
export function collectSchedLimitEvents(
  schedRoot: string,
  sinceMs: number,
  untilMs: number,
  host: string
): LimitEvent[] {
  const out: LimitEvent[] = [];
  for (const project of safeReaddir(schedRoot)) {
    if (!project.isDirectory()) continue;
    const file = path.join(schedRoot, project.name, 'events.jsonl');
    if ((mtimeMs(file) ?? 0) < sinceMs) continue;
    forEachLine(file, (line) => {
      if (!line.includes('"dispatch-')) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.event !== 'dispatch-failure' && event.event !== 'dispatch-unhealthy') return;
      const ts = typeof event.ts === 'string' ? event.ts : null;
      const tsMs = ts ? Date.parse(ts) : Number.NaN;
      if (!ts || Number.isNaN(tsMs) || tsMs < sinceMs || tsMs >= untilMs) return;
      const status = typeof event.api_error_status === 'number' ? event.api_error_status : null;
      const detail = oneLine(event.detail);
      if (status !== 429 && !LIMIT_TEXT_RE.test(detail)) return;
      out.push({
        ts,
        host,
        source: 'sched',
        provider: providerFromText(detail),
        session_id: null,
        unit: typeof event.unit === 'string' ? event.unit : null,
        status,
        detail: `[${project.name}] ${event.event}: ${detail}`,
      });
    });
  }
  return out;
}

/** session id → number of `ai-dossier run` invocations recorded from it in `[sinceMs, untilMs)`. */
export function countDossierRuns(
  runsLog: string,
  sinceMs: number,
  untilMs: number
): Map<string, number> {
  const counts = new Map<string, number>();
  if ((mtimeMs(runsLog) ?? 0) < sinceMs) return counts;
  forEachLine(runsLog, (line) => {
    if (!line.includes('"session_id"')) return;
    let entry: RunLogEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (!entry.session_id) return;
    const tsMs = Date.parse(entry.timestamp);
    if (Number.isNaN(tsMs) || tsMs < sinceMs || tsMs >= untilMs) return;
    counts.set(entry.session_id, (counts.get(entry.session_id) ?? 0) + 1);
  });
  return counts;
}
