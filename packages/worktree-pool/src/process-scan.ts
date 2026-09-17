import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Kill processes rooted inside a worktree (or the whole pool directory),
 * so a verification-step dev server, jest run, or vite server does not
 * outlive the worktree that spawned it (imboard-ai/ai-dossier#760).
 *
 * Linux is the primary target (host timers and CI both run there): a
 * process is "rooted" under a path when its cwd (`/proc/<pid>/cwd`) or its
 * command line (`/proc/<pid>/cmdline`) is under that path. Other platforms
 * fall back to `ps`, matching only the command line — there is no
 * dependency-free way to read another process's cwd there.
 *
 * Every lookup here excludes this process and its ancestor chain on Linux
 * (the `/proc` `PPid` walk): `return --path <wt>` can be invoked from a
 * shell whose own cwd is inside `<wt>`, and a pattern/path-based kill must
 * never be able to take out its own invoker (see docs/agent-traps.md's
 * `pkill -f` row — the same class of mistake, a different trigger). The
 * `ps` fallback (non-Linux) can only exclude this process itself — an
 * ancestor's cwd/ppid is not determinable without `/proc`.
 */

export interface WorktreeProcess {
  pid: number;
  /** Process cwd, when it could be read (Linux only). */
  cwd: string | null;
  /** Best-effort command line, space-joined. */
  command: string;
  /** Milliseconds since process start, or `null` when it could not be determined. */
  ageMs: number | null;
}

export interface KilledProcess {
  pid: number;
  command: string;
  signal: 'SIGTERM' | 'SIGKILL';
}

export interface KillResult {
  killed: KilledProcess[];
  errors: string[];
}

const HAS_PROC = process.platform === 'linux' && fs.existsSync('/proc');

/** Default SIGTERM-to-SIGKILL grace period, shared by every caller (return/gc/reap). */
export const DEFAULT_KILL_GRACE_MS = 5000;

/**
 * Thrown by {@link assertWorktreeKillRootSafe} — a kill root that fails the
 * safety check (imboard-ai/ai-dossier#763). Every current caller derives its
 * target correctly, so this should never fire in practice; it exists so a
 * future call site cannot skip the check by construction.
 */
export class UnsafeKillRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeKillRootError';
  }
}

function readCmdline(pid: number): string | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
    if (raw.length === 0) return null;
    const parts = raw
      .toString('utf-8')
      .split('\0')
      .filter((p) => p.length > 0);
    return parts.length > 0 ? parts.join(' ') : null;
  } catch {
    return null;
  }
}

const DELETED_SUFFIX = ' (deleted)';

/**
 * A process's cwd — surviving deletion of the directory it points at. This is
 * exactly the `reap` scenario (imboard-ai/ai-dossier#760): `gc` (pre-fix) or a
 * hand-run `git worktree remove` can delete a worktree directory while a
 * process still has it as cwd. Linux then reports the cwd symlink target as
 * `<original path> (deleted)` rather than failing the readlink — strip the
 * marker so the path still matches the worktree it was rooted in.
 */
function readCwd(pid: number): string | null {
  try {
    const link = fs.readlinkSync(`/proc/${pid}/cwd`);
    return link.endsWith(DELETED_SUFFIX) ? link.slice(0, -DELETED_SUFFIX.length) : link;
  } catch {
    return null;
  }
}

/**
 * Approximate process start time from `/proc/<pid>`'s own directory ctime.
 * Not exact (exact requires parsing `/proc/<pid>/stat`'s `starttime` field
 * against `/proc/uptime` and the kernel's clock ticks per second), but
 * adequate for the hour-granularity `--older-than` filtering `reap` does.
 */
function readStartTimeMs(pid: number): number | null {
  try {
    return fs.statSync(`/proc/${pid}`).ctimeMs;
  } catch {
    return null;
  }
}

function listPids(): number[] {
  try {
    return fs
      .readdirSync('/proc')
      .filter((name) => /^\d+$/.test(name))
      .map((name) => Number.parseInt(name, 10));
  } catch {
    return [];
  }
}

