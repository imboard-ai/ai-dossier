/**
 * Shared subprocess plumbing for issue-comment-backed protocols (runstate:v1,
 * plan:v1).
 *
 * Every command that reads or writes GitHub issue comments through `gh` needs the
 * same things: run a subprocess and keep WHY it failed, turn `gh`'s stderr into a
 * named cause with a fix, parse `--json` output without a throw, and reject
 * values that cannot be safely passed on a command line. These lived privately in
 * `commands/runstate.ts` until the second consumer (`commands/plan.ts`) arrived;
 * they are extracted verbatim rather than reimplemented per command.
 */

import { execFileSync } from 'node:child_process';
import { isIssueNumber } from './runstate';

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

/** Why a subprocess did not produce output — enough to name the actual cause. */
export interface ExecFailure {
  /** The binary itself is missing from PATH (ENOENT), rather than having exited non-zero. */
  notFound: boolean;
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
 * three different fixes and are indistinguishable without it.
 */
export function exec(file: string, args: string[]): ExecResult {
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

/** Collapse output to one bounded line so a huge or binary payload stays readable. */
export function snippet(text: string, max = SNIPPET_LENGTH): string {
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
export interface GhFailureCase {
  /** Lowercased substrings of gh's stderr that identify this cause. */
  match: readonly string[];
  /** What went wrong; `where` names the repository the request targeted. */
  cause: (where: string) => string;
  /** What the caller should do about it. */
  fix: string;
}

export const GH_FAILURE_CASES: readonly GhFailureCase[] = [
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
export function hasControlChar(value: string): boolean {
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
