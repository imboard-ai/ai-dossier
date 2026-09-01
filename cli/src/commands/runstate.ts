/**
 * `ai-dossier runstate` — post, read, and verify `runstate:v1` milestones.
 *
 * Issue-workflow dossiers used to ask agents to hand-reproduce a markdown heredoc after
 * every phase. These subcommands make the milestone a command instead of a template, so
 * the format, the timestamp, and the per-phase required keys are enforced rather than
 * hoped for.
 */

import fs from 'node:fs';
import type { Command } from 'commander';
import { formatDurationCell } from '../duration';
import {
  asString,
  type ExecFailure,
  exec,
  fail,
  isSafeArg,
  isSafePath,
  parseGhJson,
  postIssueComment,
  printDryRun,
  repoArgs,
  requireIssueNumber,
  requireIssueTarget,
  requireRepoSlug,
  snippet,
  tryFetchComments,
} from '../gh';
import { parseIssueSelection } from '../issue-selection';
import {
  BATCH_PHASES,
  buildMilestone,
  computeResume,
  MAX_BODY_LENGTH,
  mintRunId,
  type ParsedMilestone,
  PHASES,
  parseMilestones,
  type ResumeProbe,
  splitPair,
  validateMilestone,
} from '../runstate';
import {
  buildStatsReport,
  type FailedIssue,
  type IssueTrail,
  type RunStats,
  renderValue,
  type StatsReport,
  skewNote,
} from '../runstate-stats';
import { type ColumnAlign, renderTable } from '../table';

interface PostOptions {
  issue: string;
  phase: string;
  status: string;
  run: string;
  kv?: string[];
  next?: string;
  repo?: string;
  dryRun?: boolean;
  json?: boolean;
}

interface ReadOptions {
  issue: string;
  repo?: string;
  json?: boolean;
}

interface MintOptions {
  issue: string;
}

interface StatsOptions {
  issue?: string;
  issues?: string;
  repo?: string;
  json?: boolean;
}

/** Characters kept in a `verify` warning, which is one line among several. */
const WARNING_SNIPPET_LENGTH = 120;

/** Parse `--kv k=v` occurrences into ordered pairs. */
function parseKvPairs(raw: string[]): { pairs: Array<[string, string]>; errors: string[] } {
  const pairs: Array<[string, string]> = [];
  const errors: string[] = [];
  for (const item of raw) {
    const kv = splitPair(item);
    if (!kv) {
      errors.push(`Malformed --kv '${item}' — expected key=value, e.g. --kv base_branch=main`);
      continue;
    }
    pairs.push(kv);
  }
  return { pairs, errors };
}

/** A trail read, or the one reason it could not be read. */
type TrailResult = { ok: true; milestones: ParsedMilestone[] } | { ok: false; error: string };

/**
 * Read every runstate milestone on an issue, returning WHY rather than exiting.
 *
 * The single-issue subcommands turn a failure here into an immediate exit; `stats --issues`
 * cannot, because one unreadable issue in a set of nine must not discard the other eight.
 * So the decision of what a failure means belongs to the caller, and this function only
 * reports it.
 */
function tryFetchMilestones(issue: string, repo?: string): TrailResult {
  const result = tryFetchComments(issue, repo);
  if (!result.ok) return { ok: false, error: result.error };
  const bodies = result.comments.map((c) => (typeof c?.body === 'string' ? c.body : ''));
  return { ok: true, milestones: parseMilestones(bodies) };
}

/** Fetch every runstate milestone on an issue, oldest first, or exit 1 explaining why. */
function fetchMilestones(issue: string, repo?: string): ParsedMilestone[] {
  const result = tryFetchMilestones(issue, repo);
  if (!result.ok) fail([result.error]);
  return result.milestones;
}

/** `git ls-remote --exit-code` exits 2 for "no such ref" — an answer, not a fault. */
const GIT_NO_MATCHING_REF = 2;

/** The `state` value `gh issue view --json state` reports for a closed issue. */
const GH_STATE_CLOSED = 'CLOSED';

/** The shape of `gh pr view --json state,mergedAt,mergeable`. Every field may be absent. */
interface GhPullRequestJson {
  state?: unknown;
  mergedAt?: unknown;
  mergeable?: unknown;
}

