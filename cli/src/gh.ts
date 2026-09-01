/**
 * Shared subprocess plumbing for issue-comment-backed protocols (runstate:v1,
 * plan:v1).
 *
 * Every command that reads or writes GitHub issue comments through `gh` needs the
 * same things: run a subprocess and keep WHY it failed, turn `gh`'s stderr into a
 * named cause with a fix, parse `--json` output without a throw, and reject
 * values that cannot be safely passed on a command line. These lived privately in
 * `commands/runstate.ts` until the second consumer (`commands/plan.ts`) arrived;
 * they are extracted verbatim rather than reimplemented per command — and anything
 * BOTH command suites do (fetch comments, post a comment, print a dry-run) lives
 * here once, not twice.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Fail on stderr and exit 1, so a calling dossier can detect it.
 *
 * Each entry is one problem. An entry may span lines: the first gets the ❌, the rest are
 * indented under it, which is how a cause line and its "Fix:" line stay visibly one item.
 */
export function fail(lines: string[]): never {
  for (const line of lines) {
    const [first, ...rest] = line.split('\n');
    console.error(`❌ ${first}`);
    for (const cont of rest) console.error(`   ${cont}`);
  }
  process.exit(1);
}

/** How long any single gh/git subprocess may run before it is killed. */
const EXEC_TIMEOUT_MS = 120_000;

/** Why a subprocess did not produce output — enough to name the actual cause. */
export interface ExecFailure {
  /** The binary itself is missing from PATH (ENOENT), rather than having exited non-zero. */
  notFound: boolean;
  /** The process was killed after {@link EXEC_TIMEOUT_MS} instead of answering. */
  timedOut: boolean;
  /** Exit status, or null when the process never ran or was killed by a signal. */
  status: number | null;
  /** Whatever the command wrote to stderr, falling back to the thrown message. */
  stderr: string;
}

export type ExecResult = { ok: true; stdout: string } | { ok: false; error: ExecFailure };

/**
 * Run a command, keeping WHY it failed.
 *
 * The whole point of the comment-protocol subcommands is that agents were silently
 * getting things wrong, so a discarded stderr is the one thing we cannot afford:
 * "gh is not installed", "gh is not logged in", and "issue 440 does not exist" need
 * three different fixes and are indistinguishable without it. A hard timeout keeps a
 * network-stalled gh from hanging an agent-driven run with nothing to debug.
 */
export function exec(file: string, args: string[]): ExecResult {
  try {
    const stdout = execFileSync(file, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: EXEC_TIMEOUT_MS,
    });
    return { ok: true, stdout: String(stdout).trim() };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      status?: number | null;
      stderr?: unknown;
      killed?: boolean;
    };
    const stderr = String(e?.stderr ?? '').trim() || String(e?.message ?? '').trim();
    return {
      ok: false,
      error: {
        notFound: e?.code === 'ENOENT',
        timedOut: e?.killed === true,
        status: typeof e?.status === 'number' ? e.status : null,
        stderr,
      },
    };
  }
}

/** Characters of command output kept in a top-level failure message. */
const SNIPPET_LENGTH = 300;

/** Control characters that have no place in output a terminal will render. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching (and stripping) control characters is exactly this regex's job
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b-\u001f\u007f\u009b]/g;

/**
 * Collapse output to one bounded line so a huge or binary payload stays readable.
 * Control characters (ANSI/OSC escapes included) are stripped — snippets come from
 * network-reachable comment bodies, and a terminal escape re-emitted raw can
 * rewrite the operator's screen or clipboard.
 */
