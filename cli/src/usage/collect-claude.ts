/**
 * Claude Code collector (#769): per-message usage from the session
 * transcripts under `~/.claude/projects/<slug>/`.
 *
 * Layout read (never written):
 *   <slug>/<sessionId>.jsonl                          — a top-level session
 *   <slug>/<sessionId>/subagents/agent-<id>.jsonl     — its subagents (sidechains)
 *   <slug>/<sessionId>/subagents/agent-<id>.meta.json — subagent type/description
 *
 * Claude Code writes one transcript line per content block, each repeating
 * the message's `usage`; rows are deduplicated on `message.id:requestId`
 * (ccusage's key) so a multi-block message is counted once — also across
 * files, since a subagent's messages must not be double-counted if the
 * parent transcript ever echoes them.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LimitEvent, UsageRow } from './types';
import {
  count,
  forEachLine,
  issueFromRef,
  LIMIT_TEXT_RE,
  mtimeMs,
  oneLine,
  projectOf,
  safeReaddir,
} from './util';

/** Claude Code's placeholder model on locally synthesized (API-error) messages — carries zero tokens. */
const SYNTHETIC_MODEL = '<synthetic>';

export interface ClaudeCollectOptions {
  /** `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`). */
  projectsDir: string;
  /** Only messages at/after this time are collected; files older than it are skipped unread. */
  sinceMs: number;
  /** Only messages before this time (default: no upper bound). */
  untilMs?: number;
  host: string;
}

export interface ClaudeCollectResult {
  rows: UsageRow[];
  limits: LimitEvent[];
  files: number;
}

/** Default Claude Code projects dir, honouring `CLAUDE_CONFIG_DIR`. */
export function defaultClaudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

interface TranscriptFile {
  file: string;
  /** Set for a subagent transcript: the parent session id (the directory name). */
  parentSession: string | null;
  title: string | null;
}

function subagentTitle(jsonlFile: string): string | null {
  try {
    const meta = JSON.parse(fs.readFileSync(jsonlFile.replace(/\.jsonl$/, '.meta.json'), 'utf-8'));
    const parts = [meta?.agentType, meta?.description].filter(
      (p): p is string => typeof p === 'string' && p.length > 0
    );
    return parts.length > 0 ? oneLine(parts.join(': '), 120) : null;
  } catch {
    return null;
  }
}

/** Every transcript modified at/after `sinceMs` — the incremental prefilter. */
export function listClaudeTranscripts(projectsDir: string, sinceMs: number): TranscriptFile[] {
  const out: TranscriptFile[] = [];
  const fresh = (file: string) => (mtimeMs(file) ?? 0) >= sinceMs;
  for (const project of safeReaddir(projectsDir)) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(projectsDir, project.name);
    for (const entry of safeReaddir(projectDir)) {
      const full = path.join(projectDir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        if (fresh(full)) out.push({ file: full, parentSession: null, title: null });
      } else if (entry.isDirectory()) {
        const subDir = path.join(full, 'subagents');
        for (const sub of safeReaddir(subDir)) {
          const subFile = path.join(subDir, sub.name);
          if (sub.isFile() && sub.name.endsWith('.jsonl') && fresh(subFile)) {
            out.push({ file: subFile, parentSession: entry.name, title: subagentTitle(subFile) });
          }
        }
      }
    }
  }
  return out;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : ''
    )
    .join(' ');
}