/** The shape of `gh issue view --json state`. */
interface GhIssueStateJson {
  state?: unknown;
}

/** Records a degraded probe result, at most once per distinct message. */
type WarnOnce = (line: string) => void;

/**
 * What `verify` does when a probe cannot answer. Each is shared by the "the command
 * failed" and "the value was unusable" paths of the same probe, so the consequence a
 * reader is told stays the same however the check fell over.
 */
const TREATED_MISSING = 'treating it as missing';
const HEAD_UNVERIFIED = 'treating the milestone head as unverified';
const SHIP_UNVERIFIED = `resuming at 'ship' rather than assuming it merged`;
const RUN_INCOMPLETE = 'treating the run as not yet complete';

/**
 * The warning for a probe whose command failed: one place for the format, so a new probe
 * supplies only `subject` (what could not be read) and `consequence` (what verify does
 * instead).
 */
function probeFailure(
  tool: string,
  subject: string,
  err: ExecFailure,
  consequence: string
): string {
  return `could not ${subject} (${tool} exited ${err.status ?? 'abnormally'}: ${snippet(err.stderr, WARNING_SNIPPET_LENGTH)}) — ${consequence}`;
}

/** The warning for a gh call that exited 0 but did not print JSON. */
function nonJsonFailure(subject: string, stdout: string, consequence: string): string {
  return `gh returned non-JSON for ${subject} (${snippet(stdout, WARNING_SNIPPET_LENGTH)}) — ${consequence}`;
}

function probeBranchOnRemote(branch: string, warn: WarnOnce): boolean {
  if (!isSafeArg(branch)) {
    warn(
      `milestone branch '${branch}' is not a usable branch name — refusing to pass it to git, and ${TREATED_MISSING}`
    );
    return false;
  }
  const res = exec('git', ['ls-remote', '--exit-code', 'origin', branch]);
  if (res.ok) return true;
  if (res.error.notFound) {
    warn(`git is not installed or not on PATH — could not confirm branch '${branch}'`);
  } else if (res.error.status !== GIT_NO_MATCHING_REF) {
    // `--exit-code` reports 2 for "no such ref", which is a real answer, not a fault.
    warn(
      probeFailure(
        'git',
        `reach 'origin' to confirm branch '${branch}'`,
        res.error,
        TREATED_MISSING
      )
    );
  }
  return false;
}

/**
 * `dirExists` — whether the recorded worktree directory is present on this machine.
 * Informational only (`local_worktree=`): no resume decision depends on it.
 */