export function snippet(text: string, max = SNIPPET_LENGTH): string {
  const oneLine = text.replace(CONTROL_CHARS_RE, '').replace(/\s+/g, ' ').trim();
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
    // this the operator is told to fix their permissions — which are fine. Sequential reads
    // over an issue set can fire enough calls to make this a realistic failure.
    match: ['rate limit', 'secondary rate', 'abuse detection', 'http 429'],
    cause: () => 'GitHub rate-limited the request.',
    fix: `Fix: wait for the window to reset ('gh api rate_limit' shows when), then re-run; narrow the issue set to read fewer issues per run.`,
  },
  {
    match: ['http 403', 'permission', 'write access', 'forbidden'],
    cause: (where) =>
      `GitHub refused the request — the authenticated account lacks access to ${where}.`,
    fix: `Fix: check the account and its scopes with 'gh auth status'; reading an issue needs read access to the repository, and posting a comment needs write.`,
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
 * call sites need the same "gh exited 0 but printed something that is not JSON" branch —
 * they differ only in what they say about it. Fields stay `unknown` because gh's output is
 * remote data — {@link asString} narrows each one at the point of use.
 */
export function parseGhJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** A JSON field as a string, or `fallback` when gh omitted it or sent another type. */
export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Turn a failed `gh` invocation into a message that names the cause and the fix.
 *
 * `action` is what we were trying to do, e.g. "Could not read issue #440".
 */
export function ghFailure(action: string, err: ExecFailure, repo?: string): string {
  if (err.notFound) {
    return [
      `${action}: 'gh' is not installed, or is not on PATH.`,
      `Fix: install the GitHub CLI (https://cli.github.com), then re-run. Check with: gh --version`,
    ].join('\n');
  }

  // Named ahead of the taxonomy: a kill leaves no stderr to match on, and "check the
  // network" is the one fix that fits every stall.
  if (err.timedOut) {
    return [
      `${action}: gh did not answer within ${EXEC_TIMEOUT_MS / 1000}s.`,
      `Fix: the call was killed as stalled — check network/proxy access, then re-run.`,
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

/**
 * GitHub issue numbers are positive integers; anything else is a caller mistake. Capped at 10
 * digits — real issue numbers never approach that, and without a cap a caller that `Number()`s
 * the value back out (e.g. for JSON output) can silently get `Infinity` → `null` from an absurd
 * input instead of a clear validation error.
 */
export function isIssueNumber(value: string): boolean {
  return /^[1-9]\d{0,9}$/.test(value);
}

/** Reject a non-numeric `--issue` here rather than letting gh (or `mint`) fail obscurely. */
export function requireIssueNumber(issue: string): void {
  if (!isIssueNumber(issue)) {
    fail([
      `Invalid --issue '${issue}' — expected a positive GitHub issue number.\nFix: pass the number only, e.g. --issue 440 (not a URL, a '#', or a branch name).`,
    ]);
  }
}

/** `--repo owner/name` appended to a gh invocation when the caller supplied one. */
export function repoArgs(repo?: string): string[] {
  return repo ? ['--repo', repo] : [];
}

/** `owner/name`, or `host/owner/name` for a GitHub Enterprise host. */
const REPO_SLUG_RE =
  /^(?:[A-Za-z0-9][A-Za-z0-9.-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Reject a `--repo` that is not a repository slug before handing it to gh. */
export function requireRepoSlug(repo?: string): void {
  if (repo === undefined) return;
  if (!REPO_SLUG_RE.test(repo)) {
    fail([
      `Invalid --repo '${repo}' — expected owner/name.\nFix: pass the slug only, e.g. --repo imboard-ai/ai-dossier (not a URL, and not a shell expansion).`,
    ]);
  }
}

/**
 * The `--issue`/`--repo` checks every issue-targeting subcommand runs before it starts.
 * Kept together so a new subcommand cannot pick up one guard and miss the other.
 */
export function requireIssueTarget(options: { issue: string; repo?: string }): void {
  requireIssueNumber(options.issue);
  requireRepoSlug(options.repo);
}

/** Whether `value` carries a control character, which has no place in a comment value. */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Whether a value read back OUT of a comment may be passed to `git`/`gh`.
 *
 * These values are attacker-reachable: anyone who can comment on the issue can post a
 * protocol comment, so values like `branch=`, `head=` and `pr=` arrive from the network
 * rather than from the caller. Every invocation here is `execFileSync` with an argument
 * array and no shell, so there is no command injection — but a value that begins with `-`
 * is still read as a FLAG rather than as data. `gh` (cobra) parses flags interspersed with
 * positionals, so `pr=--repo=someone/else` or `pr=--web` would silently retarget, or add a
 * side effect to, a subcommand documented as strictly read-only.
 */
export function isSafeArg(value: string): boolean {
  return value !== '' && !value.startsWith('-') && !/\s/.test(value) && !hasControlChar(value);
}

/**
 * Paths are only ever passed in value position (`git -C <path>`) or to `fs.statSync`, so
 * they cannot be mistaken for a flag — but the protocol requires them absolute, and a
 * relative path from a forged comment would resolve against whatever directory the agent
 * happens to be in.
 */
export function isSafePath(value: string): boolean {
  return value.startsWith('/') && !hasControlChar(value);
}

/** Formats why a local `git` probe could not answer — shared by every git-reading command. */
export function gitFailure(err: ExecFailure): string {
  return err.notFound
    ? 'git is not installed or not on PATH'
    : err.timedOut
      ? `git did not answer within ${EXEC_TIMEOUT_MS / 1000}s (killed as stalled)`
      : `git exited ${err.status ?? 'abnormally'}: ${snippet(err.stderr, GIT_ERROR_SNIPPET_LENGTH)}`;
}

/** Characters kept when quoting git stderr inside a reason or warning line. */
const GIT_ERROR_SNIPPET_LENGTH = 120;

/** A comment as gh reports it; every field but `body` may be absent. */
export interface GhComment {
  body?: unknown;
  url?: unknown;
  createdAt?: unknown;
  author?: { login?: unknown } | null;
  authorAssociation?: unknown;
}

/** A comment-read, or the one reason it could not be read. */
export type CommentsResult = { ok: true; comments: GhComment[] } | { ok: false; error: string };

/**
 * Read an issue's comments through gh, reporting WHY rather than exiting.
 *
 * The single-issue subcommands turn a failure here into an immediate exit; `stats
 * --issues` cannot, because one unreadable issue in a set must not discard the rest. So
 * the decision of what a failure means belongs to the caller, and this function only
 * reports it.
 */
export function tryFetchComments(issue: string, repo?: string): CommentsResult {
  const res = exec('gh', ['issue', 'view', issue, '--json', 'comments', ...repoArgs(repo)]);
  if (!res.ok) {
    return { ok: false, error: ghFailure(`Could not read issue #${issue}`, res.error, repo) };
  }

  const parsed = parseGhJson<{ comments?: unknown }>(res.stdout);
  if (parsed === null || !Array.isArray(parsed?.comments)) {
    // A comment-less issue and a shape we cannot read must not look the same: the first
    // means "nothing there", the second means the tool is broken, and silently returning
    // [] for both would make a reader report "no artifacts" over an unreadable response.
    return {
      ok: false,
      error: [
        `Could not read issue #${issue}: gh exited 0 but did not print JSON — no "comments" array.`,
        `Fix: run 'gh issue view ${issue} --json comments' by hand — a gh older than 2.0 (no --json), or an interactive prompt landing on stdout, both look like this.`,
        `gh printed: ${snippet(res.stdout)}`,
      ].join('\n'),
    };
  }

  return { ok: true, comments: parsed.comments as GhComment[] };
}

/**
 * Extract label names from a `gh --json labels` field: `{name, color, description}` objects,
 * only `name` read, a malformed entry dropped rather than failing the whole read. Shared by
 * every fetcher that reads labels, so the extraction logic can't drift between them.
 */
function ghLabelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((label) =>
      label !== null && typeof label === 'object' ? (label as { name?: unknown }).name : undefined
    )
    .filter((name): name is string => typeof name === 'string');
}

/** An issue's label read, or the one reason it could not be read. */
export type LabelsResult = { ok: true; labels: string[] } | { ok: false; error: string };

/**
 * Read an issue's label names through gh, reporting WHY rather than exiting —
 * the same discipline as {@link tryFetchComments} (#507's enqueue-time
 * hard-block pre-screen is the second consumer).
 */
export function tryFetchLabels(issue: string, repo?: string): LabelsResult {
  const res = exec('gh', ['issue', 'view', issue, '--json', 'labels', ...repoArgs(repo)]);
  if (!res.ok) {
    return {
      ok: false,
      error: ghFailure(`Could not read labels for issue #${issue}`, res.error, repo),
    };
  }

  const parsed = parseGhJson<{ labels?: unknown }>(res.stdout);
  if (parsed === null || !Array.isArray(parsed?.labels)) {
    return {
      ok: false,
      error: [
        `Could not read labels for issue #${issue}: gh exited 0 but did not print JSON — no "labels" array.`,
        `Fix: run 'gh issue view ${issue} --json labels' by hand — a gh older than 2.0 (no --json), or an interactive prompt landing on stdout, both look like this.`,
        `gh printed: ${snippet(res.stdout)}`,
      ].join('\n'),
    };
  }

  return { ok: true, labels: ghLabelNames(parsed.labels) };
}

/** An issue's title/body/labels/state read, or the one reason it could not be read. */
export type IssueMetaResult =
  | { ok: true; title: string; body: string; labels: string[]; state: string }
  | { ok: false; error: string };

/**
 * Read an issue's title, body, labels, and state in one `gh` call — the combined fetch the
 * classify pre-screen (#538) needs (title/body for the text-keyword scan, labels for the
 * hard-block check, state so a caller can tell CLOSED apart from a read failure).
 */
export function tryFetchIssueMeta(issue: string, repo?: string): IssueMetaResult {
  const res = exec('gh', [
    'issue',
    'view',
    issue,
    '--json',
    'title,body,labels,state',
    ...repoArgs(repo),
  ]);
  if (!res.ok) {
    return {
      ok: false,
      error: ghFailure(`Could not read issue #${issue}`, res.error, repo),
    };
  }

  const parsed = parseGhJson<{
    title?: unknown;
    body?: unknown;
    labels?: unknown;
    state?: unknown;
  }>(res.stdout);
  if (parsed === null) {
    return {
      ok: false,
      error: [
        `Could not read issue #${issue}: gh exited 0 but did not print JSON.`,
        `Fix: run 'gh issue view ${issue} --json title,body,labels,state' by hand — a gh older than 2.0 (no --json), or an interactive prompt landing on stdout, both look like this.`,
        `gh printed: ${snippet(res.stdout)}`,
      ].join('\n'),
    };
  }

  return {
    ok: true,
    title: asString(parsed.title),
    body: asString(parsed.body),
    labels: ghLabelNames(parsed.labels),
    state: asString(parsed.state),
  };
}

/** An issue's state read, or the one reason it could not be read. */
export type IssueStateResult = { ok: true; state: string } | { ok: false; error: string };

/**
 * Read an issue's `state` (`OPEN`/`CLOSED`) through gh — used to resolve `Depends on #N`
 * references (#538's classify pre-screen, RFC-0001 E.2 rule 9) without reading anything else
 * about the dependency issue.
 */
export function tryFetchIssueState(issue: string, repo?: string): IssueStateResult {
  const res = exec('gh', ['issue', 'view', issue, '--json', 'state', ...repoArgs(repo)]);
  if (!res.ok) {
    return {
      ok: false,
      error: ghFailure(`Could not read the state of issue #${issue}`, res.error, repo),
    };
  }

  const parsed = parseGhJson<{ state?: unknown }>(res.stdout);
  if (parsed === null || typeof parsed.state !== 'string') {
    return {
      ok: false,
      error: [
        `Could not read the state of issue #${issue}: gh exited 0 but did not print JSON — no "state" field.`,
        `Fix: run 'gh issue view ${issue} --json state' by hand.`,
        `gh printed: ${snippet(res.stdout)}`,
      ].join('\n'),
    };
  }

  return { ok: true, state: parsed.state };
}

/** `--dry-run` support for comment-posting subcommands: show the body, post nothing. */
export function printDryRun(body: string, json?: boolean, extra?: Record<string, unknown>): void {
  if (json) {
    console.log(JSON.stringify({ posted: false, dryRun: true, ...extra, body }, null, 2));
  } else {
    process.stdout.write(body);
  }
}

/**
 * Write `body` to a temp file and return a paste-safe retry hint using `--body-file`.
 *
 * Inlining the body in a suggested `gh … --body <string>` command is a paste-time
 * injection: JSON double quotes are not shell quotes, so a body containing `$(…)` or
 * backticks would execute the moment the operator pastes the suggestion. A file path
 * carries no such payload.
 */
function retryHint(issue: string, repo: string | undefined, body: string, noun: string): string {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dossier-'));
    const file = path.join(dir, `${noun}.md`);
    fs.writeFileSync(file, body);
    return `The ${noun} was NOT posted. Retry, or post it by hand:\ngh issue comment ${issue}${repo ? ` --repo ${repo}` : ''} --body-file ${file}`;
  } catch {
    return `The ${noun} was NOT posted. Retry, or save the body shown above and post it with: gh issue comment ${issue}${repo ? ` --repo ${repo}` : ''} --body-file <file>`;
  }
}

/**
 * Comment `body` onto an issue, with the shared failure taxonomy, the paste-safe retry
 * hint, and the success output both protocols use.
 *
 * `jsonExtras` merge into the `--json` result (e.g. `head` for plans); `successLine`
 * renders the human-mode success line for the caller's protocol.
 */
export function postIssueComment(options: {
  issue: string;
  repo?: string;
  body: string;
  noun: string;
  action: string;
  json?: boolean;
  jsonExtras?: Record<string, unknown>;
  successLine: (url: string) => string;
}): void {
  const res = exec('gh', [
    'issue',
    'comment',
    options.issue,
    '--body',
    options.body,
    ...repoArgs(options.repo),
  ]);
  if (!res.ok) {
    fail([
      ghFailure(options.action, res.error, options.repo),
      retryHint(options.issue, options.repo, options.body, options.noun),
    ]);
  }

  if (options.json) {
    console.log(JSON.stringify({ posted: true, url: res.stdout, ...options.jsonExtras }, null, 2));
  } else {
    console.log(options.successLine(res.stdout));
  }
}