function readPpid(pid: number): number | null {
  try {
    const statusText = fs.readFileSync(`/proc/${pid}/status`, 'utf-8');
    const match = /^PPid:\s*(\d+)/m.exec(statusText);
    return match ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

/** This process and every ancestor up the ppid chain — never a kill candidate. */
function selfAndAncestorPids(): Set<number> {
  const pids = new Set<number>([process.pid]);
  if (!HAS_PROC) return pids;
  let current = process.pid;
  for (let i = 0; i < 64; i++) {
    const ppid = readPpid(current);
    if (ppid === null || ppid <= 1 || pids.has(ppid)) break;
    pids.add(ppid);
    current = ppid;
  }
  return pids;
}

/** True when `childAbs` is `rootAbs` itself or strictly inside it. */
function isUnder(childAbs: string, rootAbs: string): boolean {
  const rel = path.relative(rootAbs, childAbs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Universal floor for ANY kill/scan root, regardless of caller: never
 * operate on an empty path or a filesystem root (`/`, `C:\`, ...). Applied
 * inside {@link findWorktreeProcesses} itself so every caller gets it,
 * including `reap`'s whole-pool-directory scan.
 */
function assertNotEmptyOrRoot(rootAbsPath: string): string {
  if (!rootAbsPath || rootAbsPath.trim().length === 0) {
    throw new UnsafeKillRootError('refusing to scan for processes: empty path');
  }
  const resolved = path.resolve(rootAbsPath);
  if (resolved === path.parse(resolved).root) {
    throw new UnsafeKillRootError(
      `refusing to scan for processes: path resolves to a filesystem root (${resolved})`
    );
  }
  return resolved;
}

/**
 * Extra guard for a kill scoped to one SPECIFIC worktree — `return` and
 * `gc`, never `reap`'s pool-directory-wide scan (imboard-ai/ai-dossier#763).
 * Beyond the universal empty/root check, the target must not be the git
 * root itself and must be strictly INSIDE the pool directory — never the
 * pool directory itself, which would broaden a single-worktree kill to
 * everything the pool manages. Every current caller already derives this
 * path as `toAbs(poolDir, someTrackedId)`, so this should never fire; it
 * exists so a future call site cannot skip it by construction.
 */
export function assertWorktreeKillRootSafe(
  targetAbsPath: string,
  gitRootAbs: string,
  poolDirAbs: string
): string {
  const resolved = assertNotEmptyOrRoot(targetAbsPath);
  const resolvedGitRoot = path.resolve(gitRootAbs);
  const resolvedPoolDir = path.resolve(poolDirAbs);
  if (resolved === resolvedGitRoot) {
    throw new UnsafeKillRootError(
      `refusing to kill processes rooted at the git root itself (${resolved})`
    );
  }
  if (resolved === resolvedPoolDir || !isUnder(resolved, resolvedPoolDir)) {
    throw new UnsafeKillRootError(
      `refusing to kill processes at ${resolved}: not strictly inside the pool directory (${resolvedPoolDir})`
    );
  }
  return resolved;
}

/**
 * True when `root` appears in `command` at a real path boundary — as the
 * whole string, or followed by a path separator, whitespace, or a quote —
 * never as a bare substring. Pool worktree directory names are
 * `pool-<timestamp>-<pid>` (see `pool-state.ts`'s `POOL_DIR_NAME_PATTERN`),
 * so a same-batch replenish routinely produces siblings that share a long
 * numeric prefix (`pool-1700000000-1234` vs `pool-1700000000-12345`) — an
 * unbounded `String.includes` would treat one worktree's root as a
 * substring of the sibling's cwd/argv and kill a process that is not
 * actually rooted there. `isUnder` already gets this right for cwd
 * comparisons via `path.relative`; this is the same guarantee for the
 * command-line fallback.
 */
function commandRootedAt(command: string, root: string): boolean {
  let from = 0;
  for (;;) {
    const idx = command.indexOf(root, from);
    if (idx === -1) return false;
    const after = command[idx + root.length];
    if (after === undefined || after === path.sep || /[\s"'`]/.test(after)) return true;
    from = idx + 1;
  }
}

/**
 * Non-Linux fallback: `ps` gives pid + command only, no reliable cwd. A
 * process is "rooted" here only when the absolute root path appears, at a
 * real path boundary, in its command line.
 */
function findViaPs(rootAbsPath: string): WorktreeProcess[] {
  let out: string;
  try {
    out = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf-8' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Warning: process discovery via 'ps' failed (${msg}) — nothing will be found`);
    return [];
  }
  const self = selfAndAncestorPids();
  const results: WorktreeProcess[] = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s+(.*)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    if (self.has(pid)) continue;
    const command = match[2];
    if (commandRootedAt(command, rootAbsPath)) {
      results.push({ pid, cwd: null, command, ageMs: null });
    }
  }
  return results;
}

/**
 * Every live process whose cwd or command line is rooted under
 * `rootAbsPath` (a single worktree, or the whole pool directory — callers
 * decide the scope). Never returns this process or any of its ancestors.
 */
export function findWorktreeProcesses(rootAbsPath: string): WorktreeProcess[] {
  const root = assertNotEmptyOrRoot(rootAbsPath);
  if (!HAS_PROC) return findViaPs(root);

  const protect = selfAndAncestorPids();
  const results: WorktreeProcess[] = [];
  for (const pid of listPids()) {
    if (protect.has(pid)) continue;
    const cwd = readCwd(pid);
    const command = readCmdline(pid);
    const cwdMatches = cwd !== null && isUnder(cwd, root);
    const cmdMatches = !cwdMatches && command !== null && commandRootedAt(command, root);
    if (!cwdMatches && !cmdMatches) continue;
    results.push({
      pid,
      cwd,
      command: command ?? '(unknown command)',
      ageMs: (() => {
        const start = readStartTimeMs(pid);
        return start === null ? null : Date.now() - start;
      })(),
    });
  }
  return results;
}

