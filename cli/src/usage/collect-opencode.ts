/**
 * opencode collector (#769): per-message usage from opencode's SQLite store
 * (`~/.local/share/opencode/opencode.db`, `message.data` JSON with
 * `modelID`/`providerID`/`tokens`/`cost`).
 *
 * Read-only by construction: the database is opened with `readOnly: true`.
 * The store can be very large (14 GB observed on hcc) and `message` has no
 * time index, so the query never scans `message` by time — it selects the
 * (small) `session` table by `time_updated`, then reads each session's
 * messages through the `(session_id, time_created, id)` index.
 *
 * Uses the built-in `node:sqlite` (Node >= 22.13 unflagged). Where it is
 * unavailable (Node 20) the collector reports `unavailable` rather than
 * failing the whole view.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UsageRow } from './types';
import { count, issueFromRef, projectOf } from './util';

/** Session metadata the collector needs. */
export interface OpenCodeSession {
  id: string;
  parent_id: string | null;
  directory: string | null;
  title: string | null;
}

/** One `message` row as stored (`data` is the JSON payload). */
export interface OpenCodeMessage {
  id: string;
  time_created: number;
  data: string;
}

/** The narrow read surface the collector uses — injectable for tests. */
export interface OpenCodeReader {
  sessionsUpdatedSince(sinceMs: number): OpenCodeSession[];
  messagesSince(sessionId: string, sinceMs: number): OpenCodeMessage[];
  close(): void;
}

export type OpenCodeOpenResult =
  | { status: 'ok'; reader: OpenCodeReader }
  | { status: 'unavailable' | 'error'; detail: string };

/** Default opencode DB path, honouring `OPENCODE_DB` and `XDG_DATA_HOME`. */
export function defaultOpenCodeDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_DB) return env.OPENCODE_DB;
  const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'opencode', 'opencode.db');
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type SqliteModule = {
  DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => SqliteDatabase;
};

/** `node:sqlite`, or null on a runtime without it. */
export function loadNodeSqlite(): SqliteModule | null {
  try {
    // Lazy: a static import would crash the whole CLI on Node 20.
    return require('node:sqlite') as SqliteModule;
  } catch {
    return null;
  }
}

/** Open `dbFile` read-only. Never throws. */
export function openOpenCodeDb(
  dbFile: string,
  sqlite: SqliteModule | null = loadNodeSqlite()
): OpenCodeOpenResult {
  if (!fs.existsSync(dbFile)) return { status: 'unavailable', detail: `no database at ${dbFile}` };
  if (!sqlite) {
    return {
      status: 'unavailable',
      detail: `node:sqlite not available in Node ${process.versions.node} (needs >= 22.13)`,
    };
  }
  let db: SqliteDatabase;
  try {
    db = new sqlite.DatabaseSync(dbFile, { readOnly: true });
  } catch (err) {
    return { status: 'error', detail: `cannot open ${dbFile}: ${(err as Error).message}` };
  }
  const sessions = db.prepare(
    'SELECT id, parent_id, directory, title FROM session WHERE time_updated >= ?'
  );
  const messages = db.prepare(
    'SELECT id, time_created, data FROM message WHERE session_id = ? AND time_created >= ? ORDER BY time_created'
  );
  return {
    status: 'ok',
    reader: {
      sessionsUpdatedSince: (sinceMs) => sessions.all(sinceMs) as OpenCodeSession[],
      messagesSince: (sessionId, sinceMs) => messages.all(sessionId, sinceMs) as OpenCodeMessage[],
      close: () => db.close(),
    },
  };
}

export interface OpenCodeCollectOptions {
  reader: OpenCodeReader;
  sinceMs: number;
  untilMs?: number;
  host: string;
}

/**
 * Usage rows for every assistant message with non-zero tokens in sessions
 * active since `sinceMs`. A message still streaming (all-zero tokens) is
 * skipped rather than recorded as a zero row.
 */
export function collectOpenCode(opts: OpenCodeCollectOptions): UsageRow[] {
  const rows: UsageRow[] = [];
  const untilMs = opts.untilMs ?? Number.POSITIVE_INFINITY;
  for (const session of opts.reader.sessionsUpdatedSince(opts.sinceMs)) {
    for (const message of opts.reader.messagesSince(session.id, opts.sinceMs)) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(message.data);
      } catch {
        continue;
      }
      if (data.role !== 'assistant') continue;
      const tokens = (data.tokens ?? {}) as Record<string, unknown>;
      const cache = (tokens.cache ?? {}) as Record<string, unknown>;
      const input = count(tokens.input);
      const output = count(tokens.output);
      const reasoning = count(tokens.reasoning);
      const cache_read = count(cache.read);
      const cache_write = count(cache.write);
      if (input + output + reasoning + cache_read + cache_write === 0) continue;

      const time = (data.time ?? {}) as Record<string, unknown>;
      const tsMs = typeof time.completed === 'number' ? time.completed : message.time_created;
      if (tsMs < opts.sinceMs || tsMs >= untilMs) continue;

      const pathInfo = (data.path ?? {}) as Record<string, unknown>;
      const cwd = typeof pathInfo.cwd === 'string' ? pathInfo.cwd : session.directory;
      const providerID = typeof data.providerID === 'string' ? data.providerID : null;
      const modelID = typeof data.modelID === 'string' ? data.modelID : null;
      const issue = issueFromRef(cwd ? path.basename(cwd) : null);
      rows.push({
        ts: new Date(tsMs).toISOString(),
        host: opts.host,
        provider: providerID ?? 'opencode',
        // `provider/model` — the same id shape opencode's own `-m` flag takes.
        model: modelID ? (providerID ? `${providerID}/${modelID}` : modelID) : null,
        input,
        output,
        reasoning,
        cache_read,
        cache_write,
        cost_usd: typeof data.cost === 'number' ? data.cost : null,
        source: 'opencode',
        session_id: session.id,
        parent_session_id: session.parent_id ?? null,
        title: session.title,
        cwd,
        project: projectOf(cwd),
        branch: null,
        issue,
        issue_source: issue === null ? null : 'branch',
        batch: null,
        unit: null,
      });
    }
  }
  return rows;
}
