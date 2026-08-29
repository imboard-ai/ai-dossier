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

/**
 * Whether `member` overlaps `testFile`. Focused tests win outright; otherwise
 * the file must be one the member changed, or live under a directory it
 * changed. A member that changed only top-level files (dir `''`) never matches
 * by directory — an empty prefix would otherwise own the entire repo.
 */
function overlaps(member: MemberFootprint, testFile: string): boolean {
  const file = normalizePath(testFile);
  if (member.focusedTests.some((t) => normalizePath(t) === file)) return true;
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
    const focused = members.filter((m) =>
      m.focusedTests.some((t) => normalizePath(t) === normalizePath(test.file))
    );
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
export function offendersOf(attribution: OverlapAttribution): number[] {
  return [...attribution.attributed.keys()].sort((a, b) => a - b);
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

/** A full sha as git prints it (bisect and revert argv are validated against this). */
export const SHA_RE = /^[0-9a-f]{7,40}$/i;

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
}

/**
 * Group boundary commits (oldest first) by member.
 *
 * `from`/`to` describe the member's span for reporting; `commits` is what a
 * revert actually walks. They differ when members interleave — reverting the
 * literal `from^..to` range would then revert a neighbour's commits too, so
 * eviction reverts the explicit commit list in reverse order instead.
 */
export function memberRanges(boundary: readonly BoundaryCommit[]): MemberRange[] {
  const byIssue = new Map<number, string[]>();
  for (const commit of boundary) {
    if (commit.issue === null) continue;
    byIssue.set(commit.issue, [...(byIssue.get(commit.issue) ?? []), commit.sha]);
  }
  return [...byIssue.entries()].map(([issue, commits]) => ({
    issue,
    from: commits[0],
    to: commits[commits.length - 1],
    commits,
  }));
}

/** The member owning `sha`, or null when the commit carries no `(#N)` trailer. */
export function memberOfCommit(boundary: readonly BoundaryCommit[], sha: string): number | null {
  const match = boundary.find(
    (c) => c.sha === sha || c.sha.startsWith(sha) || sha.startsWith(c.sha)
  );
  return match?.issue ?? null;
}
