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
 *   Subagents share the parent's id, so the caller is the transcript whose
 *   newest tool call is a still-pending `ai-dossier run` (else the recently
 *   active transcripts' model when they all agree; null when they don't).
 * - Both markers are inherited by child processes, so the NEAREST host
 *   ancestor (`CLAUDE_PID` / `OPENCODE_PID` via /proc) wins.
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

/** Transcripts written within this long of the newest one are "concurrently active" candidates. */
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;
const DOSSIER_RUN_RE = /\b(?:ai-)?dossier\s+run\b/;

/** Every transcript (main + subagents) of `sessionId`, with mtimes. */
function claudeTranscripts(
  projectsDir: string,
  sessionId: string
): { file: string; mtime: number }[] {
  const out: { file: string; mtime: number }[] = [];
  const consider = (file: string) => {
    const mtime = mtimeMs(file);
    if (mtime !== null) out.push({ file, mtime });
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
  return out;
}

/**
 * Whether a transcript's newest tool call is a still-pending `ai-dossier run`
 * — i.e. this transcript's agent is the one executing us right now: the
 * command is in a `tool_use` block whose `tool_result` has not been written.
 */
export function hasPendingDossierRun(transcript: string): boolean {
  const lines = tail(transcript, TAIL_BYTES).split('\n');
  const answered = new Set<string>();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('tool_')) continue;
    let record: { type?: unknown; message?: { content?: unknown } };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const content = Array.isArray(record.message?.content) ? record.message.content : [];
    for (const block of content as Record<string, unknown>[]) {
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        answered.add(block.tool_use_id);
      }
      if (block?.type === 'tool_use' && typeof block.id === 'string' && !answered.has(block.id)) {
        const command = (block.input as { command?: unknown } | undefined)?.command;
        if (typeof command === 'string' && DOSSIER_RUN_RE.test(command)) return true;
      }
    }
    if (
      record.type === 'assistant' &&
      content.some((b) => (b as { type?: unknown })?.type === 'tool_use')
    ) {
      // Only the newest tool-calling turn can be the one invoking us.
      return false;
    }
  }
  return false;
}

/**
 * The model of the Claude Code agent invoking us. Subagents share their
 * parent's `CLAUDE_CODE_SESSION_ID`, so "newest transcript" alone can pick a
 * concurrent sibling: prefer the one transcript with a pending `ai-dossier
 * run` call; otherwise accept the recently-active candidates' model only when
 * they all agree — a guess between different models records null.
 */
export function claudeHostModel(projectsDir: string, sessionId: string): string | null {
  const all = claudeTranscripts(projectsDir, sessionId);
  if (all.length === 0) return null;
  const newest = Math.max(...all.map((t) => t.mtime));
  const active = all.filter((t) => t.mtime >= newest - ACTIVE_WINDOW_MS);
  const pending = active.filter((t) => hasPendingDossierRun(t.file));
  if (pending.length === 1) return lastAssistantModel(pending[0].file);
  const pool = pending.length > 1 ? pending : active;
  const models = new Set(pool.map((t) => lastAssistantModel(t.file)));
  if (models.size !== 1) return null;
  return [...models][0];
}

/** `/proc/<pid>/stat` parent pid, or null (non-Linux, gone, unreadable). */
function parentPid(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    // comm (field 2) may contain spaces/parens — parse after the LAST ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number.parseInt(fields[1], 10);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

/** Sentinel depth for "cannot tell" (no pid given, or no /proc): trusted, but loses to a proven ancestor. */
const UNKNOWN_DEPTH = Number.MAX_SAFE_INTEGER;

/**
 * How many generations up `pid` is from this process: a number when it is a
 * proven ancestor, null when it provably is not (an inherited env marker from
 * an unrelated outer host), UNKNOWN_DEPTH when it cannot be told.
 */
export function ancestorDepth(
  pidText: string | undefined,
  self: number = process.pid
): number | null {
  const pid = pidText ? Number.parseInt(pidText, 10) : Number.NaN;
  if (!Number.isFinite(pid) || !fs.existsSync(`/proc/${self}/stat`)) return UNKNOWN_DEPTH;
  let current: number | null = self;
  for (let depth = 0; depth < 64 && current !== null && current > 1; depth++) {
    if (current === pid) return depth;
    current = parentPid(current);
  }
  return null;
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
    // Child processes inherit BOTH hosts' markers (e.g. an opencode agent
    // dispatched by a sched daemon started from a Claude Code shell), so pick
    // the NEAREST host ancestor, not whichever marker is checked first.
    const claudeDepth =
      env.CLAUDECODE === '1' || env.CLAUDE_CODE === '1' ? ancestorDepth(env.CLAUDE_PID) : null;
    const opencodeDepth = env.OPENCODE === '1' ? ancestorDepth(env.OPENCODE_PID) : null;
    const useClaude =
      claudeDepth !== null && (opencodeDepth === null || claudeDepth <= opencodeDepth);
    if (useClaude) {
      const id = env.CLAUDE_CODE_SESSION_ID;
      if (!id || !CLAUDE_SESSION_RE.test(id)) {
        return { agent: 'claude-code', session_id: null, model: null };
      }
      return {
        agent: 'claude-code',
        session_id: id,
        model: claudeHostModel(opts.claudeProjectsDir ?? defaultClaudeProjectsDir(env), id),
      };
    }
    if (opencodeDepth !== null) {
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