/** HTTP status embedded in an API-error message (`API Error: 429 …`), else null. */
function statusOf(record: Record<string, unknown>, text: string): number | null {
  const explicit = record.apiErrorStatus ?? record.status;
  if (typeof explicit === 'number') return explicit;
  const match = text.match(/\b(4\d\d|5\d\d)\b/);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Parse the transcripts into usage rows and limit events. Read-only; files
 * that cannot be read are skipped (their rows are simply absent).
 */
export function collectClaude(opts: ClaudeCollectOptions): ClaudeCollectResult {
  const rows: UsageRow[] = [];
  const limits: LimitEvent[] = [];
  // key → the row already emitted for that message (see the repeat handling below)
  const seen = new Map<string, UsageRow>();
  const untilMs = opts.untilMs ?? Number.POSITIVE_INFINITY;
  const files = listClaudeTranscripts(opts.projectsDir, opts.sinceMs);

  for (const transcript of files) {
    const fileSession = path.basename(transcript.file, '.jsonl');
    forEachLine(transcript.file, (line) => {
      // Cheap prefilter: only assistant records carry usage or API errors.
      if (!line.includes('"assistant"')) return;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line);
      } catch {
        return;
      }
      if (record.type !== 'assistant') return;
      const ts = typeof record.timestamp === 'string' ? record.timestamp : null;
      const tsMs = ts ? Date.parse(ts) : Number.NaN;
      if (!ts || Number.isNaN(tsMs) || tsMs < opts.sinceMs || tsMs >= untilMs) return;

      const message = (record.message ?? {}) as Record<string, unknown>;
      const sessionId =
        typeof record.sessionId === 'string' && record.sessionId ? record.sessionId : fileSession;
      const agentId = typeof record.agentId === 'string' && record.agentId ? record.agentId : null;
      const isSubagent = transcript.parentSession !== null || record.isSidechain === true;
      const session_id = isSubagent && agentId ? `${sessionId}/${agentId}` : sessionId;
      const parent_session_id = isSubagent
        ? (transcript.parentSession ?? (agentId ? sessionId : null))
        : null;

      if (record.isApiErrorMessage === true) {
        const text = textOf(message.content);
        const error = typeof record.error === 'string' ? record.error : '';
        if (LIMIT_TEXT_RE.test(text) || /rate_limit|overloaded/i.test(error)) {
          limits.push({
            ts,
            host: opts.host,
            source: 'claude-code',
            provider: 'anthropic',
            session_id,
            unit: null,
            status: statusOf(record, text),
            detail: oneLine(text || error),
          });
        }
        return;
      }

      const usage = message.usage as Record<string, unknown> | undefined;
      if (!usage || typeof usage !== 'object') return;
      const model = typeof message.model === 'string' && message.model ? message.model : null;
      if (model === SYNTHETIC_MODEL) return;

      const messageId = typeof message.id === 'string' ? message.id : null;
      const requestId = typeof record.requestId === 'string' ? record.requestId : null;
      const key = messageId
        ? `${messageId}:${requestId ?? ''}`
        : typeof record.uuid === 'string'
          ? `uuid:${record.uuid}`
          : null;
      const input = count(usage.input_tokens);
      const output = count(usage.output_tokens);
      const cache_read = count(usage.cache_read_input_tokens);
      const cache_write = count(usage.cache_creation_input_tokens);
      const prior = key ? seen.get(key) : undefined;
      if (prior) {
        // A repeat line of an already-counted message. Earlier content-block
        // lines carry a PARTIAL `output_tokens` (streaming); later ones the
        // final count — so keep the max of each field, never the first line's.
        prior.input = Math.max(prior.input, input);
        prior.output = Math.max(prior.output, output);
        prior.cache_read = Math.max(prior.cache_read, cache_read);
        prior.cache_write = Math.max(prior.cache_write, cache_write);
        return;
      }

      const cwd = typeof record.cwd === 'string' ? record.cwd : null;
      const branch =
        typeof record.gitBranch === 'string' && record.gitBranch ? record.gitBranch : null;
      const issue = issueFromRef(branch) ?? issueFromRef(cwd ? path.basename(cwd) : null);
      const row: UsageRow = {
        ts,
        host: opts.host,
        provider: 'anthropic',
        model,
        input,
        output,
        reasoning: 0,
        cache_read,
        cache_write,
        cost_usd: typeof record.costUSD === 'number' ? record.costUSD : null,
        source: 'claude-code',
        session_id,
        parent_session_id,
        title: transcript.title,
        cwd,
        project: projectOf(cwd),
        branch,
        issue,
        issue_source: issue === null ? null : 'branch',
        batch: null,
        unit: null,
      };
      if (key) seen.set(key, row);
      rows.push(row);
    });
  }
  return { rows, limits, files: files.length };
}
