/**
 * `ai-dossier runstate` — post, read, and verify `runstate:v1` milestones.
 *
 * Issue-workflow dossiers used to ask agents to hand-reproduce a markdown heredoc after
 * every phase. These subcommands make the milestone a command instead of a template, so
 * the format, the timestamp, and the per-phase required keys are enforced rather than
 * hoped for.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { Command } from 'commander';
import { formatDurationCell } from '../duration';
import { parseIssueSelection } from '../issue-selection';
import {
  buildMilestone,
  computeResume,
  isIssueNumber,
  MAX_BODY_LENGTH,
  mintRunId,
  type ParsedMilestone,
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

/**
 * Fail on stderr and exit 1, so a calling dossier can detect it.
 *
 * Each entry is one problem. An entry may span lines: the first gets the ❌, the rest are
 * indented under it, which is how a cause line and its "Fix:" line stay visibly one item.
 */
function fail(lines: string[]): never {
  for (const line of lines) {
    const [first, ...rest] = line.split('\n');
    console.error(`❌ ${first}`);
    for (const cont of rest) console.error(`   ${cont}`);
  }
  process.exit(1);
}

/** Why a subprocess did not produce output — enough to name the actual cause. */
interface ExecFailure {
  /** The binary itself is missing from PATH (ENOENT), rather than having exited non-zero. */
  notFound: boolean;
  /** Exit status, or null when the process never ran or was killed by a signal. */
  status: number | null;
  /** Whatever the command wrote to stderr, falling back to the thrown message. */
  stderr: string;
}

type ExecResult = { ok: true; stdout: string } | { ok: false; error: ExecFailure };

/**
 * Run a command, keeping WHY it failed.
 *
 * The whole point of this subcommand is that agents were silently getting things wrong,
 * so a discarded stderr is the one thing we cannot afford: "gh is not installed", "gh is
 * not logged in", and "issue 440 does not exist" need three different fixes and are
 * indistinguishable without it.
 */
function exec(file: string, args: string[]): ExecResult {
  try {
    const stdout = execFileSync(file, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: String(stdout).trim() };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number | null; stderr?: unknown };
    const stderr = String(e?.stderr ?? '').trim() || String(e?.message ?? '').trim();
    return {
      ok: false,
      error: {
        notFound: e?.code === 'ENOENT',
        status: typeof e?.status === 'number' ? e.status : null,
        stderr,
      },
    };
  }
}

/** Characters of command output kept in a top-level failure message. */
const SNIPPET_LENGTH = 300;

/** Characters kept in a `verify` warning, which is one line among several. */
const WARNING_SNIPPET_LENGTH = 120;

/** Collapse output to one bounded line so a huge or binary payload stays readable. */
function snippet(text: string, max = SNIPPET_LENGTH): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine === '') return '(no output)';
  return oneLine.length > max
    ? `${oneLine.slice(0, max)}… (${oneLine.length} characters total)`
    : oneLine;
}

/**
 * One recognisable reason a `gh` call failed, and what to do about it.
 *
 * `gh` gives no machine-readable error code, so each case matches on substrings of its
 * stderr. {@link GH_FAILURE_CASES} is ordered and the first match wins, so narrower causes
 * come before broader ones — and teaching this code a new cause is a new entry rather than
 * another branch in a growing if/else chain.
 */
interface GhFailureCase {
  /** Lowercased substrings of gh's stderr that identify this cause. */
  match: readonly string[];
  /** What went wrong; `where` names the repository the request targeted. */
  cause: (where: string) => string;
  /** What the caller should do about it. */
  fix: string;
}

const GH_FAILURE_CASES: readonly GhFailureCase[] = [
  {
    match: [
      'gh auth login',
      'not logged',
      'authentication',
      'unauthorized',
      'http 401',
      'bad credentials',
    ],
    cause: () => 'gh is not authenticated.',
    fix: `Fix: run 'gh auth login', confirm with 'gh auth status', then re-run.`,
  },
  {
    match: ['could not resolve to', 'not found', 'http 404'],
    cause: (where) => `GitHub could not find it in ${where}.`,
    fix: `Fix: check the number is right and that the repository is the one you mean — pass --repo <owner/name> when running outside it.`,
  },
  {
    // Ahead of the 403 case on purpose: gh reports rate limiting AS an HTTP 403, so without
    // this the operator is told to fix their permissions — which are fine. `stats --issues`
    // can fire up to 200 sequential reads, which makes this a realistic failure.
    match: ['rate limit', 'secondary rate', 'abuse detection', 'http 429'],
    cause: () => 'GitHub rate-limited the request.',
    fix: `Fix: wait for the window to reset ('gh api rate_limit' shows when), then re-run; narrow --issues to read fewer issues per run.`,
  },
  {
    match: ['http 403', 'permission', 'write access', 'forbidden'],
    cause: (where) =>
      `GitHub refused the request — the authenticated account lacks access to ${where}.`,
    fix: `Fix: check the account and its scopes with 'gh auth status'; reading an issue needs read access to the repository, and posting a milestone needs write.`,
  },
  {
    match: ['dial tcp', 'no such host', 'timeout', 'connection refused', 'network is unreachable'],
    cause: () => 'gh could not reach GitHub.',
    fix: `Fix: check network/proxy access to github.com and re-run; this is transient, so a retry is usually enough.`,
  },
];

