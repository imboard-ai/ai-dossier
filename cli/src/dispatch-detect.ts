/**
 * Dispatch-profile detection (#707) — which agent FAMILY invoked the current
 * process, used by `sched enqueue` as the DEFAULT for `BatchEntry.dispatch_profile`
 * when the operator (or skill) did not pass `--dispatch`.
 *
 * Measured, not assumed (#707): Claude Code marks its environment
 * (`CLAUDECODE=1` plus a dozen `CLAUDE_CODE_*` vars); opencode ≥1.18 exports
 * ZERO `OPENCODE_*` vars to spawned tools. So environment sniffing identifies
 * Claude and nothing else, and process ancestry is the only generic fallback
 * — a tool spawned by opencode has `opencode` somewhere in its parent chain.
 * Ancestry is best-effort BY DESIGN: `nohup`, `systemd-run`, or any detached
 * wrapper re-parents to init and breaks it (#678, #679). Explicit is the
 * mechanism (`--dispatch`); detection is the convenience; when detection is
 * inconclusive the enqueue FAILS rather than guessing (#680's silent
 * mis-attribution cost $14+ before anyone noticed).
 *
 * Pure and injectable: the caller supplies the environment and the ancestor
 * binary list, so tests never touch `/proc`.
 */

import * as fs from 'node:fs';

/** One configured profile, reduced to what detection matches against: its name and the agent binaries any of its tiers may spawn. */
export interface ProfileCandidate {
  name: string;
  binaries: string[];
}

/** A conclusive detection: which profile, and what evidence decided it. */
export interface DetectedProfile {
  profile: string;
  method: 'claudecode-env' | 'parent-chain';
}

/** Maximum ancestry depth — a defensive cap; real chains are < 10 deep. */
const MAX_ANCESTRY_DEPTH = 15;

/**
 * Read this process's ancestor binaries, innermost first, from `/proc/<pid>/comm`.
 * Linux-only by implementation; any read failure (non-Linux host, a pid that
 * exited mid-walk, a re-parent to a non-matching init) simply ends the walk —
 * inconclusive, per this module's contract, never a throw.
 */
export function ancestorBinaries(): string[] {
  const binaries: string[] = [];
  try {
    let pid = process.pid;
    for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      // comm is parenthesized and may contain spaces; ppid follows the LAST ')'.
      const close = stat.lastIndexOf(')');
      if (close === -1) break;
      const fields = stat.slice(close + 2).split(' ');
      const ppid = Number.parseInt(fields[1], 10);
      if (!Number.isInteger(ppid) || ppid <= 0) break;
      const comm = stat.slice(stat.indexOf('(') + 1, close);
      if (comm.length > 0) binaries.push(comm);
      if (ppid === 1) break;
      pid = ppid;
    }
  } catch {
    // Best-effort: partial ancestry is still useful evidence.
  }
  return binaries;
}

/**
 * Detect which configured profile this session belongs to.
 *
 * 1. `CLAUDECODE` set in the environment → the `claude` profile (by name,
 *    else by a candidate that spawns the `claude` binary). A Claude
 *    environment with NO matching candidate is INCONCLUSIVE — the operator
 *    decides, the CLI refuses to guess.
 * 2. Otherwise the innermost ancestor binary that matches any candidate's
 *    binaries wins.
 * 3. Otherwise null — the caller must fail loudly, never fall back.
 */
export function detectDispatchProfile(opts: {
  env: NodeJS.ProcessEnv;
  candidates: readonly ProfileCandidate[];
  ancestors?: readonly string[];
}): DetectedProfile | null {
  const { env, candidates } = opts;
  if (candidates.length === 0) return null;
  const byBinary = (binary: string): ProfileCandidate[] =>
    candidates.filter((candidate) => candidate.binaries.includes(binary));

  if (env.CLAUDECODE !== undefined && env.CLAUDECODE !== '') {
    const claude =
      candidates.find((candidate) => candidate.name === 'claude') ??
      (byBinary('claude').length === 1 ? byBinary('claude')[0] : undefined);
    if (claude) return { profile: claude.name, method: 'claudecode-env' };
    return null;
  }

  const ancestors = opts.ancestors ?? ancestorBinaries();
  for (const binary of ancestors) {
    const matches = byBinary(binary);
    if (matches.length === 1) return { profile: matches[0].name, method: 'parent-chain' };
    if (matches.length > 1) return null;
  }
  return null;
}