function probeDirExists(path: string, warn: WarnOnce): boolean {
  if (!isSafePath(path)) {
    warn(`milestone worktree '${path}' is not an absolute path — ${TREATED_MISSING}`);
    return false;
  }
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `git merge-base --is-ancestor` exits 1 for "not an ancestor" — an answer, not a fault. */
const GIT_NOT_ANCESTOR = 1;

/**
 * Remote-first head check (WIP sync rule): `head` counts as present on `origin/<branch>`
 * when it equals the branch's current tip, or is an ancestor of it. Never touches a local
 * worktree — this is what lets `plan`/`implement`/`review` milestones resume on a machine
 * that has never seen the worktree the milestone recorded.
 */
function probeHeadOnRemote(branch: string, head: string, warn: WarnOnce): boolean {
  if (!isSafeArg(branch)) {
    warn(
      `milestone branch '${branch}' is not a usable branch name — refusing to pass it to git, and ${HEAD_UNVERIFIED}`
    );
    return false;
  }
  if (!isSafeArg(head)) {
    warn(
      `milestone head '${head}' is not a usable commit reference — refusing to pass it to git, and ${HEAD_UNVERIFIED}`
    );
    return false;
  }
  const fetchRes = exec('git', ['fetch', 'origin', branch]);
  if (!fetchRes.ok) {
    if (fetchRes.error.notFound) {
      warn(`git is not installed or not on PATH — could not confirm head '${head}'`);
    } else {
      warn(
        probeFailure(
          'git',
          `fetch 'origin/${branch}' to confirm head '${head}'`,
          fetchRes.error,
          HEAD_UNVERIFIED
        )
      );
    }
    return false;
  }
  const ancestorRes = exec('git', ['merge-base', '--is-ancestor', head, 'FETCH_HEAD']);
  if (ancestorRes.ok) return true;
  if (ancestorRes.error.status !== GIT_NOT_ANCESTOR) {
    warn(
      probeFailure(
        'git',
        `check whether '${head}' is on 'origin/${branch}'`,
        ancestorRes.error,
        HEAD_UNVERIFIED
      )
    );
  }
  return false;
}

function probePrState(
  pr: string,
  repo: string | undefined,
  warn: WarnOnce
): ReturnType<ResumeProbe['prState']> {
  if (!isSafeArg(pr)) {
    warn(
      `milestone pr '${pr}' is not a usable PR reference — refusing to pass it to gh, and ${SHIP_UNVERIFIED}`
    );
    return null;
  }
  const res = exec('gh', [
    'pr',
    'view',
    pr,
    '--json',
    'state,mergedAt,mergeable',
    ...repoArgs(repo),
  ]);
  if (!res.ok) {
    warn(probeFailure('gh', `read PR ${pr}`, res.error, SHIP_UNVERIFIED));
    return null;
  }
  const data = parseGhJson<GhPullRequestJson>(res.stdout);
  if (data === null) {
    warn(nonJsonFailure(`PR ${pr}`, res.stdout, SHIP_UNVERIFIED));
    return null;
  }
  return {
    state: asString(data.state),
    mergedAt: typeof data.mergedAt === 'string' ? data.mergedAt : null,
    mergeable: asString(data.mergeable),
  };
}

function probeIssueClosed(issue: string, repo: string | undefined, warn: WarnOnce): boolean {
  const res = exec('gh', ['issue', 'view', issue, '--json', 'state', ...repoArgs(repo)]);
  if (!res.ok) {
    warn(probeFailure('gh', `read the state of issue #${issue}`, res.error, RUN_INCOMPLETE));
    return false;
  }
  const data = parseGhJson<GhIssueStateJson>(res.stdout);
  if (data === null) {
    warn(nonJsonFailure(`the state of issue #${issue}`, res.stdout, RUN_INCOMPLETE));
    return false;
  }
  return asString(data.state) === GH_STATE_CLOSED;
}

/**
 * The real-world probe backing `runstate verify`. All reads — never needs push access.
 *
 * A probe that cannot answer degrades to "not verified", which is the safe direction (the
 * run redoes a phase rather than skipping one). But silently redoing a phase is expensive,
 * so every degradation appends to `warnings` and `verify` reports them.
 */
function makeProbe(issue: string, repo?: string, warnings: string[] = []): ResumeProbe {
  const warn: WarnOnce = (line) => {
    if (!warnings.includes(line)) warnings.push(line);
  };

  return {
    branchOnRemote: (branch) => probeBranchOnRemote(branch, warn),
    headOnRemote: (branch, head) => probeHeadOnRemote(branch, head, warn),
    dirExists: (path) => probeDirExists(path, warn),
    prState: (pr) => probePrState(pr, repo, warn),
    issueClosed: () => probeIssueClosed(issue, repo, warn),
  };
}

/** `--dry-run` and posting are shared with the plan protocol — see `../gh`. */

/** Comment the built milestone body onto the issue and report where it landed. */
function postMilestone(body: string, options: PostOptions): void {
  postIssueComment({
    issue: options.issue,
    repo: options.repo,
    body,
    noun: 'milestone',
    action: `Failed to post the ${options.phase}/${options.status} milestone to issue #${options.issue}`,
    json: options.json,
    // The milestone is the only durable record of the phase, so the body is handed back
    // in the JSON result: re-running the phase is far more expensive than a retry.
    jsonExtras: { body },
    successLine: (url) => `✅ ${options.phase} ${options.status} → ${url}`,
  });
}

/**
 * `post` refuses an over-long body itself: GitHub answers a too-large comment with an
 * opaque 422, and `execFileSync` can hit E2BIG even earlier, so without this the failure
 * arrives as "gh exited abnormally" with no mention of size.
 */
function requirePostableBody(body: string, pairs: Array<[string, string]>): void {
  if (body.length <= MAX_BODY_LENGTH) return;
  const biggest = [...pairs].sort((a, b) => b[1].length - a[1].length)[0];
  fail([
    [
      `Milestone is ${body.length} characters — GitHub rejects an issue comment over ${MAX_BODY_LENGTH}.`,
      biggest
        ? `Largest key: ${biggest[0]}= at ${biggest[1].length} characters.`
        : `No --kv pairs to trim.`,
      `Fix: replace the long value with a count or a path to the full text — a milestone is an index, not a report.`,
    ].join('\n'),
  ]);
}

/** `runstate post` — validate a milestone, then comment it onto the issue. */
function registerPostSubcommand(cmd: Command): void {
  cmd
    .command('post')
    .description('Build and post a runstate milestone comment (validates before posting)')
    .requiredOption('--issue <number>', 'GitHub issue number')
    .requiredOption(
      '--phase <phase>',
      `classify, ${[...PHASES].join(', ')}, or a batch phase (${BATCH_PHASES.join(', ')})`
    )
    .requiredOption('--status <status>', 'done, partial, blocked, or awaiting-merge')
    .requiredOption(
      '--run <id>',
      'Run id (r-<issue>-<hex>) — mint one with: runstate mint; full-cycle runs mint it at the gate phase'
    )
    .option('--kv <key=value...>', 'Phase-specific key=value pair (repeatable)')
    .option('--next <phase>', 'Override the computed next= value')
    .option('--repo <owner/name>', 'Target repository (defaults to the current one)')
    .option('--dry-run', 'Print the comment body without posting it')
    .option('--json', 'Output the result as JSON')
    .action((options: PostOptions) => {
      requireIssueTarget(options);
      const { pairs, errors: kvErrors } = parseKvPairs(options.kv ?? []);

      const input = {
        phase: options.phase,
        status: options.status,
        run: options.run,
        keys: pairs,
        next: options.next,
      };
      const errors = [...kvErrors, ...validateMilestone(input)];
      if (errors.length > 0) fail(errors);

      const body = buildMilestone(input);

      requirePostableBody(body, pairs);

      if (options.dryRun) {
        printDryRun(body, options.json);
        return;
      }
      postMilestone(body, options);
    });
}

/** `runstate last` — print the most recent milestone on an issue. */
function registerLastSubcommand(cmd: Command): void {
  cmd
    .command('last')
    .description('Print the most recent runstate milestone on an issue (read-only)')
    .requiredOption('--issue <number>', 'GitHub issue number')
    .option('--repo <owner/name>', 'Target repository (defaults to the current one)')
    .option('--json', 'Output the parsed milestone as JSON')
    .action((options: ReadOptions) => {
      requireIssueTarget(options);
      const milestones = fetchMilestones(options.issue, options.repo);

      if (milestones.length === 0) {
        if (options.json) {
          console.log(JSON.stringify(null));
        } else {
          console.log(`No runstate milestones on issue #${options.issue}.`);
        }
        return;
      }

      const last = milestones[milestones.length - 1];
      if (options.json) {
        console.log(
          JSON.stringify(
            { phase: last.phase, status: last.status, run: last.run, at: last.at, ...last.keys },
            null,
            2
          )
        );
        return;
      }

      for (const [key, value] of Object.entries(last.keys)) {
        console.log(`${key}=${value}`);
      }
    });
}

/** `runstate verify` — re-check a run's claims and report where it should resume. */
function registerVerifySubcommand(cmd: Command): void {
  cmd
    .command('verify')
    .description("Run the gate's resume verification and print resume_from (read-only)")
    .requiredOption('--issue <number>', 'GitHub issue number')
    .option('--repo <owner/name>', 'Target repository (defaults to the current one)')
    .option('--json', 'Output the result as JSON')
    .action((options: ReadOptions) => {
      requireIssueTarget(options);
      const milestones = fetchMilestones(options.issue, options.repo);
      const warnings: string[] = [];
      const result = computeResume(milestones, makeProbe(options.issue, options.repo, warnings));

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              resume_from: result.resume_from,
              run_id: result.run_id,
              verified: result.verified,
              resume_context: result.resume_context,
              local_worktree: result.local_worktree,
              ...(result.slot_trail ? { slot_trail: true } : {}),
              ...(result.hard_block ? { hard_block: result.hard_block } : {}),
              ...(result.note ? { note: result.note } : {}),
              ...(warnings.length > 0 ? { warnings } : {}),
            },
            null,
            2
          )
        );
      } else {
        console.log(`resume_from=${result.resume_from}`);
        console.log(`run_id=${result.run_id ?? 'none'}`);
        console.log(`verified=${result.verified.length > 0 ? result.verified.join(',') : 'none'}`);
        console.log(`local_worktree=${result.local_worktree}`);
        if (result.slot_trail) console.log('slot_trail=present');
        if (result.hard_block) console.log(`hard_block=${result.hard_block}`);
        if (result.note) console.log(`note=${result.note}`);
        console.log(`resume_context=${JSON.stringify(result.resume_context)}`);
      }

      // On stderr so stdout stays parseable. `verify` still exits 0: an unanswerable
      // probe is a degraded read, not a failure — but the reader must be told that
      // `resume_from` is conservative BECAUSE a check could not run, not because the
      // work is genuinely missing.
      for (const warning of warnings) {
        console.error(`⚠️  verify could not check everything: ${warning}`);
      }
    });
}

