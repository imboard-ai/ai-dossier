/**
 * Where a Claude Code subagent actually worked (#803).
 *
 * A subagent transcript's records repeat the cwd / gitBranch of the session
 * that spawned it, so a fleet member launched from an orchestrator in repo A
 * but working in repo B looked like it ran in A. The truth is in the
 * subagent's own transcript: the paths its first tool calls touch, and the
 * prompt it was given.
 */

import * as path from 'node:path';
import { forEachLine, oneLine } from './util';

export interface SubagentOrigin {
  /** Checkout root the subagent worked in (worktree or `<project>/main`), or null when nothing was inferred. */
  cwd: string | null;
  /** Issue named by the subagent's own prompt, or null. */
  promptIssue: number | null;
}

/** Absolute paths that are never a project checkout. */
const IGNORED_ROOTS =
  /^(?:\/tmp\/|\/var\/|\/usr\/|\/etc\/|\/proc\/|.*\/\.claude\/|.*\/node_modules\/)/;

/** The worktree / `main` checkout a path lives in, or null when it is neither. */
export function checkoutRootOf(p: string): string | null {
  if (!path.isAbsolute(p) || IGNORED_ROOTS.test(p)) return null;
  const wt = p.match(/^(.*\/worktrees\/[^/\s'"`]+)/);
  if (wt) return wt[1];
  const main = p.match(/^(.*\/[^/\s'"`]+\/main)(?:\/|$)/);
  return main ? main[1] : null;
}

const ABS_PATH_RE = /(?:^|[\s='"`(:])(\/[\w.@+-]+(?:\/[\w.@+-]+)+)/g;

function rootsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ABS_PATH_RE)) {
    const root = checkoutRootOf(m[1]);
    if (root) out.push(root);
  }
  return out;
}

/**
 * The first explicit issue reference in free text: `issue #N`, `issue N`,
 * `#N`, or the `Full cycle <repo> N` title shape. Heuristic, so callers
 * label it `issue_source: 'prompt'`.
 */
export function issueFromText(text: string | null | undefined): number | null {
  if (!text) return null;
  const m =
    text.match(/\bissues?\s*#?\s*([1-9]\d{1,5})\b/i) ??
    text.match(/(?:^|[^\w&/])#([1-9]\d{1,5})\b/) ??
    text.match(/\bfull[ -]cycle\b[^\d\n]{0,60}?\b([1-9]\d{1,5})\b/i);
  return m ? Number.parseInt(m[1], 10) : null;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) =>
      b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
        ? (b as { text: string }).text
        : ''
    )
    .join(' ');
}

/** Path-bearing strings of a tool call: `cd`/`-C` targets, file paths, whole commands. */
function toolInputText(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  return ['file_path', 'path', 'cwd', 'notebook_path', 'command']
    .map((k) => (typeof i[k] === 'string' ? (i[k] as string) : ''))
    .join(' ');
}

/**
 * Scan a subagent transcript for its own working checkout (first tool call
 * that touches one, else a checkout named in the prompt) and the issue its
 * prompt names. Stops reading as soon as both are settled.
 */
export function inferSubagentOrigin(file: string): SubagentOrigin {
  let prompt: string | null = null;
  let toolRoot: string | null = null;
  forEachLine(file, (line) => {
    if (toolRoot && prompt !== null) return;
    if (prompt === null && line.includes('"user"')) {
      try {
        const rec = JSON.parse(line);
        if (rec.type === 'user') prompt = textOf(rec.message?.content);
      } catch {
        // skip
      }
    }
    if (toolRoot || !line.includes('"tool_use"')) return;
    try {
      const rec = JSON.parse(line);
      const blocks = Array.isArray(rec.message?.content) ? rec.message.content : [];
      for (const b of blocks) {
        if (b?.type !== 'tool_use') continue;
        const root = rootsIn(toolInputText(b.input))[0];
        if (root) {
          toolRoot = root;
          return;
        }
      }
    } catch {
      // skip
    }
  });
  const promptText: string = prompt ?? '';
  const cwd = toolRoot ?? rootsIn(promptText)[0] ?? null;
  return { cwd, promptIssue: issueFromText(oneLine(promptText, 4000)) };
}