/**
 * `JSON.parse` for a `gh --json` payload: `null` instead of a throw, and the caller's
 * declared shape instead of `any`. Every gh call here reads a `--json` payload, so all
 * three call sites need the same "gh exited 0 but printed something that is not JSON"
 * branch — they differ only in what they say about it. Fields stay `unknown` because gh's
 * output is remote data — {@link asString} narrows each one at the point of use.
 */
function parseGhJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** A JSON field as a string, or `fallback` when gh omitted it or sent another type. */
function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Turn a failed `gh` invocation into a message that names the cause and the fix.
 *
 * `action` is what we were trying to do, e.g. "Could not read issue #440".
 */
function ghFailure(action: string, err: ExecFailure, repo?: string): string {
  if (err.notFound) {
    return [
      `${action}: 'gh' is not installed, or is not on PATH.`,
      `Fix: install the GitHub CLI (https://cli.github.com), then re-run. Check with: gh --version`,
    ].join('\n');
  }

  const hint = err.stderr.toLowerCase();
  const where = repo ? `--repo ${repo}` : 'the current repository (no --repo was passed)';
  const matched = GH_FAILURE_CASES.find((c) => c.match.some((needle) => hint.includes(needle)));

  const cause = matched
    ? `${action}: ${matched.cause(where)}`
    : `${action}: gh exited ${err.status === null ? 'abnormally' : `with status ${err.status}`}.`;
  const fix = matched?.fix ?? `Fix: run the same gh command by hand to see the full error.`;

  return [cause, fix, `gh said: ${snippet(err.stderr)}`].join('\n');
}

/** Reject a non-numeric `--issue` here rather than letting gh (or `mint`) fail obscurely. */
function requireIssueNumber(issue: string): void {
  if (!isIssueNumber(issue)) {
    fail([
      `Invalid --issue '${issue}' — expected a positive GitHub issue number.\nFix: pass the number only, e.g. --issue 440 (not a URL, a '#', or a branch name).`,
    ]);
  }
}

/**
 * The `--issue`/`--repo` checks every issue-targeting subcommand runs before it starts.
 * Kept together so a new subcommand cannot pick up one guard and miss the other.
 */
function requireIssueTarget(options: { issue: string; repo?: string }): void {
  requireIssueNumber(options.issue);
  requireRepoSlug(options.repo);
}

/** `--repo owner/name` appended to a gh invocation when the caller supplied one. */
function repoArgs(repo?: string): string[] {
  return repo ? ['--repo', repo] : [];
}