/**
 * Resolve `--issue` / `--issues` into the issue numbers to fetch.
 *
 * Exactly one of the two is required: silently preferring one when both are passed would
 * quietly analyse a different set than the operator asked for, and defaulting to something
 * when neither is passed would hit the network on a typo.
 */
function resolveStatsIssues(options: StatsOptions): number[] {
  if (options.issue !== undefined && options.issues !== undefined) {
    fail([
      `Pass --issue or --issues, not both.\nFix: --issue ${options.issue} for one issue, or --issues ${options.issues} for a set.`,
    ]);
  }

  if (options.issue !== undefined) {
    requireIssueTarget({ issue: options.issue, repo: options.repo });
    return [Number(options.issue)];
  }

  if (options.issues === undefined) {
    fail([
      `Missing --issue or --issues.\nFix: 'runstate stats --issue 451', or a set: 'runstate stats --issues 440,448,451' (ranges too: 440..451).`,
    ]);
  }

  requireRepoSlug(options.repo);
  try {
    return parseIssueSelection(options.issues);
  } catch (err) {
    // Selection errors already carry their own `Fix:` line — appending a generic one told
    // the operator to do the very thing that just failed ("pass a range" on a cap error).
    return fail([err instanceof Error ? err.message : String(err)]);
  }
}

