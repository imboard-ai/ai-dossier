/**
 * Run fencing for the stall-recovery ladder (#504).
 *
 * The ladder's contract is "redispatch the SAME run one tier stronger", so a takeover
 * inherits the run id and its milestone trail. That is what made the #472 race possible:
 * `enterRecovery` kills the pid it knows about and respawns, but a pid it cannot see —
 * an agent throttled, or with its cwd outside the worktree — survives, and nothing on the
 * trail tells that agent it was replaced. Both runs then implement the same issue and
 * both keep posting milestones on one trail.
 *
 * A fence is the durable half of the fix: before the takeover is spawned, a
 * `status=superseded` milestone is posted naming the generation that now owns the run.
 * `ai-dossier runstate post` refuses anything from a lower generation, so the superseded
 * agent cannot extend the trail even if it never checks. The family's own doctrine, one
 * step further: an agent exiting is not proof of merge, and no visible process is not
 * proof of death.
 *
 * Like every other outward effect in this package the fencer is injected (the `ExecFn`
 * pattern of project.ts, matching recovery.ts's `createExecMilestonePoster`), so the
 * engine's tests never shell out.
 */

import type { ExecFn } from './project';

/**
 * Subprocess budget for one fence.
 *
 * Wider than a ground-truth poll because `runstate fence` makes two `gh` round trips
 * (read the trail, then comment), and a fence that times out mid-write is the one
 * failure mode that leaves the trail and the engine disagreeing about the generation.
 */
export const FENCE_TIMEOUT_MS = 60_000;

/**
 * The result of one fence attempt.
 *
 * A failure carries its REASON rather than collapsing to a bare null: "the binary is
 * missing", "gh auth expired", "the CLI refused the phase" and "the fence landed but its
 * stdout was unreadable" all end a redispatch unfenced, but they need completely
 * different operator responses — and `fence-failed` is the only place anyone will see
 * which one happened.
 */
export type FenceOutcome = { ok: true; gen: number } | { ok: false; reason: string };

/**
 * Write the takeover record for `run` and report the generation it installed.
 *
 * Reporting the generation rather than a boolean is the whole point: the number has to
 * reach the replacement agent, which posts at exactly that generation. A failure is a
 * DEGRADED redispatch, never a silent success — see `enterRecovery`'s handling.
 */
export type RunFencer = (
  issue: number,
  run: string,
  phase: string,
  takeover: string
) => FenceOutcome;

/** `gen=<n>` as `ai-dossier runstate fence` prints it on its human success line. */
const GEN_LINE_RE = /(?:^|\s)gen=(\d+)(?:\s|$)/m;

/** Stdout kept in a failure reason, so a journal line stays one line. */
const STDOUT_SNIPPET_LENGTH = 200;

/**
 * Recover the installed generation from `runstate fence` stdout.
 *
 * Parsed rather than assumed because the generation is read-then-incremented off the
 * live trail by the CLI: a recovery-of-recovery installs 2 where the engine's own slot
 * bookkeeping might have guessed 1, and acting on the guess would leave the takeover
 * posting at a fenced generation — locked out by the very fence meant to protect it.
 *
 * `--json` is the contract this reads (matching how `groundtruth.ts` reads `runstate
 * last`); the human `gen=` line is accepted as a fallback so a shadow copy of an older
 * `ai-dossier` on PATH degrades to "still works" rather than "silently never fences".
 */
export function parseFenceGeneration(stdout: string | null): number | null {
  if (stdout === null) return null;
  try {
    const parsed: unknown = JSON.parse(stdout);
    const gen = (parsed as { gen?: unknown } | null)?.gen;
    if (typeof gen === 'number' && Number.isSafeInteger(gen) && gen >= 0) return gen;
  } catch {
    // Not JSON — an older CLI, or a human success line. Fall through to the regex.
  }
  const match = GEN_LINE_RE.exec(stdout);
  if (match === null) return null;
  const gen = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(gen) && gen >= 0 ? gen : null;
}

/**
 * The default fencer: shells `ai-dossier runstate fence`, which owns the generation
 * arithmetic and the milestone grammar. Never throws — the `ExecFn` contract — so a
 * missing binary or an expired gh auth becomes a reasoned failure the caller journals,
 * rather than aborting a tick.
 */
export function createExecRunFencer(
  exec: ExecFn,
  opts: { bin?: string; repoDir?: string } = {}
): RunFencer {
  const bin = opts.bin ?? 'ai-dossier';
  return (issue, run, phase, takeover) => {
    const stdout = exec(
      bin,
      [
        'runstate',
        'fence',
        '--issue',
        String(issue),
        '--run',
        run,
        '--phase',
        phase,
        '--takeover',
        takeover,
        '--json',
      ],
      opts.repoDir
    );
    if (stdout === null) {
      return { ok: false, reason: `'${bin} runstate fence' produced no output (see stderr)` };
    }
    const gen = parseFenceGeneration(stdout);
    if (gen === null) {
      // Reachable when the fence DID land but its stdout was lost (e.g. the exec timed
      // out after `gh issue comment` returned), so the reason says so rather than
      // asserting the trail is unfenced.
      return {
        ok: false,
        reason: `no generation in 'runstate fence' output — the fence MAY still have landed: ${stdout.slice(0, STDOUT_SNIPPET_LENGTH).replace(/\s+/g, ' ').trim()}`,
      };
    }
    return { ok: true, gen };
  };
}

