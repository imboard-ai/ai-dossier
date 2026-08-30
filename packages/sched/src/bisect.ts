/**
 * Deterministic attribution bisect — RFC-0001 §F.2 (#472): "ambiguous →
 * deterministic `git bisect` over issue-boundary commits running only the
 * failing tests (script, no LLM)".
 *
 * Drives real `git bisect` in the batch worktree via the injectable
 * `ExecFn` (project.ts) — the same never-throws subprocess pattern as
 * groundtruth.ts and teardown.ts. Safety:
 *
 * - shas are hex-validated before they enter argv (the CWE-88 discipline of
 *   groundtruth.ts's ref checks);
 * - `git bisect reset` runs on EVERY exit path (a worktree stuck mid-bisect
 *   poisons every later git operation); reset failure is an `error` outcome;
 * - unparsable bisect output is an `error` outcome, never a guess.
 */

import type { BoundaryCommit } from './attribution';
import type { ExecFn } from './project';

/** Full or abbreviated commit shas only — anything else never enters argv. */
const SHA_RE = /^[0-9a-f]{7,40}$/i;

function isSha(value: string): boolean {
  return SHA_RE.test(value);
}

/** Git deps for the bisect runner. */
export interface BisectDeps {
  exec: ExecFn;
  /** The batch worktree, with the batch branch checked out at `head`. */
  cwd: string;
}

/** What to bisect. */
export interface BisectInput {
  /** Good sha — the batch base (ancestor of `head`). */
  base: string;
  /** Bad sha — the batch branch head the failing suite ran against. */
  head: string;
  /** Boundary commits base..head (any order; used for the member mapping). */
  boundaries: readonly BoundaryCommit[];
  /**
   * Command that runs ONLY the failing tests and exits non-zero when any of
   * them fails (the "running only the failing tests" contract of F.2).
   */
  testCommand: readonly string[];
}

/** What the bisect found. */
export type BisectOutcome =
  | { kind: 'first-bad'; commit: string; issue: number | null }
  | { kind: 'green' }
  | { kind: 'error'; detail: string };

/** The line `git bisect run` prints when it pins the culprit. */
const FIRST_BAD_RE = /^([0-9a-f]{7,40}) is the first bad commit$/m;

/**
 * Run the deterministic attribution bisect. The flow:
 *
 * 1. re-run the test command at `head` — if it is green now, the suite
 *    failure does not reproduce (flake/infra) and there is nothing to
 *    attribute;
 * 2. `git bisect start <head> <base>` + `git bisect run <testCommand>`;
 * 3. parse the first-bad commit and map it to a member through
 *    `boundaries` — a first-bad commit that is not a member's boundary
 *    commit (e.g. a batch-level review fix) maps to `issue: null`
 *    (unattributable — the caller escalates, it never guesses);
 * 4. `git bisect reset` on every exit path.
 */
export function runAttributionBisect(deps: BisectDeps, input: BisectInput): BisectOutcome {
  const { exec, cwd } = deps;
  if (!isSha(input.base) || !isSha(input.head)) {
    return { kind: 'error', detail: `invalid sha: base=${input.base} head=${input.head}` };
  }
  if (input.testCommand.length === 0) {
    return { kind: 'error', detail: 'empty test command' };
  }

  // Step 1: does the failure reproduce at head? exec returns null on any
  // failure — a test run that cannot run is an error, not a green.
  const headRun = exec(input.testCommand[0], [...input.testCommand.slice(1)], cwd);
  if (headRun === null) {
    // Non-zero exit: the tests still fail at head — proceed to bisect.
  } else {
    return finish(exec, cwd, { kind: 'green' });
  }

  // Step 2: the bisect itself. `git bisect start` takes bad then good revs;
  // `git bisect run` takes the test command verbatim (no `--` separator —
  // anything after `run` is the command).
  const start = exec('git', ['bisect', 'start', input.head, input.base, '--'], cwd);
  if (start === null) {
    return { kind: 'error', detail: 'git bisect start failed' };
  }
  const run = exec('git', ['bisect', 'run', ...input.testCommand], cwd);
  if (run === null) {
    return finish(exec, cwd, { kind: 'error', detail: 'git bisect run failed' });
  }

  // Step 3: parse the first-bad commit.
  const match = FIRST_BAD_RE.exec(run);
  if (match === null) {
    return finish(exec, cwd, {
      kind: 'error',
      detail: `could not parse first bad commit from git bisect run output`,
    });
  }
  const firstBad = match[1];
  const boundary = input.boundaries.find((b) => b.sha === firstBad || b.sha.startsWith(firstBad));
  if (boundary === undefined) {
    return finish(exec, cwd, { kind: 'first-bad', commit: firstBad, issue: null });
  }
  return finish(exec, cwd, { kind: 'first-bad', commit: firstBad, issue: boundary.issue });
}

/** `git bisect reset` before returning `outcome` — a stuck bisect state poisons the worktree. */
function finish(exec: ExecFn, cwd: string, outcome: BisectOutcome): BisectOutcome {
  const reset = exec('git', ['bisect', 'reset'], cwd);
  if (reset === null && outcome.kind !== 'error') {
    return { kind: 'error', detail: 'git bisect reset failed — worktree may be stuck mid-bisect' };
  }
  return outcome;
}
