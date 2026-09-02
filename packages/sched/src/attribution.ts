/**
 * Failure attribution, stage 1 (#472 AC1): map failing tests to batch members
 * without an LLM, using only what the batch run already recorded.
 *
 * Two overlap signals, in order of confidence:
 *   1. **focused tests** — the member's own plan/implement phase named these
 *      test files; a failure in one of them is that member's.
 *   2. **changed paths** — the failing test file was changed by the member, or
 *      sits under a directory the member changed (the `src/x.ts` →
 *      `src/__tests__/x.test.ts` relationship, expressed structurally rather
 *      than by naming convention).
 *
 * A test with exactly one candidate member is ATTRIBUTED; more than one is
 * AMBIGUOUS and none is UNATTRIBUTED. Both of those go to stage 2 (`bisect.ts`)
 * — this module never guesses, because a wrong attribution evicts innocent
 * work. Everything here is pure; `recovery.ts` owns the effects.
 */

/** One failing test, as the aggregate suite reported it. */
export interface FailingTest {
  /** Test file path, repo-relative where the runner reports it that way. */
  file: string;
  /** Full test name (describe path + title). */
  name: string;
  /** Stable id used in evidence and journal lines: `<file>::<name>`. */
  id: string;
}

/** What one batch member touched — the attribution surface, recorded as it ran. */
export interface MemberFootprint {
  issue: number;
  /** Repo-relative paths the member's commits changed. */
  changedPaths: string[];
  /** Test files the member's own phases ran focused (strongest signal). */
  focusedTests: string[];
}

/** A failing test that could belong to more than one member. */
export interface AmbiguousTest {
  test: FailingTest;
  /** Member issue numbers that all overlap it, ascending. */
  candidates: number[];
}

/** Stage-1 attribution verdict for one suite run. */
export interface OverlapAttribution {
  /** Member issue → the failing tests uniquely attributed to it. */
  attributed: Map<number, FailingTest[]>;
  /** Tests overlapping several members — bisect decides. */
  ambiguous: AmbiguousTest[];
  /** Tests overlapping no member at all — bisect decides. */
  unattributed: FailingTest[];
}

/** Build a `FailingTest` with the derived id, so the id format exists once. */
export function failingTest(file: string, name: string): FailingTest {
  return { file, name, id: `${file}::${name}` };
}