/** `owner/name`, or `host/owner/name` for a GitHub Enterprise host. */
const REPO_SLUG_RE =
  /^(?:[A-Za-z0-9][A-Za-z0-9.-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Reject a `--repo` that is not a repository slug before handing it to gh. */
function requireRepoSlug(repo?: string): void {
  if (repo === undefined) return;
  if (!REPO_SLUG_RE.test(repo)) {
    fail([
      `Invalid --repo '${repo}' — expected owner/name.\nFix: pass the slug only, e.g. --repo imboard-ai/ai-dossier (not a URL, and not a shell expansion).`,
    ]);
  }
}

/** Whether `value` carries a control character, which has no place in a milestone value. */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Whether a value read back OUT of a milestone comment may be passed to `git`/`gh`.
 *
 * These values are attacker-reachable: anyone who can comment on the issue can post a
 * `<!-- runstate:v1 -->` body, so `branch=`, `worktree=` and `pr=` arrive from the network
 * rather than from the caller. Every invocation here is `execFileSync` with an argument
 * array and no shell, so there is no command injection — but a value that begins with `-`
 * is still read as a FLAG rather than as data. `gh` (cobra) parses flags interspersed with
 * positionals, so `pr=--repo=someone/else` or `pr=--web` would silently retarget, or add a
 * side effect to, a subcommand documented as strictly read-only.
 */
function isSafeArg(value: string): boolean {
  return value !== '' && !value.startsWith('-') && !/\s/.test(value) && !hasControlChar(value);
}

/**
 * Paths are only ever passed in value position (`git -C <path>`) or to `fs.statSync`, so
 * they cannot be mistaken for a flag — but the protocol requires them absolute, and a
 * relative path from a forged comment would resolve against whatever directory the agent
 * happens to be in.
 */
function isSafePath(value: string): boolean {
  return value.startsWith('/') && !hasControlChar(value);
}

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
  const res = exec('gh', ['issue', 'view', issue, '--json', 'comments', ...repoArgs(repo)]);
  if (!res.ok) {
    return { ok: false, error: ghFailure(`Could not read issue #${issue}`, res.error, repo) };
  }

  const parsed = parseGhJson<{ comments?: unknown }>(res.stdout);
  if (parsed === null) {
    return {
      ok: false,
      error: [
        `Could not read issue #${issue}: gh exited 0 but did not print JSON.`,
        `Expected a {"comments":[…]} object from: gh issue view ${issue} --json comments${repo ? ` --repo ${repo}` : ''}`,
        `Fix: run that command by hand — a gh older than 2.0 (no --json), or an interactive prompt landing on stdout, both look like this.`,
        `gh printed: ${snippet(res.stdout)}`,
      ].join('\n'),
    };
  }

  // A milestone-less issue and a shape we cannot read must not look the same: the first
  // means "fresh run", the second means the tool is broken, and silently returning [] for
  // both would make a resume start over and destroy work.
  if (!Array.isArray(parsed?.comments)) {
    return {
      ok: false,
      error: [
        `Could not read issue #${issue}: gh's JSON has no "comments" array.`,
        `Fix: confirm your gh supports 'gh issue view <n> --json comments' (gh --version); if it does, re-run — this is not an issue with no comments, it is an unreadable response.`,
        `gh printed: ${snippet(res.stdout)}`,
      ].join('\n'),
    };
  }

  const bodies = (parsed.comments as Array<{ body?: unknown }>).map((c) =>
    typeof c?.body === 'string' ? c.body : ''
  );
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
const IMPLEMENT_UNVERIFIED = 'treating the implement milestone as unverified';
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
 * Backs both `dirExists` and `fileExists`, which differ only in the milestone key the
 * path came from (`label`) and the kind of entry they expect.
 */
function probePathExists(
  path: string,
  label: string,
  kind: 'directory' | 'file',
  warn: WarnOnce
): boolean {
  if (!isSafePath(path)) {
    warn(`milestone ${label} '${path}' is not an absolute path — ${TREATED_MISSING}`);
    return false;
  }
  try {
    const stat = fs.statSync(path);
    return kind === 'directory' ? stat.isDirectory() : stat.isFile();
  } catch {
    return false;
  }
}

function probeHeadOf(worktree: string, warn: WarnOnce): string | null {
  if (!isSafePath(worktree)) {
    warn(
      `milestone worktree '${worktree}' is not an absolute path — refusing to run git in it, and ${IMPLEMENT_UNVERIFIED}`
    );
    return null;
  }
  const res = exec('git', ['-C', worktree, 'rev-parse', '--short', 'HEAD']);
  if (res.ok) return res.stdout;
  // The worktree directory already passed dirExists, so a failure here is surprising.
  warn(probeFailure('git', `read HEAD in '${worktree}'`, res.error, IMPLEMENT_UNVERIFIED));
  return null;
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
    dirExists: (path) => probePathExists(path, 'worktree', 'directory', warn),
    fileExists: (path) => probePathExists(path, 'planning path', 'file', warn),
    headOf: (worktree) => probeHeadOf(worktree, warn),
    prState: (pr) => probePrState(pr, repo, warn),
    issueClosed: () => probeIssueClosed(issue, repo, warn),
  };
}

/** `--dry-run`: show the exact body that would have been posted, and post nothing. */
function printDryRun(body: string, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify({ posted: false, dryRun: true, body }, null, 2));
  } else {
    process.stdout.write(body);
  }
}

/** Comment the built body onto the issue and report where it landed. */
function postMilestone(body: string, options: PostOptions): void {
  const res = exec('gh', [
    'issue',
    'comment',
    options.issue,
    '--body',
    body,
    ...repoArgs(options.repo),
  ]);
  if (!res.ok) {
    fail([
      ghFailure(
        `Failed to post the ${options.phase}/${options.status} milestone to issue #${options.issue}`,
        res.error,
        options.repo
      ),
      // The milestone is the only durable record of the phase, so hand back the body it
      // could not post: re-running the phase is far more expensive than a retry.
      `The milestone was NOT posted. Retry, or post it by hand:\ngh issue comment ${options.issue}${options.repo ? ` --repo ${options.repo}` : ''} --body ${JSON.stringify(body)}`,
    ]);
  }

  if (options.json) {
    console.log(JSON.stringify({ posted: true, url: res.stdout, body }, null, 2));
  } else {
    console.log(`✅ ${options.phase} ${options.status} → ${res.stdout}`);
  }
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
    .requiredOption('--phase <phase>', 'gate, setup, plan, implement, review, ship, or report')
    .requiredOption('--status <status>', 'done, partial, blocked, or awaiting-merge')
    .requiredOption('--run <id>', 'Run id minted by the gate phase (r-<issue>-<hex>)')
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
 * Read-only by construction: the only subprocess it can reach is the `gh issue view` inside
 * {@link fetchMilestones}, which is also where the auth/404/network failure taxonomy lives.
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