/** Column layout of the per-run phase table. */
const PHASE_TABLE_HEADERS = ['phase', 'status', 'started', 'ended', 'duration'];
const PHASE_TABLE_ALIGN: ColumnAlign[] = ['left', 'left', 'left', 'left', 'right'];

/** Per-phase spread: a label, a sample count, then three durations. */
const SPREAD_TABLE_ALIGN: ColumnAlign[] = ['left', 'right', 'right', 'right', 'right'];

const TOTALS_TABLE_HEADERS = ['run', 'issue', 'model', 'last', 'total'];
const TOTALS_TABLE_ALIGN: ColumnAlign[] = ['left', 'right', 'left', 'left', 'right'];

/** Indent applied to every table so its rows sit visibly under their heading. */
const TABLE_INDENT = '  ';

function indent(block: string): string {
  return block
    .split('\n')
    .map((line) => `${TABLE_INDENT}${line}`)
    .join('\n');
}

/** One run's heading line: which run, on which issue, from which model. */
function runHeading(run: RunStats): string {
  const model = run.model ? `, model ${renderValue(run.model)}` : '';
  const total = run.total_seconds === null ? 'unknown' : formatDurationCell(run.total_seconds);
  return `Issue #${run.issue} — run ${renderValue(run.run)}${model} — total ${total}`;
}