/** Normalize a path for comparison: strip `./`, collapse `\` to `/`, drop a trailing `/`. */
function normalizePath(p: string): string {
  const slashed = p.replaceAll('\\', '/').replace(/^\.\//, '');
  return slashed.endsWith('/') ? slashed.slice(0, -1) : slashed;
}

/** The directory part of a path, or `''` for a top-level file. */
function dirOf(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '' : p.slice(0, idx);
}

/** Whether `member` explicitly ran `normalizedFile` focused — the strongest signal. */
function focusesOn(member: MemberFootprint, normalizedFile: string): boolean {
  return member.focusedTests.some((t) => normalizePath(t) === normalizedFile);
}

/**
 * Whether `member` overlaps `testFile`. Focused tests win outright; otherwise
 * the file must be one the member changed, or live under a directory it
 * changed. A member that changed only top-level files (dir `''`) never matches
 * by directory — an empty prefix would otherwise own the entire repo.
 */
function overlaps(member: MemberFootprint, testFile: string): boolean {
  const file = normalizePath(testFile);
  if (focusesOn(member, file)) return true;
  for (const raw of member.changedPaths) {
    const changed = normalizePath(raw);
    if (changed === file) return true;
    const dir = dirOf(changed);
    if (dir !== '' && file.startsWith(`${dir}/`)) return true;
  }
  return false;
}

/**
 * Stage-1 attribution: overlap only, no git, no LLM (AC1). Deterministic —
 * candidates are compared in ascending issue order so the same inputs always
 * produce the same verdict.
 */
export function attributeByOverlap(
  failing: readonly FailingTest[],
  footprints: readonly MemberFootprint[]
): OverlapAttribution {
  const attributed = new Map<number, FailingTest[]>();
  const ambiguous: AmbiguousTest[] = [];
  const unattributed: FailingTest[] = [];
  const members = [...footprints].sort((a, b) => a.issue - b.issue);

  for (const test of failing) {
    // A focused-test match is the stronger signal: when any member claims the
    // file explicitly, members that merely changed a neighbouring path are not
    // candidates — otherwise the strong signal could never break a tie.
    const file = normalizePath(test.file);
    const focused = members.filter((m) => focusesOn(m, file));
    const candidates = focused.length > 0 ? focused : members.filter((m) => overlaps(m, test.file));
    if (candidates.length === 1) {
      const issue = candidates[0].issue;
      attributed.set(issue, [...(attributed.get(issue) ?? []), test]);
    } else if (candidates.length > 1) {
      ambiguous.push({ test, candidates: candidates.map((m) => m.issue) });
    } else {
      unattributed.push(test);
    }
  }

  return { attributed, ambiguous, unattributed };
}

/** Members with at least one failing test attributed to them, ascending. */
export function offendersOf(attributed: ReadonlyMap<number, unknown>): number[] {
  return [...attributed.keys()].sort((a, b) => a - b);
}

// --- Parsers ---

/**
 * Failing tests from `vitest run --reporter=json` output. Tolerates the
 * surrounding noise a real run prints around the JSON document (vitest writes
 * the report to stdout alongside its own banner), and skips any record it
 * cannot read rather than throwing — an unparseable suite report degrades to
 * "no attributable tests", which routes to bisect, never to a guess.
 */
export function parseVitestJson(stdout: string | null): FailingTest[] {
  if (stdout === null) return [];
  const parsed = extractJsonObject(stdout);
  if (parsed === null) return [];
  const results = (parsed as { testResults?: unknown }).testResults;
  if (!Array.isArray(results)) return [];
  const out: FailingTest[] = [];
  for (const raw of results) {
    if (raw === null || typeof raw !== 'object') continue;
    const suite = raw as { name?: unknown; assertionResults?: unknown };
    const file = typeof suite.name === 'string' ? suite.name : null;
    if (file === null || !Array.isArray(suite.assertionResults)) continue;
    for (const rawAssertion of suite.assertionResults) {
      if (rawAssertion === null || typeof rawAssertion !== 'object') continue;
      const assertion = rawAssertion as { status?: unknown; fullName?: unknown; title?: unknown };
      if (assertion.status !== 'failed') continue;
      const name =
        typeof assertion.fullName === 'string'
          ? assertion.fullName
          : typeof assertion.title === 'string'
            ? assertion.title
            : '';
      out.push(failingTest(file, name));
    }
  }
  return out;
}

/**
 * Whether `stdout` contains a parseable vitest JSON report (a `{ testResults:
 * [...] }` document) — independent of whether any test in it failed (#562).
 * `parseVitestJson` returns `[]` both for "found a report, zero failures" and
 * "found no report at all" (an empty string, a wrapper script's plain-text
 * abort message, a make error): those two are NOT the same thing to a caller
 * deciding whether to trust a red exit code's failing-test list, or a green
 * exit code that happens to carry no parseable body.
 */
export function isReadableVitestReport(stdout: string | null): boolean {
  if (stdout === null) return false;
  const parsed = extractJsonObject(stdout);
  if (parsed === null) return false;
  const results = (parsed as { testResults?: unknown }).testResults;
  return Array.isArray(results);
}

/** The first balanced `{...}` document in `text`, parsed; null when there is none. */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** One commit on the batch branch, with the member it belongs to. */
export interface BoundaryCommit {
  sha: string;
  subject: string;
  /** Member issue from the `(#N)` subject trailer; null when the commit has none. */
  issue: number | null;
}

/**
 * The established commit ↔ member key: the `(#N)` trailer a squash-merge (and
 * this project's commit convention) leaves at the end of the subject. A commit
 * WITHOUT one maps to `issue: null` — unattributable, never a guess.
 */
const ISSUE_TRAILER_RE = /\(#(\d+)\)\s*$/;

/**
 * A full or abbreviated sha as git prints it — 7 to 40 hex characters. Bisect
 * endpoints and revert argv are validated against this before they become git
 * arguments (CWE-88).
 */
export const SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * A git ref name safe to interpolate into argv (CWE-88) — the pattern
 * `groundtruth.ts` established for branch names off untrusted milestone text.
 * Defined here, beside `SHA_RE`, so the package has one "validate before it
 * becomes a git argument" home rather than a copy per module.
 */
export const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Parse `git log --reverse --format=%H%x09%s <base>..<head>` — OLDEST FIRST,
 * which is the order eviction ranges and bisect boundaries are built in.
 * Malformed lines are skipped; a line whose subject has no `(#N)` trailer
 * still yields a commit, with `issue: null`.
 */
export function parseBoundaryCommits(gitLogOutput: string | null): BoundaryCommit[] {
  if (gitLogOutput === null) return [];
  const out: BoundaryCommit[] = [];
  for (const line of gitLogOutput.split('\n')) {
    if (line.trim() === '') continue;
    const tab = line.indexOf('\t');
    const sha = (tab === -1 ? line : line.slice(0, tab)).trim();
    if (!SHA_RE.test(sha)) continue;
    const subject = tab === -1 ? '' : line.slice(tab + 1);
    const match = ISSUE_TRAILER_RE.exec(subject);
    out.push({ sha, subject, issue: match ? Number.parseInt(match[1], 10) : null });
  }
  return out;
}

/** The commits one member contributed to the batch branch, oldest first. */
export interface MemberRange {
  issue: number;
  /** Oldest commit of the member. */
  from: string;
  /** Newest commit of the member. */
  to: string;
  /** Every commit of the member, oldest first. */
  commits: string[];
  /**
   * Each commit's index in the boundary list, parallel to `commits`. Grouping
   * by member loses branch order; eviction needs it back to revert newest-first
   * ACROSS members (see `memberRanges`).
   */
  positions: number[];
}

/**
 * Group boundary commits (oldest first) by member.
 *
 * `from`/`to` describe the member's span for reporting; `commits` is what a
 * revert actually walks. They differ when members interleave — reverting the
 * literal `from^..to` range would then revert a neighbour's commits too, so
 * eviction reverts the explicit commits instead, ordered by `positions`:
 * for a branch `A1 B1 A2 B2`, evicting both members must revert
 * `B2 A2 B1 A1`, not each member's commits as a block.
 */
export function memberRanges(boundary: readonly BoundaryCommit[]): MemberRange[] {
  const byIssue = new Map<number, { commits: string[]; positions: number[] }>();
  boundary.forEach((commit, position) => {
    if (commit.issue === null) return;
    const group = byIssue.get(commit.issue) ?? { commits: [], positions: [] };
    group.commits.push(commit.sha);
    group.positions.push(position);
    byIssue.set(commit.issue, group);
  });
  return [...byIssue.entries()].map(([issue, group]) => ({
    issue,
    from: group.commits[0],
    to: group.commits[group.commits.length - 1],
    commits: group.commits,
    positions: group.positions,
  }));
}

/**
 * The member owning `sha`, or null when the commit carries no `(#N)` trailer.
 *
 * Either side may be abbreviated (bisect reports a short sha; boundary commits
 * are full), so matching is prefix-based — but an AMBIGUOUS prefix returns null
 * rather than the first hit. Attribution feeds eviction, and eviction reverts
 * work: a wrong answer here destroys an innocent member's commits, so "cannot
 * tell" must never collapse into "probably this one".
 */
export function memberOfCommit(boundary: readonly BoundaryCommit[], sha: string): number | null {
  const needle = sha.toLowerCase();
  const matches = boundary.filter((c) => {
    const candidate = c.sha.toLowerCase();
    return candidate.startsWith(needle) || needle.startsWith(candidate);
  });
  const issues = new Set(matches.map((m) => m.issue));
  if (matches.length === 0 || issues.size > 1) return null;
  return matches[0].issue;
}
