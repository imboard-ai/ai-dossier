/**
 * `ai-dossier classify` — the deterministic pre-screen `issue-cycle-classifier` runs before any
 * model call (#538). Patterned on `plan validate` (`commands/plan.ts`): a single JSON verdict,
 * no model call anywhere, always exits 0 once arguments validate — `verdict` is the payload, not
 * a pass/fail gate. (An invalid `--issue`/`--repo` still exits 1 before any lookup, same as
 * every other command built on `requireIssueTarget`.)
 */

import type { Command } from 'commander';
import {
  fail,
  requireIssueTarget,
  tryFetchComments,
  tryFetchIssueMeta,
  tryFetchIssueState,
} from '../gh';
import { parseIssueSelection } from '../issue-selection';
import { findLatestPlan } from '../plan-artifact';
import { extractDependencyRefs, type PrescreenReason, prescreenIssue } from '../prescreen';

interface PrescreenOptions {
  issue: string;
  repo?: string;
  submittedSet?: string;
}

/** GitHub's `state` value for an open issue. */
const GH_STATE_OPEN = 'OPEN';

/** Parse `--submitted-set` (`4,5` or `4..9`), failing through the CLI's exit path — same pattern as `sched.ts`'s `issueList`. */
function parseSubmittedSet(raw: string | undefined): Set<number> | null {
  if (raw === undefined) return null;
  try {
    return new Set(parseIssueSelection(raw));
  } catch (err) {
    fail([`--submitted-set: ${(err as Error).message}`]);
  }
}

interface DependencyResolution {
  /** Open and outside the submitted set — real rule-9 floor hits. */
  open: number[];
  /** `gh issue view --json state` failed for these — fails open (not treated as open), but recorded so the caller can warn rather than silently under-report. */
  unresolved: number[];
}

/**
 * Resolve each `Depends on #N` reference to whether it is open and outside `submittedSet` —
 * fails open (drops the ref from `open` rather than erroring the whole prescreen) on a lookup
 * failure, the same discipline #507's `screenHardBlockLabels` established: a nice-to-have check
 * must never hard-fail the command it augments, but a dropped check must be visible, not silent
 * — `unresolved` exists so the caller can say so.
 */
function resolveOpenDependencies(
  refs: number[],
  submittedSet: Set<number> | null,
  repo: string | undefined
): DependencyResolution {
  const open: number[] = [];
  const unresolved: number[] = [];
  for (const dep of refs) {
    if (submittedSet?.has(dep)) continue; // in-set: rule 9 explicitly exempts this (RFC-0001 E.2)
    const result = tryFetchIssueState(String(dep), repo);
    if (!result.ok) {
      unresolved.push(dep);
    } else if (result.state === GH_STATE_OPEN) {
      open.push(dep);
    }
  }
  return { open, unresolved };
}

type PlanArtifactStatus = 'present' | 'absent' | 'unreadable';

interface PredictedFilesResult {
  status: PlanArtifactStatus;
  files?: string[];
  error?: string;
}

/** The plan:v1 artifact's predicted files, when the issue already carries one — distinguishes "no artifact" from "couldn't read comments" so a transient `gh` failure never silently looks like a clean issue. */
function fetchPredictedFiles(issue: string, repo: string | undefined): PredictedFilesResult {
  const comments = tryFetchComments(issue, repo);
  if (!comments.ok) return { status: 'unreadable', error: comments.error };
  const bodies = comments.comments.map((c) => (typeof c?.body === 'string' ? c.body : ''));
  const latest = findLatestPlan(bodies);
  if (latest === null) return { status: 'absent' };
  return { status: 'present', files: latest.artifact.predictedFiles };
}

/** The one JSON shape every path emits — success and failure alike carry the same five keys, plus `degraded`/`warnings` when something didn't run cleanly. */
function emitVerdict(fields: {
  issue: number;
  state: string | null;
  verdict: 'full' | 'candidate';
  reasons: PrescreenReason[];
  planArtifact: PlanArtifactStatus | null;
  warnings: string[];
}): void {
  const { issue, state, verdict, reasons, planArtifact, warnings } = fields;
  for (const w of warnings) console.error(`⚠ ${w}`);
  console.log(
    JSON.stringify(
      {
        issue,
        state,
        verdict,
        reasons,
        plan_artifact: planArtifact,
        degraded: warnings.length > 0,
        warnings,
        // Not part of the deterministic verdict — documented in cli/README.md as the one
        // non-reproducible field two identical runs may disagree on.
        checked_at: new Date().toISOString(),
      },
      null,
      2
    )
  );
}

function registerPrescreenSubcommand(cmd: Command): void {
  cmd
    .command('prescreen')
    .description(
      'Deterministically pre-screen an issue for the classify pass (JSON verdict, no model call)'
    )
    .requiredOption('--issue <number>', 'GitHub issue number')
    .option('--repo <owner/name>', 'Target repository (defaults to the current one)')
    .option(
      '--submitted-set <selection>',
      'Issues batched/submitted with this one (e.g. "4,5" or "4..9") — an open "Depends on #N" inside this set does not count toward rule 9'
    )
    .action((options: PrescreenOptions) => {
      requireIssueTarget(options);
      const submittedSet = parseSubmittedSet(options.submittedSet);

      const meta = tryFetchIssueMeta(options.issue, options.repo);
      if (!meta.ok) {
        emitVerdict({
          issue: Number(options.issue),
          state: null,
          verdict: 'candidate',
          reasons: [],
          planArtifact: null,
          warnings: [meta.error],
        });
        return;
      }

      const predicted = fetchPredictedFiles(options.issue, options.repo);
      const depRefs = extractDependencyRefs(`${meta.title}\n${meta.body}`);
      const { open: openDependencies, unresolved } = resolveOpenDependencies(
        depRefs,
        submittedSet,
        options.repo
      );

      const result = prescreenIssue({
        title: meta.title,
        body: meta.body,
        labels: meta.labels,
        predictedFiles: predicted.status === 'present' ? predicted.files : undefined,
        openDependencies,
      });

      const warnings: string[] = [];
      if (predicted.status === 'unreadable') {
        warnings.push(
          `Could not read comments to check for a plan:v1 artifact — path-floor and file-count checks were skipped: ${predicted.error}`
        );
      }
      if (unresolved.length > 0) {
        warnings.push(
          `Could not resolve open/closed state for dependency issue(s) ${unresolved.map((n) => `#${n}`).join(', ')} — rule-9 check may be incomplete for them.`
        );
      }

      emitVerdict({
        issue: Number(options.issue),
        state: meta.state,
        verdict: result.verdict,
        reasons: result.reasons,
        planArtifact: predicted.status,
        warnings,
      });
    });
}

/** Registers the `classify` command tree (currently just `prescreen`). */
export function registerClassifyCommand(program: Command): void {
  const classifyCmd = program
    .command('classify')
    .description('Deterministic pre-screen for the issue-cycle-classifier pipeline');

  registerPrescreenSubcommand(classifyCmd);
}
