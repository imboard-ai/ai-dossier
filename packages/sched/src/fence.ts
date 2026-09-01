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
 * Write the takeover record for `run` and return the generation it installed, or null
 * when the fence could not be written.
 *
 * Returning the generation rather than a boolean is the whole point: the number has to
 * reach the replacement agent, which posts at exactly that generation. `null` is a
 * DEGRADED redispatch, never a silent success — see `enterRecovery`'s handling.
 */
export type RunFencer = (
  issue: number,
  run: string,
  phase: string,
  takeover: string
) => number | null;

/** `gen=<n>` as `ai-dossier runstate fence` prints it on success. */
const GEN_LINE_RE = /(?:^|\s)gen=(\d+)(?:\s|$)/m;

/**
 * Recover the installed generation from `runstate fence` stdout.
 *
 * Parsed rather than assumed because the generation is read-then-incremented off the
 * live trail by the CLI: a recovery-of-recovery installs 2 where the engine's own slot
 * bookkeeping might have guessed 1, and acting on the guess would leave the takeover
 * posting at a fenced generation — locked out by the very fence meant to protect it.
 */
export function parseFenceGeneration(stdout: string | null): number | null {
  if (stdout === null) return null;
  const match = GEN_LINE_RE.exec(stdout);
  if (match === null) return null;
  const gen = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(gen) && gen >= 0 ? gen : null;
}

/**
 * The default fencer: shells `ai-dossier runstate fence`, which owns the generation
 * arithmetic and the milestone grammar. Never throws — the `ExecFn` contract — so a
 * missing binary or an expired gh auth degrades to `null` and is journaled by the caller
 * rather than aborting a tick.
 */
export function createExecRunFencer(
  exec: ExecFn,
  opts: { bin?: string; repoDir?: string } = {}
): RunFencer {
  const bin = opts.bin ?? 'ai-dossier';
  return (issue, run, phase, takeover) =>
    parseFenceGeneration(
      exec(
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
        ],
        opts.repoDir
      )
    );
}