/** The per-run phase table: phase, status, started, ended, duration. */
function printRunTable(run: RunStats): void {
  console.log(runHeading(run));
  if (run.phases.length === 0) {
    console.log(`${TABLE_INDENT}(no milestone in this run carried a usable timestamp)`);
    return;
  }
  const rows = run.phases.map((phase) => [
    renderValue(phase.phase),
    renderValue(phase.status),
    phase.started_at ?? '-',
    phase.ended_at,
    formatDurationCell(phase.seconds),
  ]);
  console.log(indent(renderTable(PHASE_TABLE_HEADERS, rows, { align: PHASE_TABLE_ALIGN })));
}

/**
 * A titled, indented table. Sections are separated by a blank line, but the first one only
 * needs it when something was printed above — otherwise the output opens on an empty line.
 */
function makeSectionPrinter(precededByOutput: boolean) {
  let printed = precededByOutput;
  return (title: string, headers: string[], rows: string[][], align: ColumnAlign[]): void => {
    console.log(printed ? `\n${title}` : title);
    printed = true;
    console.log(indent(renderTable(headers, rows, { align })));
  };
}

/** A trailing note marking an aggregate row whose samples include clock-skewed spans. */
function skewCell(negativeSamples: number): string {
  const note = skewNote(negativeSamples);
  return note ? `⚠ ${note}` : '';
}

/** The cross-run aggregates: per-phase spread, per-run totals, and totals by model. */
function printAggregates(report: StatsReport, precededByTables: boolean): void {
  const { phases, models } = report.aggregates;
  const section = makeSectionPrinter(precededByTables);

  if (phases.length > 0) {
    section(
      `Per-phase duration across ${report.runs.length} run(s):`,
      ['phase', 'n', 'median', 'min', 'max', ''],
      phases.map((phase) => [
        renderValue(phase.phase),
        String(phase.samples),
        formatDurationCell(phase.median_seconds),
        formatDurationCell(phase.min_seconds),
        formatDurationCell(phase.max_seconds),
        skewCell(phase.negative_samples),
      ]),
      [...SPREAD_TABLE_ALIGN, 'left']
    );
  }

  section(
    'Per-run total:',
    TOTALS_TABLE_HEADERS,
    report.runs.map((run) => [
      renderValue(run.run),
      `#${run.issue}`,
      run.model === null ? '-' : renderValue(run.model),
      `${renderValue(run.last_phase) || '-'}/${renderValue(run.last_status) || '-'}`,
      formatDurationCell(run.total_seconds),
    ]),
    TOTALS_TABLE_ALIGN
  );

  if (models.length > 0) {
    section(
      'By model:',
      ['model', 'runs', 'n', 'median total', 'min', 'max', ''],
      models.map((model) => [
        renderValue(model.model),
        String(model.runs),
        String(model.samples),
        formatDurationCell(model.median_total_seconds),
        formatDurationCell(model.min_total_seconds),
        formatDurationCell(model.max_total_seconds),
        skewCell(model.negative_samples),
      ]),
      ['left', 'right', 'right', 'right', 'right', 'right', 'left']
    );
  }
}

/**
 * Render the human report.
 *
 * Per-run phase tables are printed for a single issue; a multi-issue selection prints the
 * aggregates instead, since a fleet of nine issues would otherwise bury them under ~70
 * rows. The aggregates always run for a multi-issue selection even when it resolved to one
 * run — the "Per-run total" table is then the only place that run appears at all.
 */
function printStatsHuman(report: StatsReport, multiIssue: boolean): void {
  for (const issue of report.issues_without_trail) {
    console.log(`Issue #${issue} has no runstate milestones — nothing to measure.`);
  }

  if (report.runs.length === 0) return;

  if (!multiIssue) {
    report.runs.forEach((run, i) => {
      if (i > 0) console.log('');
      printRunTable(run);
    });
  }

  // A single run's aggregates restate its own phase table with median = min = max on every
  // row — but only when that table was actually printed.
  if (multiIssue || report.runs.length > 1) printAggregates(report, !multiIssue);
}

/**
 * Read every selected issue's trail, keeping going past one that cannot be read.
 *
 * A selection pasted from a fleet dispatch routinely contains an issue that was since
 * transferred, deleted, or made private. Aborting on the first one throws away every gh
 * round trip already spent and reports nothing — so a failure becomes a per-issue fact
 * here, and only a selection where EVERY issue failed is a failure of the command.
 */
