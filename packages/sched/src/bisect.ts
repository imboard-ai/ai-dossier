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

import { type BoundaryCommit, memberOfCommit, SAFE_REF_RE, SHA_RE } from './attribution';
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
   * It is executed as a binary, so it must come from operator configuration —
   * never from issue-comment or suite-output text.
   */
  testCommand: readonly string[];
  /** Boundary commits of the batch branch, for mapping the first-bad sha to a member. */
  boundary: readonly BoundaryCommit[];
  /**
   * Called when cleanup (bisect reset / checkout restore) fails. This module
   * has no journal of its own; the caller routes these into one.
   */
  onWarn?: (detail: string) => void;
}

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
  const runTests = (): string | null =>
    exec(opts.testCommand[0], [...opts.testCommand.slice(1)], opts.repoDir);

  // Where the checkout was before we touched it. `git bisect reset` returns to
  // wherever HEAD was when `bisect start` ran — which is our OWN detach, not
  // the caller's branch — so the restore is explicit. A detached or unreadable
  // HEAD falls back to the sha: with no restore at all the checkout is left on
  // our probe commit, and the next recovery step then commits onto a detached
  // HEAD, leaving the batch branch silently behind.
  const originalRef = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const originalSha = git(['rev-parse', 'HEAD']);
  const restore: string[] | null =
    originalRef !== null && SAFE_REF_RE.test(originalRef)
      ? ['checkout', originalRef]
      : originalSha !== null && SHA_RE.test(originalSha)
        ? ['checkout', '--detach', originalSha]
        : null;
  if (restore === null) {
    return { kind: 'error', detail: 'cannot read HEAD to restore it after the bisect' };
  }

  git(['bisect', 'reset']);
  try {
    // Verify the bad end really is bad. Inside the try: every exit from here on
    // must go through the restore in `finally`.
    if (git(['checkout', '--detach', opts.bad]) === null) {
      return { kind: 'error', detail: `cannot check out bad commit ${opts.bad}` };
    }
    if (runTests() !== null) {
      return { kind: 'green' };
    }

    // ...and that the command can tell good from bad at all. A runner that
    // cannot execute (missing binary, wrong cwd, bad argv) "fails" at the good
    // end too, and bisecting on it marks EVERY commit bad — reporting the
    // earliest commit in the range, an innocent member, as the culprit.
    if (git(['checkout', '--detach', opts.good]) === null) {
      return { kind: 'error', detail: `cannot check out good commit ${opts.good}` };
    }
    if (runTests() === null) {
      return {
        kind: 'error',
        detail: `test command fails at the known-good commit ${opts.good} too — it cannot discriminate (missing runner, wrong cwd, or a pre-existing failure); refusing to bisect`,
      };
    }

    if (git(['bisect', 'start', opts.bad, opts.good]) === null) {
      return {
        kind: 'error',
        detail: `git bisect start failed (is ${opts.good} an ancestor of ${opts.bad}?)`,
      };
    }
    if (git(['bisect', 'run', ...opts.testCommand]) === null) {
      return { kind: 'error', detail: 'git bisect run failed' };
    }
    // Ask git for the answer rather than reading its prose: a completed bisect
    // leaves `refs/bisect/bad` pointing at the first bad commit — set by git's
    // own bisect algorithm from the test command's EXIT CODE alone, never from
    // anything the command prints. There is deliberately no fallback that
    // parses `git bisect run`'s captured output: that stream interleaves git's
    // own lines with the failing test command's stdout, so a member-authored
    // test could forge an "<sha> is the first bad commit" line naming another
    // member's real commit to shift blame (#503). Every supported git writes
    // this ref, and the module's contract is "no answer is an error, never a
    // guess" — so no ref means no answer, not a guess from prose.
    const sha = git(['rev-parse', '--verify', '--quiet', 'refs/bisect/bad'])?.trim() ?? '';
    if (!SHA_RE.test(sha)) {
      // No answer is an error, never a guess.
      return { kind: 'error', detail: 'git bisect run identified no first-bad commit' };
    }
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
    // Always — a checkout left mid-bisect (or detached at one of our probes)
    // breaks every later git operation in that worktree. A cleanup that itself
    // fails is reported through `onWarn`: this module has no journal, and a
    // poisoned checkout that nothing recorded is the worst outcome here.
    if (git(['bisect', 'reset']) === null) {
      opts.onWarn?.('git bisect reset failed — the checkout may be left mid-bisect');
    }
    if (git(restore) === null) {
      opts.onWarn?.(`git ${restore.join(' ')} failed — the checkout may be left detached`);
    }
  }
}
