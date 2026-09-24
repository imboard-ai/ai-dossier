/**
 * Resolve the agent host an `ai-dossier run` was invoked from — session id
 * and the model it is running — so `runs.jsonl` records a concrete model
 * instead of null (#769, "fix at the source").
 *
 * ~99% of `runs.jsonl` rows are `llm: auto` invocations made BY a host agent
 * (Claude Code, opencode) that then follows the printed dossier itself; no
 * agent is spawned, so nothing reported a model. The host's own store knows
 * it:
 *
 * - Claude Code exports `CLAUDE_CODE_SESSION_ID`; its transcript
 *   (`~/.claude/projects/<slug>/<id>.jsonl`, or a subagent's under
 *   `<id>/subagents/`) records each assistant message's resolved `model`.
 *   The newest transcript of that session is the one that just issued the
 *   `ai-dossier run` tool call, so its last assistant model is the caller's.
 * - opencode exports `OPENCODE=1` but no session id; the newest session for
 *   this working directory in opencode.db (updated in the last few minutes)
 *   is the caller.
 *
 * Best effort and bounded: every failure yields nulls, never an exception.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defaultClaudeProjectsDir } from './collect-claude';
import { defaultOpenCodeDbPath, loadNodeSqlite } from './collect-opencode';
import { mtimeMs, safeReaddir } from './util';

export interface HostSession {
  agent: 'claude-code' | 'opencode' | null;
  session_id: string | null;
  model: string | null;
}

const NONE: HostSession = { agent: null, session_id: null, model: null };

/** Bytes read from a transcript's tail when looking for the latest model. */
const TAIL_BYTES = 256 * 1024;
/** An opencode session older than this is not the one invoking us. */
const OPENCODE_RECENT_MS = 10 * 60 * 1000;

const CLAUDE_SESSION_RE = /^[0-9a-f-]{36}$/i;

function tail(file: string, bytes: number): string {
  let fd: number | null = null;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.allocUnsafe(size - start);
    fd = fs.openSync(file, 'r');
    const read = fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.subarray(0, read).toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** The last real (non-synthetic) assistant `message.model` in a transcript's tail. */
export function lastAssistantModel(transcript: string): string | null {
  const lines = tail(transcript, TAIL_BYTES).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"assistant"') || !line.includes('"model"')) continue;
    try {
      const record = JSON.parse(line);
      const model = record?.message?.model;
      if (
        record?.type === 'assistant' &&
        typeof model === 'string' &&
        model &&
        model !== '<synthetic>'
      ) {
        return model;
      }
    } catch {
      // partial first line of the tail window, or a malformed line
    }
  }
  return null;
}

/** Newest transcript file (main or subagent) belonging to `sessionId`, or null. */
export function findClaudeTranscript(projectsDir: string, sessionId: string): string | null {
  let best: { file: string; mtime: number } | null = null;
  const consider = (file: string) => {
    const mtime = mtimeMs(file);
    if (mtime !== null && (!best || mtime > best.mtime)) best = { file, mtime };
  };
  for (const project of safeReaddir(projectsDir)) {
    if (!project.isDirectory()) continue;
    const dir = path.join(projectsDir, project.name);
    consider(path.join(dir, `${sessionId}.jsonl`));
    const subDir = path.join(dir, sessionId, 'subagents');
    for (const sub of safeReaddir(subDir)) {
      if (sub.isFile() && sub.name.endsWith('.jsonl')) consider(path.join(subDir, sub.name));
    }
  }
  return (best as { file: string } | null)?.file ?? null;
}

function openCodeSession(dbFile: string, cwd: string, nowMs: number): HostSession {
  const base: HostSession = { agent: 'opencode', session_id: null, model: null };
  const sqlite = loadNodeSqlite();
  if (!sqlite || !fs.existsSync(dbFile)) return base;
  try {
    const db = new sqlite.DatabaseSync(dbFile, { readOnly: true });
    try {
      const session = db
        .prepare(
          'SELECT id FROM session WHERE directory = ? AND time_updated >= ? ORDER BY time_updated DESC LIMIT 1'
        )
        .all(cwd, nowMs - OPENCODE_RECENT_MS)[0] as { id?: string } | undefined;
      if (!session?.id) return base;
      const message = db
        .prepare(
          'SELECT data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 20'
        )
        .all(session.id) as { data: string }[];
      for (const { data } of message) {
        try {
          const parsed = JSON.parse(data);
          if (parsed?.role === 'assistant' && typeof parsed.modelID === 'string') {
            const model =
              typeof parsed.providerID === 'string'
                ? `${parsed.providerID}/${parsed.modelID}`
                : parsed.modelID;
            return { ...base, session_id: session.id, model };
          }
        } catch {
          // skip malformed payloads
        }
      }
      return { ...base, session_id: session.id };
    } finally {
      db.close();
    }
  } catch {
    return base;
  }
}

export interface DetectHostOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  nowMs?: number;
  claudeProjectsDir?: string;
  opencodeDb?: string;
}

/** Identify the invoking agent host, its session, and its current model. Never throws. */
export function detectHostSession(opts: DetectHostOptions = {}): HostSession {
  const env = opts.env ?? process.env;
  try {
    if (env.CLAUDECODE === '1' || env.CLAUDE_CODE === '1') {
      const id = env.CLAUDE_CODE_SESSION_ID;
      if (!id || !CLAUDE_SESSION_RE.test(id)) {
        return { agent: 'claude-code', session_id: null, model: null };
      }
      const transcript = findClaudeTranscript(
        opts.claudeProjectsDir ?? defaultClaudeProjectsDir(env),
        id
      );
      return {
        agent: 'claude-code',
        session_id: id,
        model: transcript ? lastAssistantModel(transcript) : null,
      };
    }
    if (env.OPENCODE === '1') {
      return openCodeSession(
        opts.opencodeDb ?? defaultOpenCodeDbPath(env),
        opts.cwd ?? process.cwd(),
        opts.nowMs ?? Date.now()
      );
    }
  } catch {
    // fall through
  }
  return NONE;
}