function readTrails(
  issues: number[],
  repo: string | undefined
): { trails: IssueTrail[]; failed: FailedIssue[] } {
  const trails: IssueTrail[] = [];
  const failed: FailedIssue[] = [];

  // Progress on stderr: 200 serial gh calls are otherwise indistinguishable from a hang,
  // and if one fails there is nothing to say how far the run got. Only on a TTY — the
  // carriage returns that make it a single updating line become literal escape noise in a
  // redirected log, which is exactly where the output is read later.
  const showProgress = issues.length > 1 && process.stderr.isTTY === true;

  issues.forEach((issue, i) => {
    if (showProgress) {
      process.stderr.write(`\rstats: reading issue #${issue} (${i + 1}/${issues.length})…`);
    }
    const result = tryFetchMilestones(String(issue), repo);
    if (result.ok) trails.push({ issue, milestones: result.milestones });
    else failed.push({ issue, error: result.error });
  });

  if (showProgress) process.stderr.write('\r\u001b[K');
  return { trails, failed };
}

/**
 * `runstate stats` — per-phase durations derived from a trail's `at=` stamps.
 *
 * Read-only by construction: the only subprocesses it can reach are the `gh issue view`
 * inside {@link fetchMilestones} and the verify probes, which apply the shared gh/git
 * failure taxonomy from `src/gh.ts`.
 */
function registerStatsSubcommand(cmd: Command): void {
  cmd
    .command('stats')
    .description("Report per-phase durations from an issue's runstate trail (read-only)")
    .option('--issue <number>', 'GitHub issue number')
    .option('--issues <list>', 'Issue list or range to aggregate, e.g. 1,2,5..8')
    .option('--repo <owner/name>', 'Target repository (defaults to the current one)')
    .option('--json', 'Output the report as JSON')
    .action((options: StatsOptions) => {
      const issues = resolveStatsIssues(options);
      const { trails, failed } = readTrails(issues, options.repo);

      // Every issue unreadable is a genuine failure, not a degraded read — there is no
      // report to hand back, so say why rather than printing an empty one and exiting 0.
      if (trails.length === 0 && failed.length > 0) {
        fail(failed.map((f) => f.error));
      }

      const report = buildStatsReport({ trails, failed, repo: options.repo });

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printStatsHuman(report, issues.length > 1);
      }

      // On stderr in BOTH modes so stdout stays a parseable table or parseable JSON, and
      // so a `--json` consumer watching stderr still learns the report is degraded — the
      // same shape `verify` uses. A skipped milestone, a skew, or an issue with no trail is
      // a degraded read, not a failure, so `stats` exits 0 in every one of those cases.
      for (const f of report.issues_failed) {
        console.error(`❌ stats could not read issue #${f.issue}, and left it out of the report:`);
        for (const line of f.error.split('\n')) console.error(`   ${line}`);
      }
      for (const warning of report.warnings) {
        console.error(`⚠️  stats could not measure everything: ${warning}`);
      }
    });
}

/** `runstate mint` — print a fresh run id. */
function registerMintSubcommand(cmd: Command): void {
  cmd
    .command('mint')
    .description('Print a fresh run id for an issue (r-<issue>-<hex>)')
    .requiredOption('--issue <number>', 'GitHub issue number')
    .action((options: MintOptions) => {
      // Without this, `mint --issue not-a-number` happily prints `r-not-a-number-ab56`
      // and the mistake only surfaces one phase later as "Invalid run id" from `post`.
      requireIssueNumber(options.issue);
      console.log(mintRunId(options.issue));
    });
}

/** Registers the `runstate` command tree (post, last, verify, mint, stats). */
export function registerRunstateCommand(program: Command): void {
  const runstateCmd = program
    .command('runstate')
    .description('Post, read, and verify runstate:v1 workflow milestones on a GitHub issue');

  registerPostSubcommand(runstateCmd);
  registerLastSubcommand(runstateCmd);
  registerVerifySubcommand(runstateCmd);
  registerMintSubcommand(runstateCmd);
  registerStatsSubcommand(runstateCmd);
}
