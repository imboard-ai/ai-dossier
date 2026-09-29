/**
 * The repo's PR merge mechanism (#887, #874) — what, if anything, will merge a
 * PR that a detached-ship agent parks on the `auto-merge` label.
 *
 * sched's PR watch only WAITS for a merge; it never merges. A parked PR
 * therefore ends only if GitHub native auto-merge (allowed on the repo AND
 * requested on the PR) or a watcher workflow acting on the label merges it. In a
 * repo with neither, the detached park is a park-forever: ai-dossier itself has
 * no watcher workflow, and #878 sat with `autoMergeRequest=null` until an
 * orchestrator merged it by hand.
 *
 * Detection is therefore done by the scheduler at dispatch time and handed to
 * the agent as FACTS; `ship-issue`'s own merge-mechanism check (#860) and its
 * `autoMergeRequest` verification (#874) stay the authority on what to do.
 */

/** Repository merge capability as far as sched could verify it. */
export interface MergeMechanism {
  /** `allow_auto_merge` from `gh api repos/<r>`; `null` = the read failed. */
  nativeAutoMerge: boolean | null;
  /** A workflow under `.github/workflows` acts on the `auto-merge` label; `null` = unreadable. */
  watcherWorkflow: boolean | null;
  /** Merge methods the repo allows (`merge`, `squash`, `rebase`); empty when unknown. */
  allowedMethods: string[];
}

/**
 * `confirmed` — native auto-merge is allowed or a watcher acts on the label:
 * detached ship is viable (subject to ship-issue verifying `autoMergeRequest`).
 * `none` — both were positively read as absent: nothing will merge a parked PR.
 * `unknown` — a read failed and nothing confirmed a mechanism: never park on a guess.
 */
export type MergeMechanismVerdict = 'confirmed' | 'none' | 'unknown';

export function mergeMechanismVerdict(m: MergeMechanism): MergeMechanismVerdict {
  if (m.nativeAutoMerge === true || m.watcherWorkflow === true) return 'confirmed';
  if (m.nativeAutoMerge === false && m.watcherWorkflow === false) return 'none';
  return 'unknown';
}

/** The `--jq` projection `gh api repos/<r>` is read with; also what `parseRepoMergeSettings` expects. */
export const REPO_MERGE_SETTINGS_JQ =
  '{allow_auto_merge, allow_squash_merge, allow_merge_commit, allow_rebase_merge}';

/** Parse `gh api repos/<r> --jq REPO_MERGE_SETTINGS_JQ`; `null` when unusable. */
export function parseRepoMergeSettings(
  stdout: string | null
): { nativeAutoMerge: boolean; allowedMethods: string[] } | null {
  if (stdout === null || stdout.trim() === '') return null;
  try {
    const obj: unknown = JSON.parse(stdout);
    if (obj === null || typeof obj !== 'object') return null;
    const o = obj as Record<string, unknown>;
    // A missing/non-boolean allow_auto_merge is "not verified", never "false".
    if (typeof o.allow_auto_merge !== 'boolean') return null;
    const allowedMethods = [
      o.allow_squash_merge === true ? 'squash' : null,
      o.allow_merge_commit === true ? 'merge' : null,
      o.allow_rebase_merge === true ? 'rebase' : null,
    ].filter((m): m is string => m !== null);
    return { nativeAutoMerge: o.allow_auto_merge, allowedMethods };
  } catch {
    return null;
  }
}

/**
 * Whether a workflow file's text is a merge watcher for the `auto-merge` label:
 * it mentions the label and is triggered by pull-request activity. Deliberately a
 * text heuristic — the watcher's exact shape is the repo's business — so it errs
 * toward "is a watcher" (a false `true` only keeps today's park behaviour; the
 * `none` verdict, which changes behaviour, needs EVERY workflow to miss).
 */
export function workflowActsOnAutoMergeLabel(text: string): boolean {
  return /['"`]?auto-merge['"`]?/.test(text) && /pull_request|labeled|workflow_run/.test(text);
}

/**
 * The ship-mode clause spliced into the default dispatch prompts
 * (`{ship_clause}`). It hands the agent the detected facts and defers the
 * decision to ship-issue's merge-mechanism check instead of hard-coding the park.
 */
export function shipModeClause(
  mechanism: MergeMechanism | undefined,
  kind: 'issue' | 'batch'
): string {
  const verdict = mechanism === undefined ? 'unknown' : mergeMechanismVerdict(mechanism);
  const facts =
    mechanism === undefined
      ? 'merge mechanism: not detected'
      : `merge mechanism detected by the scheduler: native_auto_merge=${String(mechanism.nativeAutoMerge)}, ` +
        `watcher_workflow=${String(mechanism.watcherWorkflow)}, ` +
        `allowed_methods=${mechanism.allowedMethods.join(',') || 'unknown'}`;
  const parkTail =
    kind === 'issue'
      ? 'post the awaiting-merge milestone with pr=, and STOP. Do not wait for the merge, do not run teardown or report — the scheduler watches the PR and dispatches those.'
      : 'post the batch-ship awaiting-merge milestone with pr= on issue #{anchor}, and STOP. Do not wait for the merge, do not run the batch report — the scheduler watches the PR and dispatches that.';
  if (verdict === 'confirmed') {
    return (
      `Ship per ship-issue's merge-mechanism check (${facts}). Detached ship (ship_mode=detached) is ` +
      'allowed ONLY once auto-merge is CONFIRMED: after requesting it, verify ' +
      '`gh pr view <pr> --json autoMergeRequest` is non-null (or the watcher workflow has acted) — the ' +
      'label alone is not proof. If confirmed, ' +
      parkTail +
      ' If it is still null and no watcher workflow exists, do NOT park: wait for the required checks and ' +
      'merge with an allowed method yourself, then finish attached (teardown and report included). ' +
      'Record the chosen ship mode and its evidence in the ship milestone.'
    );
  }
  const why =
    verdict === 'none'
      ? 'neither native auto-merge nor a label watcher exists, so a parked PR would never merge'
      : 'a merge mechanism could not be confirmed, so parking would be a guess';
  const attachedTail =
    kind === 'issue'
      ? 'confirm the merge, then run teardown and report.'
      : 'confirm the merge, post the batch-ship awaiting-merge milestone with pr= on issue #{anchor}, and STOP — the scheduler dispatches the batch report.';
  return (
    `Ship ATTACHED (ship_mode=attached) — ${why} (${facts}). Do not park the PR and do not rely on the ` +
    '`auto-merge` label. After the review milestone (real reviewer agents in agents_done) and green ' +
    'required checks, merge the PR yourself with an allowed method, ' +
    attachedTail +
    ' If no allowed merge method works, block loudly with reason ' +
    '`no-merge-mechanism` instead of parking. Record the chosen ship mode and evidence in the ship milestone.'
  );
}
