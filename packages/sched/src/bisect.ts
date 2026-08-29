/**
 * Failure attribution, stage 2 (#472 AC1): when overlap cannot say which
 * member broke a test, `git bisect` decides — a pure script over the batch
 * branch's issue-boundary commits, running ONLY the failing tests. No LLM is
 * involved, and no attribution is ever guessed: a first-bad commit that is not
 * a member's commit reports `unattributable` rather than blaming a neighbour.
 *
 * Every subprocess goes through the injectable `ExecFn` (project.ts pattern),
 * and the bisect state is ALWAYS reset — a repo left mid-bisect poisons every
 * later git operation in that checkout.
 */

import { type BoundaryCommit, memberOfCommit, SHA_RE } from './attribution';
import type { ExecFn } from './project';

/** What a bisect run concluded. */
export type BisectOutcome =
  /** The first bad commit is a member's — that member owns the failure. */
  | { kind: 'first-bad'; sha: string; issue: number }
  /** The failing tests pass at `bad` — nothing to attribute (someone already fixed it). */
  | { kind: 'green' }
  /** A first bad commit exists but belongs to no member (e.g. a batch-level fix commit). */
  | { kind: 'unattributable'; sha: string; detail: string }
  /** The bisect could not run or its output could not be read — never a guess. */
  | { kind: 'error'; detail: string };

export interface BisectOptions {
  /** The batch checkout to bisect in. */
  repoDir: string;
  /** Last known-good commit (the batch base). */
  good: string;
  /** Known-bad commit (the batch branch head). */
  bad: string;
  /**
   * The command `git bisect run` executes at each step. MUST be scoped to the
   * failing tests only — a full suite makes the bisect cost O(members × suite).
   */
  testCommand: readonly string[];
  /** Boundary commits of the batch branch, for mapping the first-bad sha to a member. */
  boundary: readonly BoundaryCommit[];
}

/** `<sha> is the first bad commit` — the line every git version prints on success. */
const FIRST_BAD_RE = /^([0-9a-f]{7,40}) is the first bad commit/im;

/** A branch name safe to pass back to `git checkout` (groundtruth.ts's ref pattern). */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Bisect the batch branch for the commit that broke `testCommand`.
 *
 * The known-bad end is verified first: if the failing tests PASS at `bad`
 * there is nothing to attribute (`green`), and starting a bisect from a good
 * "bad" end would otherwise walk the whole range and report nonsense.
 */
export function runAttributionBisect(exec: ExecFn, opts: BisectOptions): BisectOutcome {
  // The shas reach us from git output and milestone text — validate before
  // they become argv so a crafted value can never become a git option
  // (CWE-88, the groundtruth.ts branch-name pattern).
  if (!SHA_RE.test(opts.good) || !SHA_RE.test(opts.bad)) {
    return { kind: 'error', detail: `invalid bisect endpoints: good=${opts.good} bad=${opts.bad}` };
  }
  if (opts.testCommand.length === 0) {
    return { kind: 'error', detail: 'bisect test command is empty' };
  }

  const git = (args: string[]): string | null => exec('git', args, opts.repoDir);

  // Where the checkout was before we touched it. `git bisect reset` returns to
  // wherever HEAD was when `bisect start` ran — which is our OWN detach, not
  // the caller's branch — so the restore is explicit.
  const originalRef = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const restore = originalRef !== null && REF_RE.test(originalRef) ? originalRef : null;

  // Verify the bad end really is bad, from a clean bisect state.
  git(['bisect', 'reset']);
  if (git(['checkout', '--detach', opts.bad]) === null) {
    return { kind: 'error', detail: `cannot check out bad commit ${opts.bad}` };
  }
  try {
    const atBad = exec(opts.testCommand[0], [...opts.testCommand.slice(1)], opts.repoDir);
    if (atBad !== null) {
      return { kind: 'green' };
    }
    if (git(['bisect', 'start', opts.bad, opts.good]) === null) {
      return {
        kind: 'error',
        detail: `git bisect start failed (is ${opts.good} an ancestor of ${opts.bad}?)`,
      };
    }
    const out = git(['bisect', 'run', ...opts.testCommand]);
    if (out === null) {
      return { kind: 'error', detail: 'git bisect run failed' };
    }
    const match = FIRST_BAD_RE.exec(out);
    if (match === null) {
      // Unparseable output is an error, never a guess — git versions differ in
      // what they print around the first-bad line, but all of them print it.
      return { kind: 'error', detail: 'git bisect run produced no first-bad commit line' };
    }
    const sha = match[1];
    const issue = memberOfCommit(opts.boundary, sha);
    if (issue === null) {
      return {
        kind: 'unattributable',
        sha,
        detail: `first bad commit ${sha} carries no (#N) member trailer`,
      };
    }
    return { kind: 'first-bad', sha, issue };
  } finally {
    // Always — a checkout left mid-bisect (or detached at our own probe)
    // breaks every later git operation in that worktree.
    git(['bisect', 'reset']);
    if (restore !== null) git(['checkout', restore]);
  }
}