/**
 * Pids that would match {@link findWorktreeProcesses}'s rooting test for
 * `rootAbsPath` but are excluded because they are this process or one of
 * its ancestors (imboard-ai/ai-dossier#763). Reported, never killed — a
 * caller can show why fewer processes were killed than a naive scan would
 * suggest (the CLI's own invocation of `return --path <wt>` routinely
 * matches this way: its own command line contains `--path <wt>`).
 */
export function selfOrAncestorMatches(rootAbsPath: string): number[] {
  const root = assertNotEmptyOrRoot(rootAbsPath);
  const protect = selfAndAncestorPids();

  if (!HAS_PROC) {
    let out: string;
    try {
      out = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf-8' });
    } catch {
      return [];
    }
    const hits: number[] = [];
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = /^(\d+)\s+(.*)$/.exec(trimmed);
      if (!match) continue;
      const pid = Number.parseInt(match[1], 10);
      if (protect.has(pid) && commandRootedAt(match[2], root)) hits.push(pid);
    }
    return hits.sort((a, b) => a - b);
  }

  const hits: number[] = [];
  for (const pid of protect) {
    const cwd = readCwd(pid);
    const command = readCmdline(pid);
    const cwdMatches = cwd !== null && isUnder(cwd, root);
    const cmdMatches = !cwdMatches && command !== null && commandRootedAt(command, root);
    if (cwdMatches || cmdMatches) hits.push(pid);
  }
  return hits.sort((a, b) => a - b);
}

/**
 * Given a process discovered by {@link findWorktreeProcesses} against the
 * whole pool directory, the child path (under `poolDirAbs`) it is rooted
 * at — its cwd when known, otherwise a best-effort extraction from its
 * command line. `null` when neither yields a path under `poolDirAbs`.
 */
export function resolveRootedChild(proc: WorktreeProcess, poolDirAbs: string): string | null {
  if (proc.cwd !== null && isUnder(proc.cwd, poolDirAbs)) return proc.cwd;
  const idx = proc.command.indexOf(poolDirAbs);
  if (idx === -1) return null;
  const rest = proc.command.slice(idx + poolDirAbs.length);
  if (rest.length === 0) return poolDirAbs;
  if (!rest.startsWith(path.sep)) return null;
  const end = rest.search(/[\s"'`]/);
  const segment = end === -1 ? rest : rest.slice(0, end);
  return poolDirAbs + segment;
}

/** First path segment of `childAbs` relative to `rootAbs`, or `null` when it is not under it. */
export function firstSegmentUnder(rootAbs: string, childAbs: string): string | null {
  const rel = path.relative(rootAbs, childAbs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const [first] = rel.split(path.sep);
  return first || null;
}

function isAlivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * SIGTERM every process in `targets`, wait up to `graceMs` for exit, then
 * SIGKILL survivors. Best-effort and never throws — a stray dev server must
 * not be able to block a `return`, `gc`, or `reap`. ESRCH (already exited
 * between discovery and kill) is not an error.
 */
export async function killProcesses(
  targets: WorktreeProcess[],
  graceMs = DEFAULT_KILL_GRACE_MS
): Promise<KillResult> {
  const killed: KilledProcess[] = [];
  const errors: string[] = [];
  const termed: WorktreeProcess[] = [];

  for (const target of targets) {
    try {
      process.kill(target.pid, 'SIGTERM');
      termed.push(target);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/ESRCH/.test(msg)) errors.push(`SIGTERM ${target.pid}: ${msg}`);
    }
  }

  if (termed.length > 0) {
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && termed.some((t) => isAlivePid(t.pid))) {
      await sleep(200);
    }
  }

  for (const target of termed) {
    if (isAlivePid(target.pid)) {
      try {
        process.kill(target.pid, 'SIGKILL');
        killed.push({ pid: target.pid, command: target.command, signal: 'SIGKILL' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/ESRCH/.test(msg)) errors.push(`SIGKILL ${target.pid}: ${msg}`);
      }
    } else {
      killed.push({ pid: target.pid, command: target.command, signal: 'SIGTERM' });
    }
  }

  return { killed, errors };
}

export interface KillWorktreeProcessesResult extends KillResult {
  /** Pids that matched but were excluded as this process or an ancestor of it (#763). */
  skippedSelfOrAncestor: number[];
}

/** {@link findWorktreeProcesses} + {@link killProcesses} for a single worktree path. */
export async function killWorktreeProcesses(
  rootAbsPath: string,
  graceMs = DEFAULT_KILL_GRACE_MS
): Promise<KillWorktreeProcessesResult> {
  const skippedSelfOrAncestor = selfOrAncestorMatches(rootAbsPath);
  const result = await killProcesses(findWorktreeProcesses(rootAbsPath), graceMs);
  return { ...result, skippedSelfOrAncestor };
}
