/**
 * Small shared helpers for the usage collectors (#769).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Bytes read per chunk by {@link forEachLine} — bounded memory regardless of file size. */
const LINE_CHUNK_BYTES = 1024 * 1024;

/**
 * Call `onLine` for every line of `file`, reading it in fixed-size chunks so a
 * multi-hundred-MB transcript never has to fit in memory as one string.
 * Never throws: an unreadable file yields no lines and returns false.
 */
export function forEachLine(file: string, onLine: (line: string) => void): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.allocUnsafe(LINE_CHUNK_BYTES);
    let carry = Buffer.alloc(0);
    let read = 0;
    do {
      read = fs.readSync(fd, buffer, 0, LINE_CHUNK_BYTES, null);
      let chunk = read > 0 ? Buffer.concat([carry, buffer.subarray(0, read)]) : carry;
      let start = 0;
      for (let nl = chunk.indexOf(10, start); nl !== -1; nl = chunk.indexOf(10, start)) {
        const line = chunk.subarray(start, nl).toString('utf-8');
        if (line) onLine(line);
        start = nl + 1;
      }
      chunk = chunk.subarray(start);
      if (read === 0) {
        if (chunk.length > 0) onLine(chunk.toString('utf-8'));
        break;
      }
      carry = Buffer.from(chunk);
    } while (read > 0);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/** Directory entries of `dir`, or `[]` when it does not exist / cannot be read. */
export function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** File mtime in ms, or null when the file cannot be stat'ed. */
export function mtimeMs(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * A short project name for a working directory: the directory that holds a
 * `worktrees/` checkout (`…/ai-dossier/worktrees/feat-x` → `ai-dossier`), the
 * parent of a `main/` worktree (`…/ai-dossier/main` → `ai-dossier`), else the
 * directory's own basename.
 */
export function projectOf(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const parts = path.resolve(cwd).split(path.sep).filter(Boolean);
  const wt = parts.lastIndexOf('worktrees');
  if (wt > 0) return parts[wt - 1];
  const last = parts[parts.length - 1];
  if (last === 'main' && parts.length > 1) return parts[parts.length - 2];
  return last ?? null;
}

/**
 * The issue number a branch or worktree name refers to — `feat/769-usage`,
 * `fix-4360-x`, `issue-12` — or null. Heuristic by nature (callers label it
 * `issue_source: 'branch'`): it takes the first 2–6 digit number without a
 * leading zero that stands alone between separators, which skips date-like
 * batch ids (`b-20260920-01`) and pool worktree timestamps.
 */
export function issueFromRef(ref: string | null | undefined): number | null {
  if (!ref) return null;
  const match = ref.match(/(?:^|[/_-])(?:issue-?|gh-?)?([1-9]\d{1,5})(?=$|[/_-])/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

/** Non-negative finite number, else 0 — source stores are untrusted JSON. */
export function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Trim a free-text field from an untrusted store to one short line. */
export function oneLine(text: unknown, max = 200): string {
  const s = typeof text === 'string' ? text : '';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Matches provider limit / rate-limit wording in error text. */
export const LIMIT_TEXT_RE =
  /usage limit|rate[ -]?limit|spend limit|hit your (?:\w+ )?limit|limit reached|limit will reset|limit resets|quota|too many requests|\b429\b/i;
