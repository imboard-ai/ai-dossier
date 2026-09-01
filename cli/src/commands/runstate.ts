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
  DEFAULT_GENERATION,
  FENCE_STATUS,
  generationOf,
  isKnownPhase,
  latestFence,
  MAX_BODY_LENGTH,
  MAX_GENERATION,
  mintRunId,
  nextFenceGeneration,
  type ParsedMilestone,
  PHASES,
  parseGeneration,
  parseMilestones,
  type ResumeProbe,
  safeLabel,
  splitPair,
  validateMilestone,
} from '../runstate';
import {
  buildStatsReport,
  type FailedIssue,
  type IssueTrail,
  type ModelAggregate,
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
  gen?: string;
  repo?: string;
  dryRun?: boolean;
  json?: boolean;
}

interface FenceOptions {
  issue: string;
  phase: string;
  run: string;
  takeover: string;
  repo?: string;
  dryRun?: boolean;
  json?: boolean;
}

interface CheckOptions {
  issue: string;
  run: string;
  gen?: string;
  comment?: boolean;
  repo?: string;
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

/** Scale for rendering a 0–1 rate as a percentage. */
const PERCENT = 100;

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
function postMilestone(
  body: string,
  options: PostOptions,
  extras: Record<string, unknown> = {}
): void {
  postIssueComment({
    issue: options.issue,
    repo: options.repo,
    body,
    noun: 'milestone',
    action: `Failed to post the ${options.phase}/${options.status} milestone to issue #${options.issue}`,
    json: options.json,
    // The milestone is the only durable record of the phase, so the body is handed back
    // in the JSON result: re-running the phase is far more expensive than a retry.
    // `extras` carries the supersession-check outcome (#504) — a post that went out
    // unchecked must be distinguishable from one that was verified live.
    jsonExtras: { body, ...extras },
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

// --- Fencing (#504) ---

/**
 * Exit code the fence guards use for "this run has been superseded".
 *
 * Distinct from `fail`'s 1 on purpose: a fenced run is a correct, expected answer that a
 * caller should act on by aborting quietly, not a usage error to be retried. A shell
 * `if ! ai-dossier runstate check …` can tell the two apart — as can a supervisor
 * distinguishing "you were replaced" from "you called this wrong". Both `check` and a
 * refused `post` use it, so one exit code means one thing everywhere.
 */
export const FENCED_EXIT_CODE = 3;

/**
 * Author associations GitHub reports for an account with write access to the repository.
 *
 * `BOT` is included: the workflows that post milestones frequently run as an app token.
 */
const WRITE_ACCESS_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR', 'BOT']);

/**
 * The trail read the FENCE decisions use: only comments from accounts with write access.
 *
 * A milestone is an issue comment, and on a public repository anyone can leave one.
 * Without this filter a single forged `status=superseded` comment from a stranger fences
 * a live run out of its own trail — every `post` refused, every `check` telling the agent
 * to stop — which is a one-comment denial of service on any run whose id is visible on
 * the issue. `groundtruth.ts`'s `parseSetupInfo` already applies exactly this rule for
 * the same reason, and `gh issue view --json comments` already returns the field.
 *
 * Reporting reads (`last`, `verify`, `stats`) deliberately stay unfiltered — they
 * describe the trail rather than act on it, and hiding comments there would make an
 * operator's picture disagree with the issue they are looking at.
 */
function tryFetchTrustedMilestones(issue: string, repo?: string): TrailResult {
  const result = tryFetchComments(issue, repo);
  if (!result.ok) return { ok: false, error: result.error };
  const bodies = result.comments
    .filter(
      (c) =>
        // An older gh does not report the field at all; trusting it then matches
        // `parseSetupInfo` and keeps the guard from failing closed on a tooling gap.
        c?.authorAssociation === undefined ||
        WRITE_ACCESS_ASSOCIATIONS.has(String(c.authorAssociation))
    )
    .map((c) => (typeof c?.body === 'string' ? c.body : ''));
  return { ok: true, milestones: parseMilestones(bodies) };
}

/** Read `--gen`, or exit explaining what a generation is. */
function requireGeneration(raw: string | undefined, flag: string): number {
  if (raw === undefined) return DEFAULT_GENERATION;
  const parsed = parseGeneration(raw);
  if (parsed === null) {
    fail([
      `Invalid ${flag} '${raw}' — expected a non-negative integer run generation.\nFix: pass the generation this run owns, e.g. ${flag} 1 (a run that was never fenced is ${DEFAULT_GENERATION}).`,
    ]);
  }
  return parsed;
}

/** A phase name read off the trail, made safe to display (same rule as {@link safeLabel}). */
function safePhase(raw: string): string {
  return isKnownPhase(raw) ? raw : 'an unrecorded phase';
}

/** A timestamp read off the trail, made safe to display. */
function safeAt(raw: string): string {
  return /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(raw) ? raw : 'an unrecorded date';
}

/**
 * How a fenced run is described wherever one is reported.
 *
 * Every interpolated value comes OFF the trail — i.e. off an issue comment — and lands
 * in an operator's terminal and in the output an agent acts on, so each is passed
 * through its own read-path guard rather than quoted raw.
 */
function fenceDescription(fence: ParsedMilestone): string {
  return `generation ${generationOf(fence) ?? 'unknown'} (takeover '${safeLabel(fence.keys.takeover)}', fenced at ${safePhase(fence.phase)} on ${safeAt(fence.at)})`;
}

/** What the trail says about one run's generation, or why it could not say. */
type FenceView =
  | { kind: 'unreadable'; error: string }
  | { kind: 'live'; current: number; knownRun: boolean }
  | { kind: 'fenced'; current: number; fence: ParsedMilestone; knownRun: boolean };

/**
 * The single "has this run been superseded?" query — one trail read, one comparison.
 *
 * Shared by `post`'s guard and `check` so the rule cannot drift between the command that
 * enforces it and the command that reports it.
 */
function viewFence(issue: string, repo: string | undefined, run: string, gen: number): FenceView {
  const result = tryFetchTrustedMilestones(issue, repo);
  if (!result.ok) return { kind: 'unreadable', error: result.error.split('\n')[0] };

  const knownRun = result.milestones.some((m) => m.run === run);
  const fence = latestFence(result.milestones, run);
  const current = fence === null ? DEFAULT_GENERATION : (generationOf(fence) ?? DEFAULT_GENERATION);
  return fence !== null && current > gen
    ? { kind: 'fenced', current, fence, knownRun }
    : { kind: 'live', current, knownRun };
}

/**
 * A `--run` that appears nowhere on the trail is almost always a typo, and a typo here
 * fails SILENTLY in the dangerous direction: `fence` announces a takeover of a run that
 * does not exist while the real one keeps working, and `check` reports "live" forever, so
 * the checkpoint the whole self-abort story rests on never fires.
 */
function warnUnknownRun(knownRun: boolean, issue: string, run: string): void {
  if (knownRun) return;
  console.error(
    `⚠️  No milestone on issue #${issue} carries run ${run} — check the --run value (minted ids look like r-${issue}-<hex>).`
  );
}

/**
 * Refuse to post from a superseded generation (#504 AC3).
 *
 * The zombie this guards against is by definition not running the code that would check
 * for a fence voluntarily, so the check lives HERE — in the one command that can write to
 * the trail — rather than only in the workflow that is supposed to call it.
 *
 * A trail that cannot be READ posts anyway, with a warning, and says so in the result: a
 * milestone is a phase's only durable record, and losing one to a transient gh outage is
 * a worse failure than the race this prevents. The degradation is reported rather than
 * merely warned about, so a machine consumer can tell a checked post from an unchecked
 * one after the fact.
 *
 * Returns the extras to merge into the posted result.
 */
function requireNotFenced(
  options: PostOptions,
  gen: number,
  body: string
): Record<string, unknown> {
  const view = viewFence(options.issue, options.repo, options.run, gen);

  if (view.kind === 'unreadable') {
    console.error(
      `⚠️  Could not read issue #${options.issue} to check whether run ${options.run} was superseded — posting anyway. (${view.error})`
    );
    return { fence_check: 'skipped', fence_check_error: view.error };
  }
  if (view.kind === 'live') {
    warnUnknownRun(view.knownRun, options.issue, options.run);
    return { fence_check: 'passed', current_gen: view.current };
  }

  const lines = [
    `Run ${options.run} was SUPERSEDED — refusing to post this ${options.phase}/${options.status} milestone from generation ${gen}.`,
    `It was fenced at ${fenceDescription(view.fence)}.`,
    `This run no longer owns issue #${options.issue}: another agent took it over, and two runs writing one trail is what this check exists to prevent.`,
    `Fix: stop working on this issue and exit. Do not push, do not open a PR, do not retry — the takeover is doing the work. If you ARE the takeover, pass --gen ${view.current}.`,
  ];
  for (const [i, line] of lines.entries()) {
    console.error(i === 0 ? `❌ ${line}` : `   ${line}`);
  }
  if (options.json) {
    // The milestone body rides the failure result for the same reason it rides the
    // success one: re-running a phase is far more expensive than re-posting it, and a
    // supervisor may legitimately decide the takeover is the one that should post it.
    console.log(
      JSON.stringify(
        {
          posted: false,
          fenced: true,
          gen,
          current_gen: view.current,
          takeover: safeLabel(view.fence.keys.takeover),
          body,
        },
        null,
        2
      )
    );
  }
  process.exit(FENCED_EXIT_CODE);
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
    .requiredOption(
      '--status <status>',
      `done, partial, blocked, or awaiting-merge (a '${FENCE_STATUS}' fence is written by 'runstate fence')`
    )
    .requiredOption(
      '--run <id>',
      'Run id (r-<issue>-<hex>) — mint one with: runstate mint; full-cycle runs mint it at the gate phase'
    )
    .option('--kv <key=value...>', 'Phase-specific key=value pair (repeatable)')
    .option('--next <phase>', 'Override the computed next= value')
    .option(
      '--gen <n>',
      "Run generation this agent owns (default 0) — a post below the trail's fenced generation is refused"
    )
    .option('--repo <owner/name>', 'Target repository (defaults to the current one)')
    .option('--dry-run', 'Print the comment body without posting it')
    .option('--json', 'Output the result as JSON')
    .action((options: PostOptions) => {
      requireIssueTarget(options);
      // `runstate fence` is the ONLY writer of a fence. Allowing `post --status
      // superseded` would hand a superseded generation the one milestone the guard
      // below cannot refuse, letting it install a higher generation and re-take the run
      // it had just lost — the mechanism turned against itself.
      if (options.status === FENCE_STATUS) {
        fail([
          `'post --status ${FENCE_STATUS}' is not allowed — a fence is installed by 'runstate fence', which reads the current generation off the trail and increments it.\nFix: ai-dossier runstate fence --issue ${options.issue} --run ${options.run} --phase ${options.phase} --takeover <label>`,
        ]);
      }
      const gen = requireGeneration(options.gen, '--gen');
      const { pairs, errors: kvErrors } = parseKvPairs(options.kv ?? []);

      // A generation above the default is recorded on the milestone itself, so the trail
      // shows which generation did the work. Appended rather than merged: an explicit
      // `--kv gen=` alongside `--gen` surfaces as the duplicate-key error it is, instead
      // of one silently overriding the other.
      const keys =
        gen > DEFAULT_GENERATION ? [...pairs, ['gen', String(gen)] as [string, string]] : pairs;

      const input = {
        phase: options.phase,
        status: options.status,
        run: options.run,
        keys,
        next: options.next,
      };
      const errors = [...kvErrors, ...validateMilestone(input)];
      if (errors.length > 0) fail(errors);

      const body = buildMilestone(input);

      requirePostableBody(body, keys);

      if (options.dryRun) {
        printDryRun(body, options.json);
        return;
      }
      const fenceExtras = requireNotFenced(options, gen, body);
      postMilestone(body, options, fenceExtras);
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
              generation: result.generation,
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
        console.log(`generation=${result.generation}`);
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
      ['model', 'runs', 'done', 'blocked', 'open', 'rate', 'n', 'median total', 'min', 'max', ''],
      models.map((model) => [
        renderValue(model.model),
        String(model.runs),
        String(model.completed),
        String(model.blocked),
        String(model.unfinished),
        formatRateCell(model.completion_rate),
        String(model.samples),
        formatDurationCell(model.median_total_seconds),
        formatDurationCell(model.min_total_seconds),
        formatDurationCell(model.max_total_seconds),
        modelNoteCell(model),
      ]),
      [
        'left',
        'right',
        'right',
        'right',
        'right',
        'right',
        'right',
        'right',
        'right',
        'right',
        'left',
      ]
    );
  }
}

/** A completion rate as a whole-percent cell. */
function formatRateCell(rate: number): string {
  return `${Math.round(rate * PERCENT)}%`;
}

/**
 * The trailing note for a model row: clock skew, and which raw `model=` spellings folded in.
 *
 * The fold is disclosed rather than assumed — a reader comparing arms needs to see that
 * `glm-5.3` and `llmgateway/glm-5.3` were counted as one model before trusting the row.
 */
function modelNoteCell(model: ModelAggregate): string {
  const notes: string[] = [];
  const skew = skewCell(model.negative_samples);
  if (skew !== '') notes.push(skew);
  const folded = model.aliases.filter((alias) => alias !== model.model);
  if (folded.length > 0) notes.push(`folded: ${folded.join(', ')}`);
  return notes.join(' · ');
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

/**
 * `runstate fence` — supersede a run: post the takeover record that locks every earlier
 * generation out of the trail (#504 AC1).
 *
 * Called by the stall-recovery ladder BEFORE the replacement agent is spawned, so the
 * fence is durable even if the takeover dies on its first breath.
 */
function registerFenceSubcommand(cmd: Command): void {
  cmd
    .command('fence')
    .description('Supersede a run: post a takeover record fencing its generation out of the trail')
    .requiredOption('--issue <number>', 'GitHub issue number')
    .requiredOption('--run <id>', 'Run id being superseded (r-<issue>-<hex>)')
    .requiredOption('--phase <phase>', 'Phase the superseded run was in when it was taken over')
    .requiredOption(
      '--takeover <label>',
      'What is taking the run over (a run id, slot id, or agent name)'
    )
    .option('--repo <owner/name>', 'Target repository (defaults to the current one)')
    .option('--dry-run', 'Print the comment body without posting it')
    .option('--json', 'Output the result as JSON')
    .action((options: FenceOptions) => {
      requireIssueTarget(options);
      // Trusted read: the generation is read-then-incremented off the trail, so a forged
      // `superseded` comment claiming a high generation would otherwise dictate what the
      // legitimate fence installs.
      const result = tryFetchTrustedMilestones(options.issue, options.repo);
      if (!result.ok) fail([result.error]);
      warnUnknownRun(
        result.milestones.some((m) => m.run === options.run),
        options.issue,
        options.run
      );
      // Read-then-increment off the live trail, so a recovery-of-recovery fences the
      // FIRST takeover too rather than reinstalling the generation it already owns.
      const gen = nextFenceGeneration(result.milestones, options.run);
      if (gen === null) {
        fail([
          `Run ${options.run} is already at the maximum generation (${MAX_GENERATION}) — refusing to fence it again.\nThe ladder caps recoveries at two per run, so a trail this deep means a forged or corrupt 'gen=' value. Fix: inspect the superseded milestones on issue #${options.issue} by hand.`,
        ]);
      }

      const keys: Array<[string, string]> = [
        ['gen', String(gen)],
        ['takeover', options.takeover],
      ];
      const input = {
        phase: options.phase,
        status: FENCE_STATUS,
        run: options.run,
        keys,
      };
      const errors = validateMilestone(input);
      if (errors.length > 0) fail(errors);

      const body = buildMilestone(input);
      requirePostableBody(body, keys);

      if (options.dryRun) {
        printDryRun(body, options.json, { gen });
        return;
      }

      postIssueComment({
        issue: options.issue,
        repo: options.repo,
        body,
        noun: 'fence',
        action: `Failed to fence run ${options.run} on issue #${options.issue}`,
        json: options.json,
        // `gen` is the whole point of the call: the caller must hand it to the takeover
        // agent, so it rides both output modes rather than only the JSON one.
        jsonExtras: { body, gen, run: options.run, takeover: options.takeover },
        successLine: (url) =>
          `✅ fenced ${options.run} gen=${gen} takeover=${options.takeover} → ${url}`,
      });
    });
}

/** What `check` reports, in either output mode. */
interface CheckResult {
  fenced: boolean;
  /** The generation the caller claimed to own. */
  gen: number;
  /** The generation that currently owns the run. */
  current_gen: number;
  /** True when the trail could not be read and the run is reported live by default. */
  degraded?: boolean;
  /** Why the trail could not be read, when `degraded`. */
  error?: string;
  /** Whether any milestone on the issue carries this run id. */
  known_run?: boolean;
  takeover?: string;
  phase?: string;
  at?: string;
}

/** The comment a fenced run leaves behind when it aborts (#504 AC2). */
function abortCommentBody(run: string, gen: number, fence: ParsedMilestone): string {
  return [
    `**Run superseded — aborting.** Run \`${run}\` (generation ${gen}) stopped work on this issue at its supersession checkpoint.`,
    '',
    `It was fenced at ${fenceDescription(fence)}. The takeover owns the issue from here; this run pushed nothing further and opened no PR.`,
  ].join('\n');
}

/**
 * Whether this run already left an abort comment for this exact fence.
 *
 * A workflow checks at several checkpoints (before implement, review, and ship), and a
 * fenced run that reaches more than one of them must not comment more than once.
 */
function alreadyAborted(issue: string, repo: string | undefined, marker: string): boolean {
  const comments = tryFetchComments(issue, repo);
  return comments.ok && comments.comments.some((c) => String(c?.body ?? '').includes(marker));
}

/**
 * `runstate check` — the agent-side checkpoint (#504 AC2): has this run been superseded?
 *
 * Exits {@link FENCED_EXIT_CODE} when it has, so a workflow can run it before implement,
 * before review, and before ship and abort on a non-zero exit. With `--comment` the abort
 * is recorded on the issue as well, so a human reading the trail sees why a run stopped
 * rather than an unexplained silence.
 *
 * A trail that cannot be read reports live, for the same reason `post` posts anyway: a
 * transient gh outage must not abort a healthy run. The degradation is reported in the
 * result, not only warned about, so the answer is never mistaken for a verified one.
 */
function registerCheckSubcommand(cmd: Command): void {
  cmd
    .command('check')
    .description(
      `Check whether a run generation has been superseded (exits ${FENCED_EXIT_CODE} when fenced)`
    )
    .requiredOption('--issue <number>', 'GitHub issue number')
    .requiredOption('--run <id>', 'Run id to check (r-<issue>-<hex>)')
    .option('--gen <n>', 'Generation this agent owns (default 0)')
    .option('--comment', 'When fenced, also post one short abort comment on the issue')
    .option('--repo <owner/name>', 'Target repository (defaults to the current one)')
    .option('--json', 'Output the result as JSON')
    .action((options: CheckOptions) => {
      requireIssueTarget(options);
      const gen = requireGeneration(options.gen, '--gen');
      const view = viewFence(options.issue, options.repo, options.run, gen);

      if (view.kind === 'unreadable') {
        console.error(
          `⚠️  check could not read issue #${options.issue} — reporting the run as live. (${view.error})`
        );
        printCheckResult(
          { fenced: false, gen, current_gen: gen, degraded: true, error: view.error },
          options.json
        );
        return;
      }

      warnUnknownRun(view.knownRun, options.issue, options.run);

      if (view.kind === 'live') {
        printCheckResult(
          { fenced: false, gen, current_gen: view.current, known_run: view.knownRun },
          options.json
        );
        return;
      }

      if (options.comment) {
        // The marker makes the comment idempotent across a run's several checkpoints,
        // and identifies exactly which generation of which run gave up.
        const marker = `<!-- runstate-abort:${options.run}:${gen} -->`;
        if (!alreadyAborted(options.issue, options.repo, marker)) {
          postIssueComment({
            issue: options.issue,
            repo: options.repo,
            body: `${marker}\n${abortCommentBody(options.run, gen, view.fence)}`,
            noun: 'abort comment',
            action: `Failed to post the abort comment for run ${options.run} to issue #${options.issue}`,
            successLine: (url) => `📝 abort comment → ${url}`,
          });
        }
      }

      printCheckResult(
        {
          fenced: true,
          gen,
          current_gen: view.current,
          known_run: view.knownRun,
          takeover: safeLabel(view.fence.keys.takeover),
          phase: safePhase(view.fence.phase),
          at: safeAt(view.fence.at),
        },
        options.json
      );
      console.error(
        `❌ Run ${options.run} was SUPERSEDED at ${fenceDescription(view.fence)}.\n   Stop working on issue #${options.issue} and exit: another agent owns it. Do not push, do not open a PR.`
      );
      process.exit(FENCED_EXIT_CODE);
    });
}

/** `check`'s stdout, in whichever mode the caller asked for. */
function printCheckResult(result: CheckResult, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`fenced=${result.fenced}`);
  console.log(`gen=${result.gen}`);
  console.log(`current_gen=${result.current_gen}`);
  if (result.degraded === true) console.log('degraded=true');
  if (result.takeover !== undefined) console.log(`takeover=${result.takeover}`);
}

/** Registers the `runstate` command tree (post, last, verify, fence, check, mint, stats). */
export function registerRunstateCommand(program: Command): void {
  const runstateCmd = program
    .command('runstate')
    .description('Post, read, and verify runstate:v1 workflow milestones on a GitHub issue');

  registerPostSubcommand(runstateCmd);
  registerLastSubcommand(runstateCmd);
  registerVerifySubcommand(runstateCmd);
  registerFenceSubcommand(runstateCmd);
  registerCheckSubcommand(runstateCmd);
  registerMintSubcommand(runstateCmd);
  registerStatsSubcommand(runstateCmd);
}
