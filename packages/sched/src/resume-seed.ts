/**
 * #840 item 4: the ENGINE bases a requeued batch member's full-cycle run on
 * its recorded member branch — through the full-cycle RESUME contract, not
 * through prompt text.
 *
 * A parked member (`evicted` / `handed-back`) that an operator `sched
 * requeue`s carries `failure_evidence.branch` — the member branch holding its
 * work. At that entry's first dispatch the engine seeds the issue's runstate
 * trail with a `setup done` milestone naming that branch (and the batch's
 * base as `base_branch`). The dispatched agent's gate then runs `ai-dossier
 * runstate verify`, which maps a `setup` milestone whose `branch=` is live on
 * origin to `resume_from=plan` with that branch in `resume_context` — and
 * full-cycle's documented "Skipping setup" path materializes the worktree
 * FROM that branch (`git worktree add ... <branch>`) and warms it. If the
 * branch is gone, `verify` answers `resume_from=setup` and the run starts
 * fresh from the base — exactly the pre-#840 fallback.
 *
 * No dossier change is needed: the seed speaks the contract every resumed run
 * (cross-machine redispatch, a takeover) already relies on.
 */
import { SAFE_REF_RE } from './attribution';
import type { ExecFn } from './project';

/** What the engine seeds a requeued member's resume trail with. */
export interface ResumeSeed {
  /** The member branch the full-cycle run resumes on (`batch/<id>-m<n>-<issue>`). */
  branch: string;
  /** The base the run ships to — the member's batch's `base_branch`. */
  baseBranch: string;
  /** The batch the member left — recorded on the milestone as `from_batch=`. */
  batch: string;
  /**
   * The worktree path recorded as `worktree=`. Never created by the engine:
   * the resume path creates (and warms) a worktree when this one is absent.
   */
  worktree: string;
}

export type ResumeSeedOutcome = { ok: true; run: string } | { ok: false; reason: string };

/** Posts the resume trail for one requeued member; never throws. */
export type MemberResumeSeeder = (issue: number, seed: ResumeSeed) => ResumeSeedOutcome;

/** `ai-dossier runstate mint`'s shape: `r-<issue>-<suffix>`. */
const RUN_ID_RE = /^r-\d+-[A-Za-z0-9]+$/;

/**
 * The default seeder: `ai-dossier runstate mint` for a fresh run id, then
 * `ai-dossier runstate post --phase setup --status done` (the CLI validates
 * the setup contract's required keys). Mirrors `createExecRunFencer` — a
 * missing binary or an expired gh auth becomes a reasoned failure the engine
 * journals, and the dispatch still goes out on the prompt fallback.
 */
export function createExecResumeSeeder(
  exec: ExecFn,
  opts: { bin?: string; repoDir?: string } = {}
): MemberResumeSeeder {
  const bin = opts.bin ?? 'ai-dossier';
  return (issue, seed) => {
    for (const [name, value] of [
      ['branch', seed.branch],
      ['base_branch', seed.baseBranch],
      ['batch', seed.batch],
    ] as const) {
      if (!SAFE_REF_RE.test(value)) return { ok: false, reason: `${name} is not a plain ref` };
    }
    if (/\s/.test(seed.worktree)) return { ok: false, reason: 'worktree path contains whitespace' };
    const run = exec(bin, ['runstate', 'mint', '--issue', String(issue)], opts.repoDir)?.trim();
    if (run === undefined || !RUN_ID_RE.test(run)) {
      return { ok: false, reason: `'${bin} runstate mint' returned no run id` };
    }
    const posted = exec(
      bin,
      [
        'runstate',
        'post',
        '--issue',
        String(issue),
        '--phase',
        'setup',
        '--status',
        'done',
        '--run',
        run,
        '--kv',
        `branch=${seed.branch}`,
        '--kv',
        `worktree=${seed.worktree}`,
        '--kv',
        'pool_claimed=false',
        '--kv',
        `base_branch=${seed.baseBranch}`,
        '--kv',
        'remote=pushed',
        '--kv',
        'seeded_by=sched',
        '--kv',
        `from_batch=${seed.batch}`,
      ],
      opts.repoDir
    );
    if (posted === null) {
      return { ok: false, reason: `'${bin} runstate post --phase setup' failed (see stderr)` };
    }
    return { ok: true, run };
  };
}