/**
 * The takeover label for a dispatch: slot `N`, recovery attempt `r`.
 *
 * The single spelling of the label so the fence that ANNOUNCES a takeover, the bind that
 * names the takeover's process, and the prompt that tells the agent its identity cannot
 * drift apart. The label is descriptive only (#683 AC7): fence ownership is decided by
 * run id + generation, never by matching labels — slot rotation makes a label an unsafe
 * identity.
 */
export function takeoverLabelFor(slotId: number, recoveries: number): string {
  return `slot-${slotId}-r${recoveries}`;
}

/**
 * Bind one fence to its owning process (#683 AC2), or report why it could not.
 *
 * The engine calls this right after spawning the takeover, while it knows the pid and
 * its `/proc` start-time: the bind is what lets every later reader of the trail —
 * `runstate check`, `post`'s guard — tell a LIVE owner from a ghost whose release was
 * missed. Without it a fence is unreadable on liveness and fails closed (still fences),
 * so a missed bind degrades to today's behavior rather than to an unfenced trail.
 */
export type RunFenceBinder = (
  issue: number,
  run: string,
  phase: string,
  takeover: string,
  gen: number,
  pid: number,
  pidStart: number | null
) => FenceOutcome;

/**
 * The default binder: shells `ai-dossier runstate fence-bind`. Same `ExecFn` contract as
 * the fencer — never throws, every failure carries its reason.
 */
export function createExecRunFenceBinder(
  exec: ExecFn,
  opts: { bin?: string; repoDir?: string } = {}
): RunFenceBinder {
  const bin = opts.bin ?? 'ai-dossier';
  return (issue, run, phase, takeover, gen, pid, pidStart) => {
    const args = [
      bin,
      'runstate',
      'fence-bind',
      '--issue',
      String(issue),
      '--run',
      run,
      '--phase',
      phase,
      '--takeover',
      takeover,
      '--gen',
      String(gen),
      '--pid',
      String(pid),
      // The start-time is the pid-identity half (#472): without it a reused pid would
      // read as a live owner. Omitted only when the engine itself could not read it —
      // the CLI then binds without identity and liveness degrades to best-effort-alive.
      ...(pidStart !== null ? ['--pid-start', String(pidStart)] : []),
      '--json',
    ];
    const stdout = exec(args[0], args.slice(1), opts.repoDir);
    if (stdout === null) {
      return { ok: false, reason: `'${bin} runstate fence-bind' produced no output (see stderr)` };
    }
    // The CLI's success line carries `gen=` in both its JSON and human forms, so the
    // same parse the fencer uses confirms the bind landed at the requested generation.
    const landed = parseFenceGeneration(stdout);
    if (landed !== gen) {
      return {
        ok: false,
        reason: `bind did not land at gen=${gen} (output: ${stdout.slice(0, STDOUT_SNIPPET_LENGTH).replace(/\s+/g, ' ').trim()})`,
      };
    }
    return { ok: true, gen };
  };
}

/**
 * Release the fences of a run whose owning dispatch has ENDED (#683 AC1), or report why
 * it could not.
 *
 * The engine calls this at its `exit-detected` hook — the one place it already learns
 * "this run's owner just ended, abnormally or not". A release is best-effort by design:
 * when it cannot land (gh down, binary gone), the trail keeps the fence and every reader
 * falls back to the bind-based stale-on-read check, which is exactly the belt-and-
 * suspenders the issue asks for.
 */
export type RunFenceReleaser = (
  issue: number,
  run: string,
  phase: string,
  takeover: string,
  gen: number
) => FenceOutcome;

/**
 * The default releaser: shells `ai-dossier runstate fence --release --gen <n>`. Same
 * `ExecFn` contract as the fencer — never throws, every failure carries its reason.
 */
export function createExecRunFenceReleaser(
  exec: ExecFn,
  opts: { bin?: string; repoDir?: string } = {}
): RunFenceReleaser {
  const bin = opts.bin ?? 'ai-dossier';
  return (issue, run, phase, takeover, gen) => {
    const stdout = exec(
      bin,
      [
        'runstate',
        'fence',
        '--release',
        '--issue',
        String(issue),
        '--run',
        run,
        '--phase',
        phase,
        '--takeover',
        takeover,
        '--gen',
        String(gen),
        '--json',
      ],
      opts.repoDir
    );
    if (stdout === null) {
      return {
        ok: false,
        reason: `'${bin} runstate fence --release' produced no output (see stderr)`,
      };
    }
    const landed = parseFenceGeneration(stdout);
    if (landed !== gen) {
      return {
        ok: false,
        reason: `release did not land at gen=${gen} (output: ${stdout.slice(0, STDOUT_SNIPPET_LENGTH).replace(/\s+/g, ' ').trim()})`,
      };
    }
    return { ok: true, gen };
  };
}
